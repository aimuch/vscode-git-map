import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { t } from './l10n';
import { RepoManager } from './repoManager';
import { GitFileBlame } from './types';
import { getPathFromUri, getRelativeTimeDiff } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * The depth of the symbols that have a CodeLens (e.g. classes, and their methods).
 */
const MAX_SYMBOL_DEPTH = 2;

/**
 * Shows a CodeLens above functions, methods & classes (the `git-map.codeLens.enabled` Extension Setting, off by default): who changed them
 * most recently and when, and how many authors changed them. Clicking it shows the history of their lines.
 */
export class GitCodeLens extends Disposable implements vscode.CodeLensProvider {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
	private readonly blames = new Map<string, { version: number, blame: Promise<GitFileBlame | null> }>(); // The blame of each document, by its URI
	private registration: vscode.Disposable | null = null; // The registration of the provider (NULL => the Git CodeLens is disabled)
	private windowOverride: boolean | null = null;
	private modeOverride: boolean | null = null;
	public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

	/**
	 * Creates the Git CodeLens.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param onDidChangeConfiguration The Event emitting when the configuration changes.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitState?: Event<void>) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		const refresh = () => {
			if (this.registration !== null) {
				this.blames.clear();
				this.onDidChangeCodeLensesEmitter.fire();
			}
		};
		this.registerDisposables(
			this.onDidChangeCodeLensesEmitter,
			vscode.commands.registerCommand('git-map.toggleCodeLens', () => {
				const currently = this.isEnabled();
				this.windowOverride = !currently;
				this.updateRegistration();
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.codeLens')) {
					this.updateRegistration();
					refresh();
				} else if (event.affectsConfiguration('git-map.blame.ignoreWhitespace') || event.affectsConfiguration('git-map.blame.ignoreRevsFile') || event.affectsConfiguration('git-map.language')) {
					refresh();
				}
			}),
			...(typeof onDidChangeGitState === 'function' ? [onDidChangeGitState(refresh)] : []),
			vscode.workspace.onDidCloseTextDocument((document) => this.blames.delete(document.uri.toString())),
			{
				dispose: () => {
					if (this.registration !== null) this.registration.dispose();
				}
			}
		);
		this.updateRegistration();
	}

	public setModeOverride(enabled: boolean | null) {
		this.modeOverride = enabled;
		this.updateRegistration();
	}

	private isEnabled(): boolean {
		if (this.modeOverride !== null) return this.modeOverride;
		if (this.windowOverride !== null) return this.windowOverride;
		return getConfig().codeLensEnabled;
	}

	/**
	 * Register the provider while the Git CodeLens is enabled (it's off by default), so that Visual Studio Code doesn't ask for the
	 * CodeLenses of every document when it's disabled.
	 */
	private updateRegistration() {
		const enabled = this.isEnabled();
		if (enabled && this.registration === null) {
			this.registration = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this);
		} else if (!enabled && this.registration !== null) {
			this.registration.dispose();
			this.registration = null;
			this.blames.clear();
		} else if (enabled && this.registration !== null) {
			this.onDidChangeCodeLensesEmitter.fire();
		}
	}

	/**
	 * Get the CodeLenses of a document (Visual Studio Code calls this).
	 * @param document The document.
	 * @param token The cancellation token.
	 * @returns The CodeLenses.
	 */
	public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		if (!this.isEnabled()) return [];
		const file = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(document.uri));
		if (token.isCancellationRequested || file === null) return [];
		const lensCfg = getConfig(file.repo).codeLensConfig;
		if (!lensCfg.recentChangeEnabled && !lensCfg.authorsEnabled) return [];

		const targetRanges: vscode.Range[] = [];
		if (lensCfg.scopes.includes('document')) {
			targetRanges.push(new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0));
		}
		if (lensCfg.scopes.includes('containers') || lensCfg.scopes.includes('blocks')) {
			const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', document.uri);
			if (token.isCancellationRequested) return [];
			if (typeof symbols !== 'undefined' && symbols.length > 0) {
				targetRanges.push(...getSymbolRanges(symbols, 1, lensCfg.scopes, lensCfg.includeSingleLineSymbols));
			}
		}
		if (targetRanges.length === 0) return [];
		const blame = await this.getBlame(document, file.repo, file.path, token);
		if (token.isCancellationRequested || blame === null) return [];

		const lenses: vscode.CodeLens[] = [];
		const makeAction = (cmdType: 'openLineHistory' | 'toggleFileBlame' | 'viewCommit', start: number, end: number, commitHash: string | null) => {
			if (cmdType === 'toggleFileBlame') {
				return { command: 'git-map.toggleFileBlame', arguments: [] };
			}
			if (cmdType === 'viewCommit' && commitHash !== null) {
				return { command: 'git-map.viewCommitInGitMap', arguments: [file.repo, commitHash] };
			}
			return { command: 'git-map.viewLineHistory', arguments: [{ uri: document.uri, start: start + 1, end: end + 1 }] };
		};

		for (let i = 0; i < targetRanges.length; i++) {
			const range = targetRanges[i];
			const summary = analyzeRangeBlame(blame, range.start.line, range.end.line);
			if (summary === null) continue;
			const anchorRange = new vscode.Range(range.start.line, 0, range.start.line, 0);
			if (lensCfg.recentChangeEnabled && lensCfg.authorsEnabled && lensCfg.recentChangeCommand === lensCfg.authorsCommand) {
				const act = makeAction(lensCfg.recentChangeCommand, range.start.line, range.end.line, summary.latestHash);
				lenses.push(new vscode.CodeLens(anchorRange, {
					title: summary.recentText + (summary.authorsText !== '' ? ' · ' + summary.authorsText : ''),
					tooltip: t('View the history of these lines'),
					command: act.command,
					arguments: act.arguments
				}));
				continue;
			}
			if (lensCfg.recentChangeEnabled) {
				const act = makeAction(lensCfg.recentChangeCommand, range.start.line, range.end.line, summary.latestHash);
				lenses.push(new vscode.CodeLens(anchorRange, {
					title: summary.recentText,
					tooltip: t('View recent change details'),
					command: act.command,
					arguments: act.arguments
				}));
			}
			if (lensCfg.authorsEnabled && summary.authorsText !== '') {
				const act = makeAction(lensCfg.authorsCommand, range.start.line, range.end.line, summary.latestHash);
				lenses.push(new vscode.CodeLens(anchorRange, {
					title: summary.authorsText,
					tooltip: summary.topAuthor !== '' ? summary.topAuthor + ' — ' + t('View authors or file blame') : t('View authors or file blame'),
					command: act.command,
					arguments: act.arguments
				}));
			}
		}
		return lenses;
	}

	/**
	 * Get the blame of a document (blamed once for each version of the document).
	 * @param document The document.
	 * @param repo The repository containing the document's file.
	 * @param filePath The path of the file (relative to the repository).
	 * @param token The cancellation token.
	 * @returns The blame, or NULL if the file couldn't be blamed (e.g. it isn't tracked).
	 */
	private getBlame(document: vscode.TextDocument, repo: string, filePath: string, token: vscode.CancellationToken) {
		const key = document.uri.toString(), cached = this.blames.get(key);
		if (typeof cached !== 'undefined' && cached.version === document.version) return cached.blame;
		const version = document.version;
		const blame = this.dataSource.getFileBlame(repo, filePath, document.isDirty ? document.getText() : null, token).then((result) => {
			if (token.isCancellationRequested && this.blames.get(key)?.blame === blame) this.blames.delete(key);
			return result;
		});
		this.blames.set(key, { version: version, blame: blame });
		return blame;
	}
}

const CONTAINER_KINDS = [vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct];
const BLOCK_KINDS = [vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor];

/**
 * Get the ranges of the symbols that have a CodeLens.
 * @param symbols The symbols of a document (hierarchical, or flat).
 * @param depth The depth of the symbols.
 * @param scopes Active CodeLens scopes.
 * @param includeSingleLine Whether single-line symbols receive CodeLenses.
 * @returns The ranges.
 */
function getSymbolRanges(
	symbols: ReadonlyArray<vscode.DocumentSymbol | vscode.SymbolInformation>,
	depth: number,
	scopes: ReadonlyArray<'document' | 'containers' | 'blocks'> = ['containers', 'blocks'],
	includeSingleLine: boolean = false
): vscode.Range[] {
	const ranges: vscode.Range[] = [];
	const allowContainers = scopes.includes('containers');
	const allowBlocks = scopes.includes('blocks');
	symbols.forEach((symbol) => {
		const isContainer = CONTAINER_KINDS.includes(symbol.kind);
		const isBlock = BLOCK_KINDS.includes(symbol.kind);
		if ((isContainer && allowContainers) || (isBlock && allowBlocks)) {
			const range = symbol instanceof vscode.SymbolInformation ? symbol.location.range : symbol.range;
			if (includeSingleLine || !range.isSingleLine) {
				ranges.push(range);
			}
		}
		if ('children' in symbol && depth < MAX_SYMBOL_DEPTH) ranges.push(...getSymbolRanges(symbol.children, depth + 1, scopes, includeSingleLine));
	});
	return ranges;
}

function analyzeRangeBlame(blame: GitFileBlame, start: number, end: number): { recentText: string, authorsText: string, topAuthor: string, latestHash: string | null } | null {
	const authorCounts = new Map<string, number>();
	let latest: string | null = null, uncommitted = false;
	for (let i = start; i <= end && i < blame.lines.length; i++) {
		const line = blame.lines[i];
		if (typeof line === 'undefined') continue;
		const commit = blame.commits[line.hash];
		if (!commit.committed) {
			uncommitted = true;
			continue;
		}
		const authorKey = commit.author || commit.authorEmail;
		authorCounts.set(authorKey, (authorCounts.get(authorKey) || 0) + 1);
		if (latest === null || commit.authorDate > blame.commits[latest].authorDate) latest = line.hash;
	}
	if (latest === null && !uncommitted) return null;
	const recentText = uncommitted || latest === null ? t('You, Uncommitted changes') : blame.commits[latest].author + ', ' + getRelativeTimeDiff(blame.commits[latest].authorDate);
	let authorsText = '';
	let topAuthor = '';
	if (authorCounts.size > 0) {
		topAuthor = Array.from(authorCounts.entries()).sort((a, b) => b[1] - a[1])[0][0];
		authorsText = authorCounts.size === 1 ? t('1 author') : t('{0} authors', authorCounts.size);
	}
	return { recentText: recentText, authorsText: authorsText, topAuthor: topAuthor, latestHash: latest };
}

/**
 * Get the title of the CodeLens of lines: who changed them most recently & when, and how many authors changed them.
 * @param blame The blame of the file.
 * @param start The first line (0-based).
 * @param end The last line (0-based).
 * @returns The title, or NULL if the lines aren't blamed.
 */
export function getCodeLensTitle(blame: GitFileBlame, start: number, end: number) {
	const summary = analyzeRangeBlame(blame, start, end);
	if (summary === null) return null;
	return summary.recentText + (summary.authorsText !== '' ? ' · ' + summary.authorsText : '');
}
