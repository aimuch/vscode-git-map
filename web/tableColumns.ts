/**
 * Makes the columns of the commits resizable (remembered for each repository), and implements the menu that chooses the columns
 * that are shown (the context menu of the column headers).
 */
class TableColumns {
	private readonly view: GitGraphView;

	/**
	 * Construct a new TableColumns instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Get the width of the Branches / Tags column of the current repository.
	 * @returns The width (in pixels).
	 */
	public getRefsColumnWidth() {
		const width = this.view.gitRepos[this.view.currentRepo].refsColumnWidth;
		return typeof width === 'number' && width >= REFS_COLUMN_MIN_WIDTH ? width : REFS_COLUMN_DEFAULT_WIDTH;
	}

	/**
	 * Allow the Branches / Tags column to be resized by dragging the right edge of its header (the width is remembered for each repository).
	 * Double-clicking the edge resets the width.
	 */
	public makeRefsColumnResizable() {
		const handleElem = document.getElementById('refsColResize');
		if (handleElem === null) return;
		const setWidth = (width: number) => document.body.style.setProperty('--git-graph-refsColWidth', width + 'px');
		let mouseX = -1, startWidth = 0, width = 0, lastClick = 0;

		const processResizing: EventListener = (e) => {
			if (mouseX < 0) return;
			const maxWidth = Math.max(REFS_COLUMN_MIN_WIDTH, Math.round(this.view.viewElem.clientWidth * 0.5));
			width = Math.min(Math.max(startWidth + (<MouseEvent>e).clientX - mouseX, REFS_COLUMN_MIN_WIDTH), maxWidth);
			setWidth(width);
		};
		const stopResizing: EventListener = () => {
			if (mouseX < 0) return;
			mouseX = -1;
			eventOverlay.remove();
			// The overlay receives the clicks while resizing, so a double-click is detected here
			const now = performance.now();
			if (width === startWidth && now - lastClick < 400) {
				width = REFS_COLUMN_DEFAULT_WIDTH;
				setWidth(width);
			}
			lastClick = width === startWidth ? now : 0;
			this.view.saveRepoStateValue(this.view.currentRepo, 'refsColumnWidth', width);
			this.updateTruncatedRefLabels();
		};

		handleElem.addEventListener('mousedown', (e) => {
			handledEvent(e);
			mouseX = e.clientX;
			startWidth = width = this.getRefsColumnWidth();
			eventOverlay.create('colResize', processResizing, stopResizing);
		});
	}

	/**
	 * The labels in the Branches / Tags column are truncated when they don't fit (the first, most important label keeps most of the width).
	 * The cells whose labels are truncated have a tooltip listing all of their labels, and the labels that are cut off by the edge of the
	 * column fade out.
	 */
	public updateTruncatedRefLabels() {
		const containers = <HTMLElement[]>Array.from(this.view.tableElem.querySelectorAll('.refsColLabels'));
		// All widths are read before anything is changed, so that the layout is only calculated once
		const overflowing = containers.map((container) => container.scrollWidth > container.clientWidth + 1);
		const truncated = containers.map((container, i) => overflowing[i]
			|| Array.from(container.querySelectorAll<HTMLElement>('.gitRefName')).some((nameElem) => nameElem.scrollWidth > nameElem.clientWidth + 1));
		containers.forEach((container, i) => {
			const cell = container.parentElement!;
			alterClass(container, 'overflowing', overflowing[i]);
			if (truncated[i]) {
				cell.title = Array.from(container.querySelectorAll<HTMLElement>('.gitRefName, .gitRefHeadRemote.icon')).map((elem) => elem.dataset.fullref!).filter((name) => typeof name === 'string').join('\n');
			} else {
				cell.removeAttribute('title');
			}
		});
	}

	public makeTableResizable() {
		let colHeadersElem = document.getElementById('tableColHeaders')!, cols = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName('tableColHeader');
		let columnWidths: GG.ColumnWidth[], mouseX = -1, col = -1, colIndex = -1;

		const makeTableFixedLayout = () => {
			cols[0].style.width = columnWidths[0] + 'px';
			cols[0].style.padding = '';
			for (let i = 2; i < cols.length; i++) {
				cols[i].style.width = columnWidths[parseInt(cols[i].dataset.col!)] + 'px';
			}
			this.view.tableElem.className = 'fixedLayout';
			this.view.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
			this.view.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
		};

		for (let i = 0; i < cols.length; i++) {
			let col = parseInt(cols[i].dataset.col!);
			cols[i].innerHTML += (i > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');
		}

		let cWidths = this.view.gitRepos[this.view.currentRepo].columnWidths;
		if (cWidths === null) { // Initialise auto column layout if it is the first time viewing the repo.
			let defaults = this.view.config.defaultColumnVisibility;
			columnWidths = [COLUMN_AUTO, COLUMN_AUTO, defaults.date ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.author ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.commit ? COLUMN_AUTO : COLUMN_HIDDEN];
			this.view.saveColumnWidths(columnWidths);
		} else {
			columnWidths = [cWidths[0], COLUMN_AUTO, cWidths[1], cWidths[2], cWidths[3]];
		}

		if (columnWidths[0] !== COLUMN_AUTO) {
			// Table should have fixed layout
			makeTableFixedLayout();
		} else {
			// Table should have automatic layout
			this.view.tableElem.className = 'autoLayout';

			let colWidth = cols[0].offsetWidth, graphWidth = this.view.graph.getNaturalContentWidth();
			let maxWidth = Math.round(this.view.viewElem.clientWidth * 0.333);
			if (Math.max(graphWidth, colWidth) > maxWidth) {
				this.view.graph.limitMaxWidth(maxWidth);
				graphWidth = Math.min(this.view.graph.getContentWidth(), maxWidth);
				this.view.tableElem.className += ' limitGraphWidth';
				this.view.tableElem.style.setProperty(CSS_PROP_LIMIT_GRAPH_WIDTH, maxWidth + 'px');
			} else {
				this.view.graph.limitMaxWidth(-1);
				this.view.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
			}

			if (colWidth < Math.max(graphWidth, 64)) {
				cols[0].style.padding = '6px ' + Math.floor((Math.max(graphWidth, 64) - (colWidth - COLUMN_LEFT_RIGHT_PADDING)) / 2) + 'px';
			}
		}

		const processResizingColumn: EventListener = (e) => {
			if (col > -1) {
				let mouseEvent = <MouseEvent>e;
				let mouseDeltaX = mouseEvent.clientX - mouseX;

				if (col === 0) {
					if (columnWidths[0] + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -columnWidths[0] + COLUMN_MIN_WIDTH;
					if (cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - COLUMN_MIN_WIDTH;
					columnWidths[0] += mouseDeltaX;
					cols[0].style.width = columnWidths[0] + 'px';
					this.view.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
				} else {
					let colWidth = col !== 1 ? columnWidths[col] : cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
					let nextCol = col + 1;
					while (columnWidths[nextCol] === COLUMN_HIDDEN) nextCol++;

					if (colWidth + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -colWidth + COLUMN_MIN_WIDTH;
					if (columnWidths[nextCol] - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = columnWidths[nextCol] - COLUMN_MIN_WIDTH;
					if (col !== 1) {
						columnWidths[col] += mouseDeltaX;
						cols[colIndex].style.width = columnWidths[col] + 'px';
					}
					columnWidths[nextCol] -= mouseDeltaX;
					cols[colIndex + 1].style.width = columnWidths[nextCol] + 'px';
				}
				mouseX = mouseEvent.clientX;
			}
		};
		const stopResizingColumn: EventListener = () => {
			if (col > -1) {
				col = -1;
				colIndex = -1;
				mouseX = -1;
				eventOverlay.remove();
				this.view.saveColumnWidths(columnWidths);
			}
		};

		addListenerToClass('resizeCol', 'mousedown', (e) => {
			if (e.target === null) return;
			col = parseInt((<HTMLElement>e.target).dataset.col!);
			while (columnWidths[col] === COLUMN_HIDDEN) col--;
			mouseX = (<MouseEvent>e).clientX;

			let isAuto = columnWidths[0] === COLUMN_AUTO;
			for (let i = 0; i < cols.length; i++) {
				let curCol = parseInt(cols[i].dataset.col!);
				if (isAuto && curCol !== 1) columnWidths[curCol] = cols[i].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
				if (curCol === col) colIndex = i;
			}
			if (isAuto) makeTableFixedLayout();
			eventOverlay.create('colResize', processResizingColumn, stopResizingColumn);
		});

		colHeadersElem.addEventListener('contextmenu', (e: MouseEvent) => {
			handledEvent(e);

			const toggleColumnState = (col: number, defaultWidth: number) => {
				columnWidths[col] = columnWidths[col] !== COLUMN_HIDDEN ? COLUMN_HIDDEN : columnWidths[0] === COLUMN_AUTO ? COLUMN_AUTO : defaultWidth - COLUMN_LEFT_RIGHT_PADDING;
				this.view.saveColumnWidths(columnWidths);
				this.view.render();
			};

			const commitOrdering = getCommitOrdering(this.view.gitRepos[this.view.currentRepo].commitOrdering);
			const changeCommitOrdering = (repoCommitOrdering: GG.RepoCommitOrdering) => {
				this.view.saveRepoStateValue(this.view.currentRepo, 'commitOrdering', repoCommitOrdering);
				this.view.refresh(true);
			};

			contextMenu.show([
				[
					{
						title: t('Changes'),
						icon: MENU_ICONS.diff,
						visible: this.view.fileHistory === null,
						checked: this.view.isChangesColumnShown(),
						onClick: () => {
							this.view.saveRepoStateValue(this.view.currentRepo, 'showChangesColumn', !this.view.isChangesColumnShown());
							this.view.render();
							this.view.requestCommitStats(false);
						}
					},
					{
						title: t('Date'),
						icon: MENU_ICONS.calendar,
						visible: true,
						checked: columnWidths[2] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(2, 128)
					},
					{
						title: t('Author'),
						icon: MENU_ICONS.person,
						visible: true,
						checked: columnWidths[3] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(3, 128)
					},
					{
						title: t('Commit'),
						icon: MENU_ICONS.commit,
						visible: true,
						checked: columnWidths[4] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(4, 80)
					}
				],
				[
					{
						title: t('Freeze Column Headers'),
						icon: MENU_ICONS.pin,
						visible: true,
						checked: this.view.config.graph.freezeColumnHeaders,
						onClick: () => sendMessage({ command: 'updateExtensionSetting', key: 'graph.freezeColumnHeaders', value: !this.view.config.graph.freezeColumnHeaders })
					},
					{
						title: t('Freeze Footer'),
						icon: MENU_ICONS.pin,
						visible: true,
						checked: this.view.config.graph.freezeFooter,
						onClick: () => sendMessage({ command: 'updateExtensionSetting', key: 'graph.freezeFooter', value: !this.view.config.graph.freezeFooter })
					}
				],
				[
					{
						title: t('Commit Timestamp Order'),
						icon: MENU_ICONS.history,
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.Date,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Date)
					},
					{
						title: t('Author Timestamp Order'),
						icon: MENU_ICONS.calendar,
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.AuthorDate,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.AuthorDate)
					},
					{
						title: t('Topological Order'),
						icon: MENU_ICONS.branch,
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.Topological,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Topological)
					}
				]
			], true, null, e, this.view.viewElem);
		});
	}
}
