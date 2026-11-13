import { DataSource } from './dataSource';
import { t } from './l10n';
import { ErrorInfo, GitOperation, UndoInfo } from './types';

/**
 * The commit & branch that HEAD refers to.
 */
interface HeadState {
	readonly hash: string;
	readonly branch: string | null; // NULL => HEAD is detached
}

/**
 * How an action is undone.
 */
type UndoRecord = {
	readonly kind: 'head'; // The action moved HEAD (or the current branch), which is moved back
	readonly before: HeadState;
	readonly after: HeadState;
} | {
	readonly kind: 'createRef'; // The action created a branch or tag (and may have checked out the branch), which is deleted
	readonly ref: string;
	readonly value: string;
	readonly before: HeadState | null;
} | {
	readonly kind: 'deleteRef'; // The action deleted a branch or tag, which is restored (with the upstream of a branch)
	readonly ref: string;
	readonly value: string;
	readonly upstream: { readonly remote: string, readonly merge: string } | null;
} | {
	readonly kind: 'renameBranch'; // The action renamed a branch, which is renamed back
	readonly oldName: string;
	readonly newName: string;
	readonly value: string;
} | {
	readonly kind: 'dropStash'; // The action dropped a stash, which is stored again
	readonly hash: string;
	readonly message: string;
};

/**
 * Remembers the last action run by Git Map in each repository that can be undone, and undoes it. An action can only be undone if the
 * repository hasn't been changed since (by something else), and undoing never discards uncommitted changes (`git reset --keep` is used
 * to move the current branch back, which is refused by Git if it would).
 */
export class UndoManager {
	private readonly dataSource: DataSource;
	private readonly records: { [repo: string]: UndoRecord & { readonly id: number, readonly description: string } } = {};
	private nextId: number = 1;

	/**
	 * Creates the Undo Manager.
	 * @param dataSource The Git Map DataSource.
	 */
	constructor(dataSource: DataSource) {
		this.dataSource = dataSource;
	}

	/**
	 * Get the action in a repository that can be undone.
	 * @param repo The path of the repository.
	 * @returns The action, or NULL if no action can be undone.
	 */
	public getUndo(repo: string): UndoInfo | null {
		const record = this.records[repo];
		return typeof record !== 'undefined' ? { id: record.id, description: record.description } : null;
	}

	/**
	 * Forget the action in a repository that can be undone (e.g. when its history is rewritten, as the commits it refers to are replaced).
	 * @param repo The path of the repository.
	 */
	public clear(repo: string) {
		delete this.records[repo];
	}


	/* Tracking Actions */

	/**
	 * Run an action that moves HEAD or the current branch (e.g. merge, rebase, cherry pick, revert, reset, pull or checkout), so that it
	 * can be undone.
	 * @param repo The path of the repository.
	 * @param description The description of the action.
	 * @param action The action.
	 * @param succeeded Did the action succeed (with the value it resolved to).
	 * @returns The value the action resolved to.
	 */
	public async trackHead<T>(repo: string, description: string, action: () => Promise<T>, succeeded: (value: T) => boolean): Promise<T> {
		delete this.records[repo];
		const before = await this.getHeadState(repo);
		const value = await action();
		if (before !== null && succeeded(value)) {
			const after = await this.getHeadState(repo);
			if (after !== null && (after.hash !== before.hash || after.branch !== before.branch)) {
				this.record(repo, description, { kind: 'head', before: before, after: after });
			}
		}
		return value;
	}

	/**
	 * Run an action that creates a branch or tag (and may check out the branch), so that it can be undone.
	 * @param repo The path of the repository.
	 * @param description The description of the action.
	 * @param ref The full name of the reference that's created (e.g. `refs/heads/name`).
	 * @param action The action.
	 * @param succeeded Did the action succeed (with the value it resolved to).
	 * @returns The value the action resolved to.
	 */
	public async trackCreateRef<T>(repo: string, description: string, ref: string, action: () => Promise<T>, succeeded: (value: T) => boolean): Promise<T> {
		delete this.records[repo];
		const before = await this.getHeadState(repo), existed = await this.getRefValue(repo, ref) !== null;
		const value = await action();
		if (!existed && succeeded(value)) {
			const created = await this.getRefValue(repo, ref);
			if (created !== null) this.record(repo, description, { kind: 'createRef', ref: ref, value: created, before: before });
		}
		return value;
	}

	/**
	 * Run an action that deletes a branch or tag, so that it can be undone (only the local branch or tag is restored).
	 * @param repo The path of the repository.
	 * @param description The description of the action.
	 * @param ref The full name of the reference that's deleted (e.g. `refs/tags/name`).
	 * @param action The action.
	 * @param succeeded Did the action succeed (with the value it resolved to).
	 * @returns The value the action resolved to.
	 */
	public async trackDeleteRef<T>(repo: string, description: string, ref: string, action: () => Promise<T>, succeeded: (value: T) => boolean): Promise<T> {
		delete this.records[repo];
		const deleted = await this.getRefValue(repo, ref);
		const branch = ref.startsWith('refs/heads/') ? ref.substring(11) : null;
		const remote = branch !== null ? await this.getConfigValue(repo, 'branch.' + branch + '.remote') : null;
		const merge = branch !== null ? await this.getConfigValue(repo, 'branch.' + branch + '.merge') : null;
		const value = await action();
		if (deleted !== null && succeeded(value) && await this.getRefValue(repo, ref) === null) {
			this.record(repo, description, { kind: 'deleteRef', ref: ref, value: deleted, upstream: remote !== null && merge !== null ? { remote: remote, merge: merge } : null });
		}
		return value;
	}

	/**
	 * Run an action that renames a branch, so that it can be undone.
	 * @param repo The path of the repository.
	 * @param description The description of the action.
	 * @param oldName The name of the branch.
	 * @param newName The new name of the branch.
	 * @param action The action.
	 * @returns The ErrorInfo of the action.
	 */
	public async trackRenameBranch(repo: string, description: string, oldName: string, newName: string, action: () => Promise<ErrorInfo>): Promise<ErrorInfo> {
		delete this.records[repo];
		const error = await action();
		const value = error === null ? await this.getRefValue(repo, 'refs/heads/' + newName) : null;
		if (value !== null) this.record(repo, description, { kind: 'renameBranch', oldName: oldName, newName: newName, value: value });
		return error;
	}

	/**
	 * Run an action that drops a stash, so that it can be undone.
	 * @param repo The path of the repository.
	 * @param description The description of the action.
	 * @param selector The selector of the stash (e.g. `refs/stash@{0}`).
	 * @param action The action.
	 * @returns The ErrorInfo of the action.
	 */
	public async trackDropStash(repo: string, description: string, selector: string, action: () => Promise<ErrorInfo>): Promise<ErrorInfo> {
		delete this.records[repo];
		const hash = await this.getRefValue(repo, selector);
		const message = hash !== null ? await this.git(repo, ['log', '-1', '--format=%s', hash]) : null;
		const error = await action();
		if (error === null && hash !== null && message !== null) this.record(repo, description, { kind: 'dropStash', hash: hash, message: message.trim() });
		return error;
	}

	/**
	 * Record an action that can be undone (replacing the action that could previously be undone in the repository).
	 */
	private record(repo: string, description: string, record: UndoRecord) {
		this.records[repo] = Object.assign({ id: this.nextId++, description: description }, record);
	}


	/* Undoing Actions */

	/**
	 * Undo the last action in a repository.
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo of undoing the action (an error if it can't be undone).
	 */
	public async undo(repo: string): Promise<ErrorInfo> {
		const record = this.records[repo];
		if (typeof record === 'undefined') return t('There is no action to undo.');
		const inProgress = await this.getOperationInProgress(repo);
		if (inProgress !== null) return t('Unable to undo {0}, as {1} is in progress. Finish or abort it first.', record.description, inProgress);
		const changed = t('Unable to undo {0}, as the repository has changed since.', record.description);

		let error: ErrorInfo;
		switch (record.kind) {
			case 'head': {
				const head = await this.getHeadState(repo);
				if (head === null || head.hash !== record.after.hash || head.branch !== record.after.branch) return changed;
				error = record.after.branch === record.before.branch
					? await this.run(repo, ['reset', '--keep', record.before.hash]) // Moves the current branch back, keeping uncommitted changes
					: await this.run(repo, record.before.branch !== null ? ['checkout', record.before.branch] : ['checkout', '--detach', record.before.hash]);
				break;
			}
			case 'createRef': {
				if (await this.getRefValue(repo, record.ref) !== record.value) return changed;
				const head = await this.getHeadState(repo);
				error = null;
				if (head !== null && head.branch !== null && 'refs/heads/' + head.branch === record.ref) {
					// The branch is checked out, so the previously checked out branch (or commit) is checked out first
					if (record.before === null) return changed;
					error = await this.run(repo, record.before.branch !== null ? ['checkout', record.before.branch] : ['checkout', '--detach', record.before.hash]);
				}
				if (error === null) error = await this.run(repo, ['update-ref', '-d', record.ref, record.value]);
				break;
			}
			case 'deleteRef':
				if (await this.getRefValue(repo, record.ref) !== null) return changed;
				error = await this.run(repo, ['update-ref', record.ref, record.value, '']);
				if (error === null && record.upstream !== null) {
					const branch = record.ref.substring(11);
					error = await this.run(repo, ['config', 'branch.' + branch + '.remote', record.upstream.remote]);
					if (error === null) error = await this.run(repo, ['config', 'branch.' + branch + '.merge', record.upstream.merge]);
				}
				break;
			case 'renameBranch':
				if (await this.getRefValue(repo, 'refs/heads/' + record.newName) !== record.value || await this.getRefValue(repo, 'refs/heads/' + record.oldName) !== null) return changed;
				error = await this.run(repo, ['branch', '-m', record.newName, record.oldName]);
				break;
			default:
				error = await this.run(repo, ['stash', 'store', '-m', record.message, record.hash]);
		}
		if (error === null) delete this.records[repo];
		return error;
	}


	/* Repository State */

	/**
	 * Get the commit & branch that HEAD refers to.
	 * @param repo The path of the repository.
	 * @returns The state, or NULL if it couldn't be determined (e.g. the repository doesn't have any commits).
	 */
	private async getHeadState(repo: string): Promise<HeadState | null> {
		const hash = await this.getRefValue(repo, 'HEAD');
		if (hash === null) return null;
		const branch = await this.git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
		return { hash: hash, branch: branch !== null && branch.trim() !== '' ? branch.trim() : null };
	}

	/**
	 * Get the object a reference points to (for an annotated tag, its tag object).
	 * @param repo The path of the repository.
	 * @param ref The reference.
	 * @returns The hash of the object, or NULL if the reference doesn't exist.
	 */
	private async getRefValue(repo: string, ref: string) {
		const value = await this.git(repo, ['rev-parse', '-q', '--verify', ref]);
		return value !== null && /^[0-9a-f]{40,64}$/.test(value.trim()) ? value.trim() : null;
	}

	/**
	 * Get the value of a Git config variable of a repository.
	 */
	private async getConfigValue(repo: string, key: string) {
		const value = await this.git(repo, ['config', '--get', key]);
		return value !== null && value.trim() !== '' ? value.trim() : null;
	}

	/**
	 * Get the operation that's in progress in a repository (which must be finished or aborted before an action is undone).
	 * @param repo The path of the repository.
	 * @returns A description of the operation, or NULL if no operation is in progress.
	 */
	private async getOperationInProgress(repo: string) {
		let operation: GitOperation | null = null;
		try {
			operation = await this.dataSource.getOperationInProgress(repo);
		} catch (_) { }
		switch (operation) {
			case 'merge':
				return t('a merge');
			case 'cherry-pick':
				return t('a cherry pick');
			case 'revert':
				return t('a revert');
			case 'rebase':
				return t('a rebase');
			default:
				return null;
		}
	}

	/**
	 * Run a Git command, resolving with its output.
	 * @returns The output, or NULL if the command failed.
	 */
	private async git(repo: string, args: string[]) {
		try {
			const output = await this.dataSource.execGit(args, repo);
			return typeof output === 'string' ? output : null;
		} catch (_) {
			return null;
		}
	}

	/**
	 * Run a Git command that changes a repository.
	 * @returns The ErrorInfo of the command.
	 */
	private async run(repo: string, args: string[]): Promise<ErrorInfo> {
		try {
			await this.dataSource.execGit(args, repo);
			return null;
		} catch (error) {
			return typeof error === 'string' ? error : String(error);
		}
	}
}

/**
 * The Undo Manager of each DataSource (shared by everything that uses the DataSource, so that an action can still be undone after the
 * Git Map View is reopened).
 */
const undoManagers = new WeakMap<DataSource, UndoManager>();

/**
 * Get the Undo Manager of a DataSource (creating it if required).
 * @param dataSource The DataSource.
 * @returns The Undo Manager.
 */
export function getUndoManager(dataSource: DataSource) {
	let undoManager = undoManagers.get(dataSource);
	if (typeof undoManager === 'undefined') {
		undoManager = new UndoManager(dataSource);
		undoManagers.set(dataSource, undoManager);
	}
	return undoManager;
}
