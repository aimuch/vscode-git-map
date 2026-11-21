const ROW_ACTION_ICONS: { readonly [action: string]: string } = {
	createBranch: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><path d="M4.5 5v6"/><path d="M4.5 9.5c0-2.5 2-3 4.5-3"/><path d="M12 4v5M9.5 6.5h5"/></svg>',
	checkout: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="8" r="3"/><path d="M1.5 8h6M5 5.5L7.5 8 5 10.5"/></svg>',
	cherrypick: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="11.5" r="2.5"/><circle cx="11.5" cy="11.5" r="2.5"/><path d="M4.5 9c.5-3 3-5.5 6.5-6.5M11.5 9c-.5-2.5-.5-4.5-.5-6.5"/></svg>',
	copyHash: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4"/></svg>',
	more: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>'
};

/** Horizontal gap between the pointer and the floating pill (never under the pointer, so clicking a row doesn't trigger a button). */
const ROW_ACTIONS_POINTER_GAP = 22;
/** Click approach zone around the pill: moving toward/onto the pill keeps it steady for clicking; moving away glides it with the pointer. */
const ROW_ACTIONS_APPROACH_PAD = 22;
/** Minimum margin kept between the pill and the edges of the view / docked CDV. */
const ROW_ACTIONS_EDGE_MARGIN = 18;

/**
 * Floating action pill shown on the commit row under the pointer.
 * Follows the mouse pointer horizontally (with a steady click approach zone) or pins to the end of
 * the Description column / row via `git-map.commitRow.actionsPosition`.
 */
class RowActions {
	private readonly view: GitGraphView;
	private readonly elem: HTMLElement;
	private commitElem: HTMLElement | null = null;
	private target: (ContextMenuTarget & DialogTarget & CommitTarget) | null = null;
	private actions: ContextMenuActions = [];
	private shown: ContextMenuAction[] = [];

	constructor(view: GitGraphView) {
		this.view = view;
		this.elem = document.createElement('div');
		this.elem.id = 'rowActions';
		this.elem.setAttribute('role', 'toolbar');

		this.elem.addEventListener('click', (e) => {
			handledEvent(e);
			const buttonElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.rowAction') : null;
			if (buttonElem !== null) this.run(buttonElem);
		});
		['dblclick', 'contextmenu', 'mousedown'].forEach((type) => this.elem.addEventListener(type, (e) => e.stopPropagation()));
		this.elem.addEventListener('mouseleave', (e) => {
			if (!(e.relatedTarget instanceof Node) || !this.view.tableElem.contains(e.relatedTarget)) this.hide();
		});
	}

	public contains(node: EventTarget | null) {
		return node instanceof Node && this.elem.contains(node);
	}

	public isShownFor(commitElem: HTMLElement) {
		return this.commitElem === commitElem && this.elem.isConnected;
	}

	public show(commitElem: HTMLElement, clientX: number) {
		if (contextMenu.isOpen() || dialog.isOpen()) {
			this.hide();
			return;
		}
		if (commitElem === this.commitElem && this.elem.isConnected) {
			this.follow(clientX);
			return;
		}
		const commit = this.view.getCommitOfElem(commitElem);
		const contentElem = document.getElementById('content');
		if (
			commit === null ||
			commit.hash === UNCOMMITTED ||
			commit.stash !== null ||
			contentElem === null ||
			commitElem.getBoundingClientRect().top < this.view.getVisibleCommitsTop() - 4
		) {
			this.hide();
			return;
		}

		const target: ContextMenuTarget & DialogTarget & CommitTarget = { type: TargetType.Commit, hash: commit.hash, index: parseInt(commitElem.dataset.id!), elem: commitElem };
		const actions = this.view.actions.getCommitContextMenuActions(target);
		const actionMap = new Map<string, ContextMenuAction>();
		actions.forEach((group) => group.forEach((action) => {
			if (typeof action.id === 'string' && (action.visible || !actionMap.has(action.id))) {
				actionMap.set(action.id, action);
			}
		}));
		const shown = this.view.getRowActionsConfig().actions
			.map((id) => actionMap.get(id))
			.filter((action): action is ContextMenuAction => typeof action !== 'undefined' && action.visible);
		this.target = target;
		this.actions = actions;
		this.shown = shown;

		const safeAttr = (raw: string) => raw.replace(/<[^>]*>/g, '').replace(/"/g, '&quot;');
		const button = (action: string, title: string, icon: string) => {
			const clean = safeAttr(title);
			return '<button type="button" class="rowAction" data-action="' + action + '" data-tip="' + clean + '" aria-label="' + clean + '" tabindex="-1">' + icon + '</button>';
		};
		this.elem.innerHTML = shown.map((action) => button(action.id!, action.title, ROW_ACTION_ICONS[action.id!] || action.icon || '')).join('') +
			(shown.length > 0 ? '<span class="rowActionSep"></span>' : '') +
			button('more', t('More Actions') + ELLIPSIS, ROW_ACTION_ICONS.more);

		if (this.commitElem !== null) this.commitElem.classList.remove('rowActionsTarget');
		commitElem.classList.add('rowActionsTarget');
		this.commitElem = commitElem;
		if (this.elem.parentElement !== contentElem) contentElem.appendChild(this.elem);
		this.place(clientX, true);
	}

	public follow(clientX: number) {
		if (this.commitElem === null || !this.elem.isConnected) return;
		const bounds = this.elem.getBoundingClientRect();
		if (clientX < bounds.left - ROW_ACTIONS_APPROACH_PAD || clientX > bounds.right + ROW_ACTIONS_APPROACH_PAD) {
			this.place(clientX, false);
		}
	}

	private place(clientX: number, vertical: boolean) {
		const commitElem = this.commitElem, contentElem = this.elem.parentElement;
		if (commitElem === null || contentElem === null) return;
		const position = this.view.getRowActionsConfig().position;
		const contentBounds = contentElem.getBoundingClientRect();
		const rowBounds = commitElem.getBoundingClientRect();
		const viewBounds = this.view.viewElem.getBoundingClientRect();
		const cdvElem = document.getElementById('cdv');
		const cdvLeft = cdvElem !== null && cdvElem.classList.contains('docked') && cdvElem.classList.contains('right')
			? cdvElem.getBoundingClientRect().left
			: Infinity;
		const width = this.elem.offsetWidth;
		const minLeft = Math.max(viewBounds.left, rowBounds.left) + ROW_ACTIONS_EDGE_MARGIN;
		const maxLeft = Math.max(minLeft, Math.min(viewBounds.right, rowBounds.right, cdvLeft) - ROW_ACTIONS_EDGE_MARGIN - width);

		let left: number;
		if (position === 'Pointer') {
			left = clientX + ROW_ACTIONS_POINTER_GAP;
			if (left > maxLeft) left = clientX - ROW_ACTIONS_POINTER_GAP - width;
		} else {
			const cellElem = position === 'Row' ? commitElem : commitElem.querySelector('td.descriptionCol');
			const right = cellElem !== null ? cellElem.getBoundingClientRect().right : rowBounds.right;
			left = right - ROW_ACTIONS_EDGE_MARGIN - width;
		}
		left = Math.max(minLeft, Math.min(left, maxLeft));
		if (vertical) {
			this.elem.classList.remove('gliding');
			this.elem.classList.toggle('tip-below', rowBounds.top - this.view.getVisibleCommitsTop() < 28);
			this.elem.style.top = Math.round(rowBounds.top - contentBounds.top + (rowBounds.height - this.elem.offsetHeight) / 2) + 'px';
		} else {
			this.elem.classList.add('gliding');
		}
		this.elem.style.left = Math.round(left - contentBounds.left) + 'px';
	}

	public hide() {
		this.elem.classList.remove('gliding', 'tip-below');
		this.elem.remove();
		if (this.commitElem !== null) this.commitElem.classList.remove('rowActionsTarget');
		this.commitElem = null;
		this.target = null;
	}

	private run(buttonElem: HTMLElement) {
		const target = this.target;
		if (target === null) return;
		const actionId = buttonElem.dataset.action!;
		if (actionId === 'more') {
			const bounds = buttonElem.getBoundingClientRect();
			const moreActions = this.actions.concat([[{
				title: t('Customize Row Hover Buttons') + ELLIPSIS,
				icon: MENU_ICONS.settings,
				visible: true,
				onClick: () => this.view.openCdvActionsCustomizer('row')
			}]]);
			this.hide();
			contextMenu.show(moreActions, false, target, new MouseEvent('contextmenu', { clientX: Math.round(bounds.left), clientY: Math.round(bounds.bottom + 2) }), this.view.viewElem);
		} else {
			const action = this.shown.find((item) => item.id === actionId);
			if (typeof action !== 'undefined') action.onClick();
		}
	}
}
