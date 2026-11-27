import * as vscode from 'vscode';
import { applyAutolinksToMarkdown } from './autolinks';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { getCachedRepoPullRequestBadges } from './prStatusIntegration';
import { RepoManager } from './repoManager';
import { AutolinkRule, BlameStatusBarCommand, GitLineBlame } from './types';
import { abbrevCommit, formatDatePattern, getPathFromUri, getRelativeTimeDiff } from './utils';
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
 * The extra idle time (in milliseconds) after showing the inline blame before running `git log -L` for the hover diff, so stepping quickly
 * across lines doesn't spawn `git log -L` on every intermediate line.
 */
const HOVER_DIFF_DELAY = 300;
const MAX_LINE_CACHE_ENTRIES = 64;
const MAX_DIFF_CACHE_ENTRIES = 128;

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
	private decorationType: vscode.TextEditorDecorationType;
	private statusBarItem: vscode.StatusBarItem;
	private statusBarAlignment: 'left' | 'right' = 'left';
	private readonly lineCache = new Map<string, { readonly blame: GitLineBlame | null, readonly time: number }>();
	private readonly diffCache = new Map<string, ReadonlyArray<string> | null>();
	private enabled: boolean; // Is the blame of the current line shown (at the end of the line, or in the Status Bar)
	private inline: boolean; // Is it shown at the end of the line (git-map.blame.currentLine)
	private statusBar: boolean; // Is it shown in the Status Bar (git-map.blame.statusBar)
	private modeOverride: { inline?: boolean, statusBar?: boolean, hovers?: boolean } | null = null;
	private timeout: NodeJS.Timeout | null = null;
	private hoverDiffTimeout: NodeJS.Timeout | null = null;
	private cancellation: vscode.CancellationTokenSource | null = null;
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
	 * @param onDidChangeGitState Optional Event emitting when HEAD, the index, or refs change in a repository.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger, onDidChangeGitState?: Event<void>) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		const config = getConfig();
		this.inline = config.blameCurrentLine;
		this.statusBar = config.blameStatusBar;
		this.enabled = this.inline || this.statusBar;
		this.statusBarAlignment = config.blameStatusBarAlignment;
		this.statusBarItem = vscode.window.createStatusBarItem(
			'git-map.blame',
			this.statusBarAlignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
			0
		);
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
			{
				dispose: () => {
					this.decorationType.dispose();
					this.statusBarItem.dispose();
				}
			},
			vscode.window.onDidChangeTextEditorSelection((event) => this.schedule(event.textEditor)),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				this.clear(!getConfig().blameStatusBarReduceFlicker);
				if (editor) this.schedule(editor);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// The line numbers may have changed, so the blame is updated once the document stops changing
				if (this.decoratedEditor !== null && this.decoratedEditor.document === event.document) this.schedule(this.decoratedEditor);
			}),
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-map.blame') ||
					event.affectsConfiguration('git-map.hovers') ||
					event.affectsConfiguration('git-map.autolinks') ||
					event.affectsConfiguration('git-map.ui.iconColorStyle') ||
					event.affectsConfiguration('git-map.language')
				) {
					this.applyConfig();
				}
			}),
			...(typeof onDidChangeGitState === 'function' ? [onDidChangeGitState(() => {
				this.lineCache.clear();
				this.lastBlamed = null;
				if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
			})] : []),
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

	public setModeOverride(override: { inline?: boolean, statusBar?: boolean, hovers?: boolean } | null) {
		this.modeOverride = override;
		this.applyConfig();
	}

	private applyConfig() {
		const config = getConfig();
		this.inline = typeof this.modeOverride?.inline === 'boolean' ? this.modeOverride.inline : config.blameCurrentLine;
		this.statusBar = typeof this.modeOverride?.statusBar === 'boolean' ? this.modeOverride.statusBar : config.blameStatusBar;
		this.enabled = this.inline || this.statusBar;
		if (config.blameStatusBarAlignment !== this.statusBarAlignment) {
			this.statusBarAlignment = config.blameStatusBarAlignment;
			this.statusBarItem.dispose();
			this.statusBarItem = vscode.window.createStatusBarItem(
				'git-map.blame',
				this.statusBarAlignment === 'right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left,
				0
			);
			this.statusBarItem.name = t('Git Map: Blame of the Current Line');
		}
		this.lineCache.clear();
		this.clear();
		if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
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
		const reduceFlicker = getConfig().blameStatusBarReduceFlicker;
		if (this.decoratedEditor !== null && this.decoratedEditor.selection.active.line !== editor.selection.active.line) this.clear(!reduceFlicker);
		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.update(editor).catch((error) => this.logger.logError('Unable to blame the current line: ' + error));
		}, BLAME_DELAY);
		if (typeof this.timeout.unref === 'function') this.timeout.unref();
	}

	/**
	 * Cancel the scheduled blame, and ignore the result of a blame that's in progress.
	 */
	private cancel() {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		if (this.hoverDiffTimeout !== null) {
			clearTimeout(this.hoverDiffTimeout);
			this.hoverDiffTimeout = null;
		}
		if (this.cancellation !== null) {
			this.cancellation.cancel();
			this.cancellation.dispose();
			this.cancellation = null;
		}
		this.requestId++;
	}

	/**
	 * Remove the blame from the editor it's shown in.
	 */
	private clear(hideStatusBar: boolean = true) {
		this.lastBlamed = null;
		if (hideStatusBar || !this.statusBar) {
			this.statusBarItem.hide();
			this.statusBarVisible = false;
		}
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
	private showInStatusBar(repo: string, blame: GitLineBlame, uri: vscode.Uri, line: number) {
		const cfg = getConfig(repo);
		const prInfo = cfg.blamePullRequestsEnabled && cfg.blameStatusBarPullRequests ? resolvePrInfoForLineBlame(repo, blame) : null;
		const commitIcon = getConfig().iconColorStyle === 'colorful' ? '$(git-map-commit-color) ' : '$(git-commit) ';
		if (cfg.blameStatusBarFormat !== '${author}, ${agoOrDate}${\' via \'pullRequest}' || cfg.blameDateStyle === 'absolute') {
			this.statusBarItem.text = commitIcon + formatBlameTemplate(cfg.blameStatusBarFormat, blame, prInfo, getBlameDateOptions(repo, cfg.blameStatusBarDateFormat));
		} else {
			const baseText = blame.committed ? t('{0}, {1}', blame.author, getRelativeTimeDiff(blame.authorDate)) : t('You, Uncommitted changes');
			this.statusBarItem.text = commitIcon + baseText + (prInfo !== null ? ' via PR #' + prInfo.number : '');
		}
		this.statusBarItem.tooltip = blame.committed && cfg.blameStatusBarTooltipFormat !== ''
			? new vscode.MarkdownString(formatBlameTemplate(cfg.blameStatusBarTooltipFormat, blame, prInfo, getBlameDateOptions(repo, cfg.blameStatusBarDateFormat)), true)
			: blame.committed
				? abbrevCommit(blame.hash) + ' · ' + blame.author + ' · ' + blame.summary + (prInfo !== null ? ' (PR #' + prInfo.number + ')' : '')
				: t('This line has uncommitted changes.');
		this.statusBarItem.command = getStatusBarCommand(cfg.blameStatusBarCommand, repo, blame, uri, line);
		this.statusBarItem.color = undefined;
		this.statusBarItem.backgroundColor = undefined;
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
		const line = editor.selection.active.line, version = document.version, requestId = ++this.requestId;
		const cancellation = this.cancellation = new vscode.CancellationTokenSource();
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(document.uri));
		if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
		if (file === null) {
			this.clear();
			return;
		}
		const repo = file.repo;
		const blamed = () => this.lastBlamed = { editor: editor, line: line, version: version, time: Date.now() };
		const cacheKey = document.uri.toString() + '\n' + version + '\n' + line;
		const cachedLine = this.lineCache.get(cacheKey);
		let blame: GitLineBlame | null;
		if (typeof cachedLine !== 'undefined' && Date.now() - cachedLine.time < BLAME_CACHE_DURATION) {
			blame = cachedLine.blame;
		} else {
			blame = await this.dataSource.getLineBlame(repo, file.path, line + 1, document.isDirty ? document.getText() : null, cancellation.token);
			if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
			if (this.lineCache.size >= MAX_LINE_CACHE_ENTRIES) {
				const oldestKey = this.lineCache.keys().next().value;
				if (typeof oldestKey === 'string') this.lineCache.delete(oldestKey);
			}
			this.lineCache.set(cacheKey, { blame: blame, time: Date.now() });
		}
		this.clear();
		if (blame === null) {
			// The line can't be blamed (e.g. the file isn't tracked), which is also remembered
			blamed();
			return;
		}

		if (this.statusBar) this.showInStatusBar(repo, blame, document.uri, line + 1);
		this.decoratedEditor = editor;
		this.decoratedLine = line;
		if (!this.inline) {
			blamed();
			return;
		}
		const lineRange = document.lineAt(line).range;
		const end = lineRange.end;
		const repoCfg = getConfig(repo);
		const hoverCfg = repoCfg.hoversConfig;
		const hoversAllowed = typeof this.modeOverride?.hovers === 'boolean' ? this.modeOverride.hovers : (hoverCfg.enabled && hoverCfg.currentLineEnabled);
		const prInfo = repoCfg.blamePullRequestsEnabled ? resolvePrInfoForLineBlame(repo, blame) : null;
		const inlineText = getBlameText(blame, {
			inlineFormat: repoCfg.blameInlineFormat,
			uncommittedFormat: repoCfg.blameUncommittedFormat,
			prInfo: prInfo,
			dates: getBlameDateOptions(repo, repoCfg.blameCurrentLineDateFormat),
			useUncommittedFormat: repoCfg.blameUseUncommittedFormat
		});
		const decRange = hoverCfg.currentLineOver === 'line' && hoversAllowed ? lineRange : new vscode.Range(end, end);
		const decorate = (change: ReadonlyArray<string> | null) => {
			if (repoCfg.blameScrollable) {
				editor.setDecorations(this.decorationType, [{
					range: decRange,
					hoverMessage: hoversAllowed
						? getBlameHover(repo, blame!, document.uri, line + 1, change, {
							includeDetails: hoverCfg.currentLineDetails,
							includeChanges: hoverCfg.currentLineChanges,
							autolinks: hoverCfg.autolinksEnabled ? repoCfg.autolinks : [],
							prInfo: hoverCfg.pullRequestsEnabled ? prInfo : null
						})
						: undefined,
					renderOptions: { after: { contentText: inlineText } }
				}]);
			} else {
				editor.setDecorations(this.decorationType, [{
					range: new vscode.Range(end, end),
					hoverMessage: hoversAllowed
						? getBlameHover(repo, blame!, document.uri, line + 1, change, {
							includeDetails: hoverCfg.currentLineDetails,
							includeChanges: hoverCfg.currentLineChanges,
							autolinks: hoverCfg.autolinksEnabled ? repoCfg.autolinks : [],
							prInfo: hoverCfg.pullRequestsEnabled ? prInfo : null
						})
						: undefined,
					renderOptions: { after: { contentText: inlineText } }
				}]);
			}
		};

		// The hover also shows how the commit changed the line, once it has been loaded
		if (!blame.committed) {
			decorate(null);
			blamed();
			return;
		}
		const diffKey = repo + '\n' + blame.hash + '\n' + blame.originalFilePath + '\n' + blame.originalLine;
		if (this.diffCache.has(diffKey)) {
			decorate(this.diffCache.get(diffKey) || null);
			blamed();
			return;
		}
		decorate(null);
		blamed();
		const committedBlame = blame;
		this.hoverDiffTimeout = setTimeout(async () => {
			this.hoverDiffTimeout = null;
			if (requestId !== this.requestId || cancellation.token.isCancellationRequested) return;
			const change = await this.dataSource.getLineChange(repo, committedBlame.hash, committedBlame.originalFilePath, committedBlame.originalLine, cancellation.token);
			if (requestId !== this.requestId || cancellation.token.isCancellationRequested || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line || this.decoratedEditor !== editor) return;
			const diff = change !== null ? change.diff : null;
			if (this.diffCache.size >= MAX_DIFF_CACHE_ENTRIES) {
				const oldestKey = this.diffCache.keys().next().value;
				if (typeof oldestKey === 'string') this.diffCache.delete(oldestKey);
			}
			this.diffCache.set(diffKey, diff);
			if (diff !== null) decorate(diff);
		}, HOVER_DIFF_DELAY);
	}
}

export interface BlamePrInfo {
	readonly number: number;
	readonly title?: string;
	readonly url?: string;
}

/**
 * Resolve associated Pull Request info from commit message references (`#N`, `Merge pull request #N`) or cached PR badges.
 */
export function resolvePrInfoForLineBlame(repo: string, blame: GitLineBlame): BlamePrInfo | null {
	if (!blame.committed) return null;
	const cached = getCachedRepoPullRequestBadges(repo);
	const m = blame.summary.match(/(?:Merge pull request |PR )?#(\d+)\b/i) || blame.summary.match(/\(#(\d+)\)/);
	if (m !== null) {
		const num = parseInt(m[1], 10);
		if (cached !== null) {
			const matchBadge = Object.values(cached).find((b) => b.number === num);
			if (matchBadge) return { number: matchBadge.number, title: matchBadge.title, url: matchBadge.url };
		}
		return { number: num };
	}
	return null;
}

/**
 * Get the command run when the blame in the Status Bar is clicked (`git-map.blame.statusBar.command`).
 * @param kind What clicking it does.
 * @param repo The repository of the file.
 * @param blame The blame of the line.
 * @param uri The URI of the file.
 * @param line The line (1-based).
 */
export function getStatusBarCommand(kind: BlameStatusBarCommand, repo: string, blame: GitLineBlame, uri: vscode.Uri, line: number): vscode.Command {
	if (blame.committed) {
		switch (kind) {
			case 'inspect': return { title: t('Inspect Commit Details'), command: 'git-map.inspect', arguments: [repo, blame.hash] };
			case 'viewCommitInGitMap': return { title: t('View Commit in Git Map'), command: 'git-map.viewCommitInGitMap', arguments: [repo, blame.hash] };
			case 'openLineChanges': return { title: t('Open Changes'), command: 'git-map.openLineChanges', arguments: [repo, blame.hash, blame.originalFilePath, blame.originalLine] };
		}
	}
	switch (kind) {
		case 'toggleFileBlame': return { title: t('Toggle File Blame'), command: 'git-map.toggleFileBlame', arguments: [uri] };
		case 'toggleFileHeatmap': return { title: t('Toggle File Heatmap'), command: 'git-map.toggleFileHeatmap', arguments: [] };
		case 'toggleFileChanges': return { title: t('Toggle File Changes'), command: 'git-map.toggleFileChanges', arguments: [] };
		case 'toggleCodeLens': return { title: t('Toggle Git CodeLens'), command: 'git-map.toggleCodeLens', arguments: [] };
		case 'viewFileHistory': return { title: t('View File History in Git Map'), command: 'git-map.viewFileHistory', arguments: [uri] };
	}
	return { title: t('View Line History'), command: 'git-map.viewLineHistory', arguments: [{ uri: uri.toString(), start: line, end: line }] };
}

/**
 * Format a blame annotation string from a customizable token template (`${author}`, `${agoOrDate}`, `${' via 'pullRequest}`, `${ • summary|60?}`, etc.).
 */
export function formatBlameTemplate(template: string, blame: GitLineBlame, prInfo: BlamePrInfo | null, dates?: BlameDateOptions): string {
	if (!blame.committed) {
		const ago = t('just now');
		return template
			.replace(/\$\{agoOrDate\}/g, ago)
			.replace(/\$\{ago\}/g, ago)
			.replace(/\$\{date\}/g, ago)
			.replace(/\$\{author([^}]*)\}/g, (_, suffix: string) => t('You') + (suffix || ''))
			.replace(/\$\{sha\}/g, '')
			.replace(/\$\{[^}]+\}/g, '')
			.trim();
	}
	const ago = getRelativeTimeDiff(blame.authorDate);
	const absDate = typeof dates !== 'undefined' ? formatDatePattern(blame.authorDate, dates.format, dates.locale || '') : new Date(blame.authorDate * 1000).toLocaleDateString(getLanguage() === 'zh-cn' ? 'zh-CN' : 'en');
	const agoOrDate = typeof dates !== 'undefined' && dates.style === 'absolute' ? absDate : ago;
	const prText = prInfo !== null ? ('PR #' + prInfo.number) : '';

	const resolveToken = (expr: string): string => {
		// `token|N?` truncates the value to N characters, `token|N-` truncates it and pads it with spaces to N characters
		const truncMatch = expr.match(/^([A-Za-z]+)\|(\d+)([?-]?)$/);
		const tokenName = truncMatch ? truncMatch[1] : expr.replace(/\?$/, '');
		const maxLen = truncMatch ? parseInt(truncMatch[2], 10) : 0, pad = truncMatch !== null && truncMatch[3] === '-';
		let val = '';
		switch (tokenName) {
			case 'author': val = blame.author; break;
			case 'ago': val = ago; break;
			case 'date': val = absDate; break;
			case 'agoOrDate': val = agoOrDate; break;
			case 'summary':
			case 'message': val = blame.summary; break;
			case 'sha': val = abbrevCommit(blame.hash); break;
			case 'pullRequest': val = prText; break;
			default: val = '';
		}
		if (maxLen > 0 && val.length > maxLen) {
			val = val.substring(0, Math.max(1, maxLen - 1)) + '…';
		}
		if (pad && val.length < maxLen) val = val + '\u00a0'.repeat(maxLen - val.length);
		return val;
	};

	return template.replace(/\$\{([^}]+)\}/g, (_, inner: string) => {
		// A token, truncated (`|N?`) or padded (`|N-`) to a width
		if (/^[A-Za-z]+\|\d+[?-]?$/.test(inner)) return resolveToken(inner);
		// Handle conditional literal prefixes like `' via 'pullRequest` or ` • summary|60?`
		const quoted = inner.match(/^'([^']*)'([A-Za-z0-9|?-]+)$/);
		if (quoted !== null) {
			const v = resolveToken(quoted[2]);
			return v !== '' ? quoted[1] + v : '';
		}
		const spaced = inner.match(/^(\s+[^A-Za-z\s]+\s+)([A-Za-z0-9|?-]+)$/);
		if (spaced !== null) {
			const v = resolveToken(spaced[2]);
			return v !== '' ? spaced[1] + v : '';
		}
		const trailingSuffix = inner.match(/^([A-Za-z0-9|?]+)([^A-Za-z0-9|?]+)$/);
		if (trailingSuffix !== null) {
			const v = resolveToken(trailingSuffix[1]);
			return v !== '' ? v + trailingSuffix[2] : '';
		}
		return resolveToken(inner);
	}).replace(/ {2,}/g, ' ').trim();
}

/**
 * How the dates of blame annotations are shown: the style of `${agoOrDate}`, and the format of `${date}` (empty => the short date).
 */
export interface BlameDateOptions {
	readonly style: 'relative' | 'absolute';
	readonly format: string;
	readonly locale?: string; // `git-map.defaultDateLocale`
}

/**
 * Get how the dates of an annotation are shown, from its own date format & the default date settings.
 * @param repo The repository (for its settings).
 * @param format The date format of the annotation (empty => the default date format, then the default short date format).
 */
export function getBlameDateOptions(repo: string, format: string): BlameDateOptions {
	const cfg = getConfig(repo);
	return { style: cfg.blameDateStyle, format: format !== '' ? format : cfg.defaultDateFormat !== '' ? cfg.defaultDateFormat : cfg.defaultDateShortFormat, locale: cfg.defaultDateLocale };
}

export interface BlameTextOptions {
	readonly inlineFormat?: string;
	readonly uncommittedFormat?: string;
	readonly dates?: BlameDateOptions;
	readonly useUncommittedFormat?: boolean; // Use `uncommittedFormat` (otherwise the default text)
	readonly prInfo?: BlamePrInfo | null;
}

/**
 * Get the text of the blame of a line, shown at the end of the line.
 * @param blame The blame of the line.
 * @param options Optional formatting & PR metadata overrides.
 * @returns The text.
 */
export function getBlameText(blame: GitLineBlame, options?: BlameTextOptions) {
	if (!blame.committed) {
		if (options && options.useUncommittedFormat !== false && typeof options.uncommittedFormat === 'string' && options.uncommittedFormat !== 'You, Uncommitted changes (${ago})') {
			return formatBlameTemplate(options.uncommittedFormat, blame, null);
		}
		return t('You, Uncommitted changes');
	}
	if (options && typeof options.inlineFormat === 'string' && (options.inlineFormat !== '${author}, ${agoOrDate}${\' via \'pullRequest}${ • summary|60?}' || (typeof options.dates !== 'undefined' && options.dates.style === 'absolute'))) {
		return formatBlameTemplate(options.inlineFormat, blame, options.prInfo || null, options.dates);
	}
	const summary = blame.summary.length > 60 ? blame.summary.substring(0, 59) + '…' : blame.summary;
	const base = t('{0}, {1} • {2}', blame.author, getRelativeTimeDiff(blame.authorDate), summary);
	return options && options.prInfo ? base + ' · PR #' + options.prInfo.number : base;
}

/**
 * The maximum number of lines of the diff shown in the hover of the blame of a line.
 */
const MAX_HOVER_DIFF_LINES = 12;

export interface BlameHoverOptions {
	readonly includeDetails?: boolean;
	readonly includeChanges?: boolean;
	readonly autolinks?: ReadonlyArray<AutolinkRule>;
	readonly prInfo?: BlamePrInfo | null;
}

/**
 * Get the hover of the blame of a line: the commit, how it changed the line, and links to view the history of the line, open the changes,
 * view the commit in the Git Map View, and copy a link to the line on the remote.
 * @param repo The repository containing the line.
 * @param blame The blame of the line.
 * @param uri The file.
 * @param line The line (1-based) in the editor.
 * @param change The diff of the line in the commit, or NULL if it hasn't been loaded.
 * @param options Optional hover display configuration.
 * @returns The hover.
 */
export function getBlameHover(repo: string, blame: GitLineBlame, uri: vscode.Uri, line: number, change: ReadonlyArray<string> | null, options?: BlameHoverOptions) {
	const hover = new vscode.MarkdownString(undefined, true);
	const args = (value: any[]) => encodeURIComponent(JSON.stringify(value)).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
	const lineHistoryLink = '[$(history) ' + t('View Line History') + '](command:git-map.viewLineHistory?' + args([{ uri: uri.toString(), start: line, end: line }]) + ')';
	hover.isTrusted = { enabledCommands: ['git-map.viewCommitInGitMap', 'git-map.viewLineHistory', 'git-map.openLineChanges', 'git-map.copyRemoteLink'] };
	if (!blame.committed) {
		hover.appendText(t('This line has uncommitted changes.'));
		hover.appendMarkdown('\n\n' + lineHistoryLink);
		return hover;
	}
	const includeDetails = !options || options.includeDetails !== false;
	const includeChanges = !options || options.includeChanges !== false;
	if (includeDetails) {
		hover.appendMarkdown('$(git-commit) **' + abbrevCommit(blame.hash) + '** · ');
		hover.appendText(blame.author + ' <' + blame.authorEmail + '> · ' + new Date(blame.authorDate * 1000).toLocaleString(getLanguage() === 'zh-cn' ? 'zh-CN' : 'en'));
		if (options && options.prInfo) {
			const prLabel = 'PR #' + options.prInfo.number;
			if (typeof options.prInfo.url === 'string' && /^https?:\/\//i.test(options.prInfo.url)) {
				hover.appendMarkdown(' · [$(git-pull-request) ' + prLabel + '](' + options.prInfo.url + ')');
			} else {
				hover.appendText(' · ' + prLabel);
			}
		}
		hover.appendMarkdown('\n\n');
		const autolinks = options && Array.isArray(options.autolinks) ? options.autolinks : [];
		if (autolinks.length > 0) {
			hover.appendMarkdown(applyAutolinksToMarkdown(blame.summary, autolinks));
		} else {
			hover.appendText(blame.summary);
		}
	}
	if (includeChanges && change !== null && change.length > 0) {
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
