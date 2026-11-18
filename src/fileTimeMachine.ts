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
import { UNCOMMITTED, copyToClipboard, getNonce, getPathFromUri, showErrorMessage, showInformationMessage, viewDiff, viewFileAtRevision } from './utils';
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

type TimeMachineWebviewMessage =
	| { readonly command: 'loadRevision'; readonly index: number }
	| { readonly command: 'compareRevisions'; readonly baseIndex: number; readonly targetIndex: number }
	| { readonly command: 'applySelectedLines'; readonly startLine: number; readonly endLine: number; readonly text: string; readonly mode: 'copy' | 'apply' }
	| { readonly command: 'visualFileHistory' }
	| { readonly command: 'openChanges' | 'openFile' | 'viewCommit'; readonly index: number };

interface WorkingTreeSnapshot {
	readonly text: string;
	readonly binary: boolean;
	readonly dirtyBuffer: boolean;
	readonly exists: boolean;
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

	private async readWorkingTreeFile(repo: string, filePath: string): Promise<WorkingTreeSnapshot> {
		const repoResolved = path.resolve(repo);
		const abs = path.resolve(repoResolved, filePath);
		const rel = path.relative(repoResolved, abs);
		if (rel.startsWith('..') || path.isAbsolute(rel)) {
			return { text: '', binary: false, dirtyBuffer: false, exists: false };
		}
		const docs = Array.isArray(vscode.workspace.textDocuments) ? vscode.workspace.textDocuments : [];
		const normalizedAbs = abs.replace(/\\/g, '/');
		const openDirty = docs.find((doc) => doc && doc.isDirty && doc.uri && doc.uri.scheme === 'file' && getPathFromUri(doc.uri) === normalizedAbs);
		if (typeof openDirty !== 'undefined') {
			const text = openDirty.getText();
			return { text: text, binary: text.includes('\0'), dirtyBuffer: true, exists: true };
		}
		try {
			const buf = await fs.promises.readFile(abs);
			if (buf.includes(0)) return { text: '', binary: true, dirtyBuffer: false, exists: true };
			return { text: buf.toString('utf8'), binary: false, dirtyBuffer: false, exists: true };
		} catch (_) {
			return { text: '', binary: false, dirtyBuffer: false, exists: false };
		}
	}

	private countDiffLines(diffText: string): { additions: number, deletions: number } {
		if (diffText === '') return { additions: 0, deletions: 0 };
		let additions = 0, deletions = 0;
		const lines = diffText.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.startsWith('+') && !line.startsWith('+++')) additions++;
			else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
		}
		return { additions, deletions };
	}

	private async getWorkingTreeStats(repo: string, filePath: string): Promise<{ additions: number, deletions: number }> {
		const work = await this.readWorkingTreeFile(repo, filePath);
		if (!work.dirtyBuffer) {
			const diffRes = await this.dataSource.getFileDiff(repo, UNCOMMITTED, 'HEAD', filePath, filePath).catch(() => null);
			if (diffRes !== null && diffRes.diff !== '') {
				return this.countDiffLines(diffRes.diff);
			}
		}
		if (work.binary) return { additions: 0, deletions: 0 };
		const headContent = await this.dataSource.getCommitFile(repo, 'HEAD', filePath).catch(() => '');
		return this.countDiffLines(buildMultiHunkUnifiedDiff(filePath, headContent, work.text));
	}

	private async loadEntryData(shown: ShownTimeMachine, index: number): Promise<{ diff: string, snapshot: string, binary: boolean, deleted: boolean, error: string | null }> {
		const entry = shown.entries[index];
		if (typeof entry === 'undefined') return { diff: '', snapshot: '', binary: false, deleted: false, error: 'Invalid revision index.' };

		if (entry.hash === UNCOMMITTED) {
			const work = await this.readWorkingTreeFile(shown.repo, entry.filePath);
			if (work.binary) {
				return { diff: '', snapshot: '', binary: true, deleted: false, error: null };
			}
			let diff = '';
			let error: string | null = null;
			if (!work.dirtyBuffer) {
				const diffRes = await this.dataSource.getFileDiff(shown.repo, UNCOMMITTED, 'HEAD', entry.filePath, entry.filePath);
				diff = diffRes.diff;
				error = diffRes.error;
			}
			if (diff === '' && error === null) {
				const headContent = await this.dataSource.getCommitFile(shown.repo, 'HEAD', entry.filePath).catch(() => '');
				if (headContent !== work.text) {
					diff = buildMultiHunkUnifiedDiff(entry.filePath, headContent, work.text);
				}
			}
			const snapshot = work.text.length > MAX_SNAPSHOT_CHARS ? work.text.slice(0, MAX_SNAPSHOT_CHARS) : work.text;
			return { diff: diff, snapshot: snapshot, binary: false, deleted: !work.exists, error: error };
		}

		const older = shown.entries[index + 1];
		const oldFilePath = entry.oldFilePath !== null ? entry.oldFilePath : (typeof older !== 'undefined' ? older.filePath : entry.filePath);
		const parentCommit = entry.added && entry.oldFilePath === null
			? null
			: await this.gitFeatures.resolveCommit(shown.repo, entry.hash + '^');

		let fileMissingAtCommit = false;
		const [diffRes, rawSnapshot] = await Promise.all([
			this.dataSource.getFileDiff(shown.repo, entry.hash, parentCommit, oldFilePath, entry.filePath),
			this.dataSource.getCommitFile(shown.repo, entry.hash, entry.filePath).catch(() => {
				fileMissingAtCommit = true;
				return '';
			})
		]);
		const binary = rawSnapshot.includes('\0') || /^Binary files /m.test(diffRes.diff);
		const deleted = fileMissingAtCommit && (/^deleted file mode /m.test(diffRes.diff) || (entry.additions === 0 && entry.deletions > 0));
		const snapshot = binary
			? ''
			: (rawSnapshot.length > MAX_SNAPSHOT_CHARS ? rawSnapshot.substring(0, MAX_SNAPSHOT_CHARS) : rawSnapshot);
		return { diff: diffRes.diff, snapshot: snapshot, binary: binary, deleted: deleted, error: diffRes.error };
	}

	private async onMessage(rawMessage: unknown) {
		const shown = this.shown;
		if (shown === null || this.panel === null || typeof rawMessage !== 'object' || rawMessage === null) return;
		const message = <Partial<TimeMachineWebviewMessage>>rawMessage;

		if (message.command === 'loadRevision' && typeof message.index === 'number') {
			const data = await this.loadEntryData(shown, message.index);
			if (this.panel !== null && this.shown === shown) {
				this.panel.webview.postMessage({
					command: 'revisionData',
					index: message.index,
					diff: data.diff,
					snapshot: data.snapshot,
					binary: data.binary,
					deleted: data.deleted,
					error: data.error
				});
			}
			return;
		}

		if (message.command === 'compareRevisions' && typeof message.baseIndex === 'number' && typeof message.targetIndex === 'number') {
			const baseEntry = shown.entries[message.baseIndex];
			const targetEntry = shown.entries[message.targetIndex];
			if (typeof baseEntry === 'undefined' || typeof targetEntry === 'undefined') return;
			let diff = '', err: string | null = null;
			if (baseEntry.hash === targetEntry.hash) {
				diff = '';
			} else if (targetEntry.hash === UNCOMMITTED) {
				const work = await this.readWorkingTreeFile(shown.repo, targetEntry.filePath);
				if (!work.dirtyBuffer) {
					const res = await this.dataSource.getFileDiff(shown.repo, UNCOMMITTED, baseEntry.hash, baseEntry.filePath, targetEntry.filePath);
					diff = res.diff;
					err = res.error;
				}
				if (diff === '' && err === null && !work.binary) {
					const baseContent = await this.dataSource.getCommitFile(shown.repo, baseEntry.hash, baseEntry.filePath).catch(() => '');
					diff = buildMultiHunkUnifiedDiff(targetEntry.filePath, baseContent, work.text);
				}
			} else if (baseEntry.hash === UNCOMMITTED) {
				const work = await this.readWorkingTreeFile(shown.repo, baseEntry.filePath);
				const targetContent = await this.dataSource.getCommitFile(shown.repo, targetEntry.hash, targetEntry.filePath).catch(() => '');
				diff = buildMultiHunkUnifiedDiff(targetEntry.filePath, work.text, targetContent);
			} else {
				const res = await this.dataSource.getFileDiff(shown.repo, targetEntry.hash, baseEntry.hash, baseEntry.filePath, targetEntry.filePath);
				diff = res.diff;
				err = res.error;
			}
			if (this.panel !== null && this.shown === shown) {
				this.panel.webview.postMessage({
					command: 'comparisonData',
					baseIndex: message.baseIndex,
					targetIndex: message.targetIndex,
					diff: diff,
					error: err
				});
			}
			return;
		}

		if (message.command === 'applySelectedLines' && typeof message.text === 'string' && typeof message.startLine === 'number' && typeof message.endLine === 'number') {
			if (message.mode === 'copy') {
				const copyErr = await copyToClipboard(message.text);
				if (copyErr === null) vscode.window.setStatusBarMessage(t('Copied selected lines to the clipboard.'), 3000);
				return;
			}
			const repoResolved = path.resolve(shown.repo);
			const abs = path.resolve(repoResolved, shown.filePath);
			const rel = path.relative(repoResolved, abs);
			if (rel.startsWith('..') || path.isAbsolute(rel)) return;
			try {
				const uri = vscode.Uri.file(abs);
				const doc = await vscode.workspace.openTextDocument(uri);
				const insertLine = Math.min(Math.max(0, message.startLine - 1), doc.lineCount);
				const edit = new vscode.WorkspaceEdit();
				const textWithNewline = message.text.endsWith('\n') ? message.text : message.text + '\n';
				edit.insert(uri, new vscode.Position(insertLine, 0), textWithNewline);
				const applied = await vscode.workspace.applyEdit(edit);
				if (applied) {
					await vscode.commands.executeCommand('vscode.open', uri, {
						selection: new vscode.Range(new vscode.Position(insertLine, 0), new vscode.Position(insertLine, 0)),
						preview: false
					});
					showInformationMessage(t('Inserted lines {0}–{1} into {2} (press Undo in the editor to revert).', String(message.startLine), String(message.endLine), shown.filePath));
				}
			} catch (_) {
				const copyErr = await copyToClipboard(message.text);
				if (copyErr === null) showInformationMessage(t('Working file could not be opened directly; copied the selected lines to the clipboard instead.'));
			}
			return;
		}

		if (message.command === 'visualFileHistory') {
			await vscode.commands.executeCommand('git-map.visualFileHistory', { repo: shown.repo, filePath: shown.filePath });
			return;
		}

		if ((message.command !== 'openChanges' && message.command !== 'openFile' && message.command !== 'viewCommit') || typeof message.index !== 'number') return;
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

interface DiffOp {
	readonly type: 'equal' | 'del' | 'add';
	readonly line: string;
	readonly oldIdx: number;
	readonly newIdx: number;
}

/**
 * Multi-hunk unified diff generator (with 3 context lines per hunk) for unsaved working-tree buffers or untracked files.
 * Distant edits in a file are emitted as separate `@@ ... @@` hunks instead of collapsing unchanged middle lines into a giant block.
 */
export function buildMultiHunkUnifiedDiff(filePath: string, oldText: string, newText: string): string {
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
	const midOldLen = oldEnd - prefix + 1;
	const midNewLen = newEnd - prefix + 1;

	const ops: DiffOp[] = [];
	for (let i = 0; i < prefix; i++) {
		ops.push({ type: 'equal', line: oldLines[i], oldIdx: i, newIdx: i });
	}

	if (midOldLen === 0) {
		for (let j = 0; j < midNewLen; j++) {
			ops.push({ type: 'add', line: newLines[prefix + j], oldIdx: prefix, newIdx: prefix + j });
		}
	} else if (midNewLen === 0) {
		for (let i = 0; i < midOldLen; i++) {
			ops.push({ type: 'del', line: oldLines[prefix + i], oldIdx: prefix + i, newIdx: prefix });
		}
	} else if (midOldLen * midNewLen <= 1600000) {
		// Exact LCS dynamic programming over the trimmed middle span (up to ~1265 x 1265 lines)
		const cols = midNewLen + 1;
		const dp = new Int32Array((midOldLen + 1) * cols);
		for (let i = midOldLen - 1; i >= 0; i--) {
			const oLine = oldLines[prefix + i];
			const rowOff = i * cols;
			const nextRowOff = (i + 1) * cols;
			for (let j = midNewLen - 1; j >= 0; j--) {
				dp[rowOff + j] = oLine === newLines[prefix + j]
					? dp[nextRowOff + j + 1] + 1
					: (dp[nextRowOff + j] >= dp[rowOff + j + 1] ? dp[nextRowOff + j] : dp[rowOff + j + 1]);
			}
		}
		let i = 0, j = 0;
		while (i < midOldLen && j < midNewLen) {
			if (oldLines[prefix + i] === newLines[prefix + j]) {
				ops.push({ type: 'equal', line: oldLines[prefix + i], oldIdx: prefix + i, newIdx: prefix + j });
				i++;
				j++;
			} else if (dp[(i + 1) * cols + j] >= dp[i * cols + j + 1]) {
				ops.push({ type: 'del', line: oldLines[prefix + i], oldIdx: prefix + i, newIdx: prefix + j });
				i++;
			} else {
				ops.push({ type: 'add', line: newLines[prefix + j], oldIdx: prefix + i, newIdx: prefix + j });
				j++;
			}
		}
		while (i < midOldLen) {
			ops.push({ type: 'del', line: oldLines[prefix + i], oldIdx: prefix + i, newIdx: prefix + j });
			i++;
		}
		while (j < midNewLen) {
			ops.push({ type: 'add', line: newLines[prefix + j], oldIdx: prefix + i, newIdx: prefix + j });
			j++;
		}
	} else {
		for (let i = 0; i < midOldLen; i++) {
			ops.push({ type: 'del', line: oldLines[prefix + i], oldIdx: prefix + i, newIdx: prefix });
		}
		for (let j = 0; j < midNewLen; j++) {
			ops.push({ type: 'add', line: newLines[prefix + j], oldIdx: oldEnd + 1, newIdx: prefix + j });
		}
	}

	const suffixCount = oldLines.length - 1 - oldEnd;
	for (let k = 0; k < suffixCount; k++) {
		ops.push({ type: 'equal', line: oldLines[oldEnd + 1 + k], oldIdx: oldEnd + 1 + k, newIdx: newEnd + 1 + k });
	}

	const CONTEXT = 3;
	const hunks: { start: number, end: number }[] = [];
	for (let k = 0; k < ops.length; k++) {
		if (ops[k].type !== 'equal') {
			const s = Math.max(0, k - CONTEXT);
			const e = Math.min(ops.length - 1, k + CONTEXT);
			if (hunks.length > 0 && s <= hunks[hunks.length - 1].end + 1) {
				hunks[hunks.length - 1].end = Math.max(hunks[hunks.length - 1].end, e);
			} else {
				hunks.push({ start: s, end: e });
			}
		}
	}
	if (hunks.length === 0) return '';

	const out: string[] = [
		'diff --git a/' + filePath + ' b/' + filePath,
		'--- a/' + filePath,
		'+++ b/' + filePath
	];
	for (const h of hunks) {
		let oldCount = 0, newCount = 0;
		for (let k = h.start; k <= h.end; k++) {
			if (ops[k].type !== 'add') oldCount++;
			if (ops[k].type !== 'del') newCount++;
		}
		const first = ops[h.start];
		const oldStart = oldCount === 0 ? first.oldIdx : first.oldIdx + 1;
		const newStart = newCount === 0 ? first.newIdx : first.newIdx + 1;
		out.push('@@ -' + oldStart + ',' + oldCount + ' +' + newStart + ',' + newCount + ' @@');
		for (let k = h.start; k <= h.end; k++) {
			const op = ops[k];
			out.push((op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ') + op.line);
		}
	}
	return out.join('\n');
}

function ftmIcon(paths: string) {
	return '<svg class="ftmIcon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

const FTM_ICONS = {
	clock: ftmIcon('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.4 1.5"/>'),
	foldDiff: ftmIcon('<path d="M5.5 2.5L8 5l2.5-2.5M5.5 13.5L8 11l2.5 2.5M2.5 8h11"/>'),
	diff: ftmIcon('<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M8 2.5v11M4 6.5h2.2M5.1 5.4v2.2M9.8 9.5H12"/>'),
	file: ftmIcon('<path d="M4 2h5.5L13 5.5V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9.5 2v3.5H13"/>'),
	chart: ftmIcon('<path d="M2.5 13.5h11M4.5 13.5V8.5M8 13.5V4.5M11.5 13.5V6.5"/>'),
	arrowUp: ftmIcon('<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>'),
	arrowDown: ftmIcon('<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>'),
	commit: ftmIcon('<circle cx="8" cy="8" r="2.6"/><path d="M1.5 8h3.9M10.6 8h3.9"/>'),
	pin: ftmIcon('<path d="M5.5 2.5h5l-.6 3.5 2.1 2v1.2H4V8l2.1-2zM8 9.2v4.3"/>')
};

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
		newer: t('Newer Revision (↑ or Alt+↑)'),
		older: t('Older Revision (↓ or Alt+↓)'),
		openChanges: t('Open Diff in Editor'),
		openFile: t('Open File at this Revision'),
		viewCommit: t('View Commit in Git Map'),
		scatterChart: t('Visual File History'),
		renamedFrom: t('Renamed from {0}'),
		loading: t('Loading revision…'),
		noDiff: t('No line changes in this revision.'),
		binaryFile: t('Binary file — click "Open Diff in Editor" or "Open File at this Revision" above to inspect.'),
		deletedFile: t('This file was deleted in this revision.'),
		hiddenLines: t('⋯ {0} unchanged lines collapsed ⋯'),
		zoomOut: t('Zoom Out Timeline'),
		zoomIn: t('Zoom In Timeline'),
		zoomLevel: t('Timeline Zoom'),
		pinBase: t('Pin as Base'),
		clearBase: t('Clear Base ({0})'),
		comparingWithBase: t('Comparing against pinned base {0}'),
		linesSelected: t('Lines {0}–{1} selected'),
		copyLines: t('Copy Lines'),
		applyLines: t('Insert into Working File'),
		clearSelection: t('Clear'),
		scrubHint: t('Drag playhead, Shift+click tick to pin BASE, or press ↑ / ↓ (Alt+↑ / ↓ in code)')
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
					'<span class="ftmBrand">' + FTM_ICONS.clock + escapeHtml(strings.title) + '</span>' +
					'<span id="ftmPath" class="ftmPath" title="' + escapeHtml(filePath) + '">' + escapeHtml(filePath) + '</span>' +
					'<span id="ftmRename" class="ftmRename hidden"></span>' +
					'<span class="ftmSpacer"></span>' +
					'<div class="ftmModes" role="group" aria-label="' + escapeHtml(strings.title) + '">' +
						'<button type="button" data-mode="changes" aria-pressed="' + String(initialMode === 'changes') + '">' + FTM_ICONS.foldDiff + escapeHtml(strings.changesOnly) + '</button>' +
						'<button type="button" data-mode="diff" aria-pressed="' + String(initialMode === 'diff') + '">' + FTM_ICONS.diff + escapeHtml(strings.fullDiff) + '</button>' +
						'<button type="button" data-mode="snapshot" aria-pressed="' + String(initialMode === 'snapshot') + '">' + FTM_ICONS.file + escapeHtml(strings.snapshot) + '</button>' +
					'</div>' +
					'<button type="button" class="ftmBtn" data-action="visualFileHistory">' + FTM_ICONS.chart + escapeHtml(strings.scatterChart) + '</button>' +
				'</header>' +
				'<section class="ftmCommitBar">' +
					'<div class="ftmNavBtns">' +
						'<button type="button" id="ftmNewer" class="ftmIconBtn" title="' + escapeHtml(strings.newer) + '" aria-label="' + escapeHtml(strings.newer) + '">' + FTM_ICONS.arrowUp + '</button>' +
						'<span id="ftmPos" class="ftmPos"></span>' +
						'<button type="button" id="ftmOlder" class="ftmIconBtn" title="' + escapeHtml(strings.older) + '" aria-label="' + escapeHtml(strings.older) + '">' + FTM_ICONS.arrowDown + '</button>' +
					'</div>' +
					'<div class="ftmCommitMeta">' +
						'<div id="ftmSubject" class="ftmSubject"></div>' +
						'<div id="ftmSubline" class="ftmSubline"></div>' +
					'</div>' +
					'<div class="ftmActions">' +
						'<button type="button" id="ftmPinBase" class="ftmBtn">' + FTM_ICONS.pin + '<span id="ftmPinBaseLabel">' + escapeHtml(strings.pinBase) + '</span></button>' +
						'<button type="button" class="ftmBtn primary" data-action="openChanges">' + FTM_ICONS.diff + escapeHtml(strings.openChanges) + '</button>' +
						'<button type="button" class="ftmBtn" data-action="openFile">' + FTM_ICONS.file + escapeHtml(strings.openFile) + '</button>' +
						'<button type="button" id="ftmViewCommit" class="ftmBtn" data-action="viewCommit">' + FTM_ICONS.commit + escapeHtml(strings.viewCommit) + '</button>' +
					'</div>' +
				'</section>' +
				'<div id="ftmCode" class="ftmCode" tabindex="0"></div>' +
				'<div id="ftmSelectionBar" class="ftmSelectionBar hidden">' +
					'<span id="ftmSelectionInfo"></span>' +
					'<button type="button" id="ftmCopyLines" class="ftmBtn">' + escapeHtml(strings.copyLines) + '</button>' +
					'<button type="button" id="ftmApplyLines" class="ftmBtn primary">' + escapeHtml(strings.applyLines) + '</button>' +
					'<button type="button" id="ftmClearSel" class="ftmBtn">' + escapeHtml(strings.clearSelection) + '</button>' +
				'</div>' +
			'</main>' +
			'<aside class="ftmRulerDock" aria-label="' + escapeHtml(strings.scrubHint) + '">' +
				'<div class="ftmZoomCapsule">' +
					'<button type="button" id="ftmZoomOut" class="ftmZoomBtn" title="' + escapeHtml(strings.zoomOut) + '" aria-label="' + escapeHtml(strings.zoomOut) + '">&minus;</button>' +
					'<input id="ftmZoomSlider" class="ftmZoomSlider" type="range" min="1" max="8" step="0.5" value="1" aria-label="' + escapeHtml(strings.zoomLevel) + '">' +
					'<button type="button" id="ftmZoomIn" class="ftmZoomBtn" title="' + escapeHtml(strings.zoomIn) + '" aria-label="' + escapeHtml(strings.zoomIn) + '">+</button>' +
				'</div>' +
				'<div id="ftmRulerScroll" class="ftmRulerScroll">' +
					'<div id="ftmRulerTrack" class="ftmRulerTrack">' +
						'<div class="ftmRailBg"></div>' +
						'<div id="ftmRailFill" class="ftmRailFill"></div>' +
						'<div id="ftmTicks" class="ftmTicks"></div>' +
						'<div id="ftmBaseMarker" class="ftmBaseMarker hidden"><span id="ftmBaseBadge" class="ftmBaseBadge">BASE</span></div>' +
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
:root{
	--ftm-dock-bg:#111318;
	--ftm-dock-fg:#d6dce8;
	--ftm-dock-border:rgba(255,255,255,.08);
	--ftm-capsule-bg:#1b1f27;
	--ftm-capsule-border:rgba(255,255,255,.08);
	--ftm-capsule-btn:#c9d1d9;
	--ftm-capsule-btn-hover-bg:rgba(255,255,255,.1);
	--ftm-capsule-btn-hover-fg:#ffffff;
	--ftm-rail-bg:#343942;
	--ftm-rail-fill:linear-gradient(180deg,#1da1ff 0%,#0b4f8a 100%);
	--ftm-minor-tick:rgba(255,255,255,.2);
	--ftm-major-tick:rgba(255,255,255,.48);
	--ftm-tick-label:#8e97a8;
	--ftm-tick-label-hover:#ffffff;
	--ftm-tick-delta:#7d8697;
	--ftm-pip:#6cb6ff;
	--ftm-pip-active:#ffffff;
	--ftm-accent:#1da1ff;
	--ftm-badge-bg:#188bff;
	--ftm-badge-fg:#ffffff;
	--ftm-hint:#7a8291;
}
body.vscode-light,body.vscode-high-contrast-light{
	--ftm-dock-bg:var(--vscode-sideBar-background,#f3f5f8);
	--ftm-dock-fg:var(--vscode-foreground,#1f2328);
	--ftm-dock-border:var(--vscode-panel-border,rgba(0,0,0,.12));
	--ftm-capsule-bg:var(--vscode-editor-background,#ffffff);
	--ftm-capsule-border:var(--vscode-dropdown-border,rgba(0,0,0,.16));
	--ftm-capsule-btn:var(--vscode-foreground,#24292f);
	--ftm-capsule-btn-hover-bg:rgba(0,0,0,.07);
	--ftm-capsule-btn-hover-fg:#000000;
	--ftm-rail-bg:#cfd6e2;
	--ftm-rail-fill:linear-gradient(180deg,#0969da 0%,#54aeff 100%);
	--ftm-minor-tick:rgba(31,35,40,.18);
	--ftm-major-tick:rgba(31,35,40,.42);
	--ftm-tick-label:#57606a;
	--ftm-tick-label-hover:#0969da;
	--ftm-tick-delta:#6e7781;
	--ftm-pip:#0969da;
	--ftm-pip-active:#ffffff;
	--ftm-accent:#0969da;
	--ftm-badge-bg:#0969da;
	--ftm-badge-fg:#ffffff;
	--ftm-hint:#57606a;
}
body.vscode-high-contrast,body.vscode-high-contrast-light{
	--ftm-dock-border:var(--vscode-contrastBorder,currentColor);
	--ftm-capsule-border:var(--vscode-contrastBorder,currentColor);
}
*{box-sizing:border-box}
html,body{height:100%;margin:0;padding:0;overflow:hidden;font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}
button{font:inherit;color:inherit}
button:focus-visible,input:focus-visible,.ftmCode:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:-1px}
.hidden{display:none!important}
.ftmIcon{width:13.5px;height:13.5px;flex:0 0 auto}
.ftmLayout{display:flex;height:100%;width:100%}
.ftmMain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;height:100%}
.ftmTopBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:8px 14px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.22));background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.ftmBrand{font-weight:700;font-size:13.5px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.ftmPath{flex:0 1 320px;max-width:38vw;min-width:72px;padding:2px 8px;border-radius:4px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:rgba(128,128,128,.1);font-family:var(--vscode-editor-font-family);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ftmRename{font-size:11.5px;color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.ftmSpacer{flex:1 1 8px}
.ftmModes{display:inline-flex;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.4));border-radius:6px;overflow:hidden;flex:0 0 auto}
.ftmModes button{height:26px;padding:0 9px;border:0;border-right:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.35));background:transparent;cursor:pointer;font-size:12px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.ftmModes button:last-child{border-right:0}
.ftmModes button.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.ftmBtn{height:26px;padding:0 10px;border:1px solid var(--vscode-dropdown-border,rgba(128,128,128,.38));border-radius:6px;background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.14));color:var(--vscode-button-secondaryForeground,inherit);cursor:pointer;font-size:12px;white-space:nowrap;display:inline-flex;align-items:center;gap:5px}
.ftmBtn:hover,.ftmIconBtn:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.22))}
.ftmBtn.primary{border-color:transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:600}
.ftmBtn.primary:hover{background:var(--vscode-button-hoverBackground,var(--vscode-button-background));filter:brightness(1.06)}
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

/* Time Machine Right Scrubber Dock (modeled on camera/Time Machine vertical timeline, adaptive to Dark / Light / High Contrast) */
.ftmRulerDock{flex:0 0 212px;display:flex;flex-direction:column;height:100%;background:var(--ftm-dock-bg);color:var(--ftm-dock-fg);border-left:1px solid var(--ftm-dock-border);user-select:none}
.ftmZoomCapsule{margin:12px 14px 10px;height:34px;padding:0 10px;border-radius:17px;background:var(--ftm-capsule-bg);border:1px solid var(--ftm-capsule-border);display:flex;align-items:center;gap:8px}
.ftmZoomBtn{width:22px;height:22px;border:0;background:transparent;color:var(--ftm-capsule-btn);font-size:18px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;padding:0}
.ftmZoomBtn:hover{background:var(--ftm-capsule-btn-hover-bg);color:var(--ftm-capsule-btn-hover-fg)}
.ftmZoomSlider{flex:1 1 auto;min-width:0;accent-color:var(--ftm-accent);cursor:pointer;height:4px}
.ftmRulerScroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;position:relative}
.ftmRulerTrack{position:relative;width:100%;min-height:100%;cursor:ns-resize;touch-action:none}
.ftmRailBg{position:absolute;left:116px;top:24px;bottom:24px;width:8px;border-radius:4px;background:var(--ftm-rail-bg)}
.ftmRailFill{position:absolute;left:116px;bottom:24px;width:8px;border-radius:0 0 4px 4px;background:var(--ftm-rail-fill);box-shadow:0 0 8px color-mix(in srgb,var(--ftm-accent) 35%,transparent)}
.ftmTicks{position:absolute;inset:0;pointer-events:none}
.ftmMinorTick{position:absolute;left:102px;width:8px;height:1px;background:var(--ftm-minor-tick)}
.ftmCommitTick{position:absolute;left:0;right:0;height:20px;transform:translateY(-50%);display:flex;align-items:center;pointer-events:auto;cursor:pointer}
.ftmCommitTick:hover .ftmTickLabel{color:var(--ftm-tick-label-hover)}
.ftmTickLabel{width:88px;padding-right:6px;text-align:right;font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--ftm-tick-label);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ftmTickMark{position:absolute;left:94px;width:16px;height:1.5px;background:var(--ftm-major-tick)}
.ftmCommitPip{position:absolute;left:117px;width:6px;height:6px;border-radius:50%;background:var(--ftm-pip);transform:translateY(-0.5px)}
.ftmCommitTick.active .ftmCommitPip{background:var(--ftm-pip-active);box-shadow:0 0 0 3px var(--ftm-accent)}
.ftmCommitTick.active .ftmTickLabel{opacity:0}
.ftmCommitDelta{position:absolute;left:132px;right:8px;font-family:var(--vscode-editor-font-family);font-size:10.5px;color:var(--ftm-tick-delta);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ftmPlayhead{position:absolute;left:0;right:0;height:2px;background:var(--ftm-accent);box-shadow:0 0 8px color-mix(in srgb,var(--ftm-accent) 65%,transparent);transform:translateY(-1px);pointer-events:none;z-index:4}
.ftmPlayheadBadge{position:absolute;left:8px;top:50%;transform:translateY(-50%);padding:3px 8px;border-radius:7px;background:var(--ftm-badge-bg);color:var(--ftm-badge-fg);font-weight:700;font-size:11px;letter-spacing:.02em;box-shadow:0 2px 6px rgba(0,0,0,.3);white-space:nowrap}
.ftmBaseMarker{position:absolute;left:0;right:0;height:2px;background:#e39b27;transform:translateY(-1px);pointer-events:none;z-index:3}
.ftmBaseBadge{position:absolute;right:8px;top:50%;transform:translateY(-50%);padding:2px 7px;border-radius:6px;background:#d28718;color:#fff;font-weight:700;font-size:10px;letter-spacing:.03em;white-space:nowrap}
.ftmBtn.pinned{border-color:#d28718;color:#e39b27}
.ftmRow.selLine{background:color-mix(in srgb,var(--vscode-focusBorder,#0e7afe) 20%,transparent)}
.ftmRow .ftmLn[data-snap-ln]{cursor:pointer}
.ftmRow .ftmLn[data-snap-ln]:hover{color:var(--vscode-foreground);text-decoration:underline}
.ftmSelectionBar{display:flex;align-items:center;gap:8px;padding:7px 14px;border-top:1px solid var(--vscode-panel-border,rgba(128,128,128,.28));background:var(--vscode-sideBar-background,var(--vscode-editor-background));font-size:12px}
#ftmSelectionInfo{flex:1 1 auto;font-weight:600}
.ftmRulerHint{padding:8px 12px;font-size:11px;line-height:1.35;color:var(--ftm-hint);border-top:1px solid var(--ftm-dock-border);text-align:center}
`;

const SCRIPT = `
(function () {
	var vscode = acquireVsCodeApi();
	var currentIndex = Math.min(Math.max(INITIAL_INDEX, 0), ENTRIES.length - 1);
	var mode = INITIAL_MODE;
	var zoom = 1;
	var cache = {}, compareCache = {};
	var baseIndex = -1;
	var selAnchor = -1, selEnd = -1;
	var inflight = false, pendingIndex = -1;
	var PAD_TOP = 28, PAD_BOTTOM = 28;

	var dtfShort = new Intl.DateTimeFormat(LOCALE, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
	var dtfFull = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
	var dtfTime = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false });
	var dtfTimeSec = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function sameDay(a, b) {
		var da = new Date(a * 1000), db = new Date(b * 1000);
		return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
	}

	function sameMinuteWithNeighbor(sec, idx) {
		if (idx > 0 && Math.floor(sec / 60) === Math.floor(ENTRIES[idx - 1].d / 60)) return true;
		if (idx + 1 < ENTRIES.length && Math.floor(sec / 60) === Math.floor(ENTRIES[idx + 1].d / 60)) return true;
		return false;
	}

	function sameSecondWithNeighbor(sec, idx) {
		if (idx > 0 && sec === ENTRIES[idx - 1].d) return true;
		if (idx + 1 < ENTRIES.length && sec === ENTRIES[idx + 1].d) return true;
		return false;
	}

	function formatRulerTime(sec, idx) {
		var e = ENTRIES[idx];
		if (sameMinuteWithNeighbor(sec, idx)) {
			var withSec = dtfTimeSec.format(new Date(sec * 1000));
			return (sameSecondWithNeighbor(sec, idx) && e && e.h !== '*') ? (withSec + '·' + e.h.substring(0, 4)) : withSec;
		}
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
		badge.textContent = entry.live
			? STRINGS.live
			: (sameMinuteWithNeighbor(entry.d, currentIndex) ? dtfTimeSec.format(new Date(entry.d * 1000)) : dtfTime.format(new Date(entry.d * 1000)));
		document.querySelectorAll('.ftmCommitTick').forEach(function (el) {
			el.classList.toggle('active', parseInt(el.dataset.index) === currentIndex);
		});
		var baseMarker = document.getElementById('ftmBaseMarker');
		var baseBadge = document.getElementById('ftmBaseBadge');
		if (baseIndex > -1 && baseIndex < ENTRIES.length) {
			var by = yForIndex(baseIndex, h);
			baseMarker.style.top = by.toFixed(1) + 'px';
			var be = ENTRIES[baseIndex];
			baseBadge.textContent = 'BASE · ' + (be.h === '*' ? 'LIVE' : be.h.substring(0, 6));
			baseMarker.classList.remove('hidden');
		} else {
			baseMarker.classList.add('hidden');
		}
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

	function requestComparisonIfNeeded() {
		if (baseIndex < 0 || baseIndex === currentIndex || mode === 'snapshot') return;
		var key = baseIndex + ':' + currentIndex;
		if (compareCache[key]) return;
		vscode.postMessage({ command: 'compareRevisions', baseIndex: baseIndex, targetIndex: currentIndex });
	}

	function selectIndex(idx, ensureVisible) {
		var clamped = Math.min(Math.max(idx, 0), ENTRIES.length - 1);
		if (clamped !== currentIndex) {
			currentIndex = clamped;
			selAnchor = -1; selEnd = -1;
			updatePlayheadPosition(null, ensureVisible);
			renderHeader();
			renderCode();
			requestRevision(currentIndex);
			requestComparisonIfNeeded();
		}
	}

	function shortNameOf(idx) {
		var item = ENTRIES[idx];
		return item.h === '*' ? 'LIVE' : item.h.substring(0, 7);
	}

	function renderHeader() {
		var e = ENTRIES[currentIndex];
		document.querySelectorAll('.ftmModes button').forEach(function (btn) {
			var active = btn.dataset.mode === mode;
			btn.classList.toggle('active', active);
			btn.setAttribute('aria-pressed', String(active));
		});
		var pinBtn = document.getElementById('ftmPinBase');
		var pinLabel = document.getElementById('ftmPinBaseLabel');
		pinBtn.classList.toggle('pinned', baseIndex > -1);
		pinLabel.textContent = baseIndex > -1 ? STRINGS.clearBase.replace('{0}', shortNameOf(baseIndex)) : STRINGS.pinBase;
		document.getElementById('ftmNewer').disabled = currentIndex === 0;
		document.getElementById('ftmOlder').disabled = currentIndex >= ENTRIES.length - 1;
		document.getElementById('ftmPos').textContent = (currentIndex + 1) + ' / ' + ENTRIES.length;
		var pathEl = document.getElementById('ftmPath');
		pathEl.textContent = e.f;
		pathEl.title = e.f;
		var renameEl = document.getElementById('ftmRename');
		if (baseIndex > -1 && baseIndex !== currentIndex && mode !== 'snapshot') {
			renameEl.textContent = STRINGS.comparingWithBase.replace('{0}', shortNameOf(baseIndex));
			renameEl.title = renameEl.textContent;
			renameEl.classList.remove('hidden');
		} else if (e.o && e.o !== e.f) {
			renameEl.textContent = '← ' + STRINGS.renamedFrom.replace('{0}', e.o);
			renameEl.title = renameEl.textContent;
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

	function renderDiffHtml(diffText, collapseContext, isBinary) {
		if (isBinary) {
			return '<div class="ftmEmpty">' + esc(STRINGS.binaryFile) + '</div>';
		}
		if (!diffText || diffText.trim() === '') {
			return '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
		}
		var rawLines = diffText.replace(/\\r\\n/g, '\\n').split('\\n');
		var parsed = [];
		var oldLn = 0, newLn = 0, inHunk = false, prevNewEnd = 0;
		for (var i = 0; i < rawLines.length; i++) {
			var line = rawLines[i];
			if (line.startsWith('@@ ')) {
				var m = line.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
				if (m) {
					var nextOld = parseInt(m[1], 10), nextNew = parseInt(m[2], 10);
					if (collapseContext && prevNewEnd > 0 && nextNew > prevNewEnd) {
						parsed.push({ kind: 'gap', count: nextNew - prevNewEnd });
					}
					oldLn = nextOld;
					newLn = nextNew;
					inHunk = true;
				}
				if (!collapseContext) parsed.push({ kind: 'hunk', text: line });
				continue;
			}
			if (!inHunk) continue;
			var prefix = line.charAt(0), content = line.substring(1);
			if (prefix === '+') {
				parsed.push({ kind: 'add', newLn: newLn++, text: content });
				prevNewEnd = newLn;
			} else if (prefix === '-') {
				parsed.push({ kind: 'del', oldLn: oldLn++, text: content });
			} else if (prefix === ' ') {
				parsed.push({ kind: 'ctx', oldLn: oldLn++, newLn: newLn++, text: content });
				prevNewEnd = newLn;
			}
		}

		if (collapseContext) {
			var KEEP_CTX = 1;
			var keep = new Array(parsed.length).fill(false);
			for (var k = 0; k < parsed.length; k++) {
				if (parsed[k].kind === 'add' || parsed[k].kind === 'del') {
					keep[k] = true;
					for (var b = 1; b <= KEEP_CTX && k - b >= 0; b++) {
						if (parsed[k - b].kind === 'ctx') keep[k - b] = true;
						else if (parsed[k - b].kind === 'gap') break;
					}
					for (var f = 1; f <= KEEP_CTX && k + f < parsed.length; f++) {
						if (parsed[k + f].kind === 'ctx') keep[k + f] = true;
						else if (parsed[k + f].kind === 'gap') break;
					}
				}
			}
			var outCollapsed = [], skipped = 0;
			var flushSkipped = function () {
				if (skipped > 0) {
					outCollapsed.push('<div class="ftmCollapsed">' + esc(STRINGS.hiddenLines.replace('{0}', String(skipped))) + '</div>');
					skipped = 0;
				}
			};
			for (var p = 0; p < parsed.length; p++) {
				var item = parsed[p];
				if (item.kind === 'gap') {
					skipped += item.count;
				} else if (item.kind === 'ctx' && !keep[p]) {
					skipped++;
				} else {
					flushSkipped();
					if (item.kind === 'add') {
						outCollapsed.push('<div class="ftmRow add"><span class="ftmLn"></span><span class="ftmLn">' + item.newLn + '</span><span class="ftmSign">+</span><span class="ftmTxt">' + esc(item.text) + '</span></div>');
					} else if (item.kind === 'del') {
						outCollapsed.push('<div class="ftmRow del"><span class="ftmLn">' + item.oldLn + '</span><span class="ftmLn"></span><span class="ftmSign">&minus;</span><span class="ftmTxt">' + esc(item.text) + '</span></div>');
					} else if (item.kind === 'ctx') {
						outCollapsed.push('<div class="ftmRow"><span class="ftmLn">' + item.oldLn + '</span><span class="ftmLn">' + item.newLn + '</span><span class="ftmSign"> </span><span class="ftmTxt">' + esc(item.text) + '</span></div>');
					}
				}
			}
			flushSkipped();
			return outCollapsed.length > 0 ? outCollapsed.join('') : '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
		}

		var outFull = [];
		for (var q = 0; q < parsed.length; q++) {
			var r = parsed[q];
			if (r.kind === 'hunk') {
				outFull.push('<div class="ftmRow hunk">' + esc(r.text) + '</div>');
			} else if (r.kind === 'add') {
				outFull.push('<div class="ftmRow add"><span class="ftmLn"></span><span class="ftmLn">' + r.newLn + '</span><span class="ftmSign">+</span><span class="ftmTxt">' + esc(r.text) + '</span></div>');
			} else if (r.kind === 'del') {
				outFull.push('<div class="ftmRow del"><span class="ftmLn">' + r.oldLn + '</span><span class="ftmLn"></span><span class="ftmSign">&minus;</span><span class="ftmTxt">' + esc(r.text) + '</span></div>');
			} else if (r.kind === 'ctx') {
				outFull.push('<div class="ftmRow"><span class="ftmLn">' + r.oldLn + '</span><span class="ftmLn">' + r.newLn + '</span><span class="ftmSign"> </span><span class="ftmTxt">' + esc(r.text) + '</span></div>');
			}
		}
		return outFull.length > 0 ? outFull.join('') : '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
	}

	function renderSnapshotHtml(text, isBinary, isDeleted) {
		if (isBinary) return '<div class="ftmEmpty">' + esc(STRINGS.binaryFile) + '</div>';
		if (isDeleted) return '<div class="ftmEmpty">' + esc(STRINGS.deletedFile) + '</div>';
		if (!text) return '<div class="ftmEmpty">' + esc(STRINGS.noDiff) + '</div>';
		var lines = text.replace(/\\r\\n/g, '\\n').split('\\n');
		var sMin = selAnchor > 0 && selEnd > 0 ? Math.min(selAnchor, selEnd) : -1;
		var sMax = selAnchor > 0 && selEnd > 0 ? Math.max(selAnchor, selEnd) : -1;
		var out = [];
		for (var i = 0; i < lines.length; i++) {
			var ln = i + 1;
			var sel = sMin > 0 && ln >= sMin && ln <= sMax;
			out.push('<div class="ftmRow' + (sel ? ' selLine' : '') + '"><span class="ftmLn" data-snap-ln="' + ln + '">' + ln + '</span><span class="ftmTxt">' + esc(lines[i]) + '</span></div>');
		}
		return out.join('');
	}

	function updateSelectionBar() {
		var bar = document.getElementById('ftmSelectionBar');
		if (mode !== 'snapshot' || selAnchor < 1 || selEnd < 1) {
			bar.classList.add('hidden');
			return;
		}
		var sMin = Math.min(selAnchor, selEnd), sMax = Math.max(selAnchor, selEnd);
		document.getElementById('ftmSelectionInfo').textContent = STRINGS.linesSelected.replace('{0}', String(sMin)).replace('{1}', String(sMax));
		bar.classList.remove('hidden');
	}

	function getSelectedSnapshotLines() {
		var data = cache[currentIndex];
		if (!data || !data.snapshot || selAnchor < 1 || selEnd < 1) return null;
		var sMin = Math.min(selAnchor, selEnd), sMax = Math.max(selAnchor, selEnd);
		var lines = data.snapshot.replace(/\\r\\n/g, '\\n').split('\\n');
		return { startLine: sMin, endLine: sMax, text: lines.slice(sMin - 1, sMax).join('\\n') };
	}

	function renderCode() {
		updateSelectionBar();
		var codeEl = document.getElementById('ftmCode');
		if (mode !== 'snapshot' && baseIndex > -1 && baseIndex !== currentIndex) {
			var cmpKey = baseIndex + ':' + currentIndex;
			var cmp = compareCache[cmpKey];
			if (!cmp) {
				codeEl.innerHTML = '<div class="ftmEmpty">' + esc(STRINGS.loading) + '</div>';
				requestComparisonIfNeeded();
				return;
			}
			if (cmp.error) {
				codeEl.innerHTML = '<div class="ftmEmpty">' + esc(cmp.error) + '</div>';
				return;
			}
			codeEl.innerHTML = renderDiffHtml(cmp.diff, mode === 'changes', false);
			return;
		}
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
			codeEl.innerHTML = renderSnapshotHtml(data.snapshot, !!data.binary, !!data.deleted);
		} else {
			codeEl.innerHTML = renderDiffHtml(data.diff, mode === 'changes', !!data.binary);
		}
	}

	window.addEventListener('message', function (ev) {
		var msg = ev.data;
		if (!msg) return;
		if (msg.command === 'comparisonData') {
			compareCache[msg.baseIndex + ':' + msg.targetIndex] = { diff: msg.diff, error: msg.error };
			renderCode();
			return;
		}
		if (msg.command !== 'revisionData') return;
		cache[msg.index] = { diff: msg.diff, snapshot: msg.snapshot, binary: !!msg.binary, deleted: !!msg.deleted, error: msg.error };
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

	// Pointer scrubbing on the vertical Time Machine ruler (Shift+Click pins BASE)
	var track = document.getElementById('ftmRulerTrack');
	var dragging = false;
	function scrubFromClientY(clientY) {
		var rect = track.getBoundingClientRect();
		selectIndex(indexForY(clientY - rect.top, rect.height), false);
	}
	track.addEventListener('pointerdown', function (e) {
		if (e.button !== 0) return;
		if (e.shiftKey) {
			var rect = track.getBoundingClientRect();
			var pinned = indexForY(e.clientY - rect.top, rect.height);
			baseIndex = (baseIndex === pinned) ? -1 : pinned;
			updatePlayheadPosition(null, false);
			renderHeader();
			renderCode();
			return;
		}
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
		if (t.closest('#ftmPinBase')) {
			baseIndex = (baseIndex > -1) ? -1 : currentIndex;
			updatePlayheadPosition(null, false);
			renderHeader();
			renderCode();
			return;
		}
		var snapLn = t.closest('[data-snap-ln]');
		if (snapLn) {
			var ln = parseInt(snapLn.dataset.snapLn, 10);
			if (e.shiftKey && selAnchor > 0) selEnd = ln;
			else { selAnchor = ln; selEnd = ln; }
			renderCode();
			return;
		}
		if (t.closest('#ftmClearSel')) { selAnchor = -1; selEnd = -1; renderCode(); return; }
		if (t.closest('#ftmCopyLines') || t.closest('#ftmApplyLines')) {
			var sel = getSelectedSnapshotLines();
			if (sel) {
				vscode.postMessage({ command: 'applySelectedLines', startLine: sel.startLine, endLine: sel.endLine, text: sel.text, mode: t.closest('#ftmCopyLines') ? 'copy' : 'apply' });
			}
			return;
		}
		if (t.closest('#ftmNewer')) { selectIndex(currentIndex - 1, true); return; }
		if (t.closest('#ftmOlder')) { selectIndex(currentIndex + 1, true); return; }
		var actionBtn = t.closest('[data-action]');
		if (actionBtn) {
			vscode.postMessage({ command: actionBtn.dataset.action, index: currentIndex });
		}
	});

	// Keyboard revision navigation: Alt+Up/Down works anywhere; bare Up/Down works unless scrolling #ftmCode or adjusting range input
	window.addEventListener('keydown', function (e) {
		var active = document.activeElement;
		var inInput = active && active.tagName === 'INPUT';
		var inCode = active && active.id === 'ftmCode';
		if (e.altKey && e.key === 'ArrowUp') {
			e.preventDefault();
			selectIndex(currentIndex - 1, true);
		} else if (e.altKey && e.key === 'ArrowDown') {
			e.preventDefault();
			selectIndex(currentIndex + 1, true);
		} else if (!e.altKey && !e.ctrlKey && !e.metaKey && !inInput && !inCode) {
			if (e.key === 'ArrowUp') { e.preventDefault(); selectIndex(currentIndex - 1, true); }
			else if (e.key === 'ArrowDown') { e.preventDefault(); selectIndex(currentIndex + 1, true); }
		}
	});
	window.addEventListener('resize', function () { renderRuler(); });

	renderHeader();
	renderRuler();
	renderCode();
	requestRevision(currentIndex);
})();
`;
