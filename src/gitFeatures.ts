import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitProcessRunner, runGit } from './historyRewrite';
import { GitBisectState, GitBranchCleanupCandidate, GitBranchComparison, GitFileTimelineCommit, GitPatchInfo, GitStashableFile } from './types';

const FIELD = '\x1f';
const RECORD = '\x1e';
const HASH_REGEXP = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_EXPLAIN_DIFF_LINES = 3000;

/**
 * The result of a Git command that changes a repository: NULL if it succeeded, otherwise its error message.
 */
export type GitFeatureError = string | null;

/**
 * Git operations used by the features of the Git Map View that aren't part of the original Git Graph: comparing branches, cleaning up
 * branches, rewriting the latest commits, bisecting, patches, stashing parts of the uncommitted changes, the visual history of a file,
 * and the changes of a commit that are explained by a language model. Everything is done by running Git itself (never a shell).
 */
export class GitFeatures {
	private readonly git: GitProcessRunner;

	/**
	 * Creates the Git Features.
	 * @param git Runs Git.
	 */
	constructor(git: GitProcessRunner) {
		this.git = git;
	}


	/* Comparing Branches */

	/**
	 * Compare two branches (or any revisions): the commits on each that aren't on the other, and their merge base.
	 * @param repo The path of the repository.
	 * @param left The first branch (e.g. the branch that would be merged).
	 * @param right The second branch (e.g. the branch it would be merged into).
	 * @returns The comparison.
	 */
	public async compareBranches(repo: string, left: string, right: string): Promise<{ comparison: GitBranchComparison | null, error: GitFeatureError }> {
		const leftHash = await this.resolveCommit(repo, left), rightHash = await this.resolveCommit(repo, right);
		if (leftHash === null || rightHash === null) return { comparison: null, error: 'Unable to resolve "' + (leftHash === null ? left : right) + '" to a commit.' };
		const mergeBase = await this.run(repo, ['merge-base', leftHash, rightHash]);
		const commits = await this.run(repo, ['rev-list', '--left-right', leftHash + '...' + rightHash]);
		if (commits.code !== 0) return { comparison: null, error: commits.stderr || 'Unable to compare the branches.' };
		const lines = splitLines(commits.stdout);
		return {
			comparison: {
				left: left,
				right: right,
				leftHash: leftHash,
				rightHash: rightHash,
				mergeBase: mergeBase.code === 0 && HASH_REGEXP.test(mergeBase.stdout.toString().trim()) ? mergeBase.stdout.toString().trim() : null,
				leftOnly: lines.filter((line) => line.startsWith('<')).map((line) => line.substring(1)),
				rightOnly: lines.filter((line) => line.startsWith('>')).map((line) => line.substring(1))
			},
			error: null
		};
	}


	/* Cleaning Up Branches */

	/**
	 * Get the local branches that can be deleted: the branches that are merged into the default branch, and the branches whose upstream
	 * branch has been deleted on the remote. The branch that's checked out, the default branch, and the branches checked out in other
	 * worktrees are never included.
	 * @param repo The path of the repository.
	 * @returns The default branch (that branches are merged into), and the branches.
	 */
	public async getBranchCleanupCandidates(repo: string): Promise<{ defaultBranch: string | null, candidates: GitBranchCleanupCandidate[], error: GitFeatureError }> {
		const current = (await this.run(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.toString().trim();
		const defaultBranch = await this.getDefaultBranch(repo);
		const branches = await this.run(repo, ['for-each-ref', '--format=' + ['%(refname:short)', '%(objectname)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:unix)', '%(authorname)'].join('%1f'), 'refs/heads']);
		if (branches.code !== 0) return { defaultBranch: null, candidates: [], error: branches.stderr || 'Unable to read the branches.' };
		const merged = new Set(defaultBranch !== null ? splitLines((await this.run(repo, ['for-each-ref', '--merged', defaultBranch, '--format=%(refname:short)', 'refs/heads'])).stdout) : []);
		const remoteRefs = splitLines((await this.run(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).stdout);
		const remotes = splitLines((await this.run(repo, ['remote'])).stdout);
		const worktreeBranches = new Set(splitLines((await this.run(repo, ['worktree', 'list', '--porcelain'])).stdout).filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.substring(18)));
		const defaultLocal = defaultBranch !== null ? defaultBranch.replace(new RegExp('^(' + remotes.map(escapeRegExp).join('|') + ')/'), '') : null;

		const candidates: GitBranchCleanupCandidate[] = [];
		for (const line of splitLines(branches.stdout)) {
			const [name, hash, upstream, track, date, author] = line.split(FIELD);
			if (typeof author === 'undefined' || name === current || name === defaultBranch || name === defaultLocal || worktreeBranches.has(name)) continue;
			const isMerged = merged.has(name), upstreamGone = upstream !== '' && track === '[gone]';
			if (!isMerged && !upstreamGone) continue;
			let unmergedCommits = 0;
			if (!isMerged) {
				// The commits that only this branch contains (which are lost if it's deleted)
				const count = await this.run(repo, ['rev-list', '--count', 'refs/heads/' + name, '--not', '--exclude=' + name, '--branches', '--remotes', '--tags']);
				unmergedCommits = parseInt(count.stdout.toString().trim()) || 0;
			}
			candidates.push({
				name: name,
				hash: hash,
				upstream: upstream !== '' ? upstream : null,
				upstreamGone: upstreamGone,
				merged: isMerged,
				unmergedCommits: unmergedCommits,
				date: parseInt(date) || 0,
				author: author,
				remotes: remotes.filter((remote) => remoteRefs.includes('refs/remotes/' + remote + '/' + name))
			});
		}
		// The branches that can be deleted safely first, then the most recently changed
		candidates.sort((a, b) => (a.unmergedCommits === 0) !== (b.unmergedCommits === 0) ? (a.unmergedCommits === 0 ? -1 : 1) : b.date - a.date);
		return { defaultBranch: defaultBranch, candidates: candidates, error: null };
	}

	/**
	 * Get the default branch of a repository: the branch that origin/HEAD refers to (the local branch, if it exists), otherwise "main" or
	 * "master" (local or on origin).
	 * @param repo The path of the repository.
	 * @returns The name of the branch (e.g. "main" or "origin/main"), or NULL if there isn't one.
	 */
	public async getDefaultBranch(repo: string): Promise<string | null> {
		const originHead = (await this.run(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).stdout.toString().trim();
		const candidates = originHead !== '' ? [originHead.replace(/^origin\//, ''), originHead] : [];
		candidates.push('main', 'master', 'origin/main', 'origin/master');
		for (const candidate of candidates) {
			const ref = candidate.startsWith('origin/') ? 'refs/remotes/' + candidate : 'refs/heads/' + candidate;
			if ((await this.run(repo, ['rev-parse', '-q', '--verify', ref])).code === 0) return candidate;
		}
		return null;
	}


	/* Rewriting the Latest Commits */

	/**
	 * Change the message of the commit that HEAD refers to (only the message changes: changes that are staged stay staged).
	 * @param repo The path of the repository.
	 * @param message The new message.
	 * @param sign Sign the commit.
	 * @returns The error, or NULL.
	 */
	public async amendMessage(repo: string, message: string, sign: boolean): Promise<GitFeatureError> {
		if (message.trim() === '') return 'The message can\'t be empty.';
		return this.withMessageFile(message, (file) => this.change(repo, ['commit', '--amend', '--only', '--allow-empty', '--cleanup=strip', '-F', file].concat(sign ? ['-S'] : [])));
	}

	/**
	 * Undo the commit that HEAD refers to: the current branch is moved back to its parent, keeping the changes of the commit.
	 * @param repo The path of the repository.
	 * @param mode "soft" => The changes stay staged, "mixed" => They're unstaged (in the working tree).
	 * @returns The error, or NULL.
	 */
	public async undoCommit(repo: string, mode: 'soft' | 'mixed'): Promise<GitFeatureError> {
		if ((await this.run(repo, ['rev-parse', '-q', '--verify', 'HEAD^'])).code !== 0) return 'The commit doesn\'t have a parent, so it can\'t be undone.';
		return this.change(repo, ['reset', '--' + mode, 'HEAD^']);
	}

	/**
	 * Add the staged changes to a commit of the current branch (a fixup commit is made, and the branch is rebased with --autosquash from
	 * the commit, keeping the unstaged changes).
	 * @param repo The path of the repository.
	 * @param hash The commit.
	 * @param sign Sign the commits.
	 * @returns The error, or NULL (also if the rebase stopped because of conflicts, in which case it's in progress).
	 */
	public async fixupCommit(repo: string, hash: string, sign: boolean): Promise<GitFeatureError> {
		if (!HASH_REGEXP.test(hash)) return 'Invalid commit hash: ' + hash;
		if ((await this.run(repo, ['diff', '--cached', '--quiet'])).code === 0) return 'There aren\'t any staged changes to add to the commit.';
		const commit = await this.change(repo, ['commit', '--no-verify', '--fixup=' + hash].concat(sign ? ['-S'] : []));
		if (commit !== null) return commit;
		const isRoot = (await this.run(repo, ['rev-parse', '-q', '--verify', hash + '^'])).code !== 0;
		// The todo list made by --autosquash is used as it is, and no editor is opened for the messages
		const args = ['-c', 'rebase.instructionFormat=%s', 'rebase', '--interactive', '--autosquash', '--autostash'].concat(sign ? ['-S'] : [], isRoot ? ['--root'] : [hash + '^']);
		const rebase = await runGit(this.git, repo, args, null, null, { GIT_SEQUENCE_EDITOR: ':', GIT_EDITOR: ':' });
		return rebase.code === 0 ? null : errorOf(rebase);
	}


	/* Bisecting */

	/**
	 * Get the state of the bisect in progress in a repository.
	 * @param repo The path of the repository.
	 * @returns The state, or NULL if no bisect is in progress.
	 */
	public async getBisectState(repo: string): Promise<GitBisectState | null> {
		const startFile = await this.getGitPath(repo, 'BISECT_START');
		if (startFile === null || !fs.existsSync(startFile)) return null;
		const refs = splitLines((await this.run(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/bisect'])).stdout).map((line) => line.split(' '));
		const bad = refs.find(([ref]) => ref === 'refs/bisect/bad'), good = refs.filter(([ref]) => ref.startsWith('refs/bisect/good-')).map(([, hash]) => hash);
		const skipped = refs.filter(([ref]) => ref.startsWith('refs/bisect/skip-')).map(([, hash]) => hash);
		const head = (await this.run(repo, ['rev-parse', '-q', '--verify', 'HEAD'])).stdout.toString().trim();
		let remaining: number | null = null, steps: number | null = null;
		if (typeof bad !== 'undefined' && good.length > 0) {
			const vars = (await this.run(repo, ['rev-list', '--bisect-vars', bad[1], '--not'].concat(good))).stdout.toString();
			const value = (name: string) => {
				const match = vars.match(new RegExp('^' + name + '=\'?(\\d+)', 'm'));
				return match !== null ? parseInt(match[1]) : null;
			};
			remaining = value('bisect_nr');
			steps = value('bisect_steps');
		}
		const logFile = await this.getGitPath(repo, 'BISECT_LOG');
		const log = logFile !== null && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
		// Git writes "# first bad commit: [hash]" or "# first 'bad' commit: [hash]" (depending on how the bisect finished)
		const firstBad = log.match(/^# first '?[^\s']+'? commit: \[([0-9a-f]{40,64})\]/m);
		return {
			bad: typeof bad !== 'undefined' ? bad[1] : null,
			good: good,
			skipped: skipped,
			current: HASH_REGEXP.test(head) ? head : null,
			remaining: remaining,
			steps: steps,
			firstBad: firstBad !== null ? firstBad[1] : null
		};
	}

	/**
	 * Start, continue or stop bisecting.
	 * @param repo The path of the repository.
	 * @param action "start" (with the bad & good commits), "good" / "bad" / "skip" (a commit, or HEAD), or "reset" (stop bisecting).
	 * @param hash The commit to mark (NULL => HEAD), or the bad commit when starting.
	 * @param goodRef The good commit (when starting).
	 * @returns The error, or NULL.
	 */
	public async bisect(repo: string, action: 'start' | 'good' | 'bad' | 'skip' | 'reset', hash: string | null, goodRef: string | null): Promise<GitFeatureError> {
		if (action === 'start') {
			if (hash === null || goodRef === null || goodRef.trim() === '') return 'A bad and a good commit are required to start bisecting.';
			const bad = await this.resolveCommit(repo, hash.trim()), good = await this.resolveCommit(repo, goodRef.trim());
			if (bad === null) return 'Unable to resolve "' + hash.trim() + '" to a commit.';
			if (good === null) return 'Unable to resolve "' + goodRef.trim() + '" to a commit.';
			if (bad === good || (await this.run(repo, ['merge-base', '--is-ancestor', good, bad])).code !== 0) return 'The good commit must be an ancestor of the bad commit.';
			return this.change(repo, ['bisect', 'start', bad, good, '--']);
		} else if (action === 'reset') {
			return this.change(repo, ['bisect', 'reset']);
		}
		if (hash !== null && !HASH_REGEXP.test(hash)) return 'Invalid commit hash: ' + hash;
		return this.change(repo, ['bisect', action].concat(hash !== null ? [hash] : []));
	}


	/* Patches */

	/**
	 * Get the patch of commits (in the format of `git format-patch`, with their authors & messages).
	 * @param repo The path of the repository.
	 * @param hashes The commits (oldest first).
	 * @returns The patch, and the error.
	 */
	public async getCommitsPatch(repo: string, hashes: ReadonlyArray<string>): Promise<{ patch: string, error: GitFeatureError }> {
		const patches: string[] = [];
		for (const hash of hashes) {
			if (!HASH_REGEXP.test(hash)) return { patch: '', error: 'Invalid commit hash: ' + hash };
			const result = await this.run(repo, ['format-patch', '--stdout', '--binary', '--no-signature', '-1', hash]);
			if (result.code !== 0) return { patch: '', error: errorOf(result) };
			patches.push(result.stdout.toString());
		}
		return { patch: patches.join(''), error: null };
	}

	/**
	 * Get the patch of a stash (its changes to tracked files, and the untracked files it includes).
	 * @param repo The path of the repository.
	 * @param hash The hash of the stash.
	 * @returns The patch, and the error.
	 */
	public async getStashPatch(repo: string, hash: string): Promise<{ patch: string, error: GitFeatureError }> {
		const tracked = await this.run(repo, ['diff', '--binary', '--no-color', '--no-ext-diff', hash + '^1', hash, '--']);
		if (tracked.code !== 0) return { patch: '', error: errorOf(tracked) };
		let patch = tracked.stdout.toString();
		if ((await this.run(repo, ['rev-parse', '-q', '--verify', hash + '^3'])).code === 0) {
			const untracked = await this.run(repo, ['diff', '--binary', '--no-color', '--no-ext-diff', EMPTY_TREE_HASH, hash + '^3', '--']);
			if (untracked.code === 0) patch += untracked.stdout.toString();
		}
		return { patch: patch, error: null };
	}

	/**
	 * Get the patch of the uncommitted changes (to tracked files).
	 * @param repo The path of the repository.
	 * @returns The patch, and the error.
	 */
	public async getUncommittedPatch(repo: string): Promise<{ patch: string, error: GitFeatureError }> {
		const result = await this.run(repo, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--']);
		return result.code === 0 ? { patch: result.stdout.toString(), error: null } : { patch: '', error: errorOf(result) };
	}

	/**
	 * Describe a patch file, and check whether it can be applied.
	 * @param repo The path of the repository.
	 * @param file The path of the patch file.
	 * @returns The description of the patch, or an error if it isn't a patch.
	 */
	public async checkPatch(repo: string, file: string): Promise<{ patch: GitPatchInfo | null, error: GitFeatureError }> {
		let contents: string;
		try {
			contents = fs.readFileSync(file, 'utf8');
		} catch (error) {
			return { patch: null, error: 'Unable to read the file: ' + String(error) };
		}
		const numstat = await this.run(repo, ['apply', '--numstat', '-z', file]);
		if (numstat.code !== 0) return { patch: null, error: 'The file isn\'t a patch: ' + errorOf(numstat) };
		let files = 0, additions = 0, deletions = 0;
		numstat.stdout.toString().split('\0').forEach((record) => {
			const fields = record.replace(/^\n/, '').split('\t');
			if (fields.length < 3) return;
			files++;
			additions += parseInt(fields[0]) || 0;
			deletions += parseInt(fields[1]) || 0;
		});
		const commits = (contents.match(/^From [0-9a-f]{40,64} Mon Sep 17 00:00:00 2001$/gm) || []).length;
		const check = await this.run(repo, commits > 0 ? ['apply', '--check', file] : ['apply', '--check', '--3way', file]);
		return {
			patch: {
				file: file,
				name: path.basename(file),
				commits: commits,
				files: files,
				additions: additions,
				deletions: deletions,
				appliesCleanly: check.code === 0,
				checkError: check.code === 0 ? null : errorOf(check)
			},
			error: null
		};
	}

	/**
	 * Apply a patch file: as commits on the current branch (`git am`), or as uncommitted changes (`git apply --3way`).
	 * @param repo The path of the repository.
	 * @param file The path of the patch file.
	 * @param asCommits Apply the commits in the patch (it must be in the format of `git format-patch`).
	 * @returns The error, or NULL (`git am` may stop because of conflicts, in which case it's in progress).
	 */
	public applyPatch(repo: string, file: string, asCommits: boolean): Promise<GitFeatureError> {
		return asCommits ? this.change(repo, ['am', '--3way', file]) : this.change(repo, ['apply', '--3way', file]);
	}


	/* Stashes */

	/**
	 * Get the files that have uncommitted changes (which can be stashed).
	 * @param repo The path of the repository.
	 * @returns The files, and the error.
	 */
	public async getStashableFiles(repo: string): Promise<{ files: GitStashableFile[], error: GitFeatureError }> {
		const status = await this.run(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		if (status.code !== 0) return { files: [], error: errorOf(status) };
		const records = status.stdout.toString().split('\0'), files: GitStashableFile[] = [];
		for (let i = 0; i < records.length; i++) {
			const record = records[i];
			if (record.length < 4) continue;
			const x = record[0], y = record[1];
			files.push({ path: record.substring(3), staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && y !== '?', untracked: x === '?' });
			if (x === 'R' || x === 'C') i++; // The original path of a rename or copy follows
		}
		return { files: files, error: null };
	}

	/**
	 * Restore a file from a stash (replacing it in the working tree, and leaving the stash as it is).
	 * @param repo The path of the repository.
	 * @param hash The hash of the stash.
	 * @param filePath The path of the file.
	 * @param untracked Is the file one of the untracked files included in the stash.
	 * @param force Replace the file even if it has uncommitted changes.
	 * @returns The error (NULL if the file was restored), and whether it wasn't restored as it has uncommitted changes.
	 */
	public async restoreFileFromStash(repo: string, hash: string, filePath: string, untracked: boolean, force: boolean): Promise<{ error: GitFeatureError, hasChanges: boolean }> {
		if (!HASH_REGEXP.test(hash)) return { error: 'Invalid stash hash: ' + hash, hasChanges: false };
		const status = await this.run(repo, ['status', '--porcelain', '--untracked-files=all', '--', filePath]);
		if (!force && status.stdout.toString().trim() !== '') return { error: null, hasChanges: true };
		const source = untracked ? hash + '^3' : hash;
		const contents = await this.run(repo, ['show', source + ':' + filePath]);
		if (contents.code !== 0) return { error: errorOf(contents), hasChanges: false };
		try {
			const absolutePath = path.join(repo, filePath);
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			fs.writeFileSync(absolutePath, contents.stdout);
		} catch (error) {
			return { error: 'Unable to write the file: ' + String(error), hasChanges: false };
		}
		return { error: null, hasChanges: false };
	}


	/* The Visual History of a File */

	/**
	 * Get the commits that changed a file (following it through renames), with the lines they added & deleted.
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param maxCommits The maximum number of commits.
	 * @returns The commits (newest first), and the error.
	 */
	public async getFileTimeline(repo: string, filePath: string, maxCommits: number): Promise<{ commits: GitFileTimelineCommit[], error: GitFeatureError }> {
		const result = await this.run(repo, ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--follow', '-M', '--max-count=' + maxCommits, '--format=' + RECORD + '%H' + FIELD + '%aN' + FIELD + '%aE' + FIELD + '%at' + FIELD + '%s', '--numstat', '--summary', '--', filePath]);
		if (result.code !== 0) return { commits: [], error: errorOf(result) };
		const commits: GitFileTimelineCommit[] = [];
		result.stdout.toString().split(RECORD).slice(1).forEach((record) => {
			const recordLines = record.split(/\r?\n/), header = recordLines[0].split(FIELD);
			if (header.length < 5) return;
			let additions = 0, deletions = 0, path = filePath, added = false;
			recordLines.slice(1).forEach((line) => {
				if (line.startsWith(' create mode ')) added = true;
				const fields = line.split('\t');
				if (fields.length < 3) return;
				additions += parseInt(fields[0]) || 0;
				deletions += parseInt(fields[1]) || 0;
				const changedPath = fields.slice(2).join('\t'), arrow = changedPath.indexOf(' => ');
				path = arrow > -1 ? changedPath.replace(/^(.*)\{(.*) => (.*)\}(.*)$/, '$1$3$4').replace(/^.* => /, '').replace(/\/\//g, '/') : changedPath;
			});
			commits.push({ hash: header[0], author: header[1], email: header[2], date: parseInt(header[3]) || 0, subject: header.slice(4).join(FIELD), additions: additions, deletions: deletions, filePath: path, added: added });
		});
		return { commits: commits, error: null };
	}


	/* Explaining a Commit */

	/**
	 * Get what a language model is given to explain a commit: its message, and its changes (truncated if they're long).
	 * @param repo The path of the repository.
	 * @param hash The commit.
	 * @returns The text, whether the changes were truncated, and the error.
	 */
	public async getCommitForExplanation(repo: string, hash: string): Promise<{ text: string, truncated: boolean, error: GitFeatureError }> {
		if (!HASH_REGEXP.test(hash)) return { text: '', truncated: false, error: 'Invalid commit hash: ' + hash };
		const result = await this.run(repo, ['-c', 'log.showSignature=false', 'show', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--format=Subject: %s%n%n%b', hash, '--']);
		if (result.code !== 0) return { text: '', truncated: false, error: errorOf(result) };
		const lines = result.stdout.toString().split(/\r?\n/), truncated = lines.length > MAX_EXPLAIN_DIFF_LINES;
		return { text: (truncated ? lines.slice(0, MAX_EXPLAIN_DIFF_LINES) : lines).join('\n'), truncated: truncated, error: null };
	}


	/* Helpers */

	/**
	 * Get the full message of a commit.
	 * @param repo The path of the repository.
	 * @param hash The commit.
	 * @returns The message, or NULL if it couldn't be read.
	 */
	public async getCommitMessage(repo: string, hash: string): Promise<string | null> {
		if (!HASH_REGEXP.test(hash)) return null;
		const result = await this.run(repo, ['-c', 'log.showSignature=false', 'log', '-1', '--format=%B', hash, '--']);
		return result.code === 0 ? result.stdout.toString().replace(/\s+$/, '') : null;
	}

	/**
	 * Resolve a revision to the hash of the commit it refers to.
	 * @returns The hash, or NULL if it isn't a commit.
	 */
	public async resolveCommit(repo: string, revision: string): Promise<string | null> {
		if (revision.startsWith('-')) return null;
		const result = await this.run(repo, ['rev-parse', '-q', '--verify', revision + '^{commit}']);
		const hash = result.stdout.toString().trim();
		return result.code === 0 && HASH_REGEXP.test(hash) ? hash : null;
	}

	/**
	 * Get the path of a file in the Git directory of a repository.
	 */
	private async getGitPath(repo: string, file: string) {
		const result = await this.run(repo, ['rev-parse', '--git-path', file]);
		return result.code === 0 ? path.resolve(repo, result.stdout.toString().trim()) : null;
	}

	/**
	 * Write a message to a temporary file (read by Git with -F, so that it's never in a command line), and run a command with it.
	 */
	private async withMessageFile(message: string, fn: (file: string) => Promise<GitFeatureError>) {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-message-')), file = path.join(directory, 'message.txt');
		try {
			fs.writeFileSync(file, message);
			return await fn(file);
		} finally {
			fs.rm(directory, { recursive: true, force: true }, () => { });
		}
	}

	/**
	 * Run a Git command that changes a repository (no editor is opened by Git).
	 * @returns The error, or NULL.
	 */
	private async change(repo: string, args: string[]): Promise<GitFeatureError> {
		const result = await runGit(this.git, repo, args, null, null, { GIT_EDITOR: ':' });
		return result.code === 0 ? null : errorOf(result);
	}

	private run(repo: string, args: string[]) {
		return runGit(this.git, repo, args);
	}
}

/**
 * Get the error message of a Git command that failed.
 */
function errorOf(result: { code: number, stdout: Buffer, stderr: string }) {
	const message = result.stderr !== '' ? result.stderr : result.stdout.toString().trim();
	return message !== '' ? message : 'Git exited with code ' + result.code + '.';
}

/**
 * Split the output of a command into its non-empty lines.
 */
function splitLines(output: Buffer) {
	return output.toString().split(/\r?\n/).filter((line) => line !== '');
}

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
