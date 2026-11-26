import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { confidenceToScore, shouldAutoApplyResolutions } from '../src/aiAutoRebase';
import {
	appendCustomInstructions,
	estimateTokenCount,
	filterDiffByExcludeGlobs,
	getDirectAiConfigForTask,
	matchesExcludeGlobs
} from '../src/aiProviders';
import {
	applyAutolinksToMarkdown,
	compileAutolinkRules,
	findAutolinkMatches,
	formatStartWorkBranchName,
	isSafeAutolinkUrl
} from '../src/autolinks';
import {
	hasGitMapMcpEntry,
	upsertAgentHookScript,
	upsertGitMapMcpJson
} from '../src/codingAgents';
import { parseChangedLineRangesFromDiff } from '../src/fileChanges';
import { computeHeatBucket } from '../src/fileHeatmap';
import { ensureSshAllowedSignersFile, parseCountObjectsOutput } from '../src/gitMaintenance';
import { formatBlameTemplate } from '../src/lineBlame';
import { MCP_TOOL_DEFINITIONS, handleMcpToolCall } from '../src/mcpServerCli';
import { classifyPrForLaunchpad } from '../src/prLaunchpad';
import { parseRebaseTodoDocument, serializeRebaseTodoDocument } from '../src/rebaseTodoCustomEditor';
import {
	RemoteHost,
	getRemoteCommitUrl,
	getRemoteWebRepo,
	matchCustomRemote,
	resolveCustomRemoteAvatarUrl
} from '../src/remoteLinks';
import { formatScmNodeTemplate } from '../src/scmTreeViews';
import { extractTerminalLinks } from '../src/terminalLinks';
import { GitLineBlame, PullRequestBadgeInfo } from '../src/types';

describe('v2.8 Feature Helpers & Pure Logic', () => {
	test('autolinks compile, match safely, render markdown, and format Start Work branches', () => {
		expect(isSafeAutolinkUrl('https://jira.example.com/browse/<num>')).toBe(true);
		expect(isSafeAutolinkUrl('mailto:dev@example.com')).toBe(true);
		const unsafeScript = 'java' + 'script:alert(1)';
		expect(isSafeAutolinkUrl(unsafeScript)).toBe(false);
		expect(isSafeAutolinkUrl('data:text/html,<script>')).toBe(false);

		const rules = [
			{ prefix: 'PROJ-', url: 'https://jira.example.com/browse/PROJ-<num>', alphanumeric: false },
			{ prefix: 'BAD-', url: 'java' + 'script:alert(<num>)' }
		];
		expect(compileAutolinkRules(rules)).toHaveLength(1);
		const matches = findAutolinkMatches('Fix PROJ-123 and BAD-99', rules);
		expect(matches).toHaveLength(1);
		expect(matches[0].url).toBe('https://jira.example.com/browse/PROJ-123');
		expect(applyAutolinksToMarkdown('Fixes PROJ-45!', rules)).toContain('(https://jira.example.com/browse/PROJ-45');

		expect(formatStartWorkBranchName('${id}-${title}', 'PROJ-42', 'Fix Login Flow!')).toBe('PROJ-42-fix-login-flow');
		expect(formatStartWorkBranchName('feat/${id}_${title}', '101', 'Add API  Support')).toBe('feat/101_add-api-support');
	});

	test('custom remotes resolve self-hosted URLs and avatars', () => {
		const custom = [{
			domain: 'git.internal.corp',
			type: 'gitlab' as const,
			name: 'Corp GitLab',
			avatarUrl: 'https://git.internal.corp/avatar/${emailHash}?s=${author}'
		}];
		const webRepo = getRemoteWebRepo('git@git.internal.corp:team/core-app.git', custom);
		expect(webRepo).not.toBeNull();
		expect(webRepo!.host).toBe(RemoteHost.GitLab);
		expect(getRemoteCommitUrl(webRepo!, 'abcdef12')).toContain('https://git.internal.corp/team/core-app/-/commit/abcdef12');
		expect(matchCustomRemote('https://git.internal.corp/team/core-app.git', 'git.internal.corp', custom)).not.toBeNull();
		expect(resolveCustomRemoteAvatarUrl('https://git.internal.corp/team/core-app.git', 'dev@internal.corp', 'Dev', custom)).toContain('s=Dev');
	});

	test('extractTerminalLinks detects ranges, commits, and known refs without false positives', () => {
		const refs = new Set(['main', 'feature/v2']);
		const links = extractTerminalLinks('Comparing abcd123..ef01999 on feature/v2 and #ff00aa color', refs);
		expect(links.some((l) => l.kind === 'range' && l.fromRef === 'abcd123' && l.toRef === 'ef01999')).toBe(true);
		expect(links.some((l) => l.kind === 'ref' && l.text === 'feature/v2')).toBe(true);
		// #ff00aa color token must NOT be treated as a commit hash
		expect(links.some((l) => l.kind === 'commit' && l.text === 'ff00aa')).toBe(false);
	});

	test('computeHeatBucket scales hot and cold timestamps relative to ageThreshold', () => {
		const now = 1_700_000_000;
		const fresh = computeHeatBucket(now - 3600, now, 90);
		const old = computeHeatBucket(now - 300 * 86400, now, 90);
		expect(fresh.isHot).toBe(true);
		expect(fresh.level).toBe(5);
		expect(old.isHot).toBe(false);
		expect(old.level).toBeLessThanOrEqual(2);
	});

	test('parseChangedLineRangesFromDiff extracts added, modified, and deleted ranges', () => {
		const diff = [
			'@@ -10,0 +11,3 @@',
			'@@ -20,2 +23,1 @@',
			'@@ -30,2 +31,0 @@'
		].join('\n');
		const ranges = parseChangedLineRangesFromDiff(diff);
		expect(ranges).toEqual([
			{ start: 10, end: 12, kind: 'added' },
			{ start: 22, end: 22, kind: 'modified' },
			{ start: 30, end: 30, kind: 'deleted' }
		]);
	});

	test('formatBlameTemplate formats author, PR suffix, and truncated message', () => {
		const blame: GitLineBlame = {
			hash: '1234567890abcdef',
			committed: true,
			author: 'Alice',
			authorEmail: 'alice@example.com',
			authorDate: Math.floor(Date.now() / 1000) - 120,
			summary: 'refactor authentication middleware',
			originalLine: 5,
			originalFilePath: 'src/auth.ts'
		};
		const out = formatBlameTemplate('${author, }${agoOrDate}${\' via \'pullRequest}${\' • \'message|20?}', blame, { number: 77, url: 'https://github.com/o/r/pull/77', title: 'Auth refactor' });
		expect(out).toContain('Alice, ');
		expect(out).toContain(' via PR #77');
		expect(out).toContain('refactor authentica…');
	});

	test('classifyPrForLaunchpad categorizes mergeable, blocked, needsReview, and stale PRs', () => {
		const freshIso = new Date().toISOString();
		const mkPr = (overrides: Partial<PullRequestBadgeInfo>): PullRequestBadgeInfo => ({
			number: 1,
			title: 'PR',
			url: 'https://github.com/o/r/pull/1',
			ciStatus: 'success',
			state: 'open',
			baseBranch: 'main',
			updatedAt: freshIso,
			...overrides
		});
		expect(classifyPrForLaunchpad(mkPr({ ciStatus: 'failure' }), 'alice', 7)).toBe('blocked');
		expect(classifyPrForLaunchpad(mkPr({ reviewDecision: 'approved' }), 'alice', 7)).toBe('mergeable');
		expect(classifyPrForLaunchpad(mkPr({ ciStatus: 'pending', author: 'bob', isRequestedReviewer: true }), 'alice', 7)).toBe('needsReview');
		expect(classifyPrForLaunchpad(mkPr({ updatedAt: '2020-01-01T00:00:00Z' }), 'alice', 7)).toBe('other');
	});

	test('AI helpers handle exclusions, custom instructions, token estimates, task routing, and auto-rebase threshold', () => {
		expect(matchesExcludeGlobs('package-lock.json', ['**/package-lock.json', '**/*.min.js'])).toBe(true);
		expect(matchesExcludeGlobs('src/app.ts', ['**/*.lock'])).toBe(false);
		const diff = [
			'diff --git a/src/app.ts b/src/app.ts',
			'+const x = 1;',
			'diff --git a/yarn.lock b/yarn.lock',
			'+huge lock content'
		].join('\n');
		const filtered = filterDiffByExcludeGlobs(diff, ['**/*.lock']);
		expect(filtered.filtered).toContain('src/app.ts');
		expect(filtered.filtered).not.toContain('huge lock content');
		expect(filtered.excludedFiles).toEqual(['yarn.lock']);
		expect(appendCustomInstructions('Base prompt', 'Respond in bullet points')).toContain('Respond in bullet points');
		expect(estimateTokenCount('hello world 1234')).toBe(4);
		expect(getDirectAiConfigForTask('commitMessage').preferredModelId).toBeNull();

		expect(confidenceToScore('high')).toBe(0.9);
		expect(confidenceToScore('low')).toBe(0.25);
		expect(shouldAutoApplyResolutions([{ text: 'a', confidence: 'high', reason: 'clear' }], 0.85)).toBe(true);
		expect(shouldAutoApplyResolutions([{ text: 'a', confidence: 'medium', reason: 'unsure' }], 0.85)).toBe(false);
	});

	test('rebaseTodoCustomEditor round-trips commits, commands, and comments cleanly', () => {
		const raw = [
			'p abc1234 First commit',
			'r def5678 Second commit',
			'x npm test',
			'# Rebase instructions'
		].join('\n');
		const entries = parseRebaseTodoDocument(raw);
		expect(entries[0]).toMatchObject({ kind: 'commit', action: 'pick', hash: 'abc1234', subject: 'First commit' });
		expect(entries[1]).toMatchObject({ kind: 'commit', action: 'reword', hash: 'def5678', subject: 'Second commit' });
		expect(entries[2]).toMatchObject({ kind: 'command', action: 'exec', subject: 'npm test' });
		expect(entries[3].kind).toBe('comment');
		expect(serializeRebaseTodoDocument(entries)).toBe([
			'pick abc1234 First commit',
			'reword def5678 Second commit',
			'x npm test',
			'# Rebase instructions'
		].join('\n'));
	});

	test('formatScmNodeTemplate resolves tokens, trailing suffixes, and conditional prefixes', () => {
		expect(formatScmNodeTemplate('${author}${, |hash}', { author: 'Alice', hash: 'abc1234' })).toBe('Alice, abc1234');
		expect(formatScmNodeTemplate('${author}${, |hash}', { author: 'Alice', hash: '' })).toBe('Alice');
		expect(formatScmNodeTemplate('${author, }${agoOrDate}', { author: 'Alice', ago: '2h ago' })).toBe('Alice, 2h ago');
		expect(formatScmNodeTemplate('${\' on \'stashOnRef}', { stashOnRef: 'main' })).toBe('on main');
	});

	test('codingAgents MCP JSON and Git hook helpers add and remove entries cleanly', () => {
		const initialCopilot = JSON.stringify({ servers: { existing: { command: 'echo' } } });
		const addedCopilot = upsertGitMapMcpJson(initialCopilot, 'copilot-chat', '/ext/out/mcpServerCli.js', '/repo', true);
		expect(hasGitMapMcpEntry(addedCopilot, 'copilot-chat')).toBe(true);
		expect(JSON.parse(addedCopilot).servers.existing).toBeDefined();
		const removedCopilot = upsertGitMapMcpJson(addedCopilot, 'copilot-chat', '/ext/out/mcpServerCli.js', '/repo', false);
		expect(hasGitMapMcpEntry(removedCopilot, 'copilot-chat')).toBe(false);
		expect(JSON.parse(removedCopilot).servers.existing).toBeDefined();

		const addedCli = upsertGitMapMcpJson('', 'claude-code', '/ext/out/mcpServerCli.js', '/repo', true);
		expect(hasGitMapMcpEntry(addedCli, 'claude-code')).toBe(true);

		const hookEnabled = upsertAgentHookScript('#!/bin/sh\necho custom\n', 'codex', true);
		expect(hookEnabled).toContain('echo custom');
		expect(hookEnabled).toContain('git-map-agent-hook');
		const hookRemoved = upsertAgentHookScript(hookEnabled, 'codex', false);
		expect(hookRemoved).toContain('echo custom');
		expect(hookRemoved).not.toContain('git-map-agent-hook');
	});

	test('MCP server definitions and gitMaintenance parsers validate inputs safely', async () => {
		expect(MCP_TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
			'git_map_status',
			'git_map_recent_commits',
			'git_map_diff',
			'git_map_branches'
		]);
		await expect(handleMcpToolCall(process.cwd(), 'git_map_diff', { commit: 'not-a-hex-sha!' })).rejects.toThrow('Invalid commit hash');
		await expect(handleMcpToolCall(process.cwd(), 'unknown_tool', {})).rejects.toThrow('Unknown tool');

		const parsed = parseCountObjectsOutput('count: 612\nsize: 2048\nin-pack: 5000\n');
		expect(parsed).toEqual({ looseObjects: 612, sizeKb: 2048 });

		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-signers-'));
		try {
			fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
			const res = await ensureSshAllowedSignersFile('git', tmpDir);
			expect(res.error).toBeNull();
			expect(res.filePath).not.toBeNull();
			expect(fs.existsSync(res.filePath!)).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
