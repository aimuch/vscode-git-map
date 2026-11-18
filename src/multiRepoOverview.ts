import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { GitFeatures } from './gitFeatures';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitOperation } from './types';
import { getNonce, getRepoName, showErrorMessage, showInformationMessage } from './utils';
import { Disposable } from './utils/disposable';

export interface MultiRepoStatusCard {
	readonly repo: string;
	readonly name: string;
	readonly branch: string | null;
	readonly upstream: string | null;
	readonly ahead: number;
	readonly behind: number;
	readonly staged: number;
	readonly unstaged: number;
	readonly untracked: number;
	readonly operation: GitOperation | null;
	readonly lastSubject: string;
	readonly lastDate: number;
	readonly branches: ReadonlyArray<string>;
}

export class MultiRepoOverview extends Disposable {
	private static instance: MultiRepoOverview | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly gitFeatures: GitFeatures;
	private panel: vscode.WebviewPanel | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.gitFeatures = new GitFeatures(dataSource);
		MultiRepoOverview.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.multiRepoOverview', () => this.show()),
			{
				dispose: () => {
					if (this.panel !== null) this.panel.dispose();
					if (MultiRepoOverview.instance === this) MultiRepoOverview.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return MultiRepoOverview.instance;
	}

	public async show() {
		const cards = await this.collectAllStatuses();
		if (cards.length === 0) {
			showErrorMessage(t('No Git repositories were found in the current workspace.'));
			return;
		}
		const title = t('Multi-Repository Overview ({0})', String(cards.length));
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.multiRepoOverview',
				title,
				getConfig().openNewTabEditorGroup,
				{ enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
			);
			const created = this.panel;
			const msgSub = created.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
			const dispSub = created.onDidDispose(() => {
				msgSub.dispose();
				dispSub.dispose();
				if (this.panel === created) this.panel = null;
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}
		this.panel.webview.html = getMultiRepoHtml(cards, this.panel.webview.cspSource);
		this.logger.log('Opened Multi-Repository Overview (' + cards.length + ' repos)');
	}

	private async inspectSingleRepo(repoPath: string, customName: string | null): Promise<MultiRepoStatusCard> {
		const [wt, op, branchRes, headRes] = await Promise.all([
			this.gitFeatures.getWorkingTreeStatus(repoPath),
			this.dataSource.getOperationInProgress(repoPath),
			runGit(this.dataSource, repoPath, ['for-each-ref', '--format=%(HEAD)%1f%(refname:short)%1f%(upstream:short)%1f%(upstream:track)', 'refs/heads']),
			runGit(this.dataSource, repoPath, ['-c', 'log.showSignature=false', 'log', '-1', '--format=%s%x1f%ct', 'HEAD'])
		]);

		let currentBranch: string | null = null, upstream: string | null = null, ahead = 0, behind = 0;
		const localBranches: string[] = [];
		if (branchRes.code === 0) {
			for (const line of branchRes.stdout.toString().split(/\r?\n/)) {
				if (line.trim() === '') continue;
				const [headMark, name, up, track] = line.split('\x1f');
				if (name) localBranches.push(name);
				if (headMark === '*') {
					currentBranch = name || null;
					upstream = up || null;
					const am = (track || '').match(/ahead (\d+)/);
					const bm = (track || '').match(/behind (\d+)/);
					if (am) ahead = parseInt(am[1], 10) || 0;
					if (bm) behind = parseInt(bm[1], 10) || 0;
				}
			}
		}

		let lastSubject = '', lastDate = 0;
		if (headRes.code === 0) {
			const parts = headRes.stdout.toString().trim().split('\x1f');
			lastSubject = parts[0] || '';
			lastDate = parseInt(parts[1] || '0', 10) || 0;
		}

		let staged = 0, unstaged = 0, untracked = 0;
		for (const f of wt.files) {
			if (f.untracked) untracked++;
			else {
				if (f.staged) staged++;
				if (f.unstaged) unstaged++;
			}
		}

		return {
			repo: repoPath,
			name: customName || getRepoName(repoPath),
			branch: currentBranch,
			upstream: upstream,
			ahead: ahead,
			behind: behind,
			staged: staged,
			unstaged: unstaged,
			untracked: untracked,
			operation: op,
			lastSubject: lastSubject,
			lastDate: lastDate,
			branches: localBranches
		};
	}

	private async collectAllStatuses(): Promise<MultiRepoStatusCard[]> {
		const repos = this.repoManager.getRepos();
		const paths = Object.keys(repos);
		const results: MultiRepoStatusCard[] = [];
		const CONCURRENCY = 4;
		for (let i = 0; i < paths.length; i += CONCURRENCY) {
			const batch = paths.slice(i, i + CONCURRENCY);
			const settled = await Promise.all(batch.map((p) => this.inspectSingleRepo(p, repos[p].name)));
			results.push(...settled);
		}
		return results;
	}

	private async onMessage(raw: unknown) {
		if (typeof raw !== 'object' || raw === null || this.panel === null) return;
		const msg = <{ command?: unknown, repos?: unknown, repo?: unknown }>raw;
		const known = this.repoManager.getRepos();
		const validRepos = Array.isArray(msg.repos) ? msg.repos.filter((r): r is string => typeof r === 'string' && typeof known[r] !== 'undefined') : [];

		if (msg.command === 'refresh') {
			const cards = await this.collectAllStatuses();
			if (this.panel !== null) this.panel.webview.postMessage({ command: 'cards', cards: cards });
		} else if (msg.command === 'openRepo' && typeof msg.repo === 'string' && typeof known[msg.repo] !== 'undefined') {
			await vscode.commands.executeCommand('git-map.view', vscode.Uri.file(msg.repo));
		} else if (msg.command === 'openTerminal' && typeof msg.repo === 'string' && typeof known[msg.repo] !== 'undefined') {
			await this.dataSource.openGitTerminal(msg.repo, null, known[msg.repo].name || getRepoName(msg.repo));
		} else if (msg.command === 'batchFetch' && validRepos.length > 0) {
			const errors: string[] = [];
			for (const r of validRepos) {
				const err = await this.dataSource.fetch(r, null, getConfig().fetchAndPrune, getConfig().fetchAndPruneTags);
				if (err !== null) errors.push(getRepoName(r) + ': ' + err);
			}
			if (errors.length > 0) showErrorMessage(errors.join('\n'));
			else showInformationMessage(t('Fetched {0} repositories.', String(validRepos.length)));
			const cards = await this.collectAllStatuses();
			if (this.panel !== null) this.panel.webview.postMessage({ command: 'cards', cards: cards });
		} else if (msg.command === 'batchPull' && validRepos.length > 0) {
			const errors: string[] = [];
			let pulled = 0;
			for (const r of validRepos) {
				const res = await runGit(this.dataSource, r, ['pull', '--ff-only']);
				if (res.code === 0) pulled++;
				else errors.push(getRepoName(r) + ': ' + (res.stderr || 'Pull failed'));
			}
			if (errors.length > 0) showErrorMessage(errors.join('\n'));
			else showInformationMessage(t('Fast-forward pulled {0} repositories.', String(pulled)));
			const cards = await this.collectAllStatuses();
			if (this.panel !== null) this.panel.webview.postMessage({ command: 'cards', cards: cards });
		} else if (msg.command === 'batchCheckout' && validRepos.length > 0) {
			const cards = await this.collectAllStatuses();
			const branchFreq = new Map<string, number>();
			cards.filter((c) => validRepos.includes(c.repo)).forEach((c) => {
				c.branches.forEach((b) => branchFreq.set(b, (branchFreq.get(b) || 0) + 1));
			});
			const choices = Array.from(branchFreq.entries()).sort((a, b) => b[1] - a[1]);
			if (choices.length === 0 || typeof vscode.window.showQuickPick !== 'function') return;
			const picked = await vscode.window.showQuickPick(
				choices.map(([name, count]) => ({ label: name, description: t('Present in {0} selected repositories', String(count)) })),
				{ placeHolder: t('Select a branch to switch to across selected repositories'), ignoreFocusOut: true }
			);
			if (typeof picked === 'undefined') return;
			const errors: string[] = [];
			for (const r of validRepos) {
				const card = cards.find((c) => c.repo === r);
				if (!card || !card.branches.includes(picked.label) || card.branch === picked.label) continue;
				const err = await this.dataSource.checkoutBranch(r, picked.label, null);
				if (err !== null) errors.push(getRepoName(r) + ': ' + err);
			}
			if (errors.length > 0) showErrorMessage(errors.join('\n'));
			const refreshed = await this.collectAllStatuses();
			if (this.panel !== null) this.panel.webview.postMessage({ command: 'cards', cards: refreshed });
		}
	}
}

function escM(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getMultiRepoHtml(cards: ReadonlyArray<MultiRepoStatusCard>, cspSource: string) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('Multi-Repository Overview'),
		fetchAll: t('Fetch Selected'),
		pullAll: t('Pull Selected (--ff-only)'),
		switchBranch: t('Switch Branch…'),
		refresh: t('Refresh'),
		openGitMap: t('Open in Git Map'),
		terminal: t('Terminal'),
		clean: t('Clean'),
		detached: t('Detached HEAD'),
		staged: t('staged'),
		modified: t('modified'),
		untracked: t('untracked')
	};
	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + MR_STYLES + '</style></head><body>' +
		'<header class="mrHeader"><h1>' + escM(strings.title) + '</h1><div class="mrActions">' +
			'<button type="button" class="mrBtn primary" data-batch="batchFetch">' + escM(strings.fetchAll) + '</button>' +
			'<button type="button" class="mrBtn" data-batch="batchPull">' + escM(strings.pullAll) + '</button>' +
			'<button type="button" class="mrBtn" data-batch="batchCheckout">' + escM(strings.switchBranch) + '</button>' +
			'<button type="button" id="mrRefresh" class="mrBtn">' + escM(strings.refresh) + '</button>' +
		'</div></header>' +
		'<main id="mrGrid" class="mrGrid"></main>' +
		'<script nonce="' + nonce + '">var CARDS=' + JSON.stringify(cards).replace(/</g, '\\u003c') + ',STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') + ';' + MR_SCRIPT + '</script></body></html>';
}

const MR_STYLES = `
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button,input{font:inherit;color:inherit}
.mrHeader{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px 20px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));background:var(--vscode-sideBar-background,var(--vscode-editor-background));position:sticky;top:0;z-index:2}
.mrHeader h1{margin:0;font-size:15px}
.mrActions{display:flex;gap:8px;flex-wrap:wrap}
.mrBtn{height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.15));cursor:pointer;font-size:12px}
.mrBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.mrGrid{max-width:1120px;margin:0 auto;padding:16px 20px 40px;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.mrCard{padding:12px 14px;border-radius:8px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.28));display:flex;flex-direction:column;gap:8px}
.mrCardTop{display:flex;align-items:center;gap:8px}
.mrName{font-weight:600;font-size:14px;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrBadges{display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px}
.mrPill{padding:2px 7px;border-radius:10px;background:rgba(128,128,128,.15);font-family:var(--vscode-editor-font-family)}
.mrPill.clean{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}
.mrPill.dirty{color:var(--vscode-gitDecoration-modifiedResourceForeground,#d29922)}
.mrSubj{font-size:12px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrFoot{display:flex;gap:6px;margin-top:auto}
`;

const MR_SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi();
	var selected = {};
	CARDS.forEach(function (c) { selected[c.repo] = true; });
	function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
	function render() {
		document.getElementById('mrGrid').innerHTML = CARDS.map(function (c) {
			var dirtyParts = [];
			if (c.staged > 0) dirtyParts.push(c.staged + ' ' + STRINGS.staged);
			if (c.unstaged > 0) dirtyParts.push(c.unstaged + ' ' + STRINGS.modified);
			if (c.untracked > 0) dirtyParts.push(c.untracked + ' ' + STRINGS.untracked);
			var sync = (c.ahead > 0 ? '↑' + c.ahead : '') + (c.behind > 0 ? (c.ahead > 0 ? ' ' : '') + '↓' + c.behind : '');
			return '<div class="mrCard"><div class="mrCardTop"><input type="checkbox" data-repo-chk="' + esc(c.repo) + '"' + (selected[c.repo] !== false ? ' checked' : '') + '>' +
				'<span class="mrName" title="' + esc(c.repo) + '">' + esc(c.name) + '</span></div>' +
				'<div class="mrBadges"><span class="mrPill">' + esc(c.branch || STRINGS.detached) + '</span>' +
				(sync ? '<span class="mrPill">' + esc(sync) + '</span>' : '') +
				(c.operation ? '<span class="mrPill dirty">' + esc(c.operation) + '</span>' : '') +
				(dirtyParts.length > 0 ? '<span class="mrPill dirty">' + esc(dirtyParts.join(', ')) + '</span>' : '<span class="mrPill clean">' + esc(STRINGS.clean) + '</span>') +
				'</div><div class="mrSubj">' + esc(c.lastSubject) + '</div>' +
				'<div class="mrFoot"><button type="button" class="mrBtn primary" data-open="' + esc(c.repo) + '">' + esc(STRINGS.openGitMap) + '</button>' +
				'<button type="button" class="mrBtn" data-term="' + esc(c.repo) + '">' + esc(STRINGS.terminal) + '</button></div></div>';
		}).join('');
	}
	document.getElementById('mrRefresh').addEventListener('click', function () { vscode.postMessage({ command: 'refresh' }); });
	document.addEventListener('change', function (e) {
		if (e.target instanceof HTMLInputElement && e.target.dataset.repoChk) {
			selected[e.target.dataset.repoChk] = e.target.checked;
		}
	});
	document.addEventListener('click', function (e) {
		var t = e.target instanceof Element ? e.target : null;
		if (!t) return;
		var batch = t.closest('[data-batch]'), openBtn = t.closest('[data-open]'), termBtn = t.closest('[data-term]');
		if (batch) {
			var repos = CARDS.map(function (c) { return c.repo; }).filter(function (r) { return selected[r] !== false; });
			vscode.postMessage({ command: batch.dataset.batch, repos: repos });
		} else if (openBtn) {
			vscode.postMessage({ command: 'openRepo', repo: openBtn.dataset.open });
		} else if (termBtn) {
			vscode.postMessage({ command: 'openTerminal', repo: termBtn.dataset.term });
		}
	});
	window.addEventListener('message', function (ev) {
		if (ev.data && ev.data.command === 'cards') { CARDS = ev.data.cards || []; render(); }
	});
	render();
})();
`;
