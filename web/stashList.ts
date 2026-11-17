/**
 * Implements the Stashes button of the control bar, and the list of the stashes it opens (with their branch, date & changes, and
 * buttons to apply, pop or drop them).
 */
class StashList {
	private readonly view: GitGraphView;

	/**
	 * Construct a new StashList instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Render the Stashes button in the control bar (shown when the repository has stashes).
	 */
	public renderStashButton() {
		const stashBtn = document.getElementById('stashBtn')!, count = this.view.gitStashes.length;
		stashBtn.innerHTML = SVG_ICONS.stashes + '<span class="pillLabel">' + t('Stashes') + '</span><span class="pillValue">' + count + '</span>' + SVG_ICONS.chevron;
		stashBtn.title = t('View the stashes in this repository');
		alterClass(stashBtn, 'hidden', count === 0);
	}

	/**
	 * Show (or hide) the list of the stashes in the repository below the Stashes button.
	 * @param stashBtn The Stashes button.
	 * @param e The click event on the Stashes button.
	 */
	public showStashList(stashBtn: HTMLElement, e: Event) {
		handledEvent(e); // Don't let the click propagate to the document, which closes the list
		if (document.getElementById('stashList') !== null) {
			this.closeStashList();
			return;
		}
		closeDialogAndContextMenu();
		const listElem = document.createElement('div');
		listElem.id = 'stashList';
		const bounds = stashBtn.getBoundingClientRect();
		listElem.style.left = Math.max(Math.min(bounds.left, window.innerWidth - 572), 8) + 'px';
		listElem.style.top = (bounds.bottom + 6) + 'px';
		document.body.appendChild(listElem);
		stashBtn.classList.add(CLASS_ACTIVE);
		this.renderStashList();

		// Request the stats of the stashes that haven't been loaded
		const stashes = this.view.gitStashes.filter((stash) => typeof this.view.stashStats[stash.hash] === 'undefined');
		if (stashes.length > 0) {
			sendMessage({ command: 'loadStashStats', repo: this.view.currentRepo, stashes: stashes.map((stash) => ({ hash: stash.hash, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash })) });
		}

		listElem.addEventListener('click', (e) => {
			handledEvent(e);
			const target = <Element>e.target, itemElem = <HTMLElement | null>target.closest('.stashListItem');
			if (target.closest('#stashListStashChanges') !== null) {
				if (this.view.loadedCommits.length > 0 && this.view.loadedCommits[0].hash === UNCOMMITTED) {
					this.closeStashList();
					this.view.actions.stashUncommittedChangesAction(null);
				}
				return;
			}
			if (itemElem === null) return;
			const stash = this.view.gitStashes[parseInt(itemElem.dataset.index!)];
			if (typeof stash === 'undefined') return;
			const actionElem = <HTMLElement | null>target.closest('.stashListAction');
			const rowElem = findCommitElemWithId(getCommitElems(), this.view.getCommitId(stash.hash));
			const dialogTarget: DialogTarget | null = rowElem !== null ? { type: TargetType.Ref, elem: rowElem, hash: stash.hash, ref: stash.selector } : null;
			this.closeStashList();
			if (actionElem === null) {
				this.view.goToStash(stash);
			} else if (actionElem.dataset.action === 'apply') {
				this.view.actions.applyStashAction(stash.selector, dialogTarget);
			} else if (actionElem.dataset.action === 'pop') {
				this.view.actions.popStashAction(stash.selector, dialogTarget);
			} else if (actionElem.dataset.action === 'drop') {
				this.view.actions.dropStashAction(stash.selector, dialogTarget);
			}
		});
	}

	/**
	 * Render the list of the stashes in the repository (if it's open).
	 */
	public renderStashList() {
		const listElem = document.getElementById('stashList');
		if (listElem === null) return;
		const keybinding = this.view.config.keybindings.scrollToStash, isMac = /Mac/.test(navigator.platform), canStash = this.view.loadedCommits.length > 0 && this.view.loadedCommits[0].hash === UNCOMMITTED;
		const modifier = isMac ? '\u2318' : 'Ctrl+', shift = isMac ? '\u21e7' : 'Shift+';
		listElem.innerHTML = '<div class="stashListHeader"><b>' + MENU_ICONS.stash + t('Stashes') + ' · ' + this.view.gitStashes.length + '</b><span>' + t('Click on a stash to go to it on the graph, and open its details') + '</span></div>' +
			'<div class="stashListItems">' + this.view.gitStashes.map((stash, index) => {
			const stats = this.view.stashStats[stash.hash], branch = stash.message.match(/^(?:WIP on|On) ([^:]+):/);
			return '<div class="stashListItem" data-index="' + index + '"><span class="stashListSelector">' + escapeHtml(stash.selector.substring(5)) + '</span>' +
					'<span class="stashListMessage" title="' + escapeHtml(stash.message) + '">' + escapeHtml(stash.message) + '</span>' +
					'<span class="stashListActions"><button type="button" class="stashListAction primary" data-action="apply" tabindex="-1">' + MENU_ICONS.stashApply + t('Apply') + '</button><button type="button" class="stashListAction" data-action="pop" tabindex="-1">' + MENU_ICONS.stashPop + t('Pop') + '</button><button type="button" class="stashListAction danger" data-action="drop" tabindex="-1">' + MENU_ICONS.trash + t('Drop') + '</button></span>' +
					'<span class="stashListMeta">' + (branch !== null ? '<span>' + escapeHtml(branch[1]) + '</span>' : '') + '<span title="' + escapeHtml(formatLongDate(stash.date)) + '">' + escapeHtml(formatRelativeDate(stash.date)) + '</span>' +
					'<span>' + (typeof stats !== 'undefined'
				? (stats.files !== 1 ? t('{0} files', stats.files) : t('{0} file', stats.files)) + ' · <span class="fileTreeFileAdd">+' + stats.additions + '</span> <span class="fileTreeFileDel">\u2212' + stats.deletions + '</span>'
				: t('Loading') + ELLIPSIS) + '</span>' +
					(stash.untrackedFilesHash !== null ? '<span>' + t('Includes untracked files') + '</span>' : '') +
					(typeof this.view.commitLookup[stash.hash] !== 'number' ? '<span class="stashListNotLoaded">' + t('Not in the loaded commits') + '</span>' : '') +
					'</span></div>';
		}).join('') + '</div>' +
			'<div class="stashListFooter"><button type="button" id="stashListStashChanges" class="stashListAction' + (canStash ? '' : ' ' + CLASS_DISABLED) + '" title="' + (canStash ? t('Stash the uncommitted changes') : t('There aren\'t any uncommitted changes to stash')) + '" tabindex="-1">' + MENU_ICONS.stash + t('Stash Current Changes') + ELLIPSIS + '</button><span class="stashListSpacer"></span>' +
			(keybinding !== null ? '<span>' + t('{0} / {1}: go to the next / previous stash', modifier + keybinding.toUpperCase(), modifier + shift + keybinding.toUpperCase()) + '</span>' : '') + '</div>';
	}

	/**
	 * Close the list of the stashes in the repository (if it's open).
	 */
	public closeStashList() {
		const listElem = document.getElementById('stashList');
		if (listElem === null) return;
		listElem.remove();
		document.getElementById('stashBtn')!.classList.remove(CLASS_ACTIVE);
	}

	/**
	 * Is the list of the stashes in the repository open.
	 */
	public isStashListOpen() {
		return document.getElementById('stashList') !== null;
	}

	/**
	 * Process the stats of the stashes loaded by the extension.
	 * @param msg The message containing the stats.
	 */
	public processLoadStashStatsResponse(msg: GG.ResponseLoadStashStats) {
		Object.keys(msg.stats).forEach((hash) => this.view.stashStats[hash] = msg.stats[hash]);
		this.renderStashList();
	}
}
