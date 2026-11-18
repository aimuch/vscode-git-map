import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from './mocks/vscode';
jest.mock('vscode', () => vscode, { virtual: true });

import { clearPrStatusCache, fetchRepoPullRequestBadges } from '../src/prStatusIntegration';
import { ReflogExplorer } from '../src/reflogExplorer';
import { AsyncRequestSequencer, PanelSyncMachine, StateMachine } from '../src/stateMachines';

const GIT_ENV = Object.assign({}, process.env, {
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: os.devNull,
	GIT_AUTHOR_NAME: 'State Tester',
	GIT_AUTHOR_EMAIL: 'state@example.com',
	GIT_COMMITTER_NAME: 'State Tester',
	GIT_COMMITTER_EMAIL: 'state@example.com',
	GIT_TERMINAL_PROMPT: '0'
});

function gitIn(cwd: string, ...args: string[]) {
	return cp.execFileSync('git', args, { cwd: cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

describe('StateMachine, AsyncRequestSequencer & Performance Refactors', () => {
	describe('StateMachine', () => {
		type DemoState =
			| { readonly status: 'idle'; readonly count: number }
			| { readonly status: 'running'; readonly count: number };
		type DemoEvent =
			| { readonly type: 'START' }
			| { readonly type: 'STOP' }
			| { readonly type: 'NOOP' };

		it('Should apply pure transitions, notify subscribers only on reference changes, and support unsubscribing', () => {
			const transitions: string[] = [];
			const sm = new StateMachine<DemoState, DemoEvent>({ status: 'idle', count: 0 }, (state, event) => {
				switch (event.type) {
					case 'START':
						return state.status === 'running' ? state : { status: 'running', count: state.count + 1 };
					case 'STOP':
						return state.status === 'idle' ? state : { status: 'idle', count: state.count };
					case 'NOOP':
						return state;
				}
			});

			const unsub = sm.onTransition((next, prev, ev) => {
				transitions.push(prev.status + '->' + next.status + ':' + ev.type + ':' + next.count);
			});

			sm.send({ type: 'NOOP' });
			expect(transitions).toEqual([]);

			sm.send({ type: 'START' });
			sm.send({ type: 'START' }); // idempotent
			sm.send({ type: 'STOP' });
			expect(transitions).toEqual(['idle->running:START:1', 'running->idle:STOP:1']);

			unsub();
			sm.send({ type: 'START' });
			expect(sm.status).toBe('running');
			expect(sm.state.count).toBe(2);
			expect(transitions.length).toBe(2);
		});
	});

	describe('AsyncRequestSequencer', () => {
		it('Should reject out-of-order stale completions and reset cleanly on cancel', () => {
			const seq = new AsyncRequestSequencer();
			expect(seq.status).toBe('idle');

			const r1 = seq.begin();
			expect(seq.status).toBe('loading');
			expect(seq.isCurrent(r1)).toBe(true);

			const r2 = seq.begin();
			expect(seq.isCurrent(r1)).toBe(false);
			expect(seq.isCurrent(r2)).toBe(true);

			// Stale response r1 arrives after r2 started -> dropped
			expect(seq.complete(r1)).toBe(false);
			expect(seq.status).toBe('loading');

			// Latest response r2 arrives -> accepted
			expect(seq.complete(r2)).toBe(true);
			expect(seq.status).toBe('ready');

			// Failure & cancellation paths
			const r3 = seq.begin();
			expect(seq.fail(r3)).toBe(true);
			expect(seq.status).toBe('error');

			const r4 = seq.begin();
			seq.cancel();
			expect(seq.status).toBe('idle');
			expect(seq.complete(r4)).toBe(false);
		});
	});

	describe('PanelSyncMachine dirty lattice', () => {
		it('Should enforce none < partial(ai, cdv) < full and consume dirty flags atomically', () => {
			const sync = new PanelSyncMachine(true);
			expect(sync.state).toEqual({
				status: 'unloaded',
				visible: true,
				loaded: false,
				dirty: { kind: 'none' }
			});

			sync.markGraphRendered(true, true);
			expect(sync.state.status).toBe('visible');

			sync.setVisible(false);
			expect(sync.state.status).toBe('hidden');

			sync.markAiDirty();
			expect(sync.state.dirty).toEqual({ kind: 'partial', ai: true, cdv: false });

			sync.markCdvDirty();
			expect(sync.state.dirty).toEqual({ kind: 'partial', ai: true, cdv: true });

			// Full update dominates partial flags
			sync.markFullDirty();
			expect(sync.state.dirty).toEqual({ kind: 'full' });

			// Subsequent partial marks do not downgrade 'full'
			sync.markAiDirty();
			sync.markCdvDirty();
			expect(sync.state.dirty).toEqual({ kind: 'full' });

			const consumed = sync.consumeDirty();
			expect(consumed).toEqual({ kind: 'full' });
			expect(sync.state.dirty).toEqual({ kind: 'none' });
		});
	});

	describe('ReflogExplorer targeted rev-list reachability (P-1)', () => {
		let tmpRepo: string;

		beforeEach(() => {
			tmpRepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'git-map-reflog-'));
			gitIn(tmpRepo, 'init', '-q', '-b', 'main');
		});

		afterEach(() => {
			fs.rmSync(tmpRepo, { recursive: true, force: true });
		});

		it('Should accurately flag reset/orphaned commits without dumping all repository SHAs', async () => {
			const file = path.join(tmpRepo, 'notes.txt');
			fs.writeFileSync(file, 'v1\n');
			gitIn(tmpRepo, 'add', 'notes.txt');
			gitIn(tmpRepo, 'commit', '-q', '-m', 'First');
			const firstHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			fs.writeFileSync(file, 'v2\n');
			gitIn(tmpRepo, 'commit', '-q', '-am', 'Second (will become orphaned)');
			const orphanedHash = gitIn(tmpRepo, 'rev-parse', 'HEAD');

			gitIn(tmpRepo, 'reset', '--hard', firstHash);

			const spawnedArgs: string[][] = [];
			const explorer = new ReflogExplorer(
				<any>{
					spawnGitProcess: (args: string[], cwd: string) => {
						spawnedArgs.push(args);
						return cp.spawn('git', args, { cwd: cwd, env: GIT_ENV });
					}
				},
				<any>{ getRepos: () => ({}), getRepoContainingFile: () => null },
				<any>{ getLastActiveRepo: () => null },
				<any>{ log: () => { } }
			);

			try {
				const entries = await explorer['loadReflogEntries'](tmpRepo);
				expect(entries.length).toBeGreaterThanOrEqual(2);
				const orphanedEntry = entries.find((e) => e.hash === orphanedHash);
				const reachableEntry = entries.find((e) => e.hash === firstHash);
				expect(orphanedEntry?.orphaned).toBe(true);
				expect(reachableEntry?.orphaned).toBe(false);

				// Verify the targeted rev-list form: git rev-list <hashes...> --not --branches --tags --remotes
				const revListCall = spawnedArgs.find((a) => a[0] === 'rev-list');
				expect(revListCall).toBeDefined();
				expect(revListCall).toContain('--not');
				expect(revListCall).toContain(orphanedHash);
			} finally {
				explorer.dispose();
			}
		});
	});

	describe('PR badge in-flight request deduplication (P-3)', () => {
		afterEach(() => {
			clearPrStatusCache();
		});

		it('Should deduplicate concurrent fetchRepoPullRequestBadges calls for the same repository', async () => {
			let remoteCalls = 0;
			const fakeDataSource: any = {
				spawnGitProcess: () => {
					remoteCalls++;
					const proc = cp.spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(""), 40)']);
					return proc;
				}
			};

			const [res1, res2, res3] = await Promise.all([
				fetchRepoPullRequestBadges(fakeDataSource, '/fake/repo'),
				fetchRepoPullRequestBadges(fakeDataSource, '/fake/repo'),
				fetchRepoPullRequestBadges(fakeDataSource, '/fake/repo')
			]);

			expect(remoteCalls).toBe(1);
			expect(res1).toEqual({});
			expect(res2).toEqual({});
			expect(res3).toEqual({});
		});
	});
});
