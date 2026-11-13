import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { FastExportFilter, FastExportFilterStats, normaliseHistoryPath } from './historyFilter';

/**
 * What the History Rewriter needs to run Git (implemented by the DataSource).
 */
export interface GitProcessRunner {
	/**
	 * Spawn Git.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param env Additional environment variables.
	 * @returns The process.
	 * @throws If there isn't a Git executable.
	 */
	spawnGitProcess: (args: string[], repo: string, env?: { [name: string]: string }) => cp.ChildProcess;

	/**
	 * Get the version of the Git executable.
	 * @returns The version, or NULL if there isn't a Git executable.
	 */
	getGitVersion: () => string | null;

	/**
	 * Get the operation that's in progress in a repository (e.g. a rebase or merge that stopped because of conflicts).
	 * @returns The operation, or NULL if no operation is in progress.
	 */
	getOperationInProgress: (repo: string) => Promise<string | null>;
}

/**
 * A request to cancel (the same shape as a CancellationToken of Visual Studio Code).
 */
export interface CancellationRequest {
	readonly isCancellationRequested: boolean;
	onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

/**
 * A reason why files can't be removed from the history of a repository in its current state.
 */
export type HistoryRemovalBlocker =
	{ readonly kind: 'gitVersion', readonly version: string }
	| { readonly kind: 'notInHistory' }
	| { readonly kind: 'detachedHead' }
	| { readonly kind: 'uncommittedChanges' }
	| { readonly kind: 'operationInProgress', readonly operation: string }
	| { readonly kind: 'shallow' }
	| { readonly kind: 'worktrees', readonly count: number }
	| { readonly kind: 'stashes', readonly stashes: ReadonlyArray<string> };

/**
 * What removing files from the history of a repository would do.
 */
export interface HistoryRemovalPreview {
	readonly paths: ReadonlyArray<string>; // The paths that would be removed (normalised)
	readonly pathsNotInHistory: ReadonlyArray<string>; // The paths that aren't in the history of any branch or tag
	readonly files: number; // The number of files in the history that match the paths
	readonly commits: number; // The number of commits that change the files
	readonly totalCommits: number; // The number of commits of all branches & tags
	readonly branches: ReadonlyArray<string> | null; // The branches containing the files (NULL if they couldn't be determined)
	readonly tags: ReadonlyArray<string> | null; // The tags containing the files
	readonly remoteBranches: ReadonlyArray<string> | null; // The remote-tracking branches containing the files (i.e. they've been pushed or fetched)
	readonly remoteOnlyBranches: ReadonlyArray<string>; // The remote-tracking branches containing the files that don't have a local branch (they aren't rewritten)
	readonly pathsInHead: ReadonlyArray<string>; // The paths that exist in the commit that's checked out
	readonly blobs: ReadonlyArray<string>; // The object ids of the versions of the files
	readonly size: number | null; // The size on disk of the versions of the files (bytes), or NULL if it couldn't be determined
	readonly zeroOid: string; // The object id of all zeros, in the object format of the repository
	readonly keepsUnaffectedSignatures: boolean; // FALSE => This version of Git removes the signatures of all commits (not only of the commits that are rewritten)
	readonly blockers: ReadonlyArray<HistoryRemovalBlocker>;
}

/**
 * What removing files from the history of a repository did.
 */
export interface HistoryRemovalResult {
	readonly stats: FastExportFilterStats;
	readonly rewrittenBranches: ReadonlyArray<string>; // The branches that now refer to a different commit
	readonly rewrittenTags: ReadonlyArray<string>;
	readonly deletedRefs: ReadonlyArray<string>; // The branches & tags that were deleted, as none of their commits were left
	readonly backupPath: string | null; // The bundle containing the history as it was before
}

/**
 * What still refers to files that were removed from the history of a repository.
 */
export interface HistoryRemovalLeftovers {
	readonly refs: ReadonlyArray<string> | null; // The references (and stashes) whose history still contains the files, or NULL if they couldn't be determined
	readonly blobsRemaining: number; // The number of versions of the files that are still stored in the repository
	readonly blobsChecked: number;
}

/**
 * Thrown when the removal of files from the history was cancelled (the repository wasn't changed).
 */
export class HistoryRewriteCancelledError extends Error {
	constructor() {
		super('Cancelled');
	}
}

export const UNCOMMITTED_CHANGES_ERROR = 'There are uncommitted changes.';
const MINIMUM_GIT_VERSION = [2, 24];
const MAX_CONTAINS_COMMITS = 100;

/**
 * Removes files from the whole history of a repository, using only Git itself: `git fast-export` writes the history of every branch &
 * tag as a stream, FastExportFilter removes the files from it, and `git fast-import` recreates the history from the filtered stream.
 * Nothing is run by a shell, and no other tool (e.g. git-filter-repo) is required.
 *
 * Only local branches & tags are rewritten. Remote-tracking branches, stashes & reflogs still refer to the previous history until
 * the rewritten branches are pushed, and `purge` is run.
 */
export class HistoryRewriter {
	private readonly git: GitProcessRunner;

	/**
	 * Creates a History Rewriter.
	 * @param git Runs Git.
	 */
	constructor(git: GitProcessRunner) {
		this.git = git;
	}


	/* Inspecting the History */

	/**
	 * Get every path that's in the history of the branches & tags of a repository (including files that have since been deleted).
	 * @param repo The path of the repository.
	 * @returns The paths, and whether each one exists in the commit that's checked out.
	 */
	public async getPathsInHistory(repo: string): Promise<{ path: string, inHead: boolean }[]> {
		const log = await this.run(repo, ['log', '--branches', '--tags', '--format=', '--name-only', '--no-renames', '-z']);
		if (log.code !== 0) throw new Error(log.stderr || 'Unable to read the history of the repository.');
		const head = await this.run(repo, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
		const inHead = new Set(head.code === 0 ? splitNul(head.stdout) : []);
		return Array.from(new Set(splitNul(log.stdout))).sort().map((path) => ({ path: path, inHead: inHead.has(path) }));
	}

	/**
	 * Determine what removing files from the history of a repository would do, and whether it's possible in its current state.
	 * @param repo The path of the repository.
	 * @param paths The paths to remove (relative to the root of the repository). A path of a directory removes everything in it.
	 * @returns What it would do.
	 */
	public async preview(repo: string, paths: ReadonlyArray<string>): Promise<HistoryRemovalPreview> {
		const normalised = Array.from(new Set(paths.map(normaliseHistoryPath).filter((path) => path !== '')));
		if (normalised.length === 0) throw new Error('No paths were given to remove from the history.');
		const blockers: HistoryRemovalBlocker[] = [];

		const version = this.git.getGitVersion();
		if (version !== null && !isVersionAtLeast(version, MINIMUM_GIT_VERSION[0], MINIMUM_GIT_VERSION[1])) blockers.push({ kind: 'gitVersion', version: version });

		// The commits that change the files, with their nearest ancestors that also change them (commits without any are the first ones)
		const pathArgs = ['--'].concat(normalised);
		const touching = await this.run(repo, ['--literal-pathspecs', 'rev-list', '--branches', '--tags', '--parents'].concat(pathArgs));
		const touchingCommits = touching.code === 0 ? touching.stdout.toString().split('\n').filter((line) => line !== '').map((line) => line.split(' ')) : [];
		if (touchingCommits.length === 0) blockers.push({ kind: 'notInHistory' });

		const total = await this.run(repo, ['rev-list', '--count', '--branches', '--tags']);
		const objectFormat = await this.run(repo, ['rev-parse', '--show-object-format']);

		// The files that match the paths, and each version of them
		const files = new Set<string>(), blobs = new Set<string>();
		if (touchingCommits.length > 0) {
			const raw = await this.run(repo, ['--literal-pathspecs', 'log', '--branches', '--tags', '--format=', '--raw', '--no-abbrev', '--no-renames', '-z'].concat(pathArgs));
			const tokens = raw.code === 0 ? splitNul(raw.stdout) : [];
			for (let i = 0; i + 1 < tokens.length; i++) {
				// Each change is ":<old mode> <new mode> <old object> <new object> <status>", followed by its path
				if (!tokens[i].startsWith(':')) continue;
				const fields = tokens[i].split(' ');
				files.add(tokens[++i]);
				if (fields.length >= 5 && !/^0+$/.test(fields[3]) && fields[1] !== '160000') blobs.add(fields[3]);
			}
		}
		const pathsNotInHistory = touchingCommits.length > 0 ? normalised.filter((path) => !Array.from(files).some((file) => file === path || file.startsWith(path + '/'))) : normalised;

		// The branches & tags that contain the files
		const refs = await this.getRefsContaining(repo, normalised, ['--branches', '--tags', '--remotes'], ['refs/heads', 'refs/tags', 'refs/remotes']);
		const branches = refs !== null ? refs.filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.substring(11)) : null;
		const tags = refs !== null ? refs.filter((ref) => ref.startsWith('refs/tags/')).map((ref) => ref.substring(10)) : null;
		const remoteBranches = refs !== null ? refs.filter((ref) => ref.startsWith('refs/remotes/')).map((ref) => ref.substring(13)) : null;
		const localBranches = (await this.run(repo, ['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads'])).stdout.toString().split('\n');
		const remoteOnlyBranches = (remoteBranches || []).filter((branch) => !localBranches.includes(branch.substring(branch.indexOf('/') + 1)));

		const headFiles = await this.run(repo, ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', 'HEAD'].concat(pathArgs));
		const filesInHead = headFiles.code === 0 ? splitNul(headFiles.stdout) : [];
		const pathsInHead = normalised.filter((path) => filesInHead.some((file) => file === path || file.startsWith(path + '/')));

		let size: number | null = null;
		if (blobs.size > 0) {
			const sizes = await this.run(repo, ['cat-file', '--batch-check=%(objectsize:disk)'], Array.from(blobs).join('\n') + '\n');
			if (sizes.code === 0) size = sizes.stdout.toString().split('\n').reduce((sum, line) => sum + (/^\d+$/.test(line) ? parseInt(line) : 0), 0);
		}

		// The state of the repository
		if ((await this.run(repo, ['symbolic-ref', '-q', 'HEAD'])).code !== 0) blockers.push({ kind: 'detachedHead' });
		const status = await this.run(repo, ['status', '--porcelain', '--untracked-files=no']);
		if (status.code !== 0 || status.stdout.length > 0) blockers.push({ kind: 'uncommittedChanges' });
		const operation = await this.git.getOperationInProgress(repo).catch(() => null);
		if (operation !== null) blockers.push({ kind: 'operationInProgress', operation: operation });
		if ((await this.run(repo, ['rev-parse', '--is-shallow-repository'])).stdout.toString().trim() === 'true') blockers.push({ kind: 'shallow' });
		const worktrees = (await this.run(repo, ['worktree', 'list', '--porcelain'])).stdout.toString().split('\n').filter((line) => line.startsWith('worktree ')).length;
		if (worktrees > 1) blockers.push({ kind: 'worktrees', count: worktrees });
		if (touchingCommits.length > 0) {
			// Stashes are based on the commits of the previous history, so they would keep the files in the repository
			const stashesWithFiles = await this.getStashesContaining(repo, normalised);
			if (stashesWithFiles.length > 0) blockers.push({ kind: 'stashes', stashes: stashesWithFiles });
		}

		return {
			paths: normalised,
			pathsNotInHistory: pathsNotInHistory,
			files: files.size,
			commits: touchingCommits.length,
			totalCommits: total.code === 0 ? parseInt(total.stdout.toString().trim()) || 0 : 0,
			branches: branches,
			tags: tags,
			remoteBranches: remoteBranches,
			remoteOnlyBranches: remoteOnlyBranches,
			pathsInHead: pathsInHead,
			blobs: Array.from(blobs),
			size: size,
			zeroOid: '0'.repeat(objectFormat.stdout.toString().trim() === 'sha256' ? 64 : 40),
			keepsUnaffectedSignatures: (await this.getExportArgs(repo)).keepsCommitSignatures,
			blockers: blockers
		};
	}


	/* Rewriting the History */

	/**
	 * Create a bundle containing everything in a repository (all of its references), which the history can be restored from.
	 * @param repo The path of the repository.
	 * @param bundlePath The path of the bundle to create.
	 * @param cancellation Cancels creating the bundle.
	 */
	public async createBackup(repo: string, bundlePath: string, cancellation: CancellationRequest) {
		await fs.promises.mkdir(path.dirname(bundlePath), { recursive: true });
		const result = await this.run(repo, ['bundle', 'create', bundlePath, '--all'], null, cancellation);
		if (result.code !== 0 || cancellation.isCancellationRequested) {
			await fs.promises.unlink(bundlePath).catch(() => { });
			if (cancellation.isCancellationRequested) throw new HistoryRewriteCancelledError();
			throw new Error(result.stderr || 'Unable to create the backup.');
		}
	}

	/**
	 * Remove files from the history of every branch & tag of a repository. The repository is only changed once the whole history has
	 * been rewritten: if it fails or is cancelled before that, nothing has changed.
	 * @param repo The path of the repository.
	 * @param preview What removing the files would do (from `preview`, without any blockers).
	 * @param keepWorkingFiles TRUE => The files stay in the working directory (as untracked files), FALSE => They're deleted from it.
	 * @param onProgress A callback invoked with the number of commits that have been processed.
	 * @param cancellation Cancels the removal.
	 * @returns What was done.
	 */
	public async removeFromHistory(repo: string, preview: HistoryRemovalPreview, keepWorkingFiles: boolean, onProgress: (commits: number) => void, cancellation: CancellationRequest): Promise<Omit<HistoryRemovalResult, 'backupPath'>> {
		if (preview.blockers.length > 0) throw new Error('The files can\'t be removed from the history of the repository in its current state.');
		const before = await this.getRefs(repo);

		const exportArgs = (await this.getExportArgs(repo)).args;
		const importArgs = ['-c', 'core.ignorecase=false', 'fast-import', '--force', '--quiet'];
		const version = this.git.getGitVersion();
		if (version !== null && isVersionAtLeast(version, 2, 28)) importArgs.push('--date-format=raw-permissive');

		const stats = await this.filterHistory(repo, preview, exportArgs, importArgs, onProgress, cancellation);

		// The index still contains the files, so it's reset to the rewritten commit that's checked out
		const head = await this.run(repo, ['rev-parse', '-q', '--verify', 'HEAD']);
		if (head.code === 0) {
			const reset = await this.run(repo, ['reset', '--quiet'].concat(keepWorkingFiles ? [] : ['--hard']));
			if (reset.code !== 0) throw new Error('The history was rewritten, but the working directory couldn\'t be updated: ' + reset.stderr);
		}

		const after = await this.getRefs(repo);
		const changed = Object.keys(before).filter((ref) => typeof after[ref] === 'string' && after[ref] !== before[ref]);
		return {
			stats: stats,
			rewrittenBranches: changed.filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.substring(11)),
			rewrittenTags: changed.filter((ref) => ref.startsWith('refs/tags/')).map((ref) => ref.substring(10)),
			deletedRefs: Object.keys(before).filter((ref) => typeof after[ref] === 'undefined')
		};
	}

	/**
	 * Write the history of the branches & tags of a repository with `git fast-export`, filter it, and recreate it with `git fast-import`.
	 * @returns What the filter did.
	 */
	private filterHistory(repo: string, preview: HistoryRemovalPreview, exportArgs: string[], importArgs: string[], onProgress: (commits: number) => void, cancellation: CancellationRequest) {
		return new Promise<FastExportFilterStats>((resolve, reject) => {
			const filter = new FastExportFilter(preview.paths, preview.zeroOid, onProgress);
			let exporter: cp.ChildProcess, importer: cp.ChildProcess;
			try {
				exporter = this.git.spawnGitProcess(exportArgs, repo, { FAST_EXPORT_SIGNED_COMMITS_NOABORT: '1' });
				importer = this.git.spawnGitProcess(importArgs, repo);
			} catch (error) {
				return reject(error);
			}

			// Once the whole filtered stream has been written, fast-import updates the references, which can no longer be cancelled
			let settled = false, written = false, exportEnded = false, exportCode: number | null | undefined = undefined, exportError = '', importError = '';
			const cancelListener = cancellation.onCancellationRequested(() => {
				if (!written) fail(new HistoryRewriteCancelledError());
			});
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cancelListener.dispose();
				exporter.kill();
				importer.kill();
				reject(error);
			};
			const write = (buffers: Buffer[]) => {
				let flushed = true;
				buffers.forEach((buffer) => flushed = importer.stdin!.write(buffer) && flushed);
				if (!flushed) {
					// fast-import is slower than fast-export, so fast-export is paused until it catches up
					exporter.stdout!.pause();
					importer.stdin!.once('drain', () => exporter.stdout!.resume());
				}
			};
			const finishExport = () => {
				if (settled || written || !exportEnded || typeof exportCode === 'undefined') return;
				if (exportCode !== 0) return fail(new Error(exportError.trim() || 'git fast-export failed.'));
				try {
					const output = filter.end();
					if (cancellation.isCancellationRequested) return fail(new HistoryRewriteCancelledError());
					written = true;
					write(output);
					importer.stdin!.end();
				} catch (error) {
					fail(toError(error));
				}
			};

			exporter.stderr!.on('data', (data) => exportError += data);
			importer.stderr!.on('data', (data) => importError += data);
			importer.stdin!.on('error', () => { }); // If fast-import exits early, it's reported when it closes
			exporter.stdout!.on('data', (chunk: Buffer) => {
				if (settled) return;
				try {
					write(filter.push(chunk));
				} catch (error) {
					fail(toError(error));
				}
			});
			exporter.stdout!.on('end', () => {
				exportEnded = true;
				finishExport();
			});
			exporter.on('exit', (code) => {
				exportCode = code;
				finishExport();
			});
			exporter.on('error', (error) => fail(error));
			importer.on('error', (error) => fail(error));
			importer.on('close', (code) => {
				if (settled) return;
				if (code === 0 && written) {
					settled = true;
					cancelListener.dispose();
					resolve(filter.stats);
				} else {
					fail(new Error(importError.trim() || 'git fast-import failed (exit code ' + code + ').'));
				}
			});
		});
	}


	/* Restoring & Cleaning Up */

	/**
	 * Restore the branches & tags of a repository from a bundle created by `createBackup` (and check out the restored commit).
	 * @param repo The path of the repository.
	 * @param bundlePath The path of the bundle.
	 */
	public async restoreBackup(repo: string, bundlePath: string) {
		const status = await this.run(repo, ['status', '--porcelain', '--untracked-files=no']);
		if (status.code !== 0 || status.stdout.length > 0) throw new Error(UNCOMMITTED_CHANGES_ERROR);
		const fetch = await this.run(repo, ['fetch', '--force', '--update-head-ok', '--no-tags', bundlePath, '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*']);
		if (fetch.code !== 0) throw new Error(fetch.stderr || 'Unable to read the backup.');
		const reset = await this.run(repo, ['reset', '--hard', '--quiet']);
		if (reset.code !== 0) throw new Error(reset.stderr);
	}

	/**
	 * Find what still refers to files that were removed from the history of a repository.
	 * @param repo The path of the repository.
	 * @param paths The paths that were removed.
	 * @param blobs The object ids of the versions of the files.
	 * @returns The references whose history still contains the files, and how many versions of the files are still stored.
	 */
	public async getLeftovers(repo: string, paths: ReadonlyArray<string>, blobs: ReadonlyArray<string>): Promise<HistoryRemovalLeftovers> {
		const containing = await this.getRefsContaining(repo, paths, ['--all'], []);
		const refs = containing !== null ? containing.filter((ref) => ref !== 'refs/stash').concat(await this.getStashesContaining(repo, paths)) : null;
		let remaining = 0;
		if (blobs.length > 0) {
			const check = await this.run(repo, ['cat-file', '--batch-check=%(objecttype)'], blobs.join('\n') + '\n');
			remaining = check.stdout.toString().split('\n').filter((line) => line === 'blob').length;
		}
		return { refs: refs, blobsRemaining: remaining, blobsChecked: blobs.length };
	}

	/**
	 * Delete everything in a repository that isn't reachable from its references: the reflogs (which still refer to the previous
	 * history) are expired, and the unreachable objects are deleted. The stashes are kept (they're only stored in a reflog).
	 * @param repo The path of the repository.
	 * @param cancellation Cancels the clean-up.
	 */
	public async purge(repo: string, cancellation: CancellationRequest) {
		// Every reflog is expired, except the reflog of the stashes (the expiry is configured instead of given as an option, as an
		// option would also apply to it)
		const expire = await this.run(repo, [
			'-c', 'gc.reflogExpire=now', '-c', 'gc.reflogExpireUnreachable=now',
			'-c', 'gc.refs/stash.reflogExpire=never', '-c', 'gc.refs/stash.reflogExpireUnreachable=never',
			'reflog', 'expire', '--all'
		], null, cancellation);
		if (cancellation.isCancellationRequested) throw new HistoryRewriteCancelledError();
		if (expire.code !== 0) throw new Error(expire.stderr || 'Unable to expire the reflogs.');
		const gc = await this.run(repo, ['-c', 'gc.refs/stash.reflogExpire=never', '-c', 'gc.refs/stash.reflogExpireUnreachable=never', 'gc', '--prune=now', '--quiet'], null, cancellation);
		if (cancellation.isCancellationRequested) throw new HistoryRewriteCancelledError();
		if (gc.code !== 0) throw new Error(gc.stderr || 'Unable to delete the unreachable objects.');
	}


	/* Helpers */

	/**
	 * Get the arguments of `git fast-export` that write the history of every branch & tag, keeping the commits & tags that aren't
	 * affected exactly as they are (so that their hashes don't change). The options that the version of Git supports are used.
	 * @param repo The path of the repository.
	 * @returns The arguments, and whether the signatures of commits are written (FALSE => fast-export removes them from all commits).
	 */
	private async getExportArgs(repo: string) {
		const usage = await this.run(repo, ['fast-export', '-h']), supports = (option: string) => (usage.stdout.toString() + usage.stderr).includes(option);
		const args = ['fast-export', '--no-data', '--use-done-feature', '--signed-tags=verbatim'];
		if (supports('reencode')) args.push('--reencode=no');
		if (supports('mark-tags')) args.push('--mark-tags');
		const keepsCommitSignatures = supports('signed-commits');
		if (keepsCommitSignatures) args.push('--signed-commits=verbatim');
		args.push('--branches', '--tags');
		return { args: args, keepsCommitSignatures: keepsCommitSignatures };
	}

	/**
	 * Get the references whose history contains files.
	 * @param repo The path of the repository.
	 * @param paths The paths of the files.
	 * @param scope The arguments of `git rev-list` selecting the references whose history is searched.
	 * @param refPatterns The references that are returned (all references if empty).
	 * @returns The full names of the references, or NULL if they couldn't be determined.
	 */
	private async getRefsContaining(repo: string, paths: ReadonlyArray<string>, scope: string[], refPatterns: string[]) {
		// The commits that change the files, with their nearest ancestors that also change them. The commits without any are the first
		// commits that change the files: a reference contains the files if it contains one of them.
		const touching = await this.run(repo, ['--literal-pathspecs', 'rev-list'].concat(scope, ['--parents', '--'], paths));
		if (touching.code !== 0) return [];
		const firstCommits = touching.stdout.toString().split('\n').filter((line) => line !== '' && !line.includes(' '));
		if (firstCommits.length === 0) return [];
		if (firstCommits.length > MAX_CONTAINS_COMMITS) return null;
		const refs = await this.run(repo, ['for-each-ref', '--format=%(refname)'].concat(...firstCommits.map((hash) => ['--contains', hash]), refPatterns));
		return refs.code === 0 ? refs.stdout.toString().split('\n').filter((ref) => ref !== '' && !/^refs\/remotes\/.*\/HEAD$/.test(ref)) : null;
	}

	/**
	 * Get the stashes whose history contains files (stashes are based on a commit, so they contain everything in its history).
	 * @param repo The path of the repository.
	 * @param paths The paths of the files.
	 * @returns The selectors of the stashes (e.g. "stash@{0}").
	 */
	private async getStashesContaining(repo: string, paths: ReadonlyArray<string>) {
		const stashes = (await this.run(repo, ['stash', 'list', '--format=%H %gd'])).stdout.toString().split('\n').filter((line) => line !== '').map((line) => line.split(' '));
		const containing: string[] = [];
		for (const [hash, selector] of stashes) {
			const contains = await this.run(repo, ['--literal-pathspecs', 'rev-list', '-1', hash, '--'].concat(paths));
			if (contains.code !== 0 || contains.stdout.toString().trim() !== '') containing.push(selector);
		}
		return containing;
	}

	/**
	 * Get the commits (or tag objects) that the branches & tags of a repository refer to.
	 */
	private async getRefs(repo: string) {
		const refs: { [ref: string]: string } = {};
		const result = await this.run(repo, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags']);
		if (result.code !== 0) throw new Error(result.stderr);
		result.stdout.toString().split('\n').filter((line) => line !== '').forEach((line) => {
			const index = line.indexOf(' ');
			refs[line.substring(index + 1)] = line.substring(0, index);
		});
		return refs;
	}

	/**
	 * Run a Git command, resolving with its output once it has exited (also when it fails).
	 * @param repo The repository to run the command in.
	 * @param args The arguments to pass to Git.
	 * @param input Text written to the standard input of the command.
	 * @param cancellation Kills the command.
	 * @returns The exit code (-1 if it couldn't be run or was killed), and the output of the command.
	 */
	private run(repo: string, args: string[], input: string | null = null, cancellation: CancellationRequest | null = null) {
		return runGit(this.git, repo, args, input, cancellation);
	}
}

/**
 * Run a Git command, resolving with its output once it has exited (also when it fails).
 * @param git Runs Git.
 * @param repo The repository to run the command in.
 * @param args The arguments to pass to Git.
 * @param input Text written to the standard input of the command.
 * @param cancellation Kills the command.
 * @param env Additional environment variables.
 * @returns The exit code (-1 if it couldn't be run or was killed), and the output of the command.
 */
export function runGit(git: GitProcessRunner, repo: string, args: string[], input: string | null = null, cancellation: CancellationRequest | null = null, env?: { [name: string]: string }) {
	return new Promise<{ code: number, stdout: Buffer, stderr: string }>((resolve, reject) => {
		let child: cp.ChildProcess;
		try {
			child = git.spawnGitProcess(args, repo, env);
		} catch (error) {
			return reject(error);
		}
		const stdout: Buffer[] = [];
		let stderr = '', settled = false;
		const cancelListener = cancellation !== null ? cancellation.onCancellationRequested(() => child.kill()) : null;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (cancelListener !== null) cancelListener.dispose();
			resolve({ code: code, stdout: Buffer.concat(stdout), stderr: stderr.trim() });
		};
		child.stdout!.on('data', (data: Buffer) => stdout.push(data));
		child.stderr!.on('data', (data) => stderr += data);
		child.on('error', (error) => {
			stderr += error.message;
			finish(-1);
		});
		child.on('close', (code) => finish(code !== null ? code : -1));
		child.stdin!.on('error', () => { });
		child.stdin!.end(input !== null ? input : undefined);
	});
}

/**
 * Split output that's separated by NUL characters (and new lines between records) into its values.
 */
function splitNul(output: Buffer) {
	return output.toString('utf8').split('\0').map((value) => value.replace(/^\n+/, '')).filter((value) => value !== '');
}

/**
 * Is a version of Git at least a required version (a version that can't be parsed is assumed to be).
 */
function isVersionAtLeast(version: string, major: number, minor: number) {
	const match = /^\D*(\d+)\.(\d+)/.exec(version);
	if (match === null) return true;
	const actualMajor = parseInt(match[1]), actualMinor = parseInt(match[2]);
	return actualMajor > major || (actualMajor === major && actualMinor >= minor);
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}
