import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CancellationRequest, GitProcessRunner, HistoryRewriteCancelledError, HistoryRewriter } from '../src/historyRewrite';

// These tests run Git itself, in repositories created in a temporary directory
// (each test runs many Git commands, which can take longer than Jest's default timeout on a slow machine)
jest.setTimeout(60000);

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 'author@example.com', GIT_AUTHOR_DATE: '2024-01-01T00:00:00Z',
	GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 'author@example.com', GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z',
	GIT_TERMINAL_PROMPT: '0'
});

const NEVER_CANCELLED: CancellationRequest = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => { } }) };

let directory: string, repo: string, repoIndex = 0;

function git(...args: string[]) {
	return cp.execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function write(file: string, contents: string) {
	fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), contents);
}

function commit(message: string, files: { [file: string]: string | null }) {
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

function refs() {
	return git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags');
}

function filesInHistory(...paths: string[]) {
	return git('log', '--all', '--format=%H', '--', ...paths);
}

function createRewriter(version: string = git('--version').replace('git version ', '')) {
	const runner: GitProcessRunner = {
		spawnGitProcess: (args, cwd, env) => cp.spawn('git', args, { cwd: cwd, env: Object.assign({}, GIT_ENV, env) }),
		getGitVersion: () => version,
		getOperationInProgress: () => Promise.resolve(null)
	};
	return new HistoryRewriter(runner);
}

beforeAll(() => {
	directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-history-'));
});

afterAll(() => {
	fs.rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
	repo = path.join(directory, 'repo-' + (++repoIndex));
	fs.mkdirSync(repo);
	git('init', '-q', '-b', 'main');
});

/**
 * Create a history with a secret that's added after the first commit, on two branches that are merged, with tags:
 *
 *   A (a.txt) - B (secret.bin, b.txt) - C (only secret.bin) - D (a.txt) --------- M (merge side) - E (deletes secret.bin)  [main]
 *                \                                                               /
 *                 S1 (side.txt) - S2 (only secrets/key.pem) --------------------            [side]
 */
function createHistory() {
	const a = commit('A', { 'a.txt': 'a\n', 'my dir/sp ace.txt': 'space\n', '名字.txt': 'unicode\n' });
	git('tag', '-a', 'before', '-m', 'Before the secret');
	const b = commit('B', { 'secret.bin': 'secret 1\n', 'b.txt': 'b\n' });
	git('checkout', '-q', '-b', 'side');
	const s1 = commit('S1', { 'side.txt': 'side\n' });
	commit('S2', { 'secrets/key.pem': 'key\n' });
	git('checkout', '-q', 'main');
	commit('C', { 'secret.bin': 'secret 2\n' });
	git('tag', 'light');
	commit('D', { 'a.txt': 'a2\n' });
	git('tag', '-a', 'annotated', '-m', 'An annotated tag');
	git('merge', '-q', '--no-ff', '-m', 'M', 'side');
	commit('E', { 'secret.bin': null });
	return { a: a, b: b, s1: s1 };
}

describe('HistoryRewriter', () => {
	describe('preview', () => {
		it('Should describe what removing the files would do', async () => {
			const history = createHistory();
			git('update-ref', 'refs/remotes/origin/main', 'main');
			git('update-ref', 'refs/remotes/origin/unfetched', history.b);

			const preview = await createRewriter().preview(repo, ['secret.bin', './secrets/', 'missing.txt']);

			expect(preview.paths).toStrictEqual(['secret.bin', 'secrets', 'missing.txt']);
			expect(preview.pathsNotInHistory).toStrictEqual(['missing.txt']);
			expect(preview.files).toBe(2);
			expect(preview.commits).toBe(5); // B, C, S2, M (it merges secrets/key.pem into main) & E
			expect(preview.totalCommits).toBe(8);
			expect(preview.branches).toStrictEqual(['main', 'side']);
			expect(preview.tags).toStrictEqual(['annotated', 'light']);
			expect(preview.remoteBranches).toStrictEqual(['origin/main', 'origin/unfetched']);
			expect(preview.remoteOnlyBranches).toStrictEqual(['origin/unfetched']);
			expect(preview.pathsInHead).toStrictEqual(['secrets']);
			expect(preview.blobs).toHaveLength(3);
			expect(preview.size).toBeGreaterThan(0);
			expect(preview.zeroOid).toBe('0'.repeat(40));
			expect(typeof preview.keepsUnaffectedSignatures).toBe('boolean');
			expect(preview.blockers).toStrictEqual([]);
		});

		it('Should report why the files can\'t be removed', async () => {
			createHistory();
			write('a.txt', 'uncommitted\n');
			git('stash', '-q');
			write('b.txt', 'uncommitted\n');
			git('worktree', 'add', '-q', path.join(directory, 'worktree-' + repoIndex), 'side');
			git('checkout', '-q', '--detach');

			const rewriter = createRewriter('2.20.1');
			const preview = await rewriter.preview(repo, ['secret.bin']);
			const missing = await rewriter.preview(repo, ['missing.txt']);

			expect(preview.blockers).toStrictEqual([
				{ kind: 'gitVersion', version: '2.20.1' },
				{ kind: 'detachedHead' },
				{ kind: 'uncommittedChanges' },
				{ kind: 'worktrees', count: 2 },
				{ kind: 'stashes', stashes: ['stash@{0}'] }
			]);
			expect(missing.blockers).toContainEqual({ kind: 'notInHistory' });
			expect(missing.commits).toBe(0);
			expect(missing.branches).toStrictEqual([]);
		});

		it('Should list every path in the history', async () => {
			createHistory();

			const paths = await createRewriter().getPathsInHistory(repo);

			expect(paths).toStrictEqual([
				{ path: 'a.txt', inHead: true },
				{ path: 'b.txt', inHead: true },
				{ path: 'my dir/sp ace.txt', inHead: true },
				{ path: 'secret.bin', inHead: false },
				{ path: 'secrets/key.pem', inHead: true },
				{ path: 'side.txt', inHead: true },
				{ path: '名字.txt', inHead: true }
			]);
		});
	});

	describe('removeFromHistory', () => {
		it('Should remove the files from every branch & tag, keeping the commits before them unchanged', async () => {
			const history = createHistory();
			const blob = git('rev-parse', history.b + ':secret.bin');
			const rewriter = createRewriter(), progress: number[] = [];

			const preview = await rewriter.preview(repo, ['secret.bin', 'secrets']);
			const result = await rewriter.removeFromHistory(repo, preview, false, (commits) => progress.push(commits), NEVER_CANCELLED);

			// The files are gone from the history of every branch & tag, and from the working directory
			expect(git('log', '--branches', '--tags', '--format=%H', '--', 'secret.bin', 'secrets')).toBe('');
			expect(git('status', '--porcelain')).toBe('');
			expect(fs.existsSync(path.join(repo, 'secrets', 'key.pem'))).toBe(false);
			expect(git('ls-tree', '-r', '--name-only', 'main')).toBe(['a.txt', 'b.txt', 'my dir/sp ace.txt', 'side.txt', '"\\345\\220\\215\\345\\255\\227.txt"'].join('\n'));
			expect(git('show', 'main:a.txt')).toBe('a2');

			// The commits that only changed the files (C, S2 & E) are removed, the others are kept with the same messages
			expect(git('log', '--format=%s', '--topo-order', 'main').split('\n').sort()).toStrictEqual(['A', 'B', 'D', 'M', 'S1']);
			expect(git('log', '--format=%s', 'side')).toBe('S1\nB\nA');
			expect(git('log', '--format=%P', '-1', 'main').split(' ')).toHaveLength(2);
			expect(result.stats).toStrictEqual({ commits: 8, commitsRewritten: 4, commitsRemoved: 3, fileChangesRemoved: 5, tagsRewritten: 1, signaturesRemoved: 0, refsDeleted: [] });
			expect(progress).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);

			// The commit & tag before the files were added are exactly as they were
			expect(git('rev-parse', 'main~3')).toBe(history.a);
			expect(git('rev-parse', 'before^{commit}')).toBe(history.a);
			expect(git('rev-parse', 'main~2')).not.toBe(history.b);
			expect(git('log', '--format=%s', '-1', 'light')).toBe('B');
			expect(git('log', '--format=%s', '-1', 'annotated')).toBe('D');
			expect(git('cat-file', '-t', 'annotated')).toBe('tag');
			expect(result.rewrittenBranches).toStrictEqual(['main', 'side']);
			expect(result.rewrittenTags).toStrictEqual(['annotated', 'light']);
			expect(result.deletedRefs).toStrictEqual([]);

			// The previous history is still in the repository (in the reflogs) until it's purged
			expect(git('cat-file', '-t', blob)).toBe('blob');
			expect(await rewriter.getLeftovers(repo, preview.paths, preview.blobs)).toStrictEqual({ refs: [], blobsRemaining: 3, blobsChecked: 3 });
			git('update-ref', 'refs/remotes/origin/main', history.b);
			expect(await rewriter.getLeftovers(repo, preview.paths, preview.blobs)).toStrictEqual({ refs: ['refs/remotes/origin/main'], blobsRemaining: 3, blobsChecked: 3 });
			await rewriter.purge(repo, NEVER_CANCELLED);
			expect(await rewriter.getLeftovers(repo, preview.paths, preview.blobs)).toStrictEqual({ refs: ['refs/remotes/origin/main'], blobsRemaining: 1, blobsChecked: 3 });
			git('update-ref', '-d', 'refs/remotes/origin/main');
			await rewriter.purge(repo, NEVER_CANCELLED);
			expect(await rewriter.getLeftovers(repo, preview.paths, preview.blobs)).toStrictEqual({ refs: [], blobsRemaining: 0, blobsChecked: 3 });
			expect(() => git('cat-file', '-t', blob)).toThrow();
			expect(filesInHistory('secret.bin', 'secrets')).toBe('');
			expect(git('fsck', '--no-dangling')).toBe('');
		});

		it('Should keep the files in the working directory when requested', async () => {
			createHistory();
			const rewriter = createRewriter();

			await rewriter.removeFromHistory(repo, await rewriter.preview(repo, ['secrets/key.pem', 'my dir']), true, () => { }, NEVER_CANCELLED);

			expect(git('ls-tree', '-r', '--name-only', 'main', '--', 'secrets', 'my dir')).toBe('');
			expect(fs.readFileSync(path.join(repo, 'secrets', 'key.pem')).toString()).toBe('key\n');
			expect(fs.readFileSync(path.join(repo, 'my dir', 'sp ace.txt')).toString()).toBe('space\n');
			expect(git('status', '--porcelain')).toBe('?? "my dir/"\n?? secrets/');
		});

		it('Should remove files with special characters in their paths, rewriting every commit when they\'re in the first one', async () => {
			const history = createHistory();
			const rewriter = createRewriter();

			const result = await rewriter.removeFromHistory(repo, await rewriter.preview(repo, ['名字.txt', 'my dir/sp ace.txt']), false, () => { }, NEVER_CANCELLED);

			expect(git('log', '--branches', '--tags', '--format=%H', '--', '名字.txt', 'my dir')).toBe('');
			expect(git('rev-parse', 'main~5')).not.toBe(history.a);
			expect(git('show', 'main~5:a.txt')).toBe('a');
			expect(result.stats.commitsRewritten).toBe(8);
			expect(result.stats.commitsRemoved).toBe(0);
			expect(result.rewrittenTags).toStrictEqual(['annotated', 'before', 'light']);
		});

		it('Should delete a branch whose commits only changed the files', async () => {
			commit('A', { 'a.txt': 'a\n' });
			git('checkout', '-q', '--orphan', 'secrets');
			git('rm', '-q', '-r', '--cached', '.');
			fs.unlinkSync(path.join(repo, 'a.txt'));
			commit('Only the secret', { 'secret.bin': 'secret\n' });
			git('tag', 'secret-tag');
			git('checkout', '-q', 'main');
			const rewriter = createRewriter();

			const result = await rewriter.removeFromHistory(repo, await rewriter.preview(repo, ['secret.bin']), false, () => { }, NEVER_CANCELLED);

			expect(refs()).toBe('refs/heads/main ' + git('rev-parse', 'main'));
			expect(result.deletedRefs).toStrictEqual(['refs/heads/secrets', 'refs/tags/secret-tag']);
			expect(result.stats.refsDeleted).toStrictEqual(['refs/heads/secrets', 'refs/tags/secret-tag']);
		});

		it('Should not change the repository when it\'s cancelled, or when the files can\'t be removed', async () => {
			createHistory();
			const rewriter = createRewriter(), before = refs();
			const preview = await rewriter.preview(repo, ['secret.bin']);
			let cancel = () => { };
			const cancellation = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose: () => { } }; } };

			const removal = rewriter.removeFromHistory(repo, preview, false, (commits) => {
				if (commits === 2) {
					cancellation.isCancellationRequested = true;
					cancel();
				}
			}, cancellation);

			await expect(removal).rejects.toBeInstanceOf(HistoryRewriteCancelledError);
			expect(refs()).toBe(before);
			expect(git('status', '--porcelain')).toBe('');

			write('a.txt', 'uncommitted\n');
			await expect(rewriter.removeFromHistory(repo, await rewriter.preview(repo, ['secret.bin']), false, () => { }, NEVER_CANCELLED)).rejects.toThrow('The files can\'t be removed from the history of the repository in its current state.');
			expect(refs()).toBe(before);
		});

		it('Should keep a stash that isn\'t based on the rewritten history when purging', async () => {
			commit('A', { 'a.txt': 'a\n' });
			write('a.txt', 'stashed\n');
			git('stash', '-q');
			commit('B', { 'secret.bin': 'secret\n' });
			const rewriter = createRewriter();

			const preview = await rewriter.preview(repo, ['secret.bin']);
			expect(preview.blockers).toStrictEqual([]);
			await rewriter.removeFromHistory(repo, preview, false, () => { }, NEVER_CANCELLED);
			await rewriter.purge(repo, NEVER_CANCELLED);

			expect(git('stash', 'list', '--format=%gd')).toBe('stash@{0}');
			expect(filesInHistory('secret.bin')).toBe('');
		});
	});

	describe('createBackup & restoreBackup', () => {
		it('Should restore the history from the backup, also after the previous history has been purged', async () => {
			createHistory();
			const rewriter = createRewriter(), before = refs(), bundle = path.join(directory, 'backups', 'backup-' + repoIndex + '.bundle');

			await rewriter.createBackup(repo, bundle, NEVER_CANCELLED);
			const preview = await rewriter.preview(repo, ['secret.bin', 'secrets']);
			await rewriter.removeFromHistory(repo, preview, false, () => { }, NEVER_CANCELLED);
			await rewriter.purge(repo, NEVER_CANCELLED);
			expect(refs()).not.toBe(before);

			await rewriter.restoreBackup(repo, bundle);

			expect(refs()).toBe(before);
			expect(git('status', '--porcelain')).toBe('');
			expect(fs.readFileSync(path.join(repo, 'secrets', 'key.pem')).toString()).toBe('key\n');
			expect(git('fsck', '--no-dangling')).toBe('');
		});

		it('Should report a backup that can\'t be created or read', async () => {
			createHistory();
			const rewriter = createRewriter(), bundle = path.join(directory, 'backups', 'missing-' + repoIndex + '.bundle');

			await expect(rewriter.restoreBackup(repo, bundle)).rejects.toThrow();
			await expect(rewriter.createBackup(repo, bundle, { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => { } }) })).rejects.toBeInstanceOf(HistoryRewriteCancelledError);
			expect(fs.existsSync(bundle)).toBe(false);
		});
	});

	describe('signatures', () => {
		it('Should keep the signature (and hash) of a commit before the files, and remove the signatures of rewritten commits', async () => {
			const key = path.join(directory, 'key-' + repoIndex);
			try {
				cp.execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'ignore' });
				git('config', 'gpg.format', 'ssh');
				git('config', 'user.signingkey', key + '.pub');
				write('a.txt', 'a\n');
				git('add', '-A');
				git('commit', '-q', '-S', '-m', 'Signed A');
			} catch (_) {
				// This environment can't sign commits with an SSH key (ssh-keygen isn't available, or Git is older than 2.34)
				return;
			}
			const signed = git('rev-parse', 'HEAD');
			write('secret.bin', 'secret\n');
			write('b.txt', 'b\n');
			git('add', '-A');
			git('commit', '-q', '-S', '-m', 'Signed B');
			const rewriter = createRewriter();

			const preview = await rewriter.preview(repo, ['secret.bin']);
			const result = await rewriter.removeFromHistory(repo, preview, false, () => { }, NEVER_CANCELLED);

			expect(git('cat-file', 'commit', 'main')).not.toContain('gpgsig');
			expect(git('ls-tree', '--name-only', 'main')).toBe('a.txt\nb.txt');
			if (preview.keepsUnaffectedSignatures) {
				expect(git('rev-parse', 'main~1')).toBe(signed);
				expect(git('cat-file', 'commit', 'main~1')).toContain('gpgsig');
				expect(result.stats.signaturesRemoved).toBe(1);
			} else {
				// This version of Git doesn't write the signatures of commits to the stream, so they're removed from all commits
				expect(git('rev-parse', 'main~1')).not.toBe(signed);
				expect(git('cat-file', 'commit', 'main~1')).not.toContain('gpgsig');
			}
		});
	});
});
