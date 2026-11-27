import { getConfig } from './config';
import { DataSource } from './dataSource';
import { t } from './l10n';
import { fetchRepoPullRequestBadges, getCachedRepoPullRequestBadges } from './prStatusIntegration';
import { RepoManager } from './repoManager';
import { LaunchpadBucket, PullRequestBadgeInfo } from './types';
import { getRepoName, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';
import * as vscode from 'vscode';

export interface LaunchpadPrItem {
	readonly repo: string;
	readonly branch: string;
	readonly badge: PullRequestBadgeInfo;
	readonly bucket: LaunchpadBucket | 'other';
}

/**
 * Classify a Pull Request badge into Launchpad action buckets (`mergeable`, `blocked`, `needsReview`, `followUp`, or `other` if stale).
 */
export function classifyPrForLaunchpad(
	badge: PullRequestBadgeInfo,
	currentUser: string,
	staleThresholdDays: number,
	nowMs: number = Date.now()
): LaunchpadBucket | 'other' {
	if (staleThresholdDays > 0 && typeof badge.updatedAt === 'string' && badge.updatedAt !== '') {
		const updated = Date.parse(badge.updatedAt);
		if (!Number.isNaN(updated) && (nowMs - updated) > staleThresholdDays * 86400000) {
			return 'other';
		}
	}
	if (badge.ciStatus === 'failure' || badge.reviewDecision === 'changes_requested' || badge.mergeable === false) {
		return 'blocked';
	}
	if (badge.state !== 'draft' && (badge.mergeQueueState !== null && typeof badge.mergeQueueState !== 'undefined' || badge.reviewDecision === 'approved' || (badge.ciStatus === 'success' && badge.reviewDecision !== 'review_required'))) {
		return 'mergeable';
	}
	if (badge.state !== 'draft' && (badge.isRequestedReviewer || badge.reviewDecision === 'review_required' || (currentUser !== '' && typeof badge.author === 'string' && badge.author !== '' && badge.author.toLowerCase() !== currentUser.toLowerCase()))) {
		return 'needsReview';
	}
	return 'followUp';
}

export class PrLaunchpad extends Disposable {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly statusBarItem: vscode.StatusBarItem;
	private readonly onOpenPrInGraph: (repo: string, branch: string) => void;
	private readonly onReviewPr: (repo: string, branch: string, badge: PullRequestBadgeInfo) => void;
	private pollTimer: NodeJS.Timeout | null = null;
	private cachedItems: LaunchpadPrItem[] = [];

	constructor(
		dataSource: DataSource,
		repoManager: RepoManager,
		onOpenPrInGraph: (repo: string, branch: string) => void,
		onReviewPr: (repo: string, branch: string, badge: PullRequestBadgeInfo) => void
	) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.onOpenPrInGraph = onOpenPrInGraph;
		this.onReviewPr = onReviewPr;
		this.statusBarItem = vscode.window.createStatusBarItem('git-map.launchpad', vscode.StatusBarAlignment.Left, -5);
		this.statusBarItem.name = t('Git Map: Pull Request Launchpad');
		this.statusBarItem.command = 'git-map.openLaunchpad';

		this.registerDisposables(
			this.statusBarItem,
			vscode.commands.registerCommand('git-map.openLaunchpad', () => this.openLaunchpad()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-map.launchpad') || e.affectsConfiguration('git-map.integrations.pullRequestStatus')) {
					this.configurePolling();
					void this.refresh(false);
				}
			}),
			repoManager.onDidChangeRepos(() => {
				void this.refresh(false);
			}),
			{
				dispose: () => {
					if (this.pollTimer !== null) {
						clearInterval(this.pollTimer);
						this.pollTimer = null;
					}
				}
			}
		);
		this.configurePolling();
		this.renderStatusBar();
	}

	private configurePolling() {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		const cfg = getConfig().launchpadConfig;
		if (!cfg.indicatorEnabled || !cfg.pollingEnabled || cfg.pollingIntervalMinutes <= 0) return;
		const intervalMs = Math.max(1, cfg.pollingIntervalMinutes) * 60000;
		this.pollTimer = setInterval(() => {
			void this.refresh(true);
		}, intervalMs);
		if (typeof this.pollTimer.unref === 'function') {
			this.pollTimer.unref();
		}
	}

	public async refresh(force: boolean = false): Promise<LaunchpadPrItem[]> {
		const cfg = getConfig().launchpadConfig;
		if (!cfg.indicatorEnabled || !getConfig().pullRequestStatusEnabled) {
			this.cachedItems = [];
			this.statusBarItem.hide();
			return [];
		}
		const repos = Object.keys(this.repoManager.getRepos());
		const collected: LaunchpadPrItem[] = [];
		for (let i = 0; i < repos.length; i++) {
			const repo = repos[i];
			const badges = force
				? await fetchRepoPullRequestBadges(this.dataSource, repo, true).catch(() => ({} as { [b: string]: PullRequestBadgeInfo }))
				: (getCachedRepoPullRequestBadges(repo) || await fetchRepoPullRequestBadges(this.dataSource, repo, false).catch(() => ({} as { [b: string]: PullRequestBadgeInfo })));
			const entries = Object.entries(badges);
			for (let j = 0; j < entries.length; j++) {
				const [branch, badge] = entries[j];
				const bucket = classifyPrForLaunchpad(badge, '', cfg.staleThresholdDays);
				collected.push({ repo: repo, branch: branch, badge: badge, bucket: bucket });
			}
		}
		this.cachedItems = collected;
		this.renderStatusBar();
		return collected;
	}

	private renderStatusBar() {
		const cfg = getConfig().launchpadConfig;
		if (!cfg.indicatorEnabled || !getConfig().pullRequestStatusEnabled) {
			this.statusBarItem.hide();
			return;
		}
		const enabledSet = new Set<LaunchpadBucket>(cfg.groups);
		const visible = this.cachedItems.filter((item) => item.bucket !== 'other' && enabledSet.has(item.bucket));
		const mergeable = visible.filter((i) => i.bucket === 'mergeable').length;
		const blocked = visible.filter((i) => i.bucket === 'blocked').length;
		const needsReview = visible.filter((i) => i.bucket === 'needsReview').length;
		const followUp = visible.filter((i) => i.bucket === 'followUp').length;

		// The highest priority group that has pull requests: blocked, then needs review, then mergeable, then follow-up
		const top: { group: LaunchpadBucket, count: number, icon: string, label: string } | null =
			blocked > 0 && enabledSet.has('blocked') ? { group: 'blocked', count: blocked, icon: '$(error)', label: t('{0} Blocked PR(s)', blocked) }
				: needsReview > 0 && enabledSet.has('needsReview') ? { group: 'needsReview', count: needsReview, icon: '$(comment-unresolved)', label: t('{0} Review PR(s)', needsReview) }
					: mergeable > 0 && enabledSet.has('mergeable') ? { group: 'mergeable', count: mergeable, icon: '$(rocket)', label: t('{0} Mergeable PR(s)', mergeable) }
						: visible.length > 0 ? { group: 'followUp', count: followUp || visible.length, icon: '$(report)', label: t('{0} PR(s)', followUp || visible.length) }
							: null;
		const icon = cfg.icon === 'group' && top !== null ? top.icon : '$(rocket)';
		const label = cfg.label === 'hidden' ? ''
			: cfg.label === 'counts' ? [blocked > 0 && enabledSet.has('blocked') ? '$(error) ' + blocked : '', needsReview > 0 && enabledSet.has('needsReview') ? '$(comment-unresolved) ' + needsReview : '', mergeable > 0 && enabledSet.has('mergeable') ? '$(check) ' + mergeable : '', followUp > 0 && enabledSet.has('followUp') ? '$(report) ' + followUp : ''].filter((s) => s !== '').join('  ') || t('PRs: 0')
				: top !== null ? top.label : t('PRs: 0');
		this.statusBarItem.text = icon + (label !== '' ? ' ' + label : '');
		this.statusBarItem.color = cfg.useColors && top !== null ? new vscode.ThemeColor(top.group === 'blocked' ? 'errorForeground' : top.group === 'needsReview' ? 'editorWarning.foreground' : top.group === 'mergeable' ? 'gitDecoration.addedResourceForeground' : 'foreground') : undefined;
		if (visible.length === 0) this.statusBarItem.tooltip = t('Git Map Launchpad: Click to inspect Pull Requests needing attention');
		this.statusBarItem.tooltip = [
			t('Mergeable: {0}', mergeable),
			t('Blocked: {0}', blocked),
			t('Needs Review: {0}', needsReview),
			t('Follow Up: {0}', followUp)
		].join(' · ');
		this.statusBarItem.show();
	}

	public async openLaunchpad(): Promise<void> {
		const items = await this.refresh(true);
		if (items.length === 0) {
			showInformationMessage(t('No open Pull Requests were found across your repositories.'));
			return;
		}
		if (typeof vscode.window.showQuickPick !== 'function') return;
		const bucketLabels: { [k in LaunchpadBucket | 'other']: string } = {
			mergeable: t('Mergeable'),
			blocked: t('Blocked'),
			needsReview: t('Needs Review'),
			followUp: t('Follow Up'),
			other: t('Stale / Other')
		};
		const picks = items.map((item) => ({
			label: '#' + item.badge.number + ' ' + item.badge.title,
			description: '[' + bucketLabels[item.bucket] + '] ' + getRepoName(item.repo) + ' · ' + item.branch,
			detail: (item.badge.baseBranch !== '' ? item.branch + ' → ' + item.badge.baseBranch + ' · ' : '') + 'CI: ' + item.badge.ciStatus,
			item: item
		}));
		const selected = await vscode.window.showQuickPick(picks, {
			title: t('Git Map Launchpad: Pull Request Triage'),
			placeHolder: t('Select a Pull Request to inspect, review, or check out'),
			ignoreFocusOut: true
		});
		if (typeof selected === 'undefined') return;
		const pr = selected.item;
		const action = await vscode.window.showQuickPick(
			[
				{ label: t('View Branch in Git Map'), id: 'graph' },
				{ label: t('Start Review Session for Pull Request'), id: 'review' },
				{ label: t('Open Pull Request in Browser'), id: 'openUrl' }
			],
			{ title: '#' + pr.badge.number + ' ' + pr.badge.title, ignoreFocusOut: true }
		);
		if (typeof action === 'undefined') return;
		if (action.id === 'graph') {
			this.onOpenPrInGraph(pr.repo, pr.branch);
		} else if (action.id === 'review') {
			this.onReviewPr(pr.repo, pr.branch, pr.badge);
		} else if (action.id === 'openUrl' && pr.badge.url !== '') {
			await vscode.env.openExternal(vscode.Uri.parse(pr.badge.url));
		}
	}
}
