import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { GitCodeLens } from './codeLens';
import { CommandManager } from './commands';
import { getConfig, saveSettingFallback, setSettingFallbackStorage } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { EscapeStack } from './escapeStack';
import { ExtensionState } from './extensionState';
import { FileBlame } from './fileBlame';
import { FileTimeMachine } from './fileTimeMachine';
import { GitGraphView } from './gitGraphView';
import { LineBlame } from './lineBlame';
import { LineHistory } from './lineHistory';
import { Logger } from './logger';
import { MultiRepoOverview } from './multiRepoOverview';
import { ReflogExplorer } from './reflogExplorer';
import { RemoveFromHistory } from './removeFromHistory';
import { RepoInsights } from './repoInsights';
import { RepoManager } from './repoManager';
import { RevisionNavigation } from './revisionNavigation';
import { VisualFileHistory } from './visualFileHistory';
import { AiAssistantPanel } from './aiAssistantPanel';
import { disposeAiCommitMessage, generateScmCommitMessage } from './aiCommitMessage';
import { clearApiKey, setAiSecretStorage, setApiKey } from './aiProviders';
import { BranchDashboard } from './branchDashboard';
import { CompactPanelView } from './compactPanelView';
import { ConflictAssistant } from './conflictAssistant';
import { exportChangelogCommand } from './exportShare';
import { PreCommitAndSplitter } from './preCommitGuard';
import { checkoutPullRequestCommand, clearHostingTokenCommand, setHostingSecretStorage, setHostingTokenCommand } from './prStatusIntegration';
import { SubmoduleManager } from './submoduleManager';
import { migrateSettings, showSettingsMigrationMessage } from './settingsMigration';
import { StatusBarItem } from './statusBarItem';
import { GitExecutable, UNABLE_TO_FIND_GIT_MSG, findGit, getGitExecutableFromPaths, isInternalHideUnchangedWrite, setDiffHideUnchangedRegions, showErrorMessage, showInformationMessage } from './utils';
import { EventEmitter } from './utils/event';
import { t } from './l10n';

/**
 * Activate Git Map.
 * @param context The context of the extension.
 */
export async function activate(context: vscode.ExtensionContext) {
	const logger = new Logger();
	logger.log('Starting Git Map ...');

	const gitExecutableEmitter = new EventEmitter<GitExecutable>();
	const onDidChangeGitExecutable = gitExecutableEmitter.subscribe;

	const extensionState = new ExtensionState(context, onDidChangeGitExecutable);

	// The Extension Settings are copied from git-graph.* to git-map.* before anything reads them. Git is found at the same time (it's
	// configured by the "git.path" setting of Visual Studio Code, not by Git Map's settings).
	const [settingsMigration, foundGit] = await Promise.all([
		migrateSettings(context.globalState, context.workspaceState, context.extension.packageJSON, logger),
		findGit(extensionState).then((executable) => executable, () => null)
	]);

	const gitExecutable: GitExecutable | null = foundGit;
	if (gitExecutable !== null) {
		gitExecutableEmitter.emit(gitExecutable);
		logger.log('Using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
	} else {
		showErrorMessage(t(UNABLE_TO_FIND_GIT_MSG));
		logger.logError(UNABLE_TO_FIND_GIT_MSG);
	}

	const configurationEmitter = new EventEmitter<vscode.ConfigurationChangeEvent>();
	const onDidChangeConfiguration = configurationEmitter.subscribe;
	const gitStateEmitter = new EventEmitter<void>();
	const onDidChangeGitState = gitStateEmitter.subscribe;
	let gitStateTimeout: NodeJS.Timeout | null = null;
	const notifyGitStateChanged = () => {
		if (gitStateTimeout !== null) clearTimeout(gitStateTimeout);
		gitStateTimeout = setTimeout(() => {
			gitStateTimeout = null;
			gitStateEmitter.emit();
		}, 300);
	};
	const gitStateWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index,packed-refs,refs/**}');
	gitStateWatcher.onDidChange(notifyGitStateChanged);
	gitStateWatcher.onDidCreate(notifyGitStateChanged);
	gitStateWatcher.onDidDelete(notifyGitStateChanged);

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);
	const lineBlame = new LineBlame(dataSource, repoManager, onDidChangeConfiguration, logger, onDidChangeGitState);
	const escapeStack = new EscapeStack();
	const lineHistory = new LineHistory(dataSource, repoManager, avatarManager, onDidChangeConfiguration, logger);
	const fileBlame = new FileBlame(dataSource, repoManager, logger, onDidChangeConfiguration, onDidChangeGitState);
	const revisionNavigation = new RevisionNavigation(dataSource, repoManager);
	const codeLens = new GitCodeLens(dataSource, repoManager, onDidChangeConfiguration, onDidChangeGitState);
	const removeFromHistory = new RemoveFromHistory(context, dataSource, repoManager, logger);
	const visualFileHistory = new VisualFileHistory(dataSource, repoManager, logger);
	const fileTimeMachine = new FileTimeMachine(dataSource, repoManager, logger);
	setAiSecretStorage(context.secrets);
	setHostingSecretStorage(context.secrets);
	setSettingFallbackStorage(context.globalState);
	const aiAssistantPanel = new AiAssistantPanel(dataSource, repoManager, extensionState, logger);
	const conflictAssistant = new ConflictAssistant(dataSource, repoManager, extensionState, logger);
	const reflogExplorer = new ReflogExplorer(dataSource, repoManager, extensionState, logger);
	const repoInsights = new RepoInsights(dataSource, repoManager, extensionState, logger);
	const multiRepoOverview = new MultiRepoOverview(dataSource, repoManager, logger);
	const preCommitAndSplitter = new PreCommitAndSplitter(dataSource, repoManager, extensionState, logger);
	const compactPanelView = new CompactPanelView(dataSource, repoManager, extensionState, logger, onDidChangeGitState);
	const submoduleManager = new SubmoduleManager(dataSource, repoManager, extensionState, logger);
	const branchDashboard = new BranchDashboard(dataSource, repoManager, extensionState, logger);

	const applyDiffViewMode = async (onlyChanges: boolean) => {
		await setDiffHideUnchangedRegions(onlyChanges);
		GitGraphView.notifyCdvConfigChanged();
		vscode.window.setStatusBarMessage(onlyChanges ? t('Diff View: Changes Only') : t('Diff View: Full File'), 3000);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('git-map.ai.generateCommitMessage', (arg?: unknown) => generateScmCommitMessage(dataSource, repoManager, extensionState, arg)),
		vscode.commands.registerCommand('git-map.ai.setApiKey', (key?: unknown) => setApiKey(key)),
		vscode.commands.registerCommand('git-map.ai.clearApiKey', () => clearApiKey()),
		vscode.commands.registerCommand('git-map.setHostingToken', () => setHostingTokenCommand()),
		vscode.commands.registerCommand('git-map.clearHostingToken', () => clearHostingTokenCommand()),
		vscode.commands.registerCommand('git-map.checkoutPullRequest', (arg?: unknown) => checkoutPullRequestCommand(dataSource, repoManager, extensionState, arg)),
		vscode.commands.registerCommand('git-map.exportChangelog', (arg?: unknown) => exportChangelogCommand(dataSource, repoManager, extensionState, arg)),
		vscode.commands.registerCommand('git-map.diff.showChangesOnly', () => applyDiffViewMode(true)),
		vscode.commands.registerCommand('git-map.diff.showFullFile', () => applyDiffViewMode(false)),
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-map.commitDetailsView.actions')) {
				void saveSettingFallback('commitDetailsView.actions', undefined);
			}
			if (event.affectsConfiguration('git-map.commitRow.actions')) {
				void saveSettingFallback('commitRow.actions', undefined);
			}
			if (event.affectsConfiguration('git-map.commitRow.actionsPosition')) {
				void saveSettingFallback('commitRow.actionsPosition', undefined);
			}
			if (!isInternalHideUnchangedWrite()) {
				if (event.affectsConfiguration('git-map.diff.hideUnchangedRegions')) {
					void saveSettingFallback('diff.hideUnchangedRegions', undefined);
					const enabled = !!vscode.workspace.getConfiguration('git-map').get('diff.hideUnchangedRegions', false);
					void setDiffHideUnchangedRegions(enabled);
				} else if (event.affectsConfiguration('diffEditor.hideUnchangedRegions.enabled')) {
					const enabled = !!vscode.workspace.getConfiguration('diffEditor').get('hideUnchangedRegions.enabled', false);
					if (getConfig().commitDetailsView.hideUnchangedRegions !== enabled) {
						void setDiffHideUnchangedRegions(enabled).then(() => GitGraphView.notifyCdvConfigChanged());
					}
				}
			}
			// Skip emitting configurationEmitter when only UI-only CDV/diff settings changed so DataSource/Blame don't respawn git processes
			if (event.affectsConfiguration('git-map') && !isInternalHideUnchangedWrite()) {
				configurationEmitter.emit(event);
			} else if (event.affectsConfiguration('git.path')) {
				const paths = getConfig().gitPaths;
				if (paths.length === 0) return;

				getGitExecutableFromPaths(paths).then((gitExecutable) => {
					gitExecutableEmitter.emit(gitExecutable);
					showInformationMessage(t('Git Map is now using {0} (version: {1})', gitExecutable.path, gitExecutable.version));
					logger.log('Git Map is now using ' + gitExecutable.path + ' (version: ' + gitExecutable.version + ')');
					repoManager.searchWorkspaceForRepos();
				}, () => {
					const msg = 'The new value of "git.path" ("' + paths.join('", "') + '") does not ' + (paths.length > 1 ? 'contain a string that matches' : 'match') + ' the path and filename of a valid Git executable.';
					showErrorMessage(paths.length > 1
						? t('The new value of "git.path" ("{0}") does not contain a string that matches the path and filename of a valid Git executable.', paths.join('", "'))
						: t('The new value of "git.path" ("{0}") does not match the path and filename of a valid Git executable.', paths.join('", "')));
					logger.logError(msg);
				});
			}
		}),
		{
			dispose: () => {
				disposeAiCommitMessage();
				if (gitStateTimeout !== null) clearTimeout(gitStateTimeout);
				gitStateWatcher.dispose();
			}
		},
		gitStateEmitter,
		diffDocProvider,
		lineBlame,
		escapeStack,
		lineHistory,
		fileBlame,
		revisionNavigation,
		codeLens,
		removeFromHistory,
		visualFileHistory,
		fileTimeMachine,
		aiAssistantPanel,
		conflictAssistant,
		reflogExplorer,
		repoInsights,
		multiRepoOverview,
		preCommitAndSplitter,
		compactPanelView,
		submoduleManager,
		branchDashboard,
		commandManager,
		statusBarItem,
		repoManager,
		avatarManager,
		dataSource,
		configurationEmitter,
		extensionState,
		gitExecutableEmitter,
		logger
	);
	logger.log('Started Git Map - Ready to use!');
	showSettingsMigrationMessage(settingsMigration, logger);

	extensionState.expireOldCodeReviews();
}

/**
 * Deactivate Git Map.
 */
export function deactivate() { }
