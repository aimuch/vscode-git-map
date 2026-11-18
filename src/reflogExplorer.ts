import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { GitResetMode } from './types';
import { getUndoManager } from './undoManager';
import { abbrevCommit, getNonce, getPathFromUri, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface ReflogEntry {
	readonly hash: string;
	readonly selector: string;
	readonly action: string;
	readonly category: 'commit' | 'reset' | 'rebase' | 'checkout' | 'merge' | 'cherry-pick' | 'other';
	readonly subject: string;
	readonly author: string;
	readonly timestamp: number;
	readonly orphaned: boolean;
}

export function classifyReflogAction(gs: string): { category: ReflogEntry['category'], action: string, subject: string } {
	const colon = gs.indexOf(':');
	const rawAction = colon > -1 ? gs.substring(0, colon).trim() : gs.trim();
	const subject = colon > -1 ? gs.substring(colon + 1).trim() : gs.trim();
	const lower = rawAction.toLowerCase();
	let category: ReflogEntry['category'] = 'other';
	if (lower.startsWith('commit')) category = 'commit';
	else if (lower.startsWith('reset')) category = 'reset';
	else if (lower.startsWith('rebase')) category = 'rebase';
	else if (lower.startsWith('checkout')) category = 'checkout';
	else if (lower.startsWith('merge') || lower.startsWith('pull')) category = 'merge';
	else if (lower.startsWith('cherry-pick')) category = 'cherry-pick';
	return { category, action: rawAction || 'reflog', subject: subject || gs };
}

export function parseReflogOutput(rawReflog: string, reachableHashes: ReadonlySet<string>): ReflogEntry[] {
	const entries: ReflogEntry[] = [];
	const records = rawReflog.split('\x1e');
	for (const rec of records) {
		const trimmed = rec.trim();
		if (trimmed === '') continue;
		const fields = trimmed.split('\x1f');
		if (fields.length < 5) continue;
		const [hash, selector, gs, author, tsStr] = fields;
		if (!/^[0-9a-f]{40,64}$/.test(hash)) continue;
		const parsed = classifyReflogAction(gs);
		entries.push({
			hash: hash,
			selector: selector,
			action: parsed.action,
			category: parsed.category,
			subject: parsed.subject,
			author: author,
			timestamp: parseInt(tsStr, 10) || 0,
			orphaned: !reachableHashes.has(hash)
		});
	}
	return entries;
}

export class ReflogExplorer extends Disposable {
	private static instance: ReflogExplorer | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly entriesSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private readonly previewSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private panel: vscode.WebviewPanel | null = null;
	private currentRepo: string | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		ReflogExplorer.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.reflogExplorer', (arg?: unknown) => this.show(arg)),
			{
				dispose: () => {
					this.entriesSeq.cancel();
					this.previewSeq.cancel();
					if (this.panel !== null) this.panel.dispose();
					if (ReflogExplorer.instance === this) ReflogExplorer.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return ReflogExplorer.instance;
	}

	public async show(arg?: any) {
		let repo: string | null = typeof arg === 'object' && arg !== null && typeof arg.repo === 'string' ? arg.repo : null;
		if (repo === null && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
			repo = this.repoManager.getRepoContainingFile(getPathFromUri(vscode.window.activeTextEditor.document.uri));
		}
		if (repo === null) {
			const last = this.extensionState.getLastActiveRepo();
			const repos = this.repoManager.getRepos();
			repo = last !== null && typeof repos[last] !== 'undefined' ? last : (Object.keys(repos)[0] || null);
		}
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		this.currentRepo = repo;
		const title = t('Reflog Explorer: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.reflogExplorer',
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
					this.entriesSeq.cancel();
					this.previewSeq.cancel();
					this.panel = null;
					this.currentRepo = null;
				}
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = getReflogExplorerHtml(getRepoName(repo), null, this.panel.webview.cspSource);
		const seq = this.entriesSeq.begin();
		const entries = await this.loadReflogEntries(repo);
		if (this.entriesSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
			this.panel.webview.postMessage({ command: 'entries', entries: entries });
			this.logger.log('Opened Reflog Explorer for ' + repo + ' (' + entries.length + ' entries)');
		}
	}

	private async loadReflogEntries(repo: string): Promise<ReflogEntry[]> {
		const reflogRes = await runGit(this.dataSource, repo, ['-c', 'log.showSignature=false', 'reflog', 'show', '-n', '250', '--format=%x1e%H%x1f%gD%x1f%gs%x1f%an%x1f%ct', 'HEAD']);
		if (reflogRes.code !== 0) return [];
		const rawReflog = reflogRes.stdout.toString();
		const uniqueHashes: string[] = [];
		const seen = new Set<string>();
		const matches = rawReflog.match(/[0-9a-f]{40,64}/g);
		if (matches !== null) {
			for (const h of matches) {
				if (!seen.has(h)) {
					seen.add(h);
					uniqueHashes.push(h);
				}
			}
		}
		if (uniqueHashes.length === 0) return [];
		const unreachableRes = await runGit(this.dataSource, repo, ['rev-list', ...uniqueHashes, '--not', '--branches', '--tags', '--remotes']);
		const unreachable = new Set<string>(
			unreachableRes.code === 0 ? unreachableRes.stdout.toString().split(/\r?\n/).filter((h) => h !== '') : []
		);
		const reachable = new Set<string>(uniqueHashes.filter((h) => !unreachable.has(h)));
		return parseReflogOutput(rawReflog, reachable);
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.currentRepo === null || this.panel === null) return;
		const repo = this.currentRepo;
		const msg = <{ command?: unknown, hash?: unknown }>raw;
		if (msg.command === 'refresh') {
			const seq = this.entriesSeq.begin();
			const entries = await this.loadReflogEntries(repo);
			if (this.entriesSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({ command: 'entries', entries: entries });
			}
			return;
		}
		if (typeof msg.hash !== 'string' || !/^[0-9a-f]{40,64}$/.test(msg.hash)) return;
		const hash = msg.hash;
		if (msg.command === 'previewCommit') {
			const pSeq = this.previewSeq.begin();
			const details = await this.dataSource.getCommitDetails(repo, hash, true);
			if (this.previewSeq.complete(pSeq) && this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({
					command: 'previewData',
					hash: hash,
					details: details.commitDetails,
					error: details.error
				});
			}
		} else if (msg.command === 'createBranch') {
			const defaultName = 'recover-' + abbrevCommit(hash);
			const branchName = await vscode.window.showInputBox({
				title: t('Create Recovery Branch at {0}', abbrevCommit(hash)),
				value: defaultName,
				prompt: t('Branch name to create at commit {0}', abbrevCommit(hash)),
				ignoreFocusOut: true
			});
			if (typeof branchName !== 'string' || branchName.trim() === '') return;
			const err = await this.dataSource.createBranch(repo, branchName.trim(), hash, true, false);
			const errMsgs = err.filter((e): e is string => e !== null);
			if (errMsgs.length > 0) showErrorMessage(errMsgs.join('\n'));
			else {
				showInformationMessage(t('Created and checked out branch "{0}" at {1}.', branchName.trim(), abbrevCommit(hash)));
				const entries = await this.loadReflogEntries(repo);
				if (this.panel !== null) this.panel.webview.postMessage({ command: 'entries', entries: entries });
			}
		} else if (msg.command === 'cherryPick') {
			const undo = getUndoManager(this.dataSource);
			const err = await undo.trackHead(repo, t('Cherry-Pick {0}', abbrevCommit(hash)), () => this.dataSource.cherrypickCommit(repo, hash, 0, true, false), (e) => e === null);
			if (err !== null) showErrorMessage(err);
			else showInformationMessage(t('Cherry-picked {0} onto current branch.', abbrevCommit(hash)));
		} else if (msg.command === 'resetHere') {
			const confirmLabel = t('Reset Mixed');
			const picked = await vscode.window.showWarningMessage(
				t('Reset the current branch to {0} (Mixed — keeps working tree changes)?', abbrevCommit(hash)),
				{ modal: true },
				confirmLabel
			);
			if (picked !== confirmLabel) return;
			const undo = getUndoManager(this.dataSource);
			const err = await undo.trackHead(repo, t('Reset to {0}', abbrevCommit(hash)), () => this.dataSource.resetToCommit(repo, hash, GitResetMode.Mixed), (e) => e === null);
			if (err !== null) showErrorMessage(err);
			else {
				const entries = await this.loadReflogEntries(repo);
				if (this.panel !== null) this.panel.webview.postMessage({ command: 'entries', entries: entries });
			}
		} else if (msg.command === 'viewInGitMap') {
			await vscode.commands.executeCommand('git-map.viewCommitInGitMap', repo, hash);
		}
	}
}

function escH(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getReflogExplorerHtml(repoName: string, entries: ReadonlyArray<ReflogEntry> | null, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('Visual Reflog Explorer'),
		searchPlaceholder: t('Filter by commit message, hash, or action…'),
		all: t('All'),
		orphanedOnly: t('Orphaned / Unreachable'),
		resets: t('Reset / Rebase'),
		commits: t('Commits'),
		refresh: t('Refresh'),
		orphanedBadge: t('Orphaned · Recoverable'),
		createBranch: t('Create Recovery Branch…'),
		cherryPick: t('Cherry-Pick Here'),
		resetHere: t('Reset Current Branch Here…'),
		viewInGitMap: t('View in Git Map'),
		loading: t('Loading ...'),
		empty: t('No matching reflog entries.'),
		selectHint: t('Select a reflog entry on the left to inspect its changed files and recovery actions.')
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + RL_STYLES + '</style></head><body data-sm-status="' + (entries === null ? 'loading' : 'ready') + '">' +
		'<header class="rlHeader">' +
			'<h1>' + escH(strings.title) + ' <span class="rlRepo">' + escH(repoName) + '</span></h1>' +
			'<input id="rlSearch" class="rlSearch" type="search" placeholder="' + escH(strings.searchPlaceholder) + '">' +
			'<div class="rlFilters" role="group">' +
				'<button type="button" data-filter="all" class="active">' + escH(strings.all) + '</button>' +
				'<button type="button" data-filter="orphaned">' + escH(strings.orphanedOnly) + '</button>' +
				'<button type="button" data-filter="rewrite">' + escH(strings.resets) + '</button>' +
				'<button type="button" data-filter="commit">' + escH(strings.commits) + '</button>' +
			'</div>' +
			'<button type="button" id="rlRefresh" class="rlBtn">' + escH(strings.refresh) + '</button>' +
		'</header>' +
		'<div class="rlBody">' +
			'<div id="rlList" class="rlList"></div>' +
			'<aside id="rlDetail" class="rlDetail"><div class="rlEmpty">' + escH(strings.selectHint) + '</div></aside>' +
		'</div>' +
		'<script nonce="' + nonce + '">var ENTRIES=' + JSON.stringify(entries).replace(/</g, '\\u003c') + ',STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ',LOCALE=' + JSON.stringify(locale) + ';' + RL_SCRIPT + '</script></body></html>';
}

const RL_STYLES = `
*{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0;overflow:hidden;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button,input{font:inherit;color:inherit}
.rlHeader{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.rlHeader h1{margin:0;font-size:14.5px;display:inline-flex;align-items:center;gap:8px}
.rlRepo{padding:2px 7px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));font-family:var(--vscode-editor-font-family);font-size:11.5px;font-weight:400}
.rlSearch{flex:1 1 200px;min-width:140px;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));background:var(--vscode-input-background,var(--vscode-editor-background))}
.rlFilters{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:6px;overflow:hidden}
.rlFilters button{height:26px;padding:0 10px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;font-size:12px}
.rlFilters button:last-child{border-right:0}
.rlFilters button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.rlBtn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));cursor:pointer;font-size:12px}
.rlBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.rlBody{display:grid;grid-template-columns:minmax(280px,1.2fr) minmax(280px,1fr);height:calc(100% - 49px)}
.rlList{overflow-y:auto;border-right:1px solid var(--vscode-panel-border,rgba(128,128,128,.25))}
.rlItem{padding:9px 14px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.14));cursor:pointer;display:flex;flex-direction:column;gap:4px}
.rlItem:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.12))}
.rlItem.selected{background:var(--vscode-list-activeSelectionBackground,rgba(128,128,128,.24));color:var(--vscode-list-activeSelectionForeground,inherit)}
.rlItemTop{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px}
.rlTag{padding:1px 6px;border-radius:4px;background:rgba(128,128,128,.18);font-family:var(--vscode-editor-font-family);font-size:11px}
.rlOrphan{padding:1px 6px;border-radius:4px;background:rgba(210,153,34,.2);color:#d29922;border:1px solid rgba(210,153,34,.45);font-weight:600;font-size:11px}
.rlSubject{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rlMeta{font-size:11.5px;color:var(--vscode-descriptionForeground)}
.rlDetail{overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.rlActions{display:flex;flex-wrap:wrap;gap:6px}
.rlFiles{display:flex;flex-direction:column;gap:4px;font-family:var(--vscode-editor-font-family);font-size:12px}
.rlEmpty{padding:24px;color:var(--vscode-descriptionForeground)}
`;

const RL_SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi();
	var loading = ENTRIES === null;
	if (loading) ENTRIES = [];
	var filter = 'all', query = '', selectedHash = ENTRIES.length > 0 ? ENTRIES[0].hash : null, previewCache = {};
	var dtf = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
	function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function filtered() {
		var q = query.toLowerCase();
		return ENTRIES.filter(function (e) {
			if (filter === 'orphaned' && !e.orphaned) return false;
			if (filter === 'rewrite' && e.category !== 'reset' && e.category !== 'rebase') return false;
			if (filter === 'commit' && e.category !== 'commit') return false;
			if (q && e.subject.toLowerCase().indexOf(q) === -1 && e.hash.indexOf(q) === -1 && e.action.toLowerCase().indexOf(q) === -1) return false;
			return true;
		});
	}
	function renderList() {
		var listEl = document.getElementById('rlList');
		if (loading) { listEl.innerHTML = '<div class="rlEmpty">' + esc(STRINGS.loading) + '</div>'; return; }
		var items = filtered();
		if (items.length === 0) { listEl.innerHTML = '<div class="rlEmpty">' + esc(STRINGS.empty) + '</div>'; return; }
		listEl.innerHTML = items.map(function (e, idx) {
			return '<div class="rlItem' + (e.hash === selectedHash ? ' selected' : '') + '" data-hash="' + esc(e.hash) + '" data-idx="' + idx + '">' +
				'<div class="rlItemTop"><span class="rlTag">' + esc(e.selector) + '</span><span class="rlTag">' + esc(e.action) + '</span>' +
				(e.orphaned ? '<span class="rlOrphan">' + esc(STRINGS.orphanedBadge) + '</span>' : '') + '</div>' +
				'<div class="rlSubject">' + esc(e.subject) + '</div>' +
				'<div class="rlMeta">' + esc(e.hash.substring(0, 8) + ' · ' + e.author + ' · ' + dtf.format(new Date(e.timestamp * 1000))) + '</div></div>';
		}).join('');
	}
	function renderDetail() {
		var detailEl = document.getElementById('rlDetail');
		var entry = ENTRIES.find(function (e) { return e.hash === selectedHash; });
		if (!entry) { detailEl.innerHTML = '<div class="rlEmpty">' + esc(STRINGS.selectHint) + '</div>'; return; }
		var pv = previewCache[entry.hash];
		var filesHtml = pv && pv.details && pv.details.fileChanges
			? '<div class="rlFiles">' + pv.details.fileChanges.slice(0, 80).map(function (f) {
				return '<div><b>' + esc(f.type) + '</b> ' + esc(f.newFilePath) + (f.additions !== null ? ' (+' + f.additions + ' −' + f.deletions + ')' : '') + '</div>';
			}).join('') + '</div>'
			: '';
		detailEl.innerHTML = '<div><h2 style="margin:0 0 6px;font-size:14px">' + esc(entry.subject) + '</h2>' +
			'<div class="rlMeta">' + esc(entry.hash + ' · ' + entry.author + ' · ' + dtf.format(new Date(entry.timestamp * 1000))) + '</div></div>' +
			'<div class="rlActions">' +
				'<button type="button" class="rlBtn primary" data-act="createBranch">' + esc(STRINGS.createBranch) + '</button>' +
				'<button type="button" class="rlBtn" data-act="cherryPick">' + esc(STRINGS.cherryPick) + '</button>' +
				'<button type="button" class="rlBtn" data-act="resetHere">' + esc(STRINGS.resetHere) + '</button>' +
				'<button type="button" class="rlBtn" data-act="viewInGitMap">' + esc(STRINGS.viewInGitMap) + '</button>' +
			'</div>' + filesHtml;
	}
	function selectHash(h) {
		selectedHash = h;
		renderList();
		renderDetail();
		if (h && !previewCache[h]) vscode.postMessage({ command: 'previewCommit', hash: h });
	}
	document.getElementById('rlSearch').addEventListener('input', function (e) { query = e.target.value; renderList(); });
	document.getElementById('rlRefresh').addEventListener('click', function () {
		loading = true;
		document.body.dataset.smStatus = 'loading';
		renderList();
		vscode.postMessage({ command: 'refresh' });
	});
	document.addEventListener('click', function (e) {
		var t = e.target instanceof Element ? e.target : null;
		if (!t) return;
		var fb = t.closest('[data-filter]'), row = t.closest('.rlItem'), act = t.closest('[data-act]');
		if (fb) {
			filter = fb.dataset.filter;
			document.querySelectorAll('.rlFilters button').forEach(function (b) { b.classList.toggle('active', b === fb); });
			renderList();
		} else if (row) {
			selectHash(row.dataset.hash);
		} else if (act && selectedHash) {
			vscode.postMessage({ command: act.dataset.act, hash: selectedHash });
		}
	});
	window.addEventListener('message', function (ev) {
		var msg = ev.data;
		if (!msg) return;
		if (msg.command === 'entries') {
			loading = false;
			document.body.dataset.smStatus = 'ready';
			ENTRIES = msg.entries || [];
			if (!selectedHash && ENTRIES.length > 0) {
				selectHash(ENTRIES[0].hash);
			} else {
				renderList();
				renderDetail();
			}
		}
		else if (msg.command === 'previewData') { previewCache[msg.hash] = msg; if (msg.hash === selectedHash) renderDetail(); }
	});
	renderList();
	if (selectedHash) selectHash(selectedHash);
})();
`;
