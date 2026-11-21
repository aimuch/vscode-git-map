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
const MAX_EXPLAIN_LINE_CHARS = 500;
const MAX_EXPLAIN_CHARS = 80000;
const MAX_EXPLAIN_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 25 * 1024 * 1024;

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
		const remoteRefs = new Set(splitLines((await this.run(repo, ['for-each-ref', '--format=%(refname)', 'refs/remotes'])).stdout));
		const remotes = splitLines((await this.run(repo, ['remote'])).stdout);
		const worktreeBranches = new Set(splitLines((await this.run(repo, ['worktree', 'list', '--porcelain'])).stdout).filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.substring(18)));
		const defaultLocal = defaultBranch !== null ? defaultBranch.replace(new RegExp('^(' + remotes.map(escapeRegExp).join('|') + ')/'), '') : null;

		const candidates: GitBranchCleanupCandidate[] = [];
		for (const line of splitLines(branches.stdout)) {
			const [name, hash, upstream, track, date, author] = line.split(FIELD);
			if (typeof author === 'undefined' || name === current || name === defaultBranch || name === defaultLocal || worktreeBranches.has(name)) continue;
			let isMerged = merged.has(name);
			const upstreamGone = upstream !== '' && track === '[gone]';
			if (!isMerged && !upstreamGone) continue;
			let unmergedCommits = 0;
			if (!isMerged) {
				// The commits that only this branch contains (which are lost if it's deleted)
				const count = await this.run(repo, ['rev-list', '--count', 'refs/heads/' + name, '--not', '--exclude=' + name, '--branches', '--remotes', '--tags']);
				unmergedCommits = parseInt(count.stdout.toString().trim()) || 0;
				if (unmergedCommits > 0 && defaultBranch !== null) {
					const cherry = await this.run(repo, ['cherry', defaultBranch, 'refs/heads/' + name]);
					const cherryLines = splitLines(cherry.stdout);
					if (cherry.code === 0 && cherryLines.length > 0 && cherryLines.every((cherryLine) => cherryLine.startsWith('- '))) {
						isMerged = true;
						unmergedCommits = 0;
					}
				}
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
				remotes: remotes.filter((remote) => remoteRefs.has('refs/remotes/' + remote + '/' + name))
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
		const headBefore = await this.resolveCommit(repo, 'HEAD');
		const commit = await this.change(repo, ['commit', '--no-verify', '-m', 'fixup! ' + hash].concat(sign ? ['-S'] : []));
		if (commit !== null) return commit;
		const fixupHash = await this.resolveCommit(repo, 'HEAD');
		if (fixupHash === null) return 'Unable to resolve the fixup commit.';
		const isRoot = (await this.run(repo, ['rev-parse', '-q', '--verify', hash + '^'])).code !== 0;
		const revList = await this.run(repo, ['rev-list', '--reverse'].concat(isRoot ? ['HEAD'] : [hash + '^..HEAD']));
		const commits = splitLines(revList.stdout).filter((c) => c !== fixupHash);
		if (!commits.includes(hash)) {
			if (headBefore !== null) await this.change(repo, ['reset', '--soft', headBefore]);
			return 'Only commits of the current branch can be fixed up.';
		}
		const todoLines: string[] = [];
		commits.forEach((c) => {
			todoLines.push('pick ' + c);
			if (c === hash) todoLines.push('fixup ' + fixupHash);
		});
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-fixup-')), todoFile = path.join(directory, 'git-rebase-todo').replace(/\\/g, '/');
		fs.writeFileSync(todoFile, todoLines.join('\n') + '\n');
		const args = ['rebase', '--interactive', '--autostash'].concat(sign ? ['-S'] : [], isRoot ? ['--root'] : [hash + '^']);
		const rebase = await runGit(this.git, repo, args, null, null, { GIT_SEQUENCE_EDITOR: 'cp \'' + todoFile.replace(/'/g, '\'\\\'\'') + '\'', GIT_EDITOR: ':' });
		const rebaseMerge = await this.getGitPath(repo, 'rebase-merge'), rebaseApply = await this.getGitPath(repo, 'rebase-apply');
		const inProgress = (rebaseMerge !== null && fs.existsSync(rebaseMerge)) || (rebaseApply !== null && fs.existsSync(rebaseApply));
		if (!inProgress) fs.rm(directory, { recursive: true, force: true }, () => { });
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
		let remaining: number | null = null, steps: number | null = null, candidates: string[] | null = null;
		if (typeof bad !== 'undefined' && good.length > 0) {
			// The commits that can still be the first bad commit (the bad commit, and its ancestors that aren't ancestors of a good commit)
			const range = await this.run(repo, ['rev-list', '--max-count=10000', bad[1], '--not'].concat(good));
			if (range.code === 0) candidates = splitLines(range.stdout);
			const vars = (await this.run(repo, ['rev-list', '--bisect-vars', bad[1], '--not'].concat(good))).stdout.toString();
			const value = (name: string) => {
				const match = vars.match(new RegExp('^' + name + '=\'?(\\d+)', 'm'));
				return match !== null ? parseInt(match[1]) : null;
			};
			remaining = value('bisect_nr');
			steps = value('bisect_steps');
		}
		const logFile = await this.getGitPath(repo, 'BISECT_LOG');
		const log = logFile !== null ? await fs.promises.readFile(logFile, 'utf8').catch(() => '') : '';
		// Git writes "# first bad commit: [hash]" or "# first 'bad' commit: [hash]" (depending on how the bisect finished)
		const firstBad = log.match(/^# first '?[^\s']+'? commit: \[([0-9a-f]{40,64})\]/m);
		return {
			bad: typeof bad !== 'undefined' ? bad[1] : null,
			good: good,
			skipped: skipped,
			current: HASH_REGEXP.test(head) ? head : null,
			remaining: remaining,
			steps: steps,
			firstBad: firstBad !== null ? firstBad[1] : null,
			candidates: candidates
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
		let totalBytes = 0;
		for (const hash of hashes) {
			if (!HASH_REGEXP.test(hash)) return { patch: '', error: 'Invalid commit hash: ' + hash };
			const result = await runGit(this.git, repo, ['format-patch', '--stdout', '--binary', '--no-signature', '-1', hash], null, null, undefined, MAX_PATCH_BYTES - totalBytes);
			if (result.truncated) return { patch: '', error: 'The patch is larger than 25 MB.' };
			if (result.code !== 0) return { patch: '', error: errorOf(result) };
			totalBytes += result.stdout.length;
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
		const tracked = await runGit(this.git, repo, ['diff', '--binary', '--no-color', '--no-ext-diff', hash + '^1', hash, '--'], null, null, undefined, MAX_PATCH_BYTES);
		if (tracked.truncated) return { patch: '', error: 'The patch is larger than 25 MB.' };
		if (tracked.code !== 0) return { patch: '', error: errorOf(tracked) };
		let patch = tracked.stdout.toString();
		if ((await this.run(repo, ['rev-parse', '-q', '--verify', hash + '^3'])).code === 0) {
			const untracked = await runGit(this.git, repo, ['diff', '--binary', '--no-color', '--no-ext-diff', EMPTY_TREE_HASH, hash + '^3', '--'], null, null, undefined, Math.max(1, MAX_PATCH_BYTES - tracked.stdout.length));
			if (untracked.truncated) return { patch: '', error: 'The patch is larger than 25 MB.' };
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
		const result = await runGit(this.git, repo, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', '--'], null, null, undefined, MAX_PATCH_BYTES);
		if (result.truncated) return { patch: '', error: 'The patch is larger than 25 MB.' };
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
			contents = await fs.promises.readFile(file, 'utf8');
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
		const repoRoot = path.resolve(repo), absolutePath = path.resolve(repoRoot, filePath);
		if (path.isAbsolute(filePath) || !absolutePath.startsWith(repoRoot + path.sep)) return { error: 'Invalid file path: ' + filePath, hasChanges: false };
		const status = await this.run(repo, ['status', '--porcelain', '--untracked-files=all', '--', ':(literal)' + filePath]);
		if (!force && status.stdout.toString().trim() !== '') return { error: null, hasChanges: true };
		const source = untracked ? hash + '^3' : hash;
		const restored = await this.change(repo, ['restore', '--source=' + source, '--worktree', '--', ':(literal)' + filePath]);
		if (restored === null) return { error: null, hasChanges: false };
		// Fallback for Git < 2.23 without `git restore`
		const contents = await this.run(repo, ['show', source + ':' + filePath]);
		if (contents.code !== 0) return { error: restored, hasChanges: false };
		try {
			const realRepo = fs.realpathSync(repoRoot);
			fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
			const realParent = fs.realpathSync(path.dirname(absolutePath));
			if (realParent !== realRepo && !realParent.startsWith(realRepo + path.sep)) return { error: 'Invalid file path: ' + filePath, hasChanges: false };
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
	 * @param revision The revision to trace from (defaults to HEAD).
	 * @returns The commits (newest first), and the error.
	 */
	public async getFileTimeline(repo: string, filePath: string, maxCommits: number, revision: string = 'HEAD'): Promise<{ commits: GitFileTimelineCommit[], error: GitFeatureError }> {
		const rev = revision === 'HEAD' || HASH_REGEXP.test(revision) ? revision : 'HEAD';
		const result = await this.run(repo, ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--follow', '-M', '--max-count=' + maxCommits, '--format=' + RECORD + '%H' + FIELD + '%aN' + FIELD + '%aE' + FIELD + '%at' + FIELD + '%s', '--numstat', '--summary', rev, '--', filePath]);
		if (result.code !== 0) return { commits: [], error: errorOf(result) };
		const commits: GitFileTimelineCommit[] = [];
		result.stdout.toString().split(RECORD).slice(1).forEach((record) => {
			const recordLines = record.split(/\r?\n/), header = recordLines[0].split(FIELD);
			if (header.length < 5) return;
			let additions = 0, deletions = 0, currentPath = filePath, oldFilePath: string | null = null, added = false;
			recordLines.slice(1).forEach((line) => {
				if (line.startsWith(' create mode ')) added = true;
				const fields = line.split('\t');
				if (fields.length < 3) return;
				additions += parseInt(fields[0]) || 0;
				deletions += parseInt(fields[1]) || 0;
				const changedPath = fields.slice(2).join('\t'), arrow = changedPath.indexOf(' => ');
				if (arrow > -1) {
					oldFilePath = changedPath.replace(/^(.*)\{(.*) => (.*)\}(.*)$/, '$1$2$4').replace(/ => .*$/, '').replace(/\/\//g, '/');
					currentPath = changedPath.replace(/^(.*)\{(.*) => (.*)\}(.*)$/, '$1$3$4').replace(/^.* => /, '').replace(/\/\//g, '/');
				} else {
					currentPath = changedPath;
				}
			});
			commits.push({ hash: header[0], author: header[1], email: header[2], date: parseInt(header[3]) || 0, subject: header.slice(4).join(FIELD), additions: additions, deletions: deletions, filePath: currentPath, oldFilePath: oldFilePath, added: added });
		});
		return { commits: commits, error: null };
	}


	/* Explaining a Commit & Generating a Commit Message */

	/**
	 * Get what a language model is given to explain a commit: its message, and its changes (truncated if they're long).
	 * @param repo The path of the repository.
	 * @param hash The commit.
	 * @returns The text, whether the changes were truncated, and the error.
	 */
	public async getCommitForExplanation(repo: string, hash: string): Promise<{ text: string, truncated: boolean, error: GitFeatureError }> {
		if (!HASH_REGEXP.test(hash)) return { text: '', truncated: false, error: 'Invalid commit hash: ' + hash };
		const result = await runGit(this.git, repo, ['-c', 'log.showSignature=false', 'show', '-m', '--first-parent', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--format=Subject: %s%n%n%b', hash, '--'], null, null, undefined, MAX_EXPLAIN_BYTES);
		if (result.code !== 0 && !result.truncated) return { text: '', truncated: false, error: errorOf(result) };
		const capped = truncateModelInput(result.stdout.toString(), result.truncated);
		return { text: capped.text, truncated: capped.truncated, error: null };
	}

	/**
	 * Get the uncommitted changes to generate a commit message from: staged changes when anything is staged, otherwise unstaged & untracked changes.
	 * @param repo The path of the repository.
	 */
	public async getChangesForCommitMessage(repo: string): Promise<{ text: string, scope: 'staged' | 'unstaged' | 'none', recentSubjects: string[], truncated: boolean, error: GitFeatureError }> {
		const staged = await runGit(this.git, repo, ['diff', '--cached', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--'], null, null, undefined, MAX_EXPLAIN_BYTES);
		if (staged.code !== 0 && !staged.truncated) return { text: '', scope: 'none', recentSubjects: [], truncated: false, error: errorOf(staged) };
		const getRecentSubjects = async () => {
			const recent = await this.run(repo, ['-c', 'log.showSignature=false', 'log', '-n', '5', '--format=%s']);
			return recent.code === 0 ? splitLines(recent.stdout).slice(0, 5) : [];
		};
		if (staged.stdout.length > 0) {
			const capped = truncateModelInput(staged.stdout.toString(), staged.truncated);
			return { text: capped.text, scope: 'staged', recentSubjects: await getRecentSubjects(), truncated: capped.truncated, error: null };
		}

		const [unstaged, untracked] = await Promise.all([
			runGit(this.git, repo, ['diff', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', '--'], null, null, undefined, MAX_EXPLAIN_BYTES),
			runGit(this.git, repo, ['ls-files', '--others', '--exclude-standard', '-z'], null, null, undefined, MAX_EXPLAIN_BYTES)
		]);
		if (unstaged.code !== 0 && !unstaged.truncated) return { text: '', scope: 'none', recentSubjects: [], truncated: false, error: errorOf(unstaged) };
		const untrackedPaths = untracked.code === 0 || untracked.truncated ? untracked.stdout.toString().split('\0').filter((p) => p !== '') : [];
		if (unstaged.stdout.length === 0 && untrackedPaths.length === 0) {
			return { text: '', scope: 'none', recentSubjects: [], truncated: false, error: null };
		}

		let combined = unstaged.stdout.toString();
		let extraTruncated = unstaged.truncated || untracked.truncated;
		if (untrackedPaths.length > 0) {
			const sections: string[] = ['Untracked files (' + untrackedPaths.length + '): ' + untrackedPaths.slice(0, 30).join(', ')];
			if (untrackedPaths.length > 30) extraTruncated = true;
			const repoResolved = path.resolve(repo);
			let totalPreviewBytes = 0;
			for (const relPath of untrackedPaths.slice(0, 15)) {
				if (totalPreviewBytes >= 32768) {
					extraTruncated = true;
					break;
				}
				const absPath = path.resolve(repoResolved, relPath);
				const relCheck = path.relative(repoResolved, absPath);
				if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
				try {
					const stat = fs.lstatSync(absPath);
					if (!stat.isFile()) continue;
					const readLen = Math.min(stat.size, 4096);
					const fd = fs.openSync(absPath, 'r');
					let buf: Buffer;
					try {
						buf = Buffer.alloc(readLen);
						fs.readSync(fd, buf, 0, readLen, 0);
					} finally {
						fs.closeSync(fd);
					}
					if (buf.includes(0)) {
						sections.push('--- /dev/null\n+++ b/' + relPath + '\n(Binary file)');
					} else {
						if (stat.size > readLen) extraTruncated = true;
						totalPreviewBytes += readLen;
						const addedLines = buf.toString('utf8').split(/\r?\n/).map((line) => '+' + line).join('\n');
						sections.push('--- /dev/null\n+++ b/' + relPath + '\n' + addedLines);
					}
				} catch (_) {
					// Ignore unreadable untracked files
				}
			}
			if (untrackedPaths.length > 15) extraTruncated = true;
			combined = (combined !== '' ? combined + '\n\n' : '') + sections.join('\n\n');
		}
		const capped = truncateModelInput(combined, extraTruncated);
		return { text: capped.text, scope: 'unstaged', recentSubjects: await getRecentSubjects(), truncated: capped.truncated, error: null };
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
	 * Get a remote branch that contains a commit (i.e. the commit has been pushed).
	 * @param repo The path of the repository.
	 * @param hash The commit.
	 * @returns The name of the remote branch (e.g. "origin/main"), or NULL if no remote branch contains it.
	 */
	public async getRemoteBranchContaining(repo: string, hash: string): Promise<string | null> {
		if (!HASH_REGEXP.test(hash)) return null;
		const result = await this.run(repo, ['for-each-ref', '--contains', hash, '--format=%(refname:short)', 'refs/remotes']);
		const branch = result.code === 0 ? splitLines(result.stdout).find((name) => !name.endsWith('/HEAD')) : undefined;
		return typeof branch !== 'undefined' ? branch : null;
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
	 * Get the path of the log of the bisect in progress.
	 * @param repo The path of the repository.
	 * @returns The path, or NULL if no bisect is in progress.
	 */
	public async getBisectLogPath(repo: string): Promise<string | null> {
		const file = await this.getGitPath(repo, 'BISECT_LOG');
		return file !== null && fs.existsSync(file) ? file : null;
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
	 * Get commit log & diff summary between two revisions (for AI Code Review or AI PR / Release Notes).
	 */
	public async getRangeForReviewOrReleaseNotes(repo: string, fromRef: string, toRef: string): Promise<{ commitsText: string, diffText: string, truncated: boolean, error: GitFeatureError }> {
		const fromHash = await this.resolveCommit(repo, fromRef);
		const toHash = await this.resolveCommit(repo, toRef);
		if (fromHash === null || toHash === null) {
			return { commitsText: '', diffText: '', truncated: false, error: 'Unable to resolve "' + (fromHash === null ? fromRef : toRef) + '" to a commit.' };
		}
		const [logRes, diffRes] = await Promise.all([
			runGit(this.git, repo, ['-c', 'log.showSignature=false', 'log', '--no-merges', '--max-count=150', '--format=- %h (%an): %s', fromHash + '..' + toHash, '--'], null, null, undefined, MAX_EXPLAIN_BYTES),
			runGit(this.git, repo, ['diff', '--no-color', '--no-ext-diff', '-M', '--stat', '--patch', fromHash, toHash, '--'], null, null, undefined, MAX_EXPLAIN_BYTES)
		]);
		if (diffRes.code !== 0 && !diffRes.truncated) {
			return { commitsText: '', diffText: '', truncated: false, error: errorOf(diffRes) };
		}
		const capped = truncateModelInput(diffRes.stdout.toString(), diffRes.truncated);
		return {
			commitsText: logRes.code === 0 ? logRes.stdout.toString().trim() : '',
			diffText: capped.text,
			truncated: capped.truncated || logRes.truncated,
			error: null
		};
	}

	/* Inline Staging, Hunk Staging, Committing & Moving Branches */

	/**
	 * Get the staged, unstaged, untracked & conflicted status of every file in the working tree, plus the HEAD commit message (for Amend).
	 */
	public async getWorkingTreeStatus(repo: string): Promise<{
		files: { path: string, oldPath: string | null, indexStatus: string, workTreeStatus: string, staged: boolean, unstaged: boolean, untracked: boolean, conflicted: boolean }[],
		headMessage: string | null,
		error: GitFeatureError
	}> {
		const [statusRes, headHash] = await Promise.all([
			this.run(repo, ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '-uall']),
			this.resolveCommit(repo, 'HEAD')
		]);
		if (statusRes.code !== 0) return { files: [], headMessage: null, error: errorOf(statusRes) };
		const headMessage = headHash !== null ? await this.getCommitMessage(repo, headHash) : null;
		const tokens = statusRes.stdout.toString().split('\0');
		const files: { path: string, oldPath: string | null, indexStatus: string, workTreeStatus: string, staged: boolean, unstaged: boolean, untracked: boolean, conflicted: boolean }[] = [];
		const conflictPairs = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
		for (let i = 0; i < tokens.length; i++) {
			const entry = tokens[i];
			if (entry.length < 4) continue;
			const x = entry[0], y = entry[1], xy = x + y;
			const filePath = entry.substring(3);
			let oldPath: string | null = null;
			if ((x === 'R' || x === 'C') && i + 1 < tokens.length) {
				oldPath = tokens[++i] || null;
			}
			const untracked = xy === '??';
			const conflicted = conflictPairs.has(xy);
			const staged = !untracked && !conflicted && x !== ' ';
			const unstaged = untracked || conflicted || y !== ' ';
			files.push({
				path: filePath,
				oldPath: oldPath,
				indexStatus: x,
				workTreeStatus: y,
				staged: staged,
				unstaged: unstaged,
				untracked: untracked,
				conflicted: conflicted
			});
		}
		return { files: files, headMessage: headMessage, error: null };
	}

	/**
	 * Stage specific files, or all files when `paths` is NULL.
	 */
	public async stageFiles(repo: string, paths: ReadonlyArray<string> | null): Promise<GitFeatureError> {
		if (paths === null) return this.change(repo, ['add', '-A']);
		if (paths.length === 0) return null;
		return this.change(repo, ['add', '--', ...paths]);
	}

	/**
	 * Unstage specific files, or all staged files when `paths` is NULL.
	 */
	public async unstageFiles(repo: string, paths: ReadonlyArray<string> | null): Promise<GitFeatureError> {
		const head = await this.resolveCommit(repo, 'HEAD');
		if (head === null) {
			return paths === null
				? this.change(repo, ['rm', '--cached', '-r', '-q', '--', '.'])
				: (paths.length === 0 ? null : this.change(repo, ['rm', '--cached', '-r', '-q', '--', ...paths]));
		}
		return paths === null
			? this.change(repo, ['reset', '-q', 'HEAD', '--'])
			: (paths.length === 0 ? null : this.change(repo, ['reset', '-q', 'HEAD', '--', ...paths]));
	}

	/**
	 * Discard working-tree changes to tracked files and/or delete untracked files inside the repository.
	 */
	public async discardWorkingChanges(repo: string, trackedPaths: ReadonlyArray<string>, untrackedPaths: ReadonlyArray<string>): Promise<GitFeatureError> {
		if (trackedPaths.length > 0) {
			const err = await this.change(repo, ['checkout', '--', ...trackedPaths]);
			if (err !== null) return err;
		}
		if (untrackedPaths.length > 0) {
			const repoResolved = path.resolve(repo);
			for (const relPath of untrackedPaths) {
				const abs = path.resolve(repoResolved, relPath);
				const rel = path.relative(repoResolved, abs);
				if (rel.startsWith('..') || path.isAbsolute(rel)) return 'Refusing to delete path outside repository: ' + relPath;
				try {
					await fs.promises.rm(abs, { recursive: true, force: true });
				} catch (e) {
					return String(e);
				}
			}
		}
		return null;
	}

	/**
	 * Get the unified diff of a single file in the index (`staged = true`) or working tree (`staged = false`) for hunk-by-hunk staging.
	 */
	public async getFileHunkDiff(repo: string, filePath: string, staged: boolean): Promise<{ diff: string, error: GitFeatureError }> {
		const args = staged
			? ['-c', 'core.quotepath=false', 'diff', '--cached', '--no-color', '--no-ext-diff', '-U3', '--', filePath]
			: ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-U3', '--', filePath];
		const res = await runGit(this.git, repo, args, null, null, undefined, MAX_EXPLAIN_BYTES);
		if (res.code !== 0 && !res.truncated) return { diff: '', error: errorOf(res) };
		return { diff: res.stdout.toString(), error: null };
	}

	/**
	 * Stage, unstage, or discard an individual unified-diff hunk via `git apply`.
	 */
	public async applyHunkPatch(repo: string, patch: string, action: 'stage' | 'unstage' | 'discard'): Promise<GitFeatureError> {
		const normalized = patch.endsWith('\n') ? patch : patch + '\n';
		const args = action === 'stage'
			? ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-']
			: action === 'unstage'
				? ['apply', '--cached', '-R', '--unidiff-zero', '--whitespace=nowarn', '-']
				: ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', '-'];
		const res = await runGit(this.git, repo, args, normalized, null, { GIT_EDITOR: ':' });
		return res.code === 0 ? null : errorOf(res);
	}

	/**
	 * Create a commit (or amend HEAD) from staged changes, optionally staging all working-tree changes first when nothing is staged.
	 */
	public async commitStagedChanges(
		repo: string,
		message: string,
		amend: boolean,
		stageAllIfEmpty: boolean,
		sign: boolean,
		options?: { readonly noVerify?: boolean, readonly signoff?: boolean }
	): Promise<GitFeatureError> {
		if (message.trim() === '') return 'The commit message can\'t be empty.';
		if (!amend && stageAllIfEmpty) {
			const cached = await this.run(repo, ['diff', '--cached', '--quiet', '--']);
			if (cached.code === 0) {
				const stageErr = await this.stageFiles(repo, null);
				if (stageErr !== null) return stageErr;
			}
		}
		const args = [
			'commit',
			...(sign ? ['-S'] : []),
			...(options && options.signoff ? ['-s'] : []),
			...(options && options.noVerify ? ['--no-verify'] : []),
			...(amend ? ['--amend'] : [])
		];
		return this.withMessageFile(message, (file) => this.change(repo, [...args, '-F', file]));
	}

	/**
	 * Detect active Git hooks (`.git/hooks/*` and `.husky/*`) and read any configured commit message template (`.gitmessage` or `commit.template`).
	 */
	public async getRepoHooksAndTemplate(repo: string): Promise<{
		readonly hooks: ReadonlyArray<{ readonly name: string, readonly path: string }>,
		readonly commitTemplate: string | null
	}> {
		const hooks: { name: string, path: string }[] = [];
		const seenNames = new Set<string>();
		const scanDir = async (dir: string, prefix: string) => {
			try {
				const entries = await fs.promises.readdir(dir, { withFileTypes: true });
				for (const ent of entries) {
					if (!ent.isFile() || ent.name.endsWith('.sample') || ent.name.startsWith('.')) continue;
					const key = prefix + ent.name;
					if (seenNames.has(key)) continue;
					seenNames.add(key);
					hooks.push({ name: key, path: path.join(dir, ent.name) });
				}
			} catch (_) { /* directory absent */ }
		};

		const hooksPathRes = await this.run(repo, ['rev-parse', '--git-path', 'hooks']);
		if (hooksPathRes.code === 0) {
			const raw = hooksPathRes.stdout.toString().trim();
			if (raw !== '') {
				const absHooks = path.isAbsolute(raw) ? raw : path.resolve(repo, raw);
				await scanDir(absHooks, '');
			}
		}
		await scanDir(path.join(repo, '.husky'), '.husky/');

		let commitTemplate: string | null = null;
		const tmplRes = await this.run(repo, ['config', '--get', 'commit.template']);
		const candidates: string[] = [];
		if (tmplRes.code === 0) {
			const configured = tmplRes.stdout.toString().trim();
			if (configured !== '') {
				candidates.push(configured.startsWith('~') ? path.join(os.homedir(), configured.substring(1)) : path.resolve(repo, configured));
			}
		}
		candidates.push(path.join(repo, '.gitmessage'));
		for (const cand of candidates) {
			try {
				const text = await fs.promises.readFile(cand, 'utf8');
				const cleaned = text.split(/\r?\n/).filter((l) => !l.trim().startsWith('#')).join('\n').trim();
				if (cleaned !== '') {
					commitTemplate = cleaned;
					break;
				}
			} catch (_) { /* not found */ }
		}
		return { hooks: hooks, commitTemplate: commitTemplate };
	}

	/**
	 * Read the `git notes` text attached to a commit, or NULL if no note exists.
	 */
	public async getCommitNote(repo: string, commitHash: string): Promise<string | null> {
		if (!HASH_REGEXP.test(commitHash)) return null;
		const res = await this.run(repo, ['notes', 'show', commitHash]);
		return res.code === 0 ? res.stdout.toString().trim() : null;
	}

	/**
	 * Add, update, or remove a `git notes` entry on a commit.
	 */
	public async setCommitNote(repo: string, commitHash: string, note: string | null): Promise<GitFeatureError> {
		if (!HASH_REGEXP.test(commitHash)) return 'Invalid commit hash.';
		if (note === null || note.trim() === '') {
			const res = await this.run(repo, ['notes', 'remove', commitHash]);
			return res.code === 0 || res.stderr.includes('has no note') ? null : errorOf(res);
		}
		return this.withMessageFile(note.trim(), (file) => this.change(repo, ['notes', 'add', '-f', '-F', file, commitHash]));
	}

	/**
	 * Retrieve GPG / SSH signature verification details (status, signer, key ID, fingerprint) for a commit.
	 */
	public async getCommitSignatureDetails(repo: string, commitHash: string): Promise<{
		readonly status: string,
		readonly signer: string,
		readonly keyId: string,
		readonly fingerprint: string
	} | null> {
		if (!HASH_REGEXP.test(commitHash)) return null;
		const res = await this.run(repo, ['log', '-1', '--format=%G?%x1f%GS%x1f%GK%x1f%GF', commitHash]);
		if (res.code !== 0) return null;
		const parts = res.stdout.toString().trim().split('\x1f');
		const status = (parts[0] || '').trim();
		if (status === '' || status === 'N') return null;
		return {
			status: status,
			signer: (parts[1] || '').trim(),
			keyId: (parts[2] || '').trim(),
			fingerprint: (parts[3] || '').trim()
		};
	}

	/**
	 * Execute a built-in or user-defined Git workflow macro (safe tokenized git subcommands — never executed via a shell).
	 */
	public async runWorkflowMacro(repo: string, macroId: string, customSteps?: ReadonlyArray<string>): Promise<{ summary: string, error: GitFeatureError }> {
		if (macroId === 'fetch-rebase-prune') {
			const fetchErr = await this.change(repo, ['fetch', '--all', '--prune']);
			if (fetchErr !== null) return { summary: '', error: fetchErr };
			const upRes = await this.run(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
			if (upRes.code !== 0) {
				return { summary: 'Fetched and pruned remotes (no upstream tracking branch configured for rebase).', error: null };
			}
			const upstream = upRes.stdout.toString().trim();
			const rebaseErr = await this.change(repo, ['rebase', upstream]);
			if (rebaseErr !== null) return { summary: '', error: rebaseErr };
			return { summary: 'Fetched, pruned, and rebased onto ' + upstream + '.', error: null };
		}
		if (macroId === 'stash-pull-pop') {
			const wt = await this.getWorkingTreeStatus(repo);
			const hasDirty = wt.files.length > 0;
			if (hasDirty) {
				const stashErr = await this.change(repo, ['stash', 'push', '-u', '-m', 'git-map-macro-autostash']);
				if (stashErr !== null) return { summary: '', error: stashErr };
			}
			const pullErr = await this.change(repo, ['pull', '--rebase']);
			if (pullErr !== null) return { summary: '', error: pullErr };
			if (hasDirty) {
				const popErr = await this.change(repo, ['stash', 'pop']);
				if (popErr !== null) return { summary: '', error: popErr };
			}
			return { summary: hasDirty ? 'Stashed changes, pulled with rebase, and restored stash.' : 'Pulled latest changes with rebase.', error: null };
		}
		if (Array.isArray(customSteps) && customSteps.length > 0) {
			const executed: string[] = [];
			for (const rawStep of customSteps) {
				const tokens = rawStep.trim().split(/\s+/).filter((s: string) => s !== '');
				if (tokens.length === 0) continue;
				const args = tokens[0] === 'git' ? tokens.slice(1) : tokens;
				if (args.length === 0) continue;
				const err = await this.change(repo, args);
				if (err !== null) return { summary: executed.join(' → '), error: 'Step "git ' + args.join(' ') + '" failed: ' + err };
				executed.push('git ' + args.join(' '));
			}
			return { summary: 'Completed: ' + executed.join(' → '), error: null };
		}
		return { summary: '', error: 'Unknown workflow macro: ' + macroId };
	}

	/**
	 * Move a non-checked-out local branch pointer to a target commit (`git branch -f`).
	 */
	public async moveBranch(repo: string, branchName: string, targetHash: string): Promise<GitFeatureError> {
		if (branchName.startsWith('-') || branchName === '') return 'Invalid branch name.';
		if (!HASH_REGEXP.test(targetHash)) return 'Invalid commit hash.';
		const current = (await this.run(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.toString().trim();
		if (current === branchName) {
			return 'The checked-out branch "' + branchName + '" must be moved with Reset instead.';
		}
		return this.change(repo, ['branch', '-f', '--', branchName, targetHash]);
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

function truncateModelInput(raw: string, alreadyTruncated: boolean) {
	const rawLines = raw.split(/\r?\n/);
	let truncated = alreadyTruncated || rawLines.length > MAX_EXPLAIN_DIFF_LINES;
	const lines = (rawLines.length > MAX_EXPLAIN_DIFF_LINES ? rawLines.slice(0, MAX_EXPLAIN_DIFF_LINES) : rawLines).map((line) => {
		if (line.length > MAX_EXPLAIN_LINE_CHARS) {
			truncated = true;
			return line.substring(0, MAX_EXPLAIN_LINE_CHARS) + ' …';
		}
		return line;
	});
	let text = lines.join('\n');
	if (text.length > MAX_EXPLAIN_CHARS) {
		text = text.substring(0, MAX_EXPLAIN_CHARS);
		truncated = true;
	}
	return { text: text, truncated: truncated };
}

/**
 * Construct a unified-diff patch that stages, unstages, or discards only the selected `+` / `-` line indices within a single hunk.
 */
export function buildPartialHunkPatch(
	diffHeader: string,
	hunkHeaderLine: string,
	hunkLines: ReadonlyArray<string>,
	selectedIndices: ReadonlySet<number>,
	action: 'stage' | 'unstage' | 'discard',
	filePath?: string
): string | null {
	const m = hunkHeaderLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
	if (m === null) return null;
	let oldStart = parseInt(m[1], 10);
	let newStart = parseInt(m[3], 10);
	const tail = m[5] || '';
	const forward = action === 'stage';
	const out: string[] = [];
	let oldCount = 0, newCount = 0, changedCount = 0;
	let k = 0;
	while (k < hunkLines.length) {
		const ln = hunkLines[k];
		if (ln.startsWith(' ')) {
			out.push(ln);
			oldCount++;
			newCount++;
			k++;
			continue;
		}
		if (ln.startsWith('\\')) {
			out.push(ln);
			k++;
			continue;
		}
		// Collect a contiguous [-... / +...] change group (preserving any trailing "\ No newline" attached to the last - or +)
		const dels: { idx: number, text: string, noEol: string | null }[] = [];
		const adds: { idx: number, text: string, noEol: string | null }[] = [];
		while (k < hunkLines.length && (hunkLines[k].startsWith('-') || hunkLines[k].startsWith('\\'))) {
			if (hunkLines[k].startsWith('-')) {
				const item = { idx: k, text: hunkLines[k].substring(1), noEol: <string | null>null };
				if (k + 1 < hunkLines.length && hunkLines[k + 1].startsWith('\\')) {
					item.noEol = hunkLines[++k];
				}
				dels.push(item);
			}
			k++;
		}
		while (k < hunkLines.length && (hunkLines[k].startsWith('+') || hunkLines[k].startsWith('\\'))) {
			if (hunkLines[k].startsWith('+')) {
				const item = { idx: k, text: hunkLines[k].substring(1), noEol: <string | null>null };
				if (k + 1 < hunkLines.length && hunkLines[k + 1].startsWith('\\')) {
					item.noEol = hunkLines[++k];
				}
				adds.push(item);
			}
			k++;
		}

		let pendingDel: { text: string, noEol: string | null }[] = [];
		let pendingAdd: { text: string, noEol: string | null }[] = [];
		const flushPending = () => {
			for (const d of pendingDel) {
				out.push('-' + d.text);
				if (d.noEol !== null) out.push(d.noEol);
				oldCount++;
				changedCount++;
			}
			for (const a of pendingAdd) {
				out.push('+' + a.text);
				if (a.noEol !== null) out.push(a.noEol);
				newCount++;
				changedCount++;
			}
			pendingDel = [];
			pendingAdd = [];
		};

		const maxLen = Math.max(dels.length, adds.length);
		for (let i = 0; i < maxLen; i++) {
			const d = i < dels.length ? dels[i] : null;
			const a = i < adds.length ? adds[i] : null;
			if (forward) {
				if (d !== null) {
					if (selectedIndices.has(d.idx)) {
						pendingDel.push(d);
					} else {
						flushPending();
						out.push(' ' + d.text);
						if (d.noEol !== null) out.push(d.noEol);
						oldCount++;
						newCount++;
					}
				}
				if (a !== null && selectedIndices.has(a.idx)) {
					pendingAdd.push(a);
				}
			} else {
				if (d !== null && selectedIndices.has(d.idx)) {
					pendingDel.push(d);
				}
				if (a !== null) {
					if (selectedIndices.has(a.idx)) {
						pendingAdd.push(a);
					} else {
						flushPending();
						out.push(' ' + a.text);
						if (a.noEol !== null) out.push(a.noEol);
						oldCount++;
						newCount++;
					}
				}
			}
		}
		flushPending();
	}

	if (changedCount === 0) return null;
	if (oldStart === 0 && oldCount > 0) oldStart = 1;
	if (newStart === 0 && newCount > 0) newStart = 1;

	let header = diffHeader;
	const inferredPath = filePath || (header.match(/^\+\+\+ b\/(.+)$/m) || header.match(/^--- a\/(.+)$/m) || [])[1] || '';
	if (oldCount > 0 && header.includes('--- /dev/null') && inferredPath !== '') {
		header = header
			.split('\n')
			.filter((l) => !l.startsWith('new file mode ') && !l.startsWith('index '))
			.map((l) => l === '--- /dev/null' ? ('--- a/' + inferredPath) : l)
			.join('\n');
	}
	if (newCount > 0 && header.includes('+++ /dev/null') && inferredPath !== '') {
		header = header
			.split('\n')
			.filter((l) => !l.startsWith('deleted file mode ') && !l.startsWith('index '))
			.map((l) => l === '+++ /dev/null' ? ('+++ b/' + inferredPath) : l)
			.join('\n');
	}

	const newHeaderLine = '@@ -' + oldStart + ',' + oldCount + ' +' + newStart + ',' + newCount + ' @@' + tail;
	return header + '\n' + newHeaderLine + '\n' + out.join('\n') + '\n';
}
