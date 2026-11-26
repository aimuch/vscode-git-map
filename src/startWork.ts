import * as vscode from 'vscode';
import { formatStartWorkBranchName } from './autolinks';
import { resolveTargetRepo } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { GitGraphView } from './gitGraphView';
import { showErrorMessage, showInformationMessage } from './utils';

export interface StartWorkInput {
	readonly repo?: string;
	readonly id?: string;
	readonly title?: string;
	readonly baseCommit?: string;
}

/**
 * Start Work on an issue/ticket by creating and checking out a formatted Git branch (`git-map.startWork.branchNameFormat`).
 */
export async function startWorkCommand(
	dataSource: DataSource,
	repoManager: RepoManager,
	extensionState: ExtensionState,
	arg?: StartWorkInput | unknown
): Promise<string | null> {
	const input: StartWorkInput = typeof arg === 'object' && arg !== null ? arg as StartWorkInput : {};
	const repo = input.repo || resolveTargetRepo(repoManager, extensionState, arg);
	if (repo === null) {
		showErrorMessage(t('No Git repositories were found in the current workspace.'));
		return null;
	}

	let issueId = typeof input.id === 'string' ? input.id.trim() : '';
	let issueTitle = typeof input.title === 'string' ? input.title.trim() : '';

	if (issueId === '') {
		const rawId = await vscode.window.showInputBox({
			title: t('Start Work: Issue ID'),
			prompt: t('Enter an issue ID (e.g. PROJ-123 or #42), or "ID Title" together'),
			ignoreFocusOut: true,
			validateInput: (val) => val.trim() === '' ? t('Issue ID cannot be empty.') : null
		});
		if (typeof rawId !== 'string' || rawId.trim() === '') return null;
		const trimmed = rawId.trim();
		const spaceIdx = trimmed.indexOf(' ');
		if (spaceIdx > 0 && issueTitle === '') {
			issueId = trimmed.substring(0, spaceIdx).trim();
			issueTitle = trimmed.substring(spaceIdx + 1).trim();
		} else {
			issueId = trimmed;
		}
	}

	if (issueTitle === '' && typeof input.title !== 'string') {
		const rawTitle = await vscode.window.showInputBox({
			title: t('Start Work: Issue Title (Optional)'),
			prompt: t('Short description for branch slug (e.g. update login flow)'),
			ignoreFocusOut: true
		});
		if (typeof rawTitle === 'undefined') return null;
		issueTitle = rawTitle.trim();
	}

	const template = getConfig(repo).startWorkBranchFormat;
	const suggestedBranch = formatStartWorkBranchName(template, issueId, issueTitle);

	let finalBranch = suggestedBranch;
	if (typeof input.id !== 'string') {
		const confirmed = await vscode.window.showInputBox({
			title: t('Start Work: Branch Name'),
			prompt: t('Review or edit the branch name created from template "{0}"', template),
			value: suggestedBranch,
			ignoreFocusOut: true,
			validateInput: (val) => val.trim() === '' ? t('Branch name cannot be empty.') : null
		});
		if (typeof confirmed !== 'string' || confirmed.trim() === '') return null;
		finalBranch = formatStartWorkBranchName('${id}', confirmed.trim(), '');
	}

	const errs = await dataSource.createBranch(repo, finalBranch, input.baseCommit || 'HEAD', true, false);
	const err = errs.find((e) => e !== null) || null;
	if (err !== null) {
		showErrorMessage(err);
		return null;
	}
	showInformationMessage(t('Created and checked out branch "{0}".', finalBranch));
	if (GitGraphView.currentPanel) {
		GitGraphView.currentPanel.sendRefreshIfRepo(repo);
	}
	return finalBranch;
}
