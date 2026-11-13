import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { GitFeatures } from './gitFeatures';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitFileStatus, GitFileTimelineCommit } from './types';
import { getNonce, getPathFromUri, showErrorMessage, viewDiff, viewFileAtRevision } from './utils';
import { Disposable } from './utils/disposable';

/**
 * The maximum number of commits shown in the visual history of a file.
 */
const MAX_COMMITS = 2000;

/**
 * The file whose history is shown, and its commits.
 */
interface ShownFile {
	readonly repo: string;
	readonly filePath: string;
	readonly commits: ReadonlyArray<GitFileTimelineCommit>;
}

/**
 * Shows the visual history of a file ("Visual File History"): each commit that changed it is a circle on a timeline, in a row for its
 * author, sized by the number of lines it changed, with a bar chart of the lines added & deleted by each commit below it. Selecting a
 * commit shows it, with actions to open its changes, open the file at the commit, and view the commit in the Git Map View.
 */
export class VisualFileHistory extends Disposable {
	private static instance: VisualFileHistory | null = null;

	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly gitFeatures: GitFeatures;
	private panel: vscode.WebviewPanel | null = null;
	private shown: ShownFile | null = null;

	/**
	 * Creates the Visual File History.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.repoManager = repoManager;
		this.logger = logger;
		this.gitFeatures = new GitFeatures(dataSource);
		VisualFileHistory.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.visualFileHistory', (arg: any) => this.show(arg)),
			{
				dispose: () => {
					if (this.panel !== null) this.panel.dispose();
					if (VisualFileHistory.instance === this) VisualFileHistory.instance = null;
				}
			}
		);
	}

	/**
	 * Get the Visual File History (used by the end-to-end tests to inspect what's shown).
	 */
	public static getInstance() {
		return VisualFileHistory.instance;
	}

	/**
	 * Get the file whose history is shown, and the HTML of the panel.
	 */
	public getShown() {
		return this.shown !== null && this.panel !== null ? { repo: this.shown.repo, filePath: this.shown.filePath, commits: this.shown.commits.length, html: this.panel.webview.html } : null;
	}

	/**
	 * The method run when the `git-map.visualFileHistory` command is invoked.
	 * @param arg The file: a URI (from the Explorer or an editor), or the repository & path (from the Git Map View); otherwise the file
	 * in the active text editor.
	 */
	private async show(arg: any) {
		let file: { repo: string, path: string } | null = null;
		if (typeof arg === 'object' && arg !== null && typeof arg.repo === 'string' && typeof arg.filePath === 'string') {
			file = { repo: arg.repo, path: arg.filePath };
		} else {
			const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor ? vscode.window.activeTextEditor.document.uri : null;
			if (uri === null || uri.scheme !== 'file') {
				showErrorMessage(t('Unable to show the Visual File History: {0}', t('Select a file in the Explorer, or open a file in an editor.')));
				return;
			}
			file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(uri));
			if (file === null) {
				showErrorMessage(t('Unable to show the Visual File History: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(uri))));
				return;
			}
		}

		const result = await this.gitFeatures.getFileTimeline(file.repo, file.path, MAX_COMMITS);
		if (result.error !== null) {
			showErrorMessage(t('Unable to show the Visual File History: {0}', result.error));
			return;
		}
		if (result.commits.length === 0) {
			showErrorMessage(t('Unable to show the Visual File History: {0}', t('The file {0} hasn\'t been committed.', file.path)));
			return;
		}
		this.shown = { repo: file.repo, filePath: file.path, commits: result.commits };
		const title = t('History: {0}', file.path.substring(file.path.lastIndexOf('/') + 1));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel('git-map.visualFileHistory', title, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
			this.panel.onDidDispose(() => {
				this.panel = null;
				this.shown = null;
			});
			this.panel.webview.onDidReceiveMessage((message) => this.onMessage(message));
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = getVisualFileHistoryPage(file.path, result.commits, this.panel.webview.cspSource);
		this.logger.log('Showing the Visual File History of ' + file.path + ' (' + result.commits.length + ' commits)');
	}

	/**
	 * Process a message sent by the panel.
	 * @param message The message.
	 */
	private async onMessage(message: any) {
		const shown = this.shown;
		if (shown === null || typeof message !== 'object' || message === null || typeof message.index !== 'number') return;
		const commit = shown.commits[message.index];
		if (typeof commit === 'undefined') return;
		// The path of the file in the commit before it (the commits are the newest first), which differs if the commit renamed it
		const older = shown.commits[message.index + 1], oldFilePath = typeof older !== 'undefined' ? older.filePath : commit.filePath;
		let error: string | null = null;
		switch (message.command) {
			case 'openChanges':
				error = await viewDiff(shown.repo, commit.hash, commit.hash, oldFilePath, commit.filePath, commit.added ? GitFileStatus.Added : oldFilePath !== commit.filePath ? GitFileStatus.Renamed : GitFileStatus.Modified);
				break;
			case 'openFile':
				error = await viewFileAtRevision(shown.repo, commit.hash, commit.filePath);
				break;
			case 'viewCommit':
				await vscode.commands.executeCommand('git-map.viewCommitInGitMap', shown.repo, commit.hash);
				break;
			case 'viewFileHistory':
				await vscode.commands.executeCommand('git-map.viewFileHistory', vscode.Uri.file(shown.repo + '/' + shown.filePath));
				break;
		}
		if (error !== null) showErrorMessage(error);
	}
}

/**
 * Get the HTML of the Visual File History panel.
 * @param filePath The path of the file (relative to its repository).
 * @param commits The commits that changed the file (newest first).
 * @param cspSource The source of the Webview's resources.
 * @returns The HTML.
 */
export function getVisualFileHistoryPage(filePath: string, commits: ReadonlyArray<GitFileTimelineCommit>, cspSource: string) {
	const nonce = getNonce(), strings = {
		days90: t('90 days'),
		year: t('1 year'),
		all: t('All'),
		commits: t('{0} commits'),
		commit1: t('1 commit'),
		authors: t('{0} authors'),
		author1: t('1 author'),
		renamedFrom: t('Renamed from {0}'),
		lines: t('lines'),
		others: t('Others'),
		selected: t('Selected commit'),
		openChanges: t('Open Changes'),
		openFile: t('Open File at this Commit'),
		viewCommit: t('View Commit in Git Map'),
		viewFileHistory: t('View File History in Git Map'),
		sizeLegend: t('Circle size: lines changed'),
		barsLegend: t('Lines added & deleted by each commit'),
		noCommits: t('No commits in this range.'),
		hint: t('Click a circle to select its commit, double-click it to open its changes.'),
		zoomHint: t('Drag across the bars to zoom into a range of dates.'),
		resetZoom: t('Reset Zoom')
	};
	const data = commits.map((commit) => ({ h: commit.hash, a: commit.author, e: commit.email, d: commit.date, s: commit.subject, p: commit.additions, m: commit.deletions, f: commit.filePath }));
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + STYLES + '</style></head><body>' +
		'<header class="vfhHeader"><h1>' + escapeHtml(t('Visual File History')) + '</h1><span class="vfhPath">' + escapeHtml(filePath) + '</span><span class="vfhSpacer"></span>' +
		'<div class="vfhRange" role="group" aria-label="' + escapeHtml(t('Time range')) + '"><button type="button" data-range="90">' + escapeHtml(strings.days90) + '</button><button type="button" data-range="365">' + escapeHtml(strings.year) + '</button><button type="button" data-range="0">' + escapeHtml(strings.all) + '</button></div>' +
		'<button type="button" class="vfhButton" data-action="viewFileHistory">' + escapeHtml(strings.viewFileHistory) + '</button></header>' +
		'<div id="summary" class="vfhSummary"></div>' +
		'<div class="vfhBody"><figure class="vfhChart" aria-label="' + escapeHtml(t('Commits that changed the file, by author')) + '"><div class="vfhPlot"><div id="lanes" class="vfhLanes"></div><div id="plot" class="vfhArea"></div></div><div id="axis" class="vfhAxis"></div><div id="bars" class="vfhBars"></div>' +
		'<figcaption class="vfhLegend"><span>' + escapeHtml(strings.sizeLegend) + '</span><span><i class="add"></i><i class="del"></i>' + escapeHtml(strings.barsLegend) + '</span><span>' + escapeHtml(strings.hint) + '</span><span>' + escapeHtml(strings.zoomHint) + '</span></figcaption></figure>' +
		'<aside id="details" class="vfhDetails" aria-live="polite"></aside></div>' +
		'<script nonce="' + nonce + '">var COMMITS = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ', STRINGS = ' + JSON.stringify(strings).replace(/</g, '\\u003c') + ', LOCALE = ' + JSON.stringify(locale) + ', FILE = ' + JSON.stringify(filePath).replace(/</g, '\\u003c') + ';' + SCRIPT + '</script></body></html>';
}

function escapeHtml(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const STYLES = `
body{margin:0;padding:16px 20px;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button{font:inherit;color:inherit}
.vfhHeader{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.vfhHeader h1{margin:0;font-size:16px;font-weight:600}
.vfhPath{padding:2px 8px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.45));border-radius:4px;background:var(--vscode-dropdown-background,rgba(128,128,128,.1));font-family:var(--vscode-editor-font-family);font-size:12px}
.vfhSpacer{flex:1 1 auto}
.vfhRange{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.45));border-radius:6px;overflow:hidden}
.vfhRange button{height:26px;padding:0 10px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.45));background:transparent;cursor:pointer}
.vfhRange button:last-child{border-right:0}
.vfhRange button[aria-pressed="true"]{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.vfhButton{height:26px;padding:0 10px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.45));border-radius:6px;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));color:var(--vscode-button-secondaryForeground,inherit);cursor:pointer}
.vfhButton.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.vfhButton:focus-visible,.vfhRange button:focus-visible,.vfhBubble:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}
.vfhSummary{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;font-size:12px}
.vfhSummary > span{padding:3px 10px;border-radius:10px;background:rgba(128,128,128,.15)}
.add{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.vfhBody{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}
.vfhChart{flex:999 1 560px;min-width:0;margin:0;padding:14px 16px 10px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));border-radius:8px;background:var(--vscode-sideBar-background,transparent)}
.vfhPlot{display:flex}
.vfhLanes{flex:0 0 130px}
.vfhLane{height:48px;display:flex;align-items:center;gap:8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vfhInitial{flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#1f1f1f}
.vfhArea{flex:1 1 auto;position:relative;border-left:1px solid var(--vscode-panel-border,rgba(128,128,128,.3))}
.vfhGrid{position:absolute;left:0;right:0;height:1px;background:var(--vscode-panel-border,rgba(128,128,128,.2))}
.vfhBubble{position:absolute;padding:0;border-radius:50%;box-sizing:border-box;transform:translate(-50%,-50%);border:1.5px solid;cursor:pointer;opacity:.9}
.vfhBubble:hover{opacity:1;z-index:2}
.vfhBubble.selected{outline:2px solid var(--vscode-editor-foreground);outline-offset:2px;z-index:3}
.vfhAxis{display:flex;justify-content:space-between;margin:4px 0 0 130px;color:var(--vscode-descriptionForeground);font-size:11.5px}
.vfhBars{position:relative;height:70px;margin:10px 0 0 130px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.25))}
.vfhBars .mid{position:absolute;left:0;right:0;top:35px;height:1px;background:var(--vscode-panel-border,rgba(128,128,128,.3))}
.vfhBar{position:absolute;width:3px;border-radius:1px;transform:translateX(-50%);pointer-events:none}
.vfhBars{cursor:crosshair;user-select:none}
.vfhBrush{position:absolute;top:0;bottom:0;border:1px solid var(--vscode-focusBorder);background:color-mix(in srgb,var(--vscode-focusBorder) 18%,transparent);pointer-events:none}
.vfhSummary > button.vfhZoomReset{padding:3px 10px;border:1px solid var(--vscode-focusBorder);border-radius:10px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.vfhBar.add{bottom:35px;background:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}
.vfhBar.del{top:36px;background:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.vfhLegend{display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;color:var(--vscode-descriptionForeground);font-size:11.5px}
.vfhLegend i{display:inline-block;width:8px;height:8px;margin-right:2px;border-radius:2px}
.vfhLegend i.add{background:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}.vfhLegend i.del{margin-right:6px;background:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.vfhDetails{flex:1 1 280px;max-width:380px;min-width:0;box-sizing:border-box;padding:14px 16px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));border-radius:8px;display:flex;flex-direction:column;gap:10px}
.vfhDetails:empty{display:none}
.vfhDetails .label{font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.vfhDetails .subject{font-size:14px;font-weight:600;line-height:20px;word-wrap:break-word}
.vfhDetails .meta{color:var(--vscode-descriptionForeground);font-size:12px}
.vfhDetails .hash{font-family:var(--vscode-editor-font-family)}
.vfhDetails .ratio{height:6px;border-radius:3px}
.vfhDetails .actions{display:flex;flex-direction:column;gap:6px}
.vfhDetails .actions button{text-align:left;height:28px}
.vfhEmpty{padding:24px;color:var(--vscode-descriptionForeground)}
`;

const SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi(), COLOURS = ['#4daafc', '#f0b45c', '#7ee787', '#d2a8ff', '#ff9bce', '#79e2d0', '#ffa198', '#e3b341'], MAX_LANES = 8, LANE = 48;
	var range = 365, selected = 0, zoom = null, view = null; // zoom: the range of dates zoomed into by dragging across the bars
	function esc(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function format(text, value) { return text.replace('{0}', value); }
	function date(seconds) { return new Date(seconds * 1000).toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' }); }
	function visible() {
		if (zoom !== null) return COMMITS.map(function (c, i) { return i; }).filter(function (i) { return COMMITS[i].d >= zoom.from && COMMITS[i].d <= zoom.to; });
		if (range === 0) return COMMITS.map(function (c, i) { return i; });
		var since = COMMITS[0].d - range * 86400, indexes = [];
		COMMITS.forEach(function (c, i) { if (c.d >= since) indexes.push(i); });
		return indexes;
	}
	function render() {
		document.querySelectorAll('.vfhRange button').forEach(function (b) { b.setAttribute('aria-pressed', String(zoom === null && parseInt(b.dataset.range) === range)); });
		var indexes = visible(), plot = document.getElementById('plot'), lanesElem = document.getElementById('lanes'), bars = document.getElementById('bars'), axis = document.getElementById('axis');
		var counts = {}, add = 0, del = 0;
		indexes.forEach(function (i) { var c = COMMITS[i]; counts[c.a] = (counts[c.a] || 0) + 1; add += c.p; del += c.m; });
		var authors = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }), lanes = authors.slice(0, MAX_LANES - (authors.length > MAX_LANES ? 1 : 0));
		if (authors.length > lanes.length) lanes.push(null);
		var renamed = indexes.length > 0 ? COMMITS[indexes[indexes.length - 1]].f : FILE;
		document.getElementById('summary').innerHTML = '<span>' + esc(indexes.length === 1 ? STRINGS.commit1 : format(STRINGS.commits, indexes.length)) + '</span><span>' + esc(authors.length === 1 ? STRINGS.author1 : format(STRINGS.authors, authors.length)) + '</span><span><span class="add">+' + add + '</span> <span class="del">\\u2212' + del + '</span> ' + esc(STRINGS.lines) + '</span>' +
			(renamed !== FILE ? '<span>' + esc(format(STRINGS.renamedFrom, renamed)) + '</span>' : '') +
			(zoom !== null ? '<button type="button" class="vfhZoomReset">' + esc(STRINGS.resetZoom) + '</button>' : '');
		if (indexes.length === 0) {
			plot.innerHTML = '<div class="vfhEmpty">' + esc(STRINGS.noCommits) + '</div>'; lanesElem.innerHTML = ''; bars.innerHTML = ''; axis.innerHTML = '';
			document.getElementById('details').innerHTML = '';
			return;
		}
		var newest = COMMITS[indexes[0]].d, oldest = COMMITS[indexes[indexes.length - 1]].d, span = Math.max(newest - oldest, 1);
		var x = function (d) { return indexes.length === 1 ? 50 : 2 + (d - oldest) / span * 96; };
		view = { oldest: oldest, span: span };
		// Commits made at (almost) the same time are spread out, so that each can be seen & clicked
		var order = indexes.slice().sort(function (a, b) { return COMMITS[a].d - COMMITS[b].d || b - a; }), lefts = {}, previousLeft = -Infinity, GAP = 1.2;
		order.forEach(function (i) { lefts[i] = Math.max(x(COMMITS[i].d), previousLeft + GAP); previousLeft = lefts[i]; });
		var last = lefts[order[order.length - 1]];
		if (order.length > 1 && last > 98) order.forEach(function (i) { lefts[i] = 2 + (lefts[i] - 2) * 96 / (last - 2); });
		var laneOf = function (author) { var i = lanes.indexOf(author); return i > -1 ? i : lanes.length - 1; };
		lanesElem.innerHTML = lanes.map(function (author, i) { var name = author === null ? STRINGS.others : author; return '<div class="vfhLane" title="' + esc(name) + '"><span class="vfhInitial" style="background:' + COLOURS[i % COLOURS.length] + '">' + esc(Array.from(name.trim() || '?')[0].toUpperCase()) + '</span>' + esc(name) + '</div>'; }).join('');
		plot.style.height = (lanes.length * LANE) + 'px';
		var html = lanes.map(function (_, i) { return '<div class="vfhGrid" style="top:' + (i * LANE + LANE / 2) + 'px"></div>'; }).join(''), barsHtml = '<div class="mid"></div>';
		var maxLines = 1; indexes.forEach(function (i) { maxLines = Math.max(maxLines, COMMITS[i].p, COMMITS[i].m); });
		indexes.slice().reverse().forEach(function (i) {
			var c = COMMITS[i], lane = laneOf(c.a), colour = COLOURS[lane % COLOURS.length], size = Math.round(8 + Math.sqrt(c.p + c.m) * 1.6), left = lefts[i].toFixed(2);
			html += '<button type="button" class="vfhBubble' + (i === selected ? ' selected' : '') + '" data-index="' + i + '" title="' + esc(c.s + ' \\u00b7 ' + c.a + ' \\u00b7 ' + date(c.d) + ' \\u00b7 +' + c.p + ' \\u2212' + c.m) + '" style="left:' + left + '%;top:' + (lane * LANE + LANE / 2) + 'px;width:' + size + 'px;height:' + size + 'px;background:' + colour + '55;border-color:' + colour + '"></button>';
			barsHtml += '<div class="vfhBar add" style="left:' + left + '%;height:' + Math.max(1, Math.round(c.p / maxLines * 34)) + 'px"></div><div class="vfhBar del" style="left:' + left + '%;height:' + Math.max(c.m > 0 ? 1 : 0, Math.round(c.m / maxLines * 34)) + 'px"></div>';
		});
		plot.innerHTML = html;
		bars.innerHTML = barsHtml;
		var ticks = [], previous = null; for (var t = 0; t <= 4; t++) { var label = date(oldest + span * t / 4); ticks.push('<span>' + (label !== previous ? esc(label) : '') + '</span>'); previous = label; }
		axis.innerHTML = ticks.join('');
		if (indexes.indexOf(selected) === -1) selected = indexes[0];
		renderDetails();
	}
	function renderDetails() {
		var c = COMMITS[selected];
		if (!c) { document.getElementById('details').innerHTML = ''; return; }
		var total = Math.max(c.p + c.m, 1);
		document.getElementById('details').innerHTML = '<div class="label">' + esc(STRINGS.selected) + '</div><div class="subject">' + esc(c.s) + '</div>' +
			'<div class="meta">' + esc(c.a) + ' \\u00b7 ' + esc(date(c.d)) + ' \\u00b7 <span class="hash">' + esc(c.h.substring(0, 8)) + '</span></div>' +
			'<div><span class="add">+' + c.p + '</span> <span class="del">\\u2212' + c.m + '</span></div>' +
			'<div class="ratio" style="background:linear-gradient(90deg, var(--vscode-gitDecoration-addedResourceForeground,#3fb950) 0 ' + (c.p / total * 100).toFixed(1) + '%, var(--vscode-gitDecoration-deletedResourceForeground,#f85149) ' + (c.p / total * 100).toFixed(1) + '% 100%)"></div>' +
			'<div class="actions"><button type="button" class="vfhButton primary" data-action="openChanges">' + esc(STRINGS.openChanges) + '</button><button type="button" class="vfhButton" data-action="openFile">' + esc(STRINGS.openFile) + '</button><button type="button" class="vfhButton" data-action="viewCommit">' + esc(STRINGS.viewCommit) + '</button></div>';
	}
	document.addEventListener('click', function (e) {
		var target = e.target instanceof Element ? e.target : null;
		if (target === null) return;
		var rangeButton = target.closest('.vfhRange button'), bubble = target.closest('.vfhBubble'), action = target.closest('[data-action]');
		if (rangeButton) { range = parseInt(rangeButton.dataset.range); zoom = null; render(); }
		else if (target.closest('.vfhZoomReset')) { zoom = null; render(); }
		else if (bubble) { selected = parseInt(bubble.dataset.index); document.querySelectorAll('.vfhBubble').forEach(function (b) { b.classList.toggle('selected', b === bubble); }); renderDetails(); }
		else if (action) { vscode.postMessage({ command: action.dataset.action, index: selected }); }
	});
	document.addEventListener('dblclick', function (e) {
		var bubble = e.target instanceof Element ? e.target.closest('.vfhBubble') : null;
		if (bubble) vscode.postMessage({ command: 'openChanges', index: parseInt(bubble.dataset.index) });
	});
	// Dragging across the bars zooms into the range of dates
	var barsElem = document.getElementById('bars'), brush = null, brushStart = 0;
	var brushX = function (e) { var r = barsElem.getBoundingClientRect(); return Math.min(Math.max(e.clientX - r.left, 0), r.width); };
	barsElem.addEventListener('mousedown', function (e) {
		if (view === null || e.button !== 0) return;
		brushStart = brushX(e);
		brush = document.createElement('div'); brush.className = 'vfhBrush'; brush.style.left = brushStart + 'px'; brush.style.width = '0px';
		barsElem.appendChild(brush);
		e.preventDefault();
	});
	document.addEventListener('mousemove', function (e) {
		if (brush === null) return;
		var x = brushX(e); brush.style.left = Math.min(brushStart, x) + 'px'; brush.style.width = Math.abs(x - brushStart) + 'px';
	});
	document.addEventListener('mouseup', function (e) {
		if (brush === null) return;
		var x = brushX(e), from = Math.min(brushStart, x), to = Math.max(brushStart, x), width = barsElem.getBoundingClientRect().width;
		brush.remove(); brush = null;
		if (to - from < 6 || view === null || width === 0) return;
		var toDate = function (px) { return view.oldest + (px / width * 100 - 2) / 96 * view.span; };
		zoom = { from: toDate(from), to: toDate(to) };
		render();
	});
	if (COMMITS.length > 0 && COMMITS[0].d - COMMITS[COMMITS.length - 1].d < 365 * 86400) range = 0;
	render();
})();
`;
