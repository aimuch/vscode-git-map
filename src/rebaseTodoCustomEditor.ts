import * as vscode from 'vscode';
import { t } from './l10n';
import { getNonce } from './utils';

export type RebaseTodoAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseTodoEntry {
	readonly kind: 'commit' | 'command' | 'comment';
	readonly action: string;
	readonly hash: string;
	readonly subject: string;
	readonly rawLine: string;
}

const SHORT_TO_LONG_ACTION: { readonly [key: string]: RebaseTodoAction } = {
	p: 'pick',
	pick: 'pick',
	r: 'reword',
	reword: 'reword',
	e: 'edit',
	edit: 'edit',
	s: 'squash',
	squash: 'squash',
	f: 'fixup',
	fixup: 'fixup',
	d: 'drop',
	drop: 'drop'
};

const COMMAND_ALIASES: { readonly [key: string]: string } = {
	x: 'exec',
	exec: 'exec',
	b: 'break',
	break: 'break',
	l: 'label',
	label: 'label',
	t: 'reset',
	reset: 'reset',
	m: 'merge',
	merge: 'merge',
	u: 'update-ref',
	'update-ref': 'update-ref'
};

/**
 * Parse the contents of a Git `git-rebase-todo` file into structured entries.
 */
export function parseRebaseTodoDocument(content: string): RebaseTodoEntry[] {
	const lines = content.split(/\r?\n/);
	const entries: RebaseTodoEntry[] = [];
	for (let i = 0; i < lines.length; i++) {
		const rawLine = lines[i];
		const trimmed = rawLine.trim();
		if (trimmed === '' || trimmed.startsWith('#')) {
			entries.push({ kind: 'comment', action: '', hash: '', subject: '', rawLine: rawLine });
			continue;
		}
		const commitMatch = trimmed.match(/^([a-zA-Z-]+)\s+([0-9a-fA-F]{4,64})(?:\s+(.*))?$/);
		if (commitMatch !== null) {
			const normalized = SHORT_TO_LONG_ACTION[commitMatch[1].toLowerCase()];
			if (typeof normalized !== 'undefined') {
				entries.push({
					kind: 'commit',
					action: normalized,
					hash: commitMatch[2],
					subject: commitMatch[3] || '',
					rawLine: rawLine
				});
				continue;
			}
		}
		const cmdMatch = trimmed.match(/^([a-zA-Z-]+)(?:\s+(.*))?$/);
		if (cmdMatch !== null && typeof COMMAND_ALIASES[cmdMatch[1].toLowerCase()] === 'string') {
			entries.push({
				kind: 'command',
				action: COMMAND_ALIASES[cmdMatch[1].toLowerCase()],
				hash: '',
				subject: cmdMatch[2] || '',
				rawLine: rawLine
			});
			continue;
		}
		entries.push({ kind: 'comment', action: '', hash: '', subject: '', rawLine: rawLine });
	}
	return entries;
}

/**
 * Serialize structured rebase todo entries back into Git `git-rebase-todo` text.
 */
export function serializeRebaseTodoDocument(entries: ReadonlyArray<RebaseTodoEntry>): string {
	return entries.map((entry) => {
		if (entry.kind === 'commit') {
			return entry.subject !== ''
				? entry.action + ' ' + entry.hash + ' ' + entry.subject
				: entry.action + ' ' + entry.hash;
		}
		return entry.rawLine;
	}).join('\n');
}

function escapeHtmlAttr(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Interactive visual editor for Git's `git-rebase-todo` sequence file.
 */
export class RebaseTodoCustomEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'git-map.rebaseTodoEditor';

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel
	): Promise<void> {
		webviewPanel.webview.options = { enableScripts: true };
		webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

		let isApplyingInternalEdit = false;

		const postState = () => {
			const entries = parseRebaseTodoDocument(document.getText());
			void webviewPanel.webview.postMessage({
				command: 'update',
				entries: entries
			});
		};

		const applyEntries = async (nextEntries: RebaseTodoEntry[]) => {
			isApplyingInternalEdit = true;
			try {
				const edit = new vscode.WorkspaceEdit();
				const fullRange = new vscode.Range(
					document.positionAt(0),
					document.positionAt(document.getText().length)
				);
				edit.replace(document.uri, fullRange, serializeRebaseTodoDocument(nextEntries));
				await vscode.workspace.applyEdit(edit);
			} finally {
				isApplyingInternalEdit = false;
			}
		};

		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (!isApplyingInternalEdit && e.document.uri.toString() === document.uri.toString()) {
				postState();
			}
		});

		const msgSub = webviewPanel.webview.onDidReceiveMessage(async (msg: { command: string, entries?: RebaseTodoEntry[] }) => {
			if (msg.command === 'ready') {
				postState();
			} else if (msg.command === 'updateEntries' && Array.isArray(msg.entries)) {
				await applyEntries(msg.entries);
			} else if (msg.command === 'startRebase') {
				await document.save();
				await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			} else if (msg.command === 'abortRebase') {
				isApplyingInternalEdit = true;
				try {
					const edit = new vscode.WorkspaceEdit();
					edit.replace(
						document.uri,
						new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
						''
					);
					await vscode.workspace.applyEdit(edit);
					await document.save();
					await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
				} finally {
					isApplyingInternalEdit = false;
				}
			} else if (msg.command === 'openAsText') {
				await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
			}
		});

		webviewPanel.onDidDispose(() => {
			changeSub.dispose();
			msgSub.dispose();
		});

		postState();
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const title = escapeHtmlAttr(t('Interactive Rebase'));
		const startLabel = escapeHtmlAttr(t('Start Rebase'));
		const abortLabel = escapeHtmlAttr(t('Abort Rebase'));
		const textLabel = escapeHtmlAttr(t('Switch to Text Editor'));
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${title}</title>
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px 20px; }
		.header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
		.header h2 { margin: 0; font-size: 16px; font-weight: 600; }
		.actions { display: flex; gap: 8px; }
		button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 5px 12px; cursor: pointer; font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
		button.danger { color: var(--vscode-errorForeground); }
		.list { display: flex; flex-direction: column; gap: 6px; }
		.row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editorWidget-background); }
		.row.cmd { opacity: 0.85; border-style: dashed; }
		.hash { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: 0.75; min-width: 68px; }
		.subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 3px 6px; font: inherit; }
		.moveBtns { display: inline-flex; gap: 4px; }
	</style>
</head>
<body>
	<div class="header">
		<h2>${title}</h2>
		<div class="actions">
			<button type="button" id="textBtn">${textLabel}</button>
			<button type="button" id="abortBtn" class="danger">${abortLabel}</button>
			<button type="button" id="startBtn" class="primary">${startLabel}</button>
		</div>
	</div>
	<div id="list" class="list"></div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let entries = [];
		const listEl = document.getElementById('list');
		function esc(s) {
			return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}
		function render() {
			const actionableIndices = [];
			entries.forEach((e, idx) => { if (e.kind !== 'comment') actionableIndices.push(idx); });
			listEl.innerHTML = actionableIndices.map((idx, pos) => {
				const entry = entries[idx];
				if (entry.kind === 'commit') {
					const opts = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']
						.map((a) => '<option value="' + a + '"' + (entry.action === a ? ' selected' : '') + '>' + a + '</option>')
						.join('');
					return '<div class="row" data-idx="' + idx + '">' +
						'<select data-act-idx="' + idx + '">' + opts + '</select>' +
						'<span class="hash">' + esc(entry.hash.slice(0, 8)) + '</span>' +
						'<span class="subject" title="' + esc(entry.subject) + '">' + esc(entry.subject) + '</span>' +
						'<span class="moveBtns">' +
						'<button type="button" data-move="-1" data-pos="' + pos + '"' + (pos === 0 ? ' disabled' : '') + '>&uarr;</button>' +
						'<button type="button" data-move="1" data-pos="' + pos + '"' + (pos === actionableIndices.length - 1 ? ' disabled' : '') + '>&darr;</button>' +
						'</span></div>';
				}
				return '<div class="row cmd" data-idx="' + idx + '"><span class="hash">' + esc(entry.action) + '</span><span class="subject">' + esc(entry.subject) + '</span></div>';
			}).join('');
			listEl.querySelectorAll('select[data-act-idx]').forEach((sel) => {
				sel.addEventListener('change', () => {
					const idx = parseInt(sel.dataset.actIdx, 10);
					entries[idx] = Object.assign({}, entries[idx], { action: sel.value });
					vscode.postMessage({ command: 'updateEntries', entries: entries });
				});
			});
			listEl.querySelectorAll('button[data-move]').forEach((btn) => {
				btn.addEventListener('click', () => {
					const pos = parseInt(btn.dataset.pos, 10);
					const delta = parseInt(btn.dataset.move, 10);
					const a = actionableIndices[pos], b = actionableIndices[pos + delta];
					if (typeof a !== 'number' || typeof b !== 'number') return;
					const tmp = entries[a];
					entries[a] = entries[b];
					entries[b] = tmp;
					render();
					vscode.postMessage({ command: 'updateEntries', entries: entries });
				});
			});
		}
		window.addEventListener('message', (e) => {
			if (e.data && e.data.command === 'update') {
				entries = e.data.entries || [];
				render();
			}
		});
		document.getElementById('startBtn').addEventListener('click', () => vscode.postMessage({ command: 'startRebase' }));
		document.getElementById('abortBtn').addEventListener('click', () => vscode.postMessage({ command: 'abortRebase' }));
		document.getElementById('textBtn').addEventListener('click', () => vscode.postMessage({ command: 'openAsText' }));
		vscode.postMessage({ command: 'ready' });
	</script>
</body>
</html>`;
	}
}
