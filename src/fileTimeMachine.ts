import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { DiffDocProvider, decodeDiffDocUri } from './diffDocProvider';
import { GitFeatures } from './gitFeatures';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitFileStatus, GitFileTimelineCommit } from './types';
import { UNCOMMITTED, getNonce, getPathFromUri, showErrorMessage, viewDiff, viewFileAtRevision } from './utils';
import { Disposable } from './utils/disposable';

const MAX_COMMITS = 2000;
const MAX_SNAPSHOT_CHARS = 200000;

interface TimeMachineEntry {
	readonly hash: string; // '*' for uncommitted LIVE working tree
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly subject: string;
	readonly filePath: string;
	readonly oldFilePath: string | null;
	readonly additions: number;
	readonly deletions: number;
	readonly added: boolean;
	readonly isLive: boolean;
}

interface ShownTimeMachine {
	readonly repo: string;
	readonly filePath: string;
	readonly entries: ReadonlyArray<TimeMachineEntry>;
}

/**
 * Interactive "File Time Machine" Webview panel: a draggable vertical timeline ruler with zoom controls and a LIVE playhead
 * (inspired by macOS Time Machine / NVR timeline scrubbers) paired with an instant diff & file-snapshot viewer.
 */
export class FileTimeMachine extends Disposable {
	private static instance: FileTimeMachine | null = null;

	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly gitFeatures: GitFeatures;
	private panel: vscode.WebviewPanel | null = null;
	private shown: ShownTimeMachine | null = null;

	constructor(dataSource: DataSource, repoManager: RepoManager, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.gitFeatures = new GitFeatures(dataSource);
		FileTimeMachine.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.fileTimeMachine', (arg: unknown) => this.show(arg)),
			{
				dispose: () => {
					if (this.panel !== null) this.panel.dispose();
					if (FileTimeMachine.instance === this) FileTimeMachine.instance = null;
				}
			}
		);
	}

	public static getInstance() {
		return FileTimeMachine.instance;
	}

	public getShown() {
		return this.shown !== null && this.panel !== null
			? { repo: this.shown.repo, filePath: this.shown.filePath, entries: this.shown.entries.length, html: this.panel.webview.html }
			: null;
	}

	private async resolveTarget(arg: unknown): Promise<{ repo: string, path: string, focusCommit: string | null } | null> {
		if (typeof arg === 'object' && arg !== null && !(arg instanceof vscode.Uri)) {
			const record = <{ repo?: unknown, filePath?: unknown, commitHash?: unknown }>arg;
			if (typeof record.repo === 'string' && typeof record.filePath === 'string') {
				return {
					repo: record.repo,
					path: record.filePath,
					focusCommit: typeof record.commitHash === 'string' && record.commitHash !== '' ? record.commitHash : null
				};
			}
		}
		if (arg instanceof vscode.Uri) {
			if (arg.scheme === DiffDocProvider.scheme) {
				const decoded = decodeDiffDocUri(arg);
				return { repo: decoded.repo, path: decoded.filePath, focusCommit: decoded.commit !== UNCOMMITTED ? decoded.commit : null };
			}
			if (arg.scheme === 'file') {
				const found = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(arg));
				if (found === null) {
					showErrorMessage(t('Unable to open File Time Machine: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(arg))));
					return null;
				}
				return { repo: found.repo, path: found.path, focusCommit: null };
			}
		}

		// Check active tab (including Diff Editors opened by Git Map)
		const activeTab = vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup ? vscode.window.tabGroups.activeTabGroup.activeTab : undefined;
		const input = typeof activeTab !== 'undefined' ? activeTab.input : undefined;
		if (input instanceof vscode.TabInputTextDiff) {
			if (input.modified.scheme === DiffDocProvider.scheme) {
				const decoded = decodeDiffDocUri(input.modified);
				return { repo: decoded.repo, path: decoded.filePath, focusCommit: decoded.commit !== UNCOMMITTED ? decoded.commit : null };
			}
			if (input.modified.scheme === 'file') {
				const found = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(input.modified));
				if (found !== null) return { repo: found.repo, path: found.path, focusCommit: null };
			}
		} else if (input instanceof vscode.TabInputText && input.uri.scheme === DiffDocProvider.scheme) {
			const decoded = decodeDiffDocUri(input.uri);
			return { repo: decoded.repo, path: decoded.filePath, focusCommit: decoded.commit !== UNCOMMITTED ? decoded.commit : null };
		}

		const editor = vscode.window.activeTextEditor;
		if (typeof editor !== 'undefined' && editor.document.uri.scheme === 'file') {
			const found = await this.repoManager.getRepoAndPathOfFile(getPathFromUri(editor.document.uri));
			if (found !== null) return { repo: found.repo, path: found.path, focusCommit: null };
			showErrorMessage(t('Unable to open File Time Machine: {0}', t('The file {0} isn\'t in a repository known by Git Map.', getPathFromUri(editor.document.uri))));
			return null;
		}

		showErrorMessage(t('Unable to open File Time Machine: {0}', t('Select a file in the Explorer, or open a file in an editor.')));
		return null;
	}

	private async show(arg: unknown) {
		const target = await this.resolveTarget(arg);
		if (target === null) return;

		// Prefer HEAD timeline when the file exists at HEAD; otherwise fall back to target.focusCommit so deleted files in older commits still open
		let timeline = await this.gitFeatures.getFileTimeline(target.repo, target.path, MAX_COMMITS, 'HEAD');
		if ((timeline.error !== null || timeline.commits.length === 0) && target.focusCommit !== null) {
			timeline = await this.gitFeatures.getFileTimeline(target.repo, target.path, MAX_COMMITS, target.focusCommit);
		}
		if (timeline.error !== null) {
			showErrorMessage(t('Unable to open File Time Machine: {0}', timeline.error));
			return;
		}
		if (timeline.commits.length === 0) {
			showErrorMessage(t('Unable to open File Time Machine: {0}', t('The file {0} hasn\'t been committed.', target.path)));
			return;
		}

		const hasDirty = await this.dataSource.hasUncommittedChanges(target.repo, target.path).catch(() => false);
		const entries: TimeMachineEntry[] = [];
		if (hasDirty) {
			const dirtyStats = await this.getWorkingTreeStats(target.repo, target.path);
			entries.push({
				hash: UNCOMMITTED,
				author: t('Working Tree'),
				email: '',
				date: Math.round(Date.now() / 1000),
				subject: t('Uncommitted Changes (LIVE)'),
				filePath: target.path,
				oldFilePath: null,
				additions: dirtyStats.additions,
				deletions: dirtyStats.deletions,
				added: false,
				isLive: true
			});
		}
		timeline.commits.forEach((c: GitFileTimelineCommit, idx: number) => {
			entries.push({
				hash: c.hash,
				author: c.author,
				email: c.email,
				date: c.date,
				subject: c.subject,
				filePath: c.filePath,
				oldFilePath: typeof c.oldFilePath === 'string' ? c.oldFilePath : null,
				additions: c.additions,
				deletions: c.deletions,
				added: c.added,
				isLive: !hasDirty && idx === 0
			});
		});

		let initialIndex = 0;
		if (target.focusCommit !== null) {
			const cleanHash = target.focusCommit.replace(/\^$/, '');
			const foundIdx = entries.findIndex((e) => e.hash === cleanHash || e.hash.startsWith(cleanHash));
			if (foundIdx > -1) initialIndex = foundIdx;
		}

		this.shown = { repo: target.repo, filePath: target.path, entries: entries };
		const baseName = target.path.substring(target.path.lastIndexOf('/') + 1);
		const title = t('Time Machine: {0}', baseName);
		if (this.panel === null) {
			this.panel = vscode.window.createWebviewPanel(
				'git-map.fileTimeMachine',
				title,
				getConfig().openNewTabEditorGroup,
				{ enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
			);
			const panel = this.panel;
			const msgSub = panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
			const dispSub = panel.onDidDispose(() => {
				msgSub.dispose();
				dispSub.dispose();
				if (this.panel === panel) {
					this.panel = null;
					this.shown = null;
				}
			});
		} else {
			this.panel.title = title;
			this.panel.reveal();
		}

		const initialMode = getConfig().commitDetailsView.hideUnchangedRegions ? 'changes' : 'diff';
		this.panel.webview.html = getFileTimeMachineHtml(target.path, entries, initialIndex, initialMode, this.panel.webview.cspSource);
		this.logger.log('Showing File Time Machine for ' + target.path + ' (' + entries.length + ' revisions)');
	}

	private async getWorkingTreeStats(repo: string, filePath: string): Promise<{ additions: number, deletions: number }> {
		const diffRes = await this.dataSource.getFileDiff(repo, UNCOMMITTED, 'HEAD', filePath, filePath).catch(() => null);
		if (diffRes === null || diffRes.diff === '') return { additions: 0, deletions: 0 };
		let additions = 0, deletions = 0;
		const lines = diffRes.diff.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('+') && !line.startsWith('+++')) additions++;
			else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
		}
		return { additions, deletions };
	}

	private async loadEntryData(shown: ShownTimeMachine, index: number): Promise<{ diff: string, snapshot: string, error: string | null }> {
		const entry = shown.entries[index];
		if (typeof entry === 'undefined') return { diff: '', snapshot: '', error: 'Invalid revision index.' };

		if (entry.hash === UNCOMMITTED) {
			const repoResolved = path.resolve(shown.repo);
			const abs = path.resolve(repoResolved, entry.filePath);
			const rel = path.relative(repoResolved, abs);
			let snapshot = '';
			if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
				try {
					const buf = await fs.promises.readFile(abs);
					snapshot = buf.includes(0) ? t('(Binary file)') : buf.toString('utf8').slice(0, MAX_SNAPSHOT_CHARS);
				} catch (_) {
					snapshot = '';
				}
			}
			const diffRes = await this.getWorkingTreeDiff(shown.repo, entry.filePath);
			return { diff: diffRes.diff, snapshot: snapshot, error: diffRes.error };
		}

		const older = shown.entries[index + 1];
		const oldFilePath = entry.oldFilePath !== null ? entry.oldFilePath : (typeof older !== 'undefined' ? older.filePath : entry.filePath);
		const parentCommit = entry.added && typeof older === 'undefined'
			? await this.gitFeatures.resolveCommit(shown.repo, entry.hash + '^')
			: (await this.gitFeatures.resolveCommit(shown.repo, entry.hash + '^'));

		const [diffRes, snapshot] = await Promise.all([
			this.dataSource.getFileDiff(shown.repo, entry.hash, parentCommit, oldFilePath, entry.filePath),
			this.dataSource.getCommitFile(shown.repo, entry.hash, entry.filePath).then(
				(content) => content.length > MAX_SNAPSHOT_CHARS ? content.substring(0, MAX_SNAPSHOT_CHARS) : content,
				() => ''
			)
		]);
		return { diff: diffRes.diff, snapshot: snapshot, error: diffRes.error };
	}

	private async getWorkingTreeDiff(repo: string, filePath: string): Promise<{ diff: string, error: string | null }> {
		// Compare working tree file against HEAD via DataSource's git executable
		const headContent = await this.dataSource.getCommitFile(repo, 'HEAD', filePath).catch(() => '');
		const repoResolved = path.resolve(repo);
		const abs = path.resolve(repoResolved, filePath);
		const rel = path.relative(repoResolved, abs);
		if (rel.startsWith('..') || path.isAbsolute(rel)) return { diff: '', error: null };
		let workContent = '';
		try {
			const buf = await fs.promises.readFile(abs);
			if (buf.includes(0)) return { diff: '', error: null };
			workContent = buf.toString('utf8');
		} catch (_) {
			workContent = '';
		}
		return { diff: buildSimpleUnifiedDiff(filePath, headContent, workContent), error: null };
	}

	private async onMessage(message: any) {
		const shown = this.shown;
		if (shown === null || this.panel === null || typeof message !== 'object' || message === null) return;

		if (message.command === 'loadRevision' && typeof message.index === 'number') {
			const data = await this.loadEntryData(shown, message.index);
			if (this.panel !== null && this.shown === shown) {
				this.panel.webview.postMessage({
					command: 'revisionData',
					index: message.index,
					diff: data.diff,
					snapshot: data.snapshot,
					error: data.error
				});
			}
			return;
		}

		if (message.command === 'visualFileHistory') {
			await vscode.commands.executeCommand('git-map.visualFileHistory', { repo: shown.repo, filePath: shown.filePath });
			return;
		}

		if (typeof message.index !== 'number') return;
		const entry = shown.entries[message.index];
		if (typeof entry === 'undefined') return;
		const older = shown.entries[message.index + 1];
		const oldFilePath = entry.oldFilePath !== null ? entry.oldFilePath : (typeof older !== 'undefined' ? older.filePath : entry.filePath);
		let error: string | null = null;
		switch (message.command) {
			case 'openChanges':
				if (entry.hash === UNCOMMITTED) {
					error = await viewDiff(shown.repo, UNCOMMITTED, UNCOMMITTED, entry.filePath, entry.filePath, GitFileStatus.Modified);
				} else {
					error = await viewDiff(
						shown.repo,
						entry.hash,
						entry.hash,
						oldFilePath,
						entry.filePath,
						entry.added ? GitFileStatus.Added : oldFilePath !== entry.filePath ? GitFileStatus.Renamed : GitFileStatus.Modified
					);
				}
				break;
			case 'openFile':
				if (entry.hash === UNCOMMITTED) {
					await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(shown.repo, entry.filePath)));
				} else {
					error = await viewFileAtRevision(shown.repo, entry.hash, entry.filePath);
				}
				break;
			case 'viewCommit':
				if (entry.hash !== UNCOMMITTED) {
					await vscode.commands.executeCommand('git-map.viewCommitInGitMap', shown.repo, entry.hash);
				}
				break;
		}
		if (error !== null) showErrorMessage(error);
	}
}

/**
 * Lightweight line-by-line unified diff generator for working-tree LIVE preview vs HEAD.
 */
function buildSimpleUnifiedDiff(filePath: string, oldText: string, newText: string): string {
	if (oldText === newText) return '';
	const oldLines = oldText === '' ? [] : oldText.replace(/\r\n/g, '\n').split('\n');
	const newLines = newText === '' ? [] : newText.replace(/\r\n/g, '\n').split('\n');
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let oldEnd = oldLines.length - 1, newEnd = newLines.length - 1;
	while (oldEnd >= prefix && newEnd >= prefix && oldLines[oldEnd] === newLines[newEnd]) {
		oldEnd--;
		newEnd--;
	}
	const ctxBefore = Math.max(0, prefix - 3);
	const ctxAfterOld = Math.min(oldLines.length - 1, oldEnd + 3);
	const ctxAfterNew = Math.min(newLines.length - 1, newEnd + 3);
	const out: string[] = [
		'diff --git a/' + filePath + ' b/' + filePath,
		'--- a/' + filePath,
		'+++ b/' + filePath,
		'@@ -' + (ctxBefore + 1) + ',' + (ctxAfterOld - ctxBefore + 1) + ' +' + (ctxBefore + 1) + ',' + (ctxAfterNew - ctxBefore + 1) + ' @@'
	];
	for (let i = ctxBefore; i < prefix; i++) out.push(' ' + oldLines[i]);
	for (let i = prefix; i <= oldEnd; i++) out.push('-' + oldLines[i]);
	for (let i = prefix; i <= newEnd; i++) out.push('+' + newLines[i]);
	for (let i = oldEnd + 1; i <= ctxAfterOld; i++) out.push(' ' + oldLines[i]);
	return out.join('\n');
}

function escapeHtml(text: string) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function getFileTimeMachineHtml(
	filePath: string,
	entries: ReadonlyArray<TimeMachineEntry>,
	initialIndex: number,
	initialMode: 'changes' | 'diff' | 'snapshot',
	cspSource: string
) {
	const nonce = getNonce();
	const locale = getLanguage() === 'zh-cn' ? 'zh-CN' : 'en';
	const strings = {
		title: t('File Time Machine'),
		live: 'LIVE',
		changesOnly: t('Changes Only'),
		fullDiff: t('Full Diff'),
		snapshot: t('Full File'),
		newer: t('Newer Revision (Up Arrow)'),
		older: t('Older Revision (Down Arrow)'),
		openChanges: t('Open Diff in Editor'),
		openFile: t('Open File at this Revision'),
		viewCommit: t('View Commit in Git Map'),
		scatterChart: t('Visual File History'),
		renamedFrom: t('Renamed from {0}'),
		loading: t('Loading revision…'),
		noDiff: t('No line changes in this revision.'),
		hiddenLines: t('⋯ {0} unchanged lines collapsed ⋯'),
		zoomOut: t('Zoom Out Timeline'),
		zoomIn: t('Zoom In Timeline'),
		scrubHint: t('Drag playhead, click ticks, or use ↑ / ↓ keys to travel through commits')
	};
	const serialised = entries.map((e) => ({
		h: e.hash,
		a: e.author,
		d: e.date,
		s: e.subject,
		f: e.filePath,
		o: e.oldFilePath,
		p: e.additions,
		m: e.deletions,
		live: e.isLive
	}));

	return '<!DOCTYPE html><html lang="' + locale + '"><head><meta charset="UTF-8">' +
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + cspSource + ' \'unsafe-inline\'; script-src \'nonce-' + nonce + '\';">' +
		'<meta name="viewport" content="width=device-width, initial-scale=1.0"><style>' + STYLES + '</style></head><body>' +
		'<div class="ftmLayout">' +
			'<main class="ftmMain">' +
				'<header class="ftmTopBar">' +
					'<span class="ftmBrand">' + escapeHtml(strings.title) + '</span>' +
					'<span id="ftmPath" class="ftmPath">' + escapeHtml(filePath) + '</span>' +
					'<span id="ftmRename" class="ftmRename hidden"></span>' +
					'<span class="ftmSpacer"></span>' +
					'<div class="ftmModes" role="group">' +
						'<button type="button" data-mode="changes">' + escapeHtml(strings.changesOnly) + '</button>' +
						'<button type="button" data-mode="diff">' + escapeHtml(strings.fullDiff) + '</button>' +
						'<button type="button" data-mode="snapshot">' + escapeHtml(strings.snapshot) + '</button>' +
					'</div>' +
					'<button type="button" class="ftmBtn" data-action="visualFileHistory">' + escapeHtml(strings.scatterChart) + '</button>' +
				'</header>' +
				'<section class="ftmCommitBar">' +
					'<div class="ftmNavBtns">' +
						'<button type="button" id="ftmNewer" class="ftmIconBtn" title="' + escapeHtml(strings.newer) + '">&#8593;</button>' +
						'<span id="ftmPos" class="ftmPos"></span>' +
						'<button type="button" id="ftmOlder" class="ftmIconBtn" title="' + escapeHtml(strings.older) + '">&#8595;</button>' +
					'</div>' +
					'<div class="ftmCommitMeta">' +
						'<div id="ftmSubject" class="ftmSubject"></div>' +
						'<div id="ftmSubline" class="ftmSubline"></div>' +
					'</div>' +
					'<div class="ftmActions">' +
						'<button type="button" class="ftmBtn primary" data-action="openChanges">' + escapeHtml(strings.openChanges) + '</button>' +
						'<button type="button" class="ftmBtn" data-action="openFile">' + escapeHtml(strings.openFile) + '</button>' +
						'<button type="button" id="ftmViewCommit" class="ftmBtn" data-action="viewCommit">' + escapeHtml(strings.viewCommit) + '</button>' +
					'</div>' +
				'</section>' +
				'<div id="ftmCode" class="ftmCode" tabindex="0"></div>' +
			'</main>' +
			'<aside class="ftmRulerDock" aria-label="' + escapeHtml(strings.scrubHint) + '">' +
				'<div class="ftmZoomCapsule">' +
					'<button type="button" id="ftmZoomOut" class="ftmZoomBtn" title="' + escapeHtml(strings.zoomOut) + '">&minus;</button>' +
					'<input id="ftmZoomSlider" class="ftmZoomSlider" type="range" min="1" max="8" step="0.5" value="1">' +
					'<button type="button" id="ftmZoomIn" class="ftmZoomBtn" title="' + escapeHtml(strings.zoomIn) + '">+</button>' +
				'</div>' +
				'<div id="ftmRulerScroll" class="ftmRulerScroll">' +
					'<div id="ftmRulerTrack" class="ftmRulerTrack">' +
						'<div class="ftmRailBg"></div>' +
						'<div id="ftmRailFill" class="ftmRailFill"></div>' +
						'<div id="ftmTicks" class="ftmTicks"></div>' +
						'<div id="ftmPlayhead" class="ftmPlayhead"><span id="ftmPlayheadBadge" class="ftmPlayheadBadge">LIVE</span></div>' +
					'</div>' +
				'</div>' +
				'<div class="ftmRulerHint">' + escapeHtml(strings.scrubHint) + '</div>' +
			'</aside>' +
		'</div>' +
		'<script nonce="' + nonce + '">var ENTRIES=' + JSON.stringify(serialised).replace(/</g, '\\u003c') +
		',STRINGS=' + JSON.stringify(strings).replace(/</g, '\\u003c') +
		',LOCALE=' + JSON.stringify(locale) +
		',INITIAL_INDEX=' + initialIndex +
		',INITIAL_MODE=' + JSON.stringify(initialMode) + ';' + SCRIPT + '</script></body></html>';
}

const STYLES = `
*{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0;overflow:hidden;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button{font:inherit;color:inherit}
.hidden{display:none!important}
.ftmLayout{display:flex;height:100%;width:100%}
.ftmMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;height:100%}
.ftmTopBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.22));background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.ftmBrand{font-weight:700;font-size:13.5px;white-space:nowrap}
.ftmPath{padding:2px 8px;min-width:80px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:rgba(128,128,128,.1);font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ftmRename{font-size:11.5px;color:var(--vscode-descriptionForeground);white-space:nowrap}
.ftmSpacer{flex:1 1 auto}
.ftmModes{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:6px;overflow:hidden;flex:0 0 auto}
.ftmModes button{height:26px;padding:0 10px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;font-size:12px;white-space:nowrap}
.ftmModes button:last-child{border-right:0}
.ftmModes button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.ftmBtn{height:26px;padding:0 10px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.38));border-radius:6px;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.14));color:var(--vscode-button-secondaryForeground,inherit);cursor:pointer;font-size:12px;white-space:nowrap}
.ftmBtn:hover{filter:brightness(1.08)}
.ftmBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.ftmCommitBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.22));background:color-mix(in srgb,var(--vscode-sideBar-background,var(--vscode-editor-background)) 60%,transparent)}
.ftmNavBtns{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}
.ftmIconBtn{width:26px;height:26px;border-radius:6px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.ftmIconBtn:disabled{opacity:.35;cursor:default}
.ftmPos{font-family:var(--vscode-editor-font-family);font-size:11.5px;color:var(--vscode-descriptionForeground);min-width:52px;text-align:center}
.ftmCommitMeta{flex:1 1 200px;min-width:0}
.ftmSubject{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ftmSubline{font-size:11.5px;color:var(--vscode-descriptionForeground);display:flex;gap:8px;align-items:center;margin-top:2px;flex-wrap:wrap}
.ftmHash{font-family:var(--vscode-editor-font-family)}
.ftmAdd{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950);font-weight:600}
.ftmDel{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149);font-weight:600}
.ftmActions{display:inline-flex;gap:6px;flex:0 0 auto;flex-wrap:wrap}
.ftmCode{flex:1 1 auto;overflow:auto;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size,12.5px);line-height:19px;outline:none;padding:4px 0}
.ftmRow{display:flex;white-space:pre;min-width:max-content}
.ftmLn{flex:0 0 46px;padding:0 8px 0 6px;text-align:right;color:var(--vscode-editorLineNumber-foreground,rgba(128,128,128,.7));user-select:none;font-size:11.5px}
.ftmSign{flex:0 0 18px;text-align:center;user-select:none}
.ftmTxt{flex:1 1 auto;padding-right:16px}
.ftmRow.add{background:color-mix(in srgb,var(--vscode-gitDecoration-addedResourceForeground,#3fb950) 15%,transparent)}
.ftmRow.add .ftmSign,.ftmRow.add .ftmTxt{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950)}
.ftmRow.del{background:color-mix(in srgb,var(--vscode-gitDecoration-deletedResourceForeground,#f85149) 15%,transparent)}
.ftmRow.del .ftmSign,.ftmRow.del .ftmTxt{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149)}
.ftmRow.hunk{background:rgba(128,128,128,.12);color:var(--vscode-descriptionForeground);font-size:11.5px;padding:2px 10px}
.ftmCollapsed{padding:4px 14px;margin:2px 0;background:color-mix(in srgb,var(--vscode-focusBorder,#0e7afe) 10%,transparent);color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);font-size:11.5px;text-align:center;border-top:1px dashed rgba(128,128,128,.25);border-bottom:1px dashed rgba(128,128,128,.25)}
.ftmEmpty{padding:28px 20px;color:var(--vscode-descriptionForeground)}

/* Time Machine Right Scrubber Dock (modeled on camera/Time Machine vertical timeline) */
.ftmRulerDock{flex:0 0 206px;display:flex;flex-direction:column;height:100%;background:#111318;color:#d6dce8;border-left:1px solid rgba(255,255,255,.08);user-select:none}
.ftmZoomCapsule{margin:12px 14px 10px;height:34px;padding:0 10px;border-radius:17px;background:#1b1f27;border:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:8px;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.ftmZoomBtn{width:22px;height:22px;border:0;background:transparent;color:#c9d1d9;font-size:18px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;padding:0}
.ftmZoomBtn:hover{background:rgba(255,255,255,.1);color:#fff}
.ftmZoomSlider{flex:1 1 auto;min-width:0;accent-color:#1a8cff;cursor:pointer;height:4px}
.ftmRulerScroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;position:relative}
.ftmRulerTrack{position:relative;width:100%;min-height:100%;cursor:ns-resize;touch-action:none}
.ftmRailBg{position:absolute;left:112px;top:24px;bottom:24px;width:8px;border-radius:4px;background:#343942}
.ftmRailFill{position:absolute;left:112px;bottom:24px;width:8px;border-radius:0 0 4px 4px;background:linear-gradient(180deg,#1da1ff 0%,#0b4f8a 100%);box-shadow:0 0 10px rgba(29,161,255,.35)}
.ftmTicks{position:absolute;inset:0;pointer-events:none}
.ftmMinorTick{position:absolute;left:98px;width:8px;height:1px;background:rgba(255,255,255,.2)}
.ftmCommitTick{position:absolute;left:0;right:0;height:20px;transform:translateY(-50%);display:flex;align-items:center;pointer-events:auto;cursor:pointer}
.ftmCommitTick:hover .ftmTickLabel{color:#fff}
.ftmTickLabel{width:84px;padding-right:6px;text-align:right;font-family:var(--vscode-editor-font-family);font-size:11px;color:#8e97a8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ftmTickMark{position:absolute;left:90px;width:16px;height:1.5px;background:rgba(255,255,255,.45)}
.ftmCommitPip{position:absolute;left:113px;width:6px;height:6px;border-radius:50%;background:#6cb6ff;transform:translateY(-0.5px)}
.ftmCommitTick.active .ftmCommitPip{background:#fff;box-shadow:0 0 0 3px #1da1ff}
.ftmCommitTick.active .ftmTickLabel{opacity:0}
.ftmCommitDelta{position:absolute;left:128px;right:8px;font-family:var(--vscode-editor-font-family);font-size:10.5px;color:#7d8697;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ftmPlayhead{position:absolute;left:0;right:0;height:2px;background:#1da1ff;box-shadow:0 0 8px rgba(29,161,255,.75);transform:translateY(-1px);pointer-events:none;z-index:4}
.ftmPlayheadBadge{position:absolute;left:10px;top:50%;transform:translateY(-50%);padding:3px 9px;border-radius:7px;background:#188bff;color:#fff;font-weight:700;font-size:11px;letter-spacing:.03em;box-shadow:0 2px 8px rgba(0,0,0,.45);white-space:nowrap}
.ftmRulerHint{padding:8px 12px;font-size:11px;line-height:1.35;color:#7a8291;border-top:1px solid rgba(255,255,255,.07);text-align:center}
`;

const SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi();
	var currentIndex = Math.min(Math.max(INITIAL_INDEX, 0), ENTRIES.length - 1);
	var mode = INITIAL_MODE;
	var zoom = 1;
	var cache = {};
	var inflight = false, pendingIndex = -1;
	var PAD_TOP = 28, PAD_BOTTOM = 28;

	var dtfShort = new Intl.DateTimeFormat(LOCALE, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
	var dtfFull = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
	var dtfTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });

	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function sameDay(a, b) {
		var da = new Date(a * 1000), db = new Date(b * 1000);
		return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
	}

	function formatRulerTime(sec, idx) {
		if (idx > 0 && sameDay(sec, ENTRIES[idx - 1].d)) {
			return dtfTime.format(new Date(sec * 1000));
		}
		return dtfShort.format(new Date(sec * 1000));
	}

	function getTrackHeight() {
		var scrollEl = document.getElementById('ftmRulerScroll');
		var baseH = Math.max(scrollEl.clientHeight, Math.min(ENTRIES.length * 30 + PAD_TOP + PAD_BOTTOM, 680));
		return Math.round(Math.max(scrollEl.clientHeight, baseH * zoom));
	}

	function yForIndex(idx, totalH) {
		var usable = Math.max(totalH - PAD_TOP - PAD_BOTTOM, 1);
		if (ENTRIES.length <= 1) return PAD_TOP;
		return PAD_TOP + (idx / (ENTRIES.length - 1)) * usable;
	}

	function indexForY(y, totalH) {
		if (ENTRIES.length <= 1) return 0;
		var usable = Math.max(totalH - PAD_TOP - PAD_BOTTOM, 1);
		var ratio = Math.min(Math.max((y - PAD_TOP) / usable, 0), 1);
		return Math.round(ratio * (ENTRIES.length - 1));
	}

	function renderRuler() {
		var track = document.getElementById('ftmRulerTrack');
		var ticksEl = document.getElementById('ftmTicks');
		var totalH = getTrackHeight();
		track.style.height = totalH + 'px';

		var html = '';
		for (var y = PAD_TOP; y <= totalH - PAD_BOTTOM; y += 10) {
			html += '<div class="ftmMinorTick" style="top:' + y + 'px"></div>';
		}

		var lastLabelY = -999;
		for (var i = 0; i < ENTRIES.length; i++) {
			var cy = yForIndex(i, totalH);
			var showLabel = (cy - lastLabelY >= 24) || i === 0 || i === ENTRIES.length - 1;
			if (showLabel) lastLabelY = cy;
			var e = ENTRIES[i];
			var delta = (e.p > 0 || e.m > 0) ? ('+' + e.p + ' −' + e.m) : '';
			html += '<div class="ftmCommitTick' + (i === currentIndex ? ' active' : '') + '" data-index="' + i + '" style="top:' + cy.toFixed(1) + 'px" title="' + esc(e.s + ' · ' + e.a) + '">' +
				'<span class="ftmTickLabel">' + (showLabel ? esc(formatRulerTime(e.d, i)) : '') + '</span>' +
				'<span class="ftmTickMark"></span>' +
				'<span class="ftmCommitPip"></span>' +
				(showLabel && delta ? '<span class="ftmCommitDelta">' + esc(delta) + '</span>' : '') +
				'</div>';
		}
		ticksEl.innerHTML = html;
		updatePlayheadPosition(totalH, false);
	}

	function updatePlayheadPosition(totalH, ensureVisible) {
		var h = totalH || getTrackHeight();
		var cy = yForIndex(currentIndex, h);
		var playhead = document.getElementById('ftmPlayhead');
		var badge = document.getElementById('ftmPlayheadBadge');
		var fill = document.getElementById('ftmRailFill');
		playhead.style.top = cy.toFixed(1) + 'px';
		fill.style.top = cy.toFixed(1) + 'px';
		var entry = ENTRIES[currentIndex];
		badge.textContent = entry.live ? STRINGS.live : dtfTime.format(new Date(entry.d * 1000));
		document.querySelectorAll('.ftmCommitTick').forEach(function (el) {
			el.classList.toggle('active', parseInt(el.dataset.index) === currentIndex);
		});
		if (ensureVisible) {
			var scrollEl = document.getElementById('ftmRulerScroll');
			if (cy < scrollEl.scrollTop + 36) scrollEl.scrollTop = Math.max(0, cy - 48);
			else if (cy > scrollEl.scrollTop + scrollEl.clientHeight - 36) scrollEl.scrollTop = cy - scrollEl.clientHeight + 48;
		}
	}

	function requestRevision(idx) {
		if (cache[idx]) {
			renderCode();
			return;
		}
		pendingIndex = idx;
		if (inflight) return;
		inflight = true;
		pendingIndex = -1;
		vscode.postMessage({ command: 'loadRevision', index: idx });
	}

	function selectIndex(idx, ensureVisible) {
		var clamped = Math.min(Math.max(idx, 0), ENTRIES.length - 1);
		if (clamped !== currentIndex) {
			currentIndex = clamped;
			updatePlayheadPosition(null, ensureVisible);
			renderHeader();
			renderCode();
			requestRevision(currentIndex);
		}
	}

	function renderHeader() {
		var e = ENTRIES[currentIndex];
		document.querySelectorAll('.ftmModes button').forEach(function (btn) {
			btn.classList.toggle('active', btn.dataset.mode === mode);
		});
		document.getElementById('ftmNewer').disabled = currentIndex === 0;
		document.getElementById('ftmOlder').disabled = currentIndex >= ENTRIES.length - 1;
		document.getElementById('ftmPos').textContent = (currentIndex + 1) + ' / ' + ENTRIES.length;
		document.getElementById('ftmPath').textContent = e.f;
		var renameEl = document.getElementById('ftmRename');
		if (e.o && e.o !== e.f) {
			renameEl.textContent = '← ' + STRINGS.renamedFrom.replace('{0}', e.o);
			renameEl.classList.remove('hidden');
		} else {
			renameEl.classList.add('hidden');
		}
		document.getElementById('ftmSubject').textContent = e.s;
		var hashText = e.h === '*' ? 'LIVE' : e.h.substring(0, 8);
		document.getElementById('ftmSubline').innerHTML =
			'<span>' + esc(e.a) + '</span><span>·</span>' +
			'<span>' + esc(dtfFull.format(new Date(e.d * 1000))) + '</span><span>·</span>' +
			'<span class="ftmHash">' + esc(hashText) + '</span>' +
			((e.p > 0 || e.m > 0) ? '<span>·</span><span class="ftmAdd">+' + e.p + '</span><span class="ftmDel">−' + e.m + '</span>' : '');
		document.getElementById('ftmViewCommit').classList.toggle('hidden', e.h === '*');
	}

	function renderDiffHtml(diffText, collapseContext) {
		if (!diffText || diffText.trim() === '') {
			return '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
		}
		var lines = diffText.replace(/\\r\\n/g, '\\n').split('\\n');
		var oldLn = 0, newLn = 0, inHunk = false, skipped = 0, out = [];
		function flushSkipped() {
			if (skipped > 0) {
				out.push('<div class="ftmCollapsed">' + esc(STRINGS.hiddenLines.replace('{0}', String(skipped))) + '</div>');
				skipped = 0;
			}
		}
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			if (line.startsWith('@@ ')) {
				flushSkipped();
				var m = line.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
				if (m) { oldLn = parseInt(m[1], 10); newLn = parseInt(m[2], 10); inHunk = true; }
				if (!collapseContext) out.push('<div class="ftmRow hunk">' + esc(line) + '</div>');
				continue;
			}
			if (!inHunk) continue;
			var prefix = line.charAt(0), content = line.substring(1);
			if (prefix === '+') {
				flushSkipped();
				out.push('<div class="ftmRow add"><span class="ftmLn"></span><span class="ftmLn">' + (newLn++) + '</span><span class="ftmSign">+</span><span class="ftmTxt">' + esc(content) + '</span></div>');
			} else if (prefix === '-') {
				flushSkipped();
				out.push('<div class="ftmRow del"><span class="ftmLn">' + (oldLn++) + '</span><span class="ftmLn"></span><span class="ftmSign">&minus;</span><span class="ftmTxt">' + esc(content) + '</span></div>');
			} else if (prefix === ' ') {
				if (collapseContext) {
					oldLn++; newLn++; skipped++;
				} else {
					out.push('<div class="ftmRow"><span class="ftmLn">' + (oldLn++) + '</span><span class="ftmLn">' + (newLn++) + '</span><span class="ftmSign"> </span><span class="ftmTxt">' + esc(content) + '</span></div>');
				}
			}
		}
		flushSkipped();
		return out.length > 0 ? out.join('') : '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
	}

	function renderSnapshotHtml(text) {
		if (!text) return '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
		var lines = text.replace(/\\r\\n/g, '\\n').split('\\n');
		var out = [];
		for (var i = 0; i < lines.length; i++) {
			out.push('<div class="ftmRow"><span class="ftmLn">' + (i + 1) + '</span><span class="ftmTxt">' + esc(lines[i]) + '</span></div>');
		}
		return out.join('');
	}

	function renderCode() {
		var codeEl = document.getElementById('ftmCode');
		var data = cache[currentIndex];
		if (!data) {
			codeEl.innerHTML = '<div class="ftmEmpty">' + esc(STRINGS.loading) + '</div>';
			return;
		}
		if (data.error) {
			codeEl.innerHTML = '<div class="ftmEmpty">' + esc(data.error) + '</div>';
			return;
		}
		if (mode === 'snapshot') {
			codeEl.innerHTML = renderSnapshotHtml(data.snapshot);
		} else {
			codeEl.innerHTML = renderDiffHtml(data.diff, mode === 'changes');
		}
	}

	window.addEventListener('message', function (ev) {
		var msg = ev.data;
		if (!msg || msg.command !== 'revisionData') return;
		cache[msg.index] = { diff: msg.diff, snapshot: msg.snapshot, error: msg.error };
		inflight = false;
		if (msg.index === currentIndex) renderCode();
		if (pendingIndex > -1 && pendingIndex !== msg.index) {
			var next = pendingIndex;
			pendingIndex = -1;
			requestRevision(next);
		} else if (!cache[currentIndex]) {
			requestRevision(currentIndex);
		}
	});

	// Pointer scrubbing on the vertical Time Machine ruler
	var track = document.getElementById('ftmRulerTrack');
	var dragging = false;
	function scrubFromClientY(clientY) {
		var rect = track.getBoundingClientRect();
		selectIndex(indexForY(clientY - rect.top, rect.height), false);
	}
	track.addEventListener('pointerdown', function (e) {
		if (e.button !== 0) return;
		dragging = true;
		track.setPointerCapture(e.pointerId);
		scrubFromClientY(e.clientY);
	});
	track.addEventListener('pointermove', function (e) {
		if (!dragging) return;
		scrubFromClientY(e.clientY);
	});
	track.addEventListener('pointerup', function () { dragging = false; });
	track.addEventListener('pointercancel', function () { dragging = false; });

	// Zoom controls
	var slider = document.getElementById('ftmZoomSlider');
	function applyZoom(val) {
		zoom = Math.min(Math.max(val, 1), 8);
		slider.value = String(zoom);
		renderRuler();
		updatePlayheadPosition(null, true);
	}
	slider.addEventListener('input', function () { applyZoom(parseFloat(slider.value)); });
	document.getElementById('ftmZoomOut').addEventListener('click', function () { applyZoom(zoom - 0.5); });
	document.getElementById('ftmZoomIn').addEventListener('click', function () { applyZoom(zoom + 0.5); });
	document.getElementById('ftmRulerScroll').addEventListener('wheel', function (e) {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			applyZoom(zoom + (e.deltaY < 0 ? 0.5 : -0.5));
		}
	}, { passive: false });

	// Mode & action clicks
	document.addEventListener('click', function (e) {
		var t = e.target instanceof Element ? e.target : null;
		if (!t) return;
		var modeBtn = t.closest('.ftmModes button');
		if (modeBtn) {
			mode = modeBtn.dataset.mode;
			renderHeader();
			renderCode();
			return;
		}
		if (t.closest('#ftmNewer')) { selectIndex(currentIndex - 1, true); return; }
		if (t.closest('#ftmOlder')) { selectIndex(currentIndex + 1, true); return; }
		var actionBtn = t.closest('[data-action]');
		if (actionBtn) {
			vscode.postMessage({ command: actionBtn.dataset.action, index: currentIndex });
		}
	});

	// Keyboard Up / Down arrow scrubbing
	window.addEventListener('keydown', function (e) {
		if (e.key === 'ArrowUp') { e.preventDefault(); selectIndex(currentIndex - 1, true); }
		else if (e.key === 'ArrowDown') { e.preventDefault(); selectIndex(currentIndex + 1, true); }
	});
	window.addEventListener('resize', function () { renderRuler(); });

	renderHeader();
	renderRuler();
	renderCode();
	requestRevision(currentIndex);
})();
`;
