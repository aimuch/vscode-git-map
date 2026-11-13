import * as vscode from 'vscode';
import { DataSource } from './dataSource';
import { EscapeStack } from './escapeStack';
import { getLanguage, t } from './l10n';
import { getBlameHover } from './lineBlame';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitFileBlame } from './types';
import { getPathFromUri, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';

/**
 * The time (in milliseconds) after a file blamed by the File Blame is changed, before it's blamed again.
 */
const REBLAME_DELAY = 500;

/**
 * The number of characters of an author's name shown in the column of the File Blame.
 */
const AUTHOR_LENGTH = 14;

/**
 * The annotation of a line by the File Blame.
 */
export interface FileBlameAnnotation {
	readonly line: number; // The line (0-based)
	readonly hash: string;
	readonly label: string; // The date & author of the commit (only on the first line of each block of lines changed by the same commit)
	readonly heat: number; // How recently the commit was made, relative to the other commits that changed the file (0 = the oldest, 1 = the newest)
	readonly colour: string;
}

/**
 * A file blamed by the File Blame.
 */
interface BlamedFile {
	readonly repo: string;
	readonly filePath: string;
	annotations: FileBlameAnnotation[];
	decorations: vscode.DecorationOptions[];
	version: number; // The version of the document that was blamed
}

/**
 * Annotates each line of a file with the commit that last changed it (the File Blame, toggled with "Git Map: Toggle File Blame"): a
 * column on the left of the lines shows the date & author of the commit on the first line of each block of lines it changed, coloured by
 * how recently it was made (a heatmap: the newest commits are orange, the oldest are blue). Hovering over it shows the commit.
 */
export class FileBlame extends Disposable {
	private static instance: FileBlame | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly decorationType: vscode.TextEditorDecorationType;
	private readonly files = new Map<string, BlamedFile>(); // The blamed files, by the URI of their document
	private readonly timeouts = new Map<string, NodeJS.Timeout>();

	/**
	 * Creates the File Blame.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.decorationType = vscode.window.createTextEditorDecorationType({
			before: {
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				margin: '0 1.2em 0 0',
				width: (11 + AUTHOR_LENGTH + 1) + 'ch'
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
		});
		FileBlame.instance = this;

		this.registerDisposables(
			this.decorationType,
			vscode.commands.registerCommand('git-map.toggleFileBlame', () => this.toggle()),
			vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => this.decorate(editor))),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.files.has(event.document.uri.toString()) && event.contentChanges.length > 0) this.scheduleBlame(event.document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => this.close(document.uri)),
			{
				dispose: () => {
					this.timeouts.forEach((timeout) => clearTimeout(timeout));
					if (FileBlame.instance === this) FileBlame.instance = null;
				}
			}
		);
	}

	/**
	 * Get the File Blame (used by the end-to-end tests to inspect the annotations).
	 */
	public static getInstance() {
		return FileBlame.instance;
	}

	/**
	 * Get the annotations of a file (if it's blamed).
	 * @param uri The file.
	 * @returns The annotations, or NULL if the file isn't blamed.
	 */
	public getAnnotations(uri: vscode.Uri) {
		const file = this.files.get(uri.toString());
		return typeof file !== 'undefined' ? file.annotations : null;
	}

	/**
	 * Show or hide the File Blame of the file in the active text editor.
	 */
	private async toggle() {
		const editor = vscode.window.activeTextEditor;
		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') {
			showErrorMessage(t('Unable to Toggle File Blame: {0}', t('Open a file in an editor.')));
			return;
		}
		const document = editor.document, key = document.uri.toString();
		if (this.files.has(key)) {
			this.close(document.uri);
			return;
		}
		const filePath = getPathFromUri(document.uri), file = await this.repoManager.getRepoAndPathOfFile(filePath);
		if (file === null) {
			showErrorMessage(t('Unable to Toggle File Blame: {0}', t('The file {0} isn\'t in a repository known by Git Map.', filePath)));
			return;
		}
		this.files.set(key, { repo: file.repo, filePath: file.path, annotations: [], decorations: [], version: -1 });
		// Escape removes the annotations of the file (while it's in the active editor)
		const uri = document.uri;
		EscapeStack.push('fileBlame:' + key, () => this.files.has(key) && typeof vscode.window.activeTextEditor !== 'undefined' && vscode.window.activeTextEditor.document.uri.toString() === key, () => this.close(uri));
		if (!await this.blame(document)) {
			this.close(document.uri);
			showErrorMessage(t('Unable to Toggle File Blame: {0}', t('The file {0} isn\'t tracked by Git.', filePath)));
		}
	}

	/**
	 * Stop blaming a file, removing its annotations.
	 * @param uri The file.
	 */
	private close(uri: vscode.Uri) {
		const key = uri.toString(), timeout = this.timeouts.get(key);
		if (typeof timeout !== 'undefined') clearTimeout(timeout);
		this.timeouts.delete(key);
		EscapeStack.remove('fileBlame:' + key);
		if (!this.files.delete(key)) return;
		vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === key).forEach((editor) => editor.setDecorations(this.decorationType, []));
		this.updateContext();
	}

	/**
	 * Blame a file again once it stops being changed (as the lines may have moved).
	 * @param document The document of the file.
	 */
	private scheduleBlame(document: vscode.TextDocument) {
		const key = document.uri.toString(), timeout = this.timeouts.get(key);
		if (typeof timeout !== 'undefined') clearTimeout(timeout);
		this.timeouts.set(key, setTimeout(() => {
			this.timeouts.delete(key);
			this.blame(document).catch((error) => this.logger.logError('Unable to blame ' + document.uri.fsPath + ': ' + error));
		}, REBLAME_DELAY));
	}

	/**
	 * Blame a file, and annotate the editors showing it.
	 * @param document The document of the file.
	 * @returns TRUE => The file was blamed, FALSE => It couldn't be blamed (e.g. it isn't tracked).
	 */
	private async blame(document: vscode.TextDocument) {
		const key = document.uri.toString(), file = this.files.get(key), version = document.version;
		if (typeof file === 'undefined') return false;
		const blame = await this.dataSource.getFileBlame(file.repo, file.filePath, document.getText());
		if (this.files.get(key) !== file || document.version !== version) return true; // The file stopped being blamed, or was changed again
		if (blame === null) return false;
		file.annotations = getAnnotations(blame);
		file.decorations = file.annotations.map((annotation) => {
			const line = blame.lines[annotation.line], commit = blame.commits[line.hash];
			return {
				range: new vscode.Range(annotation.line, 0, annotation.line, 0),
				hoverMessage: annotation.label !== '' ? getBlameHover(file.repo, { hash: line.hash, committed: commit.committed, author: commit.author, authorEmail: commit.authorEmail, authorDate: commit.authorDate, summary: commit.summary, originalLine: line.originalLine, originalFilePath: commit.filePath }, document.uri, annotation.line + 1, null) : undefined,
				renderOptions: { before: { contentText: annotation.label !== '' ? annotation.label : ' ', backgroundColor: annotation.colour } }
			};
		});
		file.version = version;
		vscode.window.visibleTextEditors.forEach((editor) => this.decorate(editor));
		this.updateContext();
		return true;
	}

	/**
	 * Annotate an editor, if its file is blamed.
	 * @param editor The editor.
	 */
	private decorate(editor: vscode.TextEditor) {
		const file = this.files.get(editor.document.uri.toString());
		if (typeof file !== 'undefined') editor.setDecorations(this.decorationType, file.decorations);
	}

	/**
	 * Update the context key used by the menus (whether any file is blamed).
	 */
	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:fileBlameShown', this.files.size > 0);
	}
}

/**
 * Get the annotations of the lines of a blamed file.
 * @param blame The blame of the file.
 * @returns The annotations.
 */
export function getAnnotations(blame: GitFileBlame): FileBlameAnnotation[] {
	const dates = Object.keys(blame.commits).filter((hash) => blame.commits[hash].committed).map((hash) => blame.commits[hash].authorDate);
	const oldest = Math.min(...dates), newest = Math.max(...dates);
	const annotations: FileBlameAnnotation[] = [];
	blame.lines.forEach((line, index) => {
		if (typeof line === 'undefined') return;
		const commit = blame.commits[line.hash], first = index === 0 || typeof blame.lines[index - 1] === 'undefined' || blame.lines[index - 1].hash !== line.hash;
		// The uncommitted changes are the newest
		const heat = !commit.committed ? 1 : newest > oldest ? (commit.authorDate - oldest) / (newest - oldest) : 1;
		annotations.push({
			line: index,
			hash: line.hash,
			label: first ? getLabel(commit.committed ? formatShortDate(commit.authorDate) : t('Uncommitted'), commit.committed ? commit.author : t('You')) : '',
			heat: heat,
			colour: getHeatColour(heat)
		});
	});
	return annotations;
}

/**
 * Get the label of a block of lines: the date & author of the commit that changed them (the author is truncated to fit the column).
 */
function getLabel(date: string, author: string) {
	return date + ' ' + (author.length > AUTHOR_LENGTH ? author.substring(0, AUTHOR_LENGTH - 1) + '…' : author);
}

/**
 * Format a date as YYYY-MM-DD (or the short date of the language Git Map is displayed in).
 */
function formatShortDate(date: number) {
	const d = new Date(date * 1000), pad = (n: number) => (n < 10 ? '0' : '') + n;
	return getLanguage() === 'zh-cn' ? d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/**
 * Get the colour of the heatmap for how recently a commit was made: from blue (the oldest) to orange (the newest), more opaque the newer
 * it is, so it's visible with light & dark themes.
 * @param heat How recently the commit was made (0 = the oldest, 1 = the newest).
 * @returns The colour.
 */
export function getHeatColour(heat: number) {
	const hue = Math.round(215 - 185 * heat), alpha = (0.14 + 0.22 * heat).toFixed(2);
	return 'hsla(' + hue + ', 80%, 55%, ' + alpha + ')';
}
