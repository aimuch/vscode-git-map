import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { GitFeatures } from './gitFeatures';
import { t } from './l10n';
import { getCachedRepoPullRequestBadges } from './prStatusIntegration';
import { RepoManager } from './repoManager';
import { CommitOrdering } from './types';
import { abbrevCommit, formatDatePattern, getRelativeTimeDiff, getRepoName } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

export type ScmSectionId =
	| 'commits'
	| 'branches'
	| 'remotes'
	| 'stashes'
	| 'tags'
	| 'worktrees'
	| 'contributors'
	| 'repositories'
	| 'searchAndCompare'
	| 'launchpad'
	| 'fileHistory';

export interface ScmTreeNode {
	readonly kind: 'section' | 'item' | 'info';
	readonly sectionId: ScmSectionId;
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly tooltip?: string | vscode.MarkdownString;
	readonly iconId: string;
	readonly collapsibleState: vscode.TreeItemCollapsibleState;
	readonly command?: vscode.Command;
}

/**
 * Format a label/description string for an SCM Tree node from `${var}`, `${prefix|var}`, `${'prefix'var}`, or `${var, }` tokens.
 */
export function formatScmNodeTemplate(template: string, vars: { readonly [key: string]: string | undefined }): string {
	const lookup = (key: string): string => {
		if (key === 'agoOrDate') {
			return vars.agoOrDate ?? vars.ago ?? vars.date ?? '';
		}
		return vars[key] ?? '';
	};
	return template
		.replace(/\$\{'([^']*)'([a-zA-Z0-9_]+)\}/g, (_, prefix: string, key: string) => {
			const v = lookup(key);
			return v !== '' ? prefix + v : '';
		})
		.replace(/\$\{([^|{}]+)\|([a-zA-Z0-9_]+)\}/g, (_, prefix: string, key: string) => {
			const v = lookup(key);
			return v !== '' ? prefix + v : '';
		})
		.replace(/\$\{([a-zA-Z0-9_]+)([^a-zA-Z0-9_|{}]+)\}/g, (_, key: string, suffix: string) => {
			const v = lookup(key);
			return v !== '' ? v + suffix : '';
		})
		.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => lookup(key))
		.replace(/\$\{[^}]+\}/g, '')
		.trim();
}

/**
 * Get the tokens of a commit for the formats of the Git Map SCM view: `${message}`, `${author}`, `${ago}`, `${date}`, `${agoOrDate}`,
 * `${sha}` & `${id}`.
 */
function getCommitVars(hash: string, message: string, author: string, date: number): { [key: string]: string } {
	const shortSha = abbrevCommit(hash), cfg = getConfig();
	const ago = getRelativeTimeDiff(date), absolute = formatDatePattern(date, cfg.defaultDateFormat !== '' ? cfg.defaultDateFormat : cfg.defaultDateShortFormat, cfg.defaultDateLocale);
	return {
		message: message || shortSha,
		author: author,
		ago: ago,
		date: absolute,
		agoOrDate: cfg.blameDateStyle === 'absolute' ? absolute : ago,
		agoAndDate: ago + ' (' + absolute + ')',
		id: shortSha,
		sha: shortSha
	};
}

/**
 * Get the tooltip of a node from its Markdown format (`views.commits.tooltipFormat` / `views.stashes.tooltipFormat`).
 */
function getTooltip(format: string, vars: { readonly [key: string]: string | undefined }) {
	const markdown = new vscode.MarkdownString(formatScmNodeTemplate(format.replace(/\\n/g, '\n'), vars), true);
	markdown.isTrusted = false;
	return markdown;
}

const SECTION_DEFS: ReadonlyArray<{ readonly id: ScmSectionId, readonly labelKey: string, readonly iconId: string }> = [
	{ id: 'commits', labelKey: 'Commits', iconId: 'git-commit' },
	{ id: 'branches', labelKey: 'Branches', iconId: 'git-branch' },
	{ id: 'remotes', labelKey: 'Remotes', iconId: 'cloud' },
	{ id: 'stashes', labelKey: 'Stashes', iconId: 'archive' },
	{ id: 'tags', labelKey: 'Tags', iconId: 'tag' },
	{ id: 'worktrees', labelKey: 'Worktrees', iconId: 'list-tree' },
	{ id: 'contributors', labelKey: 'Contributors', iconId: 'organization' },
	{ id: 'repositories', labelKey: 'Repositories', iconId: 'repo' },
	{ id: 'searchAndCompare', labelKey: 'Search & Compare', iconId: 'search' },
	{ id: 'launchpad', labelKey: 'Launchpad PRs', iconId: 'rocket' },
	{ id: 'fileHistory', labelKey: 'File History', iconId: 'history' }
];

const SCM_ICON_COLORS: { readonly [iconId: string]: string } = {
	'git-commit': 'charts.blue',
	'git-branch': 'charts.purple',
	'cloud': 'charts.blue',
	'archive': 'charts.yellow',
	'tag': 'charts.orange',
	'list-tree': 'charts.green',
	'organization': 'charts.blue',
	'repo': 'charts.blue',
	'search': 'charts.purple',
	'rocket': 'charts.orange',
	'history': 'charts.green',
	'file': 'charts.blue',
	'diff': 'charts.blue',
	'account': 'charts.purple'
};

/**
 * Native VS Code Source Control grouped Tree View provider (`git-map.scmView`).
 */
export class ScmTreeViewProvider extends Disposable implements vscode.TreeDataProvider<ScmTreeNode> {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly gitFeatures: GitFeatures;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ScmTreeNode | undefined>();
	public readonly onDidChangeTreeData: vscode.Event<ScmTreeNode | undefined> = this.onDidChangeTreeDataEmitter.event;

	constructor(
		dataSource: DataSource,
		repoManager: RepoManager,
		extensionState: ExtensionState,
		onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>,
		onDidChangeGitState: Event<void>
	) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.gitFeatures = new GitFeatures(dataSource);

		const disposables: vscode.Disposable[] = [
			this.onDidChangeTreeDataEmitter,
			vscode.commands.registerCommand('git-map.scmView.refresh', () => this.refresh())
		];
		if (typeof vscode.window.createTreeView === 'function') {
			disposables.push(vscode.window.createTreeView('git-map.scmView', {
				treeDataProvider: this,
				showCollapseAll: true
			}));
		}
		if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
			disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.refresh()));
		}
		this.registerDisposables(...disposables);
		this.registerDisposable(repoManager.onDidChangeRepos(() => this.refresh()));
		onDidChangeGitState(() => this.refresh());
		onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('git-map.views') || e.affectsConfiguration('git-map.ui.iconColorStyle')) this.refresh();
		});
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	public getTreeItem(element: ScmTreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, element.collapsibleState);
		item.id = element.id;
		item.description = element.description;
		item.tooltip = element.tooltip;
		const iconColor = getConfig().iconColorStyle === 'colorful' ? SCM_ICON_COLORS[element.iconId] : undefined;
		item.iconPath = iconColor ? new vscode.ThemeIcon(element.iconId, new vscode.ThemeColor(iconColor)) : new vscode.ThemeIcon(element.iconId);
		if (element.command) item.command = element.command;
		return item;
	}

	public async getChildren(element?: ScmTreeNode): Promise<ScmTreeNode[]> {
		const cfg = getConfig().scmViewsConfig;
		if (!cfg.enabled) return [];

		const repo = this.resolveActiveRepo();
		if (repo === null) {
			return element ? [] : [{
				kind: 'info',
				sectionId: 'commits',
				id: 'scm-no-repo',
				label: t('No Git repository found'),
				iconId: 'info',
				collapsibleState: vscode.TreeItemCollapsibleState.None
			}];
		}

		if (!element) {
			const hidden = new Set(cfg.hiddenSections);
			const repoName = getRepoName(repo);
			const defaultSec = cfg.defaultSection || 'commits';
			return SECTION_DEFS
				.filter((s) => !hidden.has(s.id))
				.map((s) => ({
					kind: 'section',
					sectionId: s.id,
					id: 'section:' + s.id,
					label: t(s.labelKey),
					description: repoName,
					iconId: s.iconId,
					collapsibleState: s.id === defaultSec
						? vscode.TreeItemCollapsibleState.Expanded
						: vscode.TreeItemCollapsibleState.Collapsed
				}));
		}

		if (element.kind !== 'section') return [];
		return this.loadSectionItems(repo, element.sectionId);
	}

	private resolveActiveRepo(): string | null {
		const repos = this.repoManager.getRepos();
		const last = this.extensionState.getLastActiveRepo();
		if (last !== null && typeof repos[last] !== 'undefined') return last;
		const keys = Object.keys(repos);
		return keys.length > 0 ? keys[0] : null;
	}

	private async loadSectionItems(repo: string, sectionId: ScmSectionId): Promise<ScmTreeNode[]> {
		const cfg = getConfig().scmViewsConfig;
		try {
			switch (sectionId) {
				case 'commits': {
					const data = await this.dataSource.getCommits(
						repo, null, 25, true, false, false, false, CommitOrdering.Date, [], [], []
					);
					return data.commits.map((c) => {
						const shortSha = abbrevCommit(c.hash);
						const vars = getCommitVars(c.hash, c.message, c.author, c.date);
						return {
							kind: 'item',
							sectionId: 'commits',
							id: 'commit:' + c.hash,
							label: formatScmNodeTemplate(cfg.commitLabelFormat, vars) || c.message || shortSha,
							description: formatScmNodeTemplate(cfg.commitDescriptionFormat, vars),
							tooltip: cfg.commitTooltipFormat !== '' ? getTooltip(cfg.commitTooltipFormat, vars) : c.hash + '\n' + c.message + '\n' + c.author,
							iconId: 'git-commit',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.viewCommitInGitMap',
								title: t('View Commit in Git Map'),
								arguments: [repo, c.hash]
							}
						};
					});
				}
				case 'branches': {
					const info = await this.dataSource.getRepoInfo(repo, true, false, []);
					return info.branches.map((b) => ({
						kind: 'item',
						sectionId: 'branches',
						id: 'branch:' + b,
						label: b === info.head ? '* ' + b : b,
						description: b.startsWith('remotes/') ? t('Remote') : (b === info.head ? 'HEAD' : t('Local')),
						iconId: 'git-branch',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'git-map.view',
							title: t('View in Git Map'),
							arguments: [{ rootUri: vscode.Uri.file(repo) }]
						}
					}));
				}
				case 'remotes': {
					const info = await this.dataSource.getRepoInfo(repo, false, false, []);
					const cfgRes = await this.dataSource.getConfig(repo, info.remotes);
					const remotesList = cfgRes.config
						? cfgRes.config.remotes
						: info.remotes.map((r) => ({ name: r, url: null, pushUrl: null }));
					return remotesList.map((r) => ({
						kind: 'item',
						sectionId: 'remotes',
						id: 'remote:' + r.name,
						label: r.name,
						description: r.url || '',
						tooltip: r.name + (r.url ? '\n' + r.url : ''),
						iconId: 'cloud',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'git-map.view',
							title: t('View in Git Map'),
							arguments: [{ rootUri: vscode.Uri.file(repo) }]
						}
					}));
				}
				case 'stashes': {
					const info = await this.dataSource.getRepoInfo(repo, false, true, []);
					return info.stashes.map((s) => {
						const vars = Object.assign(getCommitVars(s.hash, s.message || s.selector, s.author, s.date), {
							stashOnRef: ((match) => match !== null ? match[1] : '')(/^(?:WIP )?[Oo]n ([^:]+):/.exec(s.message)), // The branch the stash was made on

							selector: s.selector
						});
						return {
							kind: 'item',
							sectionId: 'stashes',
							id: 'stash:' + s.selector,
							label: formatScmNodeTemplate(cfg.stashLabelFormat, vars) || s.message || s.selector,
							description: formatScmNodeTemplate(cfg.stashDescriptionFormat, vars) || s.selector,
							tooltip: cfg.stashTooltipFormat !== '' ? getTooltip(cfg.stashTooltipFormat, vars) : s.selector + '\n' + (s.message || ''),
							iconId: 'archive',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.viewCommitInGitMap',
								title: t('View Commit in Git Map'),
								arguments: [repo, s.hash]
							}
						};
					});
				}
				case 'tags': {
					const data = await this.dataSource.getCommits(
						repo, null, 100, true, false, false, false, CommitOrdering.Date, [], [], []
					);
					const nodes: ScmTreeNode[] = [];
					const seen = new Set<string>();
					for (let i = 0; i < data.commits.length; i++) {
						const c = data.commits[i];
						for (let j = 0; j < c.tags.length; j++) {
							const tg = c.tags[j];
							if (seen.has(tg.name)) continue;
							seen.add(tg.name);
							nodes.push({
								kind: 'item',
								sectionId: 'tags',
								id: 'tag:' + tg.name,
								label: tg.name,
								description: abbrevCommit(c.hash),
								iconId: 'tag',
								collapsibleState: vscode.TreeItemCollapsibleState.None,
								command: {
									command: 'git-map.viewCommitInGitMap',
									title: t('View Commit in Git Map'),
									arguments: [repo, c.hash]
								}
							});
						}
					}
					return nodes;
				}
				case 'worktrees': {
					const wtRes = await this.dataSource.getWorktrees(repo);
					return wtRes.worktrees.map((w) => ({
						kind: 'item',
						sectionId: 'worktrees',
						id: 'wt:' + w.path,
						label: w.branch || abbrevCommit(w.head || ''),
						description: w.path,
						iconId: 'list-tree',
						collapsibleState: vscode.TreeItemCollapsibleState.None
					}));
				}
				case 'contributors': {
					const cRes = await this.gitFeatures.getContributors(repo);
					return cRes.contributors.map((c) => ({
						kind: 'item',
						sectionId: 'contributors',
						id: 'contrib:' + c.email,
						label: c.name,
						description: c.commits + ' · ' + c.email,
						iconId: 'person',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'git-map.viewAuthorInGitMap',
							title: t('View Author Commits in Git Map'),
							arguments: [repo, c.name]
						}
					}));
				}
				case 'repositories': {
					const repos = this.repoManager.getRepos();
					return Object.keys(repos).map((rPath) => ({
						kind: 'item',
						sectionId: 'repositories',
						id: 'repo:' + rPath,
						label: repos[rPath].name || getRepoName(rPath),
						description: rPath === repo ? t('Active') : rPath,
						tooltip: rPath,
						iconId: 'repo',
						collapsibleState: vscode.TreeItemCollapsibleState.None,
						command: {
							command: 'git-map.view',
							title: t('View in Git Map'),
							arguments: [{ rootUri: vscode.Uri.file(rPath) }]
						}
					}));
				}
				case 'searchAndCompare': {
					return [
						{
							kind: 'item',
							sectionId: 'searchAndCompare',
							id: 'sc:open-graph',
							label: t('Search Commits in Git Map'),
							description: getRepoName(repo),
							iconId: 'search',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.view',
								title: t('View in Git Map'),
								arguments: [{ rootUri: vscode.Uri.file(repo) }]
							}
						},
						{
							kind: 'item',
							sectionId: 'searchAndCompare',
							id: 'sc:branch-dashboard',
							label: t('Compare & Manage Branches'),
							description: t('Branch Lifecycle Dashboard'),
							iconId: 'git-compare',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.branchDashboard',
								title: t('Branch Lifecycle Dashboard'),
								arguments: [{ repo: repo }]
							}
						},
						{
							kind: 'item',
							sectionId: 'searchAndCompare',
							id: 'sc:insights',
							label: t('Repository Insights & Hotspots'),
							iconId: 'graph',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.repoInsights',
								title: t('Repository Insights & Hotspots'),
								arguments: [{ repo: repo }]
							}
						}
					];
				}
				case 'launchpad': {
					const badges = getCachedRepoPullRequestBadges(repo) || {};
					return Object.keys(badges).map((branch) => {
						const b = badges[branch];
						return {
							kind: 'item',
							sectionId: 'launchpad',
							id: 'pr:' + branch + ':' + b.number,
							label: '#' + b.number + ' ' + b.title,
							description: branch + ' · ' + b.ciStatus,
							iconId: 'git-pull-request',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.openLaunchpad',
								title: t('Open Launchpad')
							}
						};
					});
				}
				case 'fileHistory': {
					const activeUri = vscode.window.activeTextEditor?.document.uri;
					if (!activeUri || activeUri.scheme !== 'file') {
						return [{
							kind: 'info',
							sectionId: 'fileHistory',
							id: 'fh:none',
							label: t('Open a file in the editor to view its history'),
							iconId: 'info',
							collapsibleState: vscode.TreeItemCollapsibleState.None
						}];
					}
					const rel = path.relative(repo, activeUri.fsPath).replace(/\\/g, '/');
					if (rel === '' || rel.startsWith('..')) {
						return [{
							kind: 'info',
							sectionId: 'fileHistory',
							id: 'fh:outside',
							label: t('Active file is outside the current repository'),
							iconId: 'info',
							collapsibleState: vscode.TreeItemCollapsibleState.None
						}];
					}
					const fhData = await this.dataSource.getCommits(
						repo, null, 20, false, false, false, false, CommitOrdering.Date, [], [], [], null, rel, null
					);
					return fhData.commits.map((c) => {
						const shortSha = abbrevCommit(c.hash);
						const vars = {
							...getCommitVars(c.hash, c.message, c.author, c.date),
							file: path.basename(rel),
							directory: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
							id: shortSha,
							sha: shortSha
						};
						return {
							kind: 'item',
							sectionId: 'fileHistory',
							id: 'fh:' + c.hash,
							label: formatScmNodeTemplate(cfg.commitLabelFormat, vars) || c.message || shortSha,
							description: formatScmNodeTemplate(cfg.commitDescriptionFormat, vars),
							tooltip: rel + '\n' + c.hash + '\n' + c.message,
							iconId: 'history',
							collapsibleState: vscode.TreeItemCollapsibleState.None,
							command: {
								command: 'git-map.viewCommitInGitMap',
								title: t('View Commit in Git Map'),
								arguments: [repo, c.hash]
							}
						};
					});
				}
			}
		} catch (_) {
			return [];
		}
	}
}
