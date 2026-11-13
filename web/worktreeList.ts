const WORKTREE_ICON = '<svg class="toolbarIcon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.5V12a1 1 0 0 0 1 1h4.5"/><path d="M2 4.5a1 1 0 0 1 1-1h2.5l1 1.2H9"/><circle cx="12" cy="4" r="1.5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 5.5v5"/><path d="M12 8.5c-1.5 0-2.5.8-2.5 2.5"/></svg>';

/**
 * Implements the Worktrees button of the control bar (shown when the repository has more than one worktree), the list of the worktrees
 * it opens (with buttons to open or remove them, and to prune the worktrees whose folders no longer exist), and creating worktrees.
 */
class WorktreeList {
	private readonly view: GitGraphView;
	private worktrees: ReadonlyArray<GG.GitWorktree> = [];

	/**
	 * Construct a new WorktreeList instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		const buttonElem = document.getElementById('worktreeBtn')!;
		buttonElem.addEventListener('click', (e) => this.toggleList(buttonElem, e));
		document.addEventListener('click', () => this.closeList());
	}

	/**
	 * Request the worktrees of the current repository (when it's loaded or refreshed).
	 */
	public requestWorktrees() {
		sendMessage({ command: 'loadWorktrees', repo: this.view.currentRepo });
	}

	/**
	 * Process the worktrees loaded by the extension.
	 * @param msg The message containing the worktrees.
	 */
	public processLoadWorktreesResponse(msg: GG.ResponseLoadWorktrees) {
		if (msg.repo !== this.view.currentRepo) return;
		const changed = JSON.stringify(msg.worktrees) !== JSON.stringify(this.worktrees);
		this.worktrees = msg.error === null ? msg.worktrees : [];
		this.renderButton();
		this.renderList();
		// The labels of the branches that are checked out in other worktrees are marked
		if (changed) this.view.renderBranchesInWorktrees();
	}

	/**
	 * Clear the worktrees (when a different repository is loaded).
	 */
	public clear() {
		this.worktrees = [];
		this.closeList();
		this.renderButton();
	}

	/**
	 * Get the worktree (other than the current one) that a branch is checked out in.
	 * @param branch The name of the branch.
	 * @returns The worktree, or NULL if the branch isn't checked out in another worktree.
	 */
	public getOtherWorktreeOfBranch(branch: string) {
		const worktree = this.worktrees.find((worktree) => worktree.branch === branch && !worktree.isCurrent);
		return typeof worktree !== 'undefined' ? worktree : null;
	}

	/**
	 * Render the Worktrees button in the control bar.
	 */
	private renderButton() {
		const buttonElem = document.getElementById('worktreeBtn')!;
		buttonElem.innerHTML = WORKTREE_ICON + '<span class="pillLabel">' + t('Worktrees') + '</span><span class="pillValue">' + this.worktrees.length + '</span>' + SVG_ICONS.chevron;
		buttonElem.title = t('View the worktrees of this repository');
		alterClass(buttonElem, 'hidden', this.worktrees.length < 2);
	}

	/**
	 * Open (or close) the list of the worktrees below the Worktrees button.
	 * @param buttonElem The Worktrees button.
	 * @param e The click event on the button.
	 */
	private toggleList(buttonElem: HTMLElement, e: Event) {
		handledEvent(e); // Don't let the click propagate to the document, which closes the list
		if (this.isListOpen()) {
			this.closeList();
			return;
		}
		closeDialogAndContextMenu();
		const listElem = document.createElement('div');
		listElem.id = 'worktreeList';
		listElem.className = 'popoverList';
		const bounds = buttonElem.getBoundingClientRect();
		listElem.style.left = Math.max(Math.min(bounds.left, window.innerWidth - 572), 8) + 'px';
		listElem.style.top = (bounds.bottom + 6) + 'px';
		document.body.appendChild(listElem);
		buttonElem.classList.add(CLASS_ACTIVE);
		this.renderList();
		this.requestWorktrees();

		listElem.addEventListener('click', (e) => {
			handledEvent(e);
			const target = <Element>e.target;
			if (target.closest('#worktreeListPrune') !== null) {
				this.closeList();
				dialog.showConfirmation(t('Are you sure you want to prune the worktrees whose folders no longer exist?'), t('Yes, prune'), () => {
					runAction({ command: 'pruneWorktrees', repo: this.view.currentRepo }, t('Pruning Worktrees'));
				}, null);
				return;
			}
			const itemElem = <HTMLElement | null>target.closest('.stashListItem'), actionElem = <HTMLElement | null>target.closest('.stashListAction');
			const worktree = itemElem !== null ? this.worktrees[parseInt(itemElem.dataset.index!)] : undefined;
			if (typeof worktree === 'undefined' || (actionElem !== null && actionElem.classList.contains(CLASS_DISABLED))) return;
			this.closeList();
			if (actionElem !== null && actionElem.dataset.action === 'open') {
				runAction({ command: 'openWorktree', path: worktree.path }, t('Opening Worktree'));
			} else if (actionElem !== null && actionElem.dataset.action === 'remove') {
				this.removeWorktreeAction(worktree);
			} else if (worktree.head !== null && typeof this.view.commitLookup[worktree.head] === 'number') {
				// Go to the commit checked out in the worktree
				this.view.scrollToCommit(worktree.head, true, true);
			}
		});
	}

	/**
	 * Render the list of the worktrees (if it's open).
	 */
	private renderList() {
		const listElem = document.getElementById('worktreeList');
		if (listElem === null) return;
		const name = (worktree: GG.GitWorktree) => worktree.path.substring(worktree.path.lastIndexOf('/') + 1);
		listElem.innerHTML = '<div class="stashListHeader"><b>' + t('Worktrees') + ' · ' + this.worktrees.length + '</b><span>' + t('Click on a worktree to go to the commit checked out in it') + '</span></div>' +
			'<div class="stashListItems">' + this.worktrees.map((worktree, index) => {
			const canRemove = !worktree.isMain && !worktree.isCurrent;
			return '<div class="stashListItem worktreeListItem" data-index="' + index + '"><span class="stashListSelector">' + escapeHtml(worktree.branch !== null ? worktree.branch : (worktree.head !== null ? abbrevCommit(worktree.head) : '')) + '</span>' +
					'<span class="stashListMessage" title="' + escapeHtml(worktree.path) + '">' + escapeHtml(name(worktree)) + '</span>' +
					'<span class="stashListActions"><button type="button" class="stashListAction primary' + (worktree.isCurrent || worktree.prunable ? ' ' + CLASS_DISABLED : '') + '" data-action="open" tabindex="-1">' + t('Open in New Window') + '</button>' +
					'<button type="button" class="stashListAction danger' + (canRemove ? '' : ' ' + CLASS_DISABLED) + '" data-action="remove" tabindex="-1" title="' + (canRemove ? '' : worktree.isMain ? t('The main worktree can\'t be removed') : t('The worktree shown in the Git Map View can\'t be removed')) + '">' + t('Remove') + ELLIPSIS + '</button></span>' +
					'<span class="stashListMeta"><span class="worktreeListPath" title="' + escapeHtml(worktree.path) + '"><bdi>' + escapeHtml(worktree.path) + '</bdi></span>' +
					(worktree.branch === null ? '<span>' + t('Detached HEAD') + '</span>' : '') +
					(worktree.isCurrent ? '<span class="worktreeListBadge">' + t('Current') + '</span>' : '') +
					(worktree.isMain ? '<span class="worktreeListBadge">' + t('Main') + '</span>' : '') +
					(worktree.locked ? '<span class="worktreeListBadge">' + t('Locked') + '</span>' : '') +
					(worktree.prunable ? '<span class="stashListNotLoaded">' + t('The folder no longer exists') + '</span>' : '') +
					'</span></div>';
		}).join('') + '</div>' +
			'<div class="stashListFooter">' + (this.worktrees.some((worktree) => worktree.prunable) ? '<button type="button" id="worktreeListPrune" class="stashListAction" tabindex="-1">' + t('Prune') + ELLIPSIS + '</button>' : '') +
			'<span class="stashListSpacer"></span><span>' + t('Create a worktree from the context menu of a branch or commit') + '</span></div>';
	}

	/**
	 * Close the list of the worktrees (if it's open).
	 */
	public closeList() {
		const listElem = document.getElementById('worktreeList');
		if (listElem === null) return;
		listElem.remove();
		document.getElementById('worktreeBtn')!.classList.remove(CLASS_ACTIVE);
	}

	/**
	 * Is the list of the worktrees open.
	 */
	public isListOpen() {
		return document.getElementById('worktreeList') !== null;
	}

	/**
	 * Remove a worktree (after confirming it). Forcing the removal also removes the worktree if it has uncommitted changes or untracked
	 * files (which are lost).
	 * @param worktree The worktree.
	 */
	private removeWorktreeAction(worktree: GG.GitWorktree) {
		dialog.asDangerous().showForm(t('Are you sure you want to remove the worktree <b><i>{0}</i></b>? Its folder is deleted (its branch is kept).', escapeHtml(worktree.path)), [
			{ type: DialogInputType.Checkbox, name: t('Force'), value: false, info: t('Remove the worktree even if it has uncommitted changes or untracked files, which are lost.') }
		], t('Yes, remove'), (values) => {
			runAction({ command: 'removeWorktree', repo: this.view.currentRepo, path: worktree.path, force: <boolean>values[0] }, t('Removing Worktree'));
		}, null);
	}

	/**
	 * Create a worktree (after asking for its folder): for a branch (which is checked out in it), or at a commit (with a new branch, or a
	 * detached HEAD).
	 * @param ref The name of the branch, or the hash of the commit.
	 * @param isBranch Is `ref` a branch.
	 * @param target The target of the dialog.
	 */
	public createWorktreeAction(ref: string, isBranch: boolean, target: DialogTarget) {
		const repo = this.view.currentRepo, parent = repo.substring(0, repo.lastIndexOf('/'));
		const folder = (name: string) => parent + '/' + repo.substring(repo.lastIndexOf('/') + 1) + '-' + name.replace(/[\\/:*?"<>|\s]+/g, '-');
		const pathInput: DialogInput = { type: DialogInputType.Text, name: t('Folder'), default: folder(isBranch ? ref : abbrevCommit(ref)), placeholder: null, info: t('The folder of the new worktree (it must not exist, or be empty).') };
		const openInput: DialogInput = { type: DialogInputType.Checkbox, name: t('Open in a new window'), value: true };
		if (isBranch) {
			dialog.showForm(t('Create a worktree in which the branch <b><i>{0}</i></b> is checked out:', escapeHtml(ref)), [pathInput, openInput], t('Create Worktree'), (values) => {
				runAction({ command: 'addWorktree', repo: repo, path: <string>values[0], ref: ref, newBranch: null, open: <boolean>values[1] }, t('Creating Worktree'));
			}, target);
		} else {
			dialog.showForm(t('Create a worktree at commit <b><i>{0}</i></b>:', abbrevCommit(ref)), [
				pathInput,
				{ type: DialogInputType.Text, name: t('New Branch'), default: '', placeholder: t('Optional (a detached HEAD if empty)'), info: t('A new branch created at the commit, which is checked out in the worktree.') },
				openInput
			], t('Create Worktree'), (values) => {
				const newBranch = (<string>values[1]).trim();
				runAction({ command: 'addWorktree', repo: repo, path: <string>values[0], ref: ref, newBranch: newBranch !== '' ? newBranch : null, open: <boolean>values[2] }, t('Creating Worktree'));
			}, target);
		}
	}
}
