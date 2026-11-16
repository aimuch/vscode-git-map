import * as vscode from 'vscode';
import { EscapeStack } from './escapeStack';
import { getLanguage, t } from './l10n';
import { GitLineHistory, GitLineHistoryEntry, GitLineRange } from './types';
import { UNCOMMITTED, abbrevCommit, getNonce, getRelativeTimeDiff } from './utils';
import { Disposable } from './utils/disposable';

/**
 * The maximum number of lines of the diff of a change shown in the drawer (the full diff can be opened).
 */
const MAX_DIFF_LINES = 200;

/**
 * A message sent by the drawer's Webview.
 */
export type LineHistoryDrawerMessage =
	{ readonly command: 'action', readonly action: string, readonly index: number } |
	{ readonly command: 'loadMore' } |
	{ readonly command: 'escape' };

/**
 * What the drawer shows: nothing yet, the history of lines that's loading, or the history of lines.
 */
export type LineHistoryDrawerContent =
	{ readonly kind: 'empty' } |
	{ readonly kind: 'loading', readonly filePath: string, readonly range: GitLineRange } |
	{ readonly kind: 'history', readonly history: GitLineHistory, readonly avatars: { readonly [email: string]: string } };

/**
 * The drawer (a view in the Secondary Side Bar) showing the history of lines: a timeline of the changes (with their date, author & avatar)
 * on the left, and the selected change on the right (its commit, and how it changed the lines).
 */
export class LineHistoryDrawer extends Disposable implements vscode.WebviewViewProvider {
	public static readonly viewId = 'git-map.lineHistory';

	private view: vscode.WebviewView | null = null;
	private content: LineHistoryDrawerContent = { kind: 'empty' };
	private readonly onMessage: (message: LineHistoryDrawerMessage) => void;

	/**
	 * Creates the drawer.
	 * @param onMessage Called with each message sent by the drawer's Webview.
	 */
	constructor(onMessage: (message: LineHistoryDrawerMessage) => void) {
		super();
		this.onMessage = onMessage;
		this.registerDisposable({ dispose: () => this.view = null });
	}

	/**
	 * Resolves the Webview of the drawer, when it's shown (Visual Studio Code calls this).
	 * @param webviewView The view.
	 */
	public resolveWebviewView(webviewView: vscode.WebviewView) {
		this.view = webviewView;
		webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
		webviewView.webview.html = getLineHistoryPage(this.content, webviewView.webview.cspSource);
		const messageDisposable = webviewView.webview.onDidReceiveMessage((message: LineHistoryDrawerMessage) => this.onMessage(message));
		const visibilityDisposable = webviewView.onDidChangeVisibility(() => EscapeStack.update());
		const disposeDisposable = webviewView.onDidDispose(() => {
			messageDisposable.dispose();
			visibilityDisposable.dispose();
			disposeDisposable.dispose();
			if (this.view === webviewView) this.view = null;
			EscapeStack.update();
		});
	}

	/**
	 * Show the drawer (opening the Secondary Side Bar if it's closed).
	 */
	public async reveal() {
		if (this.view !== null) {
			this.view.show(false);
		} else {
			await vscode.commands.executeCommand(LineHistoryDrawer.viewId + '.focus');
		}
	}

	/**
	 * Is the drawer visible.
	 */
	public isVisible() {
		return this.view !== null && this.view.visible;
	}

	/**
	 * Show content in the drawer.
	 * @param content The content.
	 */
	public show(content: LineHistoryDrawerContent) {
		this.content = content;
		if (this.view !== null) this.view.webview.postMessage({ command: 'render', html: renderContent(content), key: getContentKey(content) });
	}

	/**
	 * Get the content shown in the drawer.
	 */
	public getContent() {
		return this.content;
	}

	/**
	 * Show an avatar that has been loaded.
	 * @param email The email address of the author.
	 * @param image The avatar (a data URI).
	 */
	public showAvatar(email: string, image: string) {
		if (this.view !== null) this.view.webview.postMessage({ command: 'avatar', email: email, image: image });
	}
}

/**
 * Get the HTML of the drawer's Webview.
 * @param content The content of the drawer.
 * @param cspSource The source of the Webview's resources (used by its Content Security Policy).
 * @returns The HTML.
 */
export function getLineHistoryPage(content: LineHistoryDrawerContent, cspSource: string) {
	const nonce = getNonce();
	return '<!DOCTYPE html><html lang="' + (getLanguage() === 'zh-cn' ? 'zh-CN' : 'en') + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\'; img-src data:;">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + STYLES + '</style></head>' +
		'<body><div id="root" data-key="' + escapeHtml(getContentKey(content)) + '">' + renderContent(content) + '</div>' +
		'<script nonce="' + nonce + '">' + SCRIPT + '</script></body></html>';
}

/**
 * Get a key identifying the history shown (the selected change is kept while the same history is shown, e.g. when more commits are loaded).
 * @param content The content of the drawer.
 * @returns The key.
 */
function getContentKey(content: LineHistoryDrawerContent) {
	return content.kind === 'history' ? content.history.repo + '\n' + content.history.filePath + '\n' + content.history.range.start + '-' + content.history.range.end : '';
}

/**
 * Render the content of the drawer.
 * @param content The content.
 * @returns The HTML.
 */
function renderContent(content: LineHistoryDrawerContent) {
	if (content.kind === 'empty') {
		return '<div class="lhMessage"><p>' + escapeHtml(t('Right-click on lines in an editor, and select Git Map > View Line History to see how they changed.')) + '</p></div>';
	} else if (content.kind === 'loading') {
		return '<div class="lhMessage"><p>' + escapeHtml(t('Loading the history of lines {0}–{1} of {2} ...', content.range.start, content.range.end, getFileName(content.filePath))) + '</p></div>';
	}

	const history = content.history, entries = history.entries;
	const authors = new Set(entries.filter((entry) => entry.hash !== UNCOMMITTED).map((entry) => entry.authorEmail || entry.author)).size;
	const numCommits = entries.filter((entry) => entry.hash !== UNCOMMITTED).length;
	let html = '<div class="lhHeader"><div class="lhHeaderFile"><b title="' + escapeHtml(history.filePath) + '">' + escapeHtml(getFileName(history.filePath)) + '</b>' +
		'<span class="lhMuted">' + escapeHtml(getDirectory(history.filePath)) + '</span></div>' +
		'<div class="lhHeaderMeta"><span class="lhRange">' + escapeHtml(formatRange(history.range)) + '</span>' +
		(history.headRange !== null && (history.headRange.start !== history.range.start || history.headRange.end !== history.range.end) ? '<span class="lhMuted">' + escapeHtml(history.headRange.start === history.headRange.end ? t('(line {0} in HEAD)', history.headRange.start) : t('(lines {0}–{1} in HEAD)', history.headRange.start, history.headRange.end)) + '</span>' : '') +
		'<span class="lhMuted">' + escapeHtml((numCommits === 1 && !history.moreAvailable ? t('1 commit') : t('{0} commits', numCommits + (history.moreAvailable ? '+' : ''))) + ' · ' + (authors === 1 ? t('1 author') : t('{0} authors', authors))) + '</span></div></div>';
	if (history.error !== null) {
		html += '<div class="lhError">' + escapeHtml(t('Unable to load the history of the lines: {0}', history.error)) + '</div>';
	}
	if (entries.length === 0) {
		return html + (history.error === null ? '<div class="lhMessage"><p>' + escapeHtml(t('No changes to these lines were found.')) + '</p></div>' : '');
	}

	html += '<div class="lhLayout"><ol class="lhTimeline" role="listbox" aria-label="' + escapeHtml(t('Changes')) + '">' + entries.map((entry, index) => renderTimelineItem(entry, index, content.avatars)).join('') +
		(history.moreAvailable ? '<li class="lhMore"><button type="button" class="lhAction" data-command="loadMore">' + ICONS.more + '<span>' + escapeHtml(t('Load More Commits')) + '</span></button></li>' : '') +
		'</ol><div class="lhSide"><div class="lhDetails">' + entries.map((entry, index) => renderDetails(history, entry, index, content.avatars)).join('') + '</div></div></div>';
	return html;
}

/**
 * Render an item of the timeline: the avatar, author, date & subject of a change.
 */
function renderTimelineItem(entry: GitLineHistoryEntry, index: number, avatars: { readonly [email: string]: string }) {
	const uncommitted = entry.hash === UNCOMMITTED;
	return '<li class="lhItem' + (uncommitted ? ' uncommitted' : '') + '" data-index="' + index + '" role="option" tabindex="-1">' +
		renderAvatar(entry, avatars) +
		'<span class="lhItemText"><span class="lhItemTop"><b class="lhAuthor">' + escapeHtml(uncommitted ? t('You') : entry.author) + '</b>' +
		'<span class="lhDate" title="' + escapeHtml(formatDate(entry.authorDate)) + '">' + escapeHtml(uncommitted ? t('Uncommitted') : getRelativeTimeDiff(entry.authorDate)) + '</span></span>' +
		'<span class="lhSubject">' + escapeHtml(uncommitted ? t('Uncommitted Changes') : entry.subject) + '</span>' +
		'<span class="lhItemMeta">' + (uncommitted ? '' : '<span class="lhHash">' + escapeHtml(abbrevCommit(entry.hash)) + '</span>') +
		'<span class="lhAdd">+' + entry.additions + '</span><span class="lhDel">−' + entry.deletions + '</span></span></span></li>';
}

/**
 * Render the details of a change: its commit, how it changed the lines, and the actions for it.
 */
function renderDetails(history: GitLineHistory, entry: GitLineHistoryEntry, index: number, avatars: { readonly [email: string]: string }) {
	const uncommitted = entry.hash === UNCOMMITTED, canSeeBefore = !entry.fileAdded && (uncommitted || entry.parents.length > 0);
	const action = (name: string, icon: string, label: string, title: string) => '<button type="button" class="lhAction" data-action="' + name + '" title="' + escapeHtml(title) + '">' + icon + '<span>' + escapeHtml(label) + '</span></button>';
	const fileActions = [
		action('openFile', ICONS.file, uncommitted ? t('Open File') : t('Open File at this Commit'), uncommitted ? t('Open the file, selecting the lines') : t('Open the file as it was at this commit, selecting the lines')),
		...(canSeeBefore ? [action('openBefore', ICONS.history, t('Show the Lines Before this Change'), uncommitted ? t('Open the file at HEAD, selecting the lines') : t('Open the file as it was before this commit, selecting the lines'))] : [])
	];
	const commitActions = uncommitted ? [] : [
		action('viewCommit', ICONS.graph, t('View Commit in Git Map'), t('Show the commit in the Git Map View')),
		action('copyRemoteLink', ICONS.link, t('Copy Remote Link'), t('Copy a permanent link to these lines at this commit, on the web page of the remote')),
		action('openCommitOnRemote', ICONS.external, t('Open Commit on Remote'), t('Open the commit on the web page of the remote'))
	];
	const inner = '<h3 class="lhDetailSubject">' + escapeHtml(uncommitted ? t('Uncommitted Changes') : entry.subject) + '</h3>' +
		'<div class="lhDetailAuthor">' + renderAvatar(entry, avatars) + '<span><b>' + escapeHtml(uncommitted ? t('You') : entry.author) + '</b>' +
		(entry.authorEmail !== '' ? ' <span class="lhMuted">&lt;' + escapeHtml(entry.authorEmail) + '&gt;</span>' : '') + '<br>' +
		'<span class="lhMuted">' + escapeHtml(uncommitted ? t('Not committed yet') : formatDate(entry.authorDate) + ' (' + getRelativeTimeDiff(entry.authorDate) + ')') + '</span></span></div>' +
		'<div class="lhChips">' + (uncommitted ? '' : '<button type="button" class="lhChip mono" data-action="copyHash" title="' + escapeHtml(t('Copy Commit Hash to Clipboard')) + '">' + ICONS.commit + escapeHtml(abbrevCommit(entry.hash)) + '</button>') +
		'<span class="lhChip" title="' + escapeHtml(entry.filePath) + '">' + ICONS.file + '<span>' + escapeHtml(entry.oldFilePath !== null ? t('{0} (renamed from {1})', getFileName(entry.filePath), entry.oldFilePath) : getFileName(entry.filePath)) + '</span></span>' +
		'<span class="lhChip">' + ICONS.lines + escapeHtml(entry.newRange !== null ? formatRange(entry.newRange) : t('Lines deleted')) + '</span>' +
		'<span class="lhChip stat"><span class="lhAdd">+' + entry.additions + '</span> <span class="lhDel">−' + entry.deletions + '</span></span></div>' +
		(entry.body !== '' ? '<div class="lhBody">' + escapeHtml(entry.body) + '</div>' : '') +
		renderDiff(entry) +
		'<div class="lhActions"><button type="button" class="lhPrimary" data-action="openChanges" title="' + escapeHtml(t('Open the changes of this commit to the file, selecting the lines')) + '">' + ICONS.diff + '<span>' + escapeHtml(t('Open Changes')) + '</span></button>' +
		'<div class="lhActionGroup">' + fileActions.join('') + '</div>' +
		(commitActions.length > 0 ? '<div class="lhActionGroup">' + commitActions.join('') + '</div>' : '') + '</div>' +
		(index === history.entries.length - 1 && !history.moreAvailable && !uncommitted ? '<p class="lhOrigin">' + ICONS.info + '<span>' + escapeHtml(entry.oldRange === null ? t('These lines were added by this commit.') : t('This is the oldest change found.')) + '</span></p>' : '');
	return '<section class="lhDetail" data-index="' + index + '" hidden>' + (index === 0 ? inner : '<template>' + inner + '</template>') + '</section>';
}

/**
 * Render the diff of the lines changed by a change, with the line numbers before & after it.
 */
function renderDiff(entry: GitLineHistoryEntry) {
	let oldLine = entry.oldRange !== null ? entry.oldRange.start : 0, newLine = entry.newRange !== null ? entry.newRange.start : 0;
	const rows = entry.diff.slice(0, MAX_DIFF_LINES).map((line) => {
		const sign = line.charAt(0), kind = sign === '+' ? 'add' : sign === '-' ? 'del' : 'ctx';
		const oldNum = kind !== 'add' ? oldLine++ : '', newNum = kind !== 'del' ? newLine++ : '';
		return '<tr class="' + kind + '"><td class="lhLn">' + oldNum + '</td><td class="lhLn">' + newNum + '</td><td class="lhSign">' + (kind === 'ctx' ? '' : escapeHtml(sign === '-' ? '−' : '+')) + '</td><td class="lhCode">' + escapeHtml(line.substring(1)) + '</td></tr>';
	});
	return '<div class="lhDiff"><table>' + rows.join('') + '</table>' +
		(entry.diff.length > MAX_DIFF_LINES ? '<p class="lhMuted">' + escapeHtml(t('{0} more lines (open the changes to see them)', entry.diff.length - MAX_DIFF_LINES)) + '</p>' : '') + '</div>';
}

/**
 * Render the avatar of the author of a change: their avatar if it has been loaded, otherwise their initial.
 */
function renderAvatar(entry: GitLineHistoryEntry, avatars: { readonly [email: string]: string }) {
	if (entry.hash === UNCOMMITTED) return '<span class="lhAvatar uncommitted" aria-hidden="true">*</span>';
	const image = avatars[entry.authorEmail];
	return '<span class="lhAvatar" data-email="' + escapeHtml(entry.authorEmail) + '" style="--lh-avatar-hue:' + getHue(entry.author) + '" aria-hidden="true">' +
		(typeof image === 'string' ? '<img src="' + escapeHtml(image) + '" alt="">' : escapeHtml(getInitial(entry.author))) + '</span>';
}

/**
 * Get the initial of an author.
 * @param author The name of the author.
 * @returns The initial.
 */
export function getInitial(author: string) {
	const name = author.trim();
	return name !== '' ? String.fromCodePoint(name.codePointAt(0)!).toUpperCase() : '?';
}

/**
 * Get the hue of the colour of an author's initial (the same author always has the same colour).
 * @param author The name of the author.
 * @returns The hue (0-359).
 */
export function getHue(author: string) {
	let hash = 0;
	for (let i = 0; i < author.length; i++) hash = (hash * 31 + author.charCodeAt(i)) | 0;
	return Math.abs(hash) % 360;
}

/**
 * Format a range of lines, e.g. "Lines 10–12" or "Line 10".
 */
export function formatRange(range: GitLineRange) {
	return range.start === range.end ? t('Line {0}', range.start) : t('Lines {0}–{1}', range.start, range.end);
}

let cachedDateFormatter: { locale: string, formatter: Intl.DateTimeFormat } | null = null;

/**
 * Format a date (a Unix timestamp) in the language Git Map is displayed in.
 */
export function formatDate(date: number) {
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	if (cachedDateFormatter === null || cachedDateFormatter.locale !== locale) {
		cachedDateFormatter = { locale: locale, formatter: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) };
	}
	return cachedDateFormatter.formatter.format(new Date(date * 1000));
}

/**
 * Get the name of a file from its path.
 */
export function getFileName(filePath: string) {
	return filePath.substring(filePath.lastIndexOf('/') + 1);
}

/**
 * Get the directory of a file from its path.
 */
function getDirectory(filePath: string) {
	const index = filePath.lastIndexOf('/');
	return index > -1 ? filePath.substring(0, index) : '';
}

/**
 * Escape the characters of a string that have a special meaning in HTML.
 */
export function escapeHtml(str: string) {
	return str.replace(/[&<>"']/g, (char) => char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;');
}

/**
 * The icons of the drawer (in the style of Visual Studio Code's icons, drawn with the colour of the text).
 */
const ICONS = {
	diff: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M6.5 6.3h3.5M8.25 4.5v3.6M6.5 11h3.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
	file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M9.5 1.5V5H13M6 8.2h4.5M6 10.7h4.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	history: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 8.8A5.3 5.3 0 1 0 4.2 4.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M2.4 2.4v3h3M8 5.2V8l2 1.3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	graph: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="4" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="12" cy="6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M4 5.1v5.8M12 7.6c0 2.6-2.2 3.3-6.4 4.3" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>',
	link: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4l-.9.9M9.2 6.8a2.8 2.8 0 0 0-4 0L3 9a2.8 2.8 0 0 0 4 4l.9-.9" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
	external: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 9v4.5h-10v-10H7M9.5 2.5h4v4M13.5 2.5l-6 6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	commit: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.5 8h3.9M10.6 8h3.9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
	lines: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h1M2.5 8h1M2.5 12h1M6 4h7.5M6 8h7.5M6 12h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
	info: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.1"/><path d="M8 7.2v4M8 4.9v.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
	more: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/**
 * The styles of the drawer, using the colours of the Visual Studio Code theme.
 */
const STYLES = `
body{margin:0;padding:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);background:transparent;}
button{font-family:inherit;font-size:inherit;}
.lhMuted{color:var(--vscode-descriptionForeground);}
.lhMessage{padding:12px 16px;color:var(--vscode-descriptionForeground);line-height:1.5;}
.lhError{margin:8px 12px;padding:6px 8px;border-radius:4px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);}
.lhHeader{position:sticky;top:0;z-index:2;padding:8px 12px 7px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));}
.lhHeaderFile{display:flex;gap:6px;align-items:baseline;min-width:0;white-space:nowrap;overflow:hidden;}
.lhHeaderFile b,.lhHeaderFile span{overflow:hidden;text-overflow:ellipsis;}
.lhHeaderFile span{direction:rtl;text-align:left;}
.lhHeaderMeta{display:flex;flex-wrap:wrap;gap:4px 8px;margin-top:2px;font-size:12px;}
.lhRange{font-weight:600;}
.lhLayout{display:grid;grid-template-columns:minmax(190px,38%) minmax(0,1fr);align-items:start;}
body.narrow .lhLayout{display:block;}
.lhTimeline{list-style:none;margin:0;padding:6px 0;border-right:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));min-width:0;}
body.narrow .lhTimeline{border-right:none;}
.lhItem{position:relative;display:flex;gap:8px;padding:6px 10px 6px 12px;cursor:pointer;outline:none;}
.lhItem::before{content:"";position:absolute;left:23px;top:0;bottom:0;width:2px;background:var(--vscode-editorWidget-border,var(--vscode-panel-border));}
.lhItem:first-child::before{top:18px;}
.lhItem:last-of-type::before{bottom:calc(100% - 18px);}
.lhItem:only-of-type::before{display:none;}
.lhItem:hover{background:var(--vscode-list-hoverBackground);}
.lhItem.selected{background:var(--vscode-list-inactiveSelectionBackground);color:var(--vscode-list-inactiveSelectionForeground,inherit);}
body.focused .lhItem.selected{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground,inherit);}
body.focused .lhItem.selected .lhMuted,body.focused .lhItem.selected .lhDate,body.focused .lhItem.selected .lhItemMeta{color:inherit;opacity:.85;}
.lhAvatar{position:relative;z-index:1;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;overflow:hidden;font-size:11px;font-weight:600;color:#fff;background:hsl(var(--lh-avatar-hue,210),45%,42%);box-shadow:0 0 0 2px var(--vscode-sideBar-background,var(--vscode-editor-background));}
.lhAvatar img{width:100%;height:100%;object-fit:cover;}
.lhAvatar.uncommitted{background:var(--vscode-sideBar-background,var(--vscode-editor-background));color:var(--vscode-descriptionForeground);border:1px dashed var(--vscode-descriptionForeground);box-sizing:border-box;font-size:14px;}
.lhItemText{display:flex;flex-direction:column;min-width:0;flex:1;}
.lhItemTop{display:flex;gap:6px;align-items:baseline;min-width:0;}
.lhAuthor{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lhDate{flex:none;margin-left:auto;font-size:11px;color:var(--vscode-descriptionForeground);}
.lhSubject{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lhItem.uncommitted .lhSubject{font-style:italic;}
.lhItemMeta{display:flex;gap:6px;font-size:11px;color:var(--vscode-descriptionForeground);}
.lhHash{font-family:var(--vscode-editor-font-family);}
.lhAdd{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950);}
.lhDel{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149);}
.lhMore{padding:6px 12px;}
.lhSide{position:sticky;top:var(--lh-header-height,52px);min-width:0;}
.lhDetail{padding:10px 12px 14px;}
body.narrow .lhDetail{padding:8px 12px 12px 44px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border,var(--vscode-panel-border));}
.lhDetailSubject{margin:0 0 8px;font-size:13px;line-height:1.4;word-break:break-word;}
.lhDetailAuthor{display:flex;gap:8px;align-items:center;margin-bottom:8px;line-height:1.35;font-size:12px;}
.lhDetailAuthor .lhAvatar{width:28px;height:28px;box-shadow:none;}
.lhChips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;}
.lhChip{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:1px 7px;border-radius:10px;font-size:11px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border:none;}
button.lhChip{cursor:pointer;}
.lhChip.mono{font-family:var(--vscode-editor-font-family);}
.lhChip svg{flex:none;width:12px;height:12px;}
.lhChip span{overflow:hidden;text-overflow:ellipsis;}
.lhChip.stat{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px var(--vscode-editorWidget-border,var(--vscode-panel-border));}
.lhBody{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;max-height:9.5em;overflow:auto;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.45;}
.lhDiff{margin:0 0 10px;border:1px solid var(--vscode-editorWidget-border,var(--vscode-panel-border));border-radius:4px;overflow:auto;background:var(--vscode-editor-background);}
.lhDiff table{border-collapse:collapse;width:100%;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size,12px);line-height:1.5;}
.lhDiff td{padding:0 6px;white-space:pre;vertical-align:top;}
.lhDiff .lhLn{width:1%;text-align:right;color:var(--vscode-editorLineNumber-foreground);user-select:none;padding:0 4px;}
.lhDiff .lhSign{width:1%;padding:0 2px 0 4px;user-select:none;}
.lhDiff tr.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(155,185,85,.2));}
.lhDiff tr.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(255,0,0,.2));}
.lhDiff p{margin:4px 8px;font-family:var(--vscode-font-family);}
.lhActions{display:flex;flex-direction:column;gap:6px;}
.lhPrimary{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:5px 10px;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-weight:500;line-height:18px;}
.lhPrimary:hover{background:var(--vscode-button-hoverBackground);}
.lhPrimary svg{width:16px;height:16px;flex:none;}
.lhActionGroup{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:1px;padding:3px;border-radius:6px;border:1px solid var(--vscode-editorWidget-border,var(--vscode-panel-border));background:var(--vscode-editorWidget-background,transparent);}
.lhAction{display:flex;align-items:center;gap:8px;min-width:0;padding:4px 8px;border:none;border-radius:4px;cursor:pointer;text-align:left;color:var(--vscode-foreground);background:transparent;line-height:18px;}
.lhAction svg{flex:none;width:16px;height:16px;color:var(--vscode-icon-foreground,currentColor);}
.lhAction span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lhAction:hover{background:var(--vscode-list-hoverBackground);}
.lhPrimary:focus-visible,.lhAction:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;}
.lhButton{padding:3px 10px;border-radius:2px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);line-height:18px;}
.lhButton:hover{background:var(--vscode-button-secondaryHoverBackground);}
.lhButton.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background);}
.lhButton.primary:hover{background:var(--vscode-button-hoverBackground);}
.lhButton:focus-visible,.lhChip:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px;}
.lhOrigin{display:flex;align-items:center;gap:6px;margin:10px 0 0;font-size:12px;color:var(--vscode-descriptionForeground);}
.lhOrigin svg{flex:none;width:14px;height:14px;}
`;

/**
 * The script of the drawer: selecting changes (with the mouse or keyboard), running their actions, and laying out the timeline & the
 * selected change side by side (or the change below its item in the timeline, if the drawer is narrow).
 */
const SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi(), root = document.getElementById('root'), state = vscode.getState() || {}, selected = 0;
	function items() { return Array.prototype.slice.call(root.querySelectorAll('.lhItem')); }
	function select(index, scroll) {
		var all = items();
		if (all.length === 0) return;
		selected = Math.max(0, Math.min(index, all.length - 1));
		all.forEach(function (item, i) { item.classList.toggle('selected', i === selected); item.setAttribute('aria-selected', i === selected ? 'true' : 'false'); });
		root.querySelectorAll('.lhDetail').forEach(function (detail) {
			var active = parseInt(detail.dataset.index) === selected;
			if (active) {
				var tpl = detail.querySelector('template');
				if (tpl) detail.replaceChildren(tpl.content.cloneNode(true));
			}
			detail.hidden = !active;
		});
		vscode.setState({ key: root.dataset.key, selected: selected });
		layout();
		if (scroll) all[selected].scrollIntoView({ block: 'nearest' });
	}
	function layout() {
		var narrow = document.body.clientWidth < 520, details = root.querySelector('.lhDetails'), side = root.querySelector('.lhSide'), all = items();
		document.body.classList.toggle('narrow', narrow);
		var header = root.querySelector('.lhHeader');
		if (header) document.body.style.setProperty('--lh-header-height', header.offsetHeight + 'px');
		if (!details || !side) return;
		if (narrow && all[selected]) {
			all[selected].insertAdjacentElement('afterend', details);
		} else if (details.parentElement !== side) {
			side.appendChild(details);
		}
	}
	function render(html, key) {
		var same = root.dataset.key === key && key !== '';
		root.dataset.key = key;
		root.innerHTML = html;
		select(same ? selected : 0, false);
	}
	window.addEventListener('message', function (event) {
		var msg = event.data;
		if (msg.command === 'render') {
			render(msg.html, msg.key);
		} else if (msg.command === 'avatar') {
			function updateAvatarScope(scope) {
				scope.querySelectorAll('.lhAvatar').forEach(function (elem) {
					if (elem.dataset.email === msg.email) { elem.textContent = ''; var img = document.createElement('img'); img.src = msg.image; img.alt = ''; elem.appendChild(img); }
				});
				scope.querySelectorAll('template').forEach(function (tpl) { updateAvatarScope(tpl.content); });
			}
			updateAvatarScope(root);
		}
	});
	document.addEventListener('click', function (event) {
		var target = event.target, actionElem = target.closest('[data-action]'), commandElem = target.closest('[data-command]'), item = target.closest('.lhItem');
		if (actionElem) {
			vscode.postMessage({ command: 'action', action: actionElem.dataset.action, index: selected });
		} else if (commandElem) {
			vscode.postMessage({ command: commandElem.dataset.command });
		} else if (item) {
			select(parseInt(item.dataset.index), false);
			item.focus();
		}
	});
	document.addEventListener('dblclick', function (event) {
		if (event.target.closest('.lhItem')) vscode.postMessage({ command: 'action', action: 'openChanges', index: selected });
	});
	document.addEventListener('keydown', function (event) {
		if (event.target.closest('button')) return;
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			select(selected + (event.key === 'ArrowDown' ? 1 : -1), true);
			var item = items()[selected];
			if (item) item.focus();
		} else if (event.key === 'Enter') {
			vscode.postMessage({ command: 'action', action: 'openChanges', index: selected });
		} else if (event.key === 'Escape') {
			vscode.postMessage({ command: 'escape' });
		}
	});
	window.addEventListener('focus', function () { document.body.classList.add('focused'); });
	window.addEventListener('blur', function () { document.body.classList.remove('focused'); });
	window.addEventListener('resize', layout);
	select(state.key === root.dataset.key ? state.selected || 0 : 0, false);
})();
`;
