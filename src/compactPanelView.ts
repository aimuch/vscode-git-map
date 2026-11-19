import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { getNonce, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

interface CompactCommitRow {
	readonly hash: string;
	readonly subject: string;
	readonly author: string;
	readonly date: number;
	readonly refs: ReadonlyArray<string>;
}

/**
 * Compact dockable Git Map WebviewView (registered in the bottom Panel and movable by users to any Sidebar).
 * Displays live recent commits, branch switcher, and quick sync / jump-to-full-graph actions alongside the editor.
 */
export class CompactPanelView extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewType = 'git-map.compactGraph';

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly extensionState: ExtensionState;
	private readonly logger: Logger;
	private readonly loadSeq: AsyncRequestSequencer = new AsyncRequestSequencer();
	private view: vscode.WebviewView | null = null;
	private activeRepo: string | null = null;

	constructor(
		dataSource: DataSource,
		repoManager: RepoManager,
		extensionState: ExtensionState,
		logger: Logger,
		onDidChangeGitState: (listener: () => void) => vscode.Disposable
	) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.extensionState = extensionState;
		this.logger = logger;
		this.registerDisposables(
			vscode.window.registerWebviewViewProvider(CompactPanelView.viewType, this, { webviewOptions: { retainContextWhenHidden: true } }),
			onDidChangeGitState(() => {
				if (this.view !== null && this.view.visible) void this.refresh();
			}),
			repoManager.onDidChangeRepos(() => {
				if (this.view !== null && this.view.visible) void this.refresh();
			})
		);
	}

	public resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
		webviewView.webview.html = getCompactViewHtml(webviewView.webview.cspSource);
		const msgSub = webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
		const visSub = webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) void this.refresh();
		});
		const dispSub = webviewView.onDidDispose(() => {
			msgSub.dispose();
			visSub.dispose();
			dispSub.dispose();
			if (this.view === webviewView) {
				this.loadSeq.cancel();
				this.view = null;
			}
		});
		void this.refresh();
	}

	private resolveRepo(): string | null {
		const repos = this.repoManager.getRepos();
		const paths = Object.keys(repos);
		if (paths.length === 0) return null;
		if (this.activeRepo !== null && typeof repos[this.activeRepo] !== 'undefined') return this.activeRepo;
		const last = this.extensionState.getLastActiveRepo();
		this.activeRepo = last !== null && typeof repos[last] !== 'undefined' ? last : paths[0];
		return this.activeRepo;
	}

	public async refresh() {
		if (this.view === null) return;
		const repo = this.resolveRepo();
		const repos = Object.keys(this.repoManager.getRepos()).map((p) => ({ path: p, name: getRepoName(p) }));
		if (repo === null) {
			this.view.webview.postMessage({ command: 'compactState', repos: [], activeRepo: null, branch: null, commits: [] });
			return;
		}
		const seq = this.loadSeq.begin();
		const [logRes, branchRes] = await Promise.all([
			runGit(this.dataSource, repo, ['-c', 'log.showSignature=false', 'log', '-n', '40', '--format=%x1e%H%x1f%s%x1f%an%x1f%ct%x1f%D']),
			runGit(this.dataSource, repo, ['symbolic-ref', '-q', '--short', 'HEAD'])
		]);
		if (!this.loadSeq.complete(seq) || this.view === null) return;
		const commits: CompactCommitRow[] = [];
		if (logRes.code === 0) {
			for (const rec of logRes.stdout.toString().split('\x1e')) {
				const trimmed = rec.trim();
				if (trimmed === '') continue;
				const [hash, subject, author, ts, refsRaw] = trimmed.split('\x1f');
				if (!hash) continue;
				const refs = refsRaw ? refsRaw.split(',').map((r) => r.trim()).filter((r) => r !== '') : [];
				commits.push({ hash: hash, subject: subject || '', author: author || '', date: parseInt(ts || '0', 10) || 0, refs: refs });
			}
		}
		const branch = branchRes.code === 0 ? branchRes.stdout.toString().trim() : 'HEAD';
		this.view.webview.postMessage({ command: 'compactState', repos: repos, activeRepo: repo, branch: branch, commits: commits });
		this.logger.log('Refreshed Compact Git Map panel (' + commits.length + ' commits)');
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null) return;
		const msg = <{ command?: unknown, repo?: unknown, hash?: unknown }>raw;
		if (msg.command === 'refresh') {
			await this.refresh();
		} else if (msg.command === 'selectRepo' && typeof msg.repo === 'string') {
			this.activeRepo = msg.repo;
			await this.refresh();
		} else if (msg.command === 'openFull') {
			const repo = this.resolveRepo();
			await vscode.commands.executeCommand('git-map.view', repo !== null ? vscode.Uri.file(repo) : undefined);
		} else if (msg.command === 'viewCommit' && typeof msg.hash === 'string') {
			const repo = this.resolveRepo();
			if (repo !== null) await vscode.commands.executeCommand('git-map.viewCommitInGitMap', repo, msg.hash);
		} else if (msg.command === 'fetch') {
			const repo = this.resolveRepo();
			if (repo !== null) {
				const err = await this.dataSource.fetch(repo, null, true, false);
				if (err !== null) showErrorMessage(err);
				else showInformationMessage(t('Fetched "{0}".', getRepoName(repo)));
				await this.refresh();
			}
		}
	}
}

function getCompactViewHtml(cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		openFull: t('Open Full Git Map'),
		fetch: t('Fetch'),
		refresh: t('Refresh'),
		empty: t('No commits to display.')
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<style>*{box-sizing:border-box}html,body{height:100%;margin:0;padding:0;font-family:var(--vscode-font-family);font-size:12.5px;color:var(--vscode-foreground);background:var(--vscode-panel-background,var(--vscode-editor-background))}' +
		'.cpBar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));position:sticky;top:0;background:inherit;z-index:2}' +
		'.cpSelect,.cpBtn{height:24px;padding:0 8px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:var(--vscode-dropdown-background,transparent);color:inherit;font:inherit;cursor:pointer}' +
		'.cpBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}' +
		'.cpList{overflow-y:auto;height:calc(100% - 37px)}.cpRow{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid rgba(128,128,128,.1);cursor:pointer}' +
		'.cpRow:hover{background:var(--vscode-list-hoverBackground,rgba(128,128,128,.12))}.cpDot{width:8px;height:8px;border-radius:50%;background:var(--vscode-button-background,#0e7afe);flex:0 0 auto}' +
		'.cpSubj{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cpRef{padding:1px 5px;border-radius:3px;font-size:11px;background:rgba(128,128,128,.2);white-space:nowrap}' +
		'.cpMeta{font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;font-family:var(--vscode-editor-font-family)}</style></head>' +
		'<body data-sm-status="loading"><div class="cpBar"><select id="cpRepo" class="cpSelect"></select><span id="cpBranch" class="cpRef"></span><span style="flex:1"></span>' +
		'<button type="button" id="cpFetch" class="cpBtn">' + strings.fetch + '</button>' +
		'<button type="button" id="cpRefresh" class="cpBtn">' + strings.refresh + '</button>' +
		'<button type="button" id="cpOpenFull" class="cpBtn primary">' + strings.openFull + '</button></div>' +
		'<div id="cpList" class="cpList"></div>' +
		'<script nonce="' + nonce + '">var STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' +
		'(function(){var vscode=acquireVsCodeApi();function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
		'document.getElementById("cpRepo").addEventListener("change",function(e){vscode.postMessage({command:"selectRepo",repo:e.target.value});});' +
		'document.getElementById("cpFetch").addEventListener("click",function(){vscode.postMessage({command:"fetch"});});' +
		'document.getElementById("cpRefresh").addEventListener("click",function(){vscode.postMessage({command:"refresh"});});' +
		'document.getElementById("cpOpenFull").addEventListener("click",function(){vscode.postMessage({command:"openFull"});});' +
		'document.getElementById("cpList").addEventListener("click",function(e){var r=e.target instanceof Element?e.target.closest("[data-hash]"):null;if(r)vscode.postMessage({command:"viewCommit",hash:r.dataset.hash});});' +
		'window.addEventListener("message",function(ev){var m=ev.data;if(!m||m.command!=="compactState")return;document.body.dataset.smStatus="ready";' +
		'var sel=document.getElementById("cpRepo");sel.innerHTML=(m.repos||[]).map(function(r){return "<option value=\\""+esc(r.path)+"\\""+(r.path===m.activeRepo?" selected":"")+">"+esc(r.name)+"</option>";}).join("");' +
		'document.getElementById("cpBranch").textContent=m.branch||"";' +
		'var list=document.getElementById("cpList");if(!m.commits||m.commits.length===0){list.innerHTML="<div style=\\"padding:14px;color:var(--vscode-descriptionForeground)\\">"+esc(STRINGS.empty)+"</div>";return;}' +
		'list.innerHTML=m.commits.map(function(c){return "<div class=\\"cpRow\\" data-hash=\\""+esc(c.hash)+"\\"><span class=\\"cpDot\\"></span>"+c.refs.slice(0,2).map(function(r){return "<span class=\\"cpRef\\">"+esc(r)+"</span>";}).join("")+"<span class=\\"cpSubj\\">"+esc(c.subject)+"</span><span class=\\"cpMeta\\">"+esc(c.author)+" · "+esc(c.hash.substring(0,7))+"</span></div>";}).join("");});})();' +
		'</script></body></html>';
}
