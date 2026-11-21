import * as vscode from 'vscode';
import { escapeCompanionHtml, resolveTargetRepo } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { fetchRepoPullRequestBadges } from './prStatusIntegration';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { PullRequestBadgeInfo } from './types';
import { getNonce, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface BranchLifecycleRow {
	readonly name: string;
	readonly isRemote: boolean;
	readonly isCurrent: boolean;
	readonly author: string;
	readonly lastCommitDate: number;
	readonly ageDays: number;
	readonly stale: boolean;
	readonly merged: boolean;
	readonly subject: string;
	readonly upstream: string;
	readonly prNumber: number | null;
	readonly prCiStatus: string | null;
}

const STALE_DAYS_THRESHOLD = 30;

/**
 * Parse `git for-each-ref` lines into sortable branch lifecycle rows.
 */
export function parseBranchLifecycleRows(
	forEachRefOutput: string,
	mergedBranches: ReadonlySet<string>,
	prBadges: { readonly [branch: string]: PullRequestBadgeInfo },
	nowSec: number = Math.round(Date.now() / 1000)
): BranchLifecycleRow[] {
	const rows: BranchLifecycleRow[] = [];
	for (const line of forEachRefOutput.split(/\r?\n/)) {
		if (line.trim() === '') continue;
		const [headMark, refType, shortName, author, tsStr, upstream, subject] = line.split('\x1f');
		if (!shortName || shortName.endsWith('/HEAD')) continue;
		const isRemote = refType === 'refs/remotes';
		const ts = parseInt(tsStr || '0', 10) || 0;
		const ageDays = ts > 0 ? Math.max(0, Math.floor((nowSec - ts) / 86400)) : 0;
		const pr = !isRemote ? prBadges[shortName] : undefined;
		rows.push({
			name: shortName,
			isRemote: isRemote,
			isCurrent: headMark === '*',
			author: author || '',
			lastCommitDate: ts,
			ageDays: ageDays,
			stale: ageDays >= STALE_DAYS_THRESHOLD,
			merged: mergedBranches.has(shortName),
			subject: subject || '',
			upstream: upstream || '',
			prNumber: typeof pr !== 'undefined' ? pr.number : null,
			prCiStatus: typeof pr !== 'undefined' ? pr.ciStatus : null
		});
	}
	return rows;
}

export function detectDefaultBranch(rows: ReadonlyArray<BranchLifecycleRow>, symbolicOriginHead: string | null): string | null {
	const names = new Set(rows.map((r) => r.name));
	if (typeof symbolicOriginHead === 'string' && symbolicOriginHead.trim() !== '') {
		const trimmed = symbolicOriginHead.trim();
		const stripped = trimmed.includes('/') ? trimmed.substring(trimmed.indexOf('/') + 1) : trimmed;
		if (names.has(stripped)) return stripped;
		if (names.has(trimmed)) return trimmed;
	}
	for (const candidate of ['main', 'master', 'develop', 'origin/main', 'origin/master']) {
		if (names.has(candidate)) return candidate;
	}
	const current = rows.find((r) => r.isCurrent);
	return current ? current.name : (rows[0] ? rows[0].name : null);
}

export class BranchDashboard extends Disposable {
	private static instance: BranchDashboard | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly loadSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private panel: vscode.WebviewPanel | null = null;
	private currentRepo: string | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, extensionState: ExtensionState, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		BranchDashboard.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.branchDashboard', (arg?: unknown) => this.show(arg)),
			{
				dispose: () => {
					this.loadSeq.cancel();
					if (this.panel !== null) this.panel.dispose();
					if (BranchDashboard.instance === this) BranchDashboard.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return BranchDashboard.instance;
	}

	public async show(arg?: any) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		this.currentRepo = repo;
		const title = t('Branch Lifecycle Dashboard: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.branchDashboard',
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
					this.loadSeq.cancel();
					this.panel = null;
					this.currentRepo = null;
				}
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = getBranchDashboardHtml(getRepoName(repo), this.panel.webview.cspSource);
		await this.refreshRows(repo);
	}

	private async refreshRows(repo: string) {
		const seq = this.loadSeq.begin();
		const [refsRes, mergedRes, originHeadRes, prBadges] = await Promise.all([
			runGit(this.dataSource, repo, ['for-each-ref', '--sort=-committerdate', '--format=%(HEAD)%1f%(refname:lstrip=0)%1f%(refname:short)%1f%(authorname)%1f%(committerdate:unix)%1f%(upstream:short)%1f%(subject)', 'refs/heads', 'refs/remotes']),
			runGit(this.dataSource, repo, ['branch', '-a', '--merged', 'HEAD', '--format=%(refname:short)']),
			runGit(this.dataSource, repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
			fetchRepoPullRequestBadges(this.dataSource, repo).catch(() => ({}))
		]);
		const normalizedRefLines = refsRes.code === 0
			? refsRes.stdout.toString().split(/\r?\n/).map((line) => {
				const parts = line.split('\x1f');
				if (parts.length < 7) return '';
				parts[1] = parts[1].startsWith('refs/remotes/') ? 'refs/remotes' : 'refs/heads';
				return parts.join('\x1f');
			}).join('\n')
			: '';
		const mergedSet = new Set<string>(
			mergedRes.code === 0 ? mergedRes.stdout.toString().split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '') : []
		);
		const rows = parseBranchLifecycleRows(normalizedRefLines, mergedSet, prBadges);
		const defaultBranch = detectDefaultBranch(rows, originHeadRes.code === 0 ? originHeadRes.stdout.toString().trim() : null);
		if (this.loadSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
			this.panel.webview.postMessage({ command: 'rows', rows: rows, defaultBranch: defaultBranch });
			this.logger.log('Loaded Branch Lifecycle Dashboard for ' + repo + ' (' + rows.length + ' branches)');
		}
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.currentRepo === null || this.panel === null) return;
		const repo = this.currentRepo;
		const msg = <{ command?: unknown, branches?: unknown, branch?: unknown, baseBranch?: unknown }>raw;
		try {
			if (msg.command === 'refresh') {
				await this.refreshRows(repo);
			} else if (msg.command === 'checkout' && typeof msg.branch === 'string' && !msg.branch.startsWith('-')) {
				const err = await this.dataSource.checkoutBranch(repo, msg.branch, null);
				if (err !== null) showErrorMessage(err);
				await this.refreshRows(repo);
			} else if (msg.command === 'compareWithDefault' && typeof msg.branch === 'string' && typeof msg.baseBranch === 'string' && msg.branch !== msg.baseBranch) {
				await vscode.commands.executeCommand('git-map.compareBranchesInGitMap', repo, msg.branch, msg.baseBranch);
			} else if (msg.command === 'deleteSelected' && Array.isArray(msg.branches)) {
				const localBranches = msg.branches.filter((b): b is string => typeof b === 'string' && b !== '' && !b.startsWith('-'));
				if (localBranches.length === 0) return;
				const confirmLabel = t('Delete Branches');
				const forceLabel = t('Force Delete (-D)');
				const picked = await vscode.window.showWarningMessage(
					t('Delete {0} selected local branch(es)?', String(localBranches.length)),
					{ modal: true },
					confirmLabel,
					forceLabel
				);
				if (picked !== confirmLabel && picked !== forceLabel) return;
				const forceDelete = picked === forceLabel;
				const errors: string[] = [];
				let deleted = 0;
				for (const b of localBranches) {
					const err = await this.dataSource.deleteBranch(repo, b, forceDelete);
					if (err !== null) errors.push(b + ': ' + err);
					else deleted++;
				}
				if (errors.length > 0) showErrorMessage(errors.join('\n'));
				else showInformationMessage(t('Deleted {0} local branches.', String(deleted)));
				await this.refreshRows(repo);
			}
		} finally {
			if (this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({ command: 'actionDone' });
			}
		}
	}
}

function getBranchDashboardHtml(repoName: string, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('Branch Lifecycle Dashboard'),
		searchPlaceholder: t('Filter branches by name or author…'),
		all: t('All'),
		local: t('Local'),
		remote: t('Remote'),
		merged: t('Merged'),
		stale: t('Stale (>30d)'),
		tagMerged: t('merged'),
		tagStale: t('stale'),
		deleteSelected: t('Delete Selected Local'),
		refresh: t('Refresh'),
		checkout: t('Checkout'),
		compare: t('Compare'),
		colBranch: t('Branch'),
		colAuthor: t('Author'),
		colAge: t('Age'),
		colStatus: t('Status'),
		colLastCommit: t('Last Commit'),
		selectAll: t('Select all deletable local branches'),
		loading: t('Loading ...'),
		empty: t('No matching branches.')
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<style>*{box-sizing:border-box}body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:12.5px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}' +
		'.bdHdr{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));background:var(--vscode-sideBar-background,var(--vscode-editor-background));position:sticky;top:0;z-index:3}' +
		'.bdHdr h1{margin:0;font-size:14.5px}.bdSearch{flex:1 1 180px;height:26px;padding:0 8px;border-radius:6px;border:1px solid var(--vscode-input-border,rgba(128,128,128,.35));background:var(--vscode-input-background);color:inherit}' +
		'.bdGroup{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:6px;overflow:hidden}.bdGroup button{height:26px;padding:0 9px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.3));background:transparent;color:inherit;cursor:pointer;font-size:12px}' +
		'.bdGroup button:last-child{border-right:0}.bdGroup button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}' +
		'.bdBtn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));color:inherit;cursor:pointer;font-size:12px;margin-right:4px}' +
		'.bdBtn:disabled{opacity:.5;cursor:not-allowed}.bdBtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}' +
		'.bdBtn.danger{background:color-mix(in srgb,var(--vscode-errorForeground,#cf222e) 16%,transparent);border-color:color-mix(in srgb,var(--vscode-errorForeground,#cf222e) 48%,transparent);color:var(--vscode-errorForeground,#cf222e)}' +
		'table{width:100%;border-collapse:collapse}th,td{padding:7px 12px;text-align:left;border-bottom:1px solid rgba(128,128,128,.14)}th{font-size:11.5px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);position:sticky;top:47px;z-index:2;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25))}th[data-sort]{cursor:pointer;user-select:none}th[data-sort]:hover{color:var(--vscode-foreground)}' +
		'.bdSubj{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
		'.bdTag{padding:1px 6px;border-radius:10px;font-size:11px;background:rgba(128,128,128,.18);margin-right:4px}.bdTag.merged{color:var(--vscode-gitDecoration-addedResourceForeground,#2da44e)}.bdTag.stale{color:var(--vscode-editorWarning-foreground,#bf8700)}</style></head>' +
		'<body data-sm-status="loading"><header class="bdHdr"><h1>' + escapeCompanionHtml(strings.title) + ' — ' + escapeCompanionHtml(repoName) + '</h1>' +
		'<input id="bdSearch" class="bdSearch" type="search" placeholder="' + escapeCompanionHtml(strings.searchPlaceholder) + '">' +
		'<div class="bdGroup"><button type="button" data-f="all" class="active">' + escapeCompanionHtml(strings.all) + '</button><button type="button" data-f="local">' + escapeCompanionHtml(strings.local) + '</button><button type="button" data-f="remote">' + escapeCompanionHtml(strings.remote) + '</button><button type="button" data-f="merged">' + escapeCompanionHtml(strings.merged) + '</button><button type="button" data-f="stale">' + escapeCompanionHtml(strings.stale) + '</button></div>' +
		'<button type="button" id="bdDelete" class="bdBtn danger" disabled>' + escapeCompanionHtml(strings.deleteSelected) + '</button>' +
		'<button type="button" id="bdRefresh" class="bdBtn">' + escapeCompanionHtml(strings.refresh) + '</button></header>' +
		'<div id="bdMain" style="padding:12px">' + escapeCompanionHtml(strings.loading) + '</div>' +
		'<script nonce="' + nonce + '">var STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' +
		'(function(){var vscode=acquireVsCodeApi(),ROWS=[],DEFAULT_BRANCH=null,filter="all",q="",sel={},sortKey="age",sortDir=1,busy=false;function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
		'function statusRank(r){return (r.isCurrent?8:0)+(r.merged?4:0)+(r.stale?2:0)+(r.prNumber?1:0);}' +
		'function sortInd(k){return sortKey===k?(sortDir>0?" &#9650;":" &#9660;"):"";}' +
		'function updateDelBtn(){var c=Object.keys(sel).filter(function(k){return sel[k];}).length;var btn=document.getElementById("bdDelete");if(btn){btn.disabled=busy||c===0;btn.textContent=c>0?(STRINGS.deleteSelected+" ("+c+")"):STRINGS.deleteSelected;}}' +
		'function setBusy(v){busy=v;document.querySelectorAll(".bdBtn").forEach(function(b){if(b.id!=="bdDelete"){b.disabled=v;b.setAttribute("aria-busy",v?"true":"false");}});updateDelBtn();}' +
		'function getFiltered(){return ROWS.filter(function(r){if(filter==="local"&&r.isRemote)return false;if(filter==="remote"&&!r.isRemote)return false;if(filter==="merged"&&!r.merged)return false;if(filter==="stale"&&!r.stale)return false;if(q&&r.name.toLowerCase().indexOf(q)===-1&&r.author.toLowerCase().indexOf(q)===-1)return false;return true;}).slice().sort(function(a,b){var cmp=0;if(sortKey==="name")cmp=a.name.localeCompare(b.name);else if(sortKey==="author")cmp=a.author.localeCompare(b.author);else if(sortKey==="status")cmp=statusRank(a)-statusRank(b);else cmp=a.ageDays-b.ageDays;return cmp*sortDir;});}' +
		'function render(){var list=getFiltered();var main=document.getElementById("bdMain");if(list.length===0){main.innerHTML="<p style=\\"padding:12px;color:var(--vscode-descriptionForeground)\\">"+esc(STRINGS.empty)+"</p>";updateDelBtn();return;}' +
		'var deletable=list.filter(function(r){return !r.isRemote&&!r.isCurrent;});var allChecked=deletable.length>0&&deletable.every(function(r){return !!sel[r.name];});' +
		'main.innerHTML="<table><thead><tr><th>"+(deletable.length>0?"<input type=\\"checkbox\\" id=\\"bdSelectAll\\" title=\\""+esc(STRINGS.selectAll)+"\\""+(allChecked?" checked":"")+">":"")+"</th><th data-sort=\\"name\\">"+esc(STRINGS.colBranch)+sortInd("name")+"</th><th data-sort=\\"author\\">"+esc(STRINGS.colAuthor)+sortInd("author")+"</th><th data-sort=\\"age\\">"+esc(STRINGS.colAge)+sortInd("age")+"</th><th data-sort=\\"status\\">"+esc(STRINGS.colStatus)+sortInd("status")+"</th><th>"+esc(STRINGS.colLastCommit)+"</th><th></th></tr></thead><tbody>"+list.map(function(r){var tags="";if(r.isCurrent)tags+="<span class=\\"bdTag\\">HEAD</span>";if(r.merged)tags+="<span class=\\"bdTag merged\\">"+esc(STRINGS.tagMerged)+"</span>";if(r.stale)tags+="<span class=\\"bdTag stale\\">"+esc(STRINGS.tagStale)+"</span>";if(r.prNumber)tags+="<span class=\\"bdTag\\">#"+r.prNumber+"</span>";var canDel=!r.isRemote&&!r.isCurrent;var actions=(!r.isCurrent&&!r.isRemote?"<button type=\\"button\\" class=\\"bdBtn\\" data-co=\\""+esc(r.name)+"\\">"+esc(STRINGS.checkout)+"</button>":"")+(DEFAULT_BRANCH&&r.name!==DEFAULT_BRANCH?"<button type=\\"button\\" class=\\"bdBtn\\" data-cmp=\\""+esc(r.name)+"\\">"+esc(STRINGS.compare)+"</button>":"");return "<tr><td>"+(canDel?"<input type=\\"checkbox\\" data-sel=\\""+esc(r.name)+"\\""+(sel[r.name]?" checked":"")+">":"")+"</td><td><b>"+esc(r.name)+"</b></td><td>"+esc(r.author)+"</td><td>"+r.ageDays+"d</td><td>"+tags+"</td><td class=\\"bdSubj\\" title=\\""+esc(r.subject)+"\\">"+esc(r.subject)+"</td><td style=\\"white-space:nowrap\\">"+actions+"</td></tr>";}).join("")+"</tbody></table>";updateDelBtn();}' +
		'document.getElementById("bdSearch").addEventListener("input",function(e){q=e.target.value.toLowerCase();render();});' +
		'document.getElementById("bdRefresh").addEventListener("click",function(){if(busy)return;setBusy(true);vscode.postMessage({command:"refresh"});});' +
		'document.getElementById("bdDelete").addEventListener("click",function(){if(busy)return;var list=Object.keys(sel).filter(function(k){return sel[k];});if(list.length>0){setBusy(true);vscode.postMessage({command:"deleteSelected",branches:list});}});' +
		'document.addEventListener("change",function(e){if(!(e.target instanceof HTMLInputElement))return;if(e.target.id==="bdSelectAll"){var chk=e.target.checked;getFiltered().forEach(function(r){if(!r.isRemote&&!r.isCurrent)sel[r.name]=chk;});render();}else if(e.target.dataset.sel){sel[e.target.dataset.sel]=e.target.checked;updateDelBtn();}});' +
		'document.addEventListener("click",function(e){var t=e.target instanceof Element?e.target:null;if(!t)return;var fb=t.closest("[data-f]"),co=t.closest("[data-co]"),cmp=t.closest("[data-cmp]"),sh=t.closest("th[data-sort]");if(fb){filter=fb.dataset.f;document.querySelectorAll(".bdGroup button").forEach(function(b){b.classList.toggle("active",b===fb);});render();}else if(co&&!busy){setBusy(true);vscode.postMessage({command:"checkout",branch:co.dataset.co});}else if(cmp&&DEFAULT_BRANCH){vscode.postMessage({command:"compareWithDefault",branch:cmp.dataset.cmp,baseBranch:DEFAULT_BRANCH});}else if(sh){var k=sh.dataset.sort;if(sortKey===k)sortDir=-sortDir;else{sortKey=k;sortDir=1;}render();}});' +
		'window.addEventListener("message",function(ev){if(!ev.data)return;if(ev.data.command==="actionDone"){setBusy(false);return;}if(ev.data.command==="rows"){ROWS=ev.data.rows||[];DEFAULT_BRANCH=ev.data.defaultBranch||null;sel={};setBusy(false);document.body.dataset.smStatus="ready";render();}});})();' +
		'</script></body></html>';
}
