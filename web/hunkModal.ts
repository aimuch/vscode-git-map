/**
 * Hunk & Line-Level Staging Modal extracted from GitGraphView.
 * Performs scroll-preserving in-place DOM updates on line selection and delegates partial patch construction
 * to the Extension Host's single-source-of-truth `buildPartialHunkPatch`.
 */
class HunkStagingModal {
	private readonly view: GitGraphView;
	private elem: HTMLElement | null = null;
	private state: { filePath: string, staged: boolean } | null = null;

	constructor(view: GitGraphView) {
		this.view = view;
	}

	public isOpen() {
		return this.elem !== null;
	}

	public close() {
		if (this.elem !== null) {
			this.elem.remove();
			this.elem = null;
		}
		this.state = null;
		this.view.syncAxState();
	}

	public open(filePath: string, staged: boolean) {
		this.close();
		closeDialogAndContextMenu();
		this.state = { filePath: filePath, staged: staged };
		const modal = document.createElement('div');
		modal.id = 'cdvHunkModal';
		modal.innerHTML = '<div class="cdvHunkCard"><div class="cdvHunkHeader">' +
			'<span class="cdvHunkTitle">' + escapeHtml(filePath) + '</span>' +
			'<div class="cdvHunkTabs">' +
			'<button type="button" class="cdvMiniBtn' + (!staged ? ' active' : '') + '" data-hunk-tab="unstaged">' + t('Unstaged Hunks') + '</button>' +
			'<button type="button" class="cdvMiniBtn' + (staged ? ' active' : '') + '" data-hunk-tab="staged">' + t('Staged Hunks') + '</button>' +
			'</div>' +
			'<button type="button" class="aiCommitClose" data-hunk-close="1" title="' + escapeHtml(t('Close')) + '">' + SVG_ICONS.close + '</button>' +
			'</div><div id="cdvHunkBody" class="cdvHunkBody"><div class="explainLoading">' + SVG_ICONS.loading + t('Loading hunks…') + '</div></div></div>';
		modal.addEventListener('mousedown', (e) => {
			if (e.target === modal) this.close();
		});
		modal.addEventListener('click', (e) => {
			if (!(e.target instanceof Element)) return;
			if (e.target.closest('[data-hunk-close]') !== null) {
				this.close();
				return;
			}
			const tabBtn = <HTMLElement | null>e.target.closest('[data-hunk-tab]');
			if (tabBtn !== null && this.state !== null) {
				this.open(this.state.filePath, tabBtn.dataset.hunkTab === 'staged');
			}
		});
		document.body.appendChild(modal);
		this.elem = modal;
		this.view.syncAxState();
		sendMessage({ command: 'loadFileHunkDiff', repo: this.view.currentRepo, filePath: filePath, staged: staged });
	}

	public processDiffResponse(msg: GG.ResponseLoadFileHunkDiff) {
		if (this.state === null || this.state.filePath !== msg.filePath || this.state.staged !== msg.staged) return;
		const body = document.getElementById('cdvHunkBody');
		if (body === null) return;
		if (msg.error !== null) {
			body.innerHTML = '<div class="explainError">' + SVG_ICONS.alert + escapeHtml(msg.error) + '</div>';
			return;
		}
		const parsed = parseUnifiedDiffHunks(msg.diff);
		if (parsed.hunks.length === 0) {
			body.innerHTML = '<p class="cdvHunkEmpty">' + (msg.staged ? t('No staged hunks in this file.') : t('No unstaged hunks in this file.')) + '</p>';
			return;
		}
		const selectedByHunk: Set<number>[] = parsed.hunks.map(() => new Set<number>());
		let lastClicked: { hunkIdx: number, lineIdx: number } | null = null;

		const renderHunkBtnsHtml = (idx: number) => {
			const selCount = selectedByHunk[idx].size;
			return (selCount > 0 && !msg.staged ? '<button type="button" class="cdvMiniBtn primary" data-hunk-idx="' + idx + '" data-hunk-act="stage" data-hunk-partial="1">+ ' + t('Stage Selected ({0})', selCount) + '</button>' : '') +
				(selCount > 0 && msg.staged ? '<button type="button" class="cdvMiniBtn primary" data-hunk-idx="' + idx + '" data-hunk-act="unstage" data-hunk-partial="1">&minus; ' + t('Unstage Selected ({0})', selCount) + '</button>' : '') +
				(selCount > 0 && !msg.staged ? '<button type="button" class="cdvMiniBtn danger" data-hunk-idx="' + idx + '" data-hunk-act="discard" data-hunk-partial="1">&times; ' + t('Discard Selected ({0})', selCount) + '</button>' : '') +
				(!msg.staged ? '<button type="button" class="cdvMiniBtn' + (selCount === 0 ? ' primary' : '') + '" data-hunk-idx="' + idx + '" data-hunk-act="stage">+ ' + t('Stage Hunk') + '</button>' : '') +
				(msg.staged ? '<button type="button" class="cdvMiniBtn" data-hunk-idx="' + idx + '" data-hunk-act="unstage">&minus; ' + t('Unstage Hunk') + '</button>' : '') +
				(!msg.staged ? '<button type="button" class="cdvMiniBtn danger" data-hunk-idx="' + idx + '" data-hunk-act="discard">&times; ' + t('Discard Hunk') + '</button>' : '');
		};

		const renderHunkBlocks = () => {
			body.innerHTML = '<div class="cdvHunkHint">' + escapeHtml(t('Click or Shift+click changed (+ / −) lines to stage, unstage, or discard individual lines.')) + '</div>' +
				parsed.hunks.map((hunk, idx) => {
					return '<div class="cdvHunkBlock" data-hunk-block="' + idx + '">' +
						'<div class="cdvHunkBlockHdr"><code>' + escapeHtml(hunk.headerLine) + '</code>' +
						'<span class="cdvHunkBlockBtns">' + renderHunkBtnsHtml(idx) + '</span></div>' +
						'<pre class="cdvHunkPre">' + hunk.lines.map((ln, lIdx) => {
						const selectable = ln.startsWith('+') || ln.startsWith('-');
						const cls = (ln.startsWith('+') ? 'add' : ln.startsWith('-') ? 'del' : 'ctx') + (selectable ? ' selectable' : '') + (selectedByHunk[idx].has(lIdx) ? ' selected' : '');
						return '<div class="cdvHunkLine ' + cls + '"' + (selectable ? ' data-sel-hunk="' + idx + '" data-sel-line="' + lIdx + '"' : '') + '>' + escapeHtml(ln) + '</div>';
					}).join('') + '</pre></div>';
				}).join('');
		};

		const updateHunkSelectionInPlace = (idx: number) => {
			const block = body.querySelector('.cdvHunkBlock[data-hunk-block="' + idx + '"]');
			if (block === null) {
				renderHunkBlocks();
				return;
			}
			const btnsElem = block.querySelector('.cdvHunkBlockBtns');
			if (btnsElem !== null) btnsElem.innerHTML = renderHunkBtnsHtml(idx);
			const set = selectedByHunk[idx];
			block.querySelectorAll<HTMLElement>('.cdvHunkLine[data-sel-line]').forEach((el) => {
				const lIdx = parseInt(el.dataset.selLine || '-1', 10);
				el.classList.toggle('selected', set.has(lIdx));
			});
		};

		renderHunkBlocks();

		body.onclick = (e: MouseEvent) => {
			if (!(e.target instanceof Element) || this.state === null) return;
			const lineEl = <HTMLElement | null>e.target.closest('[data-sel-hunk]');
			if (lineEl !== null) {
				const hIdx = parseInt(lineEl.dataset.selHunk || '-1', 10);
				const lIdx = parseInt(lineEl.dataset.selLine || '-1', 10);
				if (hIdx < 0 || hIdx >= parsed.hunks.length || lIdx < 0) return;
				const set = selectedByHunk[hIdx];
				if (e.shiftKey && lastClicked !== null && lastClicked.hunkIdx === hIdx) {
					const lo = Math.min(lastClicked.lineIdx, lIdx), hi = Math.max(lastClicked.lineIdx, lIdx);
					for (let k = lo; k <= hi; k++) {
						const rawLn = parsed.hunks[hIdx].lines[k];
						if (rawLn && (rawLn.startsWith('+') || rawLn.startsWith('-'))) set.add(k);
					}
				} else if (set.has(lIdx)) {
					set.delete(lIdx);
				} else {
					set.add(lIdx);
				}
				lastClicked = { hunkIdx: hIdx, lineIdx: lIdx };
				updateHunkSelectionInPlace(hIdx);
				return;
			}
			const btn = <HTMLElement | null>e.target.closest('[data-hunk-act]');
			if (btn === null) return;
			const idx = parseInt(btn.dataset.hunkIdx || '-1', 10);
			const act = <'stage' | 'unstage' | 'discard'>btn.dataset.hunkAct;
			if (idx < 0 || idx >= parsed.hunks.length) return;
			const cur = this.state;
			const isPartial = btn.dataset.hunkPartial === '1';
			if (isPartial && selectedByHunk[idx].size === 0) return;
			const send = () => {
				if (isPartial) {
					sendMessage({
						command: 'applyHunkPatch',
						repo: this.view.currentRepo,
						filePath: cur.filePath,
						staged: cur.staged,
						partialSelection: {
							diffHeader: parsed.header,
							hunkHeaderLine: parsed.hunks[idx].headerLine,
							hunkLines: parsed.hunks[idx].lines,
							selectedIndices: Array.from(selectedByHunk[idx])
						},
						action: act
					});
				} else {
					sendMessage({
						command: 'applyHunkPatch',
						repo: this.view.currentRepo,
						filePath: cur.filePath,
						staged: cur.staged,
						patch: parsed.header + '\n' + parsed.hunks[idx].patchBody + '\n',
						action: act
					});
				}
			};
			if (act === 'discard') {
				dialog.asDangerous().showConfirmation(
					isPartial ? t('Discard the selected lines in <b><i>{0}</i></b>? This cannot be undone.', escapeHtml(cur.filePath)) : t('Discard this hunk in <b><i>{0}</i></b>? This cannot be undone.', escapeHtml(cur.filePath)),
					isPartial ? t('Discard Selected Lines') : t('Discard Hunk'),
					send,
					null
				);
			} else {
				send();
			}
		};
	}

	public processApplyResponse(msg: GG.ResponseApplyHunkPatch) {
		if (msg.error !== null) {
			dialog.showError(t('Unable to Apply Hunk'), msg.error, null, null);
			return;
		}
		if (this.state !== null && this.state.filePath === msg.filePath) {
			sendMessage({ command: 'loadFileHunkDiff', repo: this.view.currentRepo, filePath: this.state.filePath, staged: this.state.staged });
		}
		this.view.refresh(false);
	}
}

function parseUnifiedDiffHunks(diffText: string): { header: string, hunks: { headerLine: string, lines: string[], patchBody: string }[] } {
	const rawLines = diffText.replace(/\r\n/g, '\n').split('\n');
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
	const headerLines: string[] = [];
	const hunks: { headerLine: string, lines: string[], patchBody: string }[] = [];
	let current: { headerLine: string, lines: string[] } | null = null;
	for (const line of rawLines) {
		if (line.startsWith('@@ ')) {
			if (current !== null) {
				hunks.push({ headerLine: current.headerLine, lines: current.lines, patchBody: current.headerLine + '\n' + current.lines.join('\n') });
			}
			current = { headerLine: line, lines: [] };
		} else if (current === null) {
			headerLines.push(line);
		} else {
			current.lines.push(line);
		}
	}
	if (current !== null) {
		hunks.push({ headerLine: current.headerLine, lines: current.lines, patchBody: current.headerLine + '\n' + current.lines.join('\n') });
	}
	return { header: headerLines.join('\n'), hunks: hunks };
}
