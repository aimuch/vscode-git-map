/**
 * Implements "Clean Up Branches…" (at the bottom of the Branches dropdown): a list of the local branches that can be deleted (those merged
 * into the default branch, and those whose remote branch has been deleted), which deletes the selected branches together. Branches that
 * aren't merged are listed unselected, with the number of commits that would be lost. Deleting them can be undone.
 */
class BranchCleanup {
	private readonly view: GitGraphView;
	private candidates: ReadonlyArray<GG.GitBranchCleanupCandidate> | null = null;
	private defaultBranch: string | null = null;
	private error: GG.ErrorInfo = null;
	private readonly selected: Set<string> = new Set();
	private deleteOnRemote: boolean = false;

	/**
	 * Construct a new BranchCleanup instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Open the list of the branches that can be deleted (in the middle of the top of the view).
	 */
	public show() {
		this.close();
		closeDialogAndContextMenu();
		this.candidates = null;
		this.error = null;
		this.selected.clear();
		this.deleteOnRemote = false;
		const listElem = document.createElement('div');
		listElem.id = 'branchCleanup';
		listElem.setAttribute('role', 'dialog');
		listElem.setAttribute('aria-label', t('Clean Up Branches'));
		listElem.style.left = Math.max(Math.round((window.innerWidth - 600) / 2), 8) + 'px';
		listElem.style.top = (document.getElementById('controls')!.getBoundingClientRect().bottom + 6) + 'px';
		document.body.appendChild(listElem);
		listElem.addEventListener('click', (e) => this.onClick(e));
		listElem.addEventListener('change', (e) => this.onChange(e));
		this.render();
		sendMessage({ command: 'loadBranchCleanup', repo: this.view.currentRepo });
	}

	/**
	 * Close the list (if it's open).
	 */
	public close() {
		const listElem = document.getElementById('branchCleanup');
		if (listElem !== null) listElem.remove();
	}

	/**
	 * Is the list open.
	 */
	public isOpen() {
		return document.getElementById('branchCleanup') !== null;
	}

	/**
	 * Process the branches that can be deleted, loaded by the extension.
	 * @param msg The message containing the branches.
	 */
	public processLoadBranchCleanupResponse(msg: GG.ResponseLoadBranchCleanup) {
		if (msg.repo !== this.view.currentRepo) return;
		this.view.setBranchCleanupCount(msg.error === null ? msg.candidates.length : null);
		if (!this.isOpen()) return; // Only the number of branches was loaded (when the Branches dropdown was opened)
		this.candidates = msg.candidates;
		this.defaultBranch = msg.defaultBranch;
		this.error = msg.error;
		msg.candidates.forEach((candidate) => {
			if (candidate.unmergedCommits === 0) this.selected.add(candidate.name);
		});
		this.render();
	}

	/**
	 * Get the remote that merged branches are also deleted on (if chosen): origin, or the only remote.
	 */
	private getRemote() {
		return this.view.gitRemotes.includes('origin') ? 'origin' : this.view.gitRemotes.length === 1 ? this.view.gitRemotes[0] : null;
	}

	private render() {
		const listElem = document.getElementById('branchCleanup');
		if (listElem === null) return;
		const header = '<div class="stashListHeader"><b>' + t('Clean Up Branches') + '</b><span>' + (this.candidates === null ? '' : this.candidates.length === 0 ? t('No branches can be cleaned up.') : this.candidates.length !== 1 ? t('{0} local branches can be deleted', this.candidates.length) : t('1 local branch can be deleted')) + '</span><span class="stashListSpacer"></span>' +
			'<button type="button" class="compareIconBtn" data-action="close" aria-label="' + t('Close') + '" title="' + t('Close') + '">' + SVG_ICONS.close + '</button></div>';
		if (this.candidates === null || this.candidates.length === 0) {
			listElem.innerHTML = header + '<div class="branchCleanupMessage">' + (this.error !== null ? escapeHtml(this.error) : this.candidates === null ? SVG_ICONS.loading + t('Loading') + ELLIPSIS : t('Every local branch is either not merged into {0}, or still on its remote.', escapeHtml(this.defaultBranch !== null ? this.defaultBranch : t('the default branch')))) + '</div>';
			return;
		}
		const merged = this.candidates.filter((candidate) => candidate.merged), gone = this.candidates.filter((candidate) => !candidate.merged);
		const item = (candidate: GG.GitBranchCleanupCandidate) => {
			const notes: string[] = [];
			if (candidate.merged) notes.push(t('Merged into {0}', escapeHtml(this.defaultBranch!)));
			if (candidate.upstreamGone) notes.push(t('{0} is gone', escapeHtml(candidate.upstream!)));
			else if (candidate.upstream !== null) notes.push(escapeHtml(candidate.upstream));
			const warning = candidate.unmergedCommits > 0 ? '<span class="branchCleanupWarning">' + (candidate.unmergedCommits !== 1 ? t('Not merged: deleting it loses {0} commits', candidate.unmergedCommits) : t('Not merged: deleting it loses 1 commit')) + '</span>' : '';
			return '<label class="branchCleanupItem"><input type="checkbox" data-branch="' + escapeHtml(candidate.name) + '"' + (this.selected.has(candidate.name) ? ' checked' : '') + '><span class="customCheckbox"></span>' +
				'<span class="branchCleanupText"><span class="branchCleanupName">' + escapeHtml(candidate.name) + '</span><span class="stashListMeta">' + notes.map((note) => '<span>' + note + '</span>').join('') + warning + '</span></span>' +
				'<span class="branchCleanupDate" title="' + escapeHtml(formatLongDate(candidate.date)) + '">' + escapeHtml(formatRelativeDate(candidate.date)) + '</span></label>';
		};
		const remote = this.getRemote(), remoteBranches = this.getRemoteBranches(), count = this.selected.size;
		listElem.innerHTML = header + '<div class="stashListItems">' +
			(merged.length > 0 ? '<div class="branchCleanupGroup">' + t('Merged into {0}', escapeHtml(this.defaultBranch !== null ? this.defaultBranch : '')) + ' · ' + merged.length + '</div>' + merged.map(item).join('') : '') +
			(gone.length > 0 ? '<div class="branchCleanupGroup">' + t('Remote branch deleted') + ' · ' + gone.length + '</div>' + gone.map(item).join('') : '') + '</div>' +
			'<div class="branchCleanupFooter">' +
			(remote !== null && merged.some((candidate) => candidate.remotes.includes(remote)) ? '<label class="branchCleanupRemote"><input type="checkbox" data-action="deleteOnRemote"' + (this.deleteOnRemote ? ' checked' : '') + '><span class="customCheckbox"></span>' + t('Also delete the merged branches on {0}', escapeHtml(remote)) + '</label>' : '') +
			'<span class="stashListSpacer"></span><button type="button" class="roundedBtn" data-action="close">' + t('Cancel') + '</button>' +
			'<button type="button" class="roundedBtn branchCleanupDelete' + (count === 0 ? ' ' + CLASS_DISABLED : '') + '" data-action="delete"' + (count === 0 ? ' disabled' : '') + '>' + (count !== 1 ? t('Delete {0} Branches', count) : t('Delete 1 Branch')) + (this.deleteOnRemote && remoteBranches.length > 0 ? ' (+' + remoteBranches.length + ' ' + t('on {0}', escapeHtml(remote!)) + ')' : '') + '</button></div>';
	}

	/**
	 * Get the branches deleted on the remote (the selected merged branches that are on it, if chosen).
	 */
	private getRemoteBranches() {
		const remote = this.getRemote();
		if (!this.deleteOnRemote || remote === null || this.candidates === null) return [];
		return this.candidates.filter((candidate) => candidate.merged && this.selected.has(candidate.name) && candidate.remotes.includes(remote)).map((candidate) => ({ remote: remote, branch: candidate.name }));
	}

	private onChange(e: Event) {
		const input = e.target instanceof HTMLInputElement ? e.target : null;
		if (input === null) return;
		if (input.dataset.action === 'deleteOnRemote') {
			this.deleteOnRemote = input.checked;
		} else if (typeof input.dataset.branch === 'string') {
			if (input.checked) this.selected.add(input.dataset.branch); else this.selected.delete(input.dataset.branch);
		}
		this.render();
	}

	private onClick(e: MouseEvent) {
		handledEvent(e); // Clicks in the list don't close it
		const actionElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('button[data-action]') : null;
		if (actionElem === null) return;
		if (actionElem.dataset.action === 'close') {
			this.close();
		} else if (actionElem.dataset.action === 'delete' && this.selected.size > 0) {
			const branches = Array.from(this.selected), remoteBranches = this.getRemoteBranches();
			this.close();
			runAction({ command: 'deleteBranches', repo: this.view.currentRepo, branches: branches, remoteBranches: remoteBranches }, t('Deleting Branches'));
		}
	}
}
