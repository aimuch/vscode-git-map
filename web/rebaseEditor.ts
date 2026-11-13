const REBASE_GRIP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="14" viewBox="0 0 10 14" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="7" cy="3" r="1.2"/><circle cx="3" cy="7" r="1.2"/><circle cx="7" cy="7" r="1.2"/><circle cx="3" cy="11" r="1.2"/><circle cx="7" cy="11" r="1.2"/></svg>';

const REBASE_ACTIONS: ReadonlyArray<GG.GitRebaseTodoItem['action']> = ['pick', 'reword', 'squash', 'fixup', 'drop'];

/**
 * Implements the Rebase Editor of an interactive rebase: the commits that are rebased (oldest first), which can be reordered (dragged,
 * or moved with their buttons), and how each commit is rebased (picked, reworded with a new message, squashed or fixed up into the
 * previous commit, or dropped). The rebase is run by the extension, without opening an editor.
 */
class RebaseEditor {
	private readonly view: GitGraphView;
	private base: string | null = null;
	private baseName: string = '';
	private items: { commit: GG.GitRebaseCommit, action: GG.GitRebaseTodoItem['action'], message: string }[] = [];
	private loading: boolean = false;
	private error: GG.ErrorInfo = null;
	private dragIndex: number = -1;

	/**
	 * Construct a new RebaseEditor instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Open the Rebase Editor for rebasing the current branch on a base.
	 * @param base The commit or branch the current branch is rebased on.
	 * @param baseName The name of the base (shown in the editor).
	 */
	public show(base: string, baseName: string) {
		this.close();
		closeDialogAndContextMenu();
		this.base = base;
		this.baseName = baseName;
		this.items = [];
		this.loading = true;
		this.error = null;
		const elem = document.createElement('div');
		elem.id = 'rebaseEditor';
		elem.innerHTML = '<div class="rebaseEditorPanel" role="dialog" aria-modal="true"></div>';
		document.body.appendChild(elem);
		this.observeEvents(elem);
		this.render();
		sendMessage({ command: 'loadRebaseCommits', repo: this.view.currentRepo, base: base });
	}

	/**
	 * Close the Rebase Editor.
	 */
	public close() {
		const elem = document.getElementById('rebaseEditor');
		if (elem !== null) elem.remove();
		this.base = null;
	}

	/**
	 * Is the Rebase Editor open.
	 */
	public isOpen() {
		return document.getElementById('rebaseEditor') !== null;
	}

	/**
	 * Process the commits that are rebased, loaded by the extension.
	 * @param msg The message containing the commits.
	 */
	public processLoadRebaseCommitsResponse(msg: GG.ResponseLoadRebaseCommits) {
		if (msg.base !== this.base) return;
		this.loading = false;
		this.error = msg.error;
		this.items = msg.commits.map((commit) => ({ commit: commit, action: 'pick', message: commit.message }));
		this.render();
	}

	/**
	 * Get the problem with the todo list (which prevents the rebase from being started).
	 * @returns The problem, or NULL if the todo list is valid.
	 */
	private getProblem() {
		const first = this.items.find((item) => item.action !== 'drop');
		if (typeof first !== 'undefined' && (first.action === 'squash' || first.action === 'fixup')) {
			return t('The first commit that isn\'t dropped can\'t be squashed or fixed up, as there\'s no previous commit to combine it with.');
		}
		const emptyMessage = this.items.find((item) => item.action === 'reword' && item.message.trim() === '');
		return typeof emptyMessage !== 'undefined' ? t('The new message of commit {0} is empty.', abbrevCommit(emptyMessage.commit.hash)) : null;
	}

	/**
	 * Render the Rebase Editor.
	 */
	private render() {
		const panelElem = document.querySelector('#rebaseEditor .rebaseEditorPanel');
		if (panelElem === null) return;
		const actionNames: { [action: string]: string } = { pick: t('Pick'), reword: t('Reword'), squash: t('Squash'), fixup: t('Fixup'), drop: t('Drop') };
		const actionInfo: { [action: string]: string } = {
			pick: t('Keep the commit'),
			reword: t('Keep the commit, and change its message'),
			squash: t('Combine the commit with the previous commit (keeping both messages)'),
			fixup: t('Combine the commit with the previous commit (discarding its message)'),
			drop: t('Remove the commit')
		};
		const problem = this.loading ? null : this.getProblem(), branch = this.view.gitBranchHead !== null ? '<b>' + escapeHtml(this.view.gitBranchHead) + '</b>' : t('the current branch');
		let body: string;
		if (this.loading) {
			body = '<div class="rebaseEditorMessage">' + SVG_ICONS.loading + t('Loading') + ELLIPSIS + '</div>';
		} else if (this.error !== null) {
			body = '<div class="rebaseEditorMessage error">' + escapeHtml(this.error) + '</div>';
		} else if (this.items.length === 0) {
			body = '<div class="rebaseEditorMessage">' + t('There aren\'t any commits to rebase.') + '</div>';
		} else {
			body = '<div class="rebaseEditorItems">' + this.items.map((item, index) => '<div class="rebaseEditorItem' + (item.action === 'drop' ? ' dropped' : '') + (item.action === 'squash' || item.action === 'fixup' ? ' combined' : '') + '" draggable="true" data-index="' + index + '">' +
				'<span class="rebaseEditorGrip" title="' + t('Drag to reorder') + '">' + REBASE_GRIP_ICON + '</span>' +
				'<select class="rebaseEditorAction" data-index="' + index + '" title="' + escapeHtml(actionInfo[item.action]) + '" tabindex="-1">' + REBASE_ACTIONS.map((action) => '<option value="' + action + '"' + (action === item.action ? ' selected' : '') + ' title="' + escapeHtml(actionInfo[action]) + '">' + actionNames[action] + '</option>').join('') + '</select>' +
				'<span class="rebaseEditorHash">' + abbrevCommit(item.commit.hash) + '</span>' +
				(item.action === 'reword'
					? '<textarea class="rebaseEditorMessageInput" data-index="' + index + '" rows="' + Math.min(Math.max(item.message.split('\n').length, 2), 6) + '" tabindex="-1">' + escapeHtml(item.message) + '</textarea>'
					: '<span class="rebaseEditorSubject" title="' + escapeHtml(item.commit.message) + '">' + escapeHtml(item.commit.subject) + '</span>') +
				'<span class="rebaseEditorMeta">' + escapeHtml(item.commit.author) + ' · ' + escapeHtml(formatRelativeDate(item.commit.date)) + '</span>' +
				'<span class="rebaseEditorMove"><span class="rebaseEditorMoveBtn' + (index === 0 ? ' ' + CLASS_DISABLED : '') + '" data-move="-1" data-index="' + index + '" title="' + t('Move Up') + '">' + SVG_ICONS.arrowUp + '</span><span class="rebaseEditorMoveBtn' + (index === this.items.length - 1 ? ' ' + CLASS_DISABLED : '') + '" data-move="1" data-index="' + index + '" title="' + t('Move Down') + '">' + SVG_ICONS.arrowDown + '</span></span>' +
				'</div>').join('') + '</div>';
		}
		panelElem.innerHTML = '<div class="rebaseEditorHeader"><h3>' + t('Interactive Rebase') + '</h3><span>' + t('Rebase {0} on {1}', branch, '<b>' + escapeHtml(this.baseName) + '</b>') + '</span></div>' +
			'<div class="rebaseEditorHint">' + t('The commits are rebased from the top (oldest) to the bottom (newest). Drag them to reorder them, and choose how each commit is rebased.') + '</div>' +
			body +
			'<div class="rebaseEditorFooter"><span id="rebaseEditorTerminal" class="rebaseEditorLink" title="' + t('Run the interactive rebase in a terminal (editing the todo list in the editor configured for Git)') + '">' + t('Open in Terminal') + ELLIPSIS + '</span>' +
			'<span class="rebaseEditorProblem">' + (problem !== null ? escapeHtml(problem) : '') + '</span>' +
			'<button type="button" id="rebaseEditorCancel" class="rebaseEditorBtn" tabindex="-1">' + t('Cancel') + '</button>' +
			'<button type="button" id="rebaseEditorStart" class="rebaseEditorBtn primary' + (this.loading || this.error !== null || this.items.length === 0 || problem !== null ? ' ' + CLASS_DISABLED : '') + '" tabindex="-1">' + t('Start Rebase') + '</button></div>';
	}

	/**
	 * Handle the events of the Rebase Editor: choosing actions, editing messages, reordering commits, and its buttons.
	 * @param elem The element of the Rebase Editor.
	 */
	private observeEvents(elem: HTMLElement) {
		elem.addEventListener('click', (e) => {
			const target = <Element>e.target;
			if (target === elem) {
				this.close(); // Clicking outside of the panel closes the editor
			} else if (target.closest('#rebaseEditorCancel') !== null) {
				this.close();
			} else if (target.closest('#rebaseEditorStart') !== null) {
				this.start();
			} else if (target.closest('#rebaseEditorTerminal') !== null) {
				this.openInTerminal();
			} else {
				const moveElem = <HTMLElement | null>target.closest('.rebaseEditorMoveBtn');
				if (moveElem !== null && !moveElem.classList.contains(CLASS_DISABLED)) {
					const index = parseInt(moveElem.dataset.index!);
					this.move(index, index + parseInt(moveElem.dataset.move!));
				}
			}
		});
		elem.addEventListener('change', (e) => {
			const target = <HTMLElement>e.target;
			if (target.classList.contains('rebaseEditorAction')) {
				this.items[parseInt(target.dataset.index!)].action = <GG.GitRebaseTodoItem['action']>(<HTMLSelectElement>target).value;
				this.render();
			}
		});
		elem.addEventListener('input', (e) => {
			const target = <HTMLElement>e.target;
			if (target.classList.contains('rebaseEditorMessageInput')) {
				this.items[parseInt(target.dataset.index!)].message = (<HTMLTextAreaElement>target).value;
				const problem = this.getProblem(), problemElem = elem.querySelector('.rebaseEditorProblem'), startElem = document.getElementById('rebaseEditorStart');
				if (problemElem !== null) problemElem.textContent = problem !== null ? problem : '';
				if (startElem !== null) alterClass(startElem, CLASS_DISABLED, problem !== null);
			}
		});
		elem.addEventListener('dragstart', (e) => {
			const itemElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.rebaseEditorItem') : null;
			if (itemElem === null || (e.target instanceof Element && e.target.closest('textarea, select') !== null)) return;
			this.dragIndex = parseInt(itemElem.dataset.index!);
			itemElem.classList.add('dragging');
			if (e.dataTransfer !== null) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/plain', itemElem.dataset.index!);
			}
		});
		elem.addEventListener('dragover', (e) => {
			const itemElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.rebaseEditorItem') : null;
			if (itemElem === null || this.dragIndex < 0) return;
			e.preventDefault();
			elem.querySelectorAll('.rebaseEditorItem.dropBefore, .rebaseEditorItem.dropAfter').forEach((other) => other.classList.remove('dropBefore', 'dropAfter'));
			const bounds = itemElem.getBoundingClientRect();
			itemElem.classList.add(e.clientY < bounds.top + bounds.height / 2 ? 'dropBefore' : 'dropAfter');
		});
		elem.addEventListener('drop', (e) => {
			const itemElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.rebaseEditorItem') : null;
			if (itemElem === null || this.dragIndex < 0) return;
			e.preventDefault();
			const index = parseInt(itemElem.dataset.index!), after = itemElem.classList.contains('dropAfter');
			const to = (after ? index + 1 : index) - (this.dragIndex < index || (after && this.dragIndex === index) ? 1 : 0);
			this.move(this.dragIndex, to);
			this.dragIndex = -1;
		});
		elem.addEventListener('dragend', () => {
			this.dragIndex = -1;
			elem.querySelectorAll('.rebaseEditorItem.dragging, .rebaseEditorItem.dropBefore, .rebaseEditorItem.dropAfter').forEach((other) => other.classList.remove('dragging', 'dropBefore', 'dropAfter'));
		});
	}

	/**
	 * Move a commit in the todo list.
	 * @param from The index of the commit.
	 * @param to The index it's moved to.
	 */
	private move(from: number, to: number) {
		if (from === to || to < 0 || to >= this.items.length) {
			this.render();
			return;
		}
		const item = this.items.splice(from, 1)[0];
		this.items.splice(to, 0, item);
		this.render();
	}

	/**
	 * Start the rebase (run by the extension).
	 */
	private start() {
		if (this.base === null || this.loading || this.error !== null || this.items.length === 0 || this.getProblem() !== null) return;
		const todo: GG.GitRebaseTodoItem[] = this.items.map((item) => ({ action: item.action, hash: item.commit.hash, message: item.action === 'reword' ? item.message : null }));
		const base = this.base;
		this.close();
		runAction({ command: 'rebaseInteractive', repo: this.view.currentRepo, base: base, todo: todo }, t('Rebasing on {0}', escapeHtml(this.baseName)));
	}

	/**
	 * Run the interactive rebase in a terminal instead.
	 */
	private openInTerminal() {
		if (this.base === null) return;
		const base = this.base;
		this.close();
		runAction({ command: 'rebase', repo: this.view.currentRepo, obj: base, actionOn: /^[0-9a-f]{40,64}$/.test(base) ? GG.RebaseActionOn.Commit : GG.RebaseActionOn.Branch, ignoreDate: false, interactive: true }, t('Launching Interactive Rebase'));
	}
}

/**
 * Implements the bar shown below the control bar while an operation is in progress in the repository (e.g. a rebase or merge that
 * stopped because of conflicts), with buttons to continue, skip or abort it.
 */
class OperationBar {
	private readonly view: GitGraphView;
	private readonly elem: HTMLElement;
	private operation: GG.GitOperation | null = null;

	/**
	 * Construct a new OperationBar instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		this.elem = document.getElementById('operationBar')!;
		this.elem.addEventListener('click', (e) => {
			const buttonElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.operationBarBtn') : null;
			if (buttonElem !== null && this.operation !== null) this.runAction(this.operation, <'continue' | 'skip' | 'abort' | 'scm'>buttonElem.dataset.action);
		});
	}

	/**
	 * Request the operation in progress in the current repository (when it's loaded or refreshed).
	 */
	public requestOperation() {
		sendMessage({ command: 'loadOperationInProgress', repo: this.view.currentRepo });
	}

	/**
	 * Render the operation in progress in the current repository.
	 * @param msg The message containing the operation.
	 */
	public processLoadOperationInProgressResponse(msg: GG.ResponseLoadOperationInProgress) {
		if (msg.repo !== this.view.currentRepo) return;
		this.render(msg.operation);
	}

	/**
	 * Render the bar.
	 * @param operation The operation in progress, or NULL if no operation is in progress.
	 */
	public render(operation: GG.GitOperation | null) {
		this.operation = operation;
		alterClass(this.elem, CLASS_ACTIVE, operation !== null);
		if (operation === null) {
			this.elem.innerHTML = '';
			return;
		}
		const descriptions: { [operation: string]: string } = {
			'rebase': t('A rebase is in progress. Resolve any conflicts (in the Source Control View), then continue the rebase.'),
			'merge': t('A merge is in progress. Resolve any conflicts (in the Source Control View), then commit the merge.'),
			'cherry-pick': t('A cherry pick is in progress. Resolve any conflicts (in the Source Control View), then continue the cherry pick.'),
			'revert': t('A revert is in progress. Resolve any conflicts (in the Source Control View), then continue the revert.')
		};
		const button = (action: string, label: string, className: string = '') => '<span class="operationBarBtn' + (className !== '' ? ' ' + className : '') + '" data-action="' + action + '">' + label + '</span>';
		this.elem.innerHTML = SVG_ICONS.alert + '<span class="operationBarText">' + descriptions[operation] + '</span><span class="operationBarSpacer"></span>' +
			button('scm', t('Open Source Control')) +
			button('continue', operation === 'merge' ? t('Commit Merge') : t('Continue'), 'primary') +
			(operation !== 'merge' ? button('skip', t('Skip Commit')) : '') +
			button('abort', t('Abort'), 'danger');
	}

	/**
	 * Continue, skip or abort the operation in progress (aborting it is confirmed), or open the Source Control View.
	 * @param operation The operation in progress.
	 * @param action The action.
	 */
	private runAction(operation: GG.GitOperation, action: 'continue' | 'skip' | 'abort' | 'scm') {
		if (action === 'scm') {
			sendMessage({ command: 'viewScm' });
		} else if (action === 'abort') {
			const names: { [operation: string]: string } = { 'rebase': t('the rebase'), 'merge': t('the merge'), 'cherry-pick': t('the cherry pick'), 'revert': t('the revert') };
			dialog.asDangerous().showConfirmation(t('Are you sure you want to abort {0}? The repository is returned to the state it was in before it started (the conflicts resolved so far are lost).', names[operation]), t('Yes, abort'), () => {
				runAction({ command: 'controlOperation', repo: this.view.currentRepo, operation: operation, action: action }, t('Aborting'));
			}, null);
		} else {
			runAction({ command: 'controlOperation', repo: this.view.currentRepo, operation: operation, action: action }, action === 'continue' ? t('Continuing') : t('Skipping'));
		}
	}
}
