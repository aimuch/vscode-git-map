import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitLineBlame } from './types';
import { abbrevCommit, getPathFromUri, getRelativeTimeDiff } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * The time (in milliseconds) the cursor must stay on a line before it's blamed.
 */
const BLAME_DELAY = 150;

/**
 * The time (in milliseconds) the blame of a line is kept while the cursor stays on the line and its document isn't changed, so that moving
 * the cursor within the line doesn't run Git again. It's short, as the blame of a line changes when it's committed.
 */
const BLAME_CACHE_DURATION = 5000;

/**
 * Shows who last changed the line the cursor is on, and when & why (the author, date & subject of the commit), at the end of the line
 * in the editor (the `git-map.blame.currentLine` Extension Setting). Hovering over it shows the commit, with a link that opens it in the
 * Git Map View.
 */
export class LineBlame extends Disposable {
	private static instance: LineBlame | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly decorationType: vscode.TextEditorDecorationType;
	private readonly statusBarItem: vscode.StatusBarItem;
	private enabled: boolean; // Is the blame of the current line shown (at the end of the line, or in the Status Bar)
	private inline: boolean; // Is it shown at the end of the line (git-map.blame.currentLine)
	private statusBar: boolean; // Is it shown in the Status Bar (git-map.blame.statusBar)
	private timeout: NodeJS.Timeout | null = null;
	private requestId: number = 0;
	private decoratedEditor: vscode.TextEditor | null = null;
	private decoratedLine: number = -1;
	private lastBlamed: { readonly editor: vscode.TextEditor, readonly line: number, readonly version: number, readonly time: number } | null = null; // The line whose blame was loaded last

	/**
	 * Creates the Line Blame.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param onDidChangeConfiguration The Event emitting when the configuration changes.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		const config = getConfig();
		this.inline = config.blameCurrentLine;
		this.statusBar = config.blameStatusBar;
		this.enabled = this.inline || this.statusBar;
		this.statusBarItem = vscode.window.createStatusBarItem('git-map.blame', vscode.StatusBarAlignment.Left, 0);
		this.statusBarItem.name = t('Git Map: Blame of the Current Line');
		this.decorationType = vscode.window.createTextEditorDecorationType({
			after: {
				margin: '0 0 0 3em',
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				fontStyle: 'italic'
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
		});

		LineBlame.instance = this;
		this.registerDisposables(
			this.decorationType,
			this.statusBarItem,
			vscode.window.onDidChangeTextEditorSelection((event) => this.schedule(event.textEditor)),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				this.clear();
				if (editor) this.schedule(editor);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// The line numbers may have changed, so the blame is updated once the document stops changing
				if (this.decoratedEditor !== null && this.decoratedEditor.document === event.document) this.schedule(this.decoratedEditor);
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.blame.currentLine') || event.affectsConfiguration('git-map.blame.statusBar') || event.affectsConfiguration('git-map.blame.ignoreWhitespace') || event.affectsConfiguration('git-map.blame.ignoreRevsFile')) {
					const config = getConfig();
					this.inline = config.blameCurrentLine;
					this.statusBar = config.blameStatusBar;
					this.enabled = this.inline || this.statusBar;
					this.clear();
					if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
				}
			}),
			{
				dispose: () => {
					this.cancel();
					if (LineBlame.instance === this) LineBlame.instance = null;
				}
			}
		);
		if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
	}

	/**
	 * Get the Line Blame (used by the end-to-end tests to inspect the blame that's shown).
	 */
	public static getInstance() {
		return LineBlame.instance;
	}

	/**
	 * Get the line whose blame is shown.
	 * @returns The file & line (0-based), or NULL if no blame is shown.
	 */
	public getShownLine() {
		return this.decoratedEditor !== null ? { uri: this.decoratedEditor.document.uri, line: this.decoratedLine } : null;
	}

	/**
	 * Blame the line the cursor is on in an editor, once the cursor stops moving.
	 * @param editor The editor.
	 */
	private schedule(editor: vscode.TextEditor) {
		if (!this.enabled) return;
		const last = this.lastBlamed;
		if (last !== null && last.editor === editor && editor.selections.length === 1 && last.line === editor.selection.active.line && last.version === editor.document.version && Date.now() - last.time < BLAME_CACHE_DURATION) {
			// The cursor moved within the line that was just blamed
			return;
		}
		this.cancel();
		if (this.decoratedEditor !== null && this.decoratedEditor.selection.active.line !== editor.selection.active.line) this.clear();
		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.update(editor).catch((error) => this.logger.logError('Unable to blame the current line: ' + error));
		}, BLAME_DELAY);
	}

	/**
	 * Cancel the scheduled blame, and ignore the result of a blame that's in progress.
	 */
	private cancel() {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.requestId++;
	}

	/**
	 * Remove the blame from the editor it's shown in.
	 */
	private clear() {
		this.lastBlamed = null;
		this.statusBarItem.hide();
		this.statusBarVisible = false;
		if (this.decoratedEditor !== null) {
			this.decoratedEditor.setDecorations(this.decorationType, []);
			this.decoratedEditor = null;
		}
	}

	/**
	 * Get the text shown in the Status Bar (used by the end-to-end tests).
	 * @returns The text, or NULL if the Status Bar item is hidden.
	 */
	public getStatusBarText() {
		return this.statusBarVisible ? this.statusBarItem.text : null;
	}
	private statusBarVisible: boolean = false;

	/**
	 * Show the blame of a line in the Status Bar.
	 */
	private showInStatusBar(blame: GitLineBlame, uri: vscode.Uri, line: number) {
		this.statusBarItem.text = '$(git-commit) ' + (blame.committed ? t('{0}, {1}', blame.author, getRelativeTimeDiff(blame.authorDate)) : t('You, Uncommitted changes'));
		this.statusBarItem.tooltip = blame.committed ? abbrevCommit(blame.hash) + ' · ' + blame.author + ' · ' + blame.summary : t('This line has uncommitted changes.');
		this.statusBarItem.command = { title: t('View Line History'), command: 'git-map.viewLineHistory', arguments: [{ uri: uri.toString(), start: line, end: line }] };
		this.statusBarItem.show();
		this.statusBarVisible = true;
	}

	/**
	 * Blame the line the cursor is on in an editor, and show the blame at the end of the line.
	 * @param editor The editor.
	 */
	private async update(editor: vscode.TextEditor) {
		const document = editor.document;
		if (!this.enabled || editor !== vscode.window.activeTextEditor || document.uri.scheme !== 'file' || editor.selections.length !== 1) {
			this.clear();
			return;
		}
		const filePath = getPathFromUri(document.uri), repo = this.repoManager.getRepoContainingFile(filePath);
		if (repo === null) {
			this.clear();
			return;
		}
		const line = editor.selection.active.line, version = document.version, requestId = ++this.requestId;
		const blamed = () => this.lastBlamed = { editor: editor, line: line, version: version, time: Date.now() };
		const blame = await this.dataSource.getLineBlame(repo, filePath.substring(repo.length + 1), line + 1, document.getText());
		if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
		this.clear();
		if (blame === null) {
			// The line can't be blamed (e.g. the file isn't tracked), which is also remembered
			blamed();
			return;
		}

		if (this.statusBar) this.showInStatusBar(blame, document.uri, line + 1);
		this.decoratedEditor = editor;
		this.decoratedLine = line;
		if (!this.inline) {
			blamed();
			return;
		}
		const end = document.lineAt(line).range.end;
		const decorate = (change: ReadonlyArray<string> | null) => editor.setDecorations(this.decorationType, [{
			range: new vscode.Range(end, end),
			hoverMessage: getBlameHover(repo, blame, document.uri, line + 1, change),
			renderOptions: { after: { contentText: getBlameText(blame) } }
		}]);
		decorate(null);

		// The hover also shows how the commit changed the line, once it has been loaded
		if (!blame.committed) {
			blamed();
			return;
		}
		const change = await this.dataSource.getLineChange(repo, blame.hash, blame.originalFilePath, blame.originalLine);
		if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line || this.decoratedEditor !== editor) return;
		if (change !== null) decorate(change.diff);
		blamed();
	}
}

/**
 * Get the text of the blame of a line, shown at the end of the line.
 * @param blame The blame of the line.
 * @returns The text.
 */
export function getBlameText(blame: GitLineBlame) {
	if (!blame.committed) return t('You, Uncommitted changes');
	const summary = blame.summary.length > 60 ? blame.summary.substring(0, 59) + '…' : blame.summary;
	return t('{0}, {1} • {2}', blame.author, getRelativeTimeDiff(blame.authorDate), summary);
}

/**
 * The maximum number of lines of the diff shown in the hover of the blame of a line.
 */
const MAX_HOVER_DIFF_LINES = 12;

/**
 * Get the hover of the blame of a line: the commit, how it changed the line, and links to view the history of the line, open the changes,
 * view the commit in the Git Map View, and copy a link to the line on the remote.
 * @param repo The repository containing the line.
 * @param blame The blame of the line.
 * @param uri The file.
 * @param line The line (1-based) in the editor.
 * @param change The diff of the line in the commit, or NULL if it hasn't been loaded.
 * @returns The hover.
 */
export function getBlameHover(repo: string, blame: GitLineBlame, uri: vscode.Uri, line: number, change: ReadonlyArray<string> | null) {
	const hover = new vscode.MarkdownString(undefined, true);
	const args = (value: any[]) => encodeURIComponent(JSON.stringify(value));
	const lineHistoryLink = '[$(history) ' + t('View Line History') + '](command:git-map.viewLineHistory?' + args([{ uri: uri.toString(), start: line, end: line }]) + ')';
	hover.isTrusted = { enabledCommands: ['git-map.viewCommitInGitMap', 'git-map.viewLineHistory', 'git-map.openLineChanges', 'git-map.copyRemoteLink'] };
	if (!blame.committed) {
		hover.appendText(t('This line has uncommitted changes.'));
		hover.appendMarkdown('\n\n' + lineHistoryLink);
		return hover;
	}
	hover.appendMarkdown('$(git-commit) **' + abbrevCommit(blame.hash) + '** · ');
	hover.appendText(blame.author + ' <' + blame.authorEmail + '> · ' + new Date(blame.authorDate * 1000).toLocaleString(getLanguage() === 'zh-cn' ? 'zh-CN' : 'en'));
	hover.appendMarkdown('\n\n');
	hover.appendText(blame.summary);
	if (change !== null && change.length > 0) {
		const lines = change.slice(0, MAX_HOVER_DIFF_LINES), fence = '`'.repeat(Math.max(3, ...lines.map((diffLine) => (diffLine.match(/`+/g) || ['']).reduce((max, run) => Math.max(max, run.length + 1), 0))));
		hover.appendMarkdown('\n\n' + fence + 'diff\n' + lines.join('\n') + (change.length > MAX_HOVER_DIFF_LINES ? '\n…' : '') + '\n' + fence);
	}
	hover.appendMarkdown('\n\n' + [
		lineHistoryLink,
		'[$(diff) ' + t('Open Changes') + '](command:git-map.openLineChanges?' + args([repo, blame.hash, blame.originalFilePath, blame.originalLine]) + ')',
		'[$(git-merge) ' + t('View Commit in Git Map') + '](command:git-map.viewCommitInGitMap?' + args([repo, blame.hash]) + ')',
		'[$(link) ' + t('Copy Remote Link') + '](command:git-map.copyRemoteLink?' + args([repo, blame.hash, blame.originalFilePath, blame.originalLine, blame.originalLine]) + ')'
	].join(' · '));
	return hover;
}
