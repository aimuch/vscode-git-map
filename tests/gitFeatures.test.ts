import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GitFeatures } from '../src/gitFeatures';
import { GitProcessRunner } from '../src/historyRewrite';
import { UndoManager } from '../src/undoManager';

// These tests run Git itself, in repositories created in a temporary directory
jest.setTimeout(60000);

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
	GIT_TERMINAL_PROMPT: '0'
});

let directory: string, repo: string, repoIndex = 0, features: GitFeatures, undoManager: UndoManager;

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function git(...args: string[]) {
	return gitIn(repo, ...args);
}

function write(file: string, contents: string) {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), contents);
}

function read(file: string) {
	return fs.readFileSync(path.join(repo, file), 'utf8');
}

function commit(message: string, files: { [file: string]: string | null } = {}) {
	Object.keys(files).forEach((file) => {
		const contents = files[file];
		if (contents === null) {
			fs.unlinkSync(path.join(repo, file));
		} else {
			write(file, contents);
		}
	});
	git('add', '-A');
	git('commit', '-q', '--allow-empty', '-m', message);
	return git('rev-parse', 'HEAD');
}

function createRepo(name: string) {
	const dir = path.join(directory, name + '-' + (++repoIndex));
	fs.mkdirSync(dir);
	gitIn(dir, 'init', '-q', '-b', 'main');
	return dir;
}

beforeAll(() => {
	directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-features-'));
	const runner: GitProcessRunner & { execGit: (args: string[], cwd: string) => Promise<string> } = {
		spawnGitProcess: (args, cwd, env) => cp.spawn('git', args, { cwd: cwd, env: Object.assign({}, GIT_ENV, env) }),
		getGitVersion: () => gitIn(directory, '--version').replace('git version ', ''),
		getOperationInProgress: () => Promise.resolve(null),
		execGit: (args, cwd) => new Promise((resolve, reject) => {
			cp.execFile('git', args, { cwd: cwd, env: GIT_ENV }, (err, stdout, stderr) => {
				if (err) reject(stderr || err.message); else resolve(stdout);
			});
		})
	};
	features = new GitFeatures(runner);
	undoManager = new UndoManager(runner as any);
});

afterAll(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
	repo = createRepo('repo');
});

describe('compareBranches', () => {
	it('Should return the commits only on each branch, and their merge base', async () => {
		// Setup
		const base = commit('Base', { 'a.txt': 'a\n' });
		git('checkout', '-q', '-b', 'feature');
		const f1 = commit('F1', { 'f.txt': '1\n' });
		const f2 = commit('F2', { 'f.txt': '2\n' });
		git('checkout', '-q', 'main');
		const m1 = commit('M1', { 'm.txt': '1\n' });

		// Run
		const result = await features.compareBranches(repo, 'feature', 'main');

		// Assert
		expect(result).toStrictEqual({
			comparison: { left: 'feature', right: 'main', leftHash: f2, rightHash: m1, mergeBase: base, leftOnly: [f2, f1], rightOnly: [m1] },
			error: null
		});
	});

	it('Should compare branches without a common ancestor', async () => {
		// Setup
		const a = commit('A', { 'a.txt': 'a\n' });
		git('checkout', '-q', '--orphan', 'other');
		const b = commit('B', { 'b.txt': 'b\n' });

		// Run
		const result = await features.compareBranches(repo, 'main', 'other');

		// Assert
		expect(result.comparison).toStrictEqual({ left: 'main', right: 'other', leftHash: a, rightHash: b, mergeBase: null, leftOnly: [a], rightOnly: [b] });
	});

	it('Should return an error when a branch doesn\'t exist', async () => {
		// Setup
		commit('A');

		// Run
		const result = await features.compareBranches(repo, 'main', 'missing');

		// Assert
		expect(result).toStrictEqual({ comparison: null, error: 'Unable to resolve "missing" to a commit.' });
	});

	it('Shouldn\'t treat a branch name as an option', async () => {
		// Setup
		commit('A');

		// Run
		const result = await features.compareBranches(repo, '--all', 'main');

		// Assert
		expect(result.error).toBe('Unable to resolve "--all" to a commit.');
	});
});

describe('getBranchCleanupCandidates', () => {
	it('Should return the merged branches, and those whose upstream branch was deleted', async () => {
		// Setup
		const origin = createRepo('origin');
		gitIn(origin, 'config', 'receive.denyCurrentBranch', 'ignore');
		commit('Base', { 'a.txt': 'a\n' });
		git('remote', 'add', 'origin', origin);
		git('push', '-q', 'origin', 'main');

		git('branch', 'merged');
		git('push', '-q', 'origin', 'merged');

		git('checkout', '-q', '-b', 'gone');
		commit('Gone 1', { 'g.txt': '1\n' });
		commit('Gone 2', { 'g.txt': '2\n' });
		git('push', '-q', '-u', 'origin', 'gone');
		gitIn(origin, 'branch', '-D', 'gone');
		git('fetch', '-q', '--prune', 'origin');

		git('checkout', '-q', '-b', 'unmerged', 'main');
		commit('Unmerged', { 'u.txt': 'u\n' });

		git('branch', 'in-worktree', 'main');
		git('worktree', 'add', '-q', path.join(directory, 'worktree-' + repoIndex), 'in-worktree');
		git('checkout', '-q', 'main');

		// Run
		const result = await features.getBranchCleanupCandidates(repo);

		// Assert
		expect(result.error).toBeNull();
		expect(result.defaultBranch).toBe('main');
		expect(result.candidates.map((candidate) => ({ name: candidate.name, merged: candidate.merged, upstream: candidate.upstream, upstreamGone: candidate.upstreamGone, unmergedCommits: candidate.unmergedCommits, remotes: candidate.remotes }))).toStrictEqual([
			{ name: 'merged', merged: true, upstream: null, upstreamGone: false, unmergedCommits: 0, remotes: ['origin'] },
			{ name: 'gone', merged: false, upstream: 'origin/gone', upstreamGone: true, unmergedCommits: 2, remotes: [] }
		]);
		expect(result.candidates[0].author).toBe('Test Author');
	});

	it('Should list the branches that were rebased or squashed into the default branch', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		git('branch', '-M', 'main');

		git('checkout', '-q', '-b', 'squashed');
		commit('Squashed 1', { 's.txt': '1\n' });
		commit('Squashed 2', { 's.txt': '2\n', 't.txt': 't\n' });

		git('checkout', '-q', '-b', 'rebased', 'main');
		commit('Rebased 1', { 'r.txt': 'r\n' });

		git('checkout', '-q', '-b', 'open', 'main');
		commit('Open 1', { 'o.txt': 'o\n' });

		// Land "squashed" (as one commit) & "rebased" (as an equivalent commit) on main, after another commit
		git('checkout', '-q', 'main');
		commit('Other', { 'b.txt': 'b\n' });
		git('merge', '-q', '--squash', 'squashed');
		git('commit', '-q', '-m', 'Squashed (#1)');
		git('cherry-pick', 'rebased');

		// Run
		const result = await features.getBranchCleanupCandidates(repo);

		// Assert
		expect(result.error).toBeNull();
		expect(result.candidates.map((candidate) => ({ name: candidate.name, merged: candidate.merged, landed: candidate.landed, unmergedCommits: candidate.unmergedCommits })).sort((a, b) => a.name.localeCompare(b.name))).toStrictEqual([
			{ name: 'rebased', merged: true, landed: 'rebased', unmergedCommits: 0 },
			{ name: 'squashed', merged: true, landed: 'squashed', unmergedCommits: 0 }
		]);
	});

	it('Should use the branch that origin/HEAD refers to as the default branch', async () => {
		// Setup
		commit('Base');
		git('branch', '-m', 'trunk');
		git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
		git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

		// Run
		const result = await features.getDefaultBranch(repo);

		// Assert
		expect(result).toBe('trunk');
	});

	it('Should return no default branch when there isn\'t one', async () => {
		// Setup
		commit('Base');
		git('branch', '-m', 'trunk');

		// Run
		const result = await features.getBranchCleanupCandidates(repo);

		// Assert
		expect(result).toStrictEqual({ defaultBranch: null, candidates: [], error: null });
	});
});

describe('Merge targets', () => {
	it('Should use the default branch, or the merge target chosen for the branch, and report how far it is from it', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		git('branch', '-M', 'main');
		git('branch', 'develop');
		git('checkout', '-q', '-b', 'feature');
		commit('Feature 1', { 'f.txt': '1\n' });
		commit('Feature 2', { 'f.txt': '2\n' });
		git('checkout', '-q', 'main');
		commit('Main 1', { 'm.txt': '1\n' });

		// Run & Assert: the default branch
		expect(await features.getMergeTarget(repo, 'feature')).toStrictEqual({ target: 'main', chosen: false });
		let status = (await features.getMergeTargetStatus(repo, 'feature')).status!;
		expect({ target: status.target, chosen: status.chosen, ahead: status.ahead, behind: status.behind, landed: status.landed }).toStrictEqual({ target: 'main', chosen: false, ahead: 2, behind: 1, landed: null });

		// Run & Assert: a merge target chosen for the branch
		expect(await features.setMergeTarget(repo, 'feature', 'develop')).toBeNull();
		expect(git('config', '--get', 'branch.feature.gitMapMergeTarget').trim()).toBe('develop');
		status = (await features.getMergeTargetStatus(repo, 'feature')).status!;
		expect({ target: status.target, chosen: status.chosen, ahead: status.ahead, behind: status.behind }).toStrictEqual({ target: 'develop', chosen: true, ahead: 2, behind: 0 });

		// Run & Assert: its range to explain starts where it diverged from the merge target
		const range = await features.getBranchRangeForExplanation(repo, 'feature', null);
		expect(range.error).toBeNull();
		expect(range.base).toBe('develop');
		expect(range.fromRef).toBe(git('rev-parse', 'develop').trim());

		// Run & Assert: once its work has landed in the merge target
		git('checkout', '-q', 'develop');
		git('merge', '-q', '--ff-only', 'feature');
		status = (await features.getMergeTargetStatus(repo, 'feature')).status!;
		expect(status.landed).toBe('merged');

		// Run & Assert: invalid names are refused, and clearing it returns to the default branch
		expect(await features.setMergeTarget(repo, 'feature', '--upload-pack=x')).toBe('Invalid merge target: --upload-pack=x');
		expect(await features.setMergeTarget(repo, 'feature', 'feature')).toBe('Invalid merge target: feature');
		expect(await features.setMergeTarget(repo, 'feature', null)).toBeNull();
		expect(await features.setMergeTarget(repo, 'feature', null)).toBeNull();
		expect(await features.getMergeTarget(repo, 'feature')).toStrictEqual({ target: 'main', chosen: false });
	});
});

describe('predictRebaseConflicts', () => {
	it('Should predict the first commit that conflicts, without changing the repository', async () => {
		// Setup
		commit('Base', { 'a.txt': 'base\n' });
		git('checkout', '-q', '-b', 'feature');
		const clean = commit('Clean', { 'b.txt': 'b\n' });
		const conflicting = commit('Conflicting', { 'a.txt': 'feature\n' });
		const after = commit('After', { 'c.txt': 'c\n' });
		git('checkout', '-q', 'main');
		commit('Main', { 'a.txt': 'main\n' });
		git('checkout', '-q', 'feature');
		const head = git('rev-parse', 'HEAD'), status = git('status', '--porcelain');

		// Run
		const result = await features.predictRebaseConflicts(repo, 'main', [
			{ action: 'pick', hash: clean },
			{ action: 'pick', hash: conflicting },
			{ action: 'squash', hash: after }
		]);

		// Assert
		expect(result.error).toBeNull();
		if (result.unsupported) return; // Git before 2.40
		expect(result.results).toStrictEqual([
			{ hash: clean, state: 'clean', files: [] },
			{ hash: conflicting, state: 'conflict', files: ['a.txt'] },
			{ hash: after, state: 'unknown', files: [] }
		]);
		expect(git('rev-parse', 'HEAD')).toBe(head);
		expect(git('status', '--porcelain')).toBe(status);

		// Run & Assert: dropping the conflicting commit
		const dropped = await features.predictRebaseConflicts(repo, 'main', [
			{ action: 'pick', hash: clean },
			{ action: 'drop', hash: conflicting },
			{ action: 'pick', hash: after }
		]);
		expect(dropped.results.map((r) => r.state)).toStrictEqual(['clean', 'clean']);
	});
});

describe('Explaining changes', () => {
	it('Should get the working changes, including untracked files, compared with HEAD', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'a\nstaged\n');
		git('add', 'a.txt');
		write('a.txt', 'a\nstaged\nunstaged\n');
		write('new.txt', 'brand new\n');

		// Run
		const result = await features.getWorkingChangesForExplanation(repo);

		// Assert
		expect(result.error).toBeNull();
		expect(result.text).toContain('+staged');
		expect(result.text).toContain('+unstaged');
		expect(result.text).toContain('Untracked files (1): new.txt');
		expect(result.text).toContain('+brand new');
	});

	it('Should return no working changes when there are none', async () => {
		commit('Base', { 'a.txt': 'a\n' });
		expect(await features.getWorkingChangesForExplanation(repo)).toStrictEqual({ text: '', truncated: false, error: null });
	});

	it('Should get the changes of a stash, including its untracked files', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'a\nchanged\n');
		write('u.txt', 'untracked\n');
		git('stash', 'push', '-q', '--include-untracked', '-m', 'Work in progress');
		const hash = git('rev-parse', 'stash@{0}').trim();

		// Run
		const result = await features.getStashForExplanation(repo, hash);

		// Assert
		expect(result.error).toBeNull();
		expect(result.text).toContain('Stash: On main: Work in progress');
		expect(result.text).toContain('+changed');
		expect(result.text).toContain('Untracked files of the stash:');
		expect(result.text).toContain('+untracked');
	});

	it('Should get the range of the unpushed commits of a branch', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		git('branch', '-M', 'main');
		expect((await features.getUnpushedRange(repo, null)).error).toBe('The branch "main" has no upstream branch.');
		git('remote', 'add', 'origin', 'https://example.invalid/repo.git');
		git('update-ref', 'refs/remotes/origin/main', 'HEAD');
		git('config', 'branch.main.remote', 'origin');
		git('config', 'branch.main.merge', 'refs/heads/main');

		// Run
		const result = await features.getUnpushedRange(repo, null);

		// Assert
		expect(result).toStrictEqual({ fromRef: 'origin/main', toRef: 'refs/heads/main', branch: 'main', upstream: 'origin/main', error: null });
	});
});

describe('Rewriting the latest commits', () => {
	it('Should change the message of the latest commit, keeping the staged changes staged', async () => {
		// Setup
		commit('Old message', { 'a.txt': 'a\n' });
		write('a.txt', 'staged\n');
		git('add', 'a.txt');

		// Run
		const result = await features.amendMessage(repo, 'New subject\n\nNew body\n', false);

		// Assert
		expect(result).toBeNull();
		expect(git('log', '-1', '--format=%B')).toBe('New subject\n\nNew body');
		expect(git('diff', '--cached', '--name-only')).toBe('a.txt');
		expect(git('show', 'HEAD:a.txt')).toBe('a');
	});

	it('Shouldn\'t change the message to an empty message', async () => {
		// Setup
		commit('Message');

		// Run
		const result = await features.amendMessage(repo, '  \n', false);

		// Assert
		expect(result).toBe('The message can\'t be empty.');
		expect(git('log', '-1', '--format=%s')).toBe('Message');
	});

	it('Should undo the latest commit, keeping its changes staged (soft)', async () => {
		// Setup
		const parent = commit('Parent', { 'a.txt': 'a\n' });
		commit('Latest', { 'a.txt': 'b\n' });

		// Run
		const result = await features.undoCommit(repo, 'soft');

		// Assert
		expect(result).toBeNull();
		expect(git('rev-parse', 'HEAD')).toBe(parent);
		expect(git('diff', '--cached', '--name-only')).toBe('a.txt');
		expect(read('a.txt')).toBe('b\n');
	});

	it('Should undo the latest commit, keeping its changes in the working tree (mixed)', async () => {
		// Setup
		const parent = commit('Parent', { 'a.txt': 'a\n' });
		commit('Latest', { 'a.txt': 'b\n' });

		// Run
		const result = await features.undoCommit(repo, 'mixed');

		// Assert
		expect(result).toBeNull();
		expect(git('rev-parse', 'HEAD')).toBe(parent);
		expect(git('diff', '--cached', '--name-only')).toBe('');
		expect(git('diff', '--name-only')).toBe('a.txt');
	});

	it('Shouldn\'t undo the first commit', async () => {
		// Setup
		const first = commit('First');

		// Run
		const result = await features.undoCommit(repo, 'soft');

		// Assert
		expect(result).toBe('The commit doesn\'t have a parent, so it can\'t be undone.');
		expect(git('rev-parse', 'HEAD')).toBe(first);
	});

	it('Should fix up a commit with the staged changes, keeping the unstaged changes', async () => {
		// Setup
		commit('A', { 'a.txt': 'a\n' });
		const target = commit('B', { 'b.txt': 'b\n' });
		commit('C', { 'c.txt': 'c\n' });
		write('b.txt', 'b fixed\n');
		git('add', 'b.txt');
		write('c.txt', 'c unstaged\n');

		// Run
		const result = await features.fixupCommit(repo, target, false);

		// Assert
		expect(result).toBeNull();
		expect(git('log', '--format=%s')).toBe('C\nB\nA');
		expect(git('show', 'HEAD~1:b.txt')).toBe('b fixed');
		expect(read('c.txt')).toBe('c unstaged\n');
		expect(git('diff', '--cached', '--name-only')).toBe('');
	});

	it('Should fix up the first commit', async () => {
		// Setup
		const target = commit('A', { 'a.txt': 'a\n' });
		commit('B', { 'b.txt': 'b\n' });
		write('a.txt', 'a fixed\n');
		git('add', 'a.txt');

		// Run
		const result = await features.fixupCommit(repo, target, false);

		// Assert
		expect(result).toBeNull();
		expect(git('log', '--format=%s')).toBe('B\nA');
		expect(git('show', 'HEAD~1:a.txt')).toBe('a fixed');
	});

	it('Shouldn\'t fix up a commit when there aren\'t any staged changes', async () => {
		// Setup
		const target = commit('A', { 'a.txt': 'a\n' });
		write('a.txt', 'unstaged\n');

		// Run
		const result = await features.fixupCommit(repo, target, false);

		// Assert
		expect(result).toBe('There aren\'t any staged changes to add to the commit.');
		expect(git('rev-parse', 'HEAD')).toBe(target);
	});

	it('Should get the message of a commit', async () => {
		// Setup
		const hash = commit('Subject\n\nBody line');

		// Run
		const result = await features.getCommitMessage(repo, hash);

		// Assert
		expect(result).toBe('Subject\n\nBody line');
	});
});

describe('Bisecting', () => {
	it('Should find the first bad commit', async () => {
		// Setup
		const hashes: string[] = [];
		for (let i = 0; i < 8; i++) hashes.push(commit('Commit ' + i, { 'value.txt': (i >= 5 ? 'bug ' : 'ok ') + i + '\n' }));

		// Run
		expect(await features.bisect(repo, 'start', 'HEAD', hashes[0])).toBeNull();
		let state = await features.getBisectState(repo);
		expect(state).not.toBeNull();
		expect(state!.bad).toBe(hashes[7]);
		expect(state!.good).toStrictEqual([hashes[0]]);
		expect(state!.remaining).not.toBeNull();
		expect(state!.steps).not.toBeNull();
		expect(state!.candidates).toStrictEqual(hashes.slice(1).reverse());
		for (let step = 0; step < 10 && state !== null && state.firstBad === null; step++) {
			const action = read('value.txt').startsWith('bug') ? 'bad' : 'good';
			expect(await features.bisect(repo, action, null, null)).toBeNull();
			state = await features.getBisectState(repo);
		}

		// Assert
		expect(state!.firstBad).toBe(hashes[5]);

		// Run
		expect(await features.bisect(repo, 'reset', null, null)).toBeNull();

		// Assert
		expect(await features.getBisectState(repo)).toBeNull();
		expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
	});

	it('Should skip a commit', async () => {
		// Setup
		const first = commit('A', { 'a.txt': '1\n' });
		for (let i = 2; i <= 6; i++) commit('Commit ' + i, { 'a.txt': i + '\n' });
		await features.bisect(repo, 'start', 'HEAD', first);
		const current = git('rev-parse', 'HEAD');

		// Run
		const result = await features.bisect(repo, 'skip', current, null);

		// Assert
		expect(result).toBeNull();
		expect((await features.getBisectState(repo))!.skipped).toStrictEqual([current]);
	});

	it('Shouldn\'t start bisecting when the good commit isn\'t an ancestor of the bad commit', async () => {
		// Setup
		const first = commit('A', { 'a.txt': '1\n' });
		commit('B', { 'a.txt': '2\n' });

		// Run
		const result = await features.bisect(repo, 'start', first, 'HEAD');

		// Assert
		expect(result).toBe('The good commit must be an ancestor of the bad commit.');
		expect(await features.getBisectState(repo)).toBeNull();
	});

	it('Should return an error when a commit doesn\'t exist', async () => {
		// Setup
		commit('A');

		// Run
		const result = await features.bisect(repo, 'start', 'HEAD', 'v9.9.9');

		// Assert
		expect(result).toBe('Unable to resolve "v9.9.9" to a commit.');
	});

	it('Shouldn\'t mark a commit with an invalid hash', async () => {
		// Run
		const result = await features.bisect(repo, 'good', '--help', null);

		// Assert
		expect(result).toBe('Invalid commit hash: --help');
	});
});

describe('Patches', () => {
	it('Should save commits as a patch, and apply it as commits', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		git('checkout', '-q', '-b', 'feature');
		const f1 = commit('Feature 1', { 'f.txt': 'one\n' });
		const f2 = commit('Feature 2\n\nWith a body', { 'f.txt': 'one\ntwo\n' });
		git('checkout', '-q', 'main');
		const { patch, error } = await features.getCommitsPatch(repo, [f1, f2]);
		expect(error).toBeNull();
		const file = path.join(directory, 'commits-' + repoIndex + '.patch');
		fs.writeFileSync(file, patch);

		// Run
		const check = await features.checkPatch(repo, file);

		// Assert
		expect(check).toStrictEqual({
			patch: { file: file, name: path.basename(file), commits: 2, files: 2, additions: 2, deletions: 0, appliesCleanly: true, checkError: null },
			error: null
		});

		// Run
		const result = await features.applyPatch(repo, file, true);

		// Assert
		expect(result).toBeNull();
		expect(git('log', '--format=%s', '-3')).toBe('Feature 2\nFeature 1\nBase');
		expect(git('log', '-1', '--format=%b')).toBe('With a body');
		expect(read('f.txt')).toBe('one\ntwo\n');
	});

	it('Should save the uncommitted changes as a patch, and apply it as uncommitted changes', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'a\nchanged\n');
		const { patch, error } = await features.getUncommittedPatch(repo);
		expect(error).toBeNull();
		git('checkout', '--', 'a.txt');
		const file = path.join(directory, 'changes-' + repoIndex + '.patch');
		fs.writeFileSync(file, patch);

		// Run
		const check = await features.checkPatch(repo, file);
		const result = await features.applyPatch(repo, file, false);

		// Assert
		expect(check.patch!.commits).toBe(0);
		expect(check.patch!.appliesCleanly).toBe(true);
		expect(result).toBeNull();
		expect(read('a.txt')).toBe('a\nchanged\n');
	});

	it('Should save a stash as a patch, including its untracked files', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'stashed\n');
		write('new.txt', 'untracked\n');
		git('stash', 'push', '-q', '--include-untracked');
		const stash = git('rev-parse', 'stash@{0}');

		// Run
		const { patch, error } = await features.getStashPatch(repo, stash);

		// Assert
		expect(error).toBeNull();
		expect(patch).toContain('diff --git a/a.txt b/a.txt');
		expect(patch).toContain('+stashed');
		expect(patch).toContain('diff --git a/new.txt b/new.txt');
		expect(patch).toContain('+untracked');
	});

	it('Should report a patch that doesn\'t apply cleanly', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		const file = path.join(directory, 'conflict-' + repoIndex + '.patch');
		fs.writeFileSync(file, 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-something else\n+b\n');

		// Run
		const result = await features.checkPatch(repo, file);

		// Assert
		expect(result.error).toBeNull();
		expect(result.patch!.appliesCleanly).toBe(false);
		expect(result.patch!.checkError).not.toBeNull();
	});

	it('Should return an error for a file that isn\'t a patch', async () => {
		// Setup
		commit('Base');
		const file = path.join(directory, 'not-a-patch-' + repoIndex + '.txt');
		fs.writeFileSync(file, 'Just some text\n');

		// Run
		const result = await features.checkPatch(repo, file);

		// Assert
		expect(result.patch).toBeNull();
		expect(result.error).toMatch(/^The file isn't a patch: /);
	});
});

describe('Stashes', () => {
	it('Should get the files that can be stashed', async () => {
		// Setup
		commit('Base', { 'staged.txt': '1\n', 'both.txt': '1\n', 'unstaged.txt': '1\n', 'old name.txt': 'renamed\n' });
		write('staged.txt', '2\n');
		write('both.txt', '2\n');
		git('add', 'staged.txt', 'both.txt');
		write('both.txt', '3\n');
		write('unstaged.txt', '2\n');
		write('dir/new.txt', 'new\n');
		git('mv', 'old name.txt', 'new name.txt');

		// Run
		const result = await features.getStashableFiles(repo);

		// Assert
		expect(result.error).toBeNull();
		expect(result.files.sort((a, b) => a.path.localeCompare(b.path))).toStrictEqual([
			{ path: 'both.txt', staged: true, unstaged: true, untracked: false },
			{ path: 'dir/new.txt', staged: false, unstaged: false, untracked: true },
			{ path: 'new name.txt', staged: true, unstaged: false, untracked: false },
			{ path: 'staged.txt', staged: true, unstaged: false, untracked: false },
			{ path: 'unstaged.txt', staged: false, unstaged: true, untracked: false }
		]);
	});

	it('Should restore a file from a stash, leaving the stash as it is', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
		write('a.txt', 'stashed a\n');
		write('b.txt', 'stashed b\n');
		git('stash', 'push', '-q');
		const stash = git('rev-parse', 'stash@{0}');

		// Run
		const result = await features.restoreFileFromStash(repo, stash, 'a.txt', false, false);

		// Assert
		expect(result).toStrictEqual({ error: null, hasChanges: false });
		expect(read('a.txt')).toBe('stashed a\n');
		expect(read('b.txt')).toBe('b\n');
		expect(git('rev-parse', 'stash@{0}')).toBe(stash);
	});

	it('Should restore an untracked file from a stash', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('dir/new.txt', 'untracked\n');
		git('stash', 'push', '-q', '--include-untracked');
		const stash = git('rev-parse', 'stash@{0}');

		// Run
		const result = await features.restoreFileFromStash(repo, stash, 'dir/new.txt', true, false);

		// Assert
		expect(result).toStrictEqual({ error: null, hasChanges: false });
		expect(read('dir/new.txt')).toBe('untracked\n');
	});

	it('Should only replace a file with uncommitted changes when forced', async () => {
		// Setup
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'stashed\n');
		git('stash', 'push', '-q');
		const stash = git('rev-parse', 'stash@{0}');
		write('a.txt', 'current\n');

		// Run
		const notForced = await features.restoreFileFromStash(repo, stash, 'a.txt', false, false);

		// Assert
		expect(notForced).toStrictEqual({ error: null, hasChanges: true });
		expect(read('a.txt')).toBe('current\n');

		// Run
		const forced = await features.restoreFileFromStash(repo, stash, 'a.txt', false, true);

		// Assert
		expect(forced).toStrictEqual({ error: null, hasChanges: false });
		expect(read('a.txt')).toBe('stashed\n');
	});
});

describe('getFileTimeline', () => {
	it('Should return the commits that changed a file, following renames', async () => {
		// Setup
		const added = commit('Add', { 'old.txt': '1\n2\n3\n' });
		const changed = commit('Change', { 'old.txt': '1\n2\n3\n4\n5\n' });
		commit('Unrelated', { 'other.txt': 'x\n' });
		git('mv', 'old.txt', 'new.txt');
		const renamed = commit('Rename');
		const latest = commit('Delete lines', { 'new.txt': '1\n' });

		// Run
		const result = await features.getFileTimeline(repo, 'new.txt', 100);

		// Assert
		expect(result.error).toBeNull();
		expect(result.commits.map((c) => ({ hash: c.hash, subject: c.subject, additions: c.additions, deletions: c.deletions, filePath: c.filePath, added: c.added }))).toStrictEqual([
			{ hash: latest, subject: 'Delete lines', additions: 0, deletions: 4, filePath: 'new.txt', added: false },
			{ hash: renamed, subject: 'Rename', additions: 0, deletions: 0, filePath: 'new.txt', added: false },
			{ hash: changed, subject: 'Change', additions: 2, deletions: 0, filePath: 'old.txt', added: false },
			{ hash: added, subject: 'Add', additions: 3, deletions: 0, filePath: 'old.txt', added: true }
		]);
		expect(result.commits[0]).toMatchObject({ author: 'Test Author', email: 'author@example.com', date: 1704067200 });
	});

	it('Should return the commits that changed any file in a folder, adding up their lines', async () => {
		// Setup
		const first = commit('Add', { 'src/a.txt': '1\n', 'src/b.txt': '1\n2\n' });
		commit('Unrelated', { 'other.txt': 'x\n' });
		const second = commit('Change both', { 'src/a.txt': '1\n2\n', 'src/sub/c.txt': 'c\n' });

		// Run
		const result = await features.getFileTimeline(repo, 'src', 100);

		// Assert
		expect(result.error).toBeNull();
		expect(result.commits.map((c) => ({ hash: c.hash, additions: c.additions, deletions: c.deletions }))).toStrictEqual([
			{ hash: second, additions: 2, deletions: 0 },
			{ hash: first, additions: 3, deletions: 0 }
		]);
	});

	it('Should limit the number of commits', async () => {
		// Setup
		for (let i = 0; i < 5; i++) commit('Commit ' + i, { 'a.txt': i + '\n' });

		// Run
		const result = await features.getFileTimeline(repo, 'a.txt', 2);

		// Assert
		expect(result.commits.map((c) => c.subject)).toStrictEqual(['Commit 4', 'Commit 3']);
	});
});

describe('getCommitForExplanation', () => {
	it('Should return the message and changes of a commit', async () => {
		// Setup
		const hash = commit('Add a greeting\n\nBecause it is polite.', { 'hello.txt': 'hello\n' });

		// Run
		const result = await features.getCommitForExplanation(repo, hash);

		// Assert
		expect(result.error).toBeNull();
		expect(result.truncated).toBe(false);
		expect(result.text).toMatch(/^Subject: Add a greeting\n\nBecause it is polite\./);
		expect(result.text).toContain('+hello');
	});

	it('Should truncate long changes', async () => {
		// Setup
		const hash = commit('Long', { 'long.txt': Array.from({ length: 4000 }, (_, i) => 'line ' + i).join('\n') + '\n' });

		// Run
		const result = await features.getCommitForExplanation(repo, hash);

		// Assert
		expect(result.truncated).toBe(true);
		expect(result.text.split('\n')).toHaveLength(3000);
	});

	it('Should return an error for an invalid hash', async () => {
		// Run
		const result = await features.getCommitForExplanation(repo, 'HEAD');

		// Assert
		expect(result).toStrictEqual({ text: '', truncated: false, error: 'Invalid commit hash: HEAD' });
	});

	it('Should include the first-parent diff for a clean merge commit, and truncate minified single-line files', async () => {
		// Setup: merge commit without conflicts (git show without -m would omit its diff)
		commit('Base', { 'base.txt': '1\n' });
		git('checkout', '-q', '-b', 'feature');
		commit('Feature work', { 'feature.txt': 'merged line\n' });
		git('checkout', '-q', 'main');
		commit('Main work', { 'main.txt': 'main line\n' });
		git('merge', '--no-ff', '-q', 'feature', '-m', 'Merge branch feature');
		const mergeHash = git('rev-parse', 'HEAD');

		// Run & Assert: merge commit diff against first parent
		const mergeExplain = await features.getCommitForExplanation(repo, mergeHash);
		expect(mergeExplain.error).toBeNull();
		expect(mergeExplain.text).toContain('Subject: Merge branch feature');
		expect(mergeExplain.text).toContain('+merged line');

		// Single-line minified file exceeding per-line character limit
		const minifiedHash = commit('Add minified bundle', { 'bundle.min.js': 'var a=' + 'x'.repeat(2000) + ';\n' });
		const minifiedExplain = await features.getCommitForExplanation(repo, minifiedHash);
		expect(minifiedExplain.error).toBeNull();
		expect(minifiedExplain.truncated).toBe(true);
		expect(minifiedExplain.text.split('\n').every((line) => line.length <= 502)).toBe(true);
	});
});

describe('Undo Commit (mixed / soft) & duplicate-subject fixup', () => {
	it('Should restore both HEAD and the index when undoing Undo Commit (mixed), without leaving inverse staged deletions', async () => {
		const first = commit('Initial', { 'base.txt': 'base\n' });
		const second = commit('Add foo', { 'foo.ts': 'export const x = 1;\n' });

		// Undo Commit (mixed): HEAD=first, Index=first, Worktree keeps foo.ts untracked
		const undoCommitError = await undoManager.trackHead(repo, 'Undo Commit', () => features.undoCommit(repo, 'mixed'), (err) => err === null, 'mixed');
		expect(undoCommitError).toBeNull();
		expect(git('rev-parse', 'HEAD')).toBe(first);
		expect(git('status', '--porcelain')).toBe('?? foo.ts');

		// Undo the Undo Commit: HEAD=second AND Index=second, working tree clean
		const redoError = await undoManager.undo(repo);
		expect(redoError).toBeNull();
		expect(git('rev-parse', 'HEAD')).toBe(second);
		expect(git('status', '--porcelain')).toBe('');
		expect(read('foo.ts')).toBe('export const x = 1;\n');
	});

	it('Should fix up the targeted commit SHA even when another commit has the same subject', async () => {
		commit('Base', { 'a.txt': '0\n', 'b.txt': '0\n' });
		const firstWip = commit('WIP', { 'a.txt': '1\n' });
		const secondWip = commit('WIP', { 'b.txt': '1\n' });
		expect(firstWip).not.toBe(secondWip);

		// Stage a fix intended specifically for secondWip (not firstWip!)
		write('b.txt', '2\n');
		git('add', 'b.txt');
		const err = await features.fixupCommit(repo, secondWip, false);
		expect(err).toBeNull();
		expect(git('rev-parse', 'HEAD~1')).toBe(firstWip);
		expect(read('b.txt')).toBe('2\n');
	});

	it('Should reject restoring stash files outside the repository', async () => {
		commit('Base', { 'a.txt': 'a\n' });
		write('a.txt', 'stashed\n');
		git('stash', 'push', '-q');
		const stash = git('rev-parse', 'stash@{0}');

		const escaped = await features.restoreFileFromStash(repo, stash, '../outside.txt', false, true);
		expect(escaped.error).toContain('Invalid file path');
	});
});

describe('getChangesForCommitMessage', () => {
	it('Should return scope "none" when the working tree is clean, and prefer staged changes over unstaged ones', async () => {
		commit('feat: initial setup', { 'app.ts': 'export const v = 1;\n' });

		const clean = await features.getChangesForCommitMessage(repo);
		expect(clean).toStrictEqual({ text: '', scope: 'none', recentSubjects: [], truncated: false, error: null });

		// Unstaged tracked + untracked file when nothing is staged
		write('app.ts', 'export const v = 2;\n');
		write('notes.md', '# Release Notes\n');
		const unstaged = await features.getChangesForCommitMessage(repo);
		expect(unstaged.error).toBeNull();
		expect(unstaged.scope).toBe('unstaged');
		expect(unstaged.recentSubjects).toStrictEqual(['feat: initial setup']);
		expect(unstaged.text).toContain('export const v = 2;');
		expect(unstaged.text).toContain('Untracked files (1): notes.md');
		expect(unstaged.text).toContain('+# Release Notes');

		// Staging only app.ts -> scope becomes "staged" and excludes untracked notes.md
		git('add', 'app.ts');
		const staged = await features.getChangesForCommitMessage(repo);
		expect(staged.error).toBeNull();
		expect(staged.scope).toBe('staged');
		expect(staged.text).toContain('export const v = 2;');
		expect(staged.text).not.toContain('notes.md');
	});
});
