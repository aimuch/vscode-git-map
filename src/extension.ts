import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { GitCodeLens } from './codeLens';
import { CommandManager } from './commands';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider } from './diffDocProvider';
import { EscapeStack } from './escapeStack';
import { ExtensionState } from './extensionState';
import { FileBlame } from './fileBlame';
import { LineBlame } from './lineBlame';
import { LineHistory } from './lineHistory';
import { Logger } from './logger';
import { RemoveFromHistory } from './removeFromHistory';
import { RepoManager } from './repoManager';
import { RevisionNavigation } from './revisionNavigation';
import { migrateSettings, showSettingsMigrationMessage } from './settingsMigration';
import { StatusBarItem } from './statusBarItem';
import { GitExecutable, UNABLE_TO_FIND_GIT_MSG, findGit, getGitExecutableFromPaths, showErrorMessage, showInformationMessage } from './utils';
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

	const dataSource = new DataSource(gitExecutable, onDidChangeConfiguration, onDidChangeGitExecutable, logger);
	const avatarManager = new AvatarManager(dataSource, extensionState, logger);
	const repoManager = new RepoManager(dataSource, extensionState, onDidChangeConfiguration, logger);
	const statusBarItem = new StatusBarItem(repoManager.getNumRepos(), repoManager.onDidChangeRepos, onDidChangeConfiguration, logger);
	const commandManager = new CommandManager(context, avatarManager, dataSource, extensionState, repoManager, gitExecutable, onDidChangeGitExecutable, logger);
	const diffDocProvider = new DiffDocProvider(dataSource);
	const lineBlame = new LineBlame(dataSource, repoManager, onDidChangeConfiguration, logger);
	const escapeStack = new EscapeStack();
	const lineHistory = new LineHistory(dataSource, repoManager, avatarManager, onDidChangeConfiguration, logger);
	const fileBlame = new FileBlame(dataSource, repoManager, logger);
	const revisionNavigation = new RevisionNavigation(dataSource, repoManager);
	const codeLens = new GitCodeLens(dataSource, repoManager, onDidChangeConfiguration);
	const removeFromHistory = new RemoveFromHistory(context, dataSource, repoManager, logger);

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(DiffDocProvider.scheme, diffDocProvider),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('git-map')) {
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
		diffDocProvider,
		lineBlame,
		escapeStack,
		lineHistory,
		fileBlame,
		revisionNavigation,
		codeLens,
		removeFromHistory,
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
