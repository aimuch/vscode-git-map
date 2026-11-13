import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { HistoryRemovalBlocker, HistoryRemovalPreview, HistoryRemovalResult, HistoryRewriteCancelledError, HistoryRewriter, UNCOMMITTED_CHANGES_ERROR } from './historyRewrite';
import { t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { getUndoManager } from './undoManager';
import { getPathFromStr, getPathFromUri, getRepoName, resolveToSymbolicPath, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

/**
 * A removal of files from the history of a repository that was run by Git Map (remembered to clean up after it, and to restore its backup).
 */
interface HistoryRemovalRecord {
	readonly repo: string;
	readonly date: number;
	readonly paths: ReadonlyArray<string>;
	readonly blobs: ReadonlyArray<string>; // The object ids of the versions of the files (to check that they're no longer stored)
	readonly backup: string | null; // The path of the bundle containing the history as it was before
}

const RECORDS_KEY = 'historyRemovals';
const MAX_RECORDED_BLOBS = 5000;
const MAX_PATHS_IN_QUICK_PICK = 30000;
const MAX_NAMES_LISTED = 12;

/**
 * Removes files from the whole history of a repository ("Remove Files from History..."), as if they had never been committed: for
 * files that should never have been committed (e.g. large files, generated files, or files containing passwords & keys). Only the
 * history is changed: by default the files themselves stay in the working directory, where they become untracked files (they're only
 * deleted from it as well if that's chosen).
 *
 * As this rewrites every branch & tag that contains the files, it's only run after showing what it will do, and after the name of the
 * repository has been typed to confirm it. A backup (a Git bundle) is created first, which "Restore History from Backup" restores.
 * Nothing is ever pushed: the steps that follow (force-pushing, and "Clean Up after Removing Files from History") are explained in a
 * document that's shown once the files have been removed.
 */
export class RemoveFromHistory extends Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly rewriter: HistoryRewriter;
	private running: boolean = false;

	/**
	 * Creates the Remove From History commands.
	 * @param context The context of the extension.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(context: vscode.ExtensionContext, dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.context = context;
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.rewriter = new HistoryRewriter(dataSource);
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.removeFilesFromHistory', (...args: any[]) => this.exclusively(() => this.remove(args), t('Unable to Remove Files from History: {0}'))),
			vscode.commands.registerCommand('git-map.cleanUpRemovedFiles', () => this.exclusively(() => this.cleanUp(), t('Unable to Clean Up after Removing Files from History: {0}'))),
			vscode.commands.registerCommand('git-map.restoreHistoryBackup', () => this.exclusively(() => this.restore(), t('Unable to Restore History from Backup: {0}')))
		);
	}

	/**
	 * Run one of the commands, unless one of them is already running (they change the whole repository). Errors are shown.
	 * @param command The command.
	 * @param errorMessage The message shown if the command fails ({0} is the reason).
	 */
	private async exclusively(command: () => Promise<void>, errorMessage: string) {
		if (this.running) {
			showErrorMessage(t('Git Map is already removing files from the history, cleaning up after it, or restoring a backup.'));
			return;
		}
		this.running = true;
		try {
			await command();
		} catch (error) {
			if (error instanceof HistoryRewriteCancelledError) {
				showInformationMessage(t('Cancelled: the history of the repository wasn\'t changed.'));
			} else {
				const reason = error instanceof Error ? error.message : String(error);
				// The reason is substituted by a function, so that "$" in it isn't treated as a replacement pattern
				this.logger.logError(errorMessage.replace('{0}', () => reason));
				showErrorMessage(errorMessage.replace('{0}', () => reason === UNCOMMITTED_CHANGES_ERROR ? t('There are uncommitted changes. Commit or discard them first.') : reason));
			}
		} finally {
			this.running = false;
		}
	}


	/* Remove Files from History */

	/**
	 * The method run when the `git-map.removeFilesFromHistory` command is invoked.
	 * @param args The files selected in the Explorer (the file that was clicked on, and all of the selected files), the repository &
	 * paths chosen in the Git Map View, or nothing (the repository & files are then asked for).
	 */
	private async remove(args: any[]) {
		const target = await this.getTarget(args);
		if (target === null) return;
		const repo = target.repo, name = this.getName(repo);

		const preview = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Checking the history of {0}...', name) }, () => this.rewriter.preview(repo, target.paths));
		if (preview.blockers.length > 0) {
			await vscode.window.showErrorMessage(t('The files can\'t be removed from the history of {0} yet.', name), { modal: true, detail: preview.blockers.map((blocker) => '\u2022 ' + describeBlocker(blocker)).join('\n') });
			return;
		}

		// By default the files in the working directory aren't deleted (the first option): they become untracked files, which can
		// also be ignored. They're only deleted from the working directory as well if that's chosen.
		let keepWorkingFiles = true, ignore = false;
		if (preview.pathsInHead.length > 0) {
			const options: (vscode.QuickPickItem & { keep: boolean, ignore: boolean })[] = [
				{ label: t('Keep them as untracked files'), description: t('Default'), detail: t('They stay in the working directory, and can be committed again.'), keep: true, ignore: false },
				{ label: t('Keep them, and add them to .gitignore'), detail: t('They stay in the working directory, and Git ignores them from now on.'), keep: true, ignore: true },
				{ label: t('Delete them from the working directory too'), detail: t('The files themselves are deleted as well. They only remain in the backup, if one is created.'), keep: false, ignore: false }
			];
			const option = await vscode.window.showQuickPick(options, { placeHolder: t('Only the history of {0} is removed. What should happen to the files in the working directory?', listNames(preview.pathsInHead)), ignoreFocusOut: true });
			if (typeof option === 'undefined') return;
			keepWorkingFiles = option.keep;
			ignore = option.ignore;
		}

		// What it will do is shown, and the name of the repository must be typed to confirm it
		const backUp = t('Back Up & Remove'), noBackUp = t('Remove Without a Backup');
		const subject = preview.paths.length === 1 ? preview.paths[0] : t('{0} files & folders', preview.paths.length);
		const choice = await vscode.window.showWarningMessage(t('Remove {0} from the whole history of {1}?', subject, name), { modal: true, detail: describePreview(preview, keepWorkingFiles) }, backUp, noBackUp);
		if (choice !== backUp && choice !== noBackUp) return;
		const typed = await vscode.window.showInputBox({
			title: t('Remove {0} from the whole history of {1}?', subject, name),
			prompt: t('This rewrites the history of the repository. Type its name ({0}) to confirm.', name),
			placeHolder: name,
			ignoreFocusOut: true,
			validateInput: (value) => value === name ? null : t('Type {0} to confirm, or press Escape to cancel.', name)
		});
		if (typed !== name) return;

		const backupPath = choice === backUp ? this.getBackupPath(repo) : null;
		let result: HistoryRemovalResult;
		try {
			result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Removing files from the history of {0}', name), cancellable: true }, async (progress, token) => {
				if (backupPath !== null) {
					progress.report({ message: t('Creating a backup...') });
					await this.rewriter.createBackup(repo, backupPath, token);
				}
				progress.report({ message: t('Rewriting {0} commits...', preview.totalCommits) });
				let percentage = 0;
				const removal = await this.rewriter.removeFromHistory(repo, preview, keepWorkingFiles, (commits) => {
					const reached = preview.totalCommits > 0 ? Math.min(99, Math.floor(commits * 100 / preview.totalCommits)) : 0;
					if (reached > percentage) {
						progress.report({ increment: reached - percentage, message: t('Rewriting {0} commits...', preview.totalCommits) });
						percentage = reached;
					}
				}, token);
				return Object.assign({ backupPath: backupPath }, removal);
			});
		} catch (error) {
			// The repository wasn't changed, so the backup isn't needed
			if (backupPath !== null) await fs.promises.unlink(backupPath).catch(() => { });
			throw error;
		}

		getUndoManager(this.dataSource).clear(repo);
		await this.saveRecords(this.getRecords().concat([{ repo: repo, date: Date.now(), paths: preview.paths, blobs: preview.blobs.slice(0, MAX_RECORDED_BLOBS), backup: backupPath }]));
		this.logger.log('Removed ' + preview.paths.join(', ') + ' from the history of ' + repo + ' (' + result.stats.commitsRewritten + ' commits rewritten, ' + result.stats.commitsRemoved + ' removed)');

		let ignoreError: string | null = null;
		if (ignore) {
			ignoreError = await addToGitignore(repo, preview.pathsInHead).then(() => null, (error) => String(error));
		}
		const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: describeResult(name, preview, result) });
		await vscode.window.showTextDocument(document, { preview: false });
		showInformationMessage(t('The files were removed from the history of {0}. The steps that follow are in the document that was opened.', name));
		if (ignoreError !== null) showErrorMessage(t('Unable to add the files to .gitignore: {0}', ignoreError));
	}

	/**
	 * Get the repository & paths that the `git-map.removeFilesFromHistory` command was invoked for.
	 * @param args The arguments of the command.
	 * @returns The repository & paths (relative to the repository), or NULL if the command was cancelled.
	 */
	private async getTarget(args: any[]): Promise<{ repo: string, paths: string[] } | null> {
		const first = args.length > 0 ? args[0] : undefined;
		if (first instanceof vscode.Uri) {
			// The files & folders selected in the Explorer
			const uris: vscode.Uri[] = Array.isArray(args[1]) && args[1].length > 0 && args[1].every((uri: any) => uri instanceof vscode.Uri) ? args[1] : [first];
			let repo: string | null = null;
			const paths: string[] = [];
			for (const uri of uris) {
				const file = uri.scheme === 'file' ? await this.getRepoOfFile(uri) : null;
				if (file === null) throw new Error(t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(uri)));
				if (file.path === '') throw new Error(t('Select files or folders in the repository, not the repository itself.'));
				if (repo !== null && repo !== file.repo) throw new Error(t('The selected files are in more than one repository.'));
				repo = file.repo;
				paths.push(file.path);
			}
			return repo !== null ? { repo: repo, paths: paths } : null;
		}
		if (typeof first === 'object' && first !== null && typeof first.repo === 'string' && Array.isArray(first.paths) && first.paths.length > 0 && first.paths.every((filePath: any) => typeof filePath === 'string')) {
			// The files chosen in the Git Map View
			if (typeof this.repoManager.getRepos()[first.repo] === 'undefined') throw new Error(t('The repository "{0}" is not known to Git Map.', first.repo));
			return { repo: first.repo, paths: first.paths };
		}

		const repo = await this.pickRepo(t('Select the repository to remove files from the history of:'));
		if (repo === null) return null;
		const files = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Loading the files in the history of {0}...', this.getName(repo)) }, () => this.rewriter.getPathsInHistory(repo));
		if (files.length === 0) throw new Error(t('The branches & tags of the repository don\'t have any commits.'));
		if (files.length > MAX_PATHS_IN_QUICK_PICK) {
			const typed = await vscode.window.showInputBox({ prompt: t('The path of the file or folder to remove from the history (relative to the root of the repository)'), placeHolder: 'path/to/file', ignoreFocusOut: true });
			return typeof typed === 'string' && typed.trim() !== '' ? { repo: repo, paths: [typed.trim()] } : null;
		}
		const selected = await vscode.window.showQuickPick(files.map((file) => ({ label: file.path, description: file.inHead ? undefined : t('No longer in the working directory') })), {
			placeHolder: t('Select the files to remove from the whole history of {0} (including files that have since been deleted)', this.getName(repo)),
			canPickMany: true,
			matchOnDescription: true,
			ignoreFocusOut: true
		});
		return typeof selected !== 'undefined' && selected.length > 0 ? { repo: repo, paths: selected.map((item) => item.label) } : null;
	}


	/* Clean Up after Removing Files from History */

	/**
	 * The method run when the `git-map.cleanUpRemovedFiles` command is invoked: delete the previous history (which still contains the
	 * removed files) from a repository, and optionally the backups.
	 */
	private async cleanUp() {
		const records = this.getRecords().filter((record) => typeof this.repoManager.getRepos()[record.repo] !== 'undefined');
		if (records.length === 0) throw new Error(t('Git Map hasn\'t removed files from the history of a repository in this workspace.'));
		const repo = await this.pickRepo(t('Select the repository to clean up:'), Array.from(new Set(records.map((record) => record.repo))));
		if (repo === null) return;
		const name = this.getName(repo), repoRecords = records.filter((record) => record.repo === repo);
		const paths = Array.from(new Set(repoRecords.flatMap((record) => record.paths))), blobs = Array.from(new Set(repoRecords.flatMap((record) => record.blobs)));
		const backups = repoRecords.map((record) => record.backup).filter((backup): backup is string => backup !== null && fs.existsSync(backup));

		const before = await this.rewriter.getLeftovers(repo, paths, blobs);
		const details = [t('The reflogs of the repository are expired, and the objects that nothing refers to are deleted (stashes are kept). After this, the previous history can only be restored from a backup.')];
		if (before.refs === null || before.refs.length > 0) {
			details.push(t('These still contain the removed files, so the files stay in the repository until they\'re updated (push the rewritten branches, then fetch) or deleted: {0}', before.refs !== null ? listNames(before.refs.map(shortenRef)) : '?'));
		}
		if (backups.length > 0) details.push(t('The backup still contains the removed files: {0}', backups.join(', ')));
		const cleanUp = t('Clean Up'), cleanUpAndDelete = t('Clean Up & Delete the Backup');
		const choice = await vscode.window.showWarningMessage(t('Delete the previous history from {0}?', name), { modal: true, detail: details.join('\n\n') }, ...(backups.length > 0 ? [cleanUp, cleanUpAndDelete] : [cleanUp]));
		if (choice !== cleanUp && choice !== cleanUpAndDelete) return;

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Deleting the previous history from {0}...', name), cancellable: true }, (_, token) => this.rewriter.purge(repo, token).catch((error) => {
			// Cancelling leaves the branches & tags as they are, but the clean-up is incomplete
			throw error instanceof HistoryRewriteCancelledError ? new Error(t('It was cancelled before it finished. Run it again to finish cleaning up.')) : error;
		}));
		if (choice === cleanUpAndDelete) {
			await Promise.all(backups.map((backup) => fs.promises.unlink(backup).catch(() => { })));
		}

		const after = await this.rewriter.getLeftovers(repo, paths, blobs);
		const backupsLeft = choice === cleanUpAndDelete ? [] : backups;
		// The removals are remembered while something still contains the files (so that this command can be run again)
		const others = this.getRecords().filter((record) => record.repo !== repo);
		await this.saveRecords(after.blobsRemaining === 0 && backupsLeft.length === 0 ? others : others.concat(repoRecords.map((record) => Object.assign({}, record, { backup: record.backup !== null && backupsLeft.includes(record.backup) ? record.backup : null }))));
		if (after.blobsRemaining === 0) {
			showInformationMessage(backupsLeft.length > 0
				? t('The previous history was deleted from {0}: the removed files are only in the backup now.', name)
				: t('The previous history was deleted from {0}: the removed files are no longer stored in the repository.', name));
		} else {
			vscode.window.showWarningMessage(t('{0} of {1} versions of the removed files are still stored in {2}, as these still contain them: {3}', after.blobsRemaining, after.blobsChecked, name, after.refs !== null && after.refs.length > 0 ? listNames(after.refs.map(shortenRef)) : '?')).then(() => { }, () => { });
		}
	}


	/* Restore History from Backup */

	/**
	 * The method run when the `git-map.restoreHistoryBackup` command is invoked: restore the branches & tags of a repository from a
	 * backup created before files were removed from its history.
	 */
	private async restore() {
		const records = this.getRecords().filter((record) => typeof this.repoManager.getRepos()[record.repo] !== 'undefined' && record.backup !== null && fs.existsSync(record.backup));
		if (records.length === 0) throw new Error(t('There aren\'t any backups of the repositories in this workspace.'));
		const items = records.sort((a, b) => b.date - a.date).map((record) => ({
			label: this.getName(record.repo) + ': ' + new Date(record.date).toLocaleString(),
			description: t('Before removing {0}', listNames(record.paths)),
			detail: record.backup!,
			record: record
		}));
		const item = await vscode.window.showQuickPick(items, { placeHolder: t('Select the backup to restore:'), ignoreFocusOut: true });
		if (typeof item === 'undefined') return;
		const record = item.record, name = this.getName(record.repo), restore = t('Restore');
		const choice = await vscode.window.showWarningMessage(t('Restore the history of {0} from the backup of {1}?', name, new Date(record.date).toLocaleString()), {
			modal: true,
			detail: t('Every branch & tag in the backup is reset to what it referred to then (commits made since are no longer on them), and the working directory is reset to the branch that\'s checked out. Branches & tags created since are kept. The removed files will be in the history again.')
		}, restore);
		if (choice !== restore) return;

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Restoring the history of {0}...', name) }, () => this.rewriter.restoreBackup(record.repo, record.backup!));
		getUndoManager(this.dataSource).clear(record.repo);
		showInformationMessage(t('The history of {0} was restored from the backup. The backup was kept: {1}', name, record.backup!));
	}


	/* Helpers */

	/**
	 * Get the removals of files from the history that Git Map remembers.
	 */
	private getRecords() {
		return this.context.globalState.get<HistoryRemovalRecord[]>(RECORDS_KEY, []);
	}

	/**
	 * Save the removals of files from the history that Git Map remembers.
	 */
	private saveRecords(records: HistoryRemovalRecord[]) {
		return this.context.globalState.update(RECORDS_KEY, records).then(() => { }, () => { });
	}

	/**
	 * Get the path of a new backup of a repository (in the global storage of the extension, so it's never inside the repository).
	 */
	private getBackupPath(repo: string) {
		const date = new Date(), pad = (value: number) => (value < 10 ? '0' : '') + value;
		const timestamp = date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' + pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
		return path.join(this.context.globalStorageUri.fsPath, 'history-backups', getRepoName(repo).replace(/[^A-Za-z0-9._-]/g, '_') + '-' + timestamp + '.bundle');
	}

	/**
	 * Get the name of a repository that's shown (and typed to confirm the removal of files).
	 */
	private getName(repo: string) {
		const state = this.repoManager.getRepos()[repo];
		return typeof state !== 'undefined' && typeof state.name === 'string' && state.name !== '' ? state.name : getRepoName(repo);
	}

	/**
	 * Ask which repository a command is run in (the repository is used if there's only one).
	 * @param placeHolder The question.
	 * @param repos The repositories to choose from (all repositories known by Git Map if omitted).
	 * @returns The path of the repository, or NULL if none was chosen.
	 */
	private async pickRepo(placeHolder: string, repos: string[] = Object.keys(this.repoManager.getRepos())) {
		if (repos.length === 0) throw new Error(t('There aren\'t any repositories in this workspace.'));
		if (repos.length === 1) return repos[0];
		const item = await vscode.window.showQuickPick(repos.sort().map((repo) => ({ label: this.getName(repo), description: repo })), { placeHolder: placeHolder, ignoreFocusOut: true });
		return typeof item !== 'undefined' ? item.description : null;
	}

	/**
	 * Get the repository (known by Git Map) containing a file, and the path of the file within it.
	 * @param uri The URI of the file.
	 * @returns The repository & path, or NULL if the file isn't in a repository known by Git Map.
	 */
	private async getRepoOfFile(uri: vscode.Uri): Promise<{ repo: string, path: string } | null> {
		const repos = this.repoManager.getRepos();
		for (const filePath of [getPathFromUri(uri), getPathFromStr(await resolveToSymbolicPath(getPathFromUri(uri)))]) {
			// A folder that's a repository itself is in that repository (not in a repository containing it)
			const repo = typeof repos[filePath] !== 'undefined' ? filePath : this.repoManager.getRepoContainingFile(filePath);
			if (repo !== null) return { repo: repo, path: filePath.substring(repo.length + 1) };
		}
		return null;
	}
}

/**
 * Describe why files can't be removed from the history of a repository.
 */
function describeBlocker(blocker: HistoryRemovalBlocker) {
	switch (blocker.kind) {
		case 'gitVersion':
			return t('Git {0} is too old: Git 2.24 or later is required.', blocker.version);
		case 'notInHistory':
			return t('None of the files are in the history of a branch or tag.');
		case 'detachedHead':
			return t('HEAD is detached. Check out a branch first.');
		case 'uncommittedChanges':
			return t('There are uncommitted changes. Commit or discard them first.');
		case 'operationInProgress':
			return t('A {0} is in progress. Finish or abort it first.', blocker.operation);
		case 'shallow':
			return t('The repository is a shallow clone, so it doesn\'t have the whole history. Run "git fetch --unshallow" first.');
		case 'worktrees':
			return t('The repository has {0} worktrees. Remove the other worktrees first.', blocker.count);
		default:
			return t('These stashes are based on commits that contain the files, so they would keep the files in the repository: {0}. Apply or drop them first.', blocker.stashes.join(', '));
	}
}

/**
 * Describe what removing files from the history of a repository will do (shown before it's confirmed).
 * @param preview What it will do.
 * @param keepWorkingFiles TRUE => The files stay in the working directory, FALSE => They're deleted from it as well.
 */
function describePreview(preview: HistoryRemovalPreview, keepWorkingFiles: boolean) {
	const lines = [t('{0} commit(s) change them. Every branch & tag that contains them is rewritten: those commits no longer change them (commits that change nothing else are removed), and every later commit gets a new hash.', preview.commits)];
	if (preview.pathsInHead.length > 0) {
		lines.push(keepWorkingFiles
			? t('The files in the working directory aren\'t deleted: they stay there as untracked files.')
			: t('As chosen, the files are also deleted from the working directory.'));
	}
	if (preview.branches !== null && preview.branches.length > 0) lines.push(t('Branches: {0}', listNames(preview.branches)));
	if (preview.tags !== null && preview.tags.length > 0) lines.push(t('Tags: {0}', listNames(preview.tags)));
	if (preview.size !== null && preview.size > 0) lines.push(t('About {0} is freed once the previous history has been cleaned up.', formatSize(preview.size)));
	if (preview.remoteBranches !== null && preview.remoteBranches.length > 0) {
		lines.push(t('They\'re already on a remote ({0}). The rewritten branches & tags must be force-pushed afterwards (Git Map never pushes them itself), and every other clone must be cloned again.', listNames(preview.remoteBranches)));
	}
	if (preview.remoteOnlyBranches.length > 0) lines.push(t('These remote branches don\'t have a local branch, so they aren\'t rewritten: {0}. Check them out first to include them.', listNames(preview.remoteOnlyBranches)));
	if (preview.pathsNotInHistory.length > 0) lines.push(t('Not in the history (ignored): {0}', listNames(preview.pathsNotInHistory)));
	lines.push(preview.keepsUnaffectedSignatures
		? t('The signatures of the rewritten commits & tags are removed, and Code Reviews of the rewritten commits are no longer found.')
		: t('This version of Git removes the signatures of all commits (a newer version only removes them from the rewritten commits), so every commit after the first signed commit gets a new hash. Code Reviews of those commits are no longer found.'));
	lines.push(t('If the files contain passwords or keys, revoke those as well: removing them from the history doesn\'t make them secret again.'));
	lines.push(t('A backup is a Git bundle of the whole repository as it is now. "Git Map: Restore History from Backup" restores it.'));
	return lines.join('\n\n');
}

/**
 * Describe what removing files from the history of a repository did, and the steps that follow (a Markdown document).
 */
function describeResult(name: string, preview: HistoryRemovalPreview, result: HistoryRemovalResult) {
	const code = (values: ReadonlyArray<string>) => values.map((value) => '`' + value + '`').join(', ');
	const lines = [
		'# ' + t('Files removed from the history of {0}', name),
		'',
		t('Removed: {0}', code(preview.paths)),
		'',
		t('{0} commit(s) were rewritten, and {1} removed (they only changed the files). {2} signature(s) were removed.', result.stats.commitsRewritten, result.stats.commitsRemoved, result.stats.signaturesRemoved)
	];
	if (result.rewrittenBranches.length > 0) lines.push('', t('Rewritten branches: {0}', code(result.rewrittenBranches)));
	if (result.rewrittenTags.length > 0) lines.push('', t('Rewritten tags: {0}', code(result.rewrittenTags)));
	if (result.deletedRefs.length > 0) lines.push('', t('Deleted (none of their commits were left): {0}', code(result.deletedRefs.map(shortenRef))));

	lines.push('', '## 1. ' + t('Check the result'), '', t('Look at the rewritten branches in the Git Map View. The previous history is still in this repository (in its reflogs) and on its remotes: the steps below remove it from them.'), '');
	lines.push(result.backupPath !== null
		? t('To undo everything, run "Git Map: Restore History from Backup". The backup is {0}', '`' + result.backupPath + '`')
		: t('A backup wasn\'t created, so this can only be undone with the reflogs of the repository (until step 3).'));

	lines.push('', '## 2. ' + t('Update the remotes'), '');
	const remotes = Array.from(new Set((preview.remoteBranches || []).map((branch) => branch.substring(0, branch.indexOf('/')))));
	if (preview.remoteBranches !== null && remotes.length === 0) {
		lines.push(t('The files weren\'t found in a remote-tracking branch, so they may never have been pushed. If they were, force-push the rewritten branches & tags:'), '', '    git push --force-with-lease <remote> ' + result.rewrittenBranches.concat(result.rewrittenTags).map(quoteShellArg).join(' '));
	} else {
		lines.push(t('The remotes still have the previous history. Force-push the rewritten branches (and the rewritten tags that are on the remote):'), '');
		(remotes.length > 0 ? remotes : [null]).forEach((remote) => {
			// The remote isn't known if the branches containing the files couldn't be determined
			const remoteArg = remote !== null ? quoteShellArg(remote) : '<remote>';
			const branches = result.rewrittenBranches.filter((branch) => remote === null || preview.remoteBranches === null || preview.remoteBranches.includes(remote + '/' + branch));
			if (branches.length > 0) lines.push('    git push --force-with-lease ' + remoteArg + ' ' + branches.map(quoteShellArg).join(' '));
			if (result.rewrittenTags.length > 0) lines.push('    git push --force ' + remoteArg + ' ' + result.rewrittenTags.map((tag) => quoteShellArg('refs/tags/' + tag)).join(' '));
		});
	}
	if (preview.remoteOnlyBranches.length > 0) {
		lines.push('', t('These remote branches weren\'t rewritten, and still contain the files: {0}. Delete them on the remote, or check them out and remove the files again.', code(preview.remoteOnlyBranches)));
	}

	lines.push('', '## 3. ' + t('Clean up this repository'), '', t('Once the remotes are updated, run "Git Map: Clean Up after Removing Files from History". It deletes the previous history from this repository, reports what still contains the files, and can delete the backup (which still contains the files).'));

	lines.push('', '## 4. ' + t('Everywhere else'), '',
		'- ' + t('Every other clone must be cloned again (or its branches reset to the rewritten ones). Otherwise the files come back with its next push.'),
		'- ' + t('Hosting services keep the previous commits (in pull requests, caches & forks). Ask their support to remove them (e.g. GitHub: "Removing sensitive data from a repository").'),
		'- ' + t('If the files contained passwords or keys, revoke them.'),
		'');
	return lines.join('\n');
}

/**
 * Add paths to the .gitignore file at the root of a repository (unless they're already in it).
 * @param repo The path of the repository.
 * @param paths The paths (relative to the repository).
 */
async function addToGitignore(repo: string, paths: ReadonlyArray<string>) {
	const file = path.join(repo, '.gitignore');
	const existing = await fs.promises.readFile(file, 'utf8').catch(() => '');
	const lines = existing.split(/\r?\n/);
	// A pattern starting with "/" only matches the path from the root of the repository
	const patterns = paths.map((filePath) => '/' + filePath.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ')).filter((pattern) => !lines.includes(pattern));
	if (patterns.length === 0) return;
	const eol = existing.includes('\r\n') ? '\r\n' : '\n';
	await fs.promises.writeFile(file, existing + (existing !== '' && !existing.endsWith('\n') ? eol : '') + patterns.join(eol) + eol);
}

/**
 * List names in a message (only the first ones if there are many).
 */
function listNames(names: ReadonlyArray<string>) {
	return names.length > MAX_NAMES_LISTED ? names.slice(0, MAX_NAMES_LISTED).join(', ') + ', ... (+' + (names.length - MAX_NAMES_LISTED) + ')' : names.join(', ');
}

/**
 * Get the short name of a reference (e.g. "origin/main" for "refs/remotes/origin/main").
 */
function shortenRef(ref: string) {
	return ref.replace(/^refs\/(heads|tags|remotes)\//, '');
}

/**
 * Format a number of bytes.
 */
function formatSize(bytes: number) {
	const units = ['B', 'KB', 'MB', 'GB'];
	let value = bytes, unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return (unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10) + ' ' + units[unit];
}

/**
 * Quote an argument of a command that's shown to be run in a shell, if it contains characters that are special to it.
 */
function quoteShellArg(arg: string) {
	return /^[A-Za-z0-9_./:@-]+$/.test(arg) ? arg : '\'' + arg.replace(/'/g, '\'\\\'\'') + '\'';
}
