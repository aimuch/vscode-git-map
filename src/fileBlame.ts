import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { EscapeStack } from './escapeStack';
import { getLanguage, t } from './l10n';
import { formatBlameTemplate, getBlameHover } from './lineBlame';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { AnnotationLocation, GitFileBlame } from './types';
import { getPathFromUri, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

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
 * how recently it was made (a heatmap: the newest commits are orange, the oldest are blue). Hovering over it shows the commit, and
 * selecting a line highlights all other lines modified in the same commit.
 */
export class FileBlame extends Disposable {
	private static instance: FileBlame | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly decorationType: vscode.TextEditorDecorationType;
	private sameCommitDecorationType: vscode.TextEditorDecorationType;
	private readonly files = new Map<string, BlamedFile>(); // The blamed files, by the URI of their document
	private readonly timeouts = new Map<string, NodeJS.Timeout>();
	private readonly cancellations = new Map<string, vscode.CancellationTokenSource>();
	private windowEnabled: boolean = false;
	private modeOverride: boolean | null = null;

	/**
	 * Creates the File Blame.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param logger The Git Map Logger instance.
	 * @param onDidChangeConfiguration Optional Event emitting when configuration changes.
	 * @param onDidChangeGitState Optional Event emitting when HEAD, the index, or refs change in a repository.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger, onDidChangeConfiguration?: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitState?: Event<void>) {
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
		this.sameCommitDecorationType = createSameCommitDecorationType(getConfig().fileBlameConfig.highlightLocations);
		FileBlame.instance = this;
		const reblameAll = () => {
			if (!this.windowEnabled && this.modeOverride !== true && this.files.size === 0) return;
			vscode.workspace.textDocuments.forEach((doc) => {
				if (this.shouldBlameDocument(doc)) this.scheduleBlame(doc);
			});
		};

		this.registerDisposables(
			this.decorationType,
			vscode.commands.registerCommand('git-map.toggleFileBlame', () => this.toggle()),
			vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((editor) => {
				if (this.files.has(editor.document.uri.toString())) {
					this.decorate(editor);
				} else if (this.shouldBlameDocument(editor.document)) {
					void this.ensureWindowFileBlamed(editor.document);
				}
			})),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor && this.shouldBlameDocument(editor.document) && !this.files.has(editor.document.uri.toString())) {
					void this.ensureWindowFileBlamed(editor.document);
				} else if (editor) {
					this.highlightSameCommitLines(editor);
				}
			}),
			vscode.window.onDidChangeTextEditorSelection((event) => {
				if (this.files.has(event.textEditor.document.uri.toString())) {
					this.highlightSameCommitLines(event.textEditor);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.shouldBlameDocument(event.document) && event.contentChanges.length > 0) this.scheduleBlame(event.document);
			}),
			vscode.workspace.onDidCloseTextDocument((document) => this.close(document.uri)),
			...(typeof onDidChangeConfiguration === 'function' ? [onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.blame') || event.affectsConfiguration('git-map.language')) {
					this.rebuildSameCommitDecoration();
					reblameAll();
				}
			})] : []),
			...(typeof onDidChangeGitState === 'function' ? [onDidChangeGitState(reblameAll)] : []),
			{
				dispose: () => {
					this.timeouts.forEach((timeout) => clearTimeout(timeout));
					this.cancellations.forEach((cancellation) => {
						cancellation.cancel();
						cancellation.dispose();
					});
					this.cancellations.clear();
					this.sameCommitDecorationType.dispose();
					if (FileBlame.instance === this) FileBlame.instance = null;
				}
			}
		);
	}

	private shouldBlameDocument(doc: vscode.TextDocument): boolean {
		if (this.modeOverride === false || doc.uri.scheme !== 'file') return false;
		return this.modeOverride === true || this.windowEnabled || this.files.has(doc.uri.toString());
	}

	private rebuildSameCommitDecoration() {
		vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(this.sameCommitDecorationType, []));
		this.sameCommitDecorationType.dispose();
		this.sameCommitDecorationType = createSameCommitDecorationType(getConfig().fileBlameConfig.highlightLocations);
		vscode.window.visibleTextEditors.forEach((ed) => {
			if (this.files.has(ed.document.uri.toString())) this.highlightSameCommitLines(ed);
		});
	}

	public setModeOverride(enabled: boolean | null) {
		this.modeOverride = enabled;
		if (enabled === false) {
			Array.from(this.files.keys()).forEach((k) => this.close(vscode.Uri.parse(k)));
		} else if (enabled === true && vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.scheme === 'file') {
			void this.ensureWindowFileBlamed(vscode.window.activeTextEditor.document);
		}
	}

	private async ensureWindowFileBlamed(document: vscode.TextDocument) {
		const key = document.uri.toString();
		if (this.files.has(key)) return;
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(document.uri));
		if (file === null) return;
		this.files.set(key, { repo: file.repo, filePath: file.path, annotations: [], decorations: [], version: -1 });
		if (!await this.blame(document)) {
			this.close(document.uri);
		}
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
		const cfg = getConfig().fileBlameConfig;
		const editor = vscode.window.activeTextEditor;
		if (cfg.toggleMode === 'window') {
			this.windowEnabled = !this.windowEnabled;
			if (!this.windowEnabled) {
				Array.from(this.files.keys()).forEach((k) => this.close(vscode.Uri.parse(k)));
			} else if (editor && editor.document.uri.scheme === 'file') {
				await this.ensureWindowFileBlamed(editor.document);
			}
			return;
		}
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
		if (cfg.dismissOnEscape) {
			const uri = document.uri;
			EscapeStack.push('fileBlame:' + key, () => this.files.has(key) && typeof vscode.window.activeTextEditor !== 'undefined' && vscode.window.activeTextEditor.document.uri.toString() === key, () => this.close(uri));
		}
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
		const key = uri.toString(), timeout = this.timeouts.get(key), cancellation = this.cancellations.get(key);
		if (typeof timeout !== 'undefined') clearTimeout(timeout);
		this.timeouts.delete(key);
		if (typeof cancellation !== 'undefined') {
			cancellation.cancel();
			cancellation.dispose();
			this.cancellations.delete(key);
		}
		EscapeStack.remove('fileBlame:' + key);
		if (!this.files.delete(key)) return;
		vscode.window.visibleTextEditors.filter((editor) => editor.document.uri.toString() === key).forEach((editor) => {
			editor.setDecorations(this.decorationType, []);
			editor.setDecorations(this.sameCommitDecorationType, []);
		});
		this.updateContext();
	}

	/**
	 * Blame a file again once it stops being changed (as the lines may have moved).
	 * @param document The document of the file.
	 */
	private scheduleBlame(document: vscode.TextDocument) {
		const blameCfg = getConfig().fileBlameConfig;
		if (document.isDirty && blameCfg.sizeThresholdAfterEdit > 0 && document.lineCount > blameCfg.sizeThresholdAfterEdit) {
			return;
		}
		const key = document.uri.toString(), timeout = this.timeouts.get(key), cancellation = this.cancellations.get(key);
		if (typeof timeout !== 'undefined') clearTimeout(timeout);
		if (typeof cancellation !== 'undefined') {
			cancellation.cancel();
			cancellation.dispose();
			this.cancellations.delete(key);
		}
		const delay = document.isDirty ? blameCfg.delayAfterEdit : 500;
		const timer = setTimeout(() => {
			this.timeouts.delete(key);
			this.blame(document).catch((error) => this.logger.logError('Unable to blame ' + document.uri.fsPath + ': ' + error));
		}, delay);
		if (typeof timer.unref === 'function') timer.unref();
		this.timeouts.set(key, timer);
	}

	/**
	 * Blame a file, and annotate the editors showing it.
	 * @param document The document of the file.
	 * @returns TRUE => The file was blamed, FALSE => It couldn't be blamed (e.g. it isn't tracked).
	 */
	private async blame(document: vscode.TextDocument) {
		const key = document.uri.toString(), file = this.files.get(key), version = document.version;
		if (typeof file === 'undefined') return false;
		const previous = this.cancellations.get(key);
		if (typeof previous !== 'undefined') {
			previous.cancel();
			previous.dispose();
		}
		const cancellation = new vscode.CancellationTokenSource();
		this.cancellations.set(key, cancellation);
		try {
			const blame = await this.dataSource.getFileBlame(file.repo, file.filePath, document.isDirty ? document.getText() : null, cancellation.token);
			if (cancellation.token.isCancellationRequested || this.files.get(key) !== file || document.version !== version) return true; // The file stopped being blamed, or was changed again
			if (blame === null) return false;
			const repoCfg = getConfig(file.repo), cfg = repoCfg.fileBlameConfig, hoverCfg = repoCfg.hoversConfig, hoversEnabled = hoverCfg.enabled && hoverCfg.annotationsEnabled;
			const dateFormat = cfg.dateFormat !== '' ? cfg.dateFormat : repoCfg.defaultDateShortFormat;
			file.annotations = getAnnotations(blame, cfg.compact, cfg.format !== '' || dateFormat !== '' || repoCfg.blameDateStyle === 'absolute' ? { format: cfg.format, dateFormat: dateFormat, dateStyle: repoCfg.blameDateStyle, locale: repoCfg.defaultDateLocale } : null);
			file.decorations = file.annotations.map((annotation) => {
				const line = blame.lines[annotation.line], commit = blame.commits[line.hash];
				const before: vscode.ThemableDecorationAttachmentRenderOptions = {
					contentText: annotation.label !== '' ? annotation.label : ' '
				};
				if (cfg.heatmapEnabled) {
					before.backgroundColor = annotation.colour;
					before.border = '2px solid ' + annotation.colour;
				}
				// The hover is shown over the annotation (only on the first line of a block), or over every line (`git-map.hovers.annotations.over`)
				const hovered = hoversEnabled && (annotation.label !== '' || hoverCfg.annotationsOver === 'line');
				return {
					range: hoverCfg.annotationsOver === 'line' ? new vscode.Range(annotation.line, 0, annotation.line, Number.MAX_SAFE_INTEGER) : new vscode.Range(annotation.line, 0, annotation.line, 0),
					hoverMessage: hovered ? getBlameHover(file.repo, { hash: line.hash, committed: commit.committed, author: commit.author, authorEmail: commit.authorEmail, authorDate: commit.authorDate, summary: commit.summary, originalLine: line.originalLine, originalFilePath: commit.filePath }, document.uri, annotation.line + 1, null, { includeDetails: hoverCfg.annotationsDetails, includeChanges: false, autolinks: hoverCfg.autolinksEnabled ? repoCfg.autolinks : [], prInfo: null }) : undefined,
					renderOptions: { before: before }
				};
			});
			file.version = version;
			vscode.window.visibleTextEditors.forEach((editor) => this.decorate(editor));
			this.updateContext();
			return true;
		} finally {
			cancellation.dispose();
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		}
	}

	/**
	 * Annotate an editor, if its file is blamed.
	 * @param editor The editor.
	 */
	private decorate(editor: vscode.TextEditor) {
		const file = this.files.get(editor.document.uri.toString());
		if (typeof file !== 'undefined') {
			editor.setDecorations(this.decorationType, file.decorations);
			this.highlightSameCommitLines(editor);
		}
	}

	private highlightSameCommitLines(editor: vscode.TextEditor) {
		const cfg = getConfig().fileBlameConfig;
		const file = this.files.get(editor.document.uri.toString());
		if (!cfg.highlightEnabled || !file || file.annotations.length === 0) {
			editor.setDecorations(this.sameCommitDecorationType, []);
			return;
		}
		const activeLine = editor.selection ? editor.selection.active.line : -1;
		const target = file.annotations.find((a) => a.line === activeLine);
		if (!target) {
			editor.setDecorations(this.sameCommitDecorationType, []);
			return;
		}
		const matches: vscode.Range[] = [];
		for (let i = 0; i < file.annotations.length; i++) {
			const ann = file.annotations[i];
			if (ann.hash === target.hash) {
				matches.push(new vscode.Range(ann.line, 0, ann.line, 0));
			}
		}
		editor.setDecorations(this.sameCommitDecorationType, matches);
	}

	/**
	 * Update the context key used by the menus (whether any file is blamed).
	 */
	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:fileBlameShown', this.files.size > 0);
	}
}

function createSameCommitDecorationType(locations: ReadonlyArray<AnnotationLocation>): vscode.TextEditorDecorationType {
	const opts: vscode.DecorationRenderOptions = { isWholeLine: true };
	if (locations.includes('line')) {
		opts.backgroundColor = 'rgba(130, 170, 255, 0.09)';
	}
	if (locations.includes('gutter')) {
		opts.borderWidth = '0 0 0 2px';
		opts.borderStyle = 'solid';
		opts.borderColor = new vscode.ThemeColor('editorOverviewRuler.modifiedForeground');
	}
	if (locations.includes('overviewRuler')) {
		opts.overviewRulerColor = new vscode.ThemeColor('editorOverviewRuler.modifiedForeground');
		opts.overviewRulerLane = vscode.OverviewRulerLane.Left;
	}
	return vscode.window.createTextEditorDecorationType(opts);
}

/**
 * Get the annotations of the lines of a blamed file.
 * @param blame The blame of the file.
 * @param compact When true (default), hide repeated author labels on contiguous lines from the same commit.
 * @returns The annotations.
 */
export function getAnnotations(blame: GitFileBlame, compact: boolean = true, template: FileBlameTemplate | null = null): FileBlameAnnotation[] {
	const dates = Object.keys(blame.commits).filter((hash) => blame.commits[hash].committed).map((hash) => blame.commits[hash].authorDate);
	const oldest = Math.min(...dates), newest = Math.max(...dates);
	const annotations: FileBlameAnnotation[] = [];
	blame.lines.forEach((line, index) => {
		if (typeof line === 'undefined') return;
		const commit = blame.commits[line.hash], first = !compact || index === 0 || typeof blame.lines[index - 1] === 'undefined' || blame.lines[index - 1].hash !== line.hash;
		// The uncommitted changes are the newest
		const heat = !commit.committed ? 1 : newest > oldest ? (commit.authorDate - oldest) / (newest - oldest) : 1;
		annotations.push({
			line: index,
			hash: line.hash,
			label: !first ? ''
				: template !== null
					? getTemplateLabel(template, line.hash, commit, line.originalLine)
					: getLabel(commit.committed ? formatShortDate(commit.authorDate) : t('Uncommitted'), commit.committed ? commit.author : t('You')),
			heat: heat,
			colour: getHeatColour(heat)
		});
	});
	return annotations;
}

/**
 * The format of the labels of File Blame (`git-map.fileBlame.format` & `git-map.fileBlame.dateFormat`).
 */
export interface FileBlameTemplate {
	readonly format: string; // The template of the label (empty => the date & author)
	readonly dateFormat: string; // The format of `${date}` (empty => YYYY-MM-DD)
	readonly dateStyle: 'relative' | 'absolute';
	readonly locale: string;
}

/**
 * Get the label of a block of lines from the template of File Blame.
 */
function getTemplateLabel(template: FileBlameTemplate, hash: string, commit: GitFileBlame['commits'][string], originalLine: number) {
	const format = template.format !== '' ? template.format : '${date} ${author|' + AUTHOR_LENGTH + '?}';
	const blame = { hash: hash, committed: commit.committed, author: commit.author, authorEmail: commit.authorEmail, authorDate: commit.authorDate, summary: commit.summary, originalLine: originalLine, originalFilePath: commit.filePath };
	if (!commit.committed) return t('Uncommitted') + ' ' + t('You');
	return formatBlameTemplate(format, blame, null, { style: template.dateStyle, format: template.dateFormat !== '' ? template.dateFormat : (getLanguage() === 'zh-cn' ? 'YYYY/MM/DD' : 'YYYY-MM-DD'), locale: template.locale });
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
