import * as path from 'path';
import * as vscode from 'vscode';
import { setApiKey } from './aiProviders';
import { getLanguageModels } from './explainCommit';
import { ExtensionState } from './extensionState';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { getPathFromUri, getRepoName, showErrorMessage } from './utils';

/**
 * Escape HTML special characters for safe interpolation inside companion Webview markup.
 */
export function escapeCompanionHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Resolve the target repository path from an optional command argument, the active text editor,
 * the last active repository, or the first known repository in the workspace.
 */
export function resolveTargetRepo(
	repoManager: RepoManager,
	extensionState: ExtensionState,
	arg?: unknown
): string | null {
	let repo: string | null = null;
	if (typeof arg === 'object' && arg !== null) {
		const obj = <{ repo?: unknown, scheme?: unknown }>arg;
		if (typeof obj.repo === 'string' && obj.repo !== '') {
			repo = obj.repo;
		} else if (obj.scheme === 'file') {
			repo = repoManager.getRepoContainingFile(getPathFromUri(<vscode.Uri>arg));
		}
	}
	if (repo === null && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
		repo = repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
	}
	if (repo === null) {
		const last = extensionState.getLastActiveRepo();
		const repos = repoManager.getRepos();
		repo = last !== null && typeof repos[last] !== 'undefined' ? last : (Object.keys(repos)[0] || null);
	}
	return repo;
}

/**
 * Resolve a relative path inside a repository, rejecting path traversal (`..`), absolute paths,
 * or leading dashes that could be interpreted as CLI options.
 */
export function resolveSafeRepoSubpath(repo: string, relPath: string): string | null {
	if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.startsWith('-')) return null;
	const repoResolved = path.resolve(repo);
	const abs = path.resolve(repoResolved, relPath);
	const rel = path.relative(repoResolved, abs);
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return abs;
}

/**
 * Select the configured AI language model, prompting for an API key or destination consent when required.
 */
export async function selectAiModelWithConsent(
	extensionState: ExtensionState,
	repo: string,
	dialogTitle?: string,
	promptText?: string
) {
	let modelsResult = await getLanguageModels();
	if (modelsResult.needsApiKey) {
		const setKeyLabel = t('Set API Key...');
		const choice = await vscode.window.showErrorMessage(modelsResult.error || t('Set an API key first.'), setKeyLabel);
		if (choice !== setKeyLabel || !(await setApiKey())) return null;
		modelsResult = await getLanguageModels();
	}
	if (modelsResult.error !== null || modelsResult.models.length === 0) {
		showErrorMessage(modelsResult.error || t('No language model is available.'));
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
					{ label: t('Continue Once'), remember: false },
					{ label: t('Always Allow for {0}', targetLabel), remember: true }
				],
				{
					title: dialogTitle || t('Git Map: AI Assistant'),
					placeHolder: promptText || t('Send Git changes from "{0}" to {1} ({2})?', getRepoName(repo), selected.name, targetLabel),
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
	return selected;
}
