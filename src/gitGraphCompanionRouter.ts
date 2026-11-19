import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { exportGraphSvgToFile } from './exportShare';
import { GitFeatures, buildPartialHunkPatch } from './gitFeatures';
import { t } from './l10n';
import { scanRepoWorkingTreeForIssues } from './preCommitGuard';
import { fetchPullRequestDetails, fetchRepoPullRequestBadges } from './prStatusIntegration';
import { RequestMessage, ResponseMessage } from './types';
import { UndoManager } from './undoManager';

export interface CompanionRouterContext {
	readonly dataSource: DataSource;
	readonly gitFeatures: GitFeatures;
	readonly undoManager: UndoManager;
	readonly signCommits: boolean;
	readonly sendMessage: (msg: ResponseMessage) => void;
}

const COMPANION_COMMAND_MAP: { readonly [key: string]: string } = {
	aiReview: 'git-map.ai.reviewChanges',
	aiReleaseNotes: 'git-map.ai.generateReleaseNotes',
	aiExplainRegression: 'git-map.ai.explainRegression',
	conflictAssistant: 'git-map.conflictAssistant',
	reflogExplorer: 'git-map.reflogExplorer',
	repoInsights: 'git-map.repoInsights',
	checkoutPullRequest: 'git-map.checkoutPullRequest',
	preCommitCheck: 'git-map.preCommitCheck',
	aiSmartCommitSplit: 'git-map.aiSmartCommitSplit',
	submoduleManager: 'git-map.submoduleManager',
	branchDashboard: 'git-map.branchDashboard',
	exportChangelog: 'git-map.exportChangelog'
};

/**
 * Handles companion-panel, inline staging, PR details, commit extras, macro, SVG export, and hook file messages
 * routed from GitGraphView. Returns true if the message was handled.
 */
export async function handleCompanionMessage(msg: RequestMessage, ctx: CompanionRouterContext): Promise<boolean> {
	switch (msg.command) {
		case 'loadWorkingTreeStatus': {
			const [wt, meta, preIssues] = await Promise.all([
				ctx.gitFeatures.getWorkingTreeStatus(msg.repo),
				ctx.gitFeatures.getRepoHooksAndTemplate(msg.repo),
				scanRepoWorkingTreeForIssues(ctx.dataSource, msg.repo).catch(() => [])
			]);
			ctx.sendMessage({
				command: 'loadWorkingTreeStatus',
				repo: msg.repo,
				files: wt.files,
				headMessage: wt.headMessage,
				hooks: meta.hooks,
				commitTemplate: meta.commitTemplate,
				preCommitIssues: preIssues,
				error: wt.error
			});
			return true;
		}
		case 'stageFiles':
			ctx.sendMessage({ command: 'stageFiles', error: await ctx.gitFeatures.stageFiles(msg.repo, msg.paths) });
			return true;
		case 'unstageFiles':
			ctx.sendMessage({ command: 'unstageFiles', error: await ctx.gitFeatures.unstageFiles(msg.repo, msg.paths) });
			return true;
		case 'discardWorkingChanges':
			ctx.sendMessage({ command: 'discardWorkingChanges', error: await ctx.gitFeatures.discardWorkingChanges(msg.repo, msg.trackedPaths, msg.untrackedPaths) });
			return true;
		case 'loadFileHunkDiff': {
			const hunkDiff = await ctx.gitFeatures.getFileHunkDiff(msg.repo, msg.filePath, msg.staged);
			ctx.sendMessage({ command: 'loadFileHunkDiff', filePath: msg.filePath, staged: msg.staged, diff: hunkDiff.diff, error: hunkDiff.error });
			return true;
		}
		case 'applyHunkPatch': {
			let patchToApply: string | null = typeof msg.patch === 'string' ? msg.patch : null;
			if (msg.partialSelection) {
				patchToApply = buildPartialHunkPatch(
					msg.partialSelection.diffHeader,
					msg.partialSelection.hunkHeaderLine,
					msg.partialSelection.hunkLines,
					new Set<number>(msg.partialSelection.selectedIndices),
					msg.action,
					msg.filePath
				);
			}
			const err = patchToApply === null
				? t('No changed lines were selected.')
				: await ctx.gitFeatures.applyHunkPatch(msg.repo, patchToApply, msg.action);
			ctx.sendMessage({ command: 'applyHunkPatch', filePath: msg.filePath, staged: msg.staged, error: err });
			return true;
		}
		case 'commitStagedChanges': {
			const sign = typeof msg.gpgSign === 'boolean' ? msg.gpgSign : ctx.signCommits;
			ctx.sendMessage({
				command: 'commitStagedChanges',
				error: await ctx.undoManager.trackHead(
					msg.repo,
					msg.amend ? t('Amend Commit') : t('Commit Changes'),
					() => ctx.gitFeatures.commitStagedChanges(msg.repo, msg.message, msg.amend, msg.stageAllIfEmpty, sign, { noVerify: !!msg.noVerify, signoff: !!msg.signoff }),
					(err) => err === null,
					!msg.amend
				)
			});
			return true;
		}
		case 'moveBranch':
			ctx.sendMessage({
				command: 'moveBranch',
				error: await ctx.gitFeatures.moveBranch(msg.repo, msg.branchName, msg.targetHash)
			});
			return true;
		case 'loadPullRequestBadges': {
			const badges = await fetchRepoPullRequestBadges(ctx.dataSource, msg.repo, !!msg.force);
			ctx.sendMessage({ command: 'loadPullRequestBadges', repo: msg.repo, badges: badges });
			return true;
		}
		case 'loadPullRequestDetails': {
			const details = await fetchPullRequestDetails(ctx.dataSource, msg.repo, msg.prNumber, msg.branch);
			ctx.sendMessage({ command: 'loadPullRequestDetails', branch: msg.branch, prNumber: msg.prNumber, details: details, error: null });
			return true;
		}
		case 'loadCommitExtras': {
			const [note, signatureDetails] = await Promise.all([
				ctx.gitFeatures.getCommitNote(msg.repo, msg.commitHash),
				ctx.gitFeatures.getCommitSignatureDetails(msg.repo, msg.commitHash)
			]);
			ctx.sendMessage({ command: 'loadCommitExtras', commitHash: msg.commitHash, note: note, signatureDetails: signatureDetails });
			return true;
		}
		case 'setCommitNote': {
			const err = await ctx.gitFeatures.setCommitNote(msg.repo, msg.commitHash, msg.note);
			ctx.sendMessage({ command: 'setCommitNote', commitHash: msg.commitHash, note: msg.note, error: err });
			return true;
		}
		case 'runWorkflowMacro': {
			const custom = getConfig().workflowMacros.find((m) => m.id === msg.macroId);
			const macroRes = await ctx.gitFeatures.runWorkflowMacro(msg.repo, msg.macroId, custom ? custom.steps : undefined);
			if (macroRes.error === null && macroRes.summary !== '') {
				vscode.window.setStatusBarMessage(macroRes.summary, 4000);
			}
			ctx.sendMessage({ command: 'runWorkflowMacro', macroId: msg.macroId, summary: macroRes.summary, error: macroRes.error });
			return true;
		}
		case 'exportGraphSvg':
			await exportGraphSvgToFile(msg.repo, msg.svg);
			return true;
		case 'openHookFile': {
			const meta = await ctx.gitFeatures.getRepoHooksAndTemplate(msg.repo);
			if (meta.hooks.length === 0) return true;
			let targetPath: string | null = null;
			if (typeof msg.hookPath === 'string' && meta.hooks.some((h) => h.path === msg.hookPath)) {
				targetPath = msg.hookPath;
			} else if (meta.hooks.length === 1) {
				targetPath = meta.hooks[0].path;
			} else {
				const picked = await vscode.window.showQuickPick(
					meta.hooks.map((h) => ({ label: h.name, description: h.path, hookPath: h.path })),
					{ placeHolder: t('Select a Git hook script to open in the editor') }
				);
				if (picked) targetPath = picked.hookPath;
			}
			if (targetPath !== null) {
				await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(targetPath));
			}
			return true;
		}
		case 'openCompanionFeature': {
			const payload = { repo: msg.repo, mode: msg.mode, commitHash: msg.commitHash, fromRef: msg.fromRef, toRef: msg.toRef, label: msg.label };
			if (msg.feature === 'multiRepoOverview') {
				vscode.commands.executeCommand('git-map.multiRepoOverview').then(() => { }, () => { });
			} else if (msg.feature === 'setHostingToken' || msg.feature === 'clearHostingToken') {
				await vscode.commands.executeCommand(msg.feature === 'setHostingToken' ? 'git-map.setHostingToken' : 'git-map.clearHostingToken');
				if (typeof msg.repo === 'string' && msg.repo !== '') {
					ctx.sendMessage({ command: 'loadPullRequestBadges', repo: msg.repo, badges: await fetchRepoPullRequestBadges(ctx.dataSource, msg.repo, true) });
				}
			} else {
				const cmd = COMPANION_COMMAND_MAP[msg.feature];
				if (typeof cmd === 'string') {
					vscode.commands.executeCommand(cmd, payload).then(() => { }, () => { });
				}
			}
			return true;
		}
		default:
			return false;
	}
}
