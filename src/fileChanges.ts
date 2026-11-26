import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { EscapeStack } from './escapeStack';
import { runGit } from './historyRewrite';
import { t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { getPathFromUri, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

export interface ChangedLineRange {
	readonly start: number; // 0-based inclusive
	readonly end: number; // 0-based inclusive
	readonly kind: 'added' | 'modified' | 'deleted';
}

/**
 * Parse changed line ranges from `git diff -U0` / `git show -U0` hunk headers.
 */
export function parseChangedLineRangesFromDiff(unifiedZeroDiff: string): ChangedLineRange[] {
	if (typeof unifiedZeroDiff !== 'string' || unifiedZeroDiff === '') return [];
	const ranges: ChangedLineRange[] = [];
	const lines = unifiedZeroDiff.split(/\r?\n/);
	const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(hunkRegex);
		if (m === null) continue;
		const oldCount = typeof m[2] === 'string' ? parseInt(m[2], 10) : 1;
		const newStart = Math.max(1, parseInt(m[3], 10));
		const newCount = typeof m[4] === 'string' ? parseInt(m[4], 10) : 1;
		const start = Math.max(0, newStart - 1);
		const end = newCount > 0 ? start + newCount - 1 : start;
		const kind: ChangedLineRange['kind'] = newCount === 0
			? 'deleted'
			: oldCount === 0
				? 'added'
				: 'modified';
		ranges.push({ start: start, end: end, kind: kind });
	}
	return ranges;
}

interface ChangesFileState {
	readonly repo: string;
	readonly filePath: string;
	readonly ranges: ChangedLineRange[];
	readonly sourceLabel: string;
}

/**
 * Highlights locally modified (uncommitted) or most recently committed changed lines in an editor
 * across gutter, line background, and/or scrollbar, with next/previous change navigation.
 */
export class FileChanges extends Disposable {
	private static instance: FileChanges | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly files = new Map<string, ChangesFileState>();
	private readonly timeouts = new Map<string, NodeJS.Timeout>();
	private decorationType: vscode.TextEditorDecorationType | null = null;
	private windowEnabled: boolean = false;
	private modeOverride: boolean | null = null;

	constructor(
		dataSource: DataSource,
		repoManager: RepoManager,
		logger: Logger,
		onDidChangeConfiguration?: Event<vscode.ConfigurationChangeEvent>,
		onDidChangeGitState?: Event<void>
	) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		FileChanges.instance = this;
		this.rebuildDecorationType();

		const refreshAll = () => {
			if (!this.isWindowOrFileActive()) return;
			vscode.window.visibleTextEditors.forEach((ed) => {
				if (this.shouldAnnotateDocument(ed.document)) {
					void this.computeAndApply(ed.document);
				}
			});
		};

		const disposables: vscode.Disposable[] = [
			vscode.commands.registerCommand('git-map.toggleFileChanges', () => this.toggle()),
			vscode.commands.registerCommand('git-map.annotations.nextChange', () => this.navigateChange(1)),
			vscode.commands.registerCommand('git-map.annotations.previousChange', () => this.navigateChange(-1)),
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				editors.forEach((ed) => {
					if (this.shouldAnnotateDocument(ed.document)) {
						const cached = this.files.get(ed.document.uri.toString());
						if (cached) this.applyToEditor(ed, cached);
						else void this.computeAndApply(ed.document);
					}
				});
			}),
			vscode.window.onDidChangeActiveTextEditor((ed) => {
				if (ed && this.shouldAnnotateDocument(ed.document) && !this.files.has(ed.document.uri.toString())) {
					void this.computeAndApply(ed.document);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.shouldAnnotateDocument(e.document) && e.contentChanges.length > 0) {
					this.scheduleCompute(e.document);
				}
			}),
			vscode.workspace.onDidCloseTextDocument((doc) => this.closeUri(doc.uri)),
			{
				dispose: () => {
					this.timeouts.forEach((t) => clearTimeout(t));
					this.timeouts.clear();
					if (this.decorationType !== null) {
						this.decorationType.dispose();
						this.decorationType = null;
					}
					if (FileChanges.instance === this) FileChanges.instance = null;
				}
			}
		];
		if (typeof onDidChangeConfiguration === 'function') {
			disposables.push(onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-map.changes')) {
					this.rebuildDecorationType();
					refreshAll();
				}
			}));
		}
		if (typeof onDidChangeGitState === 'function') {
			disposables.push(onDidChangeGitState(refreshAll));
		}
		this.registerDisposables(...disposables);
	}

	public static getInstance(): FileChanges | null {
		return FileChanges.instance;
	}

	public setModeOverride(enabled: boolean | null) {
		this.modeOverride = enabled;
		if (enabled === false) {
			this.clearAll();
		} else if (enabled === true && vscode.window.activeTextEditor) {
			void this.computeAndApply(vscode.window.activeTextEditor.document);
		}
	}

	private isWindowOrFileActive(): boolean {
		return this.modeOverride === true || (this.modeOverride !== false && (this.windowEnabled || this.files.size > 0));
	}

	private shouldAnnotateDocument(doc: vscode.TextDocument): boolean {
		if (this.modeOverride === false || doc.uri.scheme !== 'file') return false;
		return this.modeOverride === true || this.windowEnabled || this.files.has(doc.uri.toString());
	}

	private rebuildDecorationType() {
		if (this.decorationType !== null) {
			vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(this.decorationType!, []));
			this.decorationType.dispose();
		}
		const cfg = getConfig().fileChangesConfig;
		const opts: vscode.DecorationRenderOptions = { isWholeLine: true };
		if (cfg.locations.includes('gutter')) {
			opts.borderWidth = '0 0 0 3px';
			opts.borderStyle = 'solid';
			opts.borderColor = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
		}
		if (cfg.locations.includes('line')) {
			opts.backgroundColor = 'rgba(56, 139, 253, 0.12)';
		}
		if (cfg.locations.includes('overviewRuler')) {
			opts.overviewRulerColor = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground');
			opts.overviewRulerLane = vscode.OverviewRulerLane.Center;
		}
		this.decorationType = vscode.window.createTextEditorDecorationType(opts);
	}

	public async toggle(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const cfg = getConfig().fileChangesConfig;
		if (cfg.toggleMode === 'window') {
			this.windowEnabled = !this.windowEnabled;
			if (!this.windowEnabled) this.clearAll();
			else if (editor && editor.document.uri.scheme === 'file') await this.computeAndApply(editor.document);
			return;
		}

		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') {
			showErrorMessage(t('Unable to Toggle File Changes: {0}', t('Open a file in an editor.')));
			return;
		}
		const doc = editor.document;
		const key = doc.uri.toString();
		if (this.files.has(key)) {
			this.closeUri(doc.uri);
			return;
		}
		const filePath = getPathFromUri(doc.uri);
		const file = await this.repoManager.getRepoAndPathOfFile(filePath);
		if (file === null) {
			showErrorMessage(t('Unable to Toggle File Changes: {0}', t('The file {0} isn\'t in a repository known by Git Map.', filePath)));
			return;
		}
		this.files.set(key, { repo: file.repo, filePath: file.path, ranges: [], sourceLabel: '' });
		if (cfg.dismissOnEscape) {
			const uri = doc.uri;
			EscapeStack.push('fileChanges:' + key, () => this.files.has(key) && !!vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === key, () => this.closeUri(uri));
		}
		await this.computeAndApply(doc);
	}

	private clearAll() {
		this.files.clear();
		this.timeouts.forEach((t) => clearTimeout(t));
		this.timeouts.clear();
		if (this.decorationType !== null) {
			vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(this.decorationType!, []));
		}
		this.updateContext();
	}

	private closeUri(uri: vscode.Uri) {
		const key = uri.toString();
		const timer = this.timeouts.get(key);
		if (typeof timer !== 'undefined') clearTimeout(timer);
		this.timeouts.delete(key);
		EscapeStack.remove('fileChanges:' + key);
		this.files.delete(key);
		if (this.decorationType !== null) {
			vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key).forEach((ed) => ed.setDecorations(this.decorationType!, []));
		}
		this.updateContext();
	}

	private scheduleCompute(doc: vscode.TextDocument) {
		const key = doc.uri.toString();
		const prev = this.timeouts.get(key);
		if (typeof prev !== 'undefined') clearTimeout(prev);
		const timer = setTimeout(() => {
			this.timeouts.delete(key);
			void this.computeAndApply(doc);
		}, 450);
		if (typeof timer.unref === 'function') timer.unref();
		this.timeouts.set(key, timer);
	}

	private async computeAndApply(doc: vscode.TextDocument): Promise<void> {
		if (!this.shouldAnnotateDocument(doc)) return;
		const key = doc.uri.toString();
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(doc.uri));
		if (file === null || file.path.startsWith('-')) return;
		try {
			// Check uncommitted changes vs HEAD first
			const wtDiff = await runGit(this.dataSource, file.repo, ['diff', '-U0', 'HEAD', '--', file.path]);
			let ranges = wtDiff.code === 0 ? parseChangedLineRangesFromDiff(wtDiff.stdout.toString()) : [];
			let label = t('Uncommitted changes compared to HEAD');
			if (ranges.length === 0) {
				// Fall back to the most recent commit touching this file
				const lastDiff = await runGit(this.dataSource, file.repo, ['log', '-n', '1', '-p', '-U0', '--format=%h %s', '--', file.path]);
				if (lastDiff.code === 0) {
					const text = lastDiff.stdout.toString();
					ranges = parseChangedLineRangesFromDiff(text);
					const firstLine = text.split(/\r?\n/, 1)[0] || '';
					label = firstLine !== '' ? t('Last commit change: {0}', firstLine) : t('Most recent change');
				}
			}
			const state: ChangesFileState = { repo: file.repo, filePath: file.path, ranges: ranges, sourceLabel: label };
			this.files.set(key, state);
			vscode.window.visibleTextEditors
				.filter((ed) => ed.document.uri.toString() === key)
				.forEach((ed) => this.applyToEditor(ed, state));
			this.updateContext();
		} catch (err) {
			this.logger.logError('Unable to compute file changes: ' + err);
		}
	}

	private applyToEditor(editor: vscode.TextEditor, state: ChangesFileState) {
		if (this.decorationType === null) return;
		const opts: vscode.DecorationOptions[] = [];
		for (let i = 0; i < state.ranges.length; i++) {
			const r = state.ranges[i];
			const start = Math.max(0, Math.min(r.start, editor.document.lineCount - 1));
			const end = Math.max(start, Math.min(r.end, editor.document.lineCount - 1));
			opts.push({
				range: new vscode.Range(start, 0, end, 0),
				hoverMessage: state.sourceLabel
			});
		}
		editor.setDecorations(this.decorationType, opts);
	}

	public async navigateChange(direction: 1 | -1): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme !== 'file') return;
		const key = editor.document.uri.toString();
		let state = this.files.get(key);
		if (!state) {
			await this.computeAndApply(editor.document);
			state = this.files.get(key);
		}
		if (!state || state.ranges.length === 0) {
			vscode.window.setStatusBarMessage(t('No changed lines found in this file.'), 2500);
			return;
		}
		const curLine = editor.selection.active.line;
		let target: ChangedLineRange;
		if (direction > 0) {
			target = state.ranges.find((r) => r.start > curLine) || state.ranges[0];
		} else {
			const prevs = state.ranges.filter((r) => r.end < curLine);
			target = prevs.length > 0 ? prevs[prevs.length - 1] : state.ranges[state.ranges.length - 1];
		}
		const pos = new vscode.Position(Math.min(target.start, Math.max(0, editor.document.lineCount - 1)), 0);
		editor.selection = new vscode.Selection(pos, pos);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:fileChangesShown', this.isWindowOrFileActive());
	}
}
