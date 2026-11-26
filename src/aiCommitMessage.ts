import * as vscode from 'vscode';
import { setApiKey } from './aiProviders';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { generateCommitMessage, getLanguageModels } from './explainCommit';
import { ExtensionState } from './extensionState';
import { GitFeatures } from './gitFeatures';
import { getLanguage, t } from './l10n';
import { RepoManager } from './repoManager';
import { UNABLE_TO_FIND_GIT_MSG, copyToClipboard, getGitExtensionRepositories, getPathFromUri, getRepoName, showErrorMessage, showInformationMessage, viewScm } from './utils';

let activeGeneration: vscode.CancellationTokenSource | null = null;

/**
 * Cancel any in-progress SCM commit message generation when deactivating.
 */
export function disposeAiCommitMessage() {
	if (activeGeneration !== null) {
		activeGeneration.cancel();
		activeGeneration.dispose();
		activeGeneration = null;
	}
}

function normalisePath(repoPath: string) {
	return repoPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Generate a commit message from uncommitted changes for the Source Control input box (`git-map.ai.generateCommitMessage`).
 */
export async function generateScmCommitMessage(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, arg?: any): Promise<string | null> {
	if (!getConfig().aiCommitMessage) {
		showErrorMessage(t('Generating commit messages with AI is turned off (the "git-map.ai.commitMessage.enabled" setting).'));
		return null;
	}
	if (dataSource.isGitExecutableUnknown()) {
		showErrorMessage(t(UNABLE_TO_FIND_GIT_MSG));
		return null;
	}

	let repo: string | null = null;
	let inputBox: { value: string } | null = null;
	const invokedFromCommandPalette = typeof arg === 'undefined' || arg === null;

	if (typeof arg === 'object' && arg !== null) {
		if (arg.rootUri instanceof vscode.Uri) {
			const rawPath = getPathFromUri(arg.rootUri);
			repo = (await repoManager.getKnownRepo(rawPath)) || rawPath;
		} else if (typeof arg.repo === 'string' && arg.repo !== '') {
			repo = arg.repo;
		}
		if (typeof arg.inputBox === 'object' && arg.inputBox !== null && typeof arg.inputBox.value === 'string') {
			inputBox = arg.inputBox;
		}
	}

	const gitRepos = await getGitExtensionRepositories();

	if (repo === null) {
		if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
			repo = repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		}
	}
	if (repo === null) {
		const selected = gitRepos.find((r) => r && r.ui && r.ui.selected && r.rootUri);
		if (selected) {
			const rawPath = getPathFromUri(selected.rootUri);
			repo = (await repoManager.getKnownRepo(rawPath)) || rawPath;
			inputBox = selected.inputBox || null;
		} else if (gitRepos.length === 1 && gitRepos[0].rootUri) {
			const rawPath = getPathFromUri(gitRepos[0].rootUri);
			repo = (await repoManager.getKnownRepo(rawPath)) || rawPath;
			inputBox = gitRepos[0].inputBox || null;
		}
	}
	if (repo === null) {
		const known = repoManager.getRepos(), repoPaths = Object.keys(known);
		if (repoPaths.length === 1) {
			repo = repoPaths[0];
		} else if (repoPaths.length > 1 && typeof vscode.window.showQuickPick === 'function') {
			const picked = await vscode.window.showQuickPick(
				repoPaths.map((repoPath) => ({ label: known[repoPath].name || getRepoName(repoPath), description: repoPath, repoPath: repoPath })),
				{ placeHolder: t('Select the repository to generate a commit message for'), ignoreFocusOut: true }
			);
			if (typeof picked === 'undefined') return null;
			repo = picked.repoPath;
		}
	}
	if (repo === null) {
		showErrorMessage(t('Unable to Generate Commit Message: {0}', t('No Git repositories were found in the current workspace.')));
		return null;
	}

	if (inputBox === null) {
		const targetNorm = normalisePath(repo);
		const matched = gitRepos.find((r) => r && r.rootUri && r.inputBox && normalisePath(getPathFromUri(r.rootUri)) === targetNorm);
		if (matched) inputBox = matched.inputBox;
	}

	const gitFeatures = new GitFeatures(dataSource);
	const changes = await gitFeatures.getChangesForCommitMessage(repo);
	if (changes.error !== null) {
		showErrorMessage(t('Unable to Generate Commit Message: {0}', changes.error));
		return null;
	}
	if (changes.scope === 'none' || changes.text.trim() === '') {
		showInformationMessage(t('There are no uncommitted changes in "{0}" to generate a commit message for.', getRepoName(repo)));
		return null;
	}

	let modelsResult = await getLanguageModels('commitMessage');
	if (modelsResult.needsApiKey) {
		const setKeyLabel = t('Set API Key...');
		const choice = await vscode.window.showErrorMessage(modelsResult.error || t('Set an API key first.'), setKeyLabel);
		if (choice !== setKeyLabel || !(await setApiKey())) return null;
		modelsResult = await getLanguageModels('commitMessage');
	}
	if (modelsResult.error !== null || modelsResult.models.length === 0) {
		showErrorMessage(t('Unable to Generate Commit Message: {0}', modelsResult.error || t('No language model is available.')));
		return null;
	}

	const globalViewState = extensionState.getGlobalViewState();
	const selected = modelsResult.models.find((m) => m.id === globalViewState.explainCommitModel) || modelsResult.models[0];
	const consentTarget = selected.endpoint !== null ? 'direct:' + selected.vendor + ':' + selected.endpoint : 'vscode:' + selected.vendor;
	const targetLabel = selected.endpoint !== null ? selected.vendor + ' · ' + selected.endpoint : selected.vendor;
	if (!(globalViewState.explainCommitAccepted === true && globalViewState.explainCommitAcceptedTarget === consentTarget)) {
		if (typeof vscode.window.showQuickPick === 'function') {
			const picked = await vscode.window.showQuickPick(
				[
					{ label: t('Generate Commit Message'), remember: false },
					{ label: t('Always Allow for {0}', targetLabel), remember: true }
				],
				{
					title: t('Git Map: Generate Commit Message with AI'),
					placeHolder: t('Send the uncommitted changes of "{0}" to {1} ({2})?', getRepoName(repo), selected.name, targetLabel),
					ignoreFocusOut: true
				}
			);
			if (typeof picked === 'undefined') return null;
			if (picked.remember) {
				await extensionState.setGlobalViewState(Object.assign({}, globalViewState, {
					explainCommitAccepted: true,
					explainCommitAcceptedTarget: consentTarget
				}));
			}
		}
	}

	disposeAiCommitMessage();
	const cancellation = activeGeneration = new vscode.CancellationTokenSource();
	const previousDraft = inputBox !== null ? inputBox.value : '';
	if (invokedFromCommandPalette && inputBox !== null) {
		void viewScm();
	}

	const executeGeneration = async (progressToken?: vscode.CancellationToken): Promise<string | null> => {
		const progressDisposable = progressToken && typeof progressToken.onCancellationRequested === 'function'
			? progressToken.onCancellationRequested(() => cancellation.cancel())
			: { dispose: () => { } };
		try {
			let lastUpdated = 0;
			const result = await generateCommitMessage(changes.text, changes.recentSubjects, previousDraft, selected.id, getLanguage(), (text) => {
				if (cancellation.token.isCancellationRequested || inputBox === null) return;
				if (Date.now() - lastUpdated < 100) return;
				lastUpdated = Date.now();
				inputBox.value = text;
			}, cancellation.token);
			if (cancellation.token.isCancellationRequested) {
				if (inputBox !== null) inputBox.value = previousDraft;
				return null;
			}
			if (result.error !== null) {
				if (inputBox !== null) inputBox.value = previousDraft;
				showErrorMessage(t('Unable to Generate Commit Message: {0}', result.error));
				return null;
			}
			if (inputBox !== null) {
				inputBox.value = result.text;
			} else {
				const copyErr = await copyToClipboard(result.text);
				if (copyErr === null) vscode.window.setStatusBarMessage(t('Copied the generated commit message to the clipboard.'), 4000);
			}
			return result.text;
		} finally {
			progressDisposable.dispose();
			cancellation.dispose();
			if (activeGeneration === cancellation) activeGeneration = null;
		}
	};

	if (typeof vscode.window.withProgress === 'function') {
		const location = vscode.ProgressLocation && typeof vscode.ProgressLocation.SourceControl === 'number'
			? vscode.ProgressLocation.SourceControl
			: vscode.ProgressLocation.Notification;
		return vscode.window.withProgress({ location: location, title: t('Generating commit message…'), cancellable: true }, (_progress, token) => executeGeneration(token));
	}
	return executeGeneration();
}
