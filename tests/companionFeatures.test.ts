import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { buildAiCodeReviewPrompt, buildAiReleaseNotesPrompt, parseReviewFindings } from '../src/aiAssistantPanel';
import { hasConflictMarkersInText, parseConflictBlocks, replaceConflictBlockInText } from '../src/conflictAssistant';
import { GitFeatures, buildPartialHunkPatch } from '../src/gitFeatures';
import { parseHostingRemoteUrl } from '../src/prStatusIntegration';
import { classifyReflogAction, parseReflogOutput } from '../src/reflogExplorer';
import { computeRepoInsights } from '../src/repoInsights';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'Alice Dev',
	GIT_AUTHOR_EMAIL: 'alice@example.com',
	GIT_COMMITTER_NAME: 'Alice Dev',
	GIT_COMMITTER_EMAIL: 'alice@example.com',
	GIT_TERMINAL_PROMPT: '0'
});

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('Companion Features & GitFeatures Workflows', () => {
	describe('AI Code Review & Release Notes helpers', () => {
		it('Should parse structured [HIGH]/[MEDIUM]/[LOW]/[INFO] findings with file and line numbers', () => {
			const report = [
				'## Overview',
				'Two issues were spotted in the diff.',
				'## Findings',
				'- [HIGH] `src/auth.ts:84` — Token leak: Avoid logging bearer header in plain text.',
				'- [MEDIUM] src/cache.ts — Unbounded cache growth: Evict oldest keys.',
				'* [LOW] web/main.ts:12 - Minor typo: Rename label variable.',
				'- [INFO] None — No further issues.'
			].join('\n');

			const findings = parseReviewFindings(report);
			expect(findings).toEqual([
				{
					severity: 'HIGH',
					file: 'src/auth.ts',
					line: 84,
					title: 'Token leak',
					detail: 'Avoid logging bearer header in plain text.'
				},
				{
					severity: 'MEDIUM',
					file: 'src/cache.ts',
					line: null,
					title: 'Unbounded cache growth',
					detail: 'Evict oldest keys.'
				},
				{
					severity: 'LOW',
					file: 'web/main.ts',
					line: 12,
					title: 'Minor typo',
					detail: 'Rename label variable.'
				},
				{
					severity: 'INFO',
					file: null,
					line: null,
					title: 'No further issues.',
					detail: ''
				}
			]);
		});

		it('Should wrap untrusted diffs and commits inside unique boundary markers', () => {
			const reviewPrompt = buildAiCodeReviewPrompt('Uncommitted Changes', '+const a = 1;', 'zh-cn');
			expect(reviewPrompt).toContain('Simplified Chinese');
			expect(reviewPrompt).toContain('<<<DIFF_PAYLOAD');
			expect(reviewPrompt).toContain('+const a = 1;');

			const rnPrompt = buildAiReleaseNotesPrompt('v1.0.0..v1.1.0', '- abc1234: Add feature', '1 file changed', 'en');
			expect(rnPrompt).toContain('English');
			expect(rnPrompt).toContain('<<<COMMITS');
			expect(rnPrompt).toContain('<<<DIFF');
		});
	});

	describe('Conflict Assistant parser & block replacer', () => {
		it('Should parse both standard 2-way and diff3 3-way conflict blocks and replace selected blocks cleanly', () => {
			const sample = [
				'const header = true;',
				'<<<<<<< HEAD',
				'const port = 3000;',
				'||||||| merged common ancestors',
				'const port = 8080;',
				'=======',
				'const port = 4000;',
				'>>>>>>> feature/config',
				'const middle = 1;',
				'<<<<<<< HEAD',
				'export default port;',
				'=======',
				'export { port };',
				'>>>>>>> feature/config',
				''
			].join('\r\n');

			const blocks = parseConflictBlocks(sample);
			expect(blocks.length).toBe(2);
			expect(blocks[0]).toMatchObject({
				index: 0,
				oursLabel: 'HEAD',
				theirsLabel: 'feature/config',
				ours: 'const port = 3000;',
				base: 'const port = 8080;',
				theirs: 'const port = 4000;'
			});
			expect(blocks[1]).toMatchObject({
				index: 1,
				ours: 'export default port;',
				base: null,
				theirs: 'export { port };'
			});

			// Resolve first block with Theirs, preserving CRLF and leaving second block intact
			const afterFirst = replaceConflictBlockInText(sample, 0, blocks[0].theirs)!;
			expect(afterFirst).toContain('\r\n');
			expect(afterFirst).toContain('const port = 4000;\r\nconst middle = 1;');
			expect(parseConflictBlocks(afterFirst).length).toBe(1);

			// Resolve remaining block with Ours
			const afterSecond = replaceConflictBlockInText(afterFirst, 0, 'export default port;')!;
			expect(parseConflictBlocks(afterSecond).length).toBe(0);
			expect(hasConflictMarkersInText(sample)).toBe(true);
			expect(hasConflictMarkersInText(afterSecond)).toBe(false);
			expect(replaceConflictBlockInText(afterSecond, 0, 'noop')).toBeNull();
		});
	});

	describe('Visual Reflog Explorer parser', () => {
		it('Should classify reflog actions and flag unreachable / orphaned commits', () => {
			expect(classifyReflogAction('reset: moving to HEAD~1')).toEqual({
				category: 'reset',
				action: 'reset',
				subject: 'moving to HEAD~1'
			});
			expect(classifyReflogAction('rebase (finish): returning to refs/heads/main').category).toBe('rebase');
			expect(classifyReflogAction('commit (amend): Fix edge case').category).toBe('commit');

			const h1 = '1111111111111111111111111111111111111111';
			const h2 = '2222222222222222222222222222222222222222';
			const raw = [
				[h1, 'HEAD@{0}', 'reset: moving to HEAD~1', 'Alice', '1700000100'].join('\x1f'),
				[h2, 'HEAD@{1}', 'commit: Experimental WIP', 'Alice', '1700000050'].join('\x1f')
			].join('\x1e');

			const entries = parseReflogOutput(raw, new Set([h1]));
			expect(entries.length).toBe(2);
			expect(entries[0].orphaned).toBe(false);
			expect(entries[1].orphaned).toBe(true);
			expect(entries[1].subject).toBe('Experimental WIP');
		});
	});

	describe('Repository Insights & Hotspots', () => {
		it('Should aggregate churn hotspots, knowledge silos, contributors, heatmap, and monthly trends', () => {
			const rawLog = [
				['Alice\x1falice@example.com\x1f1700000000', '20\t5\tsrc/core.ts', '4\t0\tsrc/shared.ts'].join('\n'),
				['Alice\x1falice@example.com\x1f1700086400', '15\t3\tsrc/core.ts'].join('\n'),
				['Alice\x1falice@example.com\x1f1700172800', '8\t2\tsrc/{old => core}.ts'].join('\n'),
				['Bob\x1fbob@example.com\x1f1702600000', '10\t1\tsrc/shared.ts'].join('\n')
			].join('\x1e');

			const insights = computeRepoInsights(rawLog);
			expect(insights.totalCommits).toBe(4);
			expect(insights.totalAuthors).toBe(2);
			expect(insights.hotspots[0]).toMatchObject({
				path: 'src/core.ts',
				commits: 3,
				additions: 43,
				deletions: 10,
				authors: 1,
				topAuthor: 'Alice',
				topAuthorShare: 100
			});
			expect(insights.knowledgeSilos.map((f) => f.path)).toContain('src/core.ts');
			expect(insights.knowledgeSilos.map((f) => f.path)).not.toContain('src/shared.ts');
			expect(insights.monthlyCommits.reduce((sum, m) => sum + m.count, 0)).toBe(4);
		});
	});

	describe('PR & CI Status remote URL parser', () => {
		it('Should parse GitHub, GitLab, Gitea / Codeberg, Bitbucket, and Azure DevOps HTTPS and SSH remote URLs', () => {
			expect(parseHostingRemoteUrl('origin', 'https://github.com/aimuch/vscode-git-map.git')).toEqual({
				provider: 'github',
				host: 'github.com',
				ownerRepo: 'aimuch/vscode-git-map',
				remoteName: 'origin'
			});
			expect(parseHostingRemoteUrl('upstream', 'git@gitlab.company.io:platform/subgroup/service.git')).toEqual({
				provider: 'gitlab',
				host: 'gitlab.company.io',
				ownerRepo: 'platform/subgroup/service',
				remoteName: 'upstream'
			});
			expect(parseHostingRemoteUrl('origin', 'https://codeberg.org/org/project.git')).toEqual({
				provider: 'gitea',
				host: 'codeberg.org',
				ownerRepo: 'org/project',
				remoteName: 'origin'
			});
			expect(parseHostingRemoteUrl('origin', 'https://bitbucket.org/team/repo.git')).toEqual({
				provider: 'bitbucket',
				host: 'bitbucket.org',
				ownerRepo: 'team/repo',
				remoteName: 'origin'
			});
			expect(parseHostingRemoteUrl('origin', 'https://dev.azure.com/contoso/WebPortal/_git/frontend')).toEqual({
				provider: 'azure',
				host: 'dev.azure.com',
				ownerRepo: 'contoso/WebPortal/frontend',
				remoteName: 'origin'
			});
			expect(parseHostingRemoteUrl('origin', 'git@ssh.dev.azure.com:v3/contoso/WebPortal/frontend')).toEqual({
				provider: 'azure',
				host: 'dev.azure.com',
				ownerRepo: 'contoso/WebPortal/frontend',
				remoteName: 'origin'
			});
			expect(parseHostingRemoteUrl('origin', 'https://svn.example.com/custom.git')).toBeNull();
		});
	});

	describe('GitFeatures staging, hunk patching, committing, discarding & branch moving', () => {
		let tmpRepo: string;
		let features: GitFeatures;

		beforeEach(() => {
			tmpRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-feat-'));
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

		it('Should stage/unstage files, stage individual hunks, commit/amend, move branches, and guard discard paths', async () => {
			const lines: string[] = [];
			for (let i = 1; i <= 20; i++) lines.push('line ' + i);
			const appFile = path.join(tmpRepo, 'app.txt');
			fs.writeFileSync(appFile, lines.join('\n') + '\n');
			gitIn(tmpRepo, 'add', '--', 'app.txt');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'Initial commit');
			const firstHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			// Edit two distant hunks + create an untracked file
			const modified = lines.slice();
			modified[1] = 'line 2 edited';
			modified[18] = 'line 19 edited';
			fs.writeFileSync(appFile, modified.join('\n') + '\n');
			fs.writeFileSync(path.join(tmpRepo, 'temp.txt'), 'scratch\n');

			const status1 = await features.getWorkingTreeStatus(tmpRepo);
			expect(status1.error).toBeNull();
			expect(status1.headMessage).toBe('Initial commit');
			expect(status1.files.length).toBe(2);

			// Load unstaged hunks and stage ONLY the first hunk
			const hunkDiff = await features.getFileHunkDiff(tmpRepo, 'app.txt', false);
			expect(hunkDiff.error).toBeNull();
			const rawLines = hunkDiff.diff.split('\n');
			const firstAt = rawLines.findIndex((l) => l.startsWith('@@ '));
			const secondAt = rawLines.findIndex((l, idx) => idx > firstAt && l.startsWith('@@ '));
			expect(firstAt).toBeGreaterThan(0);
			expect(secondAt).toBeGreaterThan(firstAt);

			const singleHunkPatch = rawLines.slice(0, secondAt).join('\n') + '\n';
			expect(await features.applyHunkPatch(tmpRepo, singleHunkPatch, 'stage')).toBeNull();

			const status2 = await features.getWorkingTreeStatus(tmpRepo);
			const appEntry = status2.files.find((f) => f.path === 'app.txt')!;
			expect(appEntry.staged).toBe(true);
			expect(appEntry.unstaged).toBe(true);

			// Commit only the staged hunk, then amend its message
			expect(await features.commitStagedChanges(tmpRepo, 'Second commit (hunk 1)', false, false, false)).toBeNull();
			expect(await features.commitStagedChanges(tmpRepo, 'Second commit amended', true, false, false)).toBeNull();
			expect(gitIn(tmpRepo, 'log', '-1', '--format=%s')).toBe('Second commit amended');
			const secondHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			// Range helper for AI review / release notes
			const range = await features.getRangeForReviewOrReleaseNotes(tmpRepo, firstHash, secondHash);
			expect(range.error).toBeNull();
			expect(range.commitsText).toContain('Second commit amended');
			expect(range.diffText).toContain('+line 2 edited');

			// Move non-checked-out branch with git branch -f, and refuse moving checked-out main
			gitIn(tmpRepo, 'branch', 'feature-ptr', firstHash);
			expect(await features.moveBranch(tmpRepo, 'feature-ptr', secondHash)).toBeNull();
			expect(gitIn(tmpRepo, 'rev-parse', 'feature-ptr')).toBe(secondHash);
			expect(await features.moveBranch(tmpRepo, 'main', firstHash)).toContain('Reset');

			// Refuse path traversal on discard, then cleanly discard remaining working changes
			expect(await features.discardWorkingChanges(tmpRepo, [], ['../outside.txt'])).toContain('outside repository');
			expect(await features.discardWorkingChanges(tmpRepo, ['app.txt'], ['temp.txt'])).toBeNull();
			const statusClean = await features.getWorkingTreeStatus(tmpRepo);
			expect(statusClean.files).toEqual([]);
		});

		it('Should stage, unstage, and discard individual selected lines within a single hunk via buildPartialHunkPatch', async () => {
			const file = path.join(tmpRepo, 'multi.txt');
			fs.writeFileSync(file, ['alpha', 'beta', 'gamma', 'delta'].join('\n') + '\n');
			gitIn(tmpRepo, 'add', '--', 'multi.txt');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'Base multi');

			// Modify 2 adjacent lines inside the SAME hunk
			fs.writeFileSync(file, ['alpha', 'BETA_NEW', 'GAMMA_NEW', 'delta'].join('\n') + '\n');
			const unstaged = await features.getFileHunkDiff(tmpRepo, 'multi.txt', false);
			const lines = unstaged.diff.replace(/\r\n/g, '\n').split('\n');
			if (lines[lines.length - 1] === '') lines.pop();
			const atIdx = lines.findIndex((l) => l.startsWith('@@ '));
			const header = lines.slice(0, atIdx).join('\n');
			const hunkHdr = lines[atIdx];
			const hunkBody = lines.slice(atIdx + 1);

			// Select ONLY '-beta' and '+BETA_NEW' (leave '-gamma' and '+GAMMA_NEW' unstaged!)
			const selStage = new Set<number>();
			hunkBody.forEach((l, idx) => {
				if (l === '-beta' || l === '+BETA_NEW') selStage.add(idx);
			});
			const stagePatch = buildPartialHunkPatch(header, hunkHdr, hunkBody, selStage, 'stage', 'multi.txt')!;
			expect(stagePatch).not.toBeNull();
			expect(await features.applyHunkPatch(tmpRepo, stagePatch, 'stage')).toBeNull();
			expect(gitIn(tmpRepo, 'show', ':multi.txt')).toBe(['alpha', 'BETA_NEW', 'gamma', 'delta'].join('\n'));

			// Now also stage the rest, then unstage ONLY '+GAMMA_NEW' & '-gamma' from a multi-line staged hunk
			expect(await features.stageFiles(tmpRepo, ['multi.txt'])).toBeNull();
			const staged = await features.getFileHunkDiff(tmpRepo, 'multi.txt', true);
			const sLines = staged.diff.replace(/\r\n/g, '\n').split('\n');
			if (sLines[sLines.length - 1] === '') sLines.pop();
			const sAt = sLines.findIndex((l) => l.startsWith('@@ '));
			const sBody = sLines.slice(sAt + 1);
			const selUnstage = new Set<number>();
			sBody.forEach((l, idx) => {
				if (l === '-gamma' || l === '+GAMMA_NEW') selUnstage.add(idx);
			});
			const unstagePatch = buildPartialHunkPatch(sLines.slice(0, sAt).join('\n'), sLines[sAt], sBody, selUnstage, 'unstage', 'multi.txt')!;
			expect(await features.applyHunkPatch(tmpRepo, unstagePatch, 'unstage')).toBeNull();
			expect(gitIn(tmpRepo, 'show', ':multi.txt')).toBe(['alpha', 'BETA_NEW', 'gamma', 'delta'].join('\n'));

			// Discard ONLY the remaining unstaged GAMMA_NEW edit in the working tree
			const unstaged2 = await features.getFileHunkDiff(tmpRepo, 'multi.txt', false);
			const uLines = unstaged2.diff.replace(/\r\n/g, '\n').split('\n');
			if (uLines[uLines.length - 1] === '') uLines.pop();
			const uAt = uLines.findIndex((l) => l.startsWith('@@ '));
			const uBody = uLines.slice(uAt + 1);
			const selDiscard = new Set<number>();
			uBody.forEach((l, idx) => {
				if (l.startsWith('+') || l.startsWith('-')) selDiscard.add(idx);
			});
			const discardPatch = buildPartialHunkPatch(uLines.slice(0, uAt).join('\n'), uLines[uAt], uBody, selDiscard, 'discard', 'multi.txt')!;
			expect(await features.applyHunkPatch(tmpRepo, discardPatch, 'discard')).toBeNull();
			expect(fs.readFileSync(file, 'utf8')).toBe(['alpha', 'BETA_NEW', 'gamma', 'delta'].join('\n') + '\n');
		});
	});
});
