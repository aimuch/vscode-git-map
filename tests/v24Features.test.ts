import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { buildAiRegressionPrompt } from '../src/aiAssistantPanel';
import { detectDefaultBranch, parseBranchLifecycleRows } from '../src/branchDashboard';
import { escapeCompanionHtml, resolveSafeRepoSubpath } from '../src/companionPanelBase';
import { applyWholeFileResolutions, parseWholeFileAiResolutions } from '../src/conflictAssistant';
import { buildChangelogMarkdown } from '../src/exportShare';
import { highlightCodeLine } from '../src/fileTimeMachine';
import { GitFeatures } from '../src/gitFeatures';
import { handleCompanionMessage } from '../src/gitGraphCompanionRouter';
import { parseCommitSplitPlan, scanDiffForPreCommitIssues } from '../src/preCommitGuard';
import { getMonthDateRange } from '../src/repoInsights';
import { parseSubmoduleStatus } from '../src/submoduleManager';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'V24 Tester',
	GIT_AUTHOR_EMAIL: 'v24@example.com',
	GIT_COMMITTER_NAME: 'V24 Tester',
	GIT_COMMITTER_EMAIL: 'v24@example.com',
	GIT_TERMINAL_PROMPT: '0'
});

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('v2.4.0 Features & Improvements', () => {
	describe('Pre-Commit Guard scanner', () => {
		it('Should detect secrets, debug leftovers, and warning markers on added lines only', () => {
			const diff = [
				'diff --git a/src/app.ts b/src/app.ts',
				'--- a/src/app.ts',
				'+++ b/src/app.ts',
				'@@ -1,3 +1,6 @@',
				'-const oldKey = "AKIAIOSFODNN7EXAMPLE";',
				'+const awsKey = "AKIAIOSFODNN7EXAMPLE";',
				'+console.log("debug value", awsKey);',
				'+// FIXME: remove before release',
				'+const ok = 42;'
			].join('\n');

			const issues = scanDiffForPreCommitIssues(diff);
			expect(issues.map((i) => ({ severity: i.severity, kind: i.kind, file: i.file, line: i.line }))).toEqual([
				{ severity: 'high', kind: 'secret', file: 'src/app.ts', line: 1 },
				{ severity: 'medium', kind: 'debug', file: 'src/app.ts', line: 2 },
				{ severity: 'low', kind: 'marker', file: 'src/app.ts', line: 3 }
			]);
		});
	});

	describe('AI Smart Commit Splitter parser', () => {
		it('Should parse fenced JSON plans, filter invalid paths, and append unassigned files', () => {
			const raw = '```json\n' + JSON.stringify([
				{ message: 'feat(ui): add palette', files: ['web/commandPalette.ts', 'nonexistent.ts'], rationale: 'UI command palette' },
				{ message: 'fix(git): handle notes', files: ['src/gitFeatures.ts'], rationale: 'Git notes support' }
			]) + '\n```';

			const plan = parseCommitSplitPlan(raw, ['web/commandPalette.ts', 'src/gitFeatures.ts', 'README.md']);
			expect(plan.length).toBe(3);
			expect(plan[0]).toEqual({ message: 'feat(ui): add palette', files: ['web/commandPalette.ts'], rationale: 'UI command palette' });
			expect(plan[1]).toEqual({ message: 'fix(git): handle notes', files: ['src/gitFeatures.ts'], rationale: 'Git notes support' });
			expect(plan[2].files).toEqual(['README.md']);
		});
	});

	describe('Submodule status parser', () => {
		it('Should parse clean, modified, uninitialized, and conflict submodules with URLs from .gitmodules', () => {
			const status = [
				' 1111111111111111111111111111111111111111 libs/core (v1.2.0)',
				'+2222222222222222222222222222222222222222 libs/ui (heads/main)',
				'-3333333333333333333333333333333333333333 libs/uninit',
				'U4444444444444444444444444444444444444444 libs/conflict'
			].join('\n');
			const gitmodules = [
				'[submodule "libs/core"]',
				'\tpath = libs/core',
				'\turl = https://github.com/org/core.git',
				'[submodule "libs/ui"]',
				'\tpath = libs/ui',
				'\turl = git@github.com:org/ui.git'
			].join('\n');

			const entries = parseSubmoduleStatus(status, gitmodules);
			expect(entries).toEqual([
				{ path: 'libs/core', hash: '1111111111111111111111111111111111111111', status: 'clean', describe: 'v1.2.0', url: 'https://github.com/org/core.git' },
				{ path: 'libs/ui', hash: '2222222222222222222222222222222222222222', status: 'modified', describe: 'heads/main', url: 'git@github.com:org/ui.git' },
				{ path: 'libs/uninit', hash: '3333333333333333333333333333333333333333', status: 'uninitialized', describe: '', url: '' },
				{ path: 'libs/conflict', hash: '4444444444444444444444444444444444444444', status: 'conflict', describe: '', url: '' }
			]);
		});
	});

	describe('Branch Lifecycle Dashboard parser', () => {
		it('Should compute staleness, merge status, and PR badges across local and remote branches', () => {
			const now = 1700000000;
			const oldTs = now - 45 * 86400;
			const recentTs = now - 2 * 86400;
			const raw = [
				['*', 'refs/heads', 'main', 'Alice', String(recentTs), 'origin/main', 'Latest release'].join('\x1f'),
				[' ', 'refs/heads', 'feature/old', 'Bob', String(oldTs), '', 'Old feature'].join('\x1f'),
				[' ', 'refs/remotes', 'origin/main', 'Alice', String(recentTs), '', 'Latest release'].join('\x1f')
			].join('\n');

			const rows = parseBranchLifecycleRows(
				raw,
				new Set(['main', 'feature/old']),
				{ 'feature/old': { number: 77, title: 'Old PR', url: 'https://example/77', state: 'open', ciStatus: 'success', baseBranch: 'main' } },
				now
			);
			expect(rows.length).toBe(3);
			expect(rows[0]).toMatchObject({ name: 'main', isCurrent: true, isRemote: false, stale: false, merged: true, ageDays: 2 });
			expect(rows[1]).toMatchObject({ name: 'feature/old', isCurrent: false, stale: true, merged: true, prNumber: 77, prCiStatus: 'success', ageDays: 45 });
			expect(rows[2]).toMatchObject({ name: 'origin/main', isRemote: true, prNumber: null });
		});
	});

	describe('Changelog Markdown exporter, syntax highlighter & regression prompt', () => {
		it('Should group Conventional Commits into categorized Markdown sections', () => {
			const md = buildChangelogMarkdown([
				{ hash: 'aaaaaaa1111', subject: 'feat(graph): add command palette', author: 'Alice', dateIso: '2026-11-19' },
				{ hash: 'bbbbbbb2222', subject: 'fix: prevent stale response', author: 'Bob', dateIso: '2026-11-18' },
				{ hash: 'ccccccc3333', subject: 'refactor: extract hunk modal', author: 'Alice', dateIso: '2026-11-17' },
				{ hash: 'ddddddd4444', subject: 'docs: update readme', author: 'Cara', dateIso: '2026-11-16' },
				{ hash: 'eeeeeee5555', subject: 'misc cleanup', author: 'Cara', dateIso: '2026-11-15' }
			], 'Weekly Report');
			expect(md).toContain('# Weekly Report');
			expect(md).toContain('## Features\n- feat(graph): add command palette (`aaaaaaa`, Alice, 2026-11-19)');
			expect(md).toContain('## Bug Fixes\n- fix: prevent stale response (`bbbbbbb`, Bob, 2026-11-18)');
			expect(md).toContain('## Refactoring & Performance');
			expect(md).toContain('## Documentation');
			expect(md).toContain('## Other Changes');
		});

		it('Should highlight code lines safely without unescaped HTML injection', () => {
			const tsHtml = highlightCodeLine('const msg = "<script>"; // 42', '.ts');
			expect(tsHtml).toContain('<span class="ftmKw">const</span>');
			expect(tsHtml).toContain('<span class="ftmStr">&quot;&lt;script&gt;&quot;</span>');
			expect(tsHtml).toContain('<span class="ftmCom">// 42</span>');

			const pyHtml = highlightCodeLine('def calc(n): # return 10', '.py');
			expect(pyHtml).toContain('<span class="ftmKw">def</span>');
			expect(pyHtml).toContain('<span class="ftmCom"># return 10</span>');
		});

		it('Should build an AI regression root-cause prompt with untrusted data boundaries', () => {
			const prompt = buildAiRegressionPrompt('abc1234', '+if (x == null) throw new Error();', 'zh-cn');
			expect(prompt).toContain('Simplified Chinese');
			expect(prompt).toContain('Root Cause Summary');
			expect(prompt).toContain('<<<DIFF_PAYLOAD');
		});
	});

	describe('GitFeatures: Notes, Hooks, Template, Sign-off & Workflow Macros', () => {
		let tmpRepo: string;
		let features: GitFeatures;

		beforeEach(() => {
			tmpRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-v24-'));
			gitIn(tmpRepo, 'init', '-q', '-b', 'main');
			features = new GitFeatures({
				spawnGitProcess: (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
					cp.spawn('git', args, { cwd: cwd, env: Object.assign({}, GIT_ENV, env) }),
				getGitVersion: () => '2.40.0',
				getOperationInProgress: () => Promise.resolve(null)
			});
		});

		afterEach(() => {
			fs.rmSync(tmpRepo, { recursive: true, force: true });
		});

		it('Should manage Git notes, detect hooks & .gitmessage templates, support sign-off commits, and run custom macros', async () => {
			fs.writeFileSync(path.join(tmpRepo, 'file.txt'), 'hello\n');
			fs.writeFileSync(path.join(tmpRepo, '.gitmessage'), '# comment\nfeat: template title\n');
			fs.mkdirSync(path.join(tmpRepo, '.husky'), { recursive: true });
			fs.writeFileSync(path.join(tmpRepo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');

			const meta = await features.getRepoHooksAndTemplate(tmpRepo);
			expect(meta.commitTemplate).toBe('feat: template title');
			expect(meta.hooks.map((h) => h.name)).toContain('.husky/pre-commit');

			// Commit with --signoff
			const commitErr = await features.commitStagedChanges(tmpRepo, 'feat: initial commit', false, true, false, { signoff: true });
			expect(commitErr).toBeNull();
			const headHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');
			expect(gitIn(tmpRepo, 'log', '-1', '--format=%B')).toContain('Signed-off-by: V24 Tester');

			// Git notes add / read / remove
			expect(await features.getCommitNote(tmpRepo, headHash)).toBeNull();
			expect(await features.setCommitNote(tmpRepo, headHash, 'Reviewed by QA')).toBeNull();
			expect(await features.getCommitNote(tmpRepo, headHash)).toBe('Reviewed by QA');
			expect(await features.setCommitNote(tmpRepo, headHash, null)).toBeNull();
			expect(await features.getCommitNote(tmpRepo, headHash)).toBeNull();

			// Custom workflow macro
			const macroRes = await features.runWorkflowMacro(tmpRepo, 'custom-tag', ['tag v1.0.0']);
			expect(macroRes.error).toBeNull();
			expect(gitIn(tmpRepo, 'tag')).toContain('v1.0.0');

			// Companion router openHookFile directly opens single hook
			const execSpy = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
			const handled = await handleCompanionMessage(
				{ command: 'openHookFile', repo: tmpRepo },
				{
					dataSource: <any>{},
					gitFeatures: features,
					undoManager: <any>{},
					signCommits: false,
					sendMessage: () => { }
				}
			);
			expect(handled).toBe(true);
			expect(execSpy).toHaveBeenCalledWith('vscode.open', expect.objectContaining({ fsPath: path.join(tmpRepo, '.husky', 'pre-commit') }));
			execSpy.mockRestore();
		});
	});

	describe('v2.4.1 Closing Polish Helpers', () => {
		it('Should parse and apply whole-file AI conflict resolutions across multiple blocks', () => {
			const conflicted = [
				'header',
				'<<<<<<< HEAD',
				'const a = 1;',
				'=======',
				'const a = 2;',
				'>>>>>>> feat',
				'middle',
				'<<<<<<< HEAD',
				'const b = 3;',
				'=======',
				'const b = 4;',
				'>>>>>>> feat',
				'footer'
			].join('\n');

			const parsed = parseWholeFileAiResolutions('```json\n["const a = 12;", "const b = 34;"]\n```', 2);
			expect(parsed).toEqual(['const a = 12;', 'const b = 34;']);
			expect(parseWholeFileAiResolutions('["only one"]', 2)).toBeNull();

			const merged = applyWholeFileResolutions(conflicted, parsed!);
			expect(merged).toBe('header\nconst a = 12;\nmiddle\nconst b = 34;\nfooter');
		});

		it('Should compute exact month date ranges including leap years', () => {
			expect(getMonthDateRange('2024-02')).toEqual({ after: '2024-02-01', before: '2024-02-29' });
			expect(getMonthDateRange('2025-02')).toEqual({ after: '2025-02-01', before: '2025-02-28' });
			expect(getMonthDateRange('2026-11')).toEqual({ after: '2026-11-01', before: '2026-11-30' });
			expect(getMonthDateRange('2026-13')).toBeNull();
			expect(getMonthDateRange('invalid')).toBeNull();
		});

		it('Should detect default branch from origin/HEAD or standard fallbacks', () => {
			const rows = parseBranchLifecycleRows(
				[
					'*\x1frefs/heads\x1ffeat/ui\x1fAlice\x1f1700000000\x1f\x1fui work',
					' \x1frefs/heads\x1fmain\x1fAlice\x1f1700000000\x1forigin/main\x1finit',
					' \x1frefs/remotes\x1forigin/main\x1fAlice\x1f1700000000\x1f\x1finit'
				].join('\n'),
				new Set(),
				{},
				1700000000
			);
			expect(detectDefaultBranch(rows, 'origin/main')).toBe('main');
			expect(detectDefaultBranch(rows, null)).toBe('main');
		});

		it('Should reject path traversal and option-like paths in resolveSafeRepoSubpath and escape HTML safely', () => {
			const repoRoot = path.resolve('/tmp/sample-repo');
			expect(resolveSafeRepoSubpath(repoRoot, 'libs/submod')).toBe(path.join(repoRoot, 'libs/submod'));
			expect(resolveSafeRepoSubpath(repoRoot, '../outside')).toBeNull();
			expect(resolveSafeRepoSubpath(repoRoot, '/etc/passwd')).toBeNull();
			expect(resolveSafeRepoSubpath(repoRoot, '--exec=evil')).toBeNull();
			expect(resolveSafeRepoSubpath(repoRoot, '')).toBeNull();
			expect(escapeCompanionHtml('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
		});
	});
});
