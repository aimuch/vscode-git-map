import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { EscapeStack } from './escapeStack';
import { t } from './l10n';
import { LineHistoryDrawer, LineHistoryDrawerMessage } from './lineHistoryDrawer';
import { LineHistoryComment, LineHistoryInline, getInitialAvatar } from './lineHistoryInline';
import { Logger } from './logger';
import { getRemoteCommitUrl, getRemoteFileUrl, getRemoteWebRepo } from './remoteLinks';
import { RepoManager } from './repoManager';
import { ErrorInfo, GitFileStatus, GitLineHistory, GitLineHistoryEntry, GitLineRange, LineHistoryLocation } from './types';
import { UNCOMMITTED, abbrevCommit, copyToClipboard, getPathFromUri, getSelectedLines, openExternalUrl, showErrorMessage, viewDiff, viewFileAtRevision } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * The number of commits loaded (and the number of additional commits loaded by "Load More Commits").
 */
const COMMITS_PER_LOAD = 100;

/**
 * The time (in milliseconds) the cursor must stay on a line before its history is loaded (while the drawer follows the cursor).
 */
const FOLLOW_DELAY = 400;

/**
 * The lines whose history is shown.
 */
export interface LineHistoryTarget {
	readonly uri: vscode.Uri; // The file
	readonly repo: string; // The repository containing the file
	readonly filePath: string; // The path of the file (relative to the repository)
	readonly range: GitLineRange; // The lines (1-based)
}

/**
 * The history of lines that's shown.
 */
interface ShownLineHistory {
	readonly target: LineHistoryTarget;
	readonly history: GitLineHistory;
	readonly maxCommits: number;
}

/**
 * Shows the history of lines: how they were changed by each commit (and the uncommitted changes), in the drawer (a view in the Secondary
 * Side Bar) or an inline window below the lines in the editor (the `git-map.lineHistory.location` Extension Setting). The drawer can follow
 * the cursor (the `git-map.lineHistory.followCursor` Extension Setting).
 */
export class LineHistory extends Disposable {
	private static instance: LineHistory | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly avatarManager: AvatarManager;
	private readonly logger: Logger;
	private readonly drawer: LineHistoryDrawer;
	private readonly inline: LineHistoryInline;
	private readonly avatars: { [email: string]: string } = {};
	private shown: ShownLineHistory | null = null;
	private loadId: number = 0;
	private followTimeout: NodeJS.Timeout | null = null;

	/**
	 * Creates the Line History.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param avatarManager The Git Map AvatarManager instance.
	 * @param onDidChangeConfiguration The Event emitting when the configuration changes.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, avatarManager: AvatarManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.avatarManager = avatarManager;
		this.logger = logger;
		this.drawer = new LineHistoryDrawer((message) => this.onDrawerMessage(message));
		this.inline = new LineHistoryInline();
		LineHistory.instance = this;

		const entryCommand = (command: string, action: string) => vscode.commands.registerCommand(command, (arg: any) => {
			const entry = this.getEntry(arg);
			if (entry !== null) this.runAction(action, entry);
		});
		this.registerDisposables(
			this.drawer,
			this.inline,
			vscode.window.registerWebviewViewProvider(LineHistoryDrawer.viewId, this.drawer),
			vscode.commands.registerCommand('git-map.viewLineHistory', (arg: any) => this.viewLineHistory(arg)),
			vscode.commands.registerCommand('git-map.lineHistory.switchToDrawer', () => this.switchLocation(LineHistoryLocation.Drawer)),
			vscode.commands.registerCommand('git-map.lineHistory.switchToInline', () => this.switchLocation(LineHistoryLocation.InlineWindow)),
			vscode.commands.registerCommand('git-map.lineHistory.followCursor', () => this.setFollowCursor(true)),
			vscode.commands.registerCommand('git-map.lineHistory.stopFollowingCursor', () => this.setFollowCursor(false)),
			vscode.commands.registerCommand('git-map.lineHistory.openInGitMap', () => this.openInGitMap()),
			vscode.commands.registerCommand('git-map.lineHistory.refresh', () => this.refresh()),
			vscode.commands.registerCommand('git-map.lineHistory.close', () => this.inline.close()),
			entryCommand('git-map.lineHistory.openChanges', 'openChanges'),
			entryCommand('git-map.lineHistory.openBefore', 'openBefore'),
			entryCommand('git-map.lineHistory.viewCommit', 'viewCommit'),
			entryCommand('git-map.lineHistory.copyRemoteLink', 'copyRemoteLink'),
			vscode.commands.registerCommand('git-map.openLineChanges', (repo: any, hash: any, filePath: any, line: any) => this.openLineChanges(repo, hash, filePath, line)),
			vscode.commands.registerCommand('git-map.copyRemoteLink', (repo: any, hash: any, filePath: any, start: any, end: any) => {
				if (typeof repo === 'string' && typeof hash === 'string' && typeof filePath === 'string' && typeof start === 'number' && typeof end === 'number') {
					this.remoteLinkToLines(repo, hash, filePath, { start: start, end: end }, false).then((error) => {
						if (error !== null) showErrorMessage(error);
					});
				}
			}),
			vscode.commands.registerCommand('git-map.copyRemoteLinkToLines', () => this.remoteLinkToSelectedLines(false)),
			vscode.commands.registerCommand('git-map.openLinesOnRemote', () => this.remoteLinkToSelectedLines(true)),
			vscode.window.onDidChangeTextEditorSelection((event) => this.onSelectionChange(event.textEditor)),
			avatarManager.onAvatar((event) => this.onAvatar(event.email, event.image)),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.lineHistory.followCursor')) this.updateContext();
			}),
			{
				dispose: () => {
					if (this.followTimeout !== null) clearTimeout(this.followTimeout);
					if (LineHistory.instance === this) LineHistory.instance = null;
				}
			}
		);
		this.updateContext();
	}

	/**
	 * Get the Line History (used by the end-to-end tests to inspect what's shown).
	 */
	public static getInstance() {
		return LineHistory.instance;
	}

	/**
	 * Get the history of lines that's shown (if any).
	 */
	public getShown() {
		return this.shown;
	}

	/**
	 * Get the drawer.
	 */
	public getDrawer() {
		return this.drawer;
	}

	/**
	 * Get the inline window.
	 */
	public getInline() {
		return this.inline;
	}

	/**
	 * The method run when the `git-map.viewLineHistory` command is invoked: show the history of the selected lines (or the line the cursor is
	 * on) in the active text editor, or of the lines given (e.g. by a CodeLens).
	 * @param arg The file & lines (`{ uri, start, end }`, where `uri` is a URI or its string), or undefined to use the active text editor.
	 */
	private async viewLineHistory(arg: any) {
		let document: vscode.TextDocument, range: GitLineRange;
		if (typeof arg === 'object' && arg !== null && (arg.uri instanceof vscode.Uri || typeof arg.uri === 'string') && typeof arg.start === 'number' && typeof arg.end === 'number') {
			// The file is a URI, or a string (from the link in the hover of the blame of a line)
			document = await vscode.workspace.openTextDocument(typeof arg.uri === 'string' ? vscode.Uri.parse(arg.uri) : arg.uri);
			range = { start: arg.start, end: arg.end };
		} else {
			const editor = vscode.window.activeTextEditor;
			if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') {
				showErrorMessage(t('Unable to View Line History: {0}', t('Open a file in an editor, and select the lines.')));
				return;
			}
			document = editor.document;
			range = getSelectedLines(editor.selection);
		}
		const target = await this.getTarget(document.uri, range);
		if (target === null) {
			showErrorMessage(t('Unable to View Line History: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(document.uri))));
			return;
		}
		await this.load(target, document.getText(), COMMITS_PER_LOAD, getConfig().lineHistoryLocation, true);
	}

	/**
	 * Load the history of lines, and show it.
	 * @param target The lines.
	 * @param contents The current contents of the file.
	 * @param maxCommits The maximum number of commits to load.
	 * @param location Where to show the history.
	 * @param reveal Show the drawer (if the history is shown in it).
	 */
	private async load(target: LineHistoryTarget, contents: string, maxCommits: number, location: LineHistoryLocation, reveal: boolean) {
		const loadId = ++this.loadId;
		if (location === LineHistoryLocation.Drawer) {
			if (this.shown === null || !isSameTarget(this.shown.target, target)) this.drawer.show({ kind: 'loading', filePath: target.filePath, range: target.range });
			if (reveal) await this.revealDrawer();
		}
		const history = await this.dataSource.getLineHistory(target.repo, target.filePath, target.range, contents, maxCommits);
		if (loadId !== this.loadId) return;
		this.shown = { target: target, history: history, maxCommits: maxCommits };
		this.requestAvatars(target.repo, history);
		this.present(location);
	}

	/**
	 * Show the history of lines that has been loaded.
	 * @param location Where to show the history.
	 */
	private present(location: LineHistoryLocation) {
		const shown = this.shown;
		if (shown === null) return;
		// The drawer always shows the latest history of lines (also when it's shown in an inline window)
		this.drawer.show({ kind: 'history', history: shown.history, avatars: this.avatars });
		if (location === LineHistoryLocation.InlineWindow) {
			this.inline.show(shown.target.uri, shown.history, (entry) => this.getAvatarUri(entry));
			EscapeStack.push('lineHistory.inline', () => this.inline.getThread() !== null, () => this.inline.close());
		} else {
			this.inline.close();
		}
	}

	/**
	 * Show the drawer, which Escape closes.
	 */
	private async revealDrawer() {
		await this.drawer.reveal();
		EscapeStack.push('lineHistory.drawer', () => this.drawer.isVisible(), () => this.closeDrawer());
	}

	/**
	 * Close the drawer (the Secondary Side Bar it's in), returning to the editor.
	 */
	private async closeDrawer() {
		await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	}

	/**
	 * Show the history of lines in a different location, which is remembered for all workspaces.
	 * @param location The location.
	 */
	private async switchLocation(location: LineHistoryLocation) {
		await vscode.workspace.getConfiguration('git-map').update('lineHistory.location', location === LineHistoryLocation.InlineWindow ? 'Inline Window' : 'Drawer', vscode.ConfigurationTarget.Global);
		if (this.shown === null) {
			if (location === LineHistoryLocation.Drawer) await this.revealDrawer();
			return;
		}
		if (location === LineHistoryLocation.Drawer) {
			await this.revealDrawer();
		} else {
			// The inline window is shown in the editor of the file
			await vscode.window.showTextDocument(this.shown.target.uri, { selection: new vscode.Range(this.shown.target.range.start - 1, 0, this.shown.target.range.start - 1, 0), preview: false });
		}
		this.present(location);
	}

	/**
	 * Start or stop following the cursor (in the drawer), which is remembered for all workspaces.
	 * @param follow TRUE => Follow the cursor, FALSE => Stop following the cursor.
	 */
	private async setFollowCursor(follow: boolean) {
		await vscode.workspace.getConfiguration('git-map').update('lineHistory.followCursor', follow, vscode.ConfigurationTarget.Global);
		this.updateContext();
		const editor = vscode.window.activeTextEditor;
		if (follow && typeof editor !== 'undefined') this.onSelectionChange(editor);
	}

	/**
	 * Update the context keys used by the menus of the drawer.
	 */
	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:lineHistoryFollowCursor', getConfig().lineHistoryFollowCursor);
	}

	/**
	 * Load the history of the line the cursor is on (or the selected lines) once the cursor stops moving, if the drawer follows the cursor.
	 * @param editor The editor whose selection changed.
	 */
	private onSelectionChange(editor: vscode.TextEditor) {
		// The visibility of the drawer is checked first, as this is called whenever the cursor moves in an editor
		if (!this.drawer.isVisible() || editor.document.uri.scheme !== 'file') return;
		const config = getConfig();
		if (!config.lineHistoryFollowCursor || config.lineHistoryLocation !== LineHistoryLocation.Drawer) return;
		if (this.followTimeout !== null) clearTimeout(this.followTimeout);
		this.followTimeout = setTimeout(async () => {
			this.followTimeout = null;
			if (editor !== vscode.window.activeTextEditor) return;
			const range = getSelectedLines(editor.selection);
			if (this.shown !== null && this.shown.target.uri.toString() === editor.document.uri.toString() && this.shown.target.range.start === range.start && this.shown.target.range.end === range.end) return;
			const target = await this.getTarget(editor.document.uri, range);
			if (target !== null) await this.load(target, editor.document.getText(), COMMITS_PER_LOAD, LineHistoryLocation.Drawer, false);
		}, FOLLOW_DELAY);
	}

	/**
	 * Load the history of the lines that's shown again (e.g. after the file has been changed or committed).
	 * @param maxCommits The maximum number of commits to load.
	 */
	private async refresh(maxCommits: number = COMMITS_PER_LOAD) {
		if (this.shown === null) return;
		const target = this.shown.target, document = await vscode.workspace.openTextDocument(target.uri);
		const location = this.inline.getThread() !== null ? LineHistoryLocation.InlineWindow : LineHistoryLocation.Drawer;
		await this.load(target, document.getText(), maxCommits, location, false);
	}

	/**
	 * Open the history of the lines that's shown in the Git Map View.
	 */
	private openInGitMap() {
		if (this.shown === null) return;
		if (this.shown.history.headRange === null) {
			showErrorMessage(t('Unable to View Line History: {0}', t('The selected lines haven\'t been committed yet.')));
			return;
		}
		vscode.commands.executeCommand('git-map.viewLineHistoryInGitMap', { repo: this.shown.target.repo, filePath: this.shown.target.filePath, lineRange: this.shown.history.headRange });
	}

	/**
	 * Process a message sent by the drawer.
	 * @param message The message.
	 */
	private onDrawerMessage(message: LineHistoryDrawerMessage) {
		if (message.command === 'escape') {
			EscapeStack.remove('lineHistory.drawer');
			this.closeDrawer();
			return;
		}
		if (this.shown === null) return;
		if (message.command === 'loadMore') {
			this.refresh(this.shown.maxCommits + COMMITS_PER_LOAD);
		} else if (message.command === 'action') {
			const entry = this.shown.history.entries[message.index];
			if (typeof entry !== 'undefined') this.runAction(message.action, entry);
		}
	}

	/**
	 * Get the change an action is run on, from the argument of the command (a comment of the inline window, or the hash of a commit).
	 * @param arg The argument.
	 * @returns The change, or NULL if it isn't shown.
	 */
	private getEntry(arg: any): GitLineHistoryEntry | null {
		if (arg instanceof LineHistoryComment) return arg.entry;
		if (this.shown === null || typeof arg !== 'string') return null;
		const entry = this.shown.history.entries.find((entry) => entry.hash === arg);
		return typeof entry !== 'undefined' ? entry : null;
	}

	/**
	 * Run an action on a change.
	 * @param action The action.
	 * @param entry The change.
	 */
	private async runAction(action: string, entry: GitLineHistoryEntry) {
		const shown = this.shown;
		if (shown === null) return;
		const repo = shown.target.repo, uncommitted = entry.hash === UNCOMMITTED;
		let error: ErrorInfo = null;
		switch (action) {
			case 'openChanges':
				error = uncommitted
					? await viewDiff(repo, UNCOMMITTED, UNCOMMITTED, entry.filePath, entry.filePath, entry.fileAdded ? GitFileStatus.Untracked : GitFileStatus.Modified, entry.newRange)
					: await viewDiff(repo, entry.hash, entry.hash, entry.oldFilePath !== null ? entry.oldFilePath : entry.filePath, entry.filePath, entry.fileAdded ? GitFileStatus.Added : entry.oldFilePath !== null ? GitFileStatus.Renamed : GitFileStatus.Modified, entry.newRange);
				break;
			case 'openFile':
				if (uncommitted) {
					await vscode.window.showTextDocument(shown.target.uri, { selection: getRange(entry.newRange), preview: true });
				} else {
					error = await viewFileAtRevision(repo, entry.hash, entry.filePath, entry.newRange);
				}
				break;
			case 'openBefore':
				// The lines before the change: in HEAD (for the uncommitted changes), or in the commit's first parent
				if (uncommitted) {
					error = await viewFileAtRevision(repo, 'HEAD', entry.filePath, entry.oldRange);
				} else if (entry.parents.length > 0 && !entry.fileAdded) {
					error = await viewFileAtRevision(repo, entry.parents[0], entry.oldFilePath !== null ? entry.oldFilePath : entry.filePath, entry.oldRange);
				}
				break;
			case 'viewCommit':
				if (!uncommitted) await vscode.commands.executeCommand('git-map.viewCommitInGitMap', repo, entry.hash);
				break;
			case 'copyHash':
				if (!uncommitted) error = await copyToClipboard(entry.hash);
				break;
			case 'copyRemoteLink':
				if (!uncommitted) error = await this.copyRemoteLink(repo, entry);
				break;
			case 'openCommitOnRemote':
				if (!uncommitted) error = await this.openCommitOnRemote(repo, entry.hash);
				break;
		}
		if (error !== null) showErrorMessage(error);
	}

	/**
	 * Copy the link to the lines changed by a commit, on the web page of the repository's remote (a permanent link to the commit).
	 * @param repo The repository.
	 * @param entry The change made by the commit.
	 * @returns The error that occurred, or NULL.
	 */
	private copyRemoteLink(repo: string, entry: GitLineHistoryEntry): Promise<ErrorInfo> {
		// If the commit deleted the lines, the link is to the lines in its parent
		const deleted = entry.newRange === null && entry.parents.length > 0;
		return this.remoteLinkToLines(repo, deleted ? entry.parents[0] : entry.hash, deleted && entry.oldFilePath !== null ? entry.oldFilePath : entry.filePath, deleted ? entry.oldRange : entry.newRange, false);
	}

	/**
	 * Copy the link to (or open) the selected lines of the active text editor on the web page of the repository's remote, at HEAD (the
	 * lines are mapped to the same lines in HEAD, if the file has uncommitted changes).
	 * @param open TRUE => Open the link, FALSE => Copy the link to the clipboard.
	 */
	private async remoteLinkToSelectedLines(open: boolean) {
		const fail = (reason: string) => {
			// The message isn't awaited, as it's only resolved when it's closed
			showErrorMessage(open ? t('Unable to Open Lines on Remote: {0}', reason) : t('Unable to Copy Remote Link: {0}', reason));
		};
		const editor = vscode.window.activeTextEditor;
		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') return fail(t('Open a file in an editor, and select the lines.'));
		const target = await this.getTarget(editor.document.uri, getSelectedLines(editor.selection));
		if (target === null) return fail(t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(editor.document.uri)));
		const head = await this.dataSource.getHeadHash(target.repo), lines = await this.dataSource.getLinesInHead(target.repo, target.filePath, target.range, editor.document.getText());
		if (head === null || lines === null) return fail(t('The selected lines haven\'t been committed yet.'));
		const error = await this.remoteLinkToLines(target.repo, head, target.filePath, lines, open);
		if (error !== null) showErrorMessage(error);
	}

	/**
	 * Copy the link to (or open) lines of a file at a commit, on the web page of the repository's remote (a permanent link to the commit).
	 * @param repo The repository.
	 * @param hash The hash of the commit.
	 * @param filePath The path of the file in the commit.
	 * @param lines The lines (or NULL for the whole file).
	 * @param open TRUE => Open the link, FALSE => Copy the link to the clipboard.
	 * @returns The error that occurred, or NULL.
	 */
	private async remoteLinkToLines(repo: string, hash: string, filePath: string, lines: GitLineRange | null, open: boolean): Promise<ErrorInfo> {
		const remote = await this.dataSource.getDefaultRemote(repo), webRepo = remote !== null ? getRemoteWebRepo(remote.url) : null;
		if (remote === null || webRepo === null) {
			const reason = t('The repository doesn\'t have a remote with a web page (e.g. on GitHub or GitLab).');
			return open ? t('Unable to Open Lines on Remote: {0}', reason) : t('Unable to Copy Remote Link: {0}', reason);
		}
		const url = getRemoteFileUrl(webRepo, hash, filePath, lines), onRemote = await this.dataSource.isCommitOnRemote(repo, hash, remote.name);
		if (open) {
			if (!onRemote) vscode.window.showWarningMessage(t('The commit {0} isn\'t on the remote "{1}" yet, so the page may not exist. Push it for the link to work.', abbrevCommit(hash), remote.name));
			return openExternalUrl(url);
		}
		const error = await copyToClipboard(url);
		if (error !== null) return error;
		if (onRemote) {
			vscode.window.setStatusBarMessage(t('Copied the link to the lines at commit {0} to the clipboard.', abbrevCommit(hash)), 4000);
		} else {
			vscode.window.showWarningMessage(t('Copied the link to the clipboard, but the commit {0} isn\'t on the remote "{1}" yet. Push it for the link to work.', abbrevCommit(hash), remote.name));
		}
		return null;
	}

	/**
	 * Open the changes a commit made to a file, selecting a line (from the link in the hover of the blame of a line).
	 * @param repo The repository.
	 * @param hash The hash of the commit.
	 * @param filePath The path of the file in the commit.
	 * @param line The line in the commit (1-based).
	 */
	private async openLineChanges(repo: any, hash: any, filePath: any, line: any) {
		if (typeof repo !== 'string' || typeof hash !== 'string' || typeof filePath !== 'string' || typeof line !== 'number') return;
		const change = await this.dataSource.getLineChange(repo, hash, filePath, line);
		const oldFilePath = change !== null && change.oldFilePath !== null ? change.oldFilePath : filePath;
		const type = change !== null && change.fileAdded ? GitFileStatus.Added : oldFilePath !== filePath ? GitFileStatus.Renamed : GitFileStatus.Modified;
		const error = await viewDiff(repo, hash, hash, oldFilePath, filePath, type, { start: line, end: line });
		if (error !== null) showErrorMessage(error);
	}

	/**
	 * Open a commit on the web page of the repository's remote.
	 * @param repo The repository.
	 * @param hash The hash of the commit.
	 * @returns The error that occurred, or NULL.
	 */
	private async openCommitOnRemote(repo: string, hash: string): Promise<ErrorInfo> {
		const remote = await this.dataSource.getDefaultRemote(repo), webRepo = remote !== null ? getRemoteWebRepo(remote.url) : null;
		if (remote === null || webRepo === null) return t('Unable to Open Commit on Remote: {0}', t('The repository doesn\'t have a remote with a web page (e.g. on GitHub or GitLab).'));
		return openExternalUrl(getRemoteCommitUrl(webRepo, hash));
	}

	/**
	 * Request the avatars of the authors of the changes (if avatars are fetched).
	 * @param repo The repository.
	 * @param history The history of the lines.
	 */
	private async requestAvatars(repo: string, history: GitLineHistory) {
		if (!getConfig().fetchAvatars) return;
		const commits: { [email: string]: string[] } = {};
		history.entries.forEach((entry) => {
			if (entry.hash === UNCOMMITTED || entry.authorEmail === '' || typeof this.avatars[entry.authorEmail] === 'string') return;
			(commits[entry.authorEmail] = commits[entry.authorEmail] || []).push(entry.hash);
		});
		const emails = Object.keys(commits);
		if (emails.length === 0) return;
		const remote = await this.dataSource.getDefaultRemote(repo);
		emails.forEach((email) => {
			this.avatarManager.getAvatarImage(email).then((image) => {
				if (image !== null) {
					this.onAvatar(email, image);
				} else {
					this.avatarManager.fetchAvatarImage(email, repo, remote !== null ? remote.name : null, commits[email]);
				}
			});
		});
	}

	/**
	 * Show an avatar that has been loaded.
	 * @param email The email address of the author.
	 * @param image The avatar (a data URI).
	 */
	private onAvatar(email: string, image: string) {
		if (this.shown === null || !this.shown.history.entries.some((entry) => entry.authorEmail === email)) return;
		const isNew = this.avatars[email] !== image;
		this.avatars[email] = image;
		if (!isNew) return;
		this.drawer.showAvatar(email, image);
		if (this.inline.getThread() !== null) this.inline.update(this.shown.history, (entry) => this.getAvatarUri(entry));
	}

	/**
	 * Get the avatar of the author of a change, for the inline window: their avatar if it has been loaded, otherwise their initial.
	 * @param entry The change.
	 * @returns The avatar (a data URI).
	 */
	private getAvatarUri(entry: GitLineHistoryEntry) {
		const image = entry.hash !== UNCOMMITTED ? this.avatars[entry.authorEmail] : undefined;
		return typeof image === 'string' ? vscode.Uri.parse(image) : getInitialAvatar(entry.hash === UNCOMMITTED ? '*' : entry.author);
	}

	/**
	 * Get the lines of a file (in a repository known by Git Map).
	 * @param uri The file.
	 * @param range The lines.
	 * @returns The lines, or NULL if the file isn't in a repository known by Git Map.
	 */
	private async getTarget(uri: vscode.Uri, range: GitLineRange): Promise<LineHistoryTarget | null> {
		const filePath = getPathFromUri(uri), file = await this.repoManager.getRepoAndPathOfFile(filePath);
		if (file === null) {
			this.logger.log('Unable to view the line history of ' + filePath + ', as it isn\'t in a known repository');
			return null;
		}
		return { uri: uri, repo: file.repo, filePath: file.path, range: range };
	}
}

/**
 * Are two targets the same lines of the same file.
 */
function isSameTarget(a: LineHistoryTarget, b: LineHistoryTarget) {
	return a.uri.toString() === b.uri.toString() && a.range.start === b.range.start && a.range.end === b.range.end;
}

/**
 * Get the range of lines in an editor.
 */
function getRange(range: GitLineRange | null) {
	return range !== null ? new vscode.Range(range.start - 1, 0, range.end - 1, 0) : undefined;
}
