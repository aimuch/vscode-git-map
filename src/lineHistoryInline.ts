import * as vscode from 'vscode';
import { EscapeStack } from './escapeStack';
import { t } from './l10n';
import { formatRange, getFileName, getHue, getInitial } from './lineHistoryDrawer';
import { GitLineHistory, GitLineHistoryEntry } from './types';
import { UNCOMMITTED, abbrevCommit } from './utils';
import { Disposable } from './utils/disposable';

/**
 * The maximum number of changes shown in the inline window (the drawer shows all of them).
 */
const MAX_COMMENTS = 50;

/**
 * The maximum number of lines of the diff of each change shown in the inline window.
 */
const MAX_DIFF_LINES = 40;

/**
 * The commands that the links in the inline window can run.
 */
const LINK_COMMANDS = ['git-map.lineHistory.openChanges', 'git-map.lineHistory.openBefore', 'git-map.lineHistory.viewCommit', 'git-map.lineHistory.copyRemoteLink'];

/**
 * A change in the inline window (a comment of its thread).
 */
export class LineHistoryComment implements vscode.Comment {
	public readonly mode = vscode.CommentMode.Preview;
	public readonly contextValue: string;
	public readonly label: string | undefined;

	/**
	 * Creates a comment for a change.
	 * @param entry The change (NULL for a note, e.g. that older changes are shown in the drawer).
	 * @param body The body of the comment.
	 * @param author The author of the change.
	 * @param timestamp When the change was made (undefined for the uncommitted changes).
	 */
	constructor(public readonly entry: GitLineHistoryEntry | null, public readonly body: vscode.MarkdownString, public readonly author: vscode.CommentAuthorInformation, public readonly timestamp: Date | undefined) {
		this.contextValue = entry === null ? 'gitMapLineHistoryNote' : entry.hash === UNCOMMITTED ? 'gitMapLineHistoryUncommitted' : 'gitMapLineHistoryCommit';
		this.label = entry === null ? undefined : entry.hash === UNCOMMITTED ? t('Uncommitted') : abbrevCommit(entry.hash);
	}
}

/**
 * The inline window showing the history of lines below them in the editor: a thread of comments (using the Comments API), one for each
 * change (with its author, avatar, date, and how it changed the lines).
 */
export class LineHistoryInline extends Disposable {
	private readonly controller: vscode.CommentController;
	private thread: vscode.CommentThread | null = null;

	/**
	 * Creates the inline window.
	 */
	constructor() {
		super();
		this.controller = vscode.comments.createCommentController('git-map.lineHistory', t('Git Map Line History'));
		this.registerDisposables(
			this.controller,
			// The inline window is closed when its document is closed
			vscode.workspace.onDidCloseTextDocument((document) => {
				if (this.thread !== null && this.thread.uri.toString() === document.uri.toString()) this.close();
			}),
			{ dispose: () => this.close() }
		);
	}

	/**
	 * Show the history of lines in the inline window (replacing the history it shows).
	 * @param uri The file.
	 * @param history The history of the lines.
	 * @param getAvatar Get the avatar of an author (a data URI).
	 */
	public show(uri: vscode.Uri, history: GitLineHistory, getAvatar: (entry: GitLineHistoryEntry) => vscode.Uri) {
		this.close();
		const range = new vscode.Range(history.range.start - 1, 0, history.range.end - 1, 0);
		this.thread = this.controller.createCommentThread(uri, range, this.getComments(history, getAvatar));
		this.thread.canReply = false;
		this.thread.contextValue = 'gitMapLineHistory';
		this.thread.label = getLabel(history);
		this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
	}

	/**
	 * Update the comments of the inline window (e.g. when an avatar has been loaded).
	 * @param history The history of the lines.
	 * @param getAvatar Get the avatar of an author (a data URI).
	 */
	public update(history: GitLineHistory, getAvatar: (entry: GitLineHistoryEntry) => vscode.Uri) {
		if (this.thread !== null) this.thread.comments = this.getComments(history, getAvatar);
	}

	/**
	 * Close the inline window.
	 */
	public close() {
		if (this.thread !== null) {
			this.thread.dispose();
			this.thread = null;
			EscapeStack.update();
		}
	}

	/**
	 * Get the thread of the inline window (if it's shown).
	 */
	public getThread() {
		return this.thread;
	}

	/**
	 * Get the comments of the changes to lines.
	 */
	private getComments(history: GitLineHistory, getAvatar: (entry: GitLineHistoryEntry) => vscode.Uri) {
		const comments = history.entries.slice(0, MAX_COMMENTS).map((entry) => {
			const uncommitted = entry.hash === UNCOMMITTED;
			return new LineHistoryComment(entry, getBody(entry), { name: uncommitted ? t('You') : entry.author, iconPath: getAvatar(entry) }, uncommitted ? undefined : new Date(entry.authorDate * 1000));
		});
		if (history.entries.length > MAX_COMMENTS || history.moreAvailable) {
			const more = new vscode.MarkdownString(t('Older changes are shown in the drawer: [Show in the Drawer]({0})', 'command:git-map.lineHistory.switchToDrawer'));
			more.isTrusted = { enabledCommands: ['git-map.lineHistory.switchToDrawer'] };
			comments.push(new LineHistoryComment(null, more, { name: t('Git Map') }, undefined));
		}
		return comments;
	}
}

/**
 * Get the label of the inline window, e.g. "Line History · file.ts · Lines 10–12 · 3 changes".
 */
function getLabel(history: GitLineHistory) {
	return t('Line History') + ' · ' + getFileName(history.filePath) + ' · ' + formatRange(history.range) + ' · ' + t('{0} changes', history.entries.length + (history.moreAvailable ? '+' : ''));
}

/**
 * Get the body of the comment of a change: its subject, how it changed the lines, and links to its actions.
 */
function getBody(entry: GitLineHistoryEntry) {
	const uncommitted = entry.hash === UNCOMMITTED, args = encodeURIComponent(JSON.stringify([entry.hash])).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
	const body = new vscode.MarkdownString();
	body.isTrusted = { enabledCommands: LINK_COMMANDS };
	body.appendMarkdown('**');
	body.appendText(uncommitted ? t('Uncommitted Changes') : entry.subject);
	body.appendMarkdown('**  \n');
	body.appendText((entry.oldFilePath !== null ? t('{0} (renamed from {1})', entry.filePath, entry.oldFilePath) : entry.filePath) + ' · ' + (entry.newRange !== null ? formatRange(entry.newRange) : t('Lines deleted')) + ' · +' + entry.additions + ' −' + entry.deletions);
	body.appendMarkdown('\n\n');
	const lines = entry.diff.slice(0, MAX_DIFF_LINES), fence = '`'.repeat(Math.max(3, ...lines.map((line) => (line.match(/`+/g) || ['']).reduce((max, run) => Math.max(max, run.length + 1), 0))));
	body.appendMarkdown(fence + 'diff\n' + lines.join('\n') + (entry.diff.length > MAX_DIFF_LINES ? '\n…' : '') + '\n' + fence + '\n\n');
	const links = [
		'[' + t('Open Changes') + '](command:git-map.lineHistory.openChanges?' + args + ')',
		...(!entry.fileAdded && (uncommitted || entry.parents.length > 0) ? ['[' + t('Show the Lines Before this Change') + '](command:git-map.lineHistory.openBefore?' + args + ')'] : []),
		...(uncommitted ? [] : ['[' + t('View Commit in Git Map') + '](command:git-map.lineHistory.viewCommit?' + args + ')', '[' + t('Copy Remote Link') + '](command:git-map.lineHistory.copyRemoteLink?' + args + ')'])
	];
	body.appendMarkdown(links.join(' · '));
	return body;
}

/**
 * Get an avatar showing an author's initial (in a circle of the author's colour), as a data URI.
 * @param author The name of the author (or "*" for the uncommitted changes).
 * @returns The avatar.
 */
export function getInitialAvatar(author: string) {
	const initial = author === '*' ? '*' : getInitial(author), fill = author === '*' ? '#808080' : 'hsl(' + getHue(author) + ',45%,42%)';
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="' + fill + '"/>' +
		'<text x="16" y="21" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" font-size="15" font-weight="600" fill="#fff">' + initial.replace(/[&<>]/g, (char) => char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;') + '</text></svg>';
	return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}
