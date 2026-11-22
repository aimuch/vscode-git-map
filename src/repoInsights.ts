import * as vscode from 'vscode';
import { escapeCompanionHtml, resolveTargetRepo } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { getNonce, getRepoName, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface HotspotFile {
	readonly path: string;
	readonly commits: number;
	readonly additions: number;
	readonly deletions: number;
	readonly authors: number;
	readonly topAuthor: string;
	readonly topAuthorShare: number;
}

export interface ContributorStat {
	readonly author: string;
	readonly email: string;
	readonly commits: number;
	readonly additions: number;
	readonly deletions: number;
	readonly activeDays: number;
}

export interface CoChangeCluster {
	readonly fileA: string;
	readonly fileB: string;
	readonly coCommits: number;
	readonly couplingPct: number;
}

export interface RepoInsightsData {
	readonly totalCommits: number;
	readonly totalAuthors: number;
	readonly hotspots: ReadonlyArray<HotspotFile>;
	readonly knowledgeSilos: ReadonlyArray<HotspotFile>;
	readonly coChangeClusters?: ReadonlyArray<CoChangeCluster>;
	readonly contributors: ReadonlyArray<ContributorStat>;
	readonly heatmap: ReadonlyArray<ReadonlyArray<number>>; // 7 (Sun..Sat) x 24 (0..23)
	readonly monthlyCommits: ReadonlyArray<{ readonly month: string; readonly count: number }>;
}

export function getMonthDateRange(yearMonth: string): { readonly after: string; readonly before: string } | null {
	const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
	if (match === null) return null;
	const year = parseInt(match[1], 10);
	const month = parseInt(match[2], 10);
	if (month < 1 || month > 12) return null;
	const lastDay = new Date(year, month, 0).getDate();
	return {
		after: yearMonth + '-01',
		before: yearMonth + '-' + String(lastDay).padStart(2, '0')
	};
}

export function computeRepoInsights(rawLog: string): RepoInsightsData {
	const fileMap = new Map<string, { commits: number, add: number, del: number, authorCounts: Map<string, number> }>();
	const authorMap = new Map<string, { email: string, commits: number, add: number, del: number, days: Set<string> }>();
	const pairCounts = new Map<string, number>();
	const heatmap: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	const monthMap = new Map<string, number>();
	let totalCommits = 0;

	const records = rawLog.split('\x1e');
	for (const rec of records) {
		const trimmed = rec.trim();
		if (trimmed === '') continue;
		const lines = trimmed.split(/\r?\n/);
		const header = lines[0].split('\x1f');
		if (header.length < 3) continue;
		const author = header[0] || 'Unknown';
		const email = header[1] || '';
		const ts = parseInt(header[2], 10) || 0;
		totalCommits++;

		const dt = new Date(ts * 1000);
		heatmap[dt.getDay()][dt.getHours()]++;
		const ym = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0');
		monthMap.set(ym, (monthMap.get(ym) || 0) + 1);
		const ymd = ym + '-' + String(dt.getDate()).padStart(2, '0');

		let aStat = authorMap.get(author);
		if (typeof aStat === 'undefined') {
			aStat = { email: email, commits: 0, add: 0, del: 0, days: new Set<string>() };
			authorMap.set(author, aStat);
		}
		aStat.commits++;
		aStat.days.add(ymd);

		const seenFilesInCommit = new Set<string>();
		for (let i = 1; i < lines.length; i++) {
			const cols = lines[i].split('\t');
			if (cols.length < 3) continue;
			const add = parseInt(cols[0], 10) || 0;
			const del = parseInt(cols[1], 10) || 0;
			let filePath = cols.slice(2).join('\t');
			if (filePath.includes(' => ')) {
				filePath = filePath.replace(/^(.*)\{(.*) => (.*)\}(.*)$/, '$1$3$4').replace(/^.* => /, '').replace(/\/\//g, '/');
			}
			aStat.add += add;
			aStat.del += del;

			let fStat = fileMap.get(filePath);
			if (typeof fStat === 'undefined') {
				fStat = { commits: 0, add: 0, del: 0, authorCounts: new Map<string, number>() };
				fileMap.set(filePath, fStat);
			}
			fStat.add += add;
			fStat.del += del;
			if (!seenFilesInCommit.has(filePath)) {
				seenFilesInCommit.add(filePath);
				fStat.commits++;
				fStat.authorCounts.set(author, (fStat.authorCounts.get(author) || 0) + 1);
			}
		}
		if (seenFilesInCommit.size >= 2 && seenFilesInCommit.size <= 20) {
			const sorted = Array.from(seenFilesInCommit).sort();
			for (let a = 0; a < sorted.length; a++) {
				for (let b = a + 1; b < sorted.length; b++) {
					const pairKey = sorted[a] + '\x00' + sorted[b];
					pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
				}
			}
		}
	}

	const allFiles: HotspotFile[] = [];
	fileMap.forEach((stat, filePath) => {
		let topAuthor = '', topCount = 0;
		stat.authorCounts.forEach((c, name) => {
			if (c > topCount) {
				topCount = c;
				topAuthor = name;
			}
		});
		allFiles.push({
			path: filePath,
			commits: stat.commits,
			additions: stat.add,
			deletions: stat.del,
			authors: stat.authorCounts.size,
			topAuthor: topAuthor,
			topAuthorShare: stat.commits > 0 ? Math.round((topCount / stat.commits) * 100) : 0
		});
	});

	const hotspots = allFiles
		.slice()
		.sort((a, b) => (b.commits - a.commits) || ((b.additions + b.deletions) - (a.additions + a.deletions)))
		.slice(0, 20);

	const knowledgeSilos = allFiles
		.filter((f) => f.commits >= 3 && (f.authors === 1 || f.topAuthorShare >= 85))
		.sort((a, b) => b.commits - a.commits)
		.slice(0, 15);

	const contributors: ContributorStat[] = [];
	authorMap.forEach((stat, author) => {
		contributors.push({
			author: author,
			email: stat.email,
			commits: stat.commits,
			additions: stat.add,
			deletions: stat.del,
			activeDays: stat.days.size
		});
	});
	contributors.sort((a, b) => b.commits - a.commits);

	const monthlyCommits = Array.from(monthMap.entries())
		.sort((a, b) => a[0].localeCompare(b[0]))
		.slice(-12)
		.map(([month, count]) => ({ month, count }));

	const coChangeClusters: CoChangeCluster[] = [];
	pairCounts.forEach((coCommits, key) => {
		if (coCommits < 2) return;
		const sep = key.indexOf('\x00');
		const fileA = key.substring(0, sep), fileB = key.substring(sep + 1);
		const countA = fileMap.get(fileA)?.commits || coCommits;
		const countB = fileMap.get(fileB)?.commits || coCommits;
		const minCommits = Math.max(1, Math.min(countA, countB));
		coChangeClusters.push({
			fileA: fileA,
			fileB: fileB,
			coCommits: coCommits,
			couplingPct: Math.min(100, Math.round((coCommits / minCommits) * 100))
		});
	});
	coChangeClusters.sort((a, b) => (b.coCommits - a.coCommits) || (b.couplingPct - a.couplingPct));

	return {
		totalCommits: totalCommits,
		totalAuthors: contributors.length,
		hotspots: hotspots,
		knowledgeSilos: knowledgeSilos,
		coChangeClusters: coChangeClusters.slice(0, 12),
		contributors: contributors.slice(0, 20),
		heatmap: heatmap,
		monthlyCommits: monthlyCommits
	};
}

export class RepoInsights extends Disposable {
	private static instance: RepoInsights | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly dataSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private panel: vscode.WebviewPanel | null = null;
	private currentRepo: string | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		RepoInsights.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.repoInsights', (arg?: unknown) => this.show(arg)),
			{
				dispose: () => {
					this.dataSeq.cancel();
					if (this.panel !== null) this.panel.dispose();
					if (RepoInsights.instance === this) RepoInsights.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return RepoInsights.instance;
	}

	public async show(arg?: any) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		this.currentRepo = repo;
		const title = t('Insights: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.repoInsights',
				title,
				getConfig().openNewTabEditorGroup,
				{ enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
			);
			const created = this.panel;
			const msgSub = created.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
			const dispSub = created.onDidDispose(() => {
				msgSub.dispose();
				dispSub.dispose();
				if (this.panel === created) {
					this.dataSeq.cancel();
					this.panel = null;
					this.currentRepo = null;
				}
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = getRepoInsightsHtml(getRepoName(repo), null, this.panel.webview.cspSource);
		const seq = this.dataSeq.begin();
		const data = await this.loadData(repo, 90);
		if (this.dataSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
			this.panel.webview.postMessage({ command: 'insightsData', data: data });
			this.logger.log('Opened Repository Insights for ' + repo);
		}
	}

	private async loadData(repo: string, days: number): Promise<RepoInsightsData> {
		const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--no-merges', '--max-count=1500', '--numstat', '--format=%x1e%an%x1f%ae%x1f%at'];
		if (days > 0) {
			const sinceSec = Math.round(Date.now() / 1000) - days * 86400;
			args.push('--since=' + sinceSec);
		}
		const res = await runGit(this.dataSource, repo, args, null, null, undefined, 8 * 1024 * 1024);
		return res.code === 0 || res.truncated ? computeRepoInsights(res.stdout.toString()) : computeRepoInsights('');
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.currentRepo === null || this.panel === null) return;
		const repo = this.currentRepo;
		const msg = <{ command?: unknown, days?: unknown, filePath?: unknown, author?: unknown, month?: unknown }>raw;
		if (msg.command === 'changeRange' && typeof msg.days === 'number') {
			const seq = this.dataSeq.begin();
			const data = await this.loadData(repo, msg.days);
			if (this.dataSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({ command: 'insightsData', data: data });
			}
		} else if (msg.command === 'openTimeMachine' && typeof msg.filePath === 'string') {
			await vscode.commands.executeCommand('git-map.fileTimeMachine', { repo: repo, filePath: msg.filePath });
		} else if (msg.command === 'openVisualHistory' && typeof msg.filePath === 'string') {
			await vscode.commands.executeCommand('git-map.visualFileHistory', { repo: repo, filePath: msg.filePath });
		} else if (msg.command === 'filterAuthorInGitMap' && typeof msg.author === 'string') {
			await vscode.commands.executeCommand('git-map.viewAuthorInGitMap', repo, msg.author);
		} else if (msg.command === 'filterMonthInGitMap' && typeof msg.month === 'string') {
			const range = getMonthDateRange(msg.month);
			if (range !== null) {
				await vscode.commands.executeCommand('git-map.viewDateRangeInGitMap', repo, range.after, range.before);
			}
		}
	}
}

function getRepoInsightsHtml(repoName: string, data: RepoInsightsData | null, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('Repository Insights & Hotspots'),
		days90: t('90 days'),
		year: t('1 year'),
		all: t('All'),
		commits: t('Commits'),
		authors: t('Contributors'),
		hotspots: t('Code Churn Hotspots'),
		silos: t('Single-Owner / Bus-Factor Files'),
		coChange: t('Co-Change File Clusters'),
		coChangePair: t('{0}× together ({1}%)'),
		heatmap: t('Commit Activity Heatmap (Day × Hour)'),
		heatmapTip: t('{0} · {1}:00 — {2} commit(s)'),
		monthly: t('Monthly Commit Trend'),
		timeMachine: t('Time Machine'),
		visual: t('Chart'),
		viewCommits: t('Commits'),
		soleOwner: t('Primary owner: {0} ({1}%)'),
		loading: t('Loading ...'),
		empty: t('No commits in this time range.'),
		weekdays: locale === 'zh-CN' ? ['日', '一', '二', '三', '四', '五', '六'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + RI_STYLES + '</style></head><body data-sm-status="' + (data === null ? 'loading' : 'ready') + '">' +
		'<header class="riHeader"><h1>' + escapeCompanionHtml(strings.title) + ' <span class="riRepo">' + escapeCompanionHtml(repoName) + '</span></h1>' +
		'<div class="riRanges" role="group"><button type="button" data-days="90" class="active">' + escapeCompanionHtml(strings.days90) + '</button><button type="button" data-days="365">' + escapeCompanionHtml(strings.year) + '</button><button type="button" data-days="0">' + escapeCompanionHtml(strings.all) + '</button></div></header>' +
		'<main id="riMain" class="riMain"></main>' +
		'<script nonce="' + nonce + '">var DATA=' + JSON.stringify(data).replace(/</g, '\\u003c') + ',STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' + RI_SCRIPT + '</script></body></html>';
}

const RI_STYLES = `
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button{font:inherit;color:inherit}
.riHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));background:var(--vscode-sideBar-background,var(--vscode-editor-background));position:sticky;top:0;z-index:2}
.riHeader h1{margin:0;font-size:15px;display:inline-flex;align-items:center;gap:8px}
.riRepo{padding:2px 7px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));font-family:var(--vscode-editor-font-family);font-size:11.5px;font-weight:400}
.riRanges{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:6px;overflow:hidden}
.riRanges button{height:26px;padding:0 10px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;font-size:12px}
.riRanges button:last-child{border-right:0}
.riRanges button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.riMain{max-width:1120px;margin:0 auto;padding:18px 20px 40px;display:flex;flex-direction:column;gap:18px}
.riKpis{display:flex;gap:12px;flex-wrap:wrap}
.riKpi{padding:12px 16px;border-radius:8px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));min-width:150px}
.riKpiVal{font-size:22px;font-weight:700}
.riKpiLbl{font-size:11.5px;color:var(--vscode-descriptionForeground)}
.riGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:16px}
.riCard{padding:14px 16px;border-radius:8px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));display:flex;flex-direction:column;gap:10px}
.riCard h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground)}
.riRow{display:flex;align-items:center;gap:8px;font-size:12.5px}
.riPath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--vscode-editor-font-family)}
.riAdd{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}
.riDel{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.riMiniBtn{padding:2px 7px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;font-size:11px;white-space:nowrap}
.riMiniBtn:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.riHeat{position:relative;display:grid;grid-template-columns:32px repeat(24,1fr);gap:3px;align-items:center;font-size:10.5px}
.riCell{height:14px;border-radius:3px;background:rgba(128,128,128,.12);transition:transform 120ms cubic-bezier(.22,1,.36,1),box-shadow 120ms ease}
.riCell:hover{transform:scale(1.35);z-index:2;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.riHeatPopover{position:fixed;z-index:20;pointer-events:none;padding:5px 9px;border-radius:6px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,#1f1f1f));border:1px solid var(--vscode-editorHoverWidget-border,rgba(128,128,128,.4));box-shadow:0 6px 18px rgba(0,0,0,.32);font-size:11.5px;white-space:nowrap;opacity:0;transition:opacity 100ms ease}
.riHeatPopover.visible{opacity:1}
.riClusterBadge{flex:0 0 auto;padding:1px 6px;border-radius:999px;font-size:11px;font-weight:600;background:rgba(55,148,255,.16);color:var(--vscode-textLink-foreground,#3794ff)}
@media (prefers-reduced-motion:reduce){.riCell,.riHeatPopover{transition:none !important}.riCell:hover{transform:none}}
.riMonths{display:flex;align-items:flex-end;gap:8px;height:110px;padding-top:12px}
.riMonthCol{flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:10.5px;color:var(--vscode-descriptionForeground);border:0;background:transparent;padding:2px 0;border-radius:4px;cursor:pointer}
.riMonthCol:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.16));color:var(--vscode-foreground)}
.riMonthBar{width:100%;max-width:34px;border-radius:4px 4px 0 0;background:var(--vscode-button-background,#0e7afe)}
`;

const RI_SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi();
	var loading = DATA === null;
	function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function render() {
		var main = document.getElementById('riMain');
		if (loading) { main.innerHTML = '<div class="riCard">' + esc(STRINGS.loading) + '</div>'; return; }
		if (!DATA || DATA.totalCommits === 0) { main.innerHTML = '<div class="riCard">' + esc(STRINGS.empty) + '</div>'; return; }
		var maxHeat = 1;
		DATA.heatmap.forEach(function (row) { row.forEach(function (v) { if (v > maxHeat) maxHeat = v; }); });
		var heatHtml = '<div class="riHeat"><span></span>' + Array.from({ length: 24 }, function (_, h) { return '<span style="text-align:center;color:var(--vscode-descriptionForeground)">' + (h % 3 === 0 ? h : '') + '</span>'; }).join('');
		DATA.heatmap.forEach(function (row, d) {
			heatHtml += '<span style="color:var(--vscode-descriptionForeground)">' + esc(STRINGS.weekdays[d]) + '</span>';
			row.forEach(function (v, h) {
				var alpha = v === 0 ? 0.08 : (0.2 + 0.8 * (v / maxHeat));
				var bg = v === 0 ? 'rgba(128,128,128,.1)' : 'color-mix(in srgb, var(--vscode-button-background,#0e7afe) ' + Math.round(alpha * 100) + '%, transparent)';
				heatHtml += '<span class="riCell" style="background:' + bg + '" data-heat-day="' + esc(STRINGS.weekdays[d]) + '" data-heat-hour="' + h + '" data-heat-count="' + v + '"></span>';
			});
		});
		heatHtml += '</div><div id="riHeatPop" class="riHeatPopover"></div>';

		var maxMonth = 1;
		DATA.monthlyCommits.forEach(function (m) { if (m.count > maxMonth) maxMonth = m.count; });
		var monthsHtml = '<div class="riMonths">' + DATA.monthlyCommits.map(function (m) {
			var h = Math.max(4, Math.round((m.count / maxMonth) * 76));
			return '<button type="button" class="riMonthCol" data-month="' + esc(m.month) + '" title="' + esc(m.month + ': ' + m.count) + '"><span>' + m.count + '</span><div class="riMonthBar" style="height:' + h + 'px"></div><span>' + esc(m.month.substring(5)) + '</span></button>';
		}).join('') + '</div>';

		main.innerHTML = '<div class="riKpis">' +
			'<div class="riKpi"><div class="riKpiVal">' + DATA.totalCommits + '</div><div class="riKpiLbl">' + esc(STRINGS.commits) + '</div></div>' +
			'<div class="riKpi"><div class="riKpiVal">' + DATA.totalAuthors + '</div><div class="riKpiLbl">' + esc(STRINGS.authors) + '</div></div>' +
			'<div class="riKpi"><div class="riKpiVal">' + DATA.hotspots.length + '</div><div class="riKpiLbl">' + esc(STRINGS.hotspots) + '</div></div>' +
			'<div class="riKpi"><div class="riKpiVal">' + DATA.knowledgeSilos.length + '</div><div class="riKpiLbl">' + esc(STRINGS.silos) + '</div></div></div>' +
			'<div class="riGrid">' +
				'<section class="riCard"><h2>' + esc(STRINGS.hotspots) + '</h2>' + DATA.hotspots.slice(0, 12).map(function (f) {
					return '<div class="riRow"><span class="riPath" title="' + esc(f.path) + '">' + esc(f.path) + '</span><b>' + f.commits + '×</b><span class="riAdd">+' + f.additions + '</span><span class="riDel">−' + f.deletions + '</span>' +
						'<button type="button" class="riMiniBtn" data-tm="' + esc(f.path) + '">' + esc(STRINGS.timeMachine) + '</button><button type="button" class="riMiniBtn" data-vfh="' + esc(f.path) + '">' + esc(STRINGS.visual) + '</button></div>';
				}).join('') + '</section>' +
				'<section class="riCard"><h2>' + esc(STRINGS.silos) + '</h2>' + (DATA.knowledgeSilos.length === 0 ? '<div>—</div>' : DATA.knowledgeSilos.slice(0, 12).map(function (f) {
					return '<div class="riRow"><span class="riPath" title="' + esc(f.path) + '">' + esc(f.path) + '</span><span>' + esc(STRINGS.soleOwner.replace('{0}', f.topAuthor).replace('{1}', String(f.topAuthorShare))) + '</span>' +
						'<button type="button" class="riMiniBtn" data-tm="' + esc(f.path) + '">' + esc(STRINGS.timeMachine) + '</button></div>';
				}).join('')) + '</section>' +
				'<section class="riCard"><h2>' + esc(STRINGS.authors) + '</h2>' + DATA.contributors.slice(0, 12).map(function (c) {
					return '<div class="riRow"><span class="riPath">' + esc(c.author) + '</span><b>' + c.commits + '</b><span class="riAdd">+' + c.additions + '</span><span class="riDel">−' + c.deletions + '</span><button type="button" class="riMiniBtn" data-author="' + esc(c.author) + '">' + esc(STRINGS.viewCommits) + '</button></div>';
				}).join('') + '</section>' +
				'<section class="riCard"><h2>' + esc(STRINGS.monthly) + '</h2>' + monthsHtml + '</section>' +
			'</div>' +
			(Array.isArray(DATA.coChangeClusters) && DATA.coChangeClusters.length > 0
				? '<section class="riCard"><h2>' + esc(STRINGS.coChange) + '</h2>' + DATA.coChangeClusters.map(function (cl) {
					return '<div class="riRow"><span class="riPath" title="' + esc(cl.fileA + ' ↔ ' + cl.fileB) + '">' + esc(cl.fileA) + ' ↔ ' + esc(cl.fileB) + '</span>' +
						'<span class="riClusterBadge">' + esc(STRINGS.coChangePair.replace('{0}', String(cl.coCommits)).replace('{1}', String(cl.couplingPct))) + '</span></div>';
				}).join('') + '</section>'
				: '') +
			'<section class="riCard"><h2>' + esc(STRINGS.heatmap) + '</h2>' + heatHtml + '</section>';
	}
	document.addEventListener('mousemove', function (e) {
		var pop = document.getElementById('riHeatPop');
		if (!pop) return;
		var cell = e.target instanceof Element ? e.target.closest('.riCell') : null;
		if (!cell) { pop.classList.remove('visible'); return; }
		pop.textContent = STRINGS.heatmapTip.replace('{0}', cell.dataset.heatDay || '').replace('{1}', cell.dataset.heatHour || '').replace('{2}', cell.dataset.heatCount || '0');
		pop.style.left = Math.min(window.innerWidth - 180, e.clientX + 12) + 'px';
		pop.style.top = Math.max(8, e.clientY - 34) + 'px';
		pop.classList.add('visible');
	});
	document.addEventListener('click', function (e) {
		var t = e.target instanceof Element ? e.target : null;
		if (!t) return;
		var rb = t.closest('[data-days]'), tm = t.closest('[data-tm]'), vfh = t.closest('[data-vfh]'), auth = t.closest('[data-author]'), mon = t.closest('[data-month]');
		if (rb) {
			document.querySelectorAll('.riRanges button').forEach(function (b) { b.classList.toggle('active', b === rb); });
			loading = true;
			document.body.dataset.smStatus = 'loading';
			render();
			vscode.postMessage({ command: 'changeRange', days: parseInt(rb.dataset.days, 10) });
		} else if (tm) {
			vscode.postMessage({ command: 'openTimeMachine', filePath: tm.dataset.tm });
		} else if (vfh) {
			vscode.postMessage({ command: 'openVisualHistory', filePath: vfh.dataset.vfh });
		} else if (auth) {
			vscode.postMessage({ command: 'filterAuthorInGitMap', author: auth.dataset.author });
		} else if (mon) {
			vscode.postMessage({ command: 'filterMonthInGitMap', month: mon.dataset.month });
		}
	});
	window.addEventListener('message', function (ev) {
		if (ev.data && ev.data.command === 'insightsData') {
			loading = false;
			document.body.dataset.smStatus = 'ready';
			DATA = ev.data.data;
			render();
		}
	});
	render();
})();
`;
