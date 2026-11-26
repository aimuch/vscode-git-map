import * as vscode from 'vscode';
import { detectCodingAgents, toggleCodingAgentHooks, toggleCodingAgentMcp } from './codingAgents';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { generateStashMessage, translateNaturalLanguageToSearchQuery } from './explainCommit';
import { exportGraphSvgToFile } from './exportShare';
import { GitFeatures, buildPartialHunkPatch } from './gitFeatures';
import { getLanguage, t } from './l10n';
import { computeGuardRiskScore, scanRepoWorkingTreeForIssues } from './preCommitGuard';
import { fetchPullRequestDetails, fetchRepoPullRequestBadges } from './prStatusIntegration';
import { RepoMetadataStore } from './repoMetadataStore';
import { GitRebaseTodoItem, RequestMessage, ResponseMessage } from './types';
import { UndoManager } from './undoManager';
import { getSettingTarget } from './utils';

export interface CompanionRouterContext {
	readonly dataSource: DataSource;
	readonly gitFeatures: GitFeatures;
	readonly undoManager: UndoManager;
	readonly signCommits: boolean;
	readonly extensionPath?: string;
	readonly metadataStore?: RepoMetadataStore;
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
	exportChangelog: 'git-map.exportChangelog',
	startWork: 'git-map.startWork',
	openLaunchpad: 'git-map.openLaunchpad',
	switchMode: 'git-map.switchMode',
	aiAutoRebase: 'git-map.ai.autoRebase',
	checkRepoHealth: 'git-map.checkRepoHealth',
	editSshAllowedSigners: 'git-map.editSshAllowedSigners'
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
		case 'loadBranchCommits': {
			const res = await ctx.gitFeatures.getBranchCommits(msg.repo, msg.branch, typeof msg.maxCommits === 'number' ? msg.maxCommits : 100);
			ctx.sendMessage({ command: 'loadBranchCommits', branch: msg.branch, commits: res.commits, error: res.error });
			return true;
		}
		case 'loadRepoMetadata': {
			const meta = ctx.metadataStore ? ctx.metadataStore.getRepoMetadata(msg.repo) : { pinnedBranches: [], reviewSessions: {}, savedFilters: [] };
			ctx.sendMessage({ command: 'loadRepoMetadata', repo: msg.repo, pinnedBranches: meta.pinnedBranches, savedFilters: meta.savedFilters || [] });
			return true;
		}
		case 'togglePinBranch': {
			const pinned = ctx.metadataStore ? ctx.metadataStore.togglePinnedBranch(msg.repo, msg.branch) : [];
			ctx.sendMessage({ command: 'togglePinBranch', repo: msg.repo, pinnedBranches: pinned });
			return true;
		}
		case 'saveFilterPreset': {
			const savedFilters = ctx.metadataStore ? ctx.metadataStore.saveFilterPreset(msg.repo, msg.name, msg.query) : [];
			ctx.sendMessage({ command: 'savedFilterPresets', repo: msg.repo, savedFilters: savedFilters });
			return true;
		}
		case 'deleteFilterPreset': {
			const savedFilters = ctx.metadataStore ? ctx.metadataStore.deleteFilterPreset(msg.repo, msg.id) : [];
			ctx.sendMessage({ command: 'savedFilterPresets', repo: msg.repo, savedFilters: savedFilters });
			return true;
		}
		case 'loadWorktreeWip': {
			try {
				const res = await ctx.gitFeatures.getWorkingTreeStatus(msg.worktreePath);
				ctx.sendMessage({ command: 'loadWorktreeWip', worktreePath: msg.worktreePath, files: res.files, error: res.error });
			} catch (err) {
				ctx.sendMessage({ command: 'loadWorktreeWip', worktreePath: msg.worktreePath, files: [], error: err instanceof Error ? err.message : String(err) });
			}
			return true;
		}
		case 'loadReviewSession': {
			const data = await ctx.gitFeatures.getReviewSessionScopeFiles(msg.repo, msg.scope);
			const session = ctx.metadataStore
				? ctx.metadataStore.getReviewSession(msg.repo, data.scopeKey)
				: { scopeKey: data.scopeKey, viewedFiles: [], comments: [], updatedAt: Date.now() };
			const totalLines = data.files.reduce((acc, f) => acc + (f.additions || 0) + (f.deletions || 0), 0);
			const guardIssues = msg.scope === 'uncommitted' ? await scanRepoWorkingTreeForIssues(ctx.dataSource, msg.repo) : [];
			const riskReport = computeGuardRiskScore(guardIssues, data.files.length, totalLines);
			ctx.sendMessage({
				command: 'loadReviewSession',
				repo: msg.repo,
				scope: msg.scope,
				scopeKey: data.scopeKey,
				baseLabel: data.baseLabel,
				headLabel: data.headLabel,
				fromHash: data.fromHash,
				toHash: data.toHash,
				commitCount: data.commitCount,
				files: data.files,
				session: session,
				riskReport: riskReport,
				error: data.error
			});
			return true;
		}
		case 'updateReviewSession': {
			const session = ctx.metadataStore
				? ctx.metadataStore.updateReviewSession(msg.repo, msg.scopeKey, {
					viewedFiles: msg.viewedFiles,
					comments: msg.comments,
					clear: msg.clear
				})
				: { scopeKey: msg.scopeKey, viewedFiles: msg.viewedFiles || [], comments: msg.comments || [], updatedAt: Date.now() };
			ctx.sendMessage({ command: 'updateReviewSession', repo: msg.repo, session: session });
			return true;
		}
		case 'aiSearchCommits': {
			const cts = new vscode.CancellationTokenSource();
			try {
				const res = await translateNaturalLanguageToSearchQuery(
					msg.naturalQuery,
					msg.authors || [],
					msg.branches || [],
					typeof msg.modelId === 'string' ? msg.modelId : null,
					cts.token
				);
				ctx.sendMessage({
					command: 'aiSearchCommits',
					naturalQuery: msg.naturalQuery,
					query: res.query,
					model: res.model || '',
					error: res.error
				});
			} finally {
				cts.dispose();
			}
			return true;
		}
		case 'generateStashMessage': {
			const cts = new vscode.CancellationTokenSource();
			try {
				const diff = await ctx.gitFeatures.getChangesForCommitMessage(msg.repo);
				if (diff.error !== null) {
					ctx.sendMessage({ command: 'generateStashMessage', message: '', model: '', error: diff.error });
					return true;
				}
				if (diff.scope === 'none' || diff.text.trim() === '') {
					ctx.sendMessage({ command: 'generateStashMessage', message: '', model: '', error: t('No uncommitted changes to summarize.') });
					return true;
				}
				const res = await generateStashMessage(
					diff.text,
					typeof msg.modelId === 'string' ? msg.modelId : null,
					getLanguage(),
					cts.token
				);
				ctx.sendMessage({
					command: 'generateStashMessage',
					message: res.message,
					model: res.model || '',
					error: res.error
				});
			} finally {
				cts.dispose();
			}
			return true;
		}
		case 'restoreFilesFromCommit': {
			const err = await ctx.dataSource.restoreFilesFromCommit(msg.repo, msg.commitHash, msg.filePaths);
			ctx.sendMessage({
				command: 'restoreFilesFromCommit',
				restoredCount: err === null ? msg.filePaths.length : 0,
				error: err
			});
			return true;
		}
		case 'exportAgentContext': {
			const md = await ctx.gitFeatures.buildAgentContextMarkdown(msg.repo, msg.selectedCommitHash);
			await vscode.env.clipboard.writeText(md);
			vscode.window.setStatusBarMessage(t('Copied repository context for coding agent to clipboard.'), 4000);
			return true;
		}
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
		case 'pushToCommit': {
			const err = await ctx.dataSource.pushToCommit(msg.repo, msg.commitHash, msg.remote, msg.branchName, msg.mode);
			ctx.sendMessage({ command: 'pushToCommit', errors: err !== null ? [err] : [] });
			return true;
		}
		case 'batchSquashCommits': {
			const commitsRes = await ctx.dataSource.getRebaseCommits(msg.repo, msg.baseHash);
			if (commitsRes.error !== null) {
				ctx.sendMessage({ command: 'batchSquashCommits', error: commitsRes.error });
				return true;
			}
			const selectedSet = new Set(msg.commitHashes);
			let seenFirst = false;
			const todo: GitRebaseTodoItem[] = commitsRes.commits.map((c) => {
				if (selectedSet.has(c.hash)) {
					if (!seenFirst) {
						seenFirst = true;
						return { hash: c.hash, action: msg.message.trim() !== '' ? 'reword' : 'pick', message: msg.message.trim() !== '' ? msg.message.trim() : null };
					}
					return { hash: c.hash, action: 'squash', message: null };
				}
				return { hash: c.hash, action: 'pick', message: null };
			});
			const err = await ctx.undoManager.trackHead(
				msg.repo,
				t('Squash Selected Commits'),
				() => ctx.dataSource.rebaseInteractive(msg.repo, msg.baseHash, todo),
				(e) => e === null
			);
			ctx.sendMessage({ command: 'batchSquashCommits', error: err });
			return true;
		}
		case 'batchDropCommits': {
			const commitsRes = await ctx.dataSource.getRebaseCommits(msg.repo, msg.baseHash);
			if (commitsRes.error !== null) {
				ctx.sendMessage({ command: 'batchDropCommits', error: commitsRes.error });
				return true;
			}
			const dropSet = new Set(msg.commitHashes);
			const todo: GitRebaseTodoItem[] = commitsRes.commits.map((c) => ({
				hash: c.hash,
				action: dropSet.has(c.hash) ? 'drop' : 'pick',
				message: null
			}));
			const err = await ctx.undoManager.trackHead(
				msg.repo,
				t('Drop Selected Commits'),
				() => ctx.dataSource.rebaseInteractive(msg.repo, msg.baseHash, todo),
				(e) => e === null
			);
			ctx.sendMessage({ command: 'batchDropCommits', error: err });
			return true;
		}
		case 'aiChangelogFromCommits': {
			await vscode.commands.executeCommand('git-map.ai.generateReleaseNotes', {
				repo: msg.repo,
				fromRef: msg.fromRef,
				toRef: msg.toRef,
				label: msg.label
			});
			return true;
		}
		case 'addToGitignore': {
			const res = await ctx.gitFeatures.addToGitignore(msg.repo, msg.paths);
			ctx.sendMessage({ command: 'addToGitignore', addedCount: res.addedCount, error: res.error });
			return true;
		}
		case 'loadContributors': {
			const res = await ctx.gitFeatures.getContributors(msg.repo);
			ctx.sendMessage({ command: 'loadContributors', repo: msg.repo, contributors: res.contributors, error: res.error });
			return true;
		}
		case 'startWorkBranch': {
			await vscode.commands.executeCommand('git-map.startWork', { repo: msg.repo, id: msg.id, title: msg.title });
			return true;
		}
		case 'loadCodingAgents': {
			const agents = await detectCodingAgents(msg.repo, getConfig().defaultCodingAgent);
			ctx.sendMessage({ command: 'loadCodingAgents', repo: msg.repo, agents: agents });
			return true;
		}
		case 'toggleCodingAgentMcp': {
			const res = await toggleCodingAgentMcp(msg.repo, ctx.extensionPath || '', msg.agentId, msg.enable);
			const agents = await detectCodingAgents(msg.repo, getConfig().defaultCodingAgent);
			ctx.sendMessage({ command: 'toggleCodingAgentMcp', repo: msg.repo, agents: agents, error: res.error });
			return true;
		}
		case 'toggleCodingAgentHooks': {
			const res = await toggleCodingAgentHooks(msg.repo, msg.agentId, msg.enable);
			const agents = await detectCodingAgents(msg.repo, getConfig().defaultCodingAgent);
			ctx.sendMessage({ command: 'toggleCodingAgentHooks', repo: msg.repo, agents: agents, error: res.error });
			return true;
		}
		case 'copyWipToWorktree': {
			const res = await ctx.gitFeatures.copyWipToWorktree(msg.repo, msg.targetWorktreePath);
			ctx.sendMessage({ command: 'copyWipToWorktree', copiedFiles: res.copiedFiles, error: res.error });
			return true;
		}
		case 'saveExtendedSettings': {
			const cfg = vscode.workspace.getConfiguration('git-map');
			const keys = Object.keys(msg.settings || {});
			const updatedKeys: string[] = [];
			try {
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i];
					const val = msg.settings[k];
					const target = getSettingTarget(cfg, k);
					await cfg.update(k, val, target);
					updatedKeys.push(k);
				}
				ctx.sendMessage({ command: 'saveExtendedSettings', updatedKeys: updatedKeys, error: null });
			} catch (err) {
				ctx.sendMessage({ command: 'saveExtendedSettings', updatedKeys: updatedKeys, error: err instanceof Error ? err.message : String(err) });
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
