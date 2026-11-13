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
 * The kinds of symbols that have a CodeLens.
 */
const SYMBOL_KINDS = [vscode.SymbolKind.Class, vscode.SymbolKind.Interface, vscode.SymbolKind.Enum, vscode.SymbolKind.Struct, vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor];

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
	public readonly onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

	/**
	 * Creates the Git CodeLens.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param onDidChangeConfiguration The Event emitting when the configuration changes.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.registerDisposables(
			this.onDidChangeCodeLensesEmitter,
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.codeLens.enabled')) this.updateRegistration();
			}),
			vscode.workspace.onDidCloseTextDocument((document) => this.blames.delete(document.uri.toString())),
			{
				dispose: () => {
					if (this.registration !== null) this.registration.dispose();
				}
			}
		);
		this.updateRegistration();
	}

	/**
	 * Register the provider while the Git CodeLens is enabled (it's off by default), so that Visual Studio Code doesn't ask for the
	 * CodeLenses of every document when it's disabled.
	 */
	private updateRegistration() {
		const enabled = getConfig().codeLensEnabled;
		if (enabled && this.registration === null) {
			this.registration = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this);
		} else if (!enabled && this.registration !== null) {
			this.registration.dispose();
			this.registration = null;
			this.blames.clear();
		}
	}

	/**
	 * Get the CodeLenses of a document (Visual Studio Code calls this).
	 * @param document The document.
	 * @param token The cancellation token.
	 * @returns The CodeLenses.
	 */
	public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
		if (!getConfig().codeLensEnabled) return [];
		const filePath = getPathFromUri(document.uri), repo = this.repoManager.getRepoContainingFile(filePath);
		if (repo === null) return [];
		const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>('vscode.executeDocumentSymbolProvider', document.uri);
		if (token.isCancellationRequested || typeof symbols === 'undefined' || symbols.length === 0) return [];
		const ranges = getSymbolRanges(symbols, 1);
		if (ranges.length === 0) return [];
		const blame = await this.getBlame(document, repo, filePath.substring(repo.length + 1));
		if (token.isCancellationRequested || blame === null) return [];
		return ranges.map((range) => {
			const title = getCodeLensTitle(blame, range.start.line, range.end.line);
			return new vscode.CodeLens(new vscode.Range(range.start.line, 0, range.start.line, 0), title !== null ? {
				title: title,
				tooltip: t('View the history of these lines'),
				command: 'git-map.viewLineHistory',
				arguments: [{ uri: document.uri, start: range.start.line + 1, end: range.end.line + 1 }]
			} : undefined);
		}).filter((lens) => typeof lens.command !== 'undefined');
	}

	/**
	 * Get the blame of a document (blamed once for each version of the document).
	 * @param document The document.
	 * @param repo The repository containing the document's file.
	 * @param filePath The path of the file (relative to the repository).
	 * @returns The blame, or NULL if the file couldn't be blamed (e.g. it isn't tracked).
	 */
	private getBlame(document: vscode.TextDocument, repo: string, filePath: string) {
		const key = document.uri.toString(), cached = this.blames.get(key);
		if (typeof cached !== 'undefined' && cached.version === document.version) return cached.blame;
		const blame = this.dataSource.getFileBlame(repo, filePath, document.getText());
		this.blames.set(key, { version: document.version, blame: blame });
		return blame;
	}
}

/**
 * Get the ranges of the symbols that have a CodeLens.
 * @param symbols The symbols of a document (hierarchical, or flat).
 * @param depth The depth of the symbols.
 * @returns The ranges.
 */
function getSymbolRanges(symbols: ReadonlyArray<vscode.DocumentSymbol | vscode.SymbolInformation>, depth: number): vscode.Range[] {
	const ranges: vscode.Range[] = [];
	symbols.forEach((symbol) => {
		if (!SYMBOL_KINDS.includes(symbol.kind)) return;
		ranges.push(symbol instanceof vscode.SymbolInformation ? symbol.location.range : symbol.range);
		if ('children' in symbol && depth < MAX_SYMBOL_DEPTH) ranges.push(...getSymbolRanges(symbol.children, depth + 1));
	});
	return ranges;
}

/**
 * Get the title of the CodeLens of lines: who changed them most recently & when, and how many authors changed them.
 * @param blame The blame of the file.
 * @param start The first line (0-based).
 * @param end The last line (0-based).
 * @returns The title, or NULL if the lines aren't blamed.
 */
export function getCodeLensTitle(blame: GitFileBlame, start: number, end: number) {
	const authors = new Set<string>();
	let latest: string | null = null, uncommitted = false;
	for (let i = start; i <= end && i < blame.lines.length; i++) {
		const line = blame.lines[i];
		if (typeof line === 'undefined') continue;
		const commit = blame.commits[line.hash];
		if (!commit.committed) {
			uncommitted = true;
			continue;
		}
		authors.add(commit.authorEmail || commit.author);
		if (latest === null || commit.authorDate > blame.commits[latest].authorDate) latest = line.hash;
	}
	if (latest === null && !uncommitted) return null;
	const recent = uncommitted || latest === null ? t('You, Uncommitted changes') : blame.commits[latest].author + ', ' + getRelativeTimeDiff(blame.commits[latest].authorDate);
	return recent + (authors.size > 0 ? ' · ' + (authors.size === 1 ? t('1 author') : t('{0} authors', authors.size)) : '');
}
