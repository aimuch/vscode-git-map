import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { escapeCompanionHtml, resolveSafeRepoSubpath, resolveTargetRepo } from './companionPanelBase';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AsyncRequestSequencer } from './stateMachines';
import { getNonce, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface SubmoduleEntry {
	readonly path: string;
	readonly hash: string;
	readonly status: 'clean' | 'modified' | 'uninitialized' | 'conflict';
	readonly describe: string;
	readonly url: string;
}

/**
 * Parse `git submodule status --recursive` and `.gitmodules` into structured submodule descriptors.
 */
export function parseSubmoduleStatus(statusOutput: string, gitmodulesContent: string): SubmoduleEntry[] {
	const urlByPath = new Map<string, string>();
	let curPath = '';
	for (const line of gitmodulesContent.split(/\r?\n/)) {
		const pm = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
		if (pm !== null) {
			curPath = pm[1].trim();
			continue;
		}
		const um = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
		if (um !== null && curPath !== '') {
			urlByPath.set(curPath, um[1].trim());
		}
	}

	const entries: SubmoduleEntry[] = [];
	for (const rawLine of statusOutput.split(/\r?\n/)) {
		if (rawLine.trim() === '') continue;
		const m = rawLine.match(/^([ +U-])([0-9a-f]{40,64})\s+(\S+)(?:\s+\((.+)\))?$/);
		if (m === null) continue;
		const code = m[1];
		const hash = m[2];
		const subPath = m[3];
		const describe = m[4] || '';
		const status: SubmoduleEntry['status'] = code === '-'
			? 'uninitialized'
			: code === '+'
				? 'modified'
				: code === 'U'
					? 'conflict'
					: 'clean';
		entries.push({
			path: subPath,
			hash: hash,
			status: status,
			describe: describe,
			url: urlByPath.get(subPath) || ''
		});
	}
	return entries;
}

export class SubmoduleManager extends Disposable {
	private static instance: SubmoduleManager | null = null;

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
		SubmoduleManager.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.submoduleManager', (arg?: unknown) => this.show(arg)),
			{
				dispose: () => {
					this.loadSeq.cancel();
					if (this.panel !== null) this.panel.dispose();
					if (SubmoduleManager.instance === this) SubmoduleManager.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return SubmoduleManager.instance;
	}

	public async show(arg?: any) {
		const repo = resolveTargetRepo(this.repoManager, this.extensionState, arg);
		if (repo === null) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		this.currentRepo = repo;
		const title = t('Submodule Manager: {0}', getRepoName(repo));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.submoduleManager',
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
		this.panel.webview.html = getSubmoduleHtml(getRepoName(repo), this.panel.webview.cspSource);
		await this.refreshEntries(repo);
	}

	private async refreshEntries(repo: string) {
		const seq = this.loadSeq.begin();
		const [statusRes, gitmodules] = await Promise.all([
			runGit(this.dataSource, repo, ['submodule', 'status', '--recursive']),
			fs.promises.readFile(path.join(repo, '.gitmodules'), 'utf8').catch(() => '')
		]);
		const entries = statusRes.code === 0 ? parseSubmoduleStatus(statusRes.stdout.toString(), gitmodules) : [];
		if (this.loadSeq.complete(seq) && this.panel !== null && this.currentRepo === repo) {
			this.panel.webview.postMessage({ command: 'submodules', entries: entries });
			this.logger.log('Loaded Submodule Manager for ' + repo + ' (' + entries.length + ' submodules)');
		}
	}

	private async withBusyProgress(title: string, work: () => Promise<void>) {
		if (typeof vscode.window.withProgress === 'function') {
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: title }, work);
		} else {
			await work();
		}
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.currentRepo === null || this.panel === null) return;
		const repo = this.currentRepo;
		const msg = <{ command?: unknown, subPath?: unknown }>raw;
		try {
			if (msg.command === 'refresh') {
				await this.refreshEntries(repo);
			} else if (msg.command === 'updateAll') {
				await this.withBusyProgress(t('Initializing and updating submodules…'), async () => {
					const res = await runGit(this.dataSource, repo, ['submodule', 'update', '--init', '--recursive']);
					if (res.code !== 0) showErrorMessage(res.stderr || t('Failed to update submodules.'));
					else showInformationMessage(t('Initialized and updated all submodules.'));
				});
				await this.refreshEntries(repo);
			} else if (msg.command === 'syncAll') {
				await this.withBusyProgress(t('Syncing submodule URLs…'), async () => {
					const res = await runGit(this.dataSource, repo, ['submodule', 'sync', '--recursive']);
					if (res.code !== 0) showErrorMessage(res.stderr || t('Failed to sync submodules.'));
					else showInformationMessage(t('Synced submodule URLs.'));
				});
				await this.refreshEntries(repo);
			} else if (typeof msg.subPath === 'string') {
				const subPath = msg.subPath;
				const safeAbs = resolveSafeRepoSubpath(repo, subPath);
				if (safeAbs === null) return;
				if (msg.command === 'updateOne') {
					await this.withBusyProgress(t('Updating submodule "{0}"…', subPath), async () => {
						const res = await runGit(this.dataSource, repo, ['submodule', 'update', '--init', '--', subPath]);
						if (res.code !== 0) showErrorMessage(res.stderr || t('Submodule update failed.'));
					});
					await this.refreshEntries(repo);
				} else if (msg.command === 'pullLatest') {
					await this.withBusyProgress(t('Pulling latest commits for submodule "{0}"…', subPath), async () => {
						const res = await runGit(this.dataSource, repo, ['submodule', 'update', '--remote', '--merge', '--', subPath]);
						if (res.code !== 0) showErrorMessage(res.stderr || t('Submodule pull failed.'));
						else showInformationMessage(t('Updated submodule "{0}" to latest remote commit.', subPath));
					});
					await this.refreshEntries(repo);
				} else if (msg.command === 'stagePointer') {
					const res = await runGit(this.dataSource, repo, ['add', '--', subPath]);
					if (res.code !== 0) showErrorMessage(res.stderr || t('Stage submodule pointer failed.'));
					else showInformationMessage(t('Staged submodule pointer "{0}".', subPath));
					await this.refreshEntries(repo);
				} else if (msg.command === 'openInGitMap') {
					await vscode.commands.executeCommand('git-map.view', vscode.Uri.file(safeAbs));
				}
			}
		} finally {
			if (this.panel !== null && this.currentRepo === repo) {
				this.panel.webview.postMessage({ command: 'actionDone' });
			}
		}
	}
}

function getSubmoduleHtml(repoName: string, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('Submodule Manager'),
		updateAll: t('Init & Update All'),
		syncAll: t('Sync URLs'),
		refresh: t('Refresh'),
		updateOne: t('Update'),
		pullLatest: t('Pull Latest'),
		stagePointer: t('Stage Pointer'),
		openGitMap: t('Open in Git Map'),
		loading: t('Loading ...'),
		empty: t('No Git submodules are configured in this repository.'),
		statusLabels: {
			clean: t('Clean'),
			modified: t('Modified'),
			uninitialized: t('Uninitialized'),
			conflict: t('Conflict')
		}
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<style>*{box-sizing:border-box}body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}' +
		'.smHdr{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));background:var(--vscode-sideBar-background,var(--vscode-editor-background));position:sticky;top:0;z-index:2}' +
		'.smHdr h1{margin:0;font-size:15px}.smBtns{display:flex;gap:6px;flex-wrap:wrap}.smBtn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.14));color:inherit;cursor:pointer;font-size:12px}' +
		'.smBtn:disabled{opacity:.55;cursor:wait}.smBtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}' +
		'.smBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}' +
		'.smList{max-width:1040px;margin:0 auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px}.smCard{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.28));border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:6px}' +
		'.smTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.smPath{font-family:var(--vscode-editor-font-family);font-weight:600}.smBadge{padding:2px 7px;border-radius:10px;font-size:11px;background:rgba(128,128,128,.18)}' +
		'.smBadge.clean{color:var(--vscode-gitDecoration-addedResourceForeground,#2da44e)}.smBadge.modified,.smBadge.uninitialized{color:var(--vscode-editorWarning-foreground,#bf8700)}.smBadge.conflict{color:var(--vscode-errorForeground,#cf222e)}.smMeta{font-size:12px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family)}</style></head>' +
		'<body data-sm-status="loading"><header class="smHdr"><h1>' + escapeCompanionHtml(strings.title) + ' — ' + escapeCompanionHtml(repoName) + '</h1><div class="smBtns">' +
		'<button type="button" class="smBtn primary" data-cmd="updateAll">' + escapeCompanionHtml(strings.updateAll) + '</button>' +
		'<button type="button" class="smBtn" data-cmd="syncAll">' + escapeCompanionHtml(strings.syncAll) + '</button>' +
		'<button type="button" class="smBtn" data-cmd="refresh">' + escapeCompanionHtml(strings.refresh) + '</button></div></header>' +
		'<main id="smList" class="smList"><div>' + escapeCompanionHtml(strings.loading) + '</div></main>' +
		'<script nonce="' + nonce + '">var STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' +
		'(function(){var vscode=acquireVsCodeApi(),busy=false;function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
		'function setBusy(v){busy=v;document.querySelectorAll(".smBtn").forEach(function(b){b.disabled=v;b.setAttribute("aria-busy",v?"true":"false");});}' +
		'document.addEventListener("click",function(e){if(busy)return;var b=e.target instanceof Element?e.target.closest("[data-cmd]"):null;if(b){setBusy(true);vscode.postMessage({command:b.dataset.cmd,subPath:b.dataset.path||""});}});' +
		'window.addEventListener("message",function(ev){var m=ev.data;if(!m)return;if(m.command==="actionDone"){setBusy(false);return;}if(m.command!=="submodules")return;setBusy(false);document.body.dataset.smStatus="ready";var el=document.getElementById("smList");var items=m.entries||[];' +
		'if(items.length===0){el.innerHTML="<div class=\\"smCard\\">"+esc(STRINGS.empty)+"</div>";return;}' +
		'el.innerHTML=items.map(function(s){var lbl=(STRINGS.statusLabels&&STRINGS.statusLabels[s.status])||s.status;return "<div class=\\"smCard\\"><div class=\\"smTop\\"><span class=\\"smPath\\">"+esc(s.path)+"</span><span class=\\"smBadge "+esc(s.status)+"\\">"+esc(lbl)+"</span><span class=\\"smMeta\\">"+esc(s.hash.substring(0,8))+(s.describe?" ("+esc(s.describe)+")":"")+"</span></div>"+(s.url?"<div class=\\"smMeta\\">"+esc(s.url)+"</div>":"")+"<div class=\\"smBtns\\"><button type=\\"button\\" class=\\"smBtn\\" data-cmd=\\"updateOne\\" data-path=\\""+esc(s.path)+"\\">"+esc(STRINGS.updateOne)+"</button><button type=\\"button\\" class=\\"smBtn\\" data-cmd=\\"pullLatest\\" data-path=\\""+esc(s.path)+"\\">"+esc(STRINGS.pullLatest)+"</button><button type=\\"button\\" class=\\"smBtn\\" data-cmd=\\"stagePointer\\" data-path=\\""+esc(s.path)+"\\">"+esc(STRINGS.stagePointer)+"</button><button type=\\"button\\" class=\\"smBtn primary\\" data-cmd=\\"openInGitMap\\" data-path=\\""+esc(s.path)+"\\">"+esc(STRINGS.openGitMap)+"</button></div></div>";}).join("");});})();' +
		'</script></body></html>';
}
