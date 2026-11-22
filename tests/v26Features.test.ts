import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { parseWholeFileAiResolutions, parseWholeFileAiResolutionsWithConfidence } from '../src/conflictAssistant';
import { sanitizeAiSearchQuery } from '../src/explainCommit';
import { GitFeatures } from '../src/gitFeatures';
import { GitProcessScheduler } from '../src/gitProcessScheduler';
import { computeGuardRiskScore } from '../src/preCommitGuard';
import { computeStackedPrMetadata } from '../src/prStatusIntegration';
import { computeRepoInsights } from '../src/repoInsights';
import { RepoMetadataStore } from '../src/repoMetadataStore';
import { PullRequestBadgeInfo } from '../src/types';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'V26 Tester',
	GIT_AUTHOR_EMAIL: 'v26@example.com',
	GIT_COMMITTER_NAME: 'V26 Tester',
	GIT_COMMITTER_EMAIL: 'v26@example.com',
	GIT_TERMINAL_PROMPT: '0'
});

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('v2.6.0 Features & Architecture', () => {
	describe('GitProcessScheduler', () => {
		it('Should bound concurrent tasks in FIFO order and release slots on errors', async () => {
			const scheduler = new GitProcessScheduler(2);
			let active = 0, peak = 0;
			const started: number[] = [];

			const makeTask = (id: number, shouldFail: boolean = false) => scheduler.run(async () => {
				started.push(id);
				active++;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 15));
				active--;
				if (shouldFail) throw new Error('boom-' + id);
				return id * 10;
			});

			const results = await Promise.allSettled([
				makeTask(1),
				makeTask(2, true),
				makeTask(3),
				makeTask(4)
			]);

			expect(peak).toBeLessThanOrEqual(2);
			expect(started).toEqual([1, 2, 3, 4]);
			expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
			expect(results[1].status).toBe('rejected');
			expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
			expect(results[3]).toEqual({ status: 'fulfilled', value: 40 });
			expect(scheduler.getStats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2 });
		});

		it('Should reject queued tasks immediately when cancelled', async () => {
			const scheduler = new GitProcessScheduler(1);
			let releaseFirst!: () => void;
			const first = scheduler.run(() => new Promise<string>((resolve) => {
				releaseFirst = () => resolve('ok');
			}));

			let cancelListener: (() => void) | null = null;
			const token = {
				isCancellationRequested: false,
				onCancellationRequested: (cb: () => unknown) => {
					cancelListener = () => { cb(); };
					return { dispose: () => { cancelListener = null; } };
				}
			};
			const second = scheduler.run(() => Promise.resolve('should-not-run'), token);
			expect(scheduler.getStats().queued).toBe(1);

			token.isCancellationRequested = true;
			if (cancelListener !== null) (cancelListener as () => void)();
			await expect(second).rejects.toBe('Cancelled');
			expect(scheduler.getStats().queued).toBe(0);

			releaseFirst();
			await expect(first).resolves.toBe('ok');
		});
	});

	describe('RepoMetadataStore (non-invasive local metadata)', () => {
		it('Should persist pinned branches and review sessions per repository without mutating git config', () => {
			const backing: { [k: string]: unknown } = {};
			const memento = {
				keys: () => Object.keys(backing),
				get: <T>(key: string) => backing[key] as T | undefined,
				update: (key: string, value: unknown) => {
					backing[key] = value;
					return Promise.resolve();
				}
			};
			const store = new RepoMetadataStore(memento);
			expect(store.togglePinnedBranch('/repo/a', 'main')).toEqual(['main']);
			expect(store.togglePinnedBranch('/repo/a', 'feat/ui')).toEqual(['main', 'feat/ui']);
			expect(store.togglePinnedBranch('/repo/a', 'main')).toEqual(['feat/ui']);

			const s1 = store.updateReviewSession('/repo/a', 'uncommitted:feat/ui', {
				viewedFiles: ['src/a.ts', 'src/a.ts', 'src/b.ts'],
				comments: [{ id: 'c1', filePath: 'src/a.ts', severity: 'blocker', text: 'Check null', createdAt: 100 }]
			});
			expect(s1.viewedFiles).toEqual(['src/a.ts', 'src/b.ts']);
			expect(s1.comments).toHaveLength(1);
			expect(store.getRepoMetadata('/repo/b').pinnedBranches).toEqual([]);

			const cleared = store.updateReviewSession('/repo/a', 'uncommitted:feat/ui', { clear: true });
			expect(cleared.viewedFiles).toEqual([]);
			expect(cleared.comments).toEqual([]);

			const saved1 = store.saveFilterPreset('/repo/a', 'Auth Week', 'after:7d file:auth');
			expect(saved1).toHaveLength(1);
			expect(saved1[0]).toMatchObject({ name: 'Auth Week', query: 'after:7d file:auth' });
			const afterDel = store.deleteFilterPreset('/repo/a', saved1[0].id);
			expect(afterDel).toEqual([]);
		});
	});

	describe('v2.7.0: Explainable Guard Risk Score & Co-Change File Clusters', () => {
		it('Should compute 0-100 health/risk scores with explicit evidence deductions', () => {
			const clean = computeGuardRiskScore([], 3, 40);
			expect(clean.score).toBe(100);
			expect(clean.grade).toBe('safe');
			expect(clean.evidence[0].deduction).toBe(0);

			const risky = computeGuardRiskScore([
				{ severity: 'high', kind: 'secret', file: 'src/cfg.ts', line: 12, message: 'Possible API secret key', snippet: 'sk-123' },
				{ severity: 'medium', kind: 'debug', file: 'src/app.ts', line: 4, message: 'Debug console.log', snippet: 'console.log(x)' }
			], 22, 800);
			expect(risky.score).toBe(32);
			expect(risky.grade).toBe('high-risk');
			expect(risky.evidence).toHaveLength(4);
		});

		it('Should detect co-change file clusters across commits while ignoring single-file commits', () => {
			const raw = [
				'\x1eAlice\x1falice@example.com\x1f1700000000\n10\t2\tsrc/a.ts\n5\t1\tsrc/b.ts',
				'\x1eBob\x1fbob@example.com\x1f1700003600\n3\t1\tsrc/a.ts\n4\t0\tsrc/b.ts',
				'\x1eAlice\x1falice@example.com\x1f1700007200\n1\t0\tsrc/solo.ts'
			].join('\n');
			const data = computeRepoInsights(raw);
			expect(data.coChangeClusters).toBeDefined();
			expect(data.coChangeClusters![0]).toEqual({ fileA: 'src/a.ts', fileB: 'src/b.ts', coCommits: 2, couplingPct: 100 });
		});
	});

	describe('Stacked PR Metadata, AI Search Sanitizer & Conflict Confidence Parser', () => {
		it('Should compute multi-level stacked PR chains and guard against cycles', () => {
			const badges: { [branch: string]: PullRequestBadgeInfo } = {
				'feat/base': { number: 10, title: 'Base', url: 'https://x/10', state: 'open', ciStatus: 'success', baseBranch: 'main' },
				'feat/mid': { number: 11, title: 'Mid', url: 'https://x/11', state: 'open', ciStatus: 'pending', baseBranch: 'feat/base' },
				'feat/top': { number: 12, title: 'Top', url: 'https://x/12', state: 'draft', ciStatus: 'unknown', baseBranch: 'feat/mid', mergeQueueState: 'queued' },
				'standalone': { number: 13, title: 'Solo', url: 'https://x/13', state: 'open', ciStatus: 'success', baseBranch: 'main' }
			};
			const enriched = computeStackedPrMetadata(badges);
			expect(enriched['feat/base']).toMatchObject({ stackDepth: 1, stackSize: 3, stackParentBranch: null, stackChildBranches: ['feat/mid'] });
			expect(enriched['feat/mid']).toMatchObject({ stackDepth: 2, stackSize: 3, stackParentBranch: 'feat/base', stackChildBranches: ['feat/top'] });
			expect(enriched['feat/top']).toMatchObject({ stackDepth: 3, stackSize: 3, stackParentBranch: 'feat/mid', stackChildBranches: [], mergeQueueState: 'queued' });
			expect(enriched['standalone'].stackDepth).toBeUndefined();
		});

		it('Should sanitize AI search queries into clean single-line operators', () => {
			expect(sanitizeAiSearchQuery('```\nQuery: author:andy file:src/auth after:2026-10-01\n```')).toBe('author:andy file:src/auth after:2026-10-01');
			expect(sanitizeAiSearchQuery('`message:timeout after:7d`')).toBe('message:timeout after:7d');
		});

		it('Should parse structured AI conflict resolutions with confidence and remain backward compatible with string arrays', () => {
			const structured = parseWholeFileAiResolutionsWithConfidence(
				'[{"code":"const a = 1;","confidence":"high","reason":"Non-overlapping imports"},{"code":"const b = 2;","confidence":"low","reason":"Both sides changed timeout"}]',
				2
			);
			expect(structured).toEqual([
				{ text: 'const a = 1;', confidence: 'high', reason: 'Non-overlapping imports' },
				{ text: 'const b = 2;', confidence: 'low', reason: 'Both sides changed timeout' }
			]);
			expect(parseWholeFileAiResolutions('["line1","line2"]', 2)).toEqual(['line1', 'line2']);
		});
	});

	describe('Review Session Scopes & Agent Context Markdown (Real Git)', () => {
		let tmpRepo: string;
		let features: GitFeatures;

		beforeEach(() => {
			tmpRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-v26-'));
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

		it('Should compute uncommitted and branch review scopes and export Markdown context for coding agents', async () => {
			fs.writeFileSync(path.join(tmpRepo, 'base.ts'), 'export const v = 1;\n');
			gitIn(tmpRepo, 'add', '-A');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'init main');

			gitIn(tmpRepo, 'checkout', '-q', '-b', 'feat/review');
			fs.writeFileSync(path.join(tmpRepo, 'feature.ts'), 'export const f = true;\n');
			gitIn(tmpRepo, 'add', '-A');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'feat: add review module');
			const headHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			// Uncommitted dirty file
			fs.writeFileSync(path.join(tmpRepo, 'base.ts'), 'export const v = 2;\n');

			const uncommittedScope = await features.getReviewSessionScopeFiles(tmpRepo, 'uncommitted');
			expect(uncommittedScope.error).toBeNull();
			expect(uncommittedScope.files.map((f) => f.newFilePath)).toContain('base.ts');

			const branchScope = await features.getReviewSessionScopeFiles(tmpRepo, 'branch');
			expect(branchScope.error).toBeNull();
			expect(branchScope.baseLabel).toBe('main');
			expect(branchScope.commitCount).toBe(1);
			expect(branchScope.files.map((f) => f.newFilePath)).toEqual(['feature.ts']);

			const md = await features.buildAgentContextMarkdown(tmpRepo, headHash);
			expect(md).toContain('# Repository Context:');
			expect(md).toContain('`feat/review`');
			expect(md).toContain('`base.ts`');
			expect(md).toContain('feat: add review module');
		});
	});
});
