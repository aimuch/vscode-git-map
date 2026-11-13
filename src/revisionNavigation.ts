import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { DiffDocProvider, decodeDiffDocUri } from './diffDocProvider';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { GitFileStatus } from './types';
import { UNCOMMITTED, abbrevCommit, getPathFromUri, showErrorMessage, showInformationMessage, viewDiff } from './utils';
import { Disposable } from './utils/disposable';

/**
 * The revision of a file shown in the active editor: a commit (in a diff or a file opened by Git Map), or the working tree.
 */
interface ShownRevision {
	readonly repo: string;
	readonly commit: string; // UNCOMMITTED for the working tree
	readonly filePath: string; // The path of the file (relative to the repository) in the revision
}

/**
 * Navigates through the revisions of a file: "Show Previous Revision" & "Show Next Revision" (the buttons of the editors of diffs & files
 * opened by Git Map) show the changes made to the file by the commit before or after the one shown. In a file's editor, the previous
 * revision is the latest commit that changed the file.
 */
export class RevisionNavigation extends Disposable {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;

	/**
	 * Creates the Revision Navigation.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.openPreviousRevision', () => this.navigate(false)),
			vscode.commands.registerCommand('git-map.openNextRevision', () => this.navigate(true))
		);
	}

	/**
	 * Show the changes made by the previous or next commit that changed the file in the active editor.
	 * @param next TRUE => The next commit, FALSE => The previous commit.
	 */
	private async navigate(next: boolean) {
		// The messages aren't awaited, as they're only resolved when they're closed
		const shown = await this.getShownRevision();
		if (shown === null) {
			const reason = t('Open a file in an editor, or the changes of a file opened by Git Map.');
			showErrorMessage(next ? t('Unable to Show the Next Revision: {0}', reason) : t('Unable to Show the Previous Revision: {0}', reason));
			return;
		}

		if (next) {
			if (shown.commit === UNCOMMITTED) {
				showInformationMessage(t('This is the latest revision of {0}.', shown.filePath));
				return;
			}
			const revision = await this.dataSource.getFileRevision(shown.repo, shown.commit, shown.filePath, 'after');
			if (revision !== null) return this.showRevision(shown.repo, revision);
			// After the latest commit, the uncommitted changes are shown (if the file has any)
			const latest = await this.dataSource.getFileRevision(shown.repo, 'HEAD', shown.filePath, 'latest');
			if (latest !== null && latest.hash === shown.commit && await this.dataSource.hasUncommittedChanges(shown.repo, shown.filePath)) {
				const error = await viewDiff(shown.repo, UNCOMMITTED, UNCOMMITTED, shown.filePath, shown.filePath, GitFileStatus.Modified);
				if (error !== null) showErrorMessage(error);
				return;
			}
			showInformationMessage(t('There isn\'t a newer revision of {0} in the history of HEAD.', shown.filePath));
			return;
		}

		const revision = await this.dataSource.getFileRevision(shown.repo, shown.commit === UNCOMMITTED ? 'HEAD' : shown.commit, shown.filePath, shown.commit === UNCOMMITTED ? 'latest' : 'before');
		if (revision === null) {
			showInformationMessage(t('{0} doesn\'t have an earlier revision.', shown.filePath));
			return;
		}
		return this.showRevision(shown.repo, revision);
	}

	/**
	 * Show the changes a commit made to a file.
	 * @param repo The repository.
	 * @param revision The commit, how it changed the file, and the paths of the file.
	 */
	private async showRevision(repo: string, revision: { hash: string, type: GitFileStatus, oldFilePath: string, newFilePath: string }) {
		const error = await viewDiff(repo, revision.hash, revision.hash, revision.oldFilePath, revision.newFilePath, revision.type);
		if (error !== null) {
			showErrorMessage(error);
		} else {
			vscode.window.setStatusBarMessage(t('Showing the changes of commit {0}', abbrevCommit(revision.hash)), 3000);
		}
	}

	/**
	 * Get the revision of the file shown in the active editor.
	 * @returns The revision, or NULL if the active editor doesn't show a file in a repository known by Git Map.
	 */
	private async getShownRevision(): Promise<ShownRevision | null> {
		const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
		const input = typeof tab !== 'undefined' ? tab.input : undefined;
		if (input instanceof vscode.TabInputTextDiff) {
			// A diff: the revision on its right side
			if (input.modified.scheme === DiffDocProvider.scheme) {
				const data = decodeDiffDocUri(input.modified);
				return { repo: data.repo, commit: data.commit, filePath: data.filePath };
			} else if (input.modified.scheme === 'file' && input.original.scheme === DiffDocProvider.scheme) {
				const data = decodeDiffDocUri(input.original);
				return { repo: data.repo, commit: UNCOMMITTED, filePath: data.filePath };
			}
		} else if (input instanceof vscode.TabInputText && input.uri.scheme === DiffDocProvider.scheme) {
			const data = decodeDiffDocUri(input.uri);
			return { repo: data.repo, commit: data.commit, filePath: data.filePath };
		}
		const editor = vscode.window.activeTextEditor;
		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') return null;
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(editor.document.uri));
		return file !== null ? { repo: file.repo, commit: UNCOMMITTED, filePath: file.path } : null;
	}
}
