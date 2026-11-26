import * as path from 'path';
import * as vscode from 'vscode';
import { AvatarManager } from './avatarManager';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { ExtensionState } from './extensionState';
import { GitFeatures } from './gitFeatures';
import { runGit } from './historyRewrite';
import { t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { LoadGitGraphViewTo } from './types';
import { getPathFromUri } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

export interface TerminalLinkMatch {
	readonly startIndex: number;
	readonly length: number;
	readonly kind: 'range' | 'commit' | 'ref';
	readonly text: string;
	readonly fromRef?: string;
	readonly toRef?: string;
	readonly tooltip: string;
}

const HASH_OR_REF_PART = '[A-Za-z0-9._/-]{2,}';
const RANGE_REGEX = new RegExp('(^|[\\s(\\[{\'"`])(' + HASH_OR_REF_PART + ')(\\.{2,3})(' + HASH_OR_REF_PART + ')(?=$|[\\s)\\]}\'"`:;,.!?])', 'g');
const HASH_REGEX = /(^|[\s(\[{'"`])([0-9a-fA-F]{7,40})(?=$|[\s)\]}'"`:;,.!?])/g;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLikelyHexCommit(token: string): boolean {
	// Reject pure decimal digits to avoid matching issue numbers or ports
	if (/^\d+$/.test(token)) return false;
	return /^[0-9a-fA-F]{7,40}$/.test(token);
}

/**
 * Extract commit hashes, commit ranges (A..B / A...B), and known branch/tag refs from a terminal output line.
 */
export function extractTerminalLinks(line: string, knownRefs: ReadonlySet<string>): TerminalLinkMatch[] {
	if (typeof line !== 'string' || line.trim() === '') return [];
	const candidates: TerminalLinkMatch[] = [];

	// 1. Commit / ref ranges (`a..b` or `a...b`)
	RANGE_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = RANGE_REGEX.exec(line)) !== null) {
		const prefixLen = match[1].length;
		const left = match[2];
		const sep = match[3];
		const right = match[4];
		const leftValid = isLikelyHexCommit(left) || knownRefs.has(left);
		const rightValid = isLikelyHexCommit(right) || knownRefs.has(right);
		if (leftValid && rightValid) {
			const full = left + sep + right;
			candidates.push({
				startIndex: match.index + prefixLen,
				length: full.length,
				kind: 'range',
				text: full,
				fromRef: left,
				toRef: right,
				tooltip: t('Open comparison {0} in Git Map', full)
			});
		}
		if (match.index === RANGE_REGEX.lastIndex) RANGE_REGEX.lastIndex++;
	}

	// 2. Standalone 7-40 char commit hashes
	HASH_REGEX.lastIndex = 0;
	while ((match = HASH_REGEX.exec(line)) !== null) {
		const prefixLen = match[1].length;
		const hash = match[2];
		const start = match.index + prefixLen;
		// Avoid matching color hashes preceded by `#`
		if (start > 0 && line.charAt(start - 1) === '#') continue;
		if (isLikelyHexCommit(hash)) {
			candidates.push({
				startIndex: start,
				length: hash.length,
				kind: 'commit',
				text: hash,
				tooltip: t('Open commit {0} in Git Map', hash)
			});
		}
		if (match.index === HASH_REGEX.lastIndex) HASH_REGEX.lastIndex++;
	}

	// 3. Known branches and tags (longest first)
	if (knownRefs.size > 0) {
		const sortedRefs = Array.from(knownRefs).filter((r) => r.length >= 2).sort((a, b) => b.length - a.length);
		// Cap to keep single-line regex compilation instant even in large monorepos
		const slice = sortedRefs.slice(0, 250);
		if (slice.length > 0) {
			const refPattern = new RegExp('(^|[\\s(\\[{\'"`*])(' + slice.map(escapeRegExp).join('|') + ')(?=$|[\\s)\\]}\'"`:;,!?])', 'g');
			while ((match = refPattern.exec(line)) !== null) {
				const start = match.index + match[1].length;
				const ref = match[2];
				candidates.push({
					startIndex: start,
					length: ref.length,
					kind: 'ref',
					text: ref,
					tooltip: t('Open ref "{0}" in Git Map', ref)
				});
				if (match.index === refPattern.lastIndex) refPattern.lastIndex++;
			}
		}
	}

	candidates.sort((a, b) => a.startIndex !== b.startIndex ? a.startIndex - b.startIndex : b.length - a.length);
	const out: TerminalLinkMatch[] = [];
	let cursor = 0;
	for (let i = 0; i < candidates.length; i++) {
		const item = candidates[i];
		if (item.startIndex >= cursor) {
			out.push(item);
			cursor = item.startIndex + item.length;
		}
	}
	return out;
}

interface GitMapTerminalLink extends vscode.TerminalLink {
	readonly match: TerminalLinkMatch;
	readonly repo: string | null;
}

export class GitTerminalLinkProvider extends Disposable implements vscode.TerminalLinkProvider<GitMapTerminalLink> {
	private readonly extensionPath: string;
	private readonly dataSource: DataSource;
	private readonly extensionState: ExtensionState;
	private readonly avatarManager: AvatarManager;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly gitFeatures: GitFeatures;
	private readonly onOpenGraphView: (loadViewTo: LoadGitGraphViewTo) => void;
	private readonly refCache = new Map<string, { readonly refs: Set<string>, readonly expiresAt: number }>();

	constructor(
		extensionPath: string,
		dataSource: DataSource,
		extensionState: ExtensionState,
		avatarManager: AvatarManager,
		repoManager: RepoManager,
		logger: Logger,
		onOpenGraphView: (loadViewTo: LoadGitGraphViewTo) => void,
		onDidChangeGitState?: Event<void>
	) {
		super();
		this.extensionPath = extensionPath;
		this.dataSource = dataSource;
		this.extensionState = extensionState;
		this.avatarManager = avatarManager;
		this.repoManager = repoManager;
		this.logger = logger;
		this.gitFeatures = new GitFeatures(dataSource);
		this.onOpenGraphView = onOpenGraphView;

		const clearCache = () => this.refCache.clear();
		const winApi: any = vscode.window;
		const disposables: vscode.Disposable[] = [
			repoManager.onDidChangeRepos(clearCache)
		];
		if (typeof winApi.registerTerminalLinkProvider === 'function') {
			disposables.push(winApi.registerTerminalLinkProvider(this));
		}
		if (typeof onDidChangeGitState === 'function') {
			disposables.push(onDidChangeGitState(clearCache));
		}
		this.registerDisposables(...disposables);
	}

	public async provideTerminalLinks(context: vscode.TerminalLinkContext): Promise<GitMapTerminalLink[]> {
		if (!getConfig().terminalLinks.enabled) return [];
		const repo = this.resolveTerminalRepo(context.terminal);
		const knownRefs = repo !== null ? await this.getKnownRefs(repo) : new Set<string>();
		const matches = extractTerminalLinks(context.line, knownRefs);
		return matches.map((m) => ({
			startIndex: m.startIndex,
			length: m.length,
			tooltip: m.tooltip,
			match: m,
			repo: repo
		}));
	}

	public async handleTerminalLink(link: GitMapTerminalLink): Promise<void> {
		const repo = link.repo || this.extensionState.getLastActiveRepo() || Object.keys(this.repoManager.getRepos())[0] || null;
		if (repo === null) return;
		const showDetails = getConfig().terminalLinks.showDetailsView;
		const m = link.match;

		if (m.kind === 'commit') {
			const resolved = await this.gitFeatures.resolveCommit(repo, m.text);
			const hash = resolved || m.text;
			this.onOpenGraphView({
				repo: repo,
				commitDetails: showDetails ? { commitHash: hash, compareWithHash: null } : undefined,
				ref: hash
			});
			return;
		}
		if (m.kind === 'range' && m.fromRef && m.toRef) {
			const [fromHash, toHash] = await Promise.all([
				this.gitFeatures.resolveCommit(repo, m.fromRef),
				this.gitFeatures.resolveCommit(repo, m.toRef)
			]);
			if (fromHash !== null && toHash !== null) {
				this.onOpenGraphView({
					repo: repo,
					commitDetails: { commitHash: toHash, compareWithHash: fromHash }
				});
			} else {
				this.onOpenGraphView({
					repo: repo,
					compareBranches: { left: m.fromRef, right: m.toRef }
				});
			}
			return;
		}
		if (m.kind === 'ref') {
			const resolved = await this.gitFeatures.resolveCommit(repo, m.text);
			this.onOpenGraphView({
				repo: repo,
				ref: resolved || m.text,
				commitDetails: showDetails && resolved !== null ? { commitHash: resolved, compareWithHash: null } : undefined
			});
		}
	}

	public resolveTerminalRepo(terminal: vscode.Terminal): string | null {
		const termAny: any = terminal;
		let cwdPath: string | null = null;
		if (termAny && termAny.shellIntegration && termAny.shellIntegration.cwd) {
			cwdPath = getPathFromUri(termAny.shellIntegration.cwd);
		} else if (terminal && terminal.creationOptions && 'cwd' in terminal.creationOptions && terminal.creationOptions.cwd) {
			const rawCwd = terminal.creationOptions.cwd;
			cwdPath = typeof rawCwd === 'string' ? rawCwd.replace(/\\/g, '/') : getPathFromUri(rawCwd);
		}
		if (cwdPath !== null) {
			const byCwd = this.repoManager.getRepoContainingFile(cwdPath) || this.findRepoForPath(cwdPath);
			if (byCwd !== null) return byCwd;
		}
		return this.extensionState.getLastActiveRepo() || Object.keys(this.repoManager.getRepos())[0] || null;
	}

	private findRepoForPath(fsPath: string): string | null {
		const norm = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
		const repos = Object.keys(this.repoManager.getRepos());
		for (let i = 0; i < repos.length; i++) {
			const repoNorm = repos[i].replace(/\\/g, '/').replace(/\/+$/, '');
			if (norm === repoNorm || norm.startsWith(repoNorm + '/')) {
				return repos[i];
			}
		}
		return null;
	}

	private async getKnownRefs(repo: string): Promise<Set<string>> {
		const cached = this.refCache.get(repo);
		if (typeof cached !== 'undefined' && cached.expiresAt > Date.now()) {
			return cached.refs;
		}
		const refs = new Set<string>(['HEAD']);
		try {
			const res = await runGit(this.dataSource, repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']);
			if (res.code === 0) {
				res.stdout.toString().split(/\r?\n/).forEach((line) => {
					const trimmed = line.trim();
					if (trimmed !== '' && trimmed !== 'HEAD' && !trimmed.endsWith('/HEAD')) refs.add(trimmed);
				});
			}
		} catch (_) {
			// Best effort ref collection
		}
		this.refCache.set(repo, { refs: refs, expiresAt: Date.now() + 15000 });
		return refs;
	}

	public getContextInfo() {
		return {
			extensionPath: this.extensionPath,
			dataSource: this.dataSource,
			extensionState: this.extensionState,
			avatarManager: this.avatarManager,
			repoManager: this.repoManager,
			logger: this.logger
		};
	}
}

export class TerminalGraphFollower extends Disposable {
	private readonly repoManager: RepoManager;
	private readonly onFocusRepo: (repo: string, worktreePath?: string) => void;
	private readonly isGraphVisible: () => boolean;
	private lastFocusedKey: string = '';

	constructor(
		repoManager: RepoManager,
		isGraphVisible: () => boolean,
		onFocusRepo: (repo: string, worktreePath?: string) => void
	) {
		super();
		this.repoManager = repoManager;
		this.isGraphVisible = isGraphVisible;
		this.onFocusRepo = onFocusRepo;

		const winApi: any = vscode.window;
		const disposables: vscode.Disposable[] = [];
		if (typeof winApi.onDidChangeActiveTerminal === 'function') {
			disposables.push(winApi.onDidChangeActiveTerminal((terminal: vscode.Terminal | undefined) => {
				if (terminal) this.handleTerminalChange(terminal);
			}));
		}
		if (typeof winApi.onDidChangeTerminalShellIntegration === 'function') {
			disposables.push(winApi.onDidChangeTerminalShellIntegration((e: { terminal?: vscode.Terminal }) => {
				if (e && e.terminal && e.terminal === vscode.window.activeTerminal) {
					this.handleTerminalChange(e.terminal);
				}
			}));
		}
		this.registerDisposables(...disposables);
	}

	private handleTerminalChange(terminal: vscode.Terminal) {
		const followCfg = getConfig().followTerminal;
		if (!followCfg.enabled || !this.isGraphVisible()) return;
		const termAny: any = terminal;
		let cwdPath: string | null = null;
		if (termAny && termAny.shellIntegration && termAny.shellIntegration.cwd) {
			cwdPath = getPathFromUri(termAny.shellIntegration.cwd);
		} else if (terminal.creationOptions && 'cwd' in terminal.creationOptions && terminal.creationOptions.cwd) {
			const raw = terminal.creationOptions.cwd;
			cwdPath = typeof raw === 'string' ? raw.replace(/\\/g, '/') : getPathFromUri(raw);
		}
		if (cwdPath === null) return;
		const matchedRepo = this.repoManager.getRepoContainingFile(cwdPath) || this.findRepoByPrefix(cwdPath);
		if (matchedRepo === null) return;
		if (!followCfg.allowRepositorySwitching && this.lastFocusedKey !== '' && !this.lastFocusedKey.startsWith(matchedRepo + '\n')) {
			return;
		}
		const normalizedCwd = path.resolve(cwdPath);
		const key = matchedRepo + '\n' + normalizedCwd;
		if (key === this.lastFocusedKey) return;
		this.lastFocusedKey = key;
		this.onFocusRepo(matchedRepo, normalizedCwd);
	}

	private findRepoByPrefix(cwdPath: string): string | null {
		const norm = cwdPath.replace(/\\/g, '/').replace(/\/+$/, '');
		const repos = Object.keys(this.repoManager.getRepos());
		for (let i = 0; i < repos.length; i++) {
			const repoNorm = repos[i].replace(/\\/g, '/').replace(/\/+$/, '');
			if (norm === repoNorm || norm.startsWith(repoNorm + '/')) return repos[i];
		}
		return null;
	}
}
