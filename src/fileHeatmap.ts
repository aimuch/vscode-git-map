import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { EscapeStack } from './escapeStack';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitFileBlame } from './types';
import { getPathFromUri, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

const BUCKET_COUNT = 6;

export interface HeatBucket {
	readonly isHot: boolean;
	readonly level: number; // 0 (oldest/coolest) .. 5 (newest/hottest)
}

/**
 * Classify a commit timestamp (in Unix seconds) into a hot/cold heatmap bucket relative to `nowSec` and `ageThresholdDays`.
 */
export function computeHeatBucket(authorDateSec: number, nowSec: number, ageThresholdDays: number): HeatBucket {
	const ageDays = Math.max(0, (nowSec - authorDateSec) / 86400);
	const threshold = Math.max(1, ageThresholdDays);
	if (ageDays <= threshold) {
		// Newer -> higher level (5 is today, 0 is at threshold edge)
		const ratio = 1 - ageDays / threshold;
		return { isHot: true, level: Math.max(0, Math.min(BUCKET_COUNT - 1, Math.round(ratio * (BUCKET_COUNT - 1)))) };
	}
	// Older than threshold -> cold scale fading up to 5x threshold
	const coldSpan = threshold * 4;
	const coldRatio = Math.min(1, (ageDays - threshold) / coldSpan);
	return { isHot: false, level: Math.max(0, Math.min(BUCKET_COUNT - 1, Math.round((1 - coldRatio) * (BUCKET_COUNT - 1)))) };
}

function hexToRgba(hex: string, alpha: number): string {
	const cleaned = hex.replace('#', '');
	if (cleaned.length !== 6) return 'rgba(246, 106, 10, ' + alpha.toFixed(2) + ')';
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha.toFixed(2) + ')';
}

interface HeatmapFileState {
	readonly repo: string;
	readonly filePath: string;
	readonly blame: GitFileBlame | null;
}

/**
 * Independent File Heatmap annotation layer: highlights recency of changes in the gutter, line background, and/or scrollbar,
 * with configurable hot/cold color thresholds and optional fading for older lines.
 */
export class FileHeatmap extends Disposable {
	private static instance: FileHeatmap | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly files = new Map<string, HeatmapFileState>();
	private readonly timeouts = new Map<string, NodeJS.Timeout>();
	private readonly cancellations = new Map<string, vscode.CancellationTokenSource>();
	private decorationTypes: { hot: vscode.TextEditorDecorationType[], cold: vscode.TextEditorDecorationType[] } | null = null;
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
		FileHeatmap.instance = this;
		this.rebuildDecorationTypes();

		const refreshAll = () => {
			if (!this.isWindowOrFileActive()) return;
			vscode.window.visibleTextEditors.forEach((editor) => {
				if (this.shouldAnnotateDocument(editor.document)) {
					void this.computeAndApply(editor.document);
				}
			});
		};

		const disposables: vscode.Disposable[] = [
			vscode.commands.registerCommand('git-map.toggleFileHeatmap', () => this.toggle()),
			vscode.window.onDidChangeVisibleTextEditors((editors) => {
				editors.forEach((editor) => {
					if (this.shouldAnnotateDocument(editor.document)) {
						const cached = this.files.get(editor.document.uri.toString());
						if (cached && cached.blame) {
							this.applyToEditor(editor, cached.blame);
						} else {
							void this.computeAndApply(editor.document);
						}
					}
				});
			}),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor && this.shouldAnnotateDocument(editor.document) && !this.files.has(editor.document.uri.toString())) {
					void this.computeAndApply(editor.document);
				}
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				const key = e.document.uri.toString();
				if (this.shouldAnnotateDocument(e.document) && e.contentChanges.length > 0) {
					this.scheduleCompute(e.document);
				} else if (!this.shouldAnnotateDocument(e.document) && this.files.has(key)) {
					this.closeUri(e.document.uri);
				}
			}),
			vscode.workspace.onDidCloseTextDocument((doc) => this.closeUri(doc.uri)),
			{
				dispose: () => {
					this.timeouts.forEach((t) => clearTimeout(t));
					this.timeouts.clear();
					this.cancellations.forEach((c) => {
						c.cancel();
						c.dispose();
					});
					this.cancellations.clear();
					this.disposeDecorationTypes();
					if (FileHeatmap.instance === this) FileHeatmap.instance = null;
				}
			}
		];
		if (typeof onDidChangeConfiguration === 'function') {
			disposables.push(onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('git-map.heatmap') || e.affectsConfiguration('git-map.blame')) {
					this.rebuildDecorationTypes();
					refreshAll();
				}
			}));
		}
		if (typeof onDidChangeGitState === 'function') {
			disposables.push(onDidChangeGitState(refreshAll));
		}
		this.registerDisposables(...disposables);
	}

	public static getInstance(): FileHeatmap | null {
		return FileHeatmap.instance;
	}

	public isActiveForUri(uri: vscode.Uri): boolean {
		return this.modeOverride === true || this.windowEnabled || this.files.has(uri.toString());
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

	private disposeDecorationTypes() {
		if (this.decorationTypes === null) return;
		this.clearAllDecorationsOnly();
		this.decorationTypes.hot.forEach((d) => d.dispose());
		this.decorationTypes.cold.forEach((d) => d.dispose());
		this.decorationTypes = null;
	}

	private clearAllDecorationsOnly() {
		if (this.decorationTypes === null) return;
		vscode.window.visibleTextEditors.forEach((ed) => {
			this.decorationTypes!.hot.forEach((d) => ed.setDecorations(d, []));
			this.decorationTypes!.cold.forEach((d) => ed.setDecorations(d, []));
		});
	}

	private rebuildDecorationTypes() {
		this.disposeDecorationTypes();
		const cfg = getConfig().fileHeatmapConfig;
		const useGutter = cfg.locations.includes('gutter');
		const useLine = cfg.locations.includes('line');
		const useRuler = cfg.locations.includes('overviewRuler');

		const buildScale = (baseColor: string, isHot: boolean) => {
			const arr: vscode.TextEditorDecorationType[] = [];
			for (let i = 0; i < BUCKET_COUNT; i++) {
				const intensity = (i + 1) / BUCKET_COUNT;
				const borderColor = hexToRgba(baseColor, 0.28 + 0.72 * intensity);
				const bgColor = hexToRgba(baseColor, 0.04 + 0.14 * intensity);
				const opts: vscode.DecorationRenderOptions = {
					isWholeLine: true
				};
				if (useGutter) {
					opts.borderWidth = '0 0 0 3px';
					opts.borderStyle = 'solid';
					opts.borderColor = borderColor;
				}
				if (useLine) {
					opts.backgroundColor = bgColor;
				}
				if (useRuler) {
					opts.overviewRulerColor = borderColor;
					opts.overviewRulerLane = vscode.OverviewRulerLane.Right;
				}
				if (!isHot && cfg.fadeLines && i <= 1) {
					opts.opacity = i === 0 ? '0.68' : '0.82';
				}
				arr.push(vscode.window.createTextEditorDecorationType(opts));
			}
			return arr;
		};

		this.decorationTypes = {
			hot: buildScale(cfg.hotColor, true),
			cold: buildScale(cfg.coldColor, false)
		};
	}

	public async toggle(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const cfg = getConfig().fileHeatmapConfig;
		if (cfg.toggleMode === 'window') {
			this.windowEnabled = !this.windowEnabled;
			if (!this.windowEnabled) {
				this.clearAll();
			} else if (editor && editor.document.uri.scheme === 'file') {
				await this.computeAndApply(editor.document);
			}
			return;
		}

		if (typeof editor === 'undefined' || editor.document.uri.scheme !== 'file') {
			showErrorMessage(t('Unable to Toggle File Heatmap: {0}', t('Open a file in an editor.')));
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
			showErrorMessage(t('Unable to Toggle File Heatmap: {0}', t('The file {0} isn\'t in a repository known by Git Map.', filePath)));
			return;
		}
		this.files.set(key, { repo: file.repo, filePath: file.path, blame: null });
		if (cfg.dismissOnEscape) {
			const uri = doc.uri;
			EscapeStack.push('fileHeatmap:' + key, () => this.files.has(key) && !!vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.toString() === key, () => this.closeUri(uri));
		}
		if (!await this.computeAndApply(doc)) {
			this.closeUri(doc.uri);
			showErrorMessage(t('Unable to Toggle File Heatmap: {0}', t('The file {0} isn\'t tracked by Git.', filePath)));
		}
	}

	private clearAll() {
		this.files.clear();
		this.timeouts.forEach((t) => clearTimeout(t));
		this.timeouts.clear();
		this.cancellations.forEach((c) => {
			c.cancel();
			c.dispose();
		});
		this.cancellations.clear();
		this.clearAllDecorationsOnly();
		this.updateContext();
	}

	private closeUri(uri: vscode.Uri) {
		const key = uri.toString();
		const timer = this.timeouts.get(key);
		if (typeof timer !== 'undefined') clearTimeout(timer);
		this.timeouts.delete(key);
		const cancel = this.cancellations.get(key);
		if (typeof cancel !== 'undefined') {
			cancel.cancel();
			cancel.dispose();
			this.cancellations.delete(key);
		}
		EscapeStack.remove('fileHeatmap:' + key);
		this.files.delete(key);
		if (this.decorationTypes !== null) {
			vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === key).forEach((ed) => {
				this.decorationTypes!.hot.forEach((d) => ed.setDecorations(d, []));
				this.decorationTypes!.cold.forEach((d) => ed.setDecorations(d, []));
			});
		}
		this.updateContext();
	}

	private scheduleCompute(document: vscode.TextDocument) {
		const key = document.uri.toString();
		const blameCfg = getConfig().fileBlameConfig;
		if (document.isDirty && blameCfg.sizeThresholdAfterEdit > 0 && document.lineCount > blameCfg.sizeThresholdAfterEdit) {
			return;
		}
		const prev = this.timeouts.get(key);
		if (typeof prev !== 'undefined') clearTimeout(prev);
		const delay = document.isDirty ? blameCfg.delayAfterEdit : 400;
		const timer = setTimeout(() => {
			this.timeouts.delete(key);
			void this.computeAndApply(document);
		}, delay);
		if (typeof timer.unref === 'function') timer.unref();
		this.timeouts.set(key, timer);
	}

	private async computeAndApply(document: vscode.TextDocument): Promise<boolean> {
		if (!this.shouldAnnotateDocument(document)) return false;
		const key = document.uri.toString();
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(document.uri));
		if (file === null) return false;
		const prevCancel = this.cancellations.get(key);
		if (typeof prevCancel !== 'undefined') {
			prevCancel.cancel();
			prevCancel.dispose();
		}
		const cancellation = new vscode.CancellationTokenSource();
		this.cancellations.set(key, cancellation);
		const version = document.version;
		try {
			const blame = await this.dataSource.getFileBlame(file.repo, file.path, document.isDirty ? document.getText() : null, cancellation.token);
			if (cancellation.token.isCancellationRequested || document.version !== version) return true;
			if (blame === null) return false;
			this.files.set(key, { repo: file.repo, filePath: file.path, blame: blame });
			vscode.window.visibleTextEditors
				.filter((ed) => ed.document.uri.toString() === key)
				.forEach((ed) => this.applyToEditor(ed, blame));
			this.updateContext();
			return true;
		} catch (err) {
			this.logger.logError('Unable to compute file heatmap: ' + err);
			return false;
		} finally {
			cancellation.dispose();
			if (this.cancellations.get(key) === cancellation) this.cancellations.delete(key);
		}
	}

	private applyToEditor(editor: vscode.TextEditor, blame: GitFileBlame) {
		if (this.decorationTypes === null) return;
		const cfg = getConfig().fileHeatmapConfig;
		const nowSec = Math.floor(Date.now() / 1000);
		const hotRanges: vscode.DecorationOptions[][] = Array.from({ length: BUCKET_COUNT }, () => []);
		const coldRanges: vscode.DecorationOptions[][] = Array.from({ length: BUCKET_COUNT }, () => []);
		const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';

		blame.lines.forEach((lineInfo, idx) => {
			if (!lineInfo || idx >= editor.document.lineCount) return;
			const commit = blame.commits[lineInfo.hash];
			if (!commit) return;
			const dateSec = commit.committed ? commit.authorDate : nowSec;
			const bucket = computeHeatBucket(dateSec, nowSec, cfg.ageThreshold);
			const hoverMsg = commit.committed
				? commit.author + ' · ' + new Date(commit.authorDate * 1000).toLocaleDateString(locale) + ' — ' + commit.summary
				: t('You, Uncommitted changes');
			const option: vscode.DecorationOptions = {
				range: new vscode.Range(idx, 0, idx, 0),
				hoverMessage: hoverMsg
			};
			if (bucket.isHot) {
				hotRanges[bucket.level].push(option);
			} else {
				coldRanges[bucket.level].push(option);
			}
		});

		for (let i = 0; i < BUCKET_COUNT; i++) {
			editor.setDecorations(this.decorationTypes.hot[i], hotRanges[i]);
			editor.setDecorations(this.decorationTypes.cold[i], coldRanges[i]);
		}
	}

	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:fileHeatmapShown', this.isWindowOrFileActive());
	}
}
