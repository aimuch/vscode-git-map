/**
 * Modal for selecting any two commits across two branches (local or remote) and opening
 * a full Commit Comparison between them — even when either commit is outside the currently filtered graph.
 */
class BranchCommitCompareModal {
	private readonly view: GitGraphView;
	private elem: HTMLElement | null = null;
	private leftBranch: string = '';
	private rightBranch: string = '';
	private leftHash: string | null = null;
	private rightHash: string | null = null;
	private leftQuery: string = '';
	private rightQuery: string = '';
	private readonly commitsByBranch: Map<string, ReadonlyArray<GG.BranchCommitSummary>> = new Map();
	private readonly loadingBranches: Set<string> = new Set();
	private readonly errorsByBranch: Map<string, string> = new Map();

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
		this.view.syncAxState();
	}

	private getAllBranchNames(): string[] {
		const seen = new Set<string>();
		const out: string[] = [];
		this.view.gitBranches.forEach((b) => {
			const clean = b.startsWith('remotes/') ? b.substring(8) : b;
			if (clean !== '' && !/\/HEAD$/.test(clean) && !seen.has(clean)) {
				seen.add(clean);
				out.push(clean);
			}
		});
		return out;
	}

	public open(initialLeftBranch?: string | null, initialRightBranch?: string | null, initialLeftHash?: string | null) {
		this.close();
		closeDialogAndContextMenu();
		const branches = this.getAllBranchNames();
		if (branches.length === 0) {
			dialog.showError(t('Unable to Compare Commits'), t('No branches were found in this repository.'), null, null);
			return;
		}
		const head = this.view.gitBranchHead;
		const pickBranch = (preferred: string | null | undefined, fallbackIdx: number, avoid?: string) => {
			if (typeof preferred === 'string' && branches.includes(preferred)) return preferred;
			if (typeof head === 'string' && head !== avoid && branches.includes(head)) return head;
			const other = branches.find((b) => b !== avoid);
			return other || branches[Math.min(fallbackIdx, branches.length - 1)];
		};
		this.leftBranch = pickBranch(initialLeftBranch, 0);
		this.rightBranch = pickBranch(initialRightBranch, 1, this.leftBranch);
		this.leftHash = typeof initialLeftHash === 'string' ? initialLeftHash : null;
		this.rightHash = null;
		this.leftQuery = '';
		this.rightQuery = '';
		this.commitsByBranch.clear();
		this.loadingBranches.clear();
		this.errorsByBranch.clear();

		const modal = document.createElement('div');
		modal.id = 'branchCommitCompareModal';
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.addEventListener('mousedown', (e) => {
			if (e.target === modal) this.close();
		});
		document.body.appendChild(modal);
		this.elem = modal;
		this.view.syncAxState();

		this.requestBranchCommits(this.leftBranch);
		if (this.rightBranch !== this.leftBranch) {
			this.requestBranchCommits(this.rightBranch);
		}
		this.render();
	}

	private requestBranchCommits(branch: string) {
		if (branch === '' || this.loadingBranches.has(branch) || this.commitsByBranch.has(branch)) return;
		this.loadingBranches.add(branch);
		this.errorsByBranch.delete(branch);
		sendMessage({ command: 'loadBranchCommits', repo: this.view.currentRepo, branch: branch, maxCommits: 100 });
	}

	public processLoadBranchCommitsResponse(msg: GG.ResponseLoadBranchCommits) {
		this.loadingBranches.delete(msg.branch);
		if (msg.error !== null) {
			this.errorsByBranch.set(msg.branch, msg.error);
		} else {
			this.commitsByBranch.set(msg.branch, msg.commits);
			if (msg.branch === this.leftBranch && (this.leftHash === null || !msg.commits.some((c) => c.hash === this.leftHash))) {
				this.leftHash = msg.commits.length > 0 ? msg.commits[0].hash : null;
			}
			if (msg.branch === this.rightBranch && (this.rightHash === null || !msg.commits.some((c) => c.hash === this.rightHash))) {
				const pick = msg.commits.find((c) => c.hash !== this.leftHash) || msg.commits[0];
				this.rightHash = pick ? pick.hash : null;
			}
		}
		if (this.elem !== null) this.render();
	}

	private renderList(side: 'left' | 'right'): string {
		const branch = side === 'left' ? this.leftBranch : this.rightBranch;
		const query = (side === 'left' ? this.leftQuery : this.rightQuery).trim().toLowerCase();
		const selected = side === 'left' ? this.leftHash : this.rightHash;
		if (this.loadingBranches.has(branch)) {
			return '<div class="bccEmpty">' + SVG_ICONS.loading + ' ' + escapeHtml(t('Loading commits…')) + '</div>';
		}
		const err = this.errorsByBranch.get(branch);
		if (typeof err === 'string') {
			return '<div class="bccEmpty">' + escapeHtml(err) + '</div>';
		}
		const all = this.commitsByBranch.get(branch) || [];
		const list = query === ''
			? all
			: all.filter((c) => c.subject.toLowerCase().includes(query) || c.hash.toLowerCase().includes(query) || c.author.toLowerCase().includes(query));
		if (list.length === 0) {
			return '<div class="bccEmpty">' + escapeHtml(t('No matching commits.')) + '</div>';
		}
		return list.map((c) => {
			const isSel = c.hash === selected;
			return '<button type="button" class="bccCommitRow' + (isSel ? ' selected' : '') + '" data-bcc-side="' + side + '" data-bcc-hash="' + escapeHtml(c.hash) + '">' +
				'<span class="bccHash">' + escapeHtml(abbrevCommit(c.hash)) + '</span>' +
				'<span class="bccSubject" title="' + escapeHtml(c.subject) + '">' + escapeHtml(c.subject) + '</span>' +
				'<span class="bccMeta">' + escapeHtml(c.author) + ' · ' + escapeHtml(formatRelativeDate(c.date)) + '</span></button>';
		}).join('');
	}

	private render() {
		if (this.elem === null) return;
		const branches = this.getAllBranchNames();
		const branchOptions = (selected: string) => branches.map((b) => '<option value="' + escapeHtml(b) + '"' + (b === selected ? ' selected' : '') + '>' + escapeHtml(b) + '</option>').join('');
		const canCompare = this.leftHash !== null && this.rightHash !== null && this.leftHash !== this.rightHash;
		const leftSummary = this.leftHash !== null ? this.leftBranch + ' @ ' + abbrevCommit(this.leftHash) : this.leftBranch;
		const rightSummary = this.rightHash !== null ? this.rightBranch + ' @ ' + abbrevCommit(this.rightHash) : this.rightBranch;

		this.elem.innerHTML = '<div class="bccCard">' +
			'<div class="bccHeader">' +
				'<span class="bccTitle">' + SVG_ICONS.compare + '<span>' + escapeHtml(t('Compare Commits Across Branches')) + '</span></span>' +
				'<button type="button" class="cdvMiniBtn" data-bcc-act="swap" title="' + escapeHtml(t('Swap Base and Target')) + '">&#8644; ' + escapeHtml(t('Swap')) + '</button>' +
				'<button type="button" class="aiCommitClose" data-bcc-act="close" title="' + escapeHtml(t('Close')) + '">' + SVG_ICONS.close + '</button>' +
			'</div>' +
			'<div class="bccCols">' +
				'<div class="bccCol">' +
					'<label class="bccLabel">' + escapeHtml(t('Base Branch & Commit (From)')) + '</label>' +
					'<select id="bccLeftBranch" class="bccSelect">' + branchOptions(this.leftBranch) + '</select>' +
					'<input id="bccLeftQuery" class="bccSearch" type="search" value="' + escapeHtml(this.leftQuery) + '" placeholder="' + escapeHtml(t('Filter commits by message, hash, or author…')) + '">' +
					'<div id="bccLeftList" class="bccList">' + this.renderList('left') + '</div>' +
				'</div>' +
				'<div class="bccCol">' +
					'<label class="bccLabel">' + escapeHtml(t('Target Branch & Commit (To)')) + '</label>' +
					'<select id="bccRightBranch" class="bccSelect">' + branchOptions(this.rightBranch) + '</select>' +
					'<input id="bccRightQuery" class="bccSearch" type="search" value="' + escapeHtml(this.rightQuery) + '" placeholder="' + escapeHtml(t('Filter commits by message, hash, or author…')) + '">' +
					'<div id="bccRightList" class="bccList">' + this.renderList('right') + '</div>' +
				'</div>' +
			'</div>' +
			'<div class="bccFooter">' +
				'<span class="bccSummary">' + escapeHtml(leftSummary) + ' &rarr; ' + escapeHtml(rightSummary) +
				(this.leftHash !== null && this.leftHash === this.rightHash ? ' <span class="bccWarn">(' + escapeHtml(t('Select two different commits')) + ')</span>' : '') + '</span>' +
				'<button type="button" class="rebaseEditorBtn" data-bcc-act="close">' + escapeHtml(t('Cancel')) + '</button>' +
				'<button type="button" class="rebaseEditorBtn primary" data-bcc-act="compare"' + (canCompare ? '' : ' disabled') + '>' + escapeHtml(t('Compare Selected Commits')) + '</button>' +
			'</div></div>';

		const leftSel = <HTMLSelectElement | null>document.getElementById('bccLeftBranch');
		const rightSel = <HTMLSelectElement | null>document.getElementById('bccRightBranch');
		const leftInp = <HTMLInputElement | null>document.getElementById('bccLeftQuery');
		const rightInp = <HTMLInputElement | null>document.getElementById('bccRightQuery');

		if (leftSel !== null) {
			leftSel.addEventListener('change', () => {
				this.leftBranch = leftSel.value;
				this.leftHash = null;
				const cached = this.commitsByBranch.get(this.leftBranch);
				if (cached && cached.length > 0) this.leftHash = cached[0].hash;
				else this.requestBranchCommits(this.leftBranch);
				this.render();
			});
		}
		if (rightSel !== null) {
			rightSel.addEventListener('change', () => {
				this.rightBranch = rightSel.value;
				this.rightHash = null;
				const cached = this.commitsByBranch.get(this.rightBranch);
				if (cached && cached.length > 0) this.rightHash = (cached.find((c) => c.hash !== this.leftHash) || cached[0]).hash;
				else this.requestBranchCommits(this.rightBranch);
				this.render();
			});
		}
		if (leftInp !== null) {
			leftInp.addEventListener('input', () => {
				this.leftQuery = leftInp.value;
				const listEl = document.getElementById('bccLeftList');
				if (listEl !== null) listEl.innerHTML = this.renderList('left');
			});
		}
		if (rightInp !== null) {
			rightInp.addEventListener('input', () => {
				this.rightQuery = rightInp.value;
				const listEl = document.getElementById('bccRightList');
				if (listEl !== null) listEl.innerHTML = this.renderList('right');
			});
		}

		this.elem.onclick = (e: MouseEvent) => {
			if (!(e.target instanceof Element)) return;
			const row = <HTMLElement | null>e.target.closest('[data-bcc-hash]');
			if (row !== null) {
				const side = row.dataset.bccSide;
				const hash = row.dataset.bccHash || null;
				if (side === 'left') this.leftHash = hash;
				else if (side === 'right') this.rightHash = hash;
				this.render();
				return;
			}
			const act = <HTMLElement | null>e.target.closest('[data-bcc-act]');
			if (act === null) return;
			switch (act.dataset.bccAct) {
				case 'close':
					this.close();
					break;
				case 'swap': {
					const tmpB = this.leftBranch, tmpH = this.leftHash, tmpQ = this.leftQuery;
					this.leftBranch = this.rightBranch;
					this.leftHash = this.rightHash;
					this.leftQuery = this.rightQuery;
					this.rightBranch = tmpB;
					this.rightHash = tmpH;
					this.rightQuery = tmpQ;
					this.render();
					break;
				}
				case 'compare': {
					if (this.leftHash !== null && this.rightHash !== null && this.leftHash !== this.rightHash) {
						const lHash = this.leftHash, rHash = this.rightHash;
						const lLabel = this.leftBranch + ' (' + abbrevCommit(lHash) + ')';
						const rLabel = this.rightBranch + ' (' + abbrevCommit(rHash) + ')';
						this.close();
						this.view.compareArbitraryCommits(lHash, rHash, lLabel, rLabel);
					}
					break;
				}
			}
		};
	}
}
