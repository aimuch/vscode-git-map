import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { DiffSide, encodeDiffDocUri } from '../src/diffDocProvider';
import { FileTimeMachine, buildMultiHunkUnifiedDiff, getFileTimeMachineHtml } from '../src/fileTimeMachine';
import { GitFileStatus } from '../src/types';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'Test Author',
	GIT_AUTHOR_EMAIL: 'author@example.com',
	GIT_COMMITTER_NAME: 'Test Author',
	GIT_COMMITTER_EMAIL: 'author@example.com',
	GIT_TERMINAL_PROMPT: '0'
});

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('FileTimeMachine', () => {
	describe('buildMultiHunkUnifiedDiff', () => {
		it('Should return an empty string when texts are identical', () => {
			expect(buildMultiHunkUnifiedDiff('src/a.ts', 'line1\nline2', 'line1\nline2')).toBe('');
		});

		it('Should emit separate hunks for distant edits instead of merging unchanged middle lines', () => {
			const oldLines: string[] = [];
			for (let i = 1; i <= 30; i++) oldLines.push('const line' + i + ' = ' + i + ';');
			const newLines = oldLines.slice();
			newLines[1] = 'const line2 = 200;';
			newLines[27] = 'const line28 = 2800;';

			const diff = buildMultiHunkUnifiedDiff('src/app.ts', oldLines.join('\n'), newLines.join('\n'));
			const hunkHeaders = diff.split('\n').filter((line) => line.startsWith('@@ '));
			expect(hunkHeaders.length).toBe(2);
			expect(diff).toContain('-const line2 = 2;');
			expect(diff).toContain('+const line2 = 200;');
			expect(diff).toContain('-const line28 = 28;');
			expect(diff).toContain('+const line28 = 2800;');
			expect(diff).not.toContain('-const line15 = 15;');
		});
	});

	describe('getFileTimeMachineHtml', () => {
		it('Should escape untrusted commit metadata, include CSP nonce, and provide theme & ARIA attributes', () => {
			const html = getFileTimeMachineHtml(
				'src/<unsafe>.ts',
				[{
					hash: 'abcdef1234567890',
					author: '<script>alert(1)</script>',
					email: 'dev@example.com',
					date: 1700000000,
					subject: 'Fix </script><img onerror=1>',
					filePath: 'src/<unsafe>.ts',
					oldFilePath: 'old/<name>.ts',
					additions: 4,
					deletions: 2,
					added: false,
					isLive: true
				}],
				0,
				'changes',
				'vscode-webview:'
			);

			expect(html).toContain('Content-Security-Policy');
			expect(html).toContain('body.vscode-light');
			expect(html).toContain('aria-pressed="true"');
			expect(html).toContain('aria-label="Timeline Zoom"');
			expect(html).toContain('src/&lt;unsafe&gt;.ts');
			expect(html).not.toContain('<script>alert(1)</script>');
			expect(html).not.toContain('</script><img');
		});
	});

	describe('FileTimeMachine panel lifecycle & messages', () => {
		let tmpRepo: string;

		beforeEach(() => {
			tmpRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-ftm-'));
			gitIn(tmpRepo, 'init', '-q', '-b', 'main');
			fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
		});

		afterEach(() => {
			fs.rmSync(tmpRepo, { recursive: true, force: true });
		});

		it('Should open from DiffDocProvider URI, compute LIVE stats, skip rev-parse on added files, and detect binary/deleted states', async () => {
			// Commit 1: initial text file
			fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const x = 1;\nexport const y = 2;\n');
			gitIn(tmpRepo, 'add', '--', 'src/hello.ts');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'Initial file');
			const commit1 = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			// Commit 2: binary content
			fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
			gitIn(tmpRepo, 'add', '--', 'src/hello.ts');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'Binary snapshot');
			const commit2 = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			// Commit 3: restore text and modify in working tree for LIVE
			fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const x = 10;\nexport const y = 2;\n');
			gitIn(tmpRepo, 'add', '--', 'src/hello.ts');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'Restore text');
			fs.writeFileSync(path.join(tmpRepo, 'src', 'hello.ts'), 'export const x = 99;\nexport const y = 2;\n');

			const spawnedArgs: string[][] = [];
			const dataSource: any = {
				spawnGitProcess: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => {
					spawnedArgs.push(args);
					return cp.spawn('git', args, { cwd: cwd, env: Object.assign({}, GIT_ENV, env) });
				},
				getGitVersion: () => '2.40.0',
				getOperationInProgress: () => Promise.resolve(null),
				hasUncommittedChanges: jest.fn().mockResolvedValue(true),
				getFileDiff: jest.fn().mockImplementation((repoDir: string, commitHash: string, parentHash: string | null, oldP: string, newP: string) => {
					const paths = oldP !== newP ? [oldP, newP] : [newP];
					const base = ['diff', '--no-color', '--no-ext-diff', '-M', parentHash !== null ? parentHash : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'];
					const args = commitHash === '*' ? [...base, '--', ...paths] : [...base, commitHash, '--', ...paths];
					return Promise.resolve({ diff: gitIn(repoDir, ...args), error: null });
				}),
				getCommitFile: jest.fn().mockImplementation((repoDir: string, hash: string, filePath: string) => {
					if (hash === commit2) return Promise.resolve('PNG\0BINARY');
					return Promise.resolve(gitIn(repoDir, 'show', hash + ':' + filePath));
				})
			};
			const repoManager: any = {
				getRepoAndPathOfFile: jest.fn().mockResolvedValue({ repo: tmpRepo, path: 'src/hello.ts' })
			};
			const logger: any = { log: jest.fn(), logError: jest.fn() };

			const ftm = new FileTimeMachine(dataSource, repoManager, logger);
			try {
				const diffUri = encodeDiffDocUri(tmpRepo, 'src/hello.ts', commit1, GitFileStatus.Added, DiffSide.New);
				await vscode.commands.executeCommand('git-map.fileTimeMachine', diffUri);

				const shown = ftm.getShown();
				expect(shown).not.toBeNull();
				expect(shown!.entries).toBe(4); // LIVE + 3 commits
				expect(shown!.html).toContain('INITIAL_INDEX=3');
				// Verify LIVE entry computed +1 / -1 stats rather than +0 / -0
				expect(shown!.html).toContain('"p":1,"m":1,"live":true');

				const mockedPanel = vscode.getMockedWebviewPanel(0);
				expect(mockedPanel.panel.title).toBe('Time Machine: hello.ts');

				// Load LIVE revision (index 0)
				await Promise.resolve(mockedPanel.mocks.panel.webview.onDidReceiveMessage({ command: 'loadRevision', index: 0 } as any));
				expect(mockedPanel.mocks.messages[0]).toMatchObject({
					command: 'revisionData',
					index: 0,
					binary: false,
					deleted: false,
					error: null
				});
				expect((mockedPanel.mocks.messages[0] as any).diff).toContain('+export const x = 99;');

				// Load binary revision (index 2)
				await Promise.resolve(mockedPanel.mocks.panel.webview.onDidReceiveMessage({ command: 'loadRevision', index: 2 } as any));
				expect(mockedPanel.mocks.messages[1]).toMatchObject({
					command: 'revisionData',
					index: 2,
					binary: true,
					snapshot: ''
				});

				// Load added revision (index 3) -> should pass parentHash = null without spawning rev-parse for commit1^
				const revParseBefore = spawnedArgs.filter((a) => a.includes('rev-parse')).length;
				await Promise.resolve(mockedPanel.mocks.panel.webview.onDidReceiveMessage({ command: 'loadRevision', index: 3 } as any));
				const revParseAfter = spawnedArgs.filter((a) => a.includes('rev-parse')).length;
				expect(revParseAfter).toBe(revParseBefore);
				expect(dataSource.getFileDiff).toHaveBeenLastCalledWith(tmpRepo, commit1, null, 'src/hello.ts', 'src/hello.ts');

				// Time Machine 2.0: compare arbitrary historical revision (index 3 -> index 0 LIVE)
				await Promise.resolve(mockedPanel.mocks.panel.webview.onDidReceiveMessage({ command: 'compareRevisions', baseIndex: 3, targetIndex: 0 } as any));
				const cmpMsg: any = mockedPanel.mocks.messages[3];
				expect(cmpMsg).toMatchObject({
					command: 'comparisonData',
					baseIndex: 3,
					targetIndex: 0,
					error: null
				});
				expect(cmpMsg.diff).toContain('-export const x = 1;');
				expect(cmpMsg.diff).toContain('+export const x = 99;');
			} finally {
				ftm.dispose();
			}
		});
	});
});
