import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { DataSource, GitConfigKey } from './dataSource';
import { DiffSide, encodeDiffDocUri } from './diffDocProvider';
import { explainCommit, getLanguageModels } from './explainCommit';
import { ExtensionState } from './extensionState';
import { buildFileIconTheme, findFileIconTheme, getFileIconThemeExtensionPaths, getLanguageFiles } from './fileIconTheme';
import { GitFeatures } from './gitFeatures';
import { Logger } from './logger';
import { RepoFileWatcher } from './repoFileWatcher';
import { RepoManager } from './repoManager';
import { UndoManager, getUndoManager } from './undoManager';
import { ErrorInfo, GitConfigLocation, GitFileStatus, GitGraphViewInitialState, GitPushBranchMode, GitRepoSet, LoadGitGraphViewTo, MergeActionOn, RebaseActionOn, RequestMessage, ResponseMessage, TabIconColourTheme } from './types';
import { UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, abbrevCommit, archive, copyFilePathToClipboard, copyToClipboard, createPullRequest, getNonce, openExtensionSettings, openExternalUrl, openFile, openFolderInNewWindow, showErrorMessage, updateExtensionSetting, viewDiff, viewDiffWithWorkingFile, viewFileAtRevision, viewScm } from './utils';
import { Disposable, toDisposable } from './utils/disposable';
import { getL10nBundle, getLanguage, t } from './l10n';

/**
 * The number of times the definition of the file icon theme is read again if it can't be read, and the time (in milliseconds) between them.
 */
const MAX_FILE_ICON_THEME_RETRIES = 5;
const FILE_ICON_THEME_RETRY_DELAY = 2000;

/**
 * The time (in milliseconds) after the definition of the file icon theme changes, before it's read again.
 */
const FILE_ICON_THEME_CHANGE_DELAY = 500;

/**
 * Manages the Git Map View.
 */
export class GitGraphView extends Disposable {
	public static currentPanel: GitGraphView | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly extensionPath: string;
	private readonly avatarManager: AvatarManager;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly repoFileWatcher: RepoFileWatcher;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly undoManager: UndoManager;
	private readonly gitFeatures: GitFeatures;
	private explainCancellation: vscode.CancellationTokenSource | null = null;
	private isGraphViewLoaded: boolean = false;
	private fileIconThemeWatcher: vscode.Disposable | null = null;
	private fileIconThemeWatched: string | null = null; // The path of the definition of the file icon theme that's watched
	private fileIconThemeRetry: NodeJS.Timeout | null = null;
	private fileIconThemeRetries: number = 0;
	private isPanelVisible: boolean = true;
	private currentRepo: string | null = null;
	private loadViewTo: LoadGitGraphViewTo = null; // Is used by the next call to getHtmlForWebview, and is then reset to null

	private loadRepoInfoRefreshId: number = 0;
	private loadCommitsRefreshId: number = 0;

	/**
	 * If a Git Map View already exists, show and update it. Otherwise, create a Git Map View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Map DataSource instance.
	 * @param extensionState The Git Map ExtensionState instance.
	 * @param avatarManger The Git Map AvatarManager instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 * @param loadViewTo What to load the view to.
	 */
	public static createOrShow(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo) {
		const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

		if (GitGraphView.currentPanel) {
			// If Git Map panel already exists
			if (GitGraphView.currentPanel.isPanelVisible) {
				// If the Git Map panel is visible
				if (loadViewTo !== null) {
					GitGraphView.currentPanel.respondLoadRepos(repoManager.getRepos(), loadViewTo);
				}
			} else {
				// If the Git Map panel is not visible
				GitGraphView.currentPanel.loadViewTo = loadViewTo;
			}
			GitGraphView.currentPanel.panel.reveal(column);
		} else {
			// If Git Map panel doesn't already exist
			GitGraphView.currentPanel = new GitGraphView(extensionPath, dataSource, extensionState, avatarManager, repoManager, logger, loadViewTo, column);
		}
	}

	/**
	 * Creates a Git Map View.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @param dataSource The Git Map DataSource instance.
	 * @param extensionState The Git Map ExtensionState instance.
	 * @param avatarManger The Git Map AvatarManager instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 * @param loadViewTo What to load the view to.
	 * @param column The column the view should be loaded in.
	 */
	private constructor(extensionPath: string, dataSource: DataSource, extensionState: ExtensionState, avatarManager: AvatarManager, repoManager: RepoManager, logger: Logger, loadViewTo: LoadGitGraphViewTo, column: vscode.ViewColumn | undefined) {
		super();
		this.extensionPath = extensionPath;
		this.avatarManager = avatarManager;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.repoManager = repoManager;
		this.logger = logger;
		this.loadViewTo = loadViewTo;
		this.undoManager = getUndoManager(dataSource);
		this.gitFeatures = new GitFeatures(dataSource);

		const config = getConfig();
		this.panel = vscode.window.createWebviewPanel('git-map', 'Git Map', column || vscode.ViewColumn.One, {
			enableScripts: true,
			localResourceRoots: this.getLocalResourceRoots(extensionPath),
			retainContextWhenHidden: config.retainContextWhenHidden
		});
		this.panel.iconPath = config.tabIconColourTheme === TabIconColourTheme.Colour
			? this.getResourcesUri('webview-icon.svg')
			: {
				light: this.getResourcesUri('webview-icon-light.svg'),
				dark: this.getResourcesUri('webview-icon-dark.svg')
			};


		this.registerDisposables(
			// Dispose Git Map View resources when disposed
			toDisposable(() => {
				GitGraphView.currentPanel = undefined;
				this.repoFileWatcher.stop();
				this.watchFileIconTheme(null);
				if (this.fileIconThemeRetry !== null) clearTimeout(this.fileIconThemeRetry);
			}),

			// Dispose this Git Map View when the Webview Panel is disposed
			this.panel.onDidDispose(() => this.dispose()),

			// Register a callback that is called when the view is shown or hidden
			this.panel.onDidChangeViewState(() => {
				if (this.panel.visible !== this.isPanelVisible) {
					if (this.panel.visible) {
						this.update();
					} else {
						this.currentRepo = null;
						this.repoFileWatcher.stop();
					}
					this.isPanelVisible = this.panel.visible;
				}
			}),

			// Re-render the view when the appearance of the graph, or the language, is changed
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (this.panel.visible && (event.affectsConfiguration('git-map.graph.colourPreset') || event.affectsConfiguration('git-map.graph.colours') || event.affectsConfiguration('git-map.graph.minimap') || event.affectsConfiguration('git-map.graph.style') || event.affectsConfiguration('git-map.graph.density') || event.affectsConfiguration('git-map.graph.freezeColumnHeaders') || event.affectsConfiguration('git-map.graph.freezeFooter') || event.affectsConfiguration('git-map.graph.nodeStyle') || event.affectsConfiguration('git-map.language'))) {
					this.update();
				} else if (this.panel.visible && this.isGraphViewLoaded && event.affectsConfiguration('workbench.iconTheme')) {
					this.fileIconThemeRetries = 0;
					this.sendFileIconTheme();
				}
			}),

			// Subscribe to events triggered when a repository is added or deleted from Git Map
			repoManager.onDidChangeRepos((event) => {
				if (!this.panel.visible) return;
				const loadViewTo = event.loadRepo !== null ? { repo: event.loadRepo } : null;
				if ((event.numRepos === 0 && this.isGraphViewLoaded) || (event.numRepos > 0 && !this.isGraphViewLoaded)) {
					this.loadViewTo = loadViewTo;
					this.update();
				} else {
					this.respondLoadRepos(event.repos, loadViewTo);
				}
			}),

			// Subscribe to events triggered when an avatar is available
			avatarManager.onAvatar((event) => {
				this.sendMessage({
					command: 'fetchAvatar',
					email: event.email,
					image: event.image
				});
			}),

			// Respond to messages sent from the Webview
			this.panel.webview.onDidReceiveMessage((msg) => this.respondToMessage(msg)),

			// Dispose the Webview Panel when disposed
			this.panel
		);

		// Instantiate a RepoFileWatcher that watches for file changes in the repository currently open in the Git Map View
		this.repoFileWatcher = new RepoFileWatcher(logger, (changedPaths) => {
			if (!this.panel.visible) return;
			const repo = this.currentRepo;
			if (changedPaths === null || repo === null) {
				this.sendMessage({ command: 'refresh' });
				return;
			}
			// Changes that are only to files ignored by Git (e.g. the output of a build) don't change anything the view shows
			this.dataSource.areAllIgnored(repo, changedPaths).then((ignored) => {
				if (!ignored && this.panel.visible) this.sendMessage({ command: 'refresh' });
			});
		});

		// Render the content of the Webview
		this.update();

		this.logger.log('Created Git Map View' + (loadViewTo !== null ? ' (active repo: ' + loadViewTo.repo + ')' : ''));
	}

	/**
	 * Respond to a message sent from the front-end.
	 * @param msg The message that was received.
	 */
	private async respondToMessage(msg: RequestMessage) {
		this.repoFileWatcher.mute();
		try {
			await this.processMessage(msg);
		} catch (error) {
			// The front-end doesn't receive a response, so the error is shown here (otherwise it would only be an unhandled rejection)
			const reason = error instanceof Error ? error.message : String(error);
			this.logger.logError('Unable to process the "' + msg.command + '" message from the Git Map View: ' + reason);
			showErrorMessage(t('An unexpected error occurred while running the command "{0}".', msg.command) + ' ' + reason);
		} finally {
			this.repoFileWatcher.unmute();
		}
	}

	/**
	 * Process a message sent from the front-end (responding to it, if it has a response).
	 * @param msg The message that was received.
	 */
	private async processMessage(msg: RequestMessage) {
		let errorInfos: ErrorInfo[];

		switch (msg.command) {
			case 'addRemote':
				this.sendMessage({
					command: 'addRemote',
					error: await this.dataSource.addRemote(msg.repo, msg.name, msg.url, msg.pushUrl, msg.fetch)
				});
				break;
			case 'addTag':
				errorInfos = [await this.undoManager.trackCreateRef(msg.repo, t('Add Tag "{0}"', msg.tagName), 'refs/tags/' + msg.tagName, () => this.dataSource.addTag(msg.repo, msg.tagName, msg.commitHash, msg.type, msg.message, msg.force), (error) => error === null)];
				if (errorInfos[0] === null && msg.pushToRemote !== null) {
					errorInfos.push(...await this.dataSource.pushTag(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.pushSkipRemoteCheck));
				}
				this.sendMessage({
					command: 'addTag',
					repo: msg.repo,
					tagName: msg.tagName,
					pushToRemote: msg.pushToRemote,
					commitHash: msg.commitHash,
					errors: errorInfos
				});
				break;
			case 'applyStash':
				this.sendMessage({
					command: 'applyStash',
					error: await this.dataSource.applyStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'branchFromStash':
				this.sendMessage({
					command: 'branchFromStash',
					error: await this.dataSource.branchFromStash(msg.repo, msg.selector, msg.branchName)
				});
				break;
			case 'checkoutBranch':
				errorInfos = await this.undoManager.trackHead(msg.repo, t('Checkout "{0}"', msg.branchName), async () => {
					const errors = [await this.dataSource.checkoutBranch(msg.repo, msg.branchName, msg.remoteBranch)];
					if (errors[0] === null && msg.pullAfterwards !== null) {
						errors.push(await this.dataSource.pullBranch(msg.repo, msg.pullAfterwards.branchName, msg.pullAfterwards.remote, msg.pullAfterwards.createNewCommit, msg.pullAfterwards.squash));
					}
					return errors;
				}, (errors) => errors[0] === null);
				this.sendMessage({
					command: 'checkoutBranch',
					pullAfterwards: msg.pullAfterwards,
					errors: errorInfos
				});
				break;
			case 'checkoutCommit':
				this.sendMessage({
					command: 'checkoutCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Checkout "{0}"', abbrevCommit(msg.commitHash)), () => this.dataSource.checkoutCommit(msg.repo, msg.commitHash), (error) => error === null)
				});
				break;
			case 'cherrypickCommit':
				errorInfos = [await this.undoManager.trackHead(msg.repo, t('Cherry Pick "{0}"', abbrevCommit(msg.commitHash)), () => this.dataSource.cherrypickCommit(msg.repo, msg.commitHash, msg.parentIndex, msg.recordOrigin, msg.noCommit), (error) => error === null)];
				if (errorInfos[0] === null && msg.noCommit) {
					errorInfos.push(await viewScm());
				}
				this.sendMessage({ command: 'cherrypickCommit', errors: errorInfos });
				break;
			case 'cherrypickCommits':
				errorInfos = [await this.undoManager.trackHead(msg.repo, t('Cherry Pick {0} Commits', msg.commitHashes.length), () => this.dataSource.cherrypickCommits(msg.repo, msg.commitHashes, msg.recordOrigin, msg.noCommit), (error) => error === null)];
				if (errorInfos[0] === null && msg.noCommit) {
					errorInfos.push(await viewScm());
				}
				this.sendMessage({ command: 'cherrypickCommits', errors: errorInfos });
				break;
			case 'cleanUntrackedFiles':
				this.sendMessage({
					command: 'cleanUntrackedFiles',
					error: await this.dataSource.cleanUntrackedFiles(msg.repo, msg.directories)
				});
				break;
			case 'commitDetails':
				let data = await Promise.all([
					msg.commitHash === UNCOMMITTED
						? this.dataSource.getUncommittedDetails(msg.repo)
						: msg.stash === null
							? this.dataSource.getCommitDetails(msg.repo, msg.commitHash, msg.hasParents)
							: this.dataSource.getStashDetails(msg.repo, msg.commitHash, msg.stash),
					msg.avatarEmail !== null ? this.avatarManager.getAvatarImage(msg.avatarEmail) : Promise.resolve(null)
				]);
				this.sendMessage({
					command: 'commitDetails',
					...data[0],
					avatar: data[1],
					codeReview: msg.commitHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.commitHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'compareCommits':
				this.sendMessage({
					command: 'compareCommits',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.dataSource.getCommitComparison(msg.repo, msg.fromHash, msg.toHash),
					codeReview: msg.toHash !== UNCOMMITTED ? this.extensionState.getCodeReview(msg.repo, msg.fromHash + '-' + msg.toHash) : null,
					refresh: msg.refresh
				});
				break;
			case 'copyFilePath':
				this.sendMessage({
					command: 'copyFilePath',
					error: await copyFilePathToClipboard(msg.repo, msg.filePath, msg.absolute)
				});
				break;
			case 'copyToClipboard':
				this.sendMessage({
					command: 'copyToClipboard',
					type: msg.type,
					error: await copyToClipboard(msg.data)
				});
				break;
			case 'createArchive':
				this.sendMessage({
					command: 'createArchive',
					error: await archive(msg.repo, msg.ref, this.dataSource)
				});
				break;
			case 'createBranch':
				this.sendMessage({
					command: 'createBranch',
					errors: await this.undoManager.trackCreateRef(msg.repo, t('Create Branch "{0}"', msg.branchName), 'refs/heads/' + msg.branchName, () => this.dataSource.createBranch(msg.repo, msg.branchName, msg.commitHash, msg.checkout, msg.force), (errors) => errors[0] === null)
				});
				break;
			case 'createPullRequest':
				errorInfos = [msg.push ? await this.dataSource.pushBranch(msg.repo, msg.sourceBranch, msg.sourceRemote, true, GitPushBranchMode.Normal) : null];
				if (errorInfos[0] === null) {
					errorInfos.push(await createPullRequest(msg.config, msg.sourceOwner, msg.sourceRepo, msg.sourceBranch));
				}
				this.sendMessage({
					command: 'createPullRequest',
					push: msg.push,
					errors: errorInfos
				});
				break;
			case 'deleteBranch':
				errorInfos = [await this.undoManager.trackDeleteRef(msg.repo, t('Delete Branch "{0}"', msg.branchName), 'refs/heads/' + msg.branchName, () => this.dataSource.deleteBranch(msg.repo, msg.branchName, msg.forceDelete), (error) => error === null)];
				if (errorInfos[0] === null) {
					for (let i = 0; i < msg.deleteOnRemotes.length; i++) {
						errorInfos.push(await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.deleteOnRemotes[i]));
					}
				}
				this.sendMessage({
					command: 'deleteBranch',
					repo: msg.repo,
					branchName: msg.branchName,
					deleteOnRemotes: msg.deleteOnRemotes,
					errors: errorInfos
				});
				break;
			case 'deleteRemote':
				this.sendMessage({
					command: 'deleteRemote',
					error: await this.dataSource.deleteRemote(msg.repo, msg.name)
				});
				break;
			case 'deleteRemoteBranch':
				this.sendMessage({
					command: 'deleteRemoteBranch',
					error: await this.dataSource.deleteRemoteBranch(msg.repo, msg.branchName, msg.remote)
				});
				break;
			case 'deleteTag':
				this.sendMessage({
					command: 'deleteTag',
					error: await this.undoManager.trackDeleteRef(msg.repo, t('Delete Tag "{0}"', msg.tagName), 'refs/tags/' + msg.tagName, () => this.dataSource.deleteTag(msg.repo, msg.tagName, msg.deleteOnRemote), (error) => error === null)
				});
				break;
			case 'deleteUserDetails':
				errorInfos = [];
				if (msg.name) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, msg.location));
				}
				if (msg.email) {
					errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, msg.location));
				}
				this.sendMessage({
					command: 'deleteUserDetails',
					errors: errorInfos
				});
				break;
			case 'dropCommit':
				this.sendMessage({
					command: 'dropCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Drop "{0}"', abbrevCommit(msg.commitHash)), () => this.dataSource.dropCommit(msg.repo, msg.commitHash), (error) => error === null)
				});
				break;
			case 'dropStash':
				this.sendMessage({
					command: 'dropStash',
					error: await this.undoManager.trackDropStash(msg.repo, t('Drop Stash "{0}"', msg.selector.replace(/^refs\//, '')), msg.selector, () => this.dataSource.dropStash(msg.repo, msg.selector))
				});
				break;
			case 'editRemote':
				this.sendMessage({
					command: 'editRemote',
					error: await this.dataSource.editRemote(msg.repo, msg.nameOld, msg.nameNew, msg.urlOld, msg.urlNew, msg.pushUrlOld, msg.pushUrlNew)
				});
				break;
			case 'editUserDetails':
				errorInfos = [
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserName, msg.name, msg.location),
					await this.dataSource.setConfigValue(msg.repo, GitConfigKey.UserEmail, msg.email, msg.location)
				];
				if (errorInfos[0] === null && errorInfos[1] === null) {
					if (msg.deleteLocalName) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserName, GitConfigLocation.Local));
					}
					if (msg.deleteLocalEmail) {
						errorInfos.push(await this.dataSource.unsetConfigValue(msg.repo, GitConfigKey.UserEmail, GitConfigLocation.Local));
					}
				}
				this.sendMessage({
					command: 'editUserDetails',
					errors: errorInfos
				});
				break;
			case 'endCodeReview':
				this.extensionState.endCodeReview(msg.repo, msg.id);
				break;
			case 'exportRepoConfig':
				this.sendMessage({
					command: 'exportRepoConfig',
					error: await this.repoManager.exportRepoConfig(msg.repo)
				});
				break;
			case 'fetch':
				this.sendMessage({
					command: 'fetch',
					error: await this.dataSource.fetch(msg.repo, msg.name, msg.prune, msg.pruneTags)
				});
				break;
			case 'fetchAvatar':
				this.avatarManager.fetchAvatarImage(msg.email, msg.repo, msg.remote, msg.commits);
				break;
			case 'fetchIntoLocalBranch':
				this.sendMessage({
					command: 'fetchIntoLocalBranch',
					error: await this.dataSource.fetchIntoLocalBranch(msg.repo, msg.remote, msg.remoteBranch, msg.localBranch, msg.force)
				});
				break;
			case 'loadCommits':
				this.loadCommitsRefreshId = msg.refreshId;
				this.sendMessage({
					command: 'loadCommits',
					refreshId: msg.refreshId,
					onlyFollowFirstParent: msg.onlyFollowFirstParent,
					...await this.dataSource.getCommits(msg.repo, msg.branches, msg.maxCommits, msg.showTags, msg.showRemoteBranches, msg.includeCommitsMentionedByReflogs, msg.onlyFollowFirstParent, msg.commitOrdering, msg.remotes, msg.hideRemotes, msg.stashes, msg.authors, typeof msg.filePath === 'string' ? msg.filePath : null, typeof msg.filePath === 'string' && msg.lineRange ? msg.lineRange : null)
				});
				break;
			case 'loadConfig':
				this.sendMessage({
					command: 'loadConfig',
					repo: msg.repo,
					...await this.dataSource.getConfig(msg.repo, msg.remotes)
				});
				break;
			case 'loadRepoInfo':
				this.loadRepoInfoRefreshId = msg.refreshId;
				let repoInfo = await this.dataSource.getRepoInfo(msg.repo, msg.showRemoteBranches, msg.showStashes, msg.hideRemotes), isRepo = true;
				if (repoInfo.error) {
					// If an error occurred, check to make sure the repo still exists
					isRepo = (await this.dataSource.repoRoot(msg.repo)) !== null;
					if (!isRepo) repoInfo.error = null; // If the error is caused by the repo no longer existing, clear the error message
				}
				this.sendMessage({
					command: 'loadRepoInfo',
					refreshId: msg.refreshId,
					...repoInfo,
					isRepo: isRepo,
					undo: this.undoManager.getUndo(msg.repo)
				});
				if (msg.repo !== this.currentRepo) {
					this.currentRepo = msg.repo;
					this.extensionState.setLastActiveRepo(msg.repo);
					this.repoFileWatcher.start(msg.repo);
				}
				break;
			case 'searchCommits':
				this.sendMessage({
					command: 'searchCommits',
					id: msg.id,
					...await this.dataSource.searchCommits(msg.repo, msg.files, msg.changes, msg.isRegex, msg.isCaseSensitive, msg.since)
				});
				break;
			case 'loadCommitStats':
				this.sendMessage({
					command: 'loadCommitStats',
					...await this.dataSource.getCommitStats(msg.repo, msg.hashes)
				});
				break;
			case 'loadFileDiff':
				this.sendMessage({
					command: 'loadFileDiff',
					commitHash: msg.commitHash,
					filePath: msg.newFilePath,
					...await this.dataSource.getFileDiff(msg.repo, msg.commitHash, msg.parentHash, msg.oldFilePath, msg.newFilePath)
				});
				break;
			case 'loadStashStats':
				this.sendMessage({
					command: 'loadStashStats',
					...await this.dataSource.getStashStats(msg.repo, msg.stashes)
				});
				break;
			case 'loadFileIconTheme':
				this.sendFileIconTheme();
				break;
			case 'loadRepos':
				if (!msg.check || !await this.repoManager.checkReposExist()) {
					// If not required to check repos, or no changes were found when checking, respond with repos
					this.respondLoadRepos(this.repoManager.getRepos(), null);
				}
				break;
			case 'merge':
				this.sendMessage({
					command: 'merge',
					actionOn: msg.actionOn,
					error: await this.undoManager.trackHead(msg.repo, t('Merge "{0}"', msg.actionOn === MergeActionOn.Commit ? abbrevCommit(msg.obj) : msg.obj), () => this.dataSource.merge(msg.repo, msg.obj, msg.actionOn, msg.createNewCommit, msg.squash, msg.noCommit), (error) => error === null)
				});
				break;
			case 'navigateEditorHistory':
				if (vscode.workspace.getConfiguration('workbench.editor').get<boolean>('mouseBackForwardToNavigate', true)) {
					vscode.commands.executeCommand(msg.forward ? 'workbench.action.navigateForward' : 'workbench.action.navigateBack').then(() => { }, () => { });
				}
				break;
			case 'openExtensionSettings':
				this.sendMessage({
					command: 'openExtensionSettings',
					error: await openExtensionSettings()
				});
				break;
			case 'updateExtensionSetting':
				this.sendMessage({
					command: 'updateExtensionSetting',
					error: await updateExtensionSetting(msg.key, msg.value)
				});
				break;
			case 'openExternalDirDiff':
				this.sendMessage({
					command: 'openExternalDirDiff',
					error: await this.dataSource.openExternalDirDiff(msg.repo, msg.fromHash, msg.toHash, msg.isGui)
				});
				break;
			case 'openExternalUrl':
				this.sendMessage({
					command: 'openExternalUrl',
					error: await openExternalUrl(msg.url)
				});
				break;
			case 'openFile':
				this.sendMessage({
					command: 'openFile',
					error: await openFile(msg.repo, msg.filePath, msg.hash, this.dataSource)
				});
				break;
			case 'openTerminal':
				this.sendMessage({
					command: 'openTerminal',
					error: await this.dataSource.openGitTerminal(msg.repo, null, msg.name)
				});
				break;
			case 'popStash':
				this.sendMessage({
					command: 'popStash',
					error: await this.dataSource.popStash(msg.repo, msg.selector, msg.reinstateIndex)
				});
				break;
			case 'pruneRemote':
				this.sendMessage({
					command: 'pruneRemote',
					error: await this.dataSource.pruneRemote(msg.repo, msg.name)
				});
				break;
			case 'pullBranch':
				this.sendMessage({
					command: 'pullBranch',
					error: await this.undoManager.trackHead(msg.repo, t('Pull "{0}"', msg.remote + '/' + msg.branchName), () => this.dataSource.pullBranch(msg.repo, msg.branchName, msg.remote, msg.createNewCommit, msg.squash), (error) => error === null)
				});
				break;
			case 'pushBranch':
				this.sendMessage({
					command: 'pushBranch',
					willUpdateBranchConfig: msg.willUpdateBranchConfig,
					errors: await this.dataSource.pushBranchToMultipleRemotes(msg.repo, msg.branchName, msg.remotes, msg.setUpstream, msg.mode)
				});
				break;
			case 'pushStash':
				this.sendMessage({
					command: 'pushStash',
					error: await this.dataSource.pushStash(msg.repo, msg.message, msg.includeUntracked, msg.paths, msg.onlyStaged)
				});
				break;
			case 'pushTag':
				this.sendMessage({
					command: 'pushTag',
					repo: msg.repo,
					tagName: msg.tagName,
					remotes: msg.remotes,
					commitHash: msg.commitHash,
					errors: await this.dataSource.pushTag(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.skipRemoteCheck)
				});
				break;
			case 'rebase':
				this.sendMessage({
					command: 'rebase',
					actionOn: msg.actionOn,
					interactive: msg.interactive,
					error: msg.interactive
						? await this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive)
						: await this.undoManager.trackHead(msg.repo, t('Rebase on "{0}"', msg.actionOn === RebaseActionOn.Commit ? abbrevCommit(msg.obj) : msg.obj), () => this.dataSource.rebase(msg.repo, msg.obj, msg.actionOn, msg.ignoreDate, msg.interactive), (error) => error === null)
				});
				break;
			case 'renameBranch':
				this.sendMessage({
					command: 'renameBranch',
					error: await this.undoManager.trackRenameBranch(msg.repo, t('Rename Branch "{0}"', msg.oldName), msg.oldName, msg.newName, () => this.dataSource.renameBranch(msg.repo, msg.oldName, msg.newName))
				});
				break;
			case 'removeFilesFromHistory':
				// The command asks for confirmation itself (it isn't awaited, as it takes as long as its dialogs are open)
				vscode.commands.executeCommand('git-map.removeFilesFromHistory', { repo: msg.repo, paths: msg.filePaths }).then(() => { }, () => { });
				break;
			case 'rescanForRepos':
				if (!(await this.repoManager.searchWorkspaceForRepos())) {
					showErrorMessage(t('No Git repositories were found in the current workspace.'));
				}
				break;
			case 'resetFileToRevision':
				this.sendMessage({
					command: 'resetFileToRevision',
					error: await this.dataSource.resetFileToRevision(msg.repo, msg.commitHash, msg.filePath)
				});
				break;
			case 'resetToCommit':
				this.sendMessage({
					command: 'resetToCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Reset to "{0}"', abbrevCommit(msg.commit)), () => this.dataSource.resetToCommit(msg.repo, msg.commit, msg.resetMode), (error) => error === null)
				});
				break;
			case 'revertCommit':
				this.sendMessage({
					command: 'revertCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Revert "{0}"', abbrevCommit(msg.commitHash)), () => this.dataSource.revertCommit(msg.repo, msg.commitHash, msg.parentIndex), (error) => error === null)
				});
				break;
			case 'setGlobalViewState':
				this.sendMessage({
					command: 'setGlobalViewState',
					error: await this.extensionState.setGlobalViewState(msg.state)
				});
				break;
			case 'setRepoState':
				this.repoManager.setRepoState(msg.repo, msg.state);
				break;
			case 'setWorkspaceViewState':
				this.sendMessage({
					command: 'setWorkspaceViewState',
					error: await this.extensionState.setWorkspaceViewState(msg.state)
				});
				break;
			case 'showErrorMessage':
				showErrorMessage(msg.message);
				break;
			case 'startCodeReview':
				this.sendMessage({
					command: 'startCodeReview',
					commitHash: msg.commitHash,
					compareWithHash: msg.compareWithHash,
					...await this.extensionState.startCodeReview(msg.repo, msg.id, msg.files, msg.lastViewedFile)
				});
				break;
			case 'tagDetails':
				this.sendMessage({
					command: 'tagDetails',
					tagName: msg.tagName,
					commitHash: msg.commitHash,
					...await this.dataSource.getTagDetails(msg.repo, msg.tagName)
				});
				break;
			case 'updateCodeReview':
				this.sendMessage({
					command: 'updateCodeReview',
					error: await this.extensionState.updateCodeReview(msg.repo, msg.id, msg.remainingFiles, msg.lastViewedFile)
				});
				break;
			case 'viewDiff':
				this.sendMessage({
					command: 'viewDiff',
					error: await viewDiff(msg.repo, msg.fromHash, msg.toHash, msg.oldFilePath, msg.newFilePath, msg.type)
				});
				break;
			case 'viewDiffWithWorkingFile':
				this.sendMessage({
					command: 'viewDiffWithWorkingFile',
					error: await viewDiffWithWorkingFile(msg.repo, msg.hash, msg.filePath, this.dataSource)
				});
				break;
			case 'viewFileAtRevision':
				this.sendMessage({
					command: 'viewFileAtRevision',
					error: await viewFileAtRevision(msg.repo, msg.hash, msg.filePath)
				});
				break;
			case 'loadWorktrees':
				this.sendMessage({
					command: 'loadWorktrees',
					repo: msg.repo,
					...await this.dataSource.getWorktrees(msg.repo)
				});
				break;
			case 'addWorktree':
				errorInfos = [await this.dataSource.addWorktree(msg.repo, msg.path, msg.ref, msg.newBranch)];
				if (errorInfos[0] === null && msg.open) {
					errorInfos.push(await openFolderInNewWindow(msg.path));
				}
				this.sendMessage({ command: 'addWorktree', errors: errorInfos });
				break;
			case 'removeWorktree':
				this.sendMessage({
					command: 'removeWorktree',
					error: await this.dataSource.removeWorktree(msg.repo, msg.path, msg.force)
				});
				break;
			case 'pruneWorktrees':
				this.sendMessage({
					command: 'pruneWorktrees',
					error: await this.dataSource.pruneWorktrees(msg.repo)
				});
				break;
			case 'openWorktree':
				this.sendMessage({
					command: 'openWorktree',
					error: await openFolderInNewWindow(msg.path)
				});
				break;
			case 'loadRebaseCommits':
				this.sendMessage({
					command: 'loadRebaseCommits',
					base: msg.base,
					...await this.dataSource.getRebaseCommits(msg.repo, msg.base)
				});
				break;
			case 'rebaseInteractive':
				this.sendMessage({
					command: 'rebaseInteractive',
					error: await this.undoManager.trackHead(msg.repo, t('Rebase on "{0}"', /^[0-9a-f]{40,64}$/.test(msg.base) ? abbrevCommit(msg.base) : msg.base), () => this.dataSource.rebaseInteractive(msg.repo, msg.base, msg.todo), (error) => error === null)
				});
				break;
			case 'loadOperationInProgress':
				this.sendMessage({
					command: 'loadOperationInProgress',
					repo: msg.repo,
					operation: await this.dataSource.getOperationInProgress(msg.repo)
				});
				break;
			case 'controlOperation':
				this.sendMessage({
					command: 'controlOperation',
					action: msg.action,
					error: await this.dataSource.controlOperation(msg.repo, msg.operation, msg.action)
				});
				break;
			case 'undo':
				this.sendMessage({
					command: 'undo',
					error: await this.undoManager.undo(msg.repo)
				});
				break;
			case 'viewScm':
				this.sendMessage({
					command: 'viewScm',
					error: await viewScm()
				});
				break;
			default:
				await this.processFeatureMessage(msg);
		}
	}

	/**
	 * Process a message of the features added by Git Map: comparing branches, cleaning up branches, rewriting the latest commits,
	 * bisecting, patches, stashing parts of the uncommitted changes, the visual history of a file, and explaining commits.
	 * @param msg The message that was received.
	 */
	private async processFeatureMessage(msg: RequestMessage) {
		const signCommits = getConfig().signCommits;
		switch (msg.command) {
			case 'compareBranches': {
				const result = await this.gitFeatures.compareBranches(msg.repo, msg.left, msg.right);
				let fileChanges: ReadonlyArray<any> = [], error = result.error;
				if (result.comparison !== null) {
					// The changes of the left branch since it diverged from the right branch (what merging it would bring in)
					const from = msg.fromMergeBase !== false && result.comparison.mergeBase !== null ? result.comparison.mergeBase : result.comparison.rightHash;
					const comparison = await this.dataSource.getCommitComparison(msg.repo, from, result.comparison.leftHash);
					fileChanges = comparison.fileChanges;
					error = comparison.error;
				}
				this.sendMessage({ command: 'compareBranches', comparison: result.comparison, fileChanges: <any>fileChanges, error: error });
				break;
			}
			case 'openAllChanges':
				this.sendMessage({ command: 'openAllChanges', error: await this.openAllChanges(msg.repo, msg.title, msg.fromHash, msg.toHash, msg.fileChanges) });
				break;
			case 'loadBranchCleanup': {
				const result = await this.gitFeatures.getBranchCleanupCandidates(msg.repo);
				this.sendMessage({ command: 'loadBranchCleanup', repo: msg.repo, defaultBranch: result.defaultBranch, candidates: result.candidates, error: result.error });
				break;
			}
			case 'deleteBranches': {
				const errors: ErrorInfo[] = [];
				let deleted = 0;
				await this.undoManager.trackDeleteBranches(msg.repo, t('Delete {0} Branches', msg.branches.length), msg.branches, async () => {
					for (const branch of msg.branches) {
						const error = await this.dataSource.deleteBranch(msg.repo, branch, true);
						if (error === null) deleted++; else errors.push(error);
					}
				});
				for (const remoteBranch of msg.remoteBranches) {
					const error = await this.dataSource.deleteRemoteBranch(msg.repo, remoteBranch.branch, remoteBranch.remote);
					if (error !== null) errors.push(error);
				}
				this.sendMessage({ command: 'deleteBranches', deleted: deleted, errors: errors });
				break;
			}
			case 'loadCommitMessage': {
				const message = await this.gitFeatures.getCommitMessage(msg.repo, msg.commitHash);
				const pushedTo = message !== null ? await this.gitFeatures.getRemoteBranchContaining(msg.repo, msg.commitHash) : null;
				this.sendMessage({ command: 'loadCommitMessage', commitHash: msg.commitHash, message: message !== null ? message : '', pushedTo: pushedTo, error: message !== null ? null : t('Unable to read the message of the commit.') });
				break;
			}
			case 'editCommitMessage':
				this.sendMessage({
					command: 'editCommitMessage',
					error: await this.undoManager.trackHead(msg.repo, t('Edit Message of "{0}"', abbrevCommit(msg.commitHash)), () => this.editCommitMessage(msg.repo, msg.commitHash, msg.message, signCommits), (error) => error === null)
				});
				break;
			case 'undoCommit':
				this.sendMessage({
					command: 'undoCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Undo Commit'), () => this.gitFeatures.undoCommit(msg.repo, msg.mode), (error) => error === null, true)
				});
				break;
			case 'fixupCommit':
				this.sendMessage({
					command: 'fixupCommit',
					error: await this.undoManager.trackHead(msg.repo, t('Fix Up "{0}"', abbrevCommit(msg.commitHash)), () => this.gitFeatures.fixupCommit(msg.repo, msg.commitHash, signCommits), (error) => error === null, true)
				});
				break;
			case 'bisect':
				this.sendMessage({ command: 'bisect', action: msg.action, error: await this.gitFeatures.bisect(msg.repo, msg.action, msg.commitHash, msg.goodRef) });
				break;
			case 'loadBisectState':
				this.sendMessage({ command: 'loadBisectState', repo: msg.repo, state: await this.gitFeatures.getBisectState(msg.repo) });
				break;
			case 'viewBisectLog': {
				const file = await this.gitFeatures.getBisectLogPath(msg.repo);
				let error: ErrorInfo = file === null ? t('No bisect is in progress.') : null;
				if (file !== null) {
					try {
						await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: getConfig().openNewTabEditorGroup });
					} catch (err) {
						error = String(err);
					}
				}
				this.sendMessage({ command: 'viewBisectLog', error: error });
				break;
			}
			case 'savePatch':
				this.sendMessage({ command: 'savePatch', error: await this.savePatch(msg.repo, msg.kind, msg.hashes, msg.name, msg.copy) });
				break;
			case 'checkPatch': {
				const uris = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(msg.repo), canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: t('Apply Patch'), filters: { [t('Patches')]: ['patch', 'diff'], [t('All Files')]: ['*'] } });
				if (typeof uris === 'undefined' || uris.length === 0) {
					this.sendMessage({ command: 'checkPatch', patch: null, error: null });
				} else {
					const result = await this.gitFeatures.checkPatch(msg.repo, uris[0].fsPath);
					this.sendMessage({ command: 'checkPatch', patch: result.patch, error: result.error });
				}
				break;
			}
			case 'applyPatch':
				this.sendMessage({
					command: 'applyPatch',
					error: msg.asCommits
						? await this.undoManager.trackHead(msg.repo, t('Apply Patch'), () => this.gitFeatures.applyPatch(msg.repo, msg.file, true), (error) => error === null)
						: await this.gitFeatures.applyPatch(msg.repo, msg.file, false)
				});
				break;
			case 'loadStashableFiles': {
				const result = await this.gitFeatures.getStashableFiles(msg.repo);
				this.sendMessage({ command: 'loadStashableFiles', files: result.files, filePath: msg.filePath, stagedSupported: this.dataSource.isStashStagedSupported(), error: result.error });
				break;
			}
			case 'restoreFileFromStash': {
				const result = await this.gitFeatures.restoreFileFromStash(msg.repo, msg.stashHash, msg.filePath, msg.untracked, msg.force);
				this.sendMessage({ command: 'restoreFileFromStash', stashHash: msg.stashHash, selector: msg.selector, filePath: msg.filePath, untracked: msg.untracked, hasChanges: result.hasChanges, error: result.error });
				break;
			}
			case 'viewVisualFileHistory':
				vscode.commands.executeCommand('git-map.visualFileHistory', { repo: msg.repo, filePath: msg.filePath }).then(() => { }, () => { });
				break;
			case 'loadLanguageModels': {
				const result = await getLanguageModels();
				this.sendMessage({ command: 'loadLanguageModels', models: result.models, error: result.error });
				break;
			}
			case 'explainCommit':
				await this.explainCommit(msg.repo, msg.commitHash, msg.modelId);
				break;
		}
	}

	/**
	 * Change the message of a commit of the current branch: the commit HEAD refers to is amended, an older commit is reworded by an
	 * interactive rebase from its parent (the commits between it and HEAD can't be merges).
	 */
	private async editCommitMessage(repo: string, hash: string, message: string, sign: boolean): Promise<ErrorInfo> {
		const head = await this.gitFeatures.resolveCommit(repo, 'HEAD');
		if (head === hash) return this.gitFeatures.amendMessage(repo, message, sign);
		if (message.trim() === '') return t('The message can\'t be empty.');
		const parent = await this.gitFeatures.resolveCommit(repo, hash + '^');
		if (parent === null) return t('The message of the first commit can only be changed while it\'s the latest commit.');
		const { commits, error } = await this.dataSource.getRebaseCommits(repo, parent);
		if (error !== null) return error;
		if (commits.length === 0 || commits[0].hash !== hash) return t('Only the commits of the current branch (since its latest merge) can be changed.');
		return this.dataSource.rebaseInteractive(repo, parent, commits.map((commit) => ({ action: commit.hash === hash ? 'reword' : 'pick', hash: commit.hash, message: commit.hash === hash ? message : null })));
	}

	/**
	 * Save a patch to a file (chosen by the person), or copy it to the clipboard.
	 */
	private async savePatch(repo: string, kind: 'commits' | 'stash' | 'uncommitted', hashes: ReadonlyArray<string>, name: string, copy: boolean): Promise<ErrorInfo> {
		const result = kind === 'commits' ? await this.gitFeatures.getCommitsPatch(repo, hashes)
			: kind === 'stash' ? await this.gitFeatures.getStashPatch(repo, hashes[0])
				: await this.gitFeatures.getUncommittedPatch(repo);
		if (result.error !== null) return result.error;
		if (result.patch === '') return t('There are no changes to save as a patch.');
		if (copy) {
			const error = await copyToClipboard(result.patch);
			if (error === null) vscode.window.setStatusBarMessage(t('Copied the patch to the clipboard.'), 4000);
			return error;
		}
		const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(repo, name.replace(/[\\/:*?"<>|]/g, '-'))), saveLabel: t('Save Patch'), filters: { [t('Patches')]: ['patch'] } });
		if (typeof uri === 'undefined') return null;
		try {
			await fs.promises.writeFile(uri.fsPath, result.patch);
		} catch (error) {
			return t('Unable to save the patch: {0}', String(error));
		}
		vscode.window.setStatusBarMessage(t('Saved the patch to {0}.', uri.fsPath), 4000);
		return null;
	}

	/**
	 * Open the changes of files between two commits in one editor (the multi-file diff editor of Visual Studio Code).
	 */
	private async openAllChanges(repo: string, title: string, fromHash: string, toHash: string, fileChanges: ReadonlyArray<{ oldFilePath: string, newFilePath: string, type: GitFileStatus }>): Promise<ErrorInfo> {
		const resources = fileChanges.map((file) => [
			vscode.Uri.file(path.join(repo, file.newFilePath)),
			encodeDiffDocUri(repo, file.oldFilePath, fromHash, file.type, DiffSide.Old),
			encodeDiffDocUri(repo, file.newFilePath, toHash, file.type, DiffSide.New)
		]);
		try {
			await vscode.commands.executeCommand('vscode.changes', title, resources);
			return null;
		} catch (_) {
			return t('This version of Visual Studio Code can\'t show the changes of several files together. Click on each file to see its changes.');
		}
	}

	/**
	 * Explain a commit with a language model, sending the explanation to the front-end as it's received.
	 */
	private async explainCommit(repo: string, hash: string, modelId: string | null) {
		if (this.explainCancellation !== null) this.explainCancellation.cancel();
		const cancellation = this.explainCancellation = new vscode.CancellationTokenSource();
		const send = (text: string, done: boolean, model: string | null, truncated: boolean, error: ErrorInfo) => this.sendMessage({ command: 'explainCommit', commitHash: hash, text: text, done: done, model: model, truncated: truncated, error: error });
		if (!getConfig().explainCommit) {
			send('', true, null, false, t('Explaining commits is turned off (the "git-map.ai.explainCommit.enabled" setting).'));
			return;
		}
		const commit = await this.gitFeatures.getCommitForExplanation(repo, hash);
		if (commit.error !== null) {
			send('', true, null, false, commit.error);
			return;
		}
		let lastSent = 0;
		const result = await explainCommit(commit.text, modelId, getLanguage(), (text, model) => {
			if (Date.now() - lastSent < 150) return;
			lastSent = Date.now();
			send(text, false, model, commit.truncated, null);
		}, cancellation.token);
		// Also sent when it was cancelled (by explaining another commit), so that it doesn't look like it's still being explained
		send(result.text, true, result.model, commit.truncated, result.error);
		if (this.explainCancellation === cancellation) this.explainCancellation = null;
	}

	/**
	 * Send a message to the front-end.
	 * @param msg The message to be sent.
	 */
	private sendMessage(msg: ResponseMessage) {
		if (this.isDisposed()) {
			this.logger.log('The Git Map View has already been disposed, ignored sending "' + msg.command + '" message.');
		} else {
			this.panel.webview.postMessage(msg).then(
				() => { },
				() => {
					if (this.isDisposed()) {
						this.logger.log('The Git Map View was disposed while sending "' + msg.command + '" message.');
					} else {
						this.logger.logError('Unable to send "' + msg.command + '" message to the Git Map View.');
					}
				}
			);
		}
	}

	/**
	 * Update the HTML document loaded in the Webview.
	 */
	private update() {
		this.panel.webview.html = this.getHtmlForWebview();
	}

	/**
	 * Get the HTML document to be loaded in the Webview.
	 * @returns The HTML.
	 */
	private getHtmlForWebview() {
		const config = getConfig(), nonce = getNonce();
		const initialState: GitGraphViewInitialState = {
			config: {
				appearance: config.appearance,
				commitDetailsView: config.commitDetailsView,
				commitOrdering: config.commitOrder,
				contextMenuActionsVisibility: config.contextMenuActionsVisibility,
				customBranchGlobPatterns: config.customBranchGlobPatterns,
				customEmojiShortcodeMappings: config.customEmojiShortcodeMappings,
				customPullRequestProviders: config.customPullRequestProviders,
				dateFormat: config.dateFormat,
				defaultColumnVisibility: config.defaultColumnVisibility,
				dialogDefaults: config.dialogDefaults,
				enhancedAccessibility: config.enhancedAccessibility,
				explainCommit: config.explainCommit,
				fetchAndPrune: config.fetchAndPrune,
				fetchAndPruneTags: config.fetchAndPruneTags,
				fetchAvatars: config.fetchAvatars && this.extensionState.isAvatarStorageAvailable(),
				graph: config.graph,
				includeCommitsMentionedByReflogs: config.includeCommitsMentionedByReflogs,
				initialLoadCommits: config.initialLoadCommits,
				keybindings: config.keybindings,
				loadMoreCommits: config.loadMoreCommits,
				loadMoreCommitsAutomatically: config.loadMoreCommitsAutomatically,
				markdown: config.markdown,
				mute: config.muteCommits,
				onlyFollowFirstParent: config.onlyFollowFirstParent,
				onRepoLoad: config.onRepoLoad,
				referenceLabels: config.referenceLabels,
				repoDropdownOrder: config.repoDropdownOrder,
				showRemoteBranches: config.showRemoteBranches,
				showStashes: config.showStashes,
				showTags: config.showTags
			},
			l10n: getL10nBundle(),
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: this.loadViewTo,
			repos: this.repoManager.getRepos(),
			loadRepoInfoRefreshId: this.loadRepoInfoRefreshId,
			loadCommitsRefreshId: this.loadCommitsRefreshId
		};
		const globalState = this.extensionState.getGlobalViewState();
		const workspaceState = this.extensionState.getWorkspaceViewState();

		let body, numRepos = Object.keys(initialState.repos).length, colorVars = '', colorParams = '';
		for (let i = 0; i < initialState.config.graph.colours.length; i++) {
			colorVars += '--git-graph-color' + i + ':' + initialState.config.graph.colours[i] + '; ';
			colorParams += '[data-color="' + i + '"]{--git-graph-color:var(--git-graph-color' + i + ');} ';
		}

		if (this.dataSource.isGitExecutableUnknown()) {
			body = `<body class="unableToLoad">
			<h2>${t('Unable to load Git Map')}</h2>
			<p class="unableToLoadMessage">${t(UNABLE_TO_FIND_GIT_MSG)}</p>
			</body>`;
		} else if (numRepos > 0) {
			body = `<body>
			<div id="view" tabindex="-1">
				<div id="controls">
					<span id="repoControl"><div id="repoDropdown" class="dropdown" data-label="${t('Repo')}" data-icon="repo"></div></span>
					<span id="branchControl"><div id="branchDropdown" class="dropdown" data-label="${t('Branches')}" data-icon="branches"></div></span>
					<span id="authorControl"><div id="authorDropdown" class="dropdown" data-label="${t('Authors')}" data-icon="person"></div></span>
					<div id="stashBtn" class="controlPill hidden"></div>
					<div id="worktreeBtn" class="controlPill hidden"></div>
					<label id="showRemoteBranchesControl"><input type="checkbox" id="showRemoteBranchesCheckbox" tabindex="-1"><span class="customCheckbox"></span>${t('Show Remote Branches')}</label>
					<div id="controlsSpacer"></div>
					<div id="scrollToHeadBtn" class="controlPill" title="${t('Scroll to HEAD')}"></div>
					<div id="syncControl" role="group"><div id="fetchBtn" class="syncBtn"></div><div id="pullBtn" class="syncBtn"></div><div id="pushBtn" class="syncBtn"></div></div>
					<div id="undoBtn" class="controlBtn hidden"></div>
					<div id="refreshBtn" class="controlBtn"></div>
					<div id="terminalBtn" class="controlBtn" title="${t('Open a Terminal for this Repository')}"></div>
					<div id="settingsBtn" class="controlBtn" title="${t('Repository Settings')}"></div>
					<div id="fileHistoryBar"></div>
					<div id="compareBar"></div>
					<div id="operationBar"></div>
					<div id="minimap"></div>
				</div>
				<div id="content">
					<div id="commitGraph"></div>
					<div id="commitTable"></div>
				</div>
				<div id="footer"></div>
			</div>
			<div id="scrollShadow"></div>
			<script nonce="${nonce}">var initialState = ${serialiseForScript(initialState)}, globalState = ${serialiseForScript(globalState)}, workspaceState = ${serialiseForScript(workspaceState)};</script>
			<script nonce="${nonce}" src="${this.getMediaUri('out.min.js')}"></script>
			</body>`;
		} else {
			body = `<body class="unableToLoad">
			<h2>${t('Unable to load Git Map')}</h2>
			<p class="unableToLoadMessage">${t('No Git repositories were found in the current workspace when it was last scanned by Git Map.')}</p>
			<p>${t('If your repositories are in subfolders of the open workspace folder(s), make sure you have set the Git Map Setting "git-map.maxDepthOfRepoSearch" appropriately (read the {0} for more information).', '<a href="https://github.com/aimuch/vscode-git-map/blob/main/docs/extension-settings.md#max-depth-of-repo-search" target="_blank">' + t('documentation') + '</a>')}</p>
			<p><div id="rescanForReposBtn" class="roundedBtn">${t('Re-scan the current workspace for repositories')}</div></p>
			<script nonce="${nonce}">(function(){ var api = acquireVsCodeApi(); document.getElementById('rescanForReposBtn').addEventListener('click', function(){ api.postMessage({command: 'rescanForRepos'}); }); })();</script>
			</body>`;
		}
		this.isGraphViewLoaded = numRepos > 0;
		this.loadViewTo = null;

		return `<!DOCTYPE html>
		<html lang="${getLanguage() === 'zh-cn' ? 'zh-CN' : 'en'}">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${standardiseCspSource(this.panel.webview.cspSource)} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: ${standardiseCspSource(this.panel.webview.cspSource)}; font-src ${standardiseCspSource(this.panel.webview.cspSource)};">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link rel="stylesheet" type="text/css" href="${this.getMediaUri('out.min.css')}">
				<title>Git Map</title>
				<style>body{${colorVars}} ${colorParams}</style>
			</head>
			${body}
		</html>`;
	}


	/* URI Manipulation Methods */

	/**
	 * Get the directories that the Webview can load resources from: the extension's media, and the extensions that contribute file icon themes.
	 * @param extensionPath The absolute file path of the directory containing the extension.
	 * @returns The directories.
	 */
	private getLocalResourceRoots(extensionPath: string) {
		return [vscode.Uri.file(path.join(extensionPath, 'media'))].concat(getFileIconThemeExtensionPaths().map((extensionPath) => vscode.Uri.file(extensionPath)));
	}

	/**
	 * Send the file icon theme used by Visual Studio Code to the Webview. If its definition can't be read (e.g. while the extension that
	 * generates it is writing it, as vscode-icons does), it's sent again once it can be. It's also sent again when its definition changes.
	 */
	private sendFileIconTheme() {
		if (this.fileIconThemeRetry !== null) {
			clearTimeout(this.fileIconThemeRetry);
			this.fileIconThemeRetry = null;
		}
		const found = findFileIconTheme(), theme = found !== null ? this.getFileIconTheme(found) : null;
		this.watchFileIconTheme(found !== null ? found.path : null);
		if (found !== null && theme === null) {
			const retry = this.fileIconThemeRetries < MAX_FILE_ICON_THEME_RETRIES;
			this.logger.logError('Unable to read the file icon theme "' + found.id + '" (' + found.path + ')' + (retry ? ', it will be read again' : ''));
			if (retry) {
				this.fileIconThemeRetries++;
				this.fileIconThemeRetry = setTimeout(() => {
					this.fileIconThemeRetry = null;
					this.sendFileIconTheme();
				}, FILE_ICON_THEME_RETRY_DELAY);
			}
		} else {
			this.fileIconThemeRetries = 0;
		}
		this.sendMessage({ command: 'loadFileIconTheme', theme: theme });
	}

	/**
	 * Watch the definition of the file icon theme, sending the theme to the Webview again when it changes.
	 * @param themePath The path of the definition, or NULL to stop watching.
	 */
	private watchFileIconTheme(themePath: string | null) {
		if (themePath === this.fileIconThemeWatched) return;
		if (this.fileIconThemeWatcher !== null) {
			this.fileIconThemeWatcher.dispose();
			this.fileIconThemeWatcher = null;
		}
		this.fileIconThemeWatched = themePath;
		if (themePath === null) return;
		let timeout: NodeJS.Timeout | null = null;
		const onChange = () => {
			// The definition may be written several times in quick succession
			if (timeout !== null) clearTimeout(timeout);
			timeout = setTimeout(() => {
				timeout = null;
				this.fileIconThemeRetries = 0;
				if (this.isGraphViewLoaded) this.sendFileIconTheme();
			}, FILE_ICON_THEME_CHANGE_DELAY);
		};
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(themePath)), path.basename(themePath)));
		watcher.onDidChange(onChange);
		watcher.onDidCreate(onChange);
		this.fileIconThemeWatcher = {
			dispose: () => {
				if (timeout !== null) clearTimeout(timeout);
				watcher.dispose();
			}
		};
	}

	/**
	 * Get the file icon theme used by Visual Studio Code, with the URIs of its fonts & images converted into Webview URIs.
	 * @param theme The id of the file icon theme, and the path of its definition.
	 * @returns The file icon theme, or NULL if its definition couldn't be read.
	 */
	private getFileIconTheme(theme: { id: string, path: string }) {
		const roots = this.panel.webview.options.localResourceRoots || [];
		if (!roots.some((root) => theme.path.startsWith(root.fsPath + path.sep))) {
			// The extension contributing the file icon theme was installed after the view was opened
			this.panel.webview.options = Object.assign({}, this.panel.webview.options, { localResourceRoots: this.getLocalResourceRoots(this.extensionPath) });
		}
		return buildFileIconTheme(theme.id, theme.path, (absolutePath) => this.panel.webview.asWebviewUri(vscode.Uri.file(absolutePath)).toString(), getLanguageFiles());
	}

	/**
	 * Get a WebviewUri for a media file included in the extension.
	 * @param file The file name in the `media` directory.
	 * @returns The WebviewUri.
	 */
	private getMediaUri(file: string) {
		return this.panel.webview.asWebviewUri(this.getUri('media', file));
	}

	/**
	 * Get a File Uri for a resource file included in the extension.
	 * @param file The file name in the `resource` directory.
	 * @returns The Uri.
	 */
	private getResourcesUri(file: string) {
		return this.getUri('resources', file);
	}

	/**
	 * Get a File Uri for a file included in the extension.
	 * @param pathComps The path components relative to the root directory of the extension.
	 * @returns The File Uri.
	 */
	private getUri(...pathComps: string[]) {
		return vscode.Uri.file(path.join(this.extensionPath, ...pathComps));
	}


	/* Response Construction Methods */

	/**
	 * Send the known repositories to the front-end.
	 * @param repos The set of known repositories.
	 * @param loadViewTo What to load the view to.
	 */
	private respondLoadRepos(repos: GitRepoSet, loadViewTo: LoadGitGraphViewTo) {
		this.sendMessage({
			command: 'loadRepos',
			repos: repos,
			lastActiveRepo: this.extensionState.getLastActiveRepo(),
			loadViewTo: loadViewTo
		});
	}
}

/**
 * Serialise a value as JSON that's embedded in a script element of the Webview's HTML. "<" is escaped, so that a string in the value
 * (e.g. the name of a repository or branch, or a setting) can't end the script element (e.g. with "</script>").
 * @param value The value.
 * @returns The JSON.
 */
export function serialiseForScript(value: any) {
	const json = JSON.stringify(value);
	return typeof json === 'string' ? json.replace(/</g, '\\u003c') : 'undefined';
}

/**
 * Standardise the CSP Source provided by Visual Studio Code for use with the Webview. It is idempotent unless called with http/https URI's, in which case it keeps only the authority portion of the http/https URI. This is necessary to be compatible with some web browser environments.
 * @param cspSource The value provide by Visual Studio Code.
 * @returns The standardised CSP Source.
 */
export function standardiseCspSource(cspSource: string) {
	if (cspSource.startsWith('http://') || cspSource.startsWith('https://')) {
		const pathIndex = cspSource.indexOf('/', 8), queryIndex = cspSource.indexOf('?', 8), fragmentIndex = cspSource.indexOf('#', 8);
		let endOfAuthorityIndex = pathIndex;
		if (queryIndex > -1 && (queryIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = queryIndex;
		if (fragmentIndex > -1 && (fragmentIndex < endOfAuthorityIndex || endOfAuthorityIndex === -1)) endOfAuthorityIndex = fragmentIndex;
		return endOfAuthorityIndex > -1 ? cspSource.substring(0, endOfAuthorityIndex) : cspSource;
	} else {
		return cspSource;
	}
}
