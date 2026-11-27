import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { runGit } from './historyRewrite';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitCommitDetails, GitFileStatus } from './types';
import { abbrevCommit, copyToClipboard, getNonce, getPathFromUri, getRelativeTimeDiff, openFile, showErrorMessage, viewDiff } from './utils';
import { Disposable } from './utils/disposable';

const HASH_REGEXP = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const FOLLOW_DELAY = 250; // The delay (in milliseconds) after the cursor moves before the commit of its line is shown

/**
 * What the Inspect view shows.
 */
type InspectContent =
	{ readonly kind: 'empty', readonly message: string } |
	{ readonly kind: 'loading' } |
	{ readonly kind: 'uncommitted', readonly repo: string, readonly filePath: string } |
	{ readonly kind: 'commit', readonly repo: string, readonly details: GitCommitDetails, readonly filePath: string | null };

/**
 * A message sent by the Inspect view's Webview.
 */
type InspectMessage =
	{ readonly command: 'openDiff' | 'openFile', readonly index: number } |
	{ readonly command: 'viewInGitMap' | 'copyHash' | 'copyMessage' | 'togglePin' | 'explain' | 'openWorkingChanges' };

/**
 * The Inspect view (in Git Map's Secondary Side Bar container): the details of the commit that last changed the line the cursor is on
 * (following the cursor), or of the commit chosen to be inspected (e.g. from the Git Map View) — its author, date, message & changed files,
 * with actions to open its changes, view it in Git Map, and explain it with AI.
 */
export class InspectView extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewId = 'git-map.inspect';

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private view: vscode.WebviewView | null = null;
	private content: InspectContent = { kind: 'empty', message: '' };
	private pinned: boolean = false; // Don't follow the cursor (a commit chosen to be inspected stays shown)
	private followTimeout: NodeJS.Timeout | null = null;
	private requestId: number = 0;

	/**
	 * Creates the Inspect view.
	 * @param dataSource The DataSource used to read commits.
	 * @param repoManager The RepoManager used to find the repository of files.
	 * @param logger The Logger.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.content = { kind: 'empty', message: t('Move the cursor to a line in a file of a repository to inspect the commit that last changed it.') };
		this.registerDisposables(
			vscode.window.registerWebviewViewProvider(InspectView.viewId, this),
			vscode.commands.registerCommand('git-map.inspect', (arg1?: unknown, arg2?: unknown) => this.inspect(arg1, arg2)),
			vscode.window.onDidChangeTextEditorSelection((event) => this.scheduleFollow(event.textEditor)),
			vscode.window.onDidChangeActiveTextEditor((editor) => this.scheduleFollow(editor)),
			{
				dispose: () => {
					if (this.followTimeout !== null) clearTimeout(this.followTimeout);
					this.view = null;
				}
			}
		);
	}

	/**
	 * Resolves the Webview of the view, when it's shown (Visual Studio Code calls this).
	 * @param webviewView The view.
	 */
	public resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
		webviewView.webview.html = getInspectPage(this.content, this.pinned, webviewView.webview.cspSource);
		const messageDisposable = webviewView.webview.onDidReceiveMessage((message: InspectMessage) => this.onMessage(message).catch((error) => this.logger.logError('Inspect: ' + error)));
		const visibilityDisposable = webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) this.scheduleFollow(vscode.window.activeTextEditor);
		});
		const disposeDisposable = webviewView.onDidDispose(() => {
			messageDisposable.dispose();
			visibilityDisposable.dispose();
			disposeDisposable.dispose();
			if (this.view === webviewView) this.view = null;
		});
		this.scheduleFollow(vscode.window.activeTextEditor);
	}

	/**
	 * The method run when the `git-map.inspect` command is invoked: inspect a commit (`{ repo, commitHash }`, or `(repo, hash)`), or the
	 * commit of the line the cursor is on.
	 */
	public async inspect(arg1?: unknown, arg2?: unknown) {
		let repo: string | null = null, hash: string | null = null;
		if (typeof arg1 === 'object' && arg1 !== null && typeof (<any>arg1).repo === 'string' && typeof (<any>arg1).commitHash === 'string') {
			repo = (<any>arg1).repo;
			hash = (<any>arg1).commitHash;
		} else if (typeof arg1 === 'string' && typeof arg2 === 'string') {
			repo = arg1;
			hash = arg2;
		}
		await this.reveal();
		if (repo !== null && hash !== null && HASH_REGEXP.test(hash)) {
			this.pinned = true;
			await this.showCommit(repo, hash, null);
		} else {
			this.pinned = false;
			await this.follow(vscode.window.activeTextEditor);
		}
	}

	/**
	 * Show the view (opening the Secondary Side Bar if it's closed).
	 */
	private async reveal() {
		if (this.view !== null) {
			this.view.show(true);
		} else {
			await vscode.commands.executeCommand(InspectView.viewId + '.focus').then(() => { }, () => { });
		}
	}

	/**
	 * Show the commit of the line the cursor is on, shortly after the cursor stops moving (while the view is visible & not pinned).
	 */
	private scheduleFollow(editor: vscode.TextEditor | undefined) {
		if (this.pinned || this.view === null || !this.view.visible) return;
		if (this.followTimeout !== null) clearTimeout(this.followTimeout);
		this.followTimeout = setTimeout(() => {
			this.followTimeout = null;
			this.follow(editor).catch((error) => this.logger.logError('Inspect: ' + error));
		}, FOLLOW_DELAY);
	}

	/**
	 * Show the commit that last changed the line the cursor is on.
	 */
	private async follow(editor: vscode.TextEditor | undefined) {
		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') return;
		const requestId = ++this.requestId, document = editor.document, line = editor.selection.active.line;
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(document.uri));
		if (requestId !== this.requestId) return;
		if (file === null) {
			this.render({ kind: 'empty', message: t('This file isn\'t in a Git repository known to Git Map.') });
			return;
		}
		const blame = await this.dataSource.getLineBlame(file.repo, file.path, line + 1, document.isDirty ? document.getText() : null);
		if (requestId !== this.requestId) return;
		if (blame === null) {
			this.render({ kind: 'empty', message: t('This line can\'t be blamed (e.g. the file isn\'t tracked by Git).') });
		} else if (!blame.committed) {
			this.render({ kind: 'uncommitted', repo: file.repo, filePath: file.path });
		} else if (this.content.kind !== 'commit' || this.content.details.hash !== blame.hash || this.content.repo !== file.repo) {
			await this.showCommit(file.repo, blame.hash, file.path, requestId);
		}
	}

	/**
	 * Show the details of a commit.
	 */
	private async showCommit(repo: string, hash: string, filePath: string | null, requestId: number = ++this.requestId) {
		this.render({ kind: 'loading' });
		const parents = await runGit(this.dataSource, repo, ['rev-list', '--parents', '-n', '1', hash, '--']);
		const hasParents = parents.code === 0 && parents.stdout.toString().trim().split(' ').length > 1;
		const data = await this.dataSource.getCommitDetails(repo, hash, hasParents);
		if (requestId !== this.requestId) return;
		if (data.commitDetails === null) {
			this.render({ kind: 'empty', message: data.error !== null ? data.error : t('Unable to load the commit.') });
		} else {
			this.render({ kind: 'commit', repo: repo, details: data.commitDetails, filePath: filePath });
		}
	}

	private render(content: InspectContent) {
		this.content = content;
		if (this.view !== null) this.view.webview.postMessage({ command: 'render', html: renderInspectContent(content, this.pinned) });
	}

	private async onMessage(message: InspectMessage) {
		const content = this.content;
		if (message.command === 'togglePin') {
			this.pinned = !this.pinned;
			this.render(this.content);
			if (!this.pinned) await this.follow(vscode.window.activeTextEditor);
			return;
		}
		if (content.kind === 'uncommitted' && message.command === 'openWorkingChanges') {
			await vscode.commands.executeCommand('git.openChange', vscode.Uri.file(content.repo + '/' + content.filePath)).then(() => { }, () => { });
			return;
		}
		if (content.kind !== 'commit') return;
		const details = content.details, parent = details.parents.length > 0 ? details.parents[0] : null;
		switch (message.command) {
			case 'openDiff': {
				const change = details.fileChanges[message.index];
				if (typeof change === 'undefined') return;
				const error = await viewDiff(content.repo, parent !== null ? parent : details.hash, details.hash, change.oldFilePath, change.newFilePath, parent !== null ? change.type : GitFileStatus.Added);
				if (error !== null) showErrorMessage(error);
				break;
			}
			case 'openFile': {
				const change = details.fileChanges[message.index];
				if (typeof change === 'undefined') return;
				const error = await openFile(content.repo, change.newFilePath, null, this.dataSource);
				if (error !== null) showErrorMessage(error);
				break;
			}
			case 'viewInGitMap':
				await vscode.commands.executeCommand('git-map.viewCommitInGitMap', content.repo, details.hash);
				break;
			case 'copyHash':
				await copyToClipboard(details.hash);
				vscode.window.setStatusBarMessage(t('Copied {0} to the clipboard.', abbrevCommit(details.hash)), 3000);
				break;
			case 'copyMessage':
				await copyToClipboard(details.body);
				vscode.window.setStatusBarMessage(t('Copied the commit message to the clipboard.'), 3000);
				break;
			case 'explain':
				if (parent !== null) {
					await vscode.commands.executeCommand('git-map.ai.explainChanges', { repo: content.repo, mode: 'range', fromRef: parent, toRef: details.hash, label: abbrevCommit(details.hash) + ' ' + details.body.split('\n')[0] });
				}
				break;
		}
	}
}

function escapeHtml(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const ICONS = {
	pin: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M9.6 1 15 6.4l-.7.7-1.1-.4-2.8 2.8.4 2.6-.7.7-3.1-3.1L3.2 13.5h-.7v-.7L6.3 9 3.2 5.9l.7-.7 2.6.4 2.8-2.8-.4-1.1.7-.7z"/></svg>',
	graph: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M5 3.5a1.5 1.5 0 1 1-2 1.4V11a1.5 1.5 0 1 1-1 0V4.9a1.5 1.5 0 0 1 3-1.4zm7.5 3a1.5 1.5 0 0 1-1 1.4c-.2 2-1.8 3.1-4 3.1H5.9a1.5 1.5 0 1 1 0-1H7.5c1.7 0 2.8-.7 3-2.1a1.5 1.5 0 1 1 2-1.4z"/></svg>',
	copy: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4 4V1.5l.5-.5h8.9l.6.5v9l-.5.5H11v2.5l-.5.5H2.6l-.6-.5v-9l.5-.5H4zm1 0h5.5l.5.5V10h2V2H5v2zm5 1H3v8h7V5z"/></svg>',
	sparkle: '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M7.5 1 9 5.5 13.5 7 9 8.5 7.5 13 6 8.5 1.5 7 6 5.5zM13 10l.7 1.8 1.8.7-1.8.7L13 15l-.7-1.8-1.8-.7 1.8-.7z"/></svg>'
};

/**
 * Render the content of the Inspect view.
 */
function renderInspectContent(content: InspectContent, pinned: boolean) {
	const pinButton = '<button type="button" class="act' + (pinned ? ' on' : '') + '" data-act="togglePin" title="' + escapeHtml(pinned ? t('Follow the Cursor') : t('Pin this Commit (Stop Following the Cursor)')) + '">' + ICONS.pin + '</button>';
	if (content.kind === 'empty') return '<div class="toolbar"><span class="grow"></span>' + pinButton + '</div><p class="message">' + escapeHtml(content.message) + '</p>';
	if (content.kind === 'loading') return '<p class="message">' + escapeHtml(t('Loading')) + '…</p>';
	if (content.kind === 'uncommitted') {
		return '<div class="toolbar"><span class="grow"></span>' + pinButton + '</div>' +
			'<div class="card"><div class="subject">' + escapeHtml(t('Uncommitted Changes')) + '</div><p class="message">' + escapeHtml(t('This line has changes that haven\'t been committed yet.')) + '</p>' +
			'<button type="button" class="btn" data-act="openWorkingChanges">' + escapeHtml(t('Open Changes')) + '</button></div>';
	}
	const d = content.details, lines = d.body.split('\n'), subject = lines[0], body = lines.slice(1).join('\n').trim();
	const date = new Date(d.authorDate * 1000);
	const files = d.fileChanges.map((change, index) => {
		const slash = change.newFilePath.lastIndexOf('/');
		const isCurrent = content.filePath !== null && (change.newFilePath === content.filePath || change.oldFilePath === content.filePath);
		return '<div class="file' + (isCurrent ? ' current' : '') + '" data-index="' + index + '" title="' + escapeHtml(change.newFilePath) + '">' +
			'<span class="status s' + change.type + '">' + change.type + '</span>' +
			'<span class="name">' + escapeHtml(change.newFilePath.substring(slash + 1)) + ' <span class="dir">' + escapeHtml(change.newFilePath.substring(0, slash + 1)) + '</span></span>' +
			(change.additions !== null && change.deletions !== null ? '<span class="stats"><span class="add">+' + change.additions + '</span> <span class="del">−' + change.deletions + '</span></span>' : '') +
			'<button type="button" class="mini" data-act="openFile" data-index="' + index + '" title="' + escapeHtml(t('Open File')) + '">↗</button></div>';
	}).join('');
	return '<div class="toolbar">' +
		'<button type="button" class="act hash" data-act="copyHash" title="' + escapeHtml(t('Copy Commit Hash to Clipboard')) + '">' + ICONS.copy + escapeHtml(abbrevCommit(d.hash)) + '</button>' +
		'<span class="grow"></span>' +
		'<button type="button" class="act" data-act="viewInGitMap" title="' + escapeHtml(t('View Commit in Git Map')) + '">' + ICONS.graph + '</button>' +
		(d.parents.length > 0 ? '<button type="button" class="act" data-act="explain" title="' + escapeHtml(t('Explain with AI')) + '">' + ICONS.sparkle + '</button>' : '') +
		'<button type="button" class="act" data-act="copyMessage" title="' + escapeHtml(t('Copy Commit Message to Clipboard')) + '">' + ICONS.copy + '</button>' +
		pinButton + '</div>' +
		'<div class="card"><div class="subject">' + escapeHtml(subject) + '</div>' +
		(body !== '' ? '<div class="body">' + escapeHtml(body) + '</div>' : '') +
		'<div class="meta"><b>' + escapeHtml(d.author) + '</b> <span title="' + escapeHtml(date.toLocaleString(getLanguage() === 'zh-cn' ? 'zh-CN' : 'en')) + '">' + escapeHtml(getRelativeTimeDiff(d.authorDate)) + '</span>' +
		(d.committer !== d.author ? '<br>' + escapeHtml(t('Committed by {0}', d.committer)) : '') + '</div></div>' +
		'<div class="section">' + escapeHtml(d.fileChanges.length !== 1 ? t('{0} Files Changed', d.fileChanges.length) : t('1 File Changed')) + '</div>' +
		'<div class="files">' + files + '</div>';
}

const STYLES = [
	'body{padding:0 8px 8px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);}',
	'.toolbar{display:flex;align-items:center;gap:2px;padding:6px 0;position:sticky;top:0;background:var(--vscode-sideBar-background);}',
	'.grow{flex:1}',
	'.act{display:inline-flex;align-items:center;gap:4px;background:none;border:0;color:var(--vscode-foreground);padding:3px 4px;border-radius:4px;cursor:pointer;font:inherit;}',
	'.act:hover,.act.on{background:var(--vscode-toolbar-hoverBackground);}',
	'.act.on{color:var(--vscode-focusBorder);}',
	'.act.hash{font-family:var(--vscode-editor-font-family);color:var(--vscode-textLink-foreground);}',
	'.card{border:1px solid var(--vscode-widget-border,rgba(128,128,128,.3));border-radius:6px;padding:8px 10px;margin-bottom:8px;}',
	'.subject{font-weight:600;margin-bottom:4px;word-break:break-word;}',
	'.body{white-space:pre-wrap;word-break:break-word;opacity:.9;margin-bottom:6px;}',
	'.meta{color:var(--vscode-descriptionForeground);font-size:.92em;}',
	'.message{color:var(--vscode-descriptionForeground);}',
	'.section{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--vscode-descriptionForeground);margin:4px 0;}',
	'.file{display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:4px;cursor:pointer;}',
	'.file:hover{background:var(--vscode-list-hoverBackground);}',
	'.file.current{background:var(--vscode-list-inactiveSelectionBackground);}',
	'.status{font-family:var(--vscode-editor-font-family);font-size:11px;width:12px;text-align:center;}',
	'.sA,.sU{color:var(--vscode-gitDecoration-addedResourceForeground);}.sM{color:var(--vscode-gitDecoration-modifiedResourceForeground);}.sD{color:var(--vscode-gitDecoration-deletedResourceForeground);}.sR{color:var(--vscode-gitDecoration-renamedResourceForeground);}',
	'.name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
	'.dir{color:var(--vscode-descriptionForeground);font-size:.9em;}',
	'.stats{font-size:11px;font-family:var(--vscode-editor-font-family);}.add{color:var(--vscode-gitDecoration-addedResourceForeground);}.del{color:var(--vscode-gitDecoration-deletedResourceForeground);}',
	'.mini{background:none;border:0;color:var(--vscode-foreground);cursor:pointer;visibility:hidden;}.file:hover .mini{visibility:visible;}',
	'.btn{margin-top:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:4px 10px;border-radius:3px;cursor:pointer;}'
].join('');

const SCRIPT = [
	'(function(){var vscode=acquireVsCodeApi(),root=document.getElementById("root");',
	'window.addEventListener("message",function(e){if(e.data&&e.data.command==="render")root.innerHTML=e.data.html;});',
	'root.addEventListener("click",function(e){var t=e.target;if(!(t instanceof Element))return;',
	'var a=t.closest("[data-act]");if(a!==null){var i=a.getAttribute("data-index");vscode.postMessage(i!==null?{command:a.getAttribute("data-act"),index:parseInt(i,10)}:{command:a.getAttribute("data-act")});return;}',
	'var f=t.closest(".file");if(f!==null)vscode.postMessage({command:"openDiff",index:parseInt(f.getAttribute("data-index"),10)});});})();'
].join('');

/**
 * Get the HTML of the Inspect view's Webview.
 */
function getInspectPage(content: InspectContent, pinned: boolean, cspSource: string) {
	const nonce = getNonce();
	return '<!DOCTYPE html><html lang="' + (getLanguage() === 'zh-cn' ? 'zh-CN' : 'en') + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + STYLES + '</style></head>' +
		'<body><div id="root">' + renderInspectContent(content, pinned) + '</div><script nonce="' + nonce + '">' + SCRIPT + '</script></body></html>';
}
