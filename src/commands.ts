import * as os from 'os';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { GRAPH_COLOUR_PRESETS, GRAPH_COLOUR_PRESET_NAMES, getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider, decodeDiffDocUri } from './diffDocProvider';
import { CodeReviewData, CodeReviews, ExtensionState } from './extensionState';
import { GitGraphView } from './gitGraphView';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitExecutable, UNABLE_TO_FIND_GIT_MSG, VsCodeVersionRequirement, abbrevCommit, abbrevText, copyToClipboard, doesVersionMeetRequirement, getExtensionVersion, getPathFromUri, getRelativeTimeDiff, getRepoName, getSelectedLines, getSortedRepositoryPaths, isPathInWorkspace, openFile, resolveToSymbolicPath, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';
import { t } from './l10n';

/**
 * Manages the registration and execution of Git Map Commands.
 */
export class CommandManager extends Disposable {
	private readonly context: vscode.ExtensionContext;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly repoManager: RepoManager;
	private gitExecutable: GitExecutable | null;

	/**
	 * Creates the Git Map Command Manager.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param avatarManger The Git Map AvatarManager instance.
	 * @param dataSource The Git Map DataSource instance.
	 * @param extensionState The Git Map ExtensionState instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param gitExecutable The Git executable available to Git Map at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Map to use.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(context: vscode.ExtensionContext, avatarManger: AvatarManager, dataSource: DataSource, extensionState: ExtensionState, repoManager: RepoManager, gitExecutable: GitExecutable | null, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.context = context;
		this.avatarManager = avatarManger;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.logger = logger;
		this.repoManager = repoManager;
		this.gitExecutable = gitExecutable;

		// Register Extension Commands
		this.registerCommand('git-map.view', (arg) => this.view(arg));
		this.registerCommand('git-map.addGitRepository', () => this.addGitRepository());
		this.registerCommand('git-map.removeGitRepository', () => this.removeGitRepository());
		this.registerCommand('git-map.clearAvatarCache', () => this.clearAvatarCache());
		this.registerCommand('git-map.fetch', () => this.openAndRun('fetch'));
		this.registerCommand('git-map.cleanUpBranches', () => this.openAndRun('cleanUpBranches'));
		this.registerCommand('git-map.endAllWorkspaceCodeReviews', () => this.endAllWorkspaceCodeReviews());
		this.registerCommand('git-map.endSpecificWorkspaceCodeReview', () => this.endSpecificWorkspaceCodeReview());
		this.registerCommand('git-map.resumeWorkspaceCodeReview', () => this.resumeWorkspaceCodeReview());
		this.registerCommand('git-map.version', () => this.version());
		this.registerCommand('git-map.selectGraphColourPreset', () => this.selectGraphColourPreset());
		this.registerCommand('git-map.openFile', (arg) => this.openFile(arg));
		this.registerCommand('git-map.viewFileHistory', (arg) => this.viewFileHistory(arg));
		this.registerCommand('git-map.viewLineHistoryInGitMap', (arg) => this.viewLineHistoryInGitMap(arg));
		this.registerCommand('git-map.viewCommitInGitMap', (repo, hash) => this.viewCommitInGitMap(repo, hash));
		this.registerCommand('git-map.toggleLineBlame', () => this.toggleLineBlame());

		this.registerDisposable(
			onDidChangeGitExecutable((gitExecutable) => {
				this.gitExecutable = gitExecutable;
			})
		);

		// Register Extension Contexts
		try {
			this.registerContext('git-map:codiconsSupported', doesVersionMeetRequirement(vscode.version, VsCodeVersionRequirement.Codicons));
		} catch (_) {
			this.logger.logError('Unable to set Visual Studio Code Context "git-map:codiconsSupported"');
		}
	}

	/**
	 * Register a Git Map command with Visual Studio Code.
	 * @param command A unique identifier for the command.
	 * @param callback A command handler function.
	 */
	private registerCommand(command: string, callback: (...args: any[]) => any) {
		this.registerDisposable(
			vscode.commands.registerCommand(command, (...args: any[]) => {
				this.logger.log('Command Invoked: ' + command);
				callback(...args);
			})
		);
	}

	/**
	 * Register a context with Visual Studio Code.
	 * @param key The Context Key.
	 * @param value The Context Value.
	 */
	private registerContext(key: string, value: any) {
		return vscode.commands.executeCommand('setContext', key, value).then(
			() => this.logger.log('Successfully set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"'),
			() => this.logger.logError('Failed to set Visual Studio Code Context "' + key + '" to "' + JSON.stringify(value) + '"')
		);
	}


	/* Commands */

	/**
	 * The method run when the `git-map.view` command is invoked.
	 * @param arg An optional argument passed to the command (when invoked from the Visual Studio Code Git Extension).
	 */
	private async view(arg: any) {
		let loadRepo: string | null = null;

		if (typeof arg === 'object' && arg !== null && arg.rootUri) {
			// If command is run from the Visual Studio Code Source Control View, load the specific repo
			const repoPath = getPathFromUri(arg.rootUri);
			loadRepo = await this.repoManager.getKnownRepo(repoPath);
			if (loadRepo === null) {
				// The repo is not currently known, add it
				loadRepo = (await this.repoManager.registerRepo(await resolveToSymbolicPath(repoPath), true)).root;
			}
		} else if (getConfig().openToTheRepoOfTheActiveTextEditorDocument && vscode.window.activeTextEditor) {
			// If the config setting is enabled, load the repo containing the active text editor document
			loadRepo = this.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		}

		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, loadRepo !== null ? { repo: loadRepo } : null);
	}

	/**
	 * The method run when the `git-map.viewFileHistory` command is invoked: open the Git Map View showing the history of a file.
	 * @param arg The URI of the file (when invoked from the Explorer or an editor's title), otherwise the file in the active text editor is used.
	 */
	private async viewFileHistory(arg: any) {
		const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null;
		if (uri === null || uri.scheme !== 'file') {
			showErrorMessage(t('Unable to View File History: {0}', t('Select a file in the Explorer, or open a file in an editor.')));
			return;
		}
		const file = await this.getRepoOfFile(uri);
		if (file === null) {
			showErrorMessage(t('Unable to View File History: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(uri))));
			return;
		}
		// The commit that last changed the line the cursor is on (or the file) is selected in the history
		const commit = await this.getCommitToSelect(file.repo, file.path, uri);
		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: file.repo, fileHistory: file.path, ...getCommitDetails(commit) });
	}

	/**
	 * Get the commit selected in the history of a file: the commit that last changed the line the cursor is on (if the file is in the active
	 * text editor, and the line is committed), otherwise the latest commit that changed the file.
	 * @param repo The repository containing the file.
	 * @param filePath The path of the file (relative to the repository).
	 * @param uri The URI of the file.
	 * @returns The hash of the commit, or NULL if the file doesn't have any commits.
	 */
	private async getCommitToSelect(repo: string, filePath: string, uri: vscode.Uri) {
		const editor = vscode.window.activeTextEditor;
		if (typeof editor !== 'undefined' && editor.document.uri.toString() === uri.toString()) {
			const blame = await this.dataSource.getLineBlame(repo, filePath, editor.selection.active.line + 1, editor.document.getText());
			if (blame !== null && blame.committed) return blame.hash;
		}
		const latest = await this.dataSource.getFileRevision(repo, 'HEAD', filePath, 'latest');
		return latest !== null ? latest.hash : null;
	}

	/**
	 * The method run when the `git-map.viewLineHistoryInGitMap` command is invoked: open the Git Map View showing the history of the
	 * selected lines (or the line the cursor is on) in the active text editor, or of the lines given by the Line History drawer.
	 * @param arg The repository, file & lines in HEAD (from the Line History drawer), or undefined to use the active text editor.
	 */
	private async viewLineHistoryInGitMap(arg: any) {
		if (typeof arg === 'object' && arg !== null && typeof arg.repo === 'string' && typeof arg.filePath === 'string' && typeof arg.lineRange === 'object' && arg.lineRange !== null) {
			const lineRange = { start: arg.lineRange.start, end: arg.lineRange.end };
			const commit = await this.dataSource.getLatestCommitOfLines(arg.repo, arg.filePath, lineRange);
			GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: arg.repo, fileHistory: arg.filePath, lineRange: lineRange, ...getCommitDetails(commit) });
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') {
			showErrorMessage(t('Unable to View Line History: {0}', t('Open a file in an editor, and select the lines.')));
			return;
		}
		const file = await this.getRepoOfFile(editor.document.uri);
		if (file === null) {
			showErrorMessage(t('Unable to View Line History: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(editor.document.uri))));
			return;
		}
		// The selected lines of the editor (which may have uncommitted changes) are mapped to the same lines in HEAD
		const lineRange = await this.dataSource.getLinesInHead(file.repo, file.path, getSelectedLines(editor.selection), editor.document.getText());
		if (lineRange === null) {
			showErrorMessage(t('Unable to View Line History: {0}', t('The selected lines haven\'t been committed yet.')));
			return;
		}
		// The latest commit that changed the lines is selected in their history
		const commit = await this.dataSource.getLatestCommitOfLines(file.repo, file.path, lineRange);
		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: file.repo, fileHistory: file.path, lineRange: lineRange, ...getCommitDetails(commit) });
	}

	/**
	 * The method run when the `git-map.viewCommitInGitMap` command is invoked (by the link in the hover of the blame of a line): open the
	 * Git Map View showing the details of a commit.
	 * @param repo The repository containing the commit.
	 * @param hash The hash of the commit.
	 */
	private viewCommitInGitMap(repo: any, hash: any) {
		if (typeof repo !== 'string' || typeof hash !== 'string') return;
		GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, { repo: repo, commitDetails: { commitHash: hash, compareWithHash: null } });
	}

	/**
	 * The method run when the `git-map.toggleLineBlame` command is invoked: show or hide the blame of the current line. The setting is
	 * changed where it's set (a workspace's setting overrides the user's), and the change is reported (also if GitLens shows the blame of the
	 * current line, as it would otherwise look like nothing changed).
	 */
	private async toggleLineBlame() {
		const config = vscode.workspace.getConfiguration('git-map'), values = config.inspect<boolean>('blame.currentLine'), show = !getConfig().blameCurrentLine;
		const target = typeof values !== 'undefined' && typeof values.workspaceValue !== 'undefined' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		await config.update('blame.currentLine', show, target);
		vscode.window.setStatusBarMessage(show ? t('$(eye) Git Map: Current Line Blame On') : t('$(eye-closed) Git Map: Current Line Blame Off'), 4000);
		if (vscode.extensions.getExtension('eamodio.gitlens') !== undefined && vscode.workspace.getConfiguration('gitlens').get<boolean>('currentLine.enabled', true)) {
			// The message isn't awaited, as it's only resolved when it's closed
			showInformationMessage(show
				? t('Git Map shows the blame of the current line again. GitLens also shows it (the "gitlens.currentLine.enabled" setting).')
				: t('Git Map no longer shows the blame of the current line. The blame still shown is GitLens\' (the "gitlens.currentLine.enabled" setting).'));
		}
	}

	/**
	 * Get the repository (known by Git Map) containing a file, and the path of the file within it.
	 * @param uri The URI of the file.
	 * @returns The repository & path, or NULL if the file isn't in a repository known by Git Map.
	 */
	private getRepoOfFile(uri: vscode.Uri): Promise<{ repo: string, path: string } | null> {
		return this.repoManager.getRepoAndPathOfFile(getPathFromUri(uri));
	}

	/**
	 * The method run when the `git-map.addGitRepository` command is invoked.
	 */
	private addGitRepository() {
		if (this.gitExecutable === null) {
			showErrorMessage(t(UNABLE_TO_FIND_GIT_MSG));
			return;
		}

		vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }).then(uris => {
			if (uris && uris.length > 0) {
				let path = getPathFromUri(uris[0]);
				if (isPathInWorkspace(path)) {
					this.repoManager.registerRepo(path, false).then(status => {
						if (status.error === null) {
							showInformationMessage(t('The repository "{0}" was added to Git Map.', status.root!));
						} else {
							showErrorMessage(t('{0} Therefore it could not be added to Git Map.', status.error));
						}
					});
				} else {
					showErrorMessage(t('The folder "{0}" is not within the opened Visual Studio Code workspace, and therefore could not be added to Git Map.', path));
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-map.removeGitRepository` command is invoked.
	 */
	private removeGitRepository() {
		if (this.gitExecutable === null) {
			showErrorMessage(t(UNABLE_TO_FIND_GIT_MSG));
			return;
		}

		const repos = this.repoManager.getRepos();
		const items: vscode.QuickPickItem[] = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder).map((path) => ({
			label: repos[path].name || getRepoName(path),
			description: path
		}));

		vscode.window.showQuickPick(items, {
			placeHolder: t('Select a repository to remove from Git Map:'),
			canPickMany: false
		}).then((item) => {
			if (item && item.description !== undefined) {
				if (this.repoManager.ignoreRepo(item.description)) {
					showInformationMessage(t('The repository "{0}" was removed from Git Map.', item.label));
				} else {
					showErrorMessage(t('The repository "{0}" is not known to Git Map.', item.label));
				}
			}
		}, () => { });
	}

	/**
	 * The method run when the `git-map.clearAvatarCache` command is invoked.
	 */
	private clearAvatarCache() {
		this.avatarManager.clearCache().then((errorInfo) => {
			if (errorInfo === null) {
				showInformationMessage(t('The Avatar Cache was successfully cleared.'));
			} else {
				showErrorMessage(errorInfo);
			}
		}, () => {
			showErrorMessage(t('An unexpected error occurred while running the command "{0}".', t('Clear Avatar Cache')));
		});
	}

	/**
	 * The method run when the `git-map.fetch` or `git-map.cleanUpBranches` command is invoked: open a repository in Git Map, and fetch from
	 * its remote(s) or open the list of the branches that can be cleaned up.
	 * @param command The command run when the repository is loaded.
	 */
	private openAndRun(command: 'fetch' | 'cleanUpBranches') {
		const repos = this.repoManager.getRepos();
		const repoPaths = getSortedRepositoryPaths(repos, getConfig().repoDropdownOrder);

		if (repoPaths.length > 1) {
			const items: vscode.QuickPickItem[] = repoPaths.map((path) => ({
				label: repos[path].name || getRepoName(path),
				description: path
			}));

			const lastActiveRepo = this.extensionState.getLastActiveRepo();
			if (lastActiveRepo !== null) {
				let lastActiveRepoIndex = items.findIndex((item) => item.description === lastActiveRepo);
				if (lastActiveRepoIndex > -1) {
					const item = items.splice(lastActiveRepoIndex, 1)[0];
					items.unshift(item);
				}
			}

			vscode.window.showQuickPick(items, {
				placeHolder: command === 'fetch' ? t('Select the repository you want to open in Git Map, and fetch from remote(s):') : t('Select the repository whose branches you want to clean up:'),
				canPickMany: false
			}).then((item) => {
				if (item && item.description) {
					GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
						repo: item.description,
						runCommandOnLoad: command
					});
				}
			}, () => {
				showErrorMessage(t('An unexpected error occurred while running the command "{0}".', command === 'fetch' ? t('Fetch from Remote(s)') : t('Clean Up Branches')));
			});
		} else if (repoPaths.length === 1) {
			GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
				repo: repoPaths[0],
				runCommandOnLoad: command
			});
		} else {
			GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, null);
		}
	}

	/**
	 * The method run when the `git-map.endAllWorkspaceCodeReviews` command is invoked.
	 */
	private endAllWorkspaceCodeReviews() {
		this.extensionState.endAllWorkspaceCodeReviews();
		showInformationMessage(t('Ended All Code Reviews in Workspace'));
	}

	/**
	 * The method run when the `git-map.endSpecificWorkspaceCodeReview` command is invoked.
	 */
	private endSpecificWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage(t('There are no Code Reviews in progress within the current workspace.'));
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: t('Select the Code Review you want to end:'),
			canPickMany: false
		}).then((item) => {
			if (item) {
				this.extensionState.endCodeReview(item.codeReviewRepo, item.codeReviewId).then((errorInfo) => {
					if (errorInfo === null) {
						showInformationMessage(t('Successfully ended Code Review "{0}".', item.label));
					} else {
						showErrorMessage(errorInfo);
					}
				}, () => { });
			}
		}, () => {
			showErrorMessage(t('An unexpected error occurred while running the command "{0}".', t('End a specific Code Review in Workspace...')));
		});
	}

	/**
	 * The method run when the `git-map.resumeWorkspaceCodeReview` command is invoked.
	 */
	private resumeWorkspaceCodeReview() {
		const codeReviews = this.extensionState.getCodeReviews();
		if (Object.keys(codeReviews).length === 0) {
			showErrorMessage(t('There are no Code Reviews in progress within the current workspace.'));
			return;
		}

		vscode.window.showQuickPick(this.getCodeReviewQuickPickItems(codeReviews), {
			placeHolder: t('Select the Code Review you want to resume:'),
			canPickMany: false
		}).then((item) => {
			if (item) {
				const commitHashes = item.codeReviewId.split('-');
				GitGraphView.createOrShow(this.context.extensionPath, this.dataSource, this.extensionState, this.avatarManager, this.repoManager, this.logger, {
					repo: item.codeReviewRepo,
					commitDetails: {
						commitHash: commitHashes[commitHashes.length > 1 ? 1 : 0],
						compareWithHash: commitHashes.length > 1 ? commitHashes[0] : null
					}
				});
			}
		}, () => {
			showErrorMessage(t('An unexpected error occurred while running the command "{0}".', t('Resume a specific Code Review in Workspace...')));
		});
	}

	/**
	 * The method run when the `git-map.version` command is invoked.
	 */
	/**
	 * The method run when the `git-map.selectGraphColourPreset` command is invoked.
	 */
	private async selectGraphColourPreset() {
		const current = getConfig().graphColourPreset;
		const items: (vscode.QuickPickItem & { preset: string })[] = GRAPH_COLOUR_PRESET_NAMES.map((preset) => ({
			label: t(preset),
			description: preset === current ? t('Current') : undefined,
			detail: preset === 'Default' ? t('The colours specified by "git-map.graph.colours"') : GRAPH_COLOUR_PRESETS[preset].join('  '),
			preset: preset
		}));
		const selected = await vscode.window.showQuickPick(items, { placeHolder: t('Select the preset of colours used on the graph'), ignoreFocusOut: true });
		if (selected) {
			try {
				await vscode.workspace.getConfiguration('git-map').update('graph.colourPreset', selected.preset, vscode.ConfigurationTarget.Global);
			} catch (_) {
				showErrorMessage(t('Unable to save the Graph Colour Preset.'));
			}
		}
	}

	private async version() {
		try {
			const gitGraphVersion = await getExtensionVersion(this.context);
			const information = 'Git Map: ' + gitGraphVersion + '\nVisual Studio Code: ' + vscode.version + '\nOS: ' + os.type() + ' ' + os.arch() + ' ' + os.release() + '\nGit: ' + (this.gitExecutable !== null ? this.gitExecutable.version : '(none)');
			vscode.window.showInformationMessage(information, { modal: true }, t('Copy')).then((selectedItem) => {
				if (selectedItem === t('Copy')) {
					copyToClipboard(information).then((result) => {
						if (result !== null) {
							showErrorMessage(result);
						}
					});
				}
			}, () => { });
		} catch (_) {
			showErrorMessage(t('An unexpected error occurred while retrieving version information.'));
		}
	}

	/**
	 * Opens a file in Visual Studio Code, based on a Git Map URI (from the Diff View).
	 * The method run when the `git-map.openFile` command is invoked.
	 * @param arg The Git Map URI.
	 */
	private openFile(arg?: vscode.Uri) {
		const uri = arg || vscode.window.activeTextEditor?.document.uri;
		if (typeof uri === 'object' && uri && uri.scheme === DiffDocProvider.scheme) {
			// A Git Map URI has been provided
			const request = decodeDiffDocUri(uri);
			return openFile(request.repo, request.filePath, request.commit, this.dataSource, vscode.ViewColumn.Active).then((errorInfo) => {
				if (errorInfo !== null) {
					return showErrorMessage(t('Unable to Open File: {0}', errorInfo));
				}
			});
		} else {
			return showErrorMessage(t('Unable to Open File: {0}', t('The command was not called with the required arguments.')));
		}
	}


	/* Helper Methods */

	/**
	 * Transform a set of Code Reviews into a list of Quick Pick items for use with `vscode.window.showQuickPick`.
	 * @param codeReviews A set of Code Reviews.
	 * @returns A list of Quick Pick items.
	 */
	private getCodeReviewQuickPickItems(codeReviews: CodeReviews): Promise<CodeReviewQuickPickItem[]> {
		const repos = this.repoManager.getRepos();
		const enrichedCodeReviews: { repo: string, id: string, review: CodeReviewData, fromCommitHash: string, toCommitHash: string }[] = [];
		const fetchCommits: { repo: string, commitHash: string }[] = [];

		Object.keys(codeReviews).forEach((repo) => {
			if (typeof repos[repo] === 'undefined') return;
			Object.keys(codeReviews[repo]).forEach((id) => {
				const commitHashes = id.split('-');
				commitHashes.forEach((commitHash) => fetchCommits.push({ repo: repo, commitHash: commitHash }));
				enrichedCodeReviews.push({
					repo: repo, id: id, review: codeReviews[repo][id],
					fromCommitHash: commitHashes[0], toCommitHash: commitHashes[commitHashes.length > 1 ? 1 : 0]
				});
			});
		});

		return Promise.all(fetchCommits.map((fetch) => this.dataSource.getCommitSubject(fetch.repo, fetch.commitHash))).then(
			(subjects) => {
				const commitSubjects: { [repo: string]: { [commitHash: string]: string } } = {};
				subjects.forEach((subject, i) => {
					if (typeof commitSubjects[fetchCommits[i].repo] === 'undefined') {
						commitSubjects[fetchCommits[i].repo] = {};
					}
					commitSubjects[fetchCommits[i].repo][fetchCommits[i].commitHash] = subject !== null ? subject : '<Unknown Commit Subject>';
				});

				return enrichedCodeReviews.sort((a, b) => b.review.lastActive - a.review.lastActive).map((codeReview) => {
					const fromSubject = commitSubjects[codeReview.repo][codeReview.fromCommitHash];
					const toSubject = commitSubjects[codeReview.repo][codeReview.toCommitHash];
					const isComparison = codeReview.fromCommitHash !== codeReview.toCommitHash;
					return {
						codeReviewRepo: codeReview.repo,
						codeReviewId: codeReview.id,
						label: (repos[codeReview.repo].name || getRepoName(codeReview.repo)) + ': ' + abbrevCommit(codeReview.fromCommitHash) + (isComparison ? ' ↔ ' + abbrevCommit(codeReview.toCommitHash) : ''),
						description: getRelativeTimeDiff(Math.round(codeReview.review.lastActive / 1000)),
						detail: isComparison
							? abbrevText(fromSubject, 50) + ' ↔ ' + abbrevText(toSubject, 50)
							: fromSubject
					};
				});
			}
		);
	}
}

interface CodeReviewQuickPickItem extends vscode.QuickPickItem {
	codeReviewRepo: string;
	codeReviewId: string;
}

/**
 * Get the commit whose details are opened when the Git Map View is loaded (selecting it in the history of a file or lines).
 * @param commit The hash of the commit, or NULL.
 * @returns The part of the view's "load view to" that opens the commit's details.
 */
function getCommitDetails(commit: string | null): { commitDetails?: { commitHash: string, compareWithHash: null } } {
	return commit !== null ? { commitDetails: { commitHash: commit, compareWithHash: null } } : {};
}
