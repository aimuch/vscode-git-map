/**
 * What's needed to render the rows of the commits (computed when the table is rendered, and reused when the rows that are rendered
 * change as the view is scrolled).
 */
interface RowRenderContext {
	readonly colVisibility: { readonly date: boolean, readonly author: boolean, readonly commit: boolean };
	readonly currentHash: string | null;
	readonly vertexColours: ReadonlyArray<number>;
	readonly widthsAtVertices: ReadonlyArray<number>;
	readonly mutedCommits: ReadonlyArray<boolean>;
	readonly textFormatter: TextFormatter;
	readonly fileHistory: { readonly [hash: string]: GG.GitFileHistoryCommit } | null;
	readonly maxLinesChanged: number;
	readonly refsInColumn: boolean;
	readonly showChanges: boolean;
}

/**
 * Implements the Git Map View. Its parts are implemented in their own files: the context menus & actions (ViewActions), the columns of
 * the commits (TableColumns), the list of stashes (StashList), the files in the Commit Details View (CdvFileView), and the processing
 * of the messages from the extension (responses.ts). The public members of the view are the state those parts use.
 */
class GitGraphView {
	public gitRepos: GG.GitRepoSet;
	public gitBranches: ReadonlyArray<string> = [];
	public gitBranchHead: string | null = null;
	public gitConfig: GG.GitRepoConfig | null = null;
	public gitRemotes: ReadonlyArray<string> = [];
	public gitStashes: ReadonlyArray<GG.GitStash> = [];
	private gitUpstreams: GG.GitBranchUpstreams = {};
	public gitTags: ReadonlyArray<string> = [];
	public commits: GG.GitCommit[] = [];
	public loadedCommits: GG.GitCommit[] = []; // All of the loaded commits (when only the matches of the Find Widget are shown, this.commits only contains them)
	private commitFilter: ReadonlySet<string> | null = null;
	public fileHistory: string | null = null; // The path of the file whose history is shown (NULL => all commits are shown)
	private fileHistoryLines: GG.GitLineRange | null = null; // The lines of the file whose history is shown (NULL => the whole file)
	private fileHistoryData: GG.GitFileHistory | null = null;
	private cdvShowWholeCommit: boolean = false;
	private commitStats: { [hash: string]: GG.GitCommitStats | null } = {}; // The files & lines changed by the loaded commits (shown in the Changes column)
	private readonly commitStatsRequested: Set<string> = new Set();
	private cdvFileDiff: { key: string, diff: string | null, error: GG.ErrorInfo } | null = null;
	private commitHead: string | null = null;
	public commitLookup: { [hash: string]: number } = {};
	public onlyFollowFirstParent: boolean = false;
	private avatars: AvatarImageCollection = {};
	private currentBranches: string[] | null = null;
	private currentAuthors: string[] | null = null;
	private knownAuthors: string[] = [];

	public currentRepo!: string;
	private currentRepoLoading: boolean = true;
	private currentRepoRefreshState: {
		inProgress: boolean;
		hard: boolean;
		loadRepoInfoRefreshId: number;
		loadCommitsRefreshId: number;
		repoInfoChanges: boolean;
		configChanges: boolean;
		requestingRepoInfo: boolean;
		requestingConfig: boolean;
	};
	private loadViewTo: GG.LoadGitGraphViewTo = null;

	public readonly graph: Graph;
	public readonly config: Config;

	private moreCommitsAvailable: boolean = false;
	private scrollToHeadPending: boolean = false;
	private cdvComparePending: boolean = false;
	private scrollToStashPending: { stash: GG.GitStash, attempts: number } | null = null;
	public stashStats: { [hash: string]: GG.GitStashStats } = {};
	public expandedCommit: ExpandedCommit | null = null;
	private rowContext: RowRenderContext | null = null;
	private renderedRows: { start: number, end: number } | null = null; // The rows rendered when they're virtualised (NULL => all rows are rendered)
	private readonly pinnedRows: Set<number> = new Set(); // Rows rendered outside of the rendered range (e.g. to open the details of a commit)
	private rowHeight: number | null = null; // The height of the rows of the commits (as rendered)
	private flashingHash: string | null = null; // The commit that's flashing (after being scrolled to)
	private selectedCommits: Set<string> = new Set(); // The commits selected with Shift (+ Ctrl / Cmd) + click
	private selectionAnchor: string | null = null; // The commit that a range of commits is selected from
	private maxCommits: number;
	private scrollTop = 0;
	private renderedGitBranchHead: string | null = null;

	private lastScrollToStash: {
		time: number,
		hash: string | null
	} = { time: 0, hash: null };

	public readonly actions: ViewActions;
	public readonly cdvFileView: CdvFileView;
	public readonly tableColumns: TableColumns;
	public readonly stashList: StashList;
	public readonly worktreeList: WorktreeList;
	public readonly rebaseEditor: RebaseEditor;
	private readonly operationBar: OperationBar;
	private readonly rowActions: RowActions;
	private readonly findWidget: FindWidget;
	private readonly settingsWidget: SettingsWidget;
	private readonly minimap: Minimap;
	private readonly scrollMarkers: ScrollMarkers;
	private readonly repoDropdown: Dropdown;
	public readonly branchDropdown: Dropdown;
	private readonly authorDropdown: Dropdown;

	public readonly viewElem: HTMLElement;
	private readonly controlsElem: HTMLElement;
	public readonly tableElem: HTMLElement;
	private readonly footerElem: HTMLElement;
	private readonly showRemoteBranchesElem: HTMLInputElement;
	private readonly refreshBtnElem: HTMLElement;
	private readonly undoBtnElem: HTMLElement;
	private readonly undoToastElem: HTMLElement;
	private undo: GG.UndoInfo | null = null; // The last action in the current repository that can be undone
	private lastUndoId: number = -1; // The id of the last action that could be undone (-1 => the repository is being loaded)
	private undoToastTimeout: number | null = null;
	private saveStatePending: boolean = false; // Is the state saved when the code that's running finishes
	private saveAvatarsTimeout: number | null = null;
	private readonly scrollShadowElem: HTMLElement;

	constructor(viewElem: HTMLElement, prevState: WebViewState | null) {
		this.gitRepos = initialState.repos;
		this.config = initialState.config;
		this.maxCommits = this.config.initialLoadCommits;
		this.viewElem = viewElem;
		this.actions = new ViewActions(this);
		this.rowActions = new RowActions(this);
		this.worktreeList = new WorktreeList(this);
		this.rebaseEditor = new RebaseEditor(this);
		this.operationBar = new OperationBar(this);
		this.cdvFileView = new CdvFileView(this);
		this.tableColumns = new TableColumns(this);
		this.stashList = new StashList(this);
		this.currentRepoRefreshState = {
			inProgress: false,
			hard: true,
			loadRepoInfoRefreshId: initialState.loadRepoInfoRefreshId,
			loadCommitsRefreshId: initialState.loadCommitsRefreshId,
			repoInfoChanges: false,
			configChanges: false,
			requestingRepoInfo: false,
			requestingConfig: false
		};

		this.controlsElem = document.getElementById('controls')!;
		this.tableElem = document.getElementById('commitTable')!;
		this.footerElem = document.getElementById('footer')!;
		this.scrollShadowElem = <HTMLInputElement>document.getElementById('scrollShadow')!;

		viewElem.focus();

		this.graph = new Graph('commitGraph', viewElem, this.config.graph, this.config.mute);
		this.graph.setAvatarSource((email) => typeof this.avatars[email] === 'string' ? this.avatars[email] : null);
		this.minimap = new Minimap(document.getElementById('minimap')!, (index) => {
			if (index < this.commits.length) this.scrollToCommit(this.commits[index].hash, true, true);
		}, (index) => {
			// The box of the commits in view is being dragged, so the commit is scrolled to the top of the view (below the sticky controls & frozen column headers)
			const elem = findCommitElemWithId(getCommitElems(), index);
			if (elem !== null) this.viewElem.scroll(0, this.viewElem.scrollTop + elem.getBoundingClientRect().top - this.getVisibleCommitsTop());
		}, (after, before) => this.findWidget.searchDateRange(after, before));
		this.scrollMarkers = new ScrollMarkers(viewElem);

		this.repoDropdown = new Dropdown('repoDropdown', true, false, 'Repos', (values) => {
			this.loadRepo(values[0]);
		});

		this.branchDropdown = new Dropdown('branchDropdown', false, true, 'Branches', (values) => {
			this.currentBranches = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});

		this.authorDropdown = new Dropdown('authorDropdown', false, true, 'Authors', (values) => {
			this.currentAuthors = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});

		this.showRemoteBranchesElem = <HTMLInputElement>document.getElementById('showRemoteBranchesCheckbox')!;
		this.showRemoteBranchesElem.addEventListener('change', () => {
			this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', this.showRemoteBranchesElem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
			this.refresh(true);
		});

		this.undoBtnElem = document.getElementById('undoBtn')!;
		this.undoBtnElem.innerHTML = SVG_ICONS.undo;
		this.undoBtnElem.addEventListener('click', () => this.undoAction());
		this.undoToastElem = document.createElement('div');
		this.undoToastElem.id = 'undoToast';
		this.undoToastElem.setAttribute('role', 'status');
		document.body.appendChild(this.undoToastElem);
		this.undoToastElem.addEventListener('click', (e) => {
			if (!(e.target instanceof Element)) return;
			if (e.target.closest('.undoToastAction') !== null) this.undoAction();
			if (e.target.closest('.undoToastAction, .undoToastClose') !== null) this.hideUndoToast();
		});

		this.refreshBtnElem = document.getElementById('refreshBtn')!;
		this.refreshBtnElem.addEventListener('click', () => {
			if (!this.refreshBtnElem.classList.contains(CLASS_REFRESHING)) {
				this.refresh(true, true);
			}
		});
		this.renderRefreshButton();

		this.findWidget = new FindWidget(this);
		this.settingsWidget = new SettingsWidget(this);
		this.observeOverviews();

		alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, this.config.referenceLabels.branchLabelsAlignedToGraph);
		alterClass(document.body, 'compactRows', this.config.graph.density === GG.GraphDensity.Compact);
		alterClass(document.body, 'freezeColumnHeaders', this.config.graph.freezeColumnHeaders);
		alterClass(document.body, 'freezeFooter', this.config.graph.freezeFooter);
		alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, this.config.referenceLabels.tagLabelsOnRight);

		this.observeWindowSizeChanges();
		this.observeWebviewStyleChanges();
		this.observeViewScroll();
		this.observeKeyboardEvents();
		this.observeMouseNavigationButtons();
		this.observeUrls();
		this.observeTableEvents();
		this.footerElem.addEventListener('click', (e) => {
			const actionElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.listFooterAction') : null;
			if (actionElem === null) return;
			const commits = this.getSelectedCommits();
			if (actionElem.dataset.action === 'cherrypick') {
				this.actions.cherrypickCommitsAction(commits, null);
			} else if (actionElem.dataset.action === 'copyHashes') {
				this.actions.copyCommitsToClipboard(commits, false);
			} else {
				this.clearCommitSelection();
			}
		});

		if (prevState && !prevState.currentRepoLoading && typeof this.gitRepos[prevState.currentRepo] !== 'undefined') {
			this.currentRepo = prevState.currentRepo;
			this.currentBranches = prevState.currentBranches;
			this.currentAuthors = prevState.currentAuthors || null;
			this.knownAuthors = prevState.knownAuthors || [];
			this.maxCommits = prevState.maxCommits;
			this.expandedCommit = prevState.expandedCommit;
			this.avatars = prevState.avatars;
			this.gitConfig = prevState.gitConfig;
			this.loadRepoInfo(prevState.gitBranches, prevState.gitBranchHead, prevState.gitRemotes, prevState.gitStashes, prevState.gitUpstreams || {}, true);
			this.fileHistory = prevState.fileHistory || null;
			this.fileHistoryLines = this.fileHistory !== null && prevState.fileHistoryLines ? prevState.fileHistoryLines : null;
			this.fileHistoryData = prevState.fileHistoryData || null;
			this.renderFileHistoryBar();
			this.loadCommits(prevState.commits, prevState.commitHead, prevState.gitTags, prevState.moreCommitsAvailable, prevState.onlyFollowFirstParent, this.fileHistoryData);
			this.findWidget.restoreState(prevState.findWidget);
			this.settingsWidget.restoreState(prevState.settingsWidget);
			this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[prevState.currentRepo].showRemoteBranchesV2);
		}

		let loadViewTo = initialState.loadViewTo;
		if (loadViewTo === null && prevState && prevState.currentRepoLoading && typeof prevState.currentRepo !== 'undefined') {
			loadViewTo = { repo: prevState.currentRepo };
		}

		if (!this.loadRepos(this.gitRepos, initialState.lastActiveRepo, loadViewTo)) {
			if (prevState) {
				this.scrollTop = prevState.scrollTop;
				this.viewElem.scroll(0, this.scrollTop);
			}
			this.requestLoadRepoInfoAndCommits(false, false);
		}

		sendMessage({ command: 'loadFileIconTheme' });

		const fetchBtn = document.getElementById('fetchBtn')!, scrollToHeadBtn = document.getElementById('scrollToHeadBtn')!, settingsBtn = document.getElementById('settingsBtn')!, terminalBtn = document.getElementById('terminalBtn')!;
		fetchBtn.title = this.config.fetchAndPrune ? t('Fetch & Prune from Remote(s)') : t('Fetch from Remote(s)');
		fetchBtn.innerHTML = SVG_ICONS.fetch + '<span>' + t('Fetch') + '</span>';
		fetchBtn.addEventListener('click', () => this.actions.fetchFromRemotesAction());
		document.getElementById('pullBtn')!.addEventListener('click', () => this.pullUpstreamAction());
		document.getElementById('pushBtn')!.addEventListener('click', () => {
			if (this.gitBranchHead !== null && this.gitRemotes.length > 0) this.actions.pushBranchAction(this.gitBranchHead, null);
		});
		document.getElementById('stashBtn')!.addEventListener('click', (e) => this.stashList.showStashList(<HTMLElement>e.currentTarget, e));
		document.addEventListener('click', () => this.stashList.closeStashList());
		scrollToHeadBtn.innerHTML = SVG_ICONS.head + '<span>HEAD</span>';
		scrollToHeadBtn.addEventListener('click', () => this.scrollToHead());
		settingsBtn.innerHTML = SVG_ICONS.gear;
		settingsBtn.addEventListener('click', () => this.settingsWidget.show(this.currentRepo));
		terminalBtn.innerHTML = SVG_ICONS.terminal;
		terminalBtn.addEventListener('click', () => {
			runAction({
				command: 'openTerminal',
				repo: this.currentRepo,
				name: this.gitRepos[this.currentRepo].name || getRepoName(this.currentRepo)
			}, t('Opening Terminal'));
		});
	}


	/* Loading Data */

	public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null, loadViewTo: GG.LoadGitGraphViewTo) {
		this.gitRepos = repos;
		this.saveState();

		let newRepo: string;
		if (loadViewTo !== null && this.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
			newRepo = loadViewTo.repo;
		} else if (typeof repos[this.currentRepo] === 'undefined') {
			newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
				? lastActiveRepo
				: getSortedRepositoryPaths(repos, this.config.repoDropdownOrder)[0];
		} else {
			newRepo = this.currentRepo;
		}

		alterClass(this.controlsElem, 'singleRepo', Object.keys(repos).length === 1);
		this.renderRepoDropdownOptions(newRepo);

		if (loadViewTo !== null) {
			if (loadViewTo.repo === newRepo) {
				this.loadViewTo = loadViewTo;
			} else {
				this.loadViewTo = null;
				showErrorMessage(t('Unable to load the Git Map View for the repository "{0}". It is not currently included in Git Map.', loadViewTo.repo));
			}
		} else {
			this.loadViewTo = null;
		}

		const fileHistory = loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.fileHistory === 'string' ? loadViewTo.fileHistory : null;
		const lineRange = fileHistory !== null && loadViewTo !== null && loadViewTo.lineRange ? loadViewTo.lineRange : null;
		if (this.currentRepo !== newRepo) {
			this.loadRepo(newRepo, fileHistory, lineRange);
			return true;
		} else if (fileHistory !== null) {
			this.setFileHistory(fileHistory, lineRange);
			return true;
		} else if (loadViewTo !== null && loadViewTo.repo === newRepo && loadViewTo.fileHistory === null && this.fileHistory !== null) {
			this.setFileHistory(null);
			return true;
		} else if (this.loadViewTo !== null && (this.currentRepoLoading || this.currentRepoRefreshState.inProgress)) {
			// The repository is being loaded (or refreshed), so the view is loaded to (e.g. the details of a commit are opened) once it has been
			return false;
		} else {
			this.finaliseRepoLoad(false);
			return false;
		}
	}

	private loadRepo(repo: string, fileHistory: string | null = null, lineRange: GG.GitLineRange | null = null) {
		this.fileHistory = fileHistory;
		this.fileHistoryLines = fileHistory !== null ? lineRange : null;
		this.fileHistoryData = null;
		this.renderFileHistoryBar();
		if (repo !== this.currentRepo) this.minimap.resetZoom();
		this.worktreeList.clear();
		this.rebaseEditor.close();
		this.operationBar.render(null);
		this.lastUndoId = -1;
		this.hideUndoToast();
		this.selectedCommits = new Set();
		this.selectionAnchor = null;
		this.currentRepo = repo;
		this.currentRepoLoading = true;
		this.scrollToHeadPending = false;
		this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[this.currentRepo].showRemoteBranchesV2);
		this.maxCommits = this.config.initialLoadCommits;
		this.gitConfig = null;
		this.gitRemotes = [];
		this.gitStashes = [];
		this.gitUpstreams = {};
		this.stashStats = {};
		this.commitStats = {};
		this.commitStatsRequested.clear();
		this.scrollToStashPending = null;
		this.stashList.closeStashList();
		this.gitTags = [];
		this.currentBranches = null;
		this.currentAuthors = null;
		this.knownAuthors = [];
		this.renderAuthorDropdown();
		this.renderFetchButton();
		this.renderSyncButtons();
		this.stashList.renderStashButton();
		this.closeCommitDetails(false);
		this.settingsWidget.close();
		this.saveState();
		this.refresh(true);
	}

	private loadRepoInfo(branchOptions: ReadonlyArray<string>, branchHead: string | null, remotes: ReadonlyArray<string>, stashes: ReadonlyArray<GG.GitStash>, upstreams: GG.GitBranchUpstreams, isRepo: boolean) {
		// Changes to this.gitStashes are reflected as changes to the commits when loadCommits is run
		this.gitStashes = stashes;
		this.gitUpstreams = upstreams;
		this.stashList.renderStashButton();
		if (stashes.length === 0) this.stashList.closeStashList(); else this.stashList.renderStashList();
		if (isRepo) this.renderSyncButtons(branchHead);

		if (!isRepo || (!this.currentRepoRefreshState.hard && arraysStrictlyEqual(this.gitBranches, branchOptions) && this.gitBranchHead === branchHead && arraysStrictlyEqual(this.gitRemotes, remotes))) {
			this.saveState();
			this.finaliseLoadRepoInfo(false, isRepo);
			return;
		}

		// Changes to these properties must be indicated as a repository info change
		this.gitBranches = branchOptions;
		this.gitBranchHead = branchHead;
		this.gitRemotes = remotes;

		// Update the state of the fetch button
		this.renderFetchButton();

		// Configure current branches
		if (this.currentBranches !== null && !(this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES)) {
			// Filter any branches that are currently selected, but no longer exist
			const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
			this.currentBranches = this.currentBranches.filter((branch) =>
				this.gitBranches.includes(branch) || globPatterns.includes(branch)
			);
		}
		if (this.currentBranches === null || this.currentBranches.length === 0) {
			// No branches are currently selected
			const onRepoLoadShowCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.gitRepos[this.currentRepo].onRepoLoadShowCheckedOutBranch);
			const onRepoLoadShowSpecificBranches = getOnRepoLoadShowSpecificBranches(this.gitRepos[this.currentRepo].onRepoLoadShowSpecificBranches);
			this.currentBranches = [];
			if (onRepoLoadShowSpecificBranches.length > 0) {
				// Show specific branches if they exist in the repository
				const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
				this.currentBranches.push(...onRepoLoadShowSpecificBranches.filter((branch) =>
					this.gitBranches.includes(branch) || globPatterns.includes(branch)
				));
			}
			if (onRepoLoadShowCheckedOutBranch && this.gitBranchHead !== null && !this.currentBranches.includes(this.gitBranchHead)) {
				// Show the checked-out branch, and it hasn't already been added as a specific branch
				this.currentBranches.push(this.gitBranchHead);
			}
			if (this.currentBranches.length === 0) {
				this.currentBranches.push(SHOW_ALL_BRANCHES);
			}
		}

		this.saveState();

		// Set up branch dropdown options
		this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);

		// Remove hidden remotes that no longer exist
		let hiddenRemotes = this.gitRepos[this.currentRepo].hideRemotes;
		let hideRemotes = hiddenRemotes.filter((hiddenRemote) => remotes.includes(hiddenRemote));
		if (hiddenRemotes.length !== hideRemotes.length) {
			this.saveRepoStateValue(this.currentRepo, 'hideRemotes', hideRemotes);
		}

		this.finaliseLoadRepoInfo(true, isRepo);
	}

	private finaliseLoadRepoInfo(repoInfoChanges: boolean, isRepo: boolean) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			if (isRepo) {
				refreshState.repoInfoChanges = refreshState.repoInfoChanges || repoInfoChanges;
				refreshState.requestingRepoInfo = false;
				this.requestLoadCommits();
			} else {
				dialog.closeActionRunning();
				refreshState.inProgress = false;
				this.loadViewTo = null;
				this.renderRefreshButton();
				sendMessage({ command: 'loadRepos', check: true });
			}
		}
	}

	private loadCommits(commits: GG.GitCommit[], commitHead: string | null, tags: ReadonlyArray<string>, moreAvailable: boolean, onlyFollowFirstParent: boolean, fileHistory: GG.GitFileHistory | null = null) {
		this.fileHistoryData = this.fileHistory !== null && fileHistory !== null && fileHistory.filePath === this.fileHistory && JSON.stringify(fileHistory.lineRange || null) === JSON.stringify(this.fileHistoryLines) ? fileHistory : null;
		// This list of tags is just used to provide additional information in the dialogs. Tag information included in commits is used for all other purposes (e.g. rendering, context menus)
		const tagsChanged = !arraysStrictlyEqual(this.gitTags, tags);
		this.gitTags = tags;

		if (!this.currentRepoLoading && !this.currentRepoRefreshState.hard && this.moreCommitsAvailable === moreAvailable && this.onlyFollowFirstParent === onlyFollowFirstParent && this.commitHead === commitHead && commits.length > 0 && arraysEqual(this.loadedCommits, commits, (a, b) =>
			a.hash === b.hash &&
			arraysStrictlyEqual(a.heads, b.heads) &&
			arraysEqual(a.tags, b.tags, (a, b) => a.name === b.name && a.annotated === b.annotated) &&
			arraysEqual(a.remotes, b.remotes, (a, b) => a.name === b.name && a.remote === b.remote) &&
			arraysStrictlyEqual(a.parents, b.parents) &&
			((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))
		) && this.renderedGitBranchHead === this.gitBranchHead) {

			if (this.loadedCommits[0].hash === UNCOMMITTED) {
				this.loadedCommits[0] = commits[0]; // Also updates this.commits, unless only the matches of the Find Widget are shown (which don't include the uncommitted changes)
				this.saveState();
				if (this.commitFilter === null) this.renderUncommittedChanges();
				if (this.commitFilter === null && this.expandedCommit !== null && this.expandedCommit.commitElem !== null) {
					if (this.expandedCommit.compareWithHash === null) {
						// Commit Details View is open
						if (this.expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(this.expandedCommit.commitHash, true);
						}
					} else {
						// Commit Comparison is open
						if (this.expandedCommit.compareWithElem !== null && (this.expandedCommit.commitHash === UNCOMMITTED || this.expandedCommit.compareWithHash === UNCOMMITTED)) {
							this.requestCommitComparison(this.expandedCommit.commitHash, this.expandedCommit.compareWithHash, true);
						}
					}
				}
			} else if (tagsChanged) {
				this.saveState();
			}
			this.finaliseLoadCommits();
			return;
		}

		const currentRepoLoading = this.currentRepoLoading;
		this.currentRepoLoading = false;
		this.moreCommitsAvailable = moreAvailable;
		this.onlyFollowFirstParent = onlyFollowFirstParent;
		this.loadedCommits = commits;
		this.commitHead = commitHead;
		if (this.findWidget.isFiltering()) this.commitFilter = this.findWidget.getMatchingHashes(commits);
		const avatarsNeeded = this.showCommits();
		this.renderFileHistoryBar();

		if (currentRepoLoading && this.config.onRepoLoad.scrollToHead && this.commitHead !== null) {
			this.scrollToCommit(this.commitHead, true);
		}

		this.finaliseLoadCommits();
		this.requestAvatars(avatarsNeeded);
	}

	/**
	 * Show the loaded commits (or only those that match the Find Widget, when only its matches are shown) in the view.
	 * @returns The avatars that need to be requested for the commits.
	 */
	private showCommits() {
		this.commits = this.commitFilter !== null ? filterCommits(this.loadedCommits, this.commitFilter) : this.loadedCommits;
		this.commitLookup = {};

		let i: number, expandedCommitVisible = false, expandedCompareWithCommitVisible = false, avatarsNeeded: { [email: string]: string[] } = {}, commit;
		for (i = 0; i < this.commits.length; i++) {
			commit = this.commits[i];
			this.commitLookup[commit.hash] = i;
			if (this.expandedCommit !== null) {
				if (this.expandedCommit.commitHash === commit.hash) {
					expandedCommitVisible = true;
				} else if (this.expandedCommit.compareWithHash === commit.hash) {
					expandedCompareWithCommitVisible = true;
				}
			}
			if (this.config.fetchAvatars && typeof this.avatars[commit.email] !== 'string' && commit.email !== '') {
				if (typeof avatarsNeeded[commit.email] === 'undefined') {
					avatarsNeeded[commit.email] = [commit.hash];
				} else {
					avatarsNeeded[commit.email].push(commit.hash);
				}
			}
		}

		if (this.expandedCommit !== null && (!expandedCommitVisible || (this.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
			this.closeCommitDetails(false);
		}

		this.saveState();

		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
		this.render();
		this.updateKnownAuthors();
		this.requestCommitStats(true);
		return avatarsNeeded;
	}

	/**
	 * Set the commits that are shown: only the commits that match the Find Widget, or all of the loaded commits.
	 * @param filter The hashes of the commits to show, or NULL to show all of the loaded commits.
	 */
	public setCommitFilter(filter: ReadonlySet<string> | null) {
		const current = this.commitFilter;
		if (filter === null ? current === null : current !== null && filter.size === current.size && Array.from(filter).every((hash) => current.has(hash))) return;
		this.commitFilter = filter;
		this.showCommits();
	}

	/**
	 * Get all of the loaded commits (including those not shown when only the matches of the Find Widget are shown).
	 * @returns The commits.
	 */
	public getLoadedCommits(): ReadonlyArray<GG.GitCommit> {
		return this.loadedCommits;
	}

	/**
	 * Get the date of the oldest loaded commit, used to limit searches to the loaded commits.
	 * @returns The unix timestamp of the date (less a day to allow for the difference between author & committer dates), or 0 if all commits are loaded.
	 */
	public getOldestLoadedCommitDate() {
		if (!this.moreCommitsAvailable) return 0;
		let oldest = Infinity;
		this.loadedCommits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.date < oldest) oldest = commit.date;
		});
		return oldest !== Infinity ? Math.max(oldest - 86400, 1) : 0;
	}

	/**
	 * Get the path of the repository currently shown in the view.
	 * @returns The path of the repository.
	 */
	public getCurrentRepo() {
		return this.currentRepo;
	}

	private finaliseLoadCommits() {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			dialog.closeActionRunning();

			if (dialog.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					dialog.close();
				} else {
					dialog.refresh(this.getCommits());
				}
			}

			if (contextMenu.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					contextMenu.close();
				} else {
					contextMenu.refresh(this.getCommits());
				}
			}

			refreshState.inProgress = false;
			this.renderRefreshButton();
		}

		this.finaliseRepoLoad(true);

		if (this.scrollToHeadPending) {
			this.scrollToHead();
		}
		if (this.scrollToStashPending !== null) {
			this.goToStash(this.scrollToStashPending.stash);
		}
	}

	private finaliseRepoLoad(didLoadRepoData: boolean) {
		let keepLoadViewTo = false;
		if (this.loadViewTo !== null && this.currentRepo === this.loadViewTo.repo) {
			if (this.loadViewTo.commitDetails && (this.expandedCommit === null || this.expandedCommit.commitHash !== this.loadViewTo.commitDetails.commitHash || this.expandedCommit.compareWithHash !== this.loadViewTo.commitDetails.compareWithHash)) {
				const commitIndex = this.getCommitId(this.loadViewTo.commitDetails.commitHash);
				const compareWithIndex = this.loadViewTo.commitDetails.compareWithHash !== null ? this.getCommitId(this.loadViewTo.commitDetails.compareWithHash) : null;
				const commitElem = this.getCommitElem(commitIndex);
				const compareWithElem = this.getCommitElem(compareWithIndex);

				if (commitElem !== null && (this.loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
					if (compareWithElem !== null) {
						this.loadCommitComparison(commitElem, compareWithElem);
					} else {
						this.loadCommitDetails(commitElem);
					}
				} else if (this.moreCommitsAvailable && compareWithIndex === null) {
					// The commit isn't loaded yet (e.g. the commit of the blame of a line), so more commits are loaded until it is
					keepLoadViewTo = true;
					if (!this.currentRepoRefreshState.inProgress) this.loadMoreCommits();
				} else {
					showErrorMessage(t('Unable to resume Code Review, it could not be found in the latest {0} commits that were loaded in this repository.', this.maxCommits));
				}
			} else if (this.loadViewTo.runCommandOnLoad) {
				switch (this.loadViewTo.runCommandOnLoad) {
					case 'fetch':
						this.actions.fetchFromRemotesAction();
						break;
				}
			}
		}
		if (!keepLoadViewTo) this.loadViewTo = null;

		if (this.gitConfig === null || (didLoadRepoData && this.currentRepoRefreshState.configChanges)) {
			this.requestLoadConfig();
		}
	}

	private clearCommits() {
		closeDialogAndContextMenu();
		this.moreCommitsAvailable = false;
		this.commits = [];
		this.loadedCommits = this.commits;
		this.commitHead = null;
		this.commitLookup = {};
		this.renderedGitBranchHead = null;
		this.closeCommitDetails(false);
		this.saveState();
		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
		this.tableElem.innerHTML = '';
		this.footerElem.innerHTML = '';
		this.renderGraph();
		this.findWidget.refresh();
	}

	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo) {
		if (msg.error === null) {
			const refreshState = this.currentRepoRefreshState;
			if (refreshState.inProgress && refreshState.loadRepoInfoRefreshId === msg.refreshId) {
				this.loadRepoInfo(msg.branches, msg.head, msg.remotes, msg.stashes, msg.upstreams, msg.isRepo);
				this.renderUndo(msg.undo);
				this.worktreeList.requestWorktrees();
				this.operationBar.requestOperation();
			}
		} else {
			this.displayLoadDataError(t('Unable to load Repository Info'), msg.error);
		}
	}

	public processSearchCommitsResponse(msg: GG.ResponseSearchCommits) {
		this.findWidget.processSearchCommitsResponse(msg);
	}

	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits) {
		if (msg.error === null) {
			const refreshState = this.currentRepoRefreshState;
			if (refreshState.inProgress && refreshState.loadCommitsRefreshId === msg.refreshId) {
				this.loadCommits(msg.commits, msg.head, msg.tags, msg.moreCommitsAvailable, msg.onlyFollowFirstParent, msg.fileHistory);
			}
		} else {
			const error = this.gitBranches.length === 0 && msg.error.indexOf('bad revision \'HEAD\'') > -1
				? t('There are no commits in this repository.')
				: msg.error;
			this.displayLoadDataError(t('Unable to load Commits'), error);
		}
	}

	public processLoadConfig(msg: GG.ResponseLoadConfig) {
		this.currentRepoRefreshState.requestingConfig = false;
		if (msg.config !== null && this.currentRepo === msg.repo) {
			this.gitConfig = msg.config;
			this.saveState();

			this.cdvFileView.renderCdvExternalDiffBtn();
		}
		this.settingsWidget.refresh();
	}

	private displayLoadDataError(message: string, reason: string) {
		this.clearCommits();
		this.currentRepoRefreshState.inProgress = false;
		this.loadViewTo = null;
		this.renderRefreshButton();
		dialog.showError(message, reason, t('Retry'), () => {
			this.refresh(true);
		});
	}

	public loadAvatar(email: string, image: string) {
		this.avatars[email] = image;
		this.saveStateAfterAvatars();
		this.graph.loadAvatar(email, image);
		let avatarsElems = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName('avatar');
		for (let i = 0; i < avatarsElems.length; i++) {
			// The value of the attribute is the email address itself (it's only escaped in the HTML it was written in)
			if (avatarsElems[i].dataset.email === email) {
				avatarsElems[i].innerHTML = '<img class="avatarImg" src="' + image + '">';
			}
		}
	}


	/* Getters */

	public getBranches(): ReadonlyArray<string> {
		return this.gitBranches;
	}

	public getBranchOptions(includeShowAll?: boolean): ReadonlyArray<DialogSelectInputOption> {
		const options: DialogSelectInputOption[] = [];
		if (includeShowAll) {
			options.push({ name: t('Show All'), value: SHOW_ALL_BRANCHES });
		}
		for (let i = 0; i < this.config.customBranchGlobPatterns.length; i++) {
			options.push({ name: 'Glob: ' + this.config.customBranchGlobPatterns[i].name, value: this.config.customBranchGlobPatterns[i].glob });
		}
		for (let i = 0; i < this.gitBranches.length; i++) {
			options.push({ name: this.gitBranches[i].indexOf('remotes/') === 0 ? this.gitBranches[i].substring(8) : this.gitBranches[i], value: this.gitBranches[i] });
		}
		return options;
	}

	/**
	 * Add the authors of the loaded commits to the authors that can be selected in the Authors Dropdown (the authors of all commits loaded in the repository during this session are retained, so that the filter can be changed while it's active).
	 */
	private updateKnownAuthors() {
		const authors = new Set(this.knownAuthors);
		if (this.currentAuthors !== null) {
			this.currentAuthors.forEach((author) => {
				if (author !== SHOW_ALL_BRANCHES) authors.add(author);
			});
		}
		this.commits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.author !== '') authors.add(commit.author);
		});
		if (authors.size !== this.knownAuthors.length) {
			this.knownAuthors = Array.from(authors).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
			this.saveState();
		}
		this.renderAuthorDropdown();
	}

	private renderAuthorDropdown() {
		// The number of loaded commits by each author (only known for the authors whose commits are loaded)
		const counts: { [author: string]: number } = {};
		this.loadedCommits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.stash === null) counts[commit.author] = (counts[commit.author] || 0) + 1;
		});
		const authorsLoaded = (author: string) => this.currentAuthors === null || this.currentAuthors.includes(SHOW_ALL_BRANCHES) || this.currentAuthors.includes(author);
		this.authorDropdown.setOptions(
			[<DropdownOption>{ name: t('Show All'), value: SHOW_ALL_BRANCHES }].concat(this.knownAuthors.map((author) => ({
				name: author,
				value: author,
				icon: generateAuthorInitialHtml(author, true),
				count: authorsLoaded(author) ? counts[author] || 0 : undefined
			}))),
			this.currentAuthors === null ? [SHOW_ALL_BRANCHES] : this.currentAuthors
		);
	}

	public getCommitId(hash: string) {
		return typeof this.commitLookup[hash] === 'number' ? this.commitLookup[hash] : null;
	}

	public getCommitOfElem(elem: HTMLElement) {
		let id = parseInt(elem.dataset.id!);
		return id < this.commits.length ? this.commits[id] : null;
	}

	public getCommits(): ReadonlyArray<GG.GitCommit> {
		return this.commits;
	}

	public getPushRemote(branch: string | null = null) {
		const possibleRemotes = [];
		if (this.gitConfig !== null) {
			if (branch !== null && typeof this.gitConfig.branches[branch] !== 'undefined') {
				possibleRemotes.push(this.gitConfig.branches[branch].pushRemote, this.gitConfig.branches[branch].remote);
			}
			possibleRemotes.push(this.gitConfig.pushDefault);
		}
		possibleRemotes.push('origin');
		return possibleRemotes.find((remote) => remote !== null && this.gitRemotes.includes(remote)) || this.gitRemotes[0];
	}

	public getRepoConfig(): Readonly<GG.GitRepoConfig> | null {
		return this.gitConfig;
	}

	public getRepoState(repo: string): Readonly<GG.GitRepoState> | null {
		return typeof this.gitRepos[repo] !== 'undefined'
			? this.gitRepos[repo]
			: null;
	}

	public isConfigLoading(): boolean {
		return this.currentRepoRefreshState.requestingConfig;
	}


	/* Refresh */

	public refresh(hard: boolean, configChanges: boolean = false) {
		if (hard) {
			this.clearCommits();
		}
		this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
	}


	/* Requests */

	private requestLoadRepoInfo() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadRepoInfo',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadRepoInfoRefreshId,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			showStashes: getShowStashes(repoState.showStashes),
			hideRemotes: repoState.hideRemotes
		});
	}

	private requestLoadCommits() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadCommits',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadCommitsRefreshId,
			branches: this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches,
			maxCommits: this.maxCommits,
			showTags: getShowTags(repoState.showTags),
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs),
			onlyFollowFirstParent: getOnlyFollowFirstParent(repoState.onlyFollowFirstParent),
			commitOrdering: getCommitOrdering(repoState.commitOrdering),
			remotes: this.gitRemotes,
			hideRemotes: repoState.hideRemotes,
			stashes: this.gitStashes,
			authors: this.currentAuthors === null || this.currentAuthors.includes(SHOW_ALL_BRANCHES) ? null : this.currentAuthors,
			filePath: this.fileHistory,
			lineRange: this.fileHistory !== null ? this.fileHistoryLines : null
		});
	}

	private requestLoadRepoInfoAndCommits(hard: boolean, skipRepoInfo: boolean, configChanges: boolean = false) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			refreshState.hard = refreshState.hard || hard;
			refreshState.configChanges = refreshState.configChanges || configChanges;
			if (!skipRepoInfo) {
				// This request will trigger a loadCommit request after the loadRepoInfo request has completed.
				// Invalidate any previous commit requests in progress.
				refreshState.loadCommitsRefreshId++;
			}
		} else {
			refreshState.hard = hard;
			refreshState.inProgress = true;
			refreshState.repoInfoChanges = false;
			refreshState.configChanges = configChanges;
			refreshState.requestingRepoInfo = false;
		}

		this.renderRefreshButton();
		if (this.commits.length === 0) {
			this.tableElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + t('Loading ...') + '</h2>';
		}

		if (skipRepoInfo) {
			if (!refreshState.requestingRepoInfo) {
				this.requestLoadCommits();
			}
		} else {
			refreshState.requestingRepoInfo = true;
			this.requestLoadRepoInfo();
		}
	}

	public requestLoadConfig() {
		this.currentRepoRefreshState.requestingConfig = true;
		sendMessage({ command: 'loadConfig', repo: this.currentRepo, remotes: this.gitRemotes });
		this.settingsWidget.refresh();
	}

	public requestCommitDetails(hash: string, refresh: boolean) {
		let commit = this.commits[this.commitLookup[hash]];
		sendMessage({
			command: 'commitDetails',
			repo: this.currentRepo,
			commitHash: hash,
			hasParents: commit.parents.length > 0,
			stash: commit.stash,
			avatarEmail: this.config.fetchAvatars && hash !== UNCOMMITTED ? commit.email : null,
			refresh: refresh
		});
	}

	public requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean) {
		let commitOrder = this.getCommitOrder(hash, compareWithHash);
		sendMessage({
			command: 'compareCommits',
			repo: this.currentRepo,
			commitHash: hash, compareWithHash: compareWithHash,
			fromHash: commitOrder.from, toHash: commitOrder.to,
			refresh: refresh
		});
	}

	private requestAvatars(avatars: { [email: string]: string[] }) {
		let emails = Object.keys(avatars), remote = this.gitRemotes.length > 0 ? this.gitRemotes.includes('origin') ? 'origin' : this.gitRemotes[0] : null;
		for (let i = 0; i < emails.length; i++) {
			sendMessage({ command: 'fetchAvatar', repo: this.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
		}
	}


	/* State */

	/**
	 * Save the state of the view (which is restored when the view is shown again). All of the state is serialised whenever it's saved
	 * (including every loaded commit), so it's saved once when the code that's running finishes, however often this is called by it.
	 */
	public saveState() {
		if (this.saveStatePending) return;
		this.saveStatePending = true;
		Promise.resolve().then(() => {
			this.saveStatePending = false;
			this.writeState();
		});
	}

	/**
	 * Save the state of the view once the avatars that are being loaded have been received (each avatar is received separately, and
	 * saving the state after each one would serialise all of the state & avatars again each time). Avatars that aren't saved before
	 * the view is hidden are requested again.
	 */
	private saveStateAfterAvatars() {
		if (this.saveAvatarsTimeout !== null) return;
		this.saveAvatarsTimeout = setTimeout(() => {
			this.saveAvatarsTimeout = null;
			this.saveState();
		}, 500);
	}

	private writeState() {
		let expandedCommit;
		if (this.expandedCommit !== null) {
			expandedCommit = Object.assign({}, this.expandedCommit);
			expandedCommit.commitElem = null;
			expandedCommit.compareWithElem = null;
			expandedCommit.contextMenuOpen = {
				summary: false,
				fileView: -1
			};
		} else {
			expandedCommit = null;
		}

		VSCODE_API.setState({
			currentRepo: this.currentRepo,
			currentRepoLoading: this.currentRepoLoading,
			gitRepos: this.gitRepos,
			gitBranches: this.gitBranches,
			gitBranchHead: this.gitBranchHead,
			gitConfig: this.gitConfig,
			gitRemotes: this.gitRemotes,
			gitStashes: this.gitStashes,
			gitUpstreams: this.gitUpstreams,
			gitTags: this.gitTags,
			commits: this.loadedCommits,
			fileHistory: this.fileHistory,
			fileHistoryLines: this.fileHistoryLines,
			fileHistoryData: this.fileHistoryData,
			commitHead: this.commitHead,
			avatars: this.avatars,
			currentBranches: this.currentBranches,
			currentAuthors: this.currentAuthors,
			knownAuthors: this.knownAuthors,
			moreCommitsAvailable: this.moreCommitsAvailable,
			maxCommits: this.maxCommits,
			onlyFollowFirstParent: this.onlyFollowFirstParent,
			expandedCommit: expandedCommit,
			scrollTop: this.scrollTop,
			findWidget: this.findWidget.getState(),
			settingsWidget: this.settingsWidget.getState()
		});
	}

	public saveRepoState() {
		sendMessage({ command: 'setRepoState', repo: this.currentRepo, state: this.gitRepos[this.currentRepo] });
	}

	public saveColumnWidths(columnWidths: GG.ColumnWidth[]) {
		this.gitRepos[this.currentRepo].columnWidths = [columnWidths[0], columnWidths[2], columnWidths[3], columnWidths[4]];
		this.saveRepoState();
	}

	private saveExpandedCommitLoading(index: number, commitHash: string, commitElem: HTMLElement, compareWithHash: string | null, compareWithElem: HTMLElement | null) {
		this.expandedCommit = {
			index: index,
			commitHash: commitHash,
			commitElem: commitElem,
			compareWithHash: compareWithHash,
			compareWithElem: compareWithElem,
			commitDetails: null,
			fileChanges: null,
			fileTree: null,
			avatar: null,
			codeReview: null,
			lastViewedFile: null,
			loading: true,
			scrollTop: {
				summary: 0,
				fileView: 0
			},
			contextMenuOpen: {
				summary: false,
				fileView: -1
			}
		};
		this.saveState();
	}

	/**
	 * Show or hide the remote branches (from the Repository Settings Widget, keeping the control bar's checkbox in sync).
	 * @param show TRUE => Show the remote branches, FALSE => Hide the remote branches.
	 */
	public setShowRemoteBranches(show: boolean) {
		if (this.showRemoteBranchesElem.checked === show) return;
		this.showRemoteBranchesElem.checked = show;
		this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', show ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
		this.refresh(true);
	}

	public saveRepoStateValue<K extends keyof GG.GitRepoState>(repo: string, key: K, value: GG.GitRepoState[K]) {
		if (repo === this.currentRepo) {
			this.gitRepos[this.currentRepo][key] = value;
			this.saveRepoState();
		}
	}


	/* Renderers */

	public render() {
		this.renderTable();
		this.renderGraph();
		this.renderOverviews();
	}

	/**
	 * Render the overviews of the loaded commits: the Minimap, and the markers alongside the scrollbar.
	 */
	private renderOverviews() {
		this.minimap.render(this.commits, this.commitHead, this.graph.getVertexColours(), this.config.graph.colours, this.config.graph.minimap);
		this.updateMinimapViewport();
		this.renderScrollMarkers();
	}

	/**
	 * Render the markers alongside the scrollbar, and the find matches on the minimap.
	 */
	public renderScrollMarkers() {
		this.minimap.setFindMatches(this.findWidget.getMatchHashes());
		this.scrollMarkers.render(this.commits, this.commitHead, this.graph.getVertexColours(), this.config.graph.colours, this.findWidget.getMatchHashes(), (index) => this.getVirtualRowCentre(index));
	}

	/**
	 * Show the commits that are visible in the view on the Minimap.
	 */
	private updateMinimapViewport() {
		const commitElems = getCommitElems();
		if (commitElems.length === 0) return;
		// The commits are only visible between the sticky controls (and the frozen column headers) and the footer (when it's frozen)
		const top = this.getVisibleCommitsTop(), bottom = Math.min(this.viewElem.getBoundingClientRect().bottom, this.footerElem.getBoundingClientRect().top);
		let low = 0, high = commitElems.length - 1, first = commitElems.length - 1, last: number;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (commitElems[mid].getBoundingClientRect().bottom > top) {
				first = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}
		low = first;
		high = commitElems.length - 1;
		last = first;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (commitElems[mid].getBoundingClientRect().top < bottom) {
				last = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		this.minimap.setViewport(parseInt(commitElems[first].dataset.id!), parseInt(commitElems[last].dataset.id!));
	}

	/**
	 * Keep the Minimap's viewport and the scrollbar markers up to date as the view is scrolled & resized.
	 */
	private observeOverviews() {
		let viewportFrame: number | null = null, markersFrame: number | null = null;
		this.viewElem.addEventListener('scroll', () => {
			if (viewportFrame !== null) return;
			viewportFrame = requestAnimationFrame(() => {
				viewportFrame = null;
				this.updateRenderedRows();
				this.updateMinimapViewport();
			});
		});
		const resizeObserver = new ResizeObserver(() => {
			document.body.style.setProperty('--git-graph-headerHeight', this.controlsElem.offsetHeight + 'px');
			if (markersFrame !== null) return;
			markersFrame = requestAnimationFrame(() => {
				markersFrame = null;
				this.updateRenderedRows();
				this.updateMinimapViewport();
				this.renderScrollMarkers();
			});
		});
		resizeObserver.observe(this.viewElem);
		resizeObserver.observe(this.controlsElem);
		resizeObserver.observe(document.getElementById('content')!);
	}

	private renderGraph() {
		if (typeof this.currentRepo === 'undefined') {
			// Only render the graph if a repo is loaded (or a repo is currently being loaded)
			return;
		}

		const colHeadersElem = document.getElementById('tableColHeaders');
		const cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
		const headerHeight = colHeadersElem !== null ? colHeadersElem.clientHeight + 1 : 0;
		const expandedCommit = this.isCdvDocked() ? null : this.expandedCommit;
		const expandedCommitElem = expandedCommit !== null ? document.getElementById('cdv') : null;

		// Update the graphs grid dimensions
		this.config.graph.grid.expandY = expandedCommitElem !== null
			? expandedCommitElem.getBoundingClientRect().height
			: cdvHeight;
		this.config.graph.grid.y = this.renderedRows !== null
			? this.getRowHeight() // The rows are virtualised, so they (and the spacers replacing them) all have the measured height
			: this.commits.length > 0 && this.tableElem.children.length > 0
				? (this.tableElem.children[0].clientHeight - headerHeight - (expandedCommit !== null ? cdvHeight : 0)) / this.commits.length
				: this.config.graph.grid.y;
		this.config.graph.grid.offsetY = headerHeight + this.config.graph.grid.y / 2;

		this.graph.render(expandedCommit);
	}

	private renderTable() {
		const colVisibility = this.getColumnVisibility();
		const currentHash = this.commits.length > 0 && this.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : this.commitHead;
		const vertexColours = this.graph.getVertexColours();
		const widthsAtVertices = this.config.referenceLabels.branchLabelsAlignedToGraph ? this.graph.getWidthsAtVertices() : [];
		const mutedCommits = this.graph.getMutedCommits(currentHash);
		const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
			emoji: true,
			issueLinking: true,
			markdown: this.config.markdown
		});

		const fileHistory = this.fileHistory !== null ? (this.fileHistoryData !== null ? this.fileHistoryData.commits : {}) : null;
		let maxLinesChanged = 1;
		if (fileHistory !== null) {
			Object.keys(fileHistory).forEach((hash) => maxLinesChanged = Math.max(maxLinesChanged, (fileHistory[hash].additions || 0) + (fileHistory[hash].deletions || 0)));
		}

		const refsInColumn = this.config.referenceLabels.inSeparateColumn, showChanges = this.isChangesColumnShown();
		alterClass(document.body, 'refsColumn', refsInColumn);
		if (refsInColumn) document.body.style.setProperty('--git-graph-refsColWidth', this.tableColumns.getRefsColumnWidth() + 'px');
		const headers = [
			'<th id="tableHeaderGraphCol" class="tableColHeader graphCol" data-col="0">' + t('Graph') + '</th>',
			'<th class="tableColHeader descriptionCol" data-col="1">' + t('Description') + '</th>'
		];
		if (refsInColumn) headers.unshift('<th class="refsCol">' + t('Branches / Tags') + '<span id="refsColResize" title="' + t('Drag to resize the column, double-click to reset its width') + '"></span></th>');
		if (colVisibility.date) headers.push('<th class="tableColHeader dateCol" data-col="2">' + t('Date') + '</th>');
		if (colVisibility.author) headers.push('<th class="tableColHeader authorCol" data-col="3">' + t('Author') + '</th>');
		if (fileHistory !== null) {
			headers.push('<th class="fileChangesCol">' + (this.fileHistoryLines !== null ? t('Changes to these Lines') : t('Changes to this File')) + '</th>');
		} else if (showChanges) {
			headers.push('<th class="changesCol">' + t('Changes') + '</th>');
		}
		if (colVisibility.commit) headers.push('<th class="tableColHeader" data-col="4">' + t('Commit') + '</th>');
		// The button to choose the columns is on the right of the last column header (whose name is truncated if they don't both fit)
		headers[headers.length - 1] = headers[headers.length - 1].replace(/^(<th[^>]*>)(.*)<\/th>$/, '$1<span class="lastColHeaderName">$2</span><span id="columnSettingsBtn" title="' + t('Choose the columns that are shown') + '">' + SVG_ICONS.columns + '</span></th>');
		let html = '<tr id="tableColHeaders">' + headers.join('') + '</tr>';

		const ctx: RowRenderContext = { colVisibility: colVisibility, currentHash: currentHash, vertexColours: vertexColours, widthsAtVertices: widthsAtVertices, mutedCommits: mutedCommits, textFormatter: textFormatter, fileHistory: fileHistory, maxLinesChanged: maxLinesChanged, refsInColumn: refsInColumn, showChanges: showChanges };
		this.rowContext = ctx;
		html += this.getRowsHtml(ctx);
		this.tableElem.innerHTML = '<table>' + html + '</table>';
		const countCommits = (commits: ReadonlyArray<GG.GitCommit>) => commits.filter((commit) => commit.hash !== UNCOMMITTED && commit.stash === null).length;
		const loaded = countCommits(this.loadedCommits), shown = countCommits(this.commits);
		this.footerElem.innerHTML = this.commits.length > 0
			? '<div id="listFooter"><span class="listFooterCount">' + (loaded !== 1 ? t('{0} commits loaded', loaded) : t('1 commit loaded')) + (shown !== loaded ? ' · ' + t('{0} shown', shown) : '') + '</span>' +
				'<span class="listFooterLegend">' + t('Scrollbar markers:') + '<span><i style="background-color:var(--vscode-focusBorder)"></i>HEAD</span><span><i style="background-color:' + escapeHtml(this.config.graph.colours[1 % this.config.graph.colours.length]) + '"></i>' + t('Branches') + '</span><span><i style="background-color:var(--vscode-descriptionForeground)"></i>' + t('Tags') + '</span><span><i style="background-color:var(--vscode-editorOverviewRuler-findMatchForeground, #d18616)"></i>' + t('Find Matches') + '</span></span>' +
				'<span id="listFooterSelection"></span><span class="listFooterSpacer"></span>' + (this.moreCommitsAvailable ? '<div id="loadMoreCommitsBtn" class="roundedBtn">' + t('Load More Commits') + '</div>' : '') + '</div>'
			: '';
		document.body.style.setProperty('--git-graph-colHeadersHeight', document.getElementById('tableColHeaders')!.offsetHeight + 'px');
		this.renderCommitSelection();
		this.renderBranchesInWorktrees();
		this.tableColumns.makeTableResizable();
		this.tableColumns.makeRefsColumnResizable();
		this.tableColumns.updateTruncatedRefLabels();
		this.measureRowHeight();
		const columnSettingsBtn = document.getElementById('columnSettingsBtn');
		if (columnSettingsBtn !== null) {
			columnSettingsBtn.addEventListener('click', (e) => {
				handledEvent(e); // Don't let the click propagate to the document, which closes context menus
				const bounds = columnSettingsBtn.getBoundingClientRect();
				document.getElementById('tableColHeaders')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom }));
			});
		}
		this.findWidget.refresh();
		this.renderedGitBranchHead = this.gitBranchHead;

		if (this.moreCommitsAvailable) {
			document.getElementById('loadMoreCommitsBtn')!.addEventListener('click', () => {
				this.loadMoreCommits();
			});
		}

		if (this.expandedCommit !== null) {
			const expandedCommit = this.expandedCommit, elems = getCommitElems();
			const commitElem = findCommitElemWithId(elems, this.getCommitId(expandedCommit.commitHash));
			const compareWithElem = expandedCommit.compareWithHash !== null ? findCommitElemWithId(elems, this.getCommitId(expandedCommit.compareWithHash)) : null;

			if (commitElem === null || (expandedCommit.compareWithHash !== null && compareWithElem === null)) {
				this.closeCommitDetails(false);
				this.saveState();
			} else {
				expandedCommit.index = parseInt(commitElem.dataset.id!);
				expandedCommit.commitElem = commitElem;
				expandedCommit.compareWithElem = compareWithElem;
				this.saveState();
				if (expandedCommit.compareWithHash === null) {
					// Commit Details View is open
					if (!expandedCommit.loading && expandedCommit.commitDetails !== null && expandedCommit.fileTree !== null) {
						this.showCommitDetails(expandedCommit.commitDetails, expandedCommit.fileTree, expandedCommit.avatar, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(expandedCommit.commitHash, true);
						}
					} else {
						this.loadCommitDetails(commitElem);
					}
				} else {
					// Commit Comparison is open
					if (!expandedCommit.loading && expandedCommit.fileChanges !== null && expandedCommit.fileTree !== null) {
						this.showCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, expandedCommit.fileChanges, expandedCommit.fileTree, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED || expandedCommit.compareWithHash === UNCOMMITTED) {
							this.requestCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, true);
						}
					} else {
						this.loadCommitComparison(commitElem, compareWithElem!);
					}
				}
			}
		}
	}

	/* Virtualised Rows */

	/**
	 * Are the rows of the commits virtualised: when there are many commits, only the rows near the view are rendered (unless the Commit
	 * Details View is inline, as it's inside the table).
	 * @returns TRUE => The rows are virtualised, FALSE => All rows are rendered.
	 */
	private isVirtualised() {
		return this.commits.length > VIRTUAL_ROWS_THRESHOLD && (this.expandedCommit === null || this.isCdvDocked());
	}

	/**
	 * Get the HTML of the rows of the commits. When the rows are virtualised, only the rows near the view (and the rows of the commits whose
	 * details are open) are rendered, the other rows are replaced by spacers of the same height, and the rows of the commits with the
	 * longest date & author are rendered collapsed, so that the widths of the columns don't change as the view is scrolled.
	 * @param ctx What's needed to render the rows.
	 * @returns The HTML.
	 */
	private getRowsHtml(ctx: RowRenderContext) {
		const numCommits = this.commits.length;
		let html = '';
		if (!this.isVirtualised()) {
			this.renderedRows = null;
			this.pinnedRows.clear();
			for (let i = 0; i < numCommits; i++) html += this.getCommitRowHtml(i, ctx);
			return html;
		}

		const inView = this.getRowsInView(), start = Math.max(inView.first - VIRTUAL_ROWS_BUFFER, 0), end = Math.min(inView.last + VIRTUAL_ROWS_BUFFER + 1, numCommits);
		this.renderedRows = { start: start, end: end };
		const pinned = new Set(this.pinnedRows);
		if (this.expandedCommit !== null) {
			[this.expandedCommit.commitHash, this.expandedCommit.compareWithHash].forEach((hash) => {
				const index = hash !== null ? this.getCommitId(hash) : null;
				if (index !== null) pinned.add(index);
			});
		}
		const indexes: number[] = [];
		for (let i = start; i < end; i++) indexes.push(i);
		pinned.forEach((index) => {
			if (index >= 0 && index < numCommits && (index < start || index >= end)) indexes.push(index);
		});
		indexes.sort((a, b) => a - b);

		const rowHeight = this.getRowHeight(), numColumns = this.getNumColumns();
		const spacer = (rows: number) => '<tr class="virtualSpacer" style="height:' + (rows * rowHeight) + 'px"><td colspan="' + numColumns + '"></td></tr>';
		html = this.getSizerRowsHtml(ctx);
		let next = 0;
		indexes.forEach((index) => {
			if (index > next) html += spacer(index - next);
			html += this.getCommitRowHtml(index, ctx);
			next = index + 1;
		});
		if (next < numCommits) html += spacer(numCommits - next);
		return html;
	}

	/**
	 * Get the HTML of the collapsed rows of the commits with the longest date & author (which determine the widths of their columns).
	 * @param ctx What's needed to render the rows.
	 * @returns The HTML.
	 */
	private getSizerRowsHtml(ctx: RowRenderContext) {
		let longestDate = -1, longestAuthor = -1, dateLength = 0, authorLength = 0;
		for (let i = 0; i < this.commits.length; i++) {
			const commit = this.commits[i];
			if (commit.hash === UNCOMMITTED) continue;
			if (ctx.colVisibility.date) {
				const length = formatShortDate(commit.date).formatted.length;
				if (length > dateLength) {
					dateLength = length;
					longestDate = i;
				}
			}
			if (commit.author.length > authorLength) {
				authorLength = commit.author.length;
				longestAuthor = i;
			}
		}
		return Array.from(new Set([longestDate, longestAuthor])).filter((index) => index > -1)
			.map((index) => this.getCommitRowHtml(index, ctx).replace(/^<tr [^>]*>/, '<tr class="virtualSizer" aria-hidden="true">')).join('');
	}

	/**
	 * Get the rows of the commits that are in view.
	 * @returns The indexes of the first & last rows in view.
	 */
	private getRowsInView() {
		const rowHeight = this.getRowHeight(), headersElem = document.getElementById('tableColHeaders'), lastIndex = Math.max(this.commits.length - 1, 0);
		const rowsTop = this.controlsElem.offsetHeight + (headersElem !== null ? headersElem.offsetHeight : 31);
		const top = this.viewElem.scrollTop + this.getCoveredTopHeight() - rowsTop, bottom = this.viewElem.scrollTop + this.viewElem.clientHeight - rowsTop;
		return {
			first: Math.min(Math.max(Math.floor(top / rowHeight), 0), lastIndex),
			last: Math.min(Math.max(Math.floor(bottom / rowHeight), 0), lastIndex)
		};
	}

	/**
	 * Get the height of the rows of the commits (as rendered, or the row height of the git-map.graph.density Extension Setting).
	 * @returns The height (in pixels).
	 */
	private getRowHeight() {
		if (this.rowHeight !== null) return this.rowHeight;
		const height = parseFloat(getComputedStyle(document.body).getPropertyValue('--git-graph-rowHeight'));
		return isNaN(height) || height <= 0 ? 32 : height;
	}

	/**
	 * Render the rows near the view again, if the view has been scrolled (or resized) so that rows that aren't rendered will soon be in view.
	 */
	private updateRenderedRows() {
		if (this.renderedRows === null || this.rowContext === null) return;
		const inView = this.getRowsInView(), margin = Math.floor(VIRTUAL_ROWS_BUFFER / 4);
		if ((inView.first - margin < this.renderedRows.start && this.renderedRows.start > 0) || (inView.last + margin >= this.renderedRows.end && this.renderedRows.end < this.commits.length)) {
			this.pinnedRows.clear();
			this.renderRows();
		}
	}

	/**
	 * Render the rows of the commits again (keeping the column headers), when the rows that are rendered change.
	 */
	private renderRows() {
		const headersElem = document.getElementById('tableColHeaders');
		if (headersElem === null || this.rowContext === null) return;
		while (headersElem.nextElementSibling !== null) headersElem.nextElementSibling.remove();
		headersElem.insertAdjacentHTML('afterend', this.getRowsHtml(this.rowContext));
		this.renderBranchesInWorktrees();
		this.tableColumns.updateTruncatedRefLabels();
		this.findWidget.highlightRenderedMatches();
		if (this.expandedCommit !== null) {
			const elems = getCommitElems();
			this.expandedCommit.commitElem = findCommitElemWithId(elems, this.getCommitId(this.expandedCommit.commitHash));
			this.expandedCommit.compareWithElem = this.expandedCommit.compareWithHash !== null ? findCommitElemWithId(elems, this.getCommitId(this.expandedCommit.compareWithHash)) : null;
		}
		this.measureRowHeight();
	}

	/**
	 * Measure the height of the rendered rows of the commits (used for the spacers that replace the rows that aren't rendered). If it's
	 * different to the height that was used, the rows are rendered again.
	 */
	private measureRowHeight() {
		if (this.renderedRows === null) return;
		const elems = getCommitElems();
		if (elems.length === 0) return;
		const height = elems[0].getBoundingClientRect().height;
		if (height > 0 && Math.abs(height - this.getRowHeight()) > 0.01) {
			this.rowHeight = height;
			this.renderRows();
		}
	}

	/**
	 * Get the element of the row of a commit, rendering the row if it isn't rendered (when the rows are virtualised).
	 * @param index The index of the commit.
	 * @returns The element, or NULL if there isn't a commit with the index.
	 */
	public getCommitElem(index: number | null) {
		if (index === null || index < 0 || index >= this.commits.length) return null;
		let elem = findCommitElemWithId(getCommitElems(), index);
		if (elem === null && this.renderedRows !== null) {
			this.pinnedRows.add(index);
			this.renderRows();
			elem = findCommitElemWithId(getCommitElems(), index);
		}
		return elem;
	}

	/**
	 * Get the vertical position of the centre of the row of a commit (in the content of the view), when the rows are virtualised.
	 * @param index The index of the commit.
	 * @returns The position, or NULL if the rows aren't virtualised.
	 */
	public getVirtualRowCentre(index: number) {
		if (this.renderedRows === null) return null;
		const headersElem = document.getElementById('tableColHeaders'), rowHeight = this.getRowHeight();
		return this.controlsElem.offsetHeight + (headersElem !== null ? headersElem.offsetHeight : 31) + (index + 0.5) * rowHeight;
	}

	/**
	 * Get the HTML of the row of a commit.
	 * @param i The index of the commit.
	 * @param ctx What's needed to render the rows (computed when the table is rendered).
	 * @returns The HTML.
	 */
	private getCommitRowHtml(i: number, ctx: RowRenderContext) {
		const { colVisibility, currentHash, vertexColours, widthsAtVertices, mutedCommits, textFormatter, fileHistory, maxLinesChanged, refsInColumn, showChanges } = ctx;
		let commit = this.commits[i];
		const fileChange = fileHistory !== null ? fileHistory[commit.hash] : undefined;
		let message = (typeof fileChange !== 'undefined' && fileChange.oldFilePath !== null ? '<span class="fileHistoryRenamed" title="' + escapeHtml(fileChange.oldFilePath + ' \u2192 ' + fileChange.filePath) + '">\u21aa ' + t('Renamed from {0}', escapeHtml(fileChange.oldFilePath)) + '</span>' : '') + '<span class="text">' + textFormatter.format(commit.message) + '</span>';
		let date = formatShortDate(commit.date);
		let branchLabels = getBranchLabels(commit.heads, commit.remotes);
		let refBranches = '', refTags = '', j, k, refName, remoteName, refActive, refHtml, branchCheckedOutAtCommit: string | null = null;

		for (j = 0; j < branchLabels.heads.length; j++) {
			refName = escapeHtml(branchLabels.heads[j].name);
			refActive = branchLabels.heads[j].name === this.gitBranchHead;
			refHtml = '<span class="gitRef head' + (refActive ? ' active' : '') + '" data-name="' + refName + '">' + (refActive && refsInColumn ? SVG_ICONS.check : SVG_ICONS.branch) + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span>';
			for (k = 0; k < branchLabels.heads[j].remotes.length; k++) {
				remoteName = escapeHtml(branchLabels.heads[j].remotes[k]);
				const remoteFullRef = escapeHtml(branchLabels.heads[j].remotes[k] + '/' + branchLabels.heads[j].name);
				refHtml += refsInColumn
					? '<span class="gitRefHeadRemote icon" data-remote="' + remoteName + '" data-fullref="' + remoteFullRef + '" title="' + t('{0} is at this commit', remoteFullRef) + '">' + SVG_ICONS.cloud + '</span>'
					: '<span class="gitRefHeadRemote" data-remote="' + remoteName + '" data-fullref="' + remoteFullRef + '">' + remoteName + '</span>';
			}
			refHtml += generateTrackingHtml(this.gitUpstreams[branchLabels.heads[j].name]) + '</span>';
			refBranches = refActive ? refHtml + refBranches : refBranches + refHtml;
			if (refActive) branchCheckedOutAtCommit = this.gitBranchHead;
		}
		for (j = 0; j < branchLabels.remotes.length; j++) {
			refName = escapeHtml(branchLabels.remotes[j].name);
			refBranches += '<span class="gitRef remote" data-name="' + refName + '" data-remote="' + (branchLabels.remotes[j].remote !== null ? escapeHtml(branchLabels.remotes[j].remote!) : '') + '">' + (refsInColumn ? SVG_ICONS.cloud : SVG_ICONS.branch) + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
		}

		for (j = 0; j < commit.tags.length; j++) {
			refName = escapeHtml(commit.tags[j].name);
			refTags += '<span class="gitRef tag" data-name="' + refName + '" data-tagtype="' + (commit.tags[j].annotated ? 'annotated' : 'lightweight') + '">' + SVG_ICONS.tag + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
		}

		if (commit.stash !== null) {
			refName = escapeHtml(commit.stash.selector);
			refBranches = '<span class="gitRef stash" data-name="' + refName + '">' + SVG_ICONS.stash + '<span class="gitRefName" data-fullref="' + refName + '">' + escapeHtml(commit.stash.selector.substring(5)) + '</span></span>' + refBranches;
		}

		const commitDot = commit.hash === this.commitHead
			? '<span class="commitHeadDot" title="' + (branchCheckedOutAtCommit !== null
				? t('The branch {0} is currently checked out at this commit', escapeHtml('"' + branchCheckedOutAtCommit + '"'))
				: t('This commit is currently checked out')
			) + '."></span>'
			: '';

		return '<tr class="commit' + (commit.hash === currentHash ? ' current' : '') + (mutedCommits[i] ? ' mute' : '') + (this.selectedCommits.has(commit.hash) ? ' multiSelected' : '') + (this.expandedCommit !== null && (this.expandedCommit.commitHash === commit.hash || this.expandedCommit.compareWithHash === commit.hash) ? ' ' + CLASS_COMMIT_DETAILS_OPEN : '') + (commit.hash === this.flashingHash ? ' flash' : '') + '"' + (commit.hash !== UNCOMMITTED ? '' : ' id="uncommittedChanges"') + ' data-id="' + i + '" data-color="' + vertexColours[i] + '">' +
			(refsInColumn
				? '<td class="refsCol">' + (refBranches !== '' || refTags !== '' ? '<span class="refsColLabels" style="--git-graph-refs:' + (branchLabels.heads.length + branchLabels.remotes.length + commit.tags.length + (commit.stash !== null ? 1 : 0)) + '">' + refBranches + refTags + '</span>' : '') + '</td><td class="graphCol"></td><td class="descriptionCol"><span class="description">' + commitDot + message
				: this.config.referenceLabels.branchLabelsAlignedToGraph
					? '<td class="graphCol">' + (refBranches !== '' ? '<span style="margin-left:' + (widthsAtVertices[i] - 4) + 'px"' + refBranches.substring(5) : '') + '</td><td class="descriptionCol"><span class="description">' + commitDot + (this.config.referenceLabels.tagLabelsOnRight ? message + refTags : refTags + message)
					: '<td class="graphCol"></td><td class="descriptionCol"><span class="description">' + commitDot + refBranches + (this.config.referenceLabels.tagLabelsOnRight ? message + refTags : refTags + message)) + '</span></td>' +
			(colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + date.formatted + '</td>' : '') +
			(colVisibility.author ? '<td class="authorCol text" title="' + escapeHtml(commit.author + ' <' + commit.email + '>') + '">' + (this.config.fetchAvatars ? '<span class="avatar" data-email="' + escapeHtml(commit.email) + '">' + (typeof this.avatars[commit.email] === 'string' ? '<img class="avatarImg" src="' + this.avatars[commit.email] + '">' : '') + '</span>' : generateAuthorInitialHtml(commit.author)) + escapeHtml(commit.author) + '</td>' : '') +
			(fileHistory !== null ? '<td class="fileChangesCol">' + (typeof fileChange !== 'undefined'
				? (fileChange.additions !== null && fileChange.deletions !== null
					? generateChangeBarHtml(fileChange.additions, fileChange.deletions, Math.round(8 + 52 * (fileChange.additions + fileChange.deletions) / maxLinesChanged)) + '<span class="fileTreeFileAdd">+' + fileChange.additions + '</span><span class="fileTreeFileDel">\u2212' + fileChange.deletions + '</span>'
					: '<span class="fileChangesBinary">' + t('Binary') + '</span>')
				: '') + '</td>' : showChanges ? '<td class="changesCol">' + (commit.stash === null && typeof this.commitStats[commit.hash] !== 'undefined' ? generateCommitStatsHtml(this.commitStats[commit.hash]) : '') + '</td>' : '') +
			(colVisibility.commit ? '<td class="hashCol text" title="' + escapeHtml(commit.hash) + '">' + abbrevCommit(commit.hash) + '</td>' : '') +
			'</tr>';
	}

	private renderUncommittedChanges() {
		const rowElem = document.getElementById('uncommittedChanges');
		if (rowElem === null) return;
		const date = formatShortDate(this.commits[0].date), textElem = rowElem.querySelector('.description .text'), dateElem = <HTMLElement | null>rowElem.querySelector('.dateCol');
		if (textElem !== null) textElem.textContent = this.commits[0].message;
		if (dateElem !== null) {
			dateElem.title = date.title;
			dateElem.textContent = date.formatted;
		}
		this.requestCommitStats(true);
	}

	/**
	 * Mark the labels of the branches that are checked out in other worktrees (with the worktree in their tooltip).
	 */
	public renderBranchesInWorktrees() {
		this.tableElem.querySelectorAll<HTMLElement>('.gitRef.head').forEach((refElem) => {
			const worktree = this.worktreeList.getOtherWorktreeOfBranch(unescapeHtml(refElem.dataset.name!));
			const markerElem = refElem.querySelector('.gitRefWorktree');
			alterClass(refElem, 'inWorktree', worktree !== null);
			if (worktree !== null) {
				refElem.title = t('Checked out in the worktree {0}', worktree.path);
				if (markerElem === null) {
					const nameElem = refElem.querySelector('.gitRefName');
					if (nameElem !== null) nameElem.insertAdjacentHTML('afterend', '<span class="gitRefWorktree">' + WORKTREE_ICON + '</span>');
				}
			} else if (markerElem !== null) {
				markerElem.remove();
				refElem.removeAttribute('title');
			}
		});
	}


	/**
	 * Process the operation in progress in the repository (e.g. a rebase that stopped because of conflicts), loaded by the extension.
	 * @param msg The message containing the operation.
	 */
	public processLoadOperationInProgressResponse(msg: GG.ResponseLoadOperationInProgress) {
		this.operationBar.processLoadOperationInProgressResponse(msg);
	}


	/* Undo */

	/**
	 * Render the last action in the current repository that can be undone: the Undo button, and a notification after the action is run.
	 * @param undo The action, or NULL if no action can be undone.
	 */
	private renderUndo(undo: GG.UndoInfo | null) {
		this.undo = undo;
		alterClass(this.undoBtnElem, 'hidden', undo === null);
		this.undoBtnElem.title = undo !== null ? t('Undo: {0}', undo.description) : '';
		if (undo !== null && this.lastUndoId > -1 && undo.id > this.lastUndoId) {
			this.undoToastElem.innerHTML = '<span class="undoToastText">' + escapeHtml(undo.description) + '</span><span class="undoToastAction">' + t('Undo') + '</span><span class="undoToastClose" title="' + t('Close') + '">' + SVG_ICONS.close + '</span>';
			this.undoToastElem.classList.add(CLASS_ACTIVE);
			if (this.undoToastTimeout !== null) clearTimeout(this.undoToastTimeout);
			this.undoToastTimeout = setTimeout(() => this.hideUndoToast(), 10000);
		} else if (undo === null) {
			this.hideUndoToast();
		}
		this.lastUndoId = Math.max(this.lastUndoId, undo !== null ? undo.id : 0);
	}

	/**
	 * Hide the notification that an action can be undone.
	 */
	private hideUndoToast() {
		if (this.undoToastTimeout !== null) {
			clearTimeout(this.undoToastTimeout);
			this.undoToastTimeout = null;
		}
		this.undoToastElem.classList.remove(CLASS_ACTIVE);
	}

	/**
	 * Undo the last action in the current repository (after confirming it).
	 */
	private undoAction() {
		const undo = this.undo;
		if (undo === null) return;
		dialog.showConfirmation(t('Are you sure you want to undo <b><i>{0}</i></b>?', escapeHtml(undo.description)) + '<br/><i>' + t('Uncommitted changes are kept, and only the local repository is changed (not its remotes).') + '</i>', t('Yes, undo'), () => {
			runAction({ command: 'undo', repo: this.currentRepo }, t('Undoing'));
		}, null);
	}


	/* Selected Commits */

	/**
	 * Select commits (with Shift + click): the commits from the commit the selection started at (or the commit whose details are open) to
	 * a commit, or add / remove a commit (with Ctrl / Cmd + Shift + click). The uncommitted changes & stashes can't be selected.
	 * @param hash The hash of the commit that was clicked.
	 * @param toggle Add or remove the commit, instead of selecting a range of commits.
	 */
	private selectCommits(hash: string, toggle: boolean) {
		const isSelectable = (commit: GG.GitCommit) => commit.hash !== UNCOMMITTED && commit.stash === null;
		const index = this.commitLookup[hash];
		if (typeof index !== 'number' || !isSelectable(this.commits[index])) return;
		if (toggle) {
			if (this.selectedCommits.has(hash)) {
				this.selectedCommits.delete(hash);
			} else {
				this.selectedCommits.add(hash);
			}
			this.selectionAnchor = hash;
		} else {
			let anchor = this.selectionAnchor !== null ? this.selectionAnchor : this.expandedCommit !== null && this.expandedCommit.compareWithHash === null ? this.expandedCommit.commitHash : hash;
			if (typeof this.commitLookup[anchor] !== 'number') anchor = hash;
			const from = Math.min(index, this.commitLookup[anchor]), to = Math.max(index, this.commitLookup[anchor]);
			this.selectedCommits = new Set(this.commits.slice(from, to + 1).filter(isSelectable).map((commit) => commit.hash));
			this.selectionAnchor = anchor;
		}
		this.renderCommitSelection();
	}

	/**
	 * Clear the selected commits.
	 */
	public clearCommitSelection() {
		if (this.selectedCommits.size === 0 && this.selectionAnchor === null) return;
		this.selectedCommits = new Set();
		this.selectionAnchor = null;
		this.renderCommitSelection();
	}

	/**
	 * Get the selected commits.
	 * @returns The commits, oldest first (the order they're cherry picked in).
	 */
	public getSelectedCommits() {
		return this.commits.filter((commit) => this.selectedCommits.has(commit.hash)).reverse();
	}

	/**
	 * Render the selected commits (and the actions on them in the footer). Commits that are no longer loaded are unselected.
	 */
	private renderCommitSelection() {
		this.selectedCommits.forEach((hash) => {
			if (typeof this.commitLookup[hash] !== 'number') this.selectedCommits.delete(hash);
		});
		const commitElems = getCommitElems();
		for (let i = 0; i < commitElems.length; i++) {
			const commit = this.getCommitOfElem(commitElems[i]);
			alterClass(commitElems[i], 'multiSelected', commit !== null && this.selectedCommits.has(commit.hash));
		}
		const selectionElem = document.getElementById('listFooterSelection');
		if (selectionElem === null) return;
		const count = this.selectedCommits.size;
		selectionElem.innerHTML = count > 0
			? '<span class="listFooterSelectionCount">' + (count !== 1 ? t('{0} commits selected', count) : t('1 commit selected')) + '</span>' +
				'<span class="listFooterAction" data-action="cherrypick">' + t('Cherry Pick') + ELLIPSIS + '</span>' +
				'<span class="listFooterAction" data-action="copyHashes">' + t('Copy Hashes') + '</span>' +
				'<span class="listFooterAction" data-action="clear" title="' + t('Escape') + '">' + t('Clear Selection') + '</span>'
			: '';
		alterClass(selectionElem, CLASS_ACTIVE, count > 0);
	}

	/**
	 * Get the height of the top of the view that is covered by the sticky controls, and the column headers when they are frozen.
	 * @returns The height (in pixels).
	 */
	private getCoveredTopHeight() {
		const colHeadersElem = this.config.graph.freezeColumnHeaders ? document.getElementById('tableColHeaders') : null;
		return this.controlsElem.offsetHeight + (colHeadersElem !== null ? colHeadersElem.offsetHeight : 0);
	}

	/**
	 * Get the top of the area of the view in which commits are visible: below the sticky controls, and the column headers when they're frozen.
	 * @returns The vertical position (relative to the viewport, as rendered).
	 */
	private getVisibleCommitsTop() {
		const colHeaderElem = this.config.graph.freezeColumnHeaders ? document.querySelector('#tableColHeaders th') : null;
		return Math.max(this.controlsElem.getBoundingClientRect().bottom, colHeaderElem !== null ? colHeaderElem.getBoundingClientRect().bottom : 0);
	}

	/**
	 * Get the height of the bottom of the view that is covered by the footer when it's frozen.
	 * @returns The height (in pixels).
	 */
	private getCoveredBottomHeight() {
		return this.config.graph.freezeFooter ? this.footerElem.offsetHeight : 0;
	}

	/**
	 * Is the Changes column (the files & lines changed by each commit) shown.
	 * @returns TRUE => The column is shown, FALSE => The column isn't shown (e.g. the history of a file is shown, which has its own column).
	 */
	public isChangesColumnShown() {
		return this.fileHistory === null && this.gitRepos[this.currentRepo].showChangesColumn !== false;
	}

	/**
	 * Request the files & lines changed by the commits that are shown, which haven't been loaded.
	 * @param refreshUncommitted Should the stats of the uncommitted changes be refreshed (as they may have changed).
	 */
	public requestCommitStats(refreshUncommitted: boolean) {
		if (!this.isChangesColumnShown()) return;
		if (refreshUncommitted) {
			delete this.commitStats[UNCOMMITTED];
			this.commitStatsRequested.delete(UNCOMMITTED);
		}
		const hashes = this.commits.filter((commit) => commit.stash === null && typeof this.commitStats[commit.hash] === 'undefined' && !this.commitStatsRequested.has(commit.hash)).map((commit) => commit.hash);
		if (hashes.length === 0) return;
		hashes.forEach((hash) => this.commitStatsRequested.add(hash));
		sendMessage({ command: 'loadCommitStats', repo: this.currentRepo, hashes: hashes });
	}

	/**
	 * Process the files & lines changed by commits, loaded by the extension.
	 * @param msg The message containing the stats.
	 */
	public processLoadCommitStatsResponse(msg: GG.ResponseLoadCommitStats) {
		const commitElems = getCommitElems();
		Object.keys(msg.stats).forEach((hash) => {
			this.commitStats[hash] = msg.stats[hash];
			this.commitStatsRequested.delete(hash);
			const elem = findCommitElemWithId(commitElems, this.getCommitId(hash));
			const cellElem = elem !== null ? elem.querySelector('td.changesCol') : null;
			if (cellElem !== null) cellElem.innerHTML = generateCommitStatsHtml(this.commitStats[hash]);
		});
	}

	private renderFetchButton() {
		alterClass(this.controlsElem, CLASS_FETCH_SUPPORTED, this.gitRemotes.length > 0);
	}

	/**
	 * Render the Pull & Push buttons in the control bar, with the number of commits the current branch is behind / ahead of its upstream branch.
	 * @param branchHead The current branch (NULL if HEAD is detached).
	 */
	private renderSyncButtons(branchHead: string | null = this.gitBranchHead) {
		const pullBtn = document.getElementById('pullBtn')!, pushBtn = document.getElementById('pushBtn')!;
		const upstream = branchHead !== null && typeof this.gitUpstreams[branchHead] !== 'undefined' && !this.gitUpstreams[branchHead].gone ? this.gitUpstreams[branchHead] : null;
		const behind = upstream !== null ? upstream.behind : 0, ahead = upstream !== null ? upstream.ahead : 0;

		pullBtn.innerHTML = SVG_ICONS.pull + '<span>' + t('Pull') + '</span>' + (behind > 0 ? '<span class="syncCount">' + behind + '</span>' : '');
		pullBtn.title = upstream !== null
			? (behind > 0 ? t('Pull {0} commit(s) from {1} into the current branch', behind, upstream.name) : t('Pull {0} into the current branch', upstream.name))
			: t('The current branch doesn\'t have an upstream branch to pull from');
		alterClass(pullBtn, CLASS_DISABLED, upstream === null);

		pushBtn.innerHTML = SVG_ICONS.push + '<span>' + t('Push') + '</span>' + (ahead > 0 ? '<span class="syncCount">' + ahead + '</span>' : '');
		pushBtn.title = branchHead === null
			? t('HEAD is detached, so there isn\'t a branch to push')
			: ahead > 0 ? t('Push {0} unpushed commit(s) on {1}', ahead, branchHead) : t('Push {0}', branchHead) + ELLIPSIS;
		alterClass(pushBtn, CLASS_DISABLED, branchHead === null);
		alterClass(pushBtn, 'pending', ahead > 0);
	}

	/**
	 * Scroll to a stash on the graph, and open its Commit Details View. If the stash isn't in the loaded commits, more commits are loaded until it is.
	 * @param stash The stash.
	 */
	public goToStash(stash: GG.GitStash) {
		const elem = this.getCommitElem(this.getCommitId(stash.hash));
		const attempts = this.scrollToStashPending !== null && this.scrollToStashPending.stash.hash === stash.hash ? this.scrollToStashPending.attempts : 0;
		if (elem !== null) {
			this.scrollToStashPending = null;
			this.scrollToCommit(stash.hash, true, true);
			if (!this.isCdvOpen(stash.hash, null)) this.loadCommitDetails(elem);
		} else if (this.moreCommitsAvailable && this.commitFilter === null && attempts < 10) {
			this.scrollToStashPending = { stash: stash, attempts: attempts + 1 };
			if (!this.currentRepoRefreshState.inProgress) this.loadMoreCommits();
		} else {
			this.scrollToStashPending = null;
			dialog.showMessage(t('The stash <b><i>{0}</i></b> isn\'t in the commits that are currently shown. Load more commits (or clear the search) to view it.', escapeHtml(stash.selector.substring(5))));
		}
	}

	/**
	 * Pull the upstream branch of the current branch into the current branch.
	 */
	private pullUpstreamAction() {
		const branchHead = this.gitBranchHead;
		if (branchHead === null || typeof this.gitUpstreams[branchHead] === 'undefined' || this.gitUpstreams[branchHead].gone) return;
		const upstream = this.gitUpstreams[branchHead].name;
		const remote = this.gitRemotes.filter((remote) => upstream.startsWith(remote + '/')).sort((a, b) => b.length - a.length)[0];
		if (typeof remote === 'undefined') return;
		this.actions.pullBranchAction(upstream, remote, upstream.substring(remote.length + 1), null);
	}

	public renderRefreshButton() {
		const enabled = !this.currentRepoRefreshState.inProgress;
		this.refreshBtnElem.title = enabled ? t('Refresh') : t('Refreshing');
		this.refreshBtnElem.innerHTML = enabled ? SVG_ICONS.refresh : SVG_ICONS.loading;
		alterClass(this.refreshBtnElem, CLASS_REFRESHING, !enabled);
	}

	public renderTagDetails(tagName: string, commitHash: string, details: GG.GitTagDetails) {
		const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
			commits: true,
			emoji: true,
			issueLinking: true,
			markdown: this.config.markdown,
			multiline: true,
			urls: true
		});
		dialog.showMessage(
			t('Tag <b><i>{0}</i></b>', escapeHtml(tagName)) + '<br><span class="messageContent">' +
			'<b>' + t('Object:') + ' </b>' + escapeHtml(details.hash) + '<br>' +
			'<b>' + t('Commit:') + ' </b>' + escapeHtml(commitHash) + '<br>' +
			'<b>' + t('Tagger:') + ' </b>' + escapeHtml(details.taggerName) + ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(details.taggerEmail) + '" tabindex="-1">' + escapeHtml(details.taggerEmail) + '</a>&gt;' + (details.signature !== null ? generateSignatureHtml(details.signature) : '') + '<br>' +
			'<b>' + t('Date:') + ' </b>' + formatLongDate(details.taggerDate) + '<br><br>' +
			textFormatter.format(details.message) +
			'</span>'
		);
	}

	public renderRepoDropdownOptions(repo?: string) {
		this.repoDropdown.setOptions(getRepoDropdownOptions(this.gitRepos), [repo || this.currentRepo]);
	}


	/* Table Utils */

	public getColumnVisibility() {
		let colWidths = this.gitRepos[this.currentRepo].columnWidths;
		if (colWidths !== null) {
			return { date: colWidths[1] !== COLUMN_HIDDEN, author: colWidths[2] !== COLUMN_HIDDEN, commit: colWidths[3] !== COLUMN_HIDDEN };
		} else {
			let defaults = this.config.defaultColumnVisibility;
			return { date: defaults.date, author: defaults.author, commit: defaults.commit };
		}
	}

	private getNumColumns() {
		let colVisibility = this.getColumnVisibility();
		return 2 + (this.config.referenceLabels.inSeparateColumn ? 1 : 0) + (this.fileHistory !== null || this.isChangesColumnShown() ? 1 : 0) + (colVisibility.date ? 1 : 0) + (colVisibility.author ? 1 : 0) + (colVisibility.commit ? 1 : 0);
	}

	/**
	 * Scroll the view to the previous or next stash.
	 * @param next TRUE => Jump to the next stash, FALSE => Jump to the previous stash.
	 */
	private scrollToStash(next: boolean) {
		const stashCommits = this.commits.filter((commit) => commit.stash !== null);
		if (stashCommits.length > 0) {
			const curTime = (new Date()).getTime();
			if (this.lastScrollToStash.time < curTime - 5000) {
				// Reset the lastScrollToStash hash if it was more than 5 seconds ago
				this.lastScrollToStash.hash = null;
			}

			const lastScrollToStashCommitIndex = this.lastScrollToStash.hash !== null
				? stashCommits.findIndex((commit) => commit.hash === this.lastScrollToStash.hash)
				: -1;
			let scrollToStashCommitIndex = lastScrollToStashCommitIndex + (next ? 1 : -1);
			if (scrollToStashCommitIndex >= stashCommits.length) {
				scrollToStashCommitIndex = 0;
			} else if (scrollToStashCommitIndex < 0) {
				scrollToStashCommitIndex = stashCommits.length - 1;
			}
			this.scrollToCommit(stashCommits[scrollToStashCommitIndex].hash, true, true);
			this.lastScrollToStash.time = curTime;
			this.lastScrollToStash.hash = stashCommits[scrollToStashCommitIndex].hash;
		}
	}

	/**
	 * Scroll the view to a commit (if it exists).
	 * @param hash The hash of the commit to scroll to.
	 * @param alwaysCenterCommit TRUE => Always scroll the view to be centered on the commit. FALSE => Don't scroll the view if the commit is already within the visible portion of commits.
	 * @param flash Should the commit flash after it has been scrolled to.
	 */
	public scrollToCommit(hash: string, alwaysCenterCommit: boolean, flash: boolean = false) {
		const elem = this.getCommitElem(this.getCommitId(hash));
		if (elem === null) return;

		// The controls are sticky (always visible at the top of the view), so commits are only visible below them (and the frozen column
		// headers), and above the footer when it's frozen
		const elemTop = this.controlsElem.clientHeight + elem.offsetTop, coveredTop = this.getCoveredTopHeight(), visibleBottom = this.viewElem.clientHeight - this.getCoveredBottomHeight();
		if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop + coveredTop || elemTop + 32 - visibleBottom > this.viewElem.scrollTop) {
			this.viewElem.scroll(0, elemTop + 12 - (visibleBottom + coveredTop) / 2);
		}

		if (flash && this.flashingHash !== hash) {
			// The row is rendered with the flash while the commit is flashing (its row can be rendered again as the view is scrolled)
			this.flashingHash = hash;
			elem.classList.add('flash');
			setTimeout(() => {
				if (this.flashingHash === hash) this.flashingHash = null;
				const commitElem = findCommitElemWithId(getCommitElems(), this.getCommitId(hash));
				if (commitElem !== null) commitElem.classList.remove('flash');
			}, 850);
		}
	}

	/**
	 * Scroll to the commit referenced by HEAD. If it hasn't been loaded yet, more commits are loaded until it is (when the branches being shown include HEAD).
	 */
	private scrollToHead() {
		const headBranchShown = this.currentBranches === null || this.currentBranches.includes(SHOW_ALL_BRANCHES) || (this.gitBranchHead !== null && this.currentBranches.includes(this.gitBranchHead));
		if (this.commitHead !== null && typeof this.commitLookup[this.commitHead] === 'number') {
			this.scrollToHeadPending = false;
			this.scrollToCommit(this.commitHead, true, true);
		} else if (this.commitHead !== null && this.moreCommitsAvailable && headBranchShown) {
			this.scrollToHeadPending = true;
			if (!this.currentRepoRefreshState.inProgress) {
				this.loadMoreCommits();
			}
		} else {
			this.scrollToHeadPending = false;
		}
	}

	private loadMoreCommits() {
		this.footerElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + t('Loading ...') + '</h2>';
		this.maxCommits += this.config.loadMoreCommits;
		this.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}


	/* Observers */

	private observeWindowSizeChanges() {
		let windowWidth = window.outerWidth, windowHeight = window.outerHeight;
		window.addEventListener('resize', () => {
			const cdvElem = document.getElementById('cdv');
			if (cdvElem !== null && this.isCdvDocked() && this.isCdvDockedRight()) {
				this.setCdvHeight(cdvElem, true);
			}
			if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {
				this.renderGraph();
			} else {
				windowWidth = window.outerWidth;
				windowHeight = window.outerHeight;
			}
		});
	}

	private observeWebviewStyleChanges() {
		let fontFamily = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
			editorFontFamily = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
			findMatchColour = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
			selectionBackgroundColor = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

		const setFlashColour = (colour: string) => {
			document.body.style.setProperty('--git-graph-flashPrimary', modifyColourOpacity(colour, 0.7));
			document.body.style.setProperty('--git-graph-flashSecondary', modifyColourOpacity(colour, 0.5));
		};
		const setSelectionBackgroundColorExists = () => {
			alterClass(document.body, 'selection-background-color-exists', selectionBackgroundColor);
		};

		this.findWidget.setColour(findMatchColour);
		setFlashColour(findMatchColour);
		setSelectionBackgroundColorExists();

		(new MutationObserver(() => {
			let ff = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
				eff = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
				fmc = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
				sbc = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

			if (ff !== fontFamily || eff !== editorFontFamily) {
				fontFamily = ff;
				editorFontFamily = eff;
				this.repoDropdown.refresh();
				this.branchDropdown.refresh();
				this.authorDropdown.refresh();
			}
			if (fmc !== findMatchColour) {
				findMatchColour = fmc;
				this.findWidget.setColour(findMatchColour);
				setFlashColour(findMatchColour);
			}
			if (selectionBackgroundColor !== sbc) {
				selectionBackgroundColor = sbc;
				setSelectionBackgroundColorExists();
			}
		})).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
	}

	private observeViewScroll() {
		let active = this.viewElem.scrollTop > 0, timeout: number | null = null;
		this.scrollShadowElem.className = active ? CLASS_ACTIVE : '';
		this.viewElem.addEventListener('scroll', () => {
			const scrollTop = this.viewElem.scrollTop;
			if (active !== scrollTop > 0) {
				active = scrollTop > 0;
				this.scrollShadowElem.className = active ? CLASS_ACTIVE : '';
			}

			if (this.config.loadMoreCommitsAutomatically && this.moreCommitsAvailable && !this.currentRepoRefreshState.inProgress) {
				const viewHeight = this.viewElem.clientHeight, contentHeight = this.viewElem.scrollHeight;
				if (scrollTop > 0 && viewHeight > 0 && contentHeight > 0 && (scrollTop + viewHeight) >= contentHeight - 25) {
					// If the user has scrolled such that the bottom of the visible view is within 25px of the end of the content, load more commits.
					this.loadMoreCommits();
				}
			}

			if (timeout !== null) clearTimeout(timeout);
			timeout = setTimeout(() => {
				this.scrollTop = scrollTop;
				this.saveState();
				timeout = null;
			}, 250);
		});
	}

	private observeMouseNavigationButtons() {
		// The back / forward buttons of a mouse navigate the Visual Studio Code editor history (the events aren't handled by Visual Studio Code when they occur in a Webview)
		document.addEventListener('mouseup', (e) => {
			if (e.button === 3 || e.button === 4) {
				handledEvent(e);
				sendMessage({ command: 'navigateEditorHistory', forward: e.button === 4 });
			}
		});
	}

	private observeKeyboardEvents() {
		// The time at which a Ctrl / Cmd keybinding that wasn't handled by Git Map was pressed. Visual Studio Code may treat it as the first part of a keybinding chord (e.g. Ctrl+K Ctrl+S), so Git Map doesn't handle the next keypress (which Visual Studio Code is waiting for).
		let possibleChordStart = 0;
		window.addEventListener('blur', () => {
			possibleChordStart = 0;
		});

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt') return;
			const chordInProgress = possibleChordStart > 0 && Date.now() - possibleChordStart < 1500;
			possibleChordStart = 0;

			if (contextMenu.isOpen()) {
				if (e.key === 'Escape') {
					contextMenu.close();
					handledEvent(e);
				} else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && this.copyCommitHashWithKeyboard(e)) {
					// Copy the hash of the commit whose context menu is open (as shown in the context menu)
					handledEvent(e);
				}
			} else if (dialog.isOpen()) {
				if (e.key === 'Escape') {
					dialog.close();
					handledEvent(e);
				} else if (e.keyCode ? e.keyCode === 13 : e.key === 'Enter') {
					// Use keyCode === 13 to detect 'Enter' events if available (for compatibility with IME Keyboards used by Chinese / Japanese / Korean users)
					dialog.submit();
					handledEvent(e);
				}
			} else if (this.expandedCommit !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
				const curHashIndex = this.commitLookup[this.expandedCommit.commitHash];
				let newHashIndex = -1;

				if (e.ctrlKey || e.metaKey) {
					// Up / Down navigates according to the order of commits on the branch
					if (e.shiftKey) {
						// Follow commits on alternative branches when possible
						if (e.key === 'ArrowUp') {
							newHashIndex = this.graph.getAlternativeChildIndex(curHashIndex);
						} else if (e.key === 'ArrowDown') {
							newHashIndex = this.graph.getAlternativeParentIndex(curHashIndex);
						}
					} else {
						// Follow commits on the same branch
						if (e.key === 'ArrowUp') {
							newHashIndex = this.graph.getFirstChildIndex(curHashIndex);
						} else if (e.key === 'ArrowDown') {
							newHashIndex = this.graph.getFirstParentIndex(curHashIndex);
						}
					}
				} else {
					// Up / Down navigates according to the order of commits in the table
					if (e.key === 'ArrowUp' && curHashIndex > 0) {
						newHashIndex = curHashIndex - 1;
					} else if (e.key === 'ArrowDown' && curHashIndex < this.commits.length - 1) {
						newHashIndex = curHashIndex + 1;
					}
				}

				if (newHashIndex > -1) {
					handledEvent(e);
					const elem = this.getCommitElem(newHashIndex);
					if (elem !== null) this.loadCommitDetails(elem);
				}
			} else if (e.key && (e.ctrlKey || e.metaKey)) {
				if (chordInProgress) return; // Leave the second keypress of a chord to Visual Studio Code

				const key = e.key.toLowerCase(), keybindings = this.config.keybindings;
				if (key === keybindings.scrollToStash) {
					this.scrollToStash(!e.shiftKey);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.refresh) {
					this.refresh(true, true);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.find) {
					this.findWidget.show(true);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.scrollToHead && this.commitHead !== null) {
					this.scrollToHead();
					handledEvent(e);
				} else if (key === 'c' && !e.shiftKey && !e.altKey && this.copyCommitHashWithKeyboard(e)) {
					handledEvent(e);
				} else if (key.length === 1 && !['a', 'c', 'v', 'x', 'y', 'z'].includes(key)) {
					possibleChordStart = Date.now();
				}
			} else if (e.key === 'Escape') {
				if (this.rebaseEditor.isOpen()) {
					this.rebaseEditor.close();
					handledEvent(e);
				} else if (this.selectedCommits.size > 0) {
					this.clearCommitSelection();
					handledEvent(e);
				} else if (this.worktreeList.isListOpen()) {
					this.worktreeList.closeList();
					handledEvent(e);
				} else if (this.stashList.isStashListOpen()) {
					this.stashList.closeStashList();
					handledEvent(e);
				} else if (this.repoDropdown.isOpen()) {
					this.repoDropdown.close();
					handledEvent(e);
				} else if (this.branchDropdown.isOpen()) {
					this.branchDropdown.close();
					handledEvent(e);
				} else if (this.authorDropdown.isOpen()) {
					this.authorDropdown.close();
					handledEvent(e);
				} else if (this.settingsWidget.isVisible()) {
					this.settingsWidget.close();
					handledEvent(e);
				} else if (this.findWidget.isVisible()) {
					this.findWidget.close();
					handledEvent(e);
				} else if (this.expandedCommit !== null) {
					this.closeCommitDetails(true);
					handledEvent(e);
				}
			}
		});
	}

	/**
	 * Copy the hash of the commit whose context menu is open, or whose details are shown, to the clipboard (Ctrl/Cmd+C), unless text is selected.
	 * @param e The keyboard event.
	 * @returns TRUE => A commit hash was copied, FALSE => Nothing was copied (the default behaviour of the keyboard shortcut applies).
	 */
	private copyCommitHashWithKeyboard(e: KeyboardEvent) {
		const selection = window.getSelection();
		if ((selection !== null && selection.toString() !== '') || (e.target instanceof Element && e.target.closest('input, textarea') !== null)) return false;
		const target = contextMenu.getTarget();
		const hash = target !== null && target.type === TargetType.Commit
			? target.hash
			: this.expandedCommit !== null && this.expandedCommit.compareWithHash === null && !contextMenu.isOpen() ? this.expandedCommit.commitHash : null;
		if (hash === null || hash === UNCOMMITTED) return false;
		sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: hash });
		closeDialogAndContextMenu();
		return true;
	}

	private observeUrls() {
		const followInternalLink = (e: MouseEvent) => {
			if (e.target !== null && isInternalUrlElem(<Element>e.target)) {
				const value = unescapeHtml((<HTMLElement>e.target).dataset.value!);
				switch ((<HTMLElement>e.target).dataset.type!) {
					case 'commit':
						if (typeof this.commitLookup[value] === 'number' && (this.expandedCommit === null || this.expandedCommit.commitHash !== value || this.expandedCommit.compareWithHash !== null)) {
							const elem = this.getCommitElem(this.commitLookup[value]);
							if (elem !== null) this.loadCommitDetails(elem);
						}
						break;
				}
			}
		};

		document.body.addEventListener('click', followInternalLink);

		document.body.addEventListener('click', (e: MouseEvent) => {
			// Visual Studio Code only follows links with standard schemes (e.g. http & https) that are clicked in a Webview, so links to other applications (e.g. issue links using a custom scheme) are opened by the extension
			if (e.target === null || !isExternalUrlElem(<Element>e.target)) return;
			const url = (<HTMLAnchorElement>e.target).href;
			const scheme = url.substring(0, url.indexOf(':')).toLowerCase();
			if (/^[a-z][a-z0-9+.-]*$/.test(scheme) && !['http', 'https', 'mailto', 'file', 'javascript', 'data', 'vbscript', 'command', 'vscode', 'vscode-insiders'].includes(scheme)) {
				handledEvent(e);
				sendMessage({ command: 'openExternalUrl', url: url });
			}
		});

		document.body.addEventListener('contextmenu', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;

			const isExternalUrl = isExternalUrlElem(eventTarget), isInternalUrl = isInternalUrlElem(eventTarget);
			if (isExternalUrl || isInternalUrl) {
				const viewElem: HTMLElement | null = eventTarget.closest('#view');
				let eventElem: HTMLElement | null;

				let target: (ContextMenuTarget & CommitTarget) | RepoTarget, isInDialog = false;
				if (this.expandedCommit !== null && eventTarget.closest('#cdv') !== null) {
					// URL is in the Commit Details View
					target = {
						type: TargetType.CommitDetailsView,
						hash: this.expandedCommit.commitHash,
						index: this.commitLookup[this.expandedCommit.commitHash],
						elem: <HTMLElement>eventTarget
					};
					GitGraphView.closeCdvContextMenuIfOpen(this.expandedCommit);
					this.expandedCommit.contextMenuOpen.summary = true;
				} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
					// URL is in the Commits
					const commit = this.getCommitOfElem(eventElem);
					if (commit === null) return;
					target = {
						type: TargetType.Commit,
						hash: commit.hash,
						index: parseInt(eventElem.dataset.id!),
						elem: <HTMLElement>eventTarget
					};
				} else {
					// URL is in a dialog
					target = {
						type: TargetType.Repo
					};
					isInDialog = true;
				}

				handledEvent(e);
				contextMenu.show([
					[
						{
							title: t('Open URL'),
							visible: isExternalUrl,
							onClick: () => {
								sendMessage({ command: 'openExternalUrl', url: (<HTMLAnchorElement>eventTarget).href });
							}
						},
						{
							title: t('Follow Internal Link'),
							visible: isInternalUrl,
							onClick: () => followInternalLink(e)
						},
						{
							title: t('Copy URL to Clipboard'),
							visible: isExternalUrl,
							onClick: () => {
								sendMessage({ command: 'copyToClipboard', type: t('External URL'), data: (<HTMLAnchorElement>eventTarget).href });
							}
						}
					]
				], false, target, e, viewElem || document.body, () => {
					if (target.type === TargetType.CommitDetailsView && this.expandedCommit !== null) {
						this.expandedCommit.contextMenuOpen.summary = false;
					}
				}, isInDialog ? 'dialogContextMenu' : null);
			}
		});
	}

	private observeTableEvents() {

		// Register Click Event Handler
		this.tableElem.addEventListener('click', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was clicked
				e.stopPropagation();
				if (contextMenu.isOpen()) {
					contextMenu.close();
				}

			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
				// .commit was clicked
				const clickedCommit = this.getCommitOfElem(eventElem);
				if (e.shiftKey) {
					// Shift + click selects the commits from the selected commit (or the commit whose details are open), and Ctrl / Cmd + Shift + click adds or removes a commit
					if (clickedCommit !== null) this.selectCommits(clickedCommit.hash, e.ctrlKey || e.metaKey);
					return;
				}
				this.clearCommitSelection();
				if (this.expandedCommit !== null) {
					const commit = this.getCommitOfElem(eventElem);
					if (commit === null) return;

					if (this.expandedCommit.commitHash === commit.hash) {
						this.closeCommitDetails(true);
					} else if ((<MouseEvent>e).ctrlKey || (<MouseEvent>e).metaKey || this.cdvComparePending) {
						this.cdvComparePending = false;
						if (this.expandedCommit.compareWithHash === commit.hash) {
							this.closeCommitComparison(true);
						} else if (this.expandedCommit.commitElem !== null) {
							this.loadCommitComparison(this.expandedCommit.commitElem, eventElem);
						}
					} else {
						this.loadCommitDetails(eventElem);
					}
				} else {
					this.loadCommitDetails(eventElem);
				}
			}
		});

		// Register Double Click Event Handler
		// Highlight the branch of the commit that the mouse is over (on the graph)
		let highlightedCommit: number | null = null;
		const highlightBranchOfCommit = (id: number | null) => {
			if (id === highlightedCommit) return;
			highlightedCommit = id;
			this.graph.highlightBranchOfCommit(id);
		};
		this.tableElem.addEventListener('mouseover', (e: MouseEvent) => {
			const commitElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.commit') : null;
			highlightBranchOfCommit(commitElem !== null && typeof commitElem.dataset.id === 'string' ? parseInt(commitElem.dataset.id) : null);
			// The buttons of the most common actions on the commit are shown at the end of its row
			if (commitElem !== null) {
				this.rowActions.show(commitElem);
			} else {
				this.rowActions.hide();
			}
		});
		this.tableElem.addEventListener('mouseleave', () => {
			highlightBranchOfCommit(null);
			this.rowActions.hide();
		});

		this.tableElem.addEventListener('dblclick', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was double clicked
				e.stopPropagation();
				closeDialogAndContextMenu();
				const commitElem = <HTMLElement>eventElem.closest('.commit')!;
				const commit = this.getCommitOfElem(commitElem);
				if (commit === null) return;

				if (eventElem.classList.contains(CLASS_REF_HEAD) || eventElem.classList.contains(CLASS_REF_REMOTE)) {
					let sourceElem = <HTMLElement>eventElem.children[1];
					let refName = unescapeHtml(eventElem.dataset.name!), isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
					if (isHead && isRemoteCombinedWithHead) {
						refName = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);
						sourceElem = <HTMLElement>eventTarget;
						isHead = false;
					}

					const target: ContextMenuTarget & DialogTarget & RefTarget = {
						type: TargetType.Ref,
						hash: commit.hash,
						index: parseInt(commitElem.dataset.id!),
						ref: refName,
						elem: sourceElem
					};

					this.actions.checkoutBranchAction(refName, isHead ? null : unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!), null, target);
				}
			}
		});

		// Register ContextMenu Event Handler
		this.tableElem.addEventListener('contextmenu', (e: Event) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was right clicked
				handledEvent(e);
				const commitElem = <HTMLElement>eventElem.closest('.commit')!;
				const commit = this.getCommitOfElem(commitElem);
				if (commit === null) return;

				const target: ContextMenuTarget & DialogTarget & RefTarget = {
					type: TargetType.Ref,
					hash: commit.hash,
					index: parseInt(commitElem.dataset.id!),
					ref: unescapeHtml(eventElem.dataset.name!),
					elem: <HTMLElement>eventElem.children[1]
				};

				let actions: ContextMenuActions;
				if (eventElem.classList.contains(CLASS_REF_STASH)) {
					actions = this.actions.getStashContextMenuActions(target);
				} else if (eventElem.classList.contains(CLASS_REF_TAG)) {
					actions = this.actions.getTagContextMenuActions(eventElem.dataset.tagtype === 'annotated', target);
				} else {
					let isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
					if (isHead && isRemoteCombinedWithHead) {
						target.ref = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);
						target.elem = <HTMLElement>eventTarget;
						isHead = false;
					}
					if (isHead) {
						actions = this.actions.getBranchContextMenuActions(target);
					} else {
						const remote = unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!);
						actions = this.actions.getRemoteBranchContextMenuActions(remote, target);
					}
				}

				contextMenu.show(actions, false, target, <MouseEvent>e, this.viewElem);

			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
				// .commit was right clicked
				handledEvent(e);
				const commit = this.getCommitOfElem(eventElem);
				if (commit === null) return;

				const target: ContextMenuTarget & DialogTarget & CommitTarget = {
					type: TargetType.Commit,
					hash: commit.hash,
					index: parseInt(eventElem.dataset.id!),
					elem: eventElem
				};

				let actions: ContextMenuActions;
				if (this.selectedCommits.size > 1 && this.selectedCommits.has(commit.hash)) {
					actions = this.actions.getSelectedCommitsContextMenuActions(this.getSelectedCommits(), target);
				} else if (commit.hash === UNCOMMITTED) {
					actions = this.actions.getUncommittedChangesContextMenuActions(target);
				} else if (commit.stash !== null) {
					target.ref = commit.stash.selector;
					actions = this.actions.getStashContextMenuActions(<RefTarget>target);
				} else {
					actions = this.actions.getCommitContextMenuActions(target);
				}

				contextMenu.show(actions, false, target, <MouseEvent>e, this.viewElem);
			}
		});

		// When a context menu is requested with the keyboard (e.g. the Menu key or Shift+F10), show the context menu of the commit selected with the keyboard
		document.addEventListener('contextmenu', (e: MouseEvent) => {
			if (e.button === 2 || (e.target !== document.body && e.target !== document.documentElement && e.target !== this.viewElem)) return;
			if (this.expandedCommit === null || this.expandedCommit.commitElem === null || dialog.isOpen()) return;

			handledEvent(e);
			const bounds = this.expandedCommit.commitElem.getBoundingClientRect();
			this.expandedCommit.commitElem.dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				button: 2,
				clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 200)),
				clientY: Math.round(bounds.top + bounds.height / 2)
			}));
		}, true);
	}


	/* Commit Details View */

	public loadCommitDetails(commitElem: HTMLElement) {
		const commit = this.getCommitOfElem(commitElem);
		if (commit === null) return;

		this.closeCommitDetails(false);
		this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, null, null);
		commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.renderCommitDetailsView(false);
		this.requestCommitDetails(commit.hash, false);
	}

	public closeCommitDetails(saveAndRender: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null) return;

		const elem = document.getElementById('cdv'), isDocked = this.isCdvDocked();
		this.cdvComparePending = false;
		this.cdvShowWholeCommit = false;
		if (elem !== null) {
			elem.remove();
		}
		if (isDocked) {
			this.viewElem.style.bottom = '0px';
			this.viewElem.style.right = '0px';
			document.body.classList.remove(CLASS_CDV_DOCKED_RIGHT);
		}
		if (expandedCommit.commitElem !== null) {
			expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		this.expandedCommit = null;
		if (saveAndRender) {
			this.saveState();
			if (!isDocked) {
				// Only the rows near the view are rendered again (if there are many commits), now that the Commit Details View isn't inline
				if (this.renderedRows === null && this.isVirtualised()) this.renderRows();
				this.renderGraph();
			}
		}
	}

	public showCommitDetails(commitDetails: GG.GitCommitDetails, fileTree: FileTreeFolder, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;

		if (!this.isCdvDocked()) {
			const elem = document.getElementById('cdv');
			if (elem !== null) elem.remove();
		}

		expandedCommit.commitDetails = commitDetails;
		if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {
			expandedCommit.fileChanges = commitDetails.fileChanges;
			expandedCommit.fileTree = fileTree;
			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		}
		expandedCommit.avatar = avatar;
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
		this.saveState();

		this.renderCommitDetailsView(refresh);
	}

	public createFileTree(gitFiles: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null) {
		let contents: FileTreeFolderContents = {}, i, j, path, absPath, cur: FileTreeFolder;
		let files: FileTreeFolder = { type: 'folder', name: '', folderPath: '', contents: contents, open: true, reviewed: true };

		for (i = 0; i < gitFiles.length; i++) {
			cur = files;
			path = gitFiles[i].newFilePath.split('/');
			absPath = this.currentRepo;
			for (j = 0; j < path.length; j++) {
				absPath += '/' + path[j];
				if (typeof this.gitRepos[absPath] !== 'undefined') {
					if (typeof cur.contents[path[j]] === 'undefined') {
						cur.contents[path[j]] = { type: 'repo', name: path[j], path: absPath };
					}
					break;
				} else if (j < path.length - 1) {
					if (typeof cur.contents[path[j]] === 'undefined') {
						contents = {};
						cur.contents[path[j]] = { type: 'folder', name: path[j], folderPath: absPath.substring(this.currentRepo.length + 1), contents: contents, open: true, reviewed: true };
					}
					cur = <FileTreeFolder>cur.contents[path[j]];
				} else if (path[j] !== '') {
					cur.contents[path[j]] = { type: 'file', name: path[j], index: i, reviewed: codeReview === null || !codeReview.remainingFiles.includes(gitFiles[i].newFilePath) };
				}
			}
		}
		if (codeReview !== null) calcFileTreeFoldersReviewed(files);
		return files;
	}


	/* Commit Comparison View */

	private loadCommitComparison(commitElem: HTMLElement, compareWithElem: HTMLElement) {
		const commit = this.getCommitOfElem(commitElem);
		const compareWithCommit = this.getCommitOfElem(compareWithElem);

		if (commit !== null && compareWithCommit !== null) {
			if (this.expandedCommit !== null) {
				if (this.expandedCommit.commitHash !== commit.hash) {
					this.closeCommitDetails(false);
				} else if (this.expandedCommit.compareWithHash !== compareWithCommit.hash) {
					this.closeCommitComparison(false);
				}
			}

			this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, compareWithCommit.hash, compareWithElem);
			commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			this.renderCommitDetailsView(false);
			this.requestCommitComparison(commit.hash, compareWithCommit.hash, false);
		}
	}

	public closeCommitComparison(saveAndRequestCommitDetails: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.compareWithHash === null) return;

		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		if (saveAndRequestCommitDetails) {
			if (expandedCommit.commitElem !== null) {
				this.saveExpandedCommitLoading(expandedCommit.index, expandedCommit.commitHash, expandedCommit.commitElem, null, null);
				this.renderCommitDetailsView(false);
				this.requestCommitDetails(expandedCommit.commitHash, false);
			} else {
				this.closeCommitDetails(true);
			}
		}
	}

	public showCommitComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, fileTree: FileTreeFolder, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;

		if (haveFilesChanged(expandedCommit.fileChanges, fileChanges)) {
			expandedCommit.fileChanges = fileChanges;
			expandedCommit.fileTree = fileTree;
			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		}
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
		this.saveState();

		this.renderCommitDetailsView(refresh);
	}


	/* Render Commit Details / Comparison View */

	private renderCommitDetailsView(refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null) return;

		let elem = document.getElementById('cdv'), html = '<div id="cdvContent">', isDocked = this.isCdvDocked(), messageHtml = '';
		const isRight = isDocked && this.isCdvDockedRight();
		const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;
		const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || this.commits[this.commitLookup[expandedCommit.commitHash]].parents.length > 0);

		if (elem === null) {
			if (!isDocked && this.renderedRows !== null) {
				// All of the rows are rendered while the Commit Details View is inline, as it's in the table
				this.renderRows();
			}
			elem = document.createElement(isDocked ? 'div' : 'tr');
			elem.id = 'cdv';
			elem.className = isDocked ? (this.isCdvDockedRight() ? 'docked right' : 'docked') : 'inline';
			this.setCdvHeight(elem, isDocked);
			if (isDocked) {
				document.body.appendChild(elem);
			} else {
				insertAfter(elem, expandedCommit.commitElem);
			}
		}

		if (expandedCommit.loading) {
			html += '<div id="cdvLoading">' + SVG_ICONS.loading + ' ' + t('Loading {0} ...', expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? t('Commit Details') : t('Uncommitted Changes') : t('Commit Comparison')) + '</div>';
		} else {
			html += '<div id="cdvSummary">';
			if (expandedCommit.compareWithHash === null) {
				// Commit details should be shown
				if (expandedCommit.commitHash !== UNCOMMITTED) {
					const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
						commits: true,
						emoji: true,
						issueLinking: true,
						markdown: this.config.markdown,
						multiline: true,
						urls: true
					});
					const commitDetails = expandedCommit.commitDetails!;
					const parents = commitDetails.parents.length > 0
						? commitDetails.parents.map((parent) => {
							const escapedParent = escapeHtml(parent);
							return typeof this.commitLookup[parent] === 'number'
								? '<span class="' + CLASS_INTERNAL_URL + '" data-type="commit" data-value="' + escapedParent + '" tabindex="-1">' + escapedParent + '</span>'
								: escapedParent;
						}).join(', ')
						: t('None');
					const subjectEnd = commitDetails.body.indexOf('\n');
					const subject = subjectEnd > -1 ? commitDetails.body.substring(0, subjectEnd) : commitDetails.body;
					const body = subjectEnd > -1 ? commitDetails.body.substring(subjectEnd + 1).trim() : '';
					const detail = (key: string, value: string) => '<span class="cdvSummaryKey">' + key + '</span><span class="cdvSummaryValue">' + value + '</span>';
					const detailsHtml = '<div class="cdvSummaryDetails">'
						+ detail(t('Commit:'), '<span class="cdvSummaryHash">' + escapeHtml(commitDetails.hash) + '</span>')
						+ detail(t('Parents:'), parents)
						+ detail(t('Author:'), escapeHtml(commitDetails.author) + (commitDetails.authorEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.authorEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.authorEmail) + '</a>&gt;' : ''))
						+ (commitDetails.authorDate !== commitDetails.committerDate ? detail(t('Author Date:'), formatLongDate(commitDetails.authorDate)) : '')
						+ detail(t('Committer:'), escapeHtml(commitDetails.committer) + (commitDetails.committerEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.committerEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.committerEmail) + '</a>&gt;' : '') + (commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : ''))
						+ detail(commitDetails.authorDate !== commitDetails.committerDate ? t('Committer Date:') : t('Date:'), formatLongDate(commitDetails.committerDate))
						+ '</div>';
					if (isRight) {
						html += this.generateCdvSummaryHtml(commitDetails, expandedCommit.avatar, expandedCommit.fileChanges!, textFormatter, subject, body);
						messageHtml = '<div class="cdvMessageText">' + textFormatter.format(commitDetails.body) + '</div>' + detailsHtml;
					} else html += '<div class="cdvSummaryHeader">'
						+ (expandedCommit.avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + expandedCommit.avatar + '"></span>' : generateAuthorInitialHtml(commitDetails.author))
						+ '<span class="cdvSummaryHeaderText"><span class="cdvSummaryAuthor">' + escapeHtml(commitDetails.author) + '</span><span class="cdvSummaryDate" title="' + escapeHtml(formatLongDate(commitDetails.authorDate)) + '">' + formatShortDate(commitDetails.authorDate).formatted + '</span></span>'
						+ '</div>'
						+ '<div class="cdvSummarySubject">' + textFormatter.format(subject) + '</div>'
						+ (body !== '' ? '<div class="cdvSummaryBody">' + textFormatter.format(body) + '</div>' : '')
						+ detailsHtml + '<div id="cdvActions"></div>';
				} else {
					html += (isRight ? '<h2 class="cdvSubject">' + t('Uncommitted Changes') + '</h2>' : '') + '<p class="cdvSummaryText">' + t('Displaying all uncommitted changes.') + '</p>' + (isRight ? generateCdvStatsHtml(expandedCommit.fileChanges!) : '') + '<div id="cdvActions"></div>';
				}
			} else {
				// Commit comparison should be shown
				html += '<p class="cdvSummaryText">' + t('Displaying all changes from <b>{0}</b> to <b>{1}</b>.', commitOrder.from, (commitOrder.to !== UNCOMMITTED ? commitOrder.to : t('Uncommitted Changes'))) + '</p>' + (isRight ? generateCdvStatsHtml(expandedCommit.fileChanges!) : '');
			}
			const fileViewHtml = generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, this.cdvFileView.getFileViewType(), commitOrder.to === UNCOMMITTED);
			html += '</div><div id="cdvFiles">' + (isRight
				? '<div id="cdvTabs"><span class="cdvTab active" data-tab="files">' + t('Changed Files') + ' · ' + expandedCommit.fileChanges!.length + '</span>' + (messageHtml !== '' ? '<span class="cdvTab" data-tab="message">' + t('Commit Message') + '</span>' : '') + '<span class="cdvTabsSpacer"></span>' +
					'<div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File Tree View') + '">' + SVG_ICONS.fileTree + '</div><div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File List View') + '">' + SVG_ICONS.fileList + '</div></div>' +
					'<div id="cdvFileView">' + fileViewHtml + '</div>' + (messageHtml !== '' ? '<div id="cdvMessageView" class="hidden">' + messageHtml + '</div>' : '')
				: fileViewHtml) + '</div><div id="cdvDivider"></div>';
		}
		if (isRight) {
			const title = expandedCommit.compareWithHash !== null ? t('Commit Comparison') : expandedCommit.commitHash === UNCOMMITTED ? t('Uncommitted Changes')
				: !expandedCommit.loading && expandedCommit.fileChanges !== null && this.getCdvFileFocus(expandedCommit.commitHash, expandedCommit.fileChanges) !== null ? t('Changes to this File in the Commit') : t('Commit Details');
			html = '<div id="cdvHeader"><span class="cdvHeaderTitle">' + title + '</span>' +
				(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +
				(externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +
				(expandedCommit.compareWithHash === null ? '<div id="cdvPrev" class="cdvControlBtn" title="' + t('Previous Commit') + '">' + SVG_ICONS.arrowUp + '</div><div id="cdvNext" class="cdvControlBtn" title="' + t('Next Commit') + '">' + SVG_ICONS.arrowDown + '</div>' : '') +
				'<div id="cdvClose" class="cdvControlBtn" title="' + t('Close') + '">' + SVG_ICONS.close + '</div></div>' +
				html + '</div><div class="cdvHeightResize"></div>';
		} else {
			html += '</div><div id="cdvControls"><div id="cdvClose" class="cdvControlBtn" title="' + t('Close') + '">' + SVG_ICONS.close + '</div>' +
				(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +
				(!expandedCommit.loading ? '<div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File Tree View') + '">' + SVG_ICONS.fileTree + '</div><div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File List View') + '">' + SVG_ICONS.fileList + '</div>' : '') +
				(externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +
				'</div><div class="cdvHeightResize"></div>';
		}

		elem.innerHTML = isDocked ? html : '<td><div class="cdvHeightResize"></div></td><td colspan="' + (this.getNumColumns() - 1) + '">' + html + '</td>';
		if (!expandedCommit.loading) this.setCdvDivider();
		if (!isDocked) this.renderGraph();

		if (!refresh) {
			if (isDocked) {
				const elemTop = this.controlsElem.clientHeight + expandedCommit.commitElem.offsetTop, coveredTop = this.getCoveredTopHeight(), visibleBottom = this.viewElem.clientHeight - this.getCoveredBottomHeight();
				if (elemTop - 8 < this.viewElem.scrollTop + coveredTop) {
					// Commit is above what is visible on screen (below the sticky controls)
					this.viewElem.scroll(0, elemTop - coveredTop - 8);
				} else if (elemTop - visibleBottom + 32 > this.viewElem.scrollTop) {
					// Commit is below what is visible on screen
					this.viewElem.scroll(0, elemTop - visibleBottom + 32);
				}
			} else {
				const elemTop = this.controlsElem.clientHeight + elem.offsetTop, cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
				const coveredTop = this.getCoveredTopHeight(), visibleBottom = this.viewElem.clientHeight - this.getCoveredBottomHeight();
				if (this.config.commitDetailsView.autoCenter) {
					// Center Commit Detail View setting is enabled (in the area below the sticky controls & frozen column headers)
					// elemTop - commit height [24px] + (commit details view height + commit height [24px]) / 2 - (visible bottom + covered top) / 2
					this.viewElem.scroll(0, elemTop - 12 + (cdvHeight - visibleBottom - coveredTop) / 2);
				} else if (elemTop - 32 < this.viewElem.scrollTop + coveredTop) {
					// Commit Detail View is opening above what is visible on screen (below the sticky controls & frozen column headers)
					// elemTop - commit height [24px] - desired gap from top [8px] < view scroll offset + covered top
					this.viewElem.scroll(0, elemTop - coveredTop - 32);
				} else if (elemTop + cdvHeight - visibleBottom + 8 > this.viewElem.scrollTop) {
					// Commit Detail View is opening below what is visible on screen (above the frozen footer)
					// elemTop + commit details view height + desired gap from bottom [8px] - visible bottom > view scroll offset
					this.viewElem.scroll(0, elemTop + cdvHeight - visibleBottom + 8);
				}
			}
		}

		this.makeCdvResizable();
		document.getElementById('cdvClose')!.addEventListener('click', () => {
			this.closeCommitDetails(true);
		});

		if (isRight) this.makeCdvHeaderInteractive();
		if (isRight && !expandedCommit.loading) this.makeCdvFileFocusInteractive();

		if (!expandedCommit.loading) {
			this.cdvFileView.makeCdvFileViewInteractive();
			this.renderCdvActions();
			this.cdvFileView.renderCdvFileViewTypeBtns();
			this.cdvFileView.renderCdvExternalDiffBtn();
			this.makeCdvDividerDraggable();

			observeElemScroll('cdvSummary', expandedCommit.scrollTop.summary, (scrollTop) => {
				if (this.expandedCommit === null) return;
				this.expandedCommit.scrollTop.summary = scrollTop;
				if (this.expandedCommit.contextMenuOpen.summary) {
					this.expandedCommit.contextMenuOpen.summary = false;
					contextMenu.close();
				}
			}, () => this.saveState());

			observeElemScroll(isRight ? 'cdvContent' : 'cdvFiles', expandedCommit.scrollTop.fileView, (scrollTop) => {
				if (this.expandedCommit === null) return;
				this.expandedCommit.scrollTop.fileView = scrollTop;
				if (this.expandedCommit.contextMenuOpen.fileView > -1) {
					this.expandedCommit.contextMenuOpen.fileView = -1;
					contextMenu.close();
				}
			}, () => this.saveState());

			document.getElementById('cdvFileViewTypeTree')!.addEventListener('click', () => {
				this.cdvFileView.changeFileViewType(GG.FileViewType.Tree);
			});

			document.getElementById('cdvFileViewTypeList')!.addEventListener('click', () => {
				this.cdvFileView.changeFileViewType(GG.FileViewType.List);
			});

			if (codeReviewPossible) {
				this.renderCodeReviewBtn();
				document.getElementById('cdvCodeReview')!.addEventListener('click', (e) => {
					const expandedCommit = this.expandedCommit;
					if (expandedCommit === null || e.target === null) return;
					let sourceElem = <HTMLElement>(<Element>e.target).closest('#cdvCodeReview')!;
					if (sourceElem.classList.contains(CLASS_ACTIVE)) {
						sendMessage({ command: 'endCodeReview', repo: this.currentRepo, id: expandedCommit.codeReview!.id });
						this.endCodeReview();
					} else {
						const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
						const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;
						sendMessage({
							command: 'startCodeReview',
							repo: this.currentRepo,
							id: id,
							commitHash: expandedCommit.commitHash,
							compareWithHash: expandedCommit.compareWithHash,
							files: getFilesInTree(expandedCommit.fileTree!, expandedCommit.fileChanges!),
							lastViewedFile: expandedCommit.lastViewedFile
						});
					}
				});
			}

			if (externalDiffPossible) {
				document.getElementById('cdvExternalDiff')!.addEventListener('click', () => {
					const expandedCommit = this.expandedCommit;
					if (expandedCommit === null || this.gitConfig === null || (this.gitConfig.diffTool === null && this.gitConfig.guiDiffTool === null)) return;
					const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
					runAction({
						command: 'openExternalDirDiff',
						repo: this.currentRepo,
						fromHash: commitOrder.from,
						toHash: commitOrder.to,
						isGui: this.gitConfig.guiDiffTool !== null
					}, t('Opening External Directory Diff'));
				});
			}
		}
	}

	/**
	 * Generate the HTML of the summary of a commit, in the Commit Details View docked to the right.
	 * @param commitDetails The details of the commit.
	 * @param avatar The avatar of the commit's author (if available).
	 * @param fileChanges The files changed by the commit.
	 * @param textFormatter The TextFormatter used to format the commit message.
	 * @param subject The subject of the commit message.
	 * @param body The body of the commit message.
	 * @returns The HTML.
	 */
	private generateCdvSummaryHtml(commitDetails: GG.GitCommitDetails, avatar: string | null, fileChanges: ReadonlyArray<GG.GitFileChange>, textFormatter: TextFormatter, subject: string, body: string) {
		const index = this.commitLookup[commitDetails.hash];
		const issues = this.getIssueLinks(commitDetails.body);
		const branches = typeof index === 'number' ? this.getBranchesContainingCommit(index) : [];
		const remoteUrl = this.getRemoteCommitUrl(commitDetails.hash);
		return '<div class="cdvAuthor">' + (avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + avatar + '"></span>' : generateAuthorInitialHtml(commitDetails.author)) +
			'<span class="cdvAuthorText"><span><b>' + escapeHtml(commitDetails.author) + '</b>' + (commitDetails.authorEmail !== '' ? ' <span class="cdvMuted">&lt;' + escapeHtml(commitDetails.authorEmail) + '&gt;</span>' : '') + '</span>' +
			'<span class="cdvMuted" title="' + escapeHtml(formatLongDate(commitDetails.committerDate)) + '">' + t('Committed {0}', formatRelativeDate(commitDetails.committerDate)) + ' · ' + formatIsoDateTime(commitDetails.committerDate) + '</span></span></div>' +
			'<div class="cdvChips"><button type="button" id="cdvCopyHash" class="cdvChip mono" title="' + t('Copy Commit Hash to Clipboard') + '" tabindex="-1">' + SVG_ICONS.copy + escapeHtml(abbrevCommit(commitDetails.hash)) + '</button>' +
			(remoteUrl !== null ? '<button type="button" id="cdvOpenOnRemote" class="cdvChip" title="' + escapeHtml(remoteUrl) + '" tabindex="-1">' + SVG_ICONS.linkExternal + t('Open on Remote') + '</button>' : '') +
			'<button type="button" id="cdvCompare" class="cdvChip' + (this.cdvComparePending ? ' active' : '') + '" title="' + t('Click on another commit to compare it with this commit') + '" tabindex="-1">' + SVG_ICONS.compare + (this.cdvComparePending ? t('Click on a commit to compare with') : t('Compare with…')) + '</button></div>' +
			'<h2 class="cdvSubject">' + textFormatter.format(subject) + '</h2>' +
			(body !== '' ? '<div class="cdvBody">' + textFormatter.format(body) + '</div>' : '') +
			(this.getCdvFileFocus(commitDetails.hash, fileChanges) !== null ? this.generateCdvFileFocusHtml(commitDetails.hash, fileChanges) : (issues.length > 0 ? '<div class="cdvLine"><span class="cdvMuted">' + t('Related Issues') + '</span>' + issues.map((issue) => '<a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(issue.url) + '" tabindex="-1">' + escapeHtml(issue.label) + '</a>').join('') + '</div>' : '') +
			(branches.length > 0 ? '<div class="cdvLine"><span class="cdvMuted">' + t('On Branches') + '</span>' + branches.map((branch) => '<span class="cdvBranch' + (branch.remote ? ' remote' : '') + '" style="--git-graph-color:' + escapeHtml(branch.colour) + '">' + escapeHtml(branch.name) + '</span>').join('') + '</div>' : '') +
			generateCdvStatsHtml(fileChanges) +
			'<div id="cdvActions"></div>');
	}

	/**
	 * Get the file the Commit Details View docked to the right focuses on: the file whose history is shown (unless the whole commit is shown).
	 * @param hash The hash of the commit.
	 * @param fileChanges The files changed by the commit.
	 * @returns The index of the file in the files changed by the commit, or NULL if the Commit Details View doesn't focus on a file.
	 */
	private getCdvFileFocus(hash: string, fileChanges: ReadonlyArray<GG.GitFileChange>) {
		if (this.fileHistory === null || this.cdvShowWholeCommit || !this.isCdvDocked() || !this.isCdvDockedRight()) return null;
		const historyCommit = this.fileHistoryData !== null ? this.fileHistoryData.commits[hash] : undefined;
		const filePath = typeof historyCommit !== 'undefined' ? historyCommit.filePath : this.fileHistory;
		const index = fileChanges.findIndex((file) => file.newFilePath === filePath || file.oldFilePath === filePath);
		return index > -1 ? index : null;
	}

	/**
	 * Generate the HTML of the changes made by a commit to the file whose history is shown, in the Commit Details View docked to the right.
	 * @param hash The hash of the commit.
	 * @param fileChanges The files changed by the commit.
	 * @returns The HTML.
	 */
	private generateCdvFileFocusHtml(hash: string, fileChanges: ReadonlyArray<GG.GitFileChange>) {
		const file = fileChanges[this.getCdvFileFocus(hash, fileChanges)!], textFile = file.additions !== null && file.deletions !== null;
		return '<div id="cdvFileFocus"><div class="cdvFileFocusFile"><span class="fileTreeFileBadge ' + file.type + '">' + file.type + '</span>' + fileIcons.getFileIcon(file.newFilePath) +
			'<span class="cdvFileFocusPath" title="' + escapeHtml(file.newFilePath) + '">' + escapeHtml(file.newFilePath) + '</span>' +
			(textFile ? '<span class="fileTreeFileAdd">+' + file.additions + '</span><span class="fileTreeFileDel">\u2212' + file.deletions + '</span>' + generateChangeBarHtml(file.additions!, file.deletions!, null) : '') + '</div>' +
			(file.type === GG.GitFileStatus.Renamed ? '<div class="cdvFileFocusRenamed">\u21aa ' + t('Renamed from {0}', escapeHtml(file.oldFilePath)) + '</div>' : '') +
			'<div class="cdvFileFocusActions"><button type="button" id="cdvFileFocusDiff" class="cdvActionBtn primary" tabindex="-1">' + t('Open in Diff Editor') + '</button>' +
			(file.type !== GG.GitFileStatus.Deleted ? '<button type="button" id="cdvFileFocusOpen" class="cdvActionBtn" tabindex="-1">' + t('Open This Version') + '</button>' : '') +
			'<button type="button" id="cdvFileFocusAll" class="cdvActionBtn" tabindex="-1">' + t('View the Whole Commit ({0} files)', fileChanges.length) + '</button></div>' +
			'<div id="cdvFileDiff">' + this.generateCdvFileDiffHtml(hash, file) + '</div></div>';
	}

	/**
	 * Generate the HTML of the diff of the file the Commit Details View focuses on (requesting it from the extension if it hasn't been loaded).
	 * @param hash The hash of the commit.
	 * @param file The file.
	 * @returns The HTML.
	 */
	private generateCdvFileDiffHtml(hash: string, file: GG.GitFileChange) {
		const key = hash + ':' + file.newFilePath;
		if (this.cdvFileDiff === null || this.cdvFileDiff.key !== key) {
			this.cdvFileDiff = { key: key, diff: null, error: null };
			const commit = this.commits[this.commitLookup[hash]];
			const parentHash = this.expandedCommit !== null && this.expandedCommit.commitDetails !== null && this.expandedCommit.commitDetails.hash === hash
				? (this.expandedCommit.commitDetails.parents.length > 0 ? this.expandedCommit.commitDetails.parents[0] : null)
				: (typeof commit !== 'undefined' && commit.parents.length > 0 ? commit.parents[0] : null);
			sendMessage({ command: 'loadFileDiff', repo: this.currentRepo, commitHash: hash, parentHash: parentHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath });
		}
		return this.cdvFileDiff.diff !== null
			? generateFileDiffHtml(this.cdvFileDiff.diff, 40)
			: '<div class="cdvFileDiffMessage">' + (this.cdvFileDiff.error !== null ? escapeHtml(this.cdvFileDiff.error) : t('Loading the changes') + ELLIPSIS) + '</div>';
	}

	/**
	 * Process the diff of a file loaded by the extension, for the Commit Details View.
	 * @param msg The message containing the diff.
	 */
	public processLoadFileDiffResponse(msg: GG.ResponseLoadFileDiff) {
		const key = msg.commitHash + ':' + msg.filePath;
		if (this.cdvFileDiff === null || this.cdvFileDiff.key !== key) return;
		this.cdvFileDiff = { key: key, diff: msg.error === null ? msg.diff : null, error: msg.error };
		const diffElem = document.getElementById('cdvFileDiff');
		if (diffElem === null || this.expandedCommit === null || this.expandedCommit.fileChanges === null) return;
		const index = this.getCdvFileFocus(msg.commitHash, this.expandedCommit.fileChanges);
		if (index !== null) diffElem.innerHTML = this.generateCdvFileDiffHtml(msg.commitHash, this.expandedCommit.fileChanges[index]);
	}

	/**
	 * Add the event listeners to the changes to the file the Commit Details View focuses on.
	 */
	private makeCdvFileFocusInteractive() {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || document.getElementById('cdvFileFocus') === null) return;
		const index = this.getCdvFileFocus(expandedCommit.commitHash, expandedCommit.fileChanges);
		if (index === null) return;
		// The actions are performed on the file in the file view, so that its state (e.g. the last file viewed, and the files reviewed) is updated
		const clickFileView = (selector: string) => {
			const elem = document.querySelector('#cdvFileView .fileTreeFileRecord[data-index="' + index + '"] ' + selector);
			if (elem !== null) elem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		};
		const diffElem = document.getElementById('cdvFileFocusDiff'), openElem = document.getElementById('cdvFileFocusOpen'), allElem = document.getElementById('cdvFileFocusAll');
		if (diffElem !== null) diffElem.addEventListener('click', () => clickFileView('.fileTreeFile'));
		if (openElem !== null) openElem.addEventListener('click', () => clickFileView('.viewGitFileAtRevision'));
		if (allElem !== null) allElem.addEventListener('click', () => {
			this.cdvShowWholeCommit = true;
			this.renderCommitDetailsView(true);
		});
		document.getElementById('cdvFileDiff')!.addEventListener('click', (e) => {
			if ((<Element>e.target).closest('.cdvFileDiffOpen') !== null) clickFileView('.fileTreeFile');
		});
	}

	/**
	 * Show the history of a file (only the commits that change it), or all commits.
	 * @param filePath The path of the file, or NULL to show all commits.
	 */
	public setFileHistory(filePath: string | null, lineRange: GG.GitLineRange | null = null) {
		if (filePath === null) lineRange = null;
		if (filePath === this.fileHistory && JSON.stringify(lineRange) === JSON.stringify(this.fileHistoryLines)) return;
		this.fileHistory = filePath;
		this.fileHistoryLines = lineRange;
		this.fileHistoryData = null;
		this.cdvShowWholeCommit = false;
		this.maxCommits = this.config.initialLoadCommits;
		this.renderFileHistoryBar();
		this.saveState();
		this.clearCommits();
		this.requestLoadRepoInfoAndCommits(true, true);
	}

	/**
	 * Render the bar shown below the control bar when the history of a file is shown.
	 */
	private renderFileHistoryBar() {
		const elem = document.getElementById('fileHistoryBar');
		if (elem === null) return;
		alterClass(elem, CLASS_ACTIVE, this.fileHistory !== null);
		alterClass(document.body, 'fileHistory', this.fileHistory !== null);
		if (this.fileHistory === null) {
			elem.innerHTML = '';
			return;
		}
		const commits = this.loadedCommits.filter((commit) => commit.hash !== UNCOMMITTED && commit.stash === null), count = commits.length;
		const authors = new Set(commits.map((commit) => commit.author)).size, renames = this.fileHistoryData !== null ? this.fileHistoryData.paths.length - 1 : 0;
		const allBranches = this.currentBranches === null || this.currentBranches.includes(SHOW_ALL_BRANCHES);
		const currentBranch = this.gitBranchHead !== null && this.currentBranches !== null && this.currentBranches.length === 1 && this.currentBranches[0] === this.gitBranchHead;
		const summary = [
			this.moreCommitsAvailable ? t('{0}+ commits', count) : count !== 1 ? t('{0} commits', count) : t('{0} commit', count),
			authors !== 1 ? t('{0} authors', authors) : t('{0} author', authors)
		].concat(renames > 0 ? [renames !== 1 ? t('followed {0} renames', renames) : t('followed 1 rename')] : []);
		const lines = this.fileHistoryLines !== null ? '<span class="fileHistoryLines">' + (this.fileHistoryLines.start !== this.fileHistoryLines.end ? t('Lines {0}–{1}', this.fileHistoryLines.start, this.fileHistoryLines.end) : t('Line {0}', this.fileHistoryLines.start)) + '</span>' : '';
		elem.innerHTML = fileIcons.getFileIcon(this.fileHistory) + '<b>' + (this.fileHistoryLines !== null ? t('Line History') : t('File History')) + '</b>' + lines +
			'<span class="fileHistoryPath" title="' + escapeHtml(this.fileHistory) + '"><span>' + escapeHtml(this.fileHistory) + '</span><span id="fileHistoryCopy" title="' + t('Copy Relative File Path to Clipboard') + '">' + SVG_ICONS.copy + '</span></span>' +
			'<span class="fileHistorySummary">' + summary.join(' · ') + '</span><span class="fileHistorySpacer"></span>' +
			'<span id="fileHistoryBranches" role="group"><span class="fileHistoryBranchesOption' + (allBranches ? ' active' : '') + '" data-value="all">' + t('All Branches') + '</span><span class="fileHistoryBranchesOption' + (currentBranch ? ' active' : '') + (this.gitBranchHead === null ? ' disabled' : '') + '" data-value="current">' + t('Current Branch') + '</span></span>' +
			'<span id="fileHistoryOpen" class="fileHistoryBtn">' + SVG_ICONS.openFile + t('Open in Editor') + '</span>' +
			'<span id="fileHistoryExit" class="fileHistoryBtn exit" title="' + t('Show all of the commits') + '">' + (this.fileHistoryLines !== null ? t('Exit Line History') : t('Exit File History')) + SVG_ICONS.close + '</span>';

		const filePath = this.fileHistory;
		document.getElementById('fileHistoryCopy')!.addEventListener('click', () => sendMessage({ command: 'copyFilePath', repo: this.currentRepo, filePath: filePath, absolute: false }));
		document.getElementById('fileHistoryOpen')!.addEventListener('click', () => {
			const latest = this.loadedCommits.find((commit) => commit.hash !== UNCOMMITTED);
			runAction({ command: 'openFile', repo: this.currentRepo, hash: typeof latest !== 'undefined' ? latest.hash : (this.commitHead || ''), filePath: filePath }, t('Opening File'));
		});
		document.getElementById('fileHistoryExit')!.addEventListener('click', () => this.setFileHistory(null));
		document.querySelectorAll<HTMLElement>('.fileHistoryBranchesOption').forEach((optionElem) => optionElem.addEventListener('click', () => {
			if (optionElem.classList.contains(CLASS_ACTIVE) || optionElem.classList.contains(CLASS_DISABLED)) return;
			this.currentBranches = optionElem.dataset.value === 'current' && this.gitBranchHead !== null ? [this.gitBranchHead] : [SHOW_ALL_BRANCHES];
			this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		}));
	}

	/**
	 * Get the issues linked to by a commit message, according to the repository's Issue Linking configuration.
	 * @param message The commit message.
	 * @returns The label & URL of each issue.
	 */
	private getIssueLinks(message: string) {
		const config = this.gitRepos[this.currentRepo].issueLinkingConfig || globalState.issueLinkingConfig;
		const links: { label: string, url: string }[] = [];
		if (config === null) return links;
		let regex: RegExp;
		try {
			regex = new RegExp(config.issue, 'gu');
		} catch (_) {
			return links;
		}
		let match: RegExpExecArray | null;
		while ((match = regex.exec(message)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			const groups = match;
			if (!links.some((link) => link.label === groups[0])) {
				links.push({ label: groups[0], url: config.url.replace(/\$([1-9])/g, (_, n) => groups[parseInt(n)] || '') });
			}
		}
		return links;
	}

	/**
	 * Get the branches (on the loaded commits) that contain a commit.
	 * @param index The index of the commit.
	 * @returns The name, colour (of its branch on the graph) & whether it's a remote branch, of each branch.
	 */
	private getBranchesContainingCommit(index: number) {
		const colours = this.config.graph.colours, vertexColours = this.graph.getVertexColours();
		const reachable: { [hash: string]: boolean } = {}, local: { name: string, remote: boolean, colour: string }[] = [], remote: { name: string, remote: boolean, colour: string }[] = [];
		for (let i = index; i >= 0; i--) {
			const commit = this.commits[i];
			if (i !== index && !commit.parents.some((parent) => reachable[parent])) continue;
			reachable[commit.hash] = true;
			const colour = colours[(vertexColours[i] >= 0 ? vertexColours[i] : 0) % colours.length];
			commit.heads.forEach((name) => local.push({ name: name, remote: false, colour: colour }));
			commit.remotes.forEach((ref) => remote.push({ name: ref.name, remote: true, colour: colour }));
		}
		return local.concat(remote).slice(0, 12);
	}

	/**
	 * Get the URL of a commit on the web page of the repository's remote (origin, or its first remote), for GitHub, GitLab, Bitbucket, Gitea & similar hosts.
	 * @param hash The hash of the commit.
	 * @returns The URL, or NULL if the remote's URL isn't known.
	 */
	private getRemoteCommitUrl(hash: string) {
		if (this.gitConfig === null) return null;
		const remote = this.gitConfig.remotes.find((remote) => remote.name === 'origin' && remote.url !== null) || this.gitConfig.remotes.find((remote) => remote.url !== null);
		if (typeof remote === 'undefined' || remote.url === null) return null;
		const url = remote.url.trim();
		let match: RegExpMatchArray | null, webUrl: string;
		if ((match = url.match(/^(https?):\/\/(?:[^@\/]+@)?(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = match[1] + '://' + match[2];
		} else if ((match = url.match(/^ssh:\/\/(?:[^@\/]+@)?([^:\/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = 'https://' + match[1] + '/' + match[2];
		} else if ((match = url.match(/^[^@\s\/]+@([^:\s]+):(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = 'https://' + match[1] + '/' + match[2];
		} else {
			return null;
		}
		return webUrl + (/bitbucket/i.test(webUrl) ? '/commits/' : '/commit/') + hash;
	}

	/**
	 * Add the event listeners to the header & summary of the Commit Details View docked to the right.
	 */
	private makeCdvHeaderInteractive() {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null) return;
		const navigate = (offset: number) => {
			if (this.expandedCommit === null || this.expandedCommit.compareWithHash !== null) return;
			const elem = this.getCommitElem(this.commitLookup[this.expandedCommit.commitHash] + offset);
			if (elem !== null) this.loadCommitDetails(elem);
		};
		const prevElem = document.getElementById('cdvPrev'), nextElem = document.getElementById('cdvNext');
		if (prevElem !== null) prevElem.addEventListener('click', () => navigate(-1));
		if (nextElem !== null) nextElem.addEventListener('click', () => navigate(1));

		const copyHashElem = document.getElementById('cdvCopyHash');
		if (copyHashElem !== null) copyHashElem.addEventListener('click', () => sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: expandedCommit.commitHash }));
		const openOnRemoteElem = document.getElementById('cdvOpenOnRemote');
		if (openOnRemoteElem !== null) openOnRemoteElem.addEventListener('click', () => {
			const url = this.getRemoteCommitUrl(expandedCommit.commitHash);
			if (url !== null) sendMessage({ command: 'openExternalUrl', url: url });
		});
		const compareElem = document.getElementById('cdvCompare');
		if (compareElem !== null) compareElem.addEventListener('click', () => {
			this.cdvComparePending = !this.cdvComparePending;
			alterClass(compareElem, CLASS_ACTIVE, this.cdvComparePending);
			compareElem.innerHTML = SVG_ICONS.compare + (this.cdvComparePending ? t('Click on a commit to compare with') : t('Compare with…'));
		});

		addListenerToClass('cdvTab', 'click', (e) => {
			const tab = (<HTMLElement>(<Element>e.target).closest('.cdvTab')!).dataset.tab;
			document.querySelectorAll<HTMLElement>('.cdvTab').forEach((elem) => alterClass(elem, CLASS_ACTIVE, elem.dataset.tab === tab));
			const fileViewElem = document.getElementById('cdvFileView'), messageViewElem = document.getElementById('cdvMessageView');
			if (fileViewElem !== null) alterClass(fileViewElem, 'hidden', tab !== 'files');
			if (messageViewElem !== null) alterClass(messageViewElem, 'hidden', tab !== 'message');
		});
	}

	/**
	 * Render the buttons of the most common actions (and a button that opens all of the actions) for the commit shown in the Commit Details View.
	 */
	private renderCdvActions() {
		const expandedCommit = this.expandedCommit, actionsElem = document.getElementById('cdvActions');
		if (expandedCommit === null || expandedCommit.commitElem === null || actionsElem === null) return;
		const commit = this.commits[this.commitLookup[expandedCommit.commitHash]];
		if (typeof commit === 'undefined') return;

		const target: ContextMenuTarget & DialogTarget & CommitTarget = {
			type: TargetType.Commit,
			hash: commit.hash,
			index: parseInt(expandedCommit.commitElem.dataset.id!),
			elem: expandedCommit.commitElem
		};
		let actions: ContextMenuActions, primary: ContextMenuAction[];
		if (commit.hash === UNCOMMITTED) {
			actions = this.actions.getUncommittedChangesContextMenuActions(target);
			primary = actions.reduce<ContextMenuAction[]>((all, group) => all.concat(group), []);
		} else if (commit.stash !== null) {
			target.ref = commit.stash.selector;
			actions = this.actions.getStashContextMenuActions(<RefTarget>target);
			primary = actions.reduce<ContextMenuAction[]>((all, group) => all.concat(group), []);
		} else {
			actions = this.actions.getCommitContextMenuActions(target);
			primary = [actions[1][0], actions[0][1], actions[1][1]]; // Checkout, Create Branch & Cherry Pick
		}
		primary = primary.filter((action) => action.visible).slice(0, 3);

		actionsElem.innerHTML = primary.map((action, i) => '<button type="button" class="cdvActionBtn' + (i === 0 ? ' primary' : '') + '" data-index="' + i + '" tabindex="-1">' + action.title + '</button>').join('')
			+ '<button type="button" id="cdvMoreActions" class="cdvActionBtn" title="' + t('More Actions') + '" tabindex="-1">&#183;&#183;&#183;</button>';
		actionsElem.querySelectorAll('.cdvActionBtn[data-index]').forEach((elem) => {
			elem.addEventListener('click', () => primary[parseInt((<HTMLElement>elem).dataset.index!)].onClick());
		});
		document.getElementById('cdvMoreActions')!.addEventListener('click', (e) => {
			handledEvent(e); // Don't let the click propagate to the document, which closes context menus
			contextMenu.show(actions, false, target, <MouseEvent>e, this.isCdvDocked() ? document.body : this.viewElem);
		});
	}

	private setCdvHeight(elem: HTMLElement, isDocked: boolean) {
		if (isDocked && this.isCdvDockedRight()) {
			const width = this.getCdvWidth(), widthPx = width + 'px';
			elem.style.width = widthPx;
			this.viewElem.style.right = widthPx;
			document.body.classList.add(CLASS_CDV_DOCKED_RIGHT);
			document.body.style.setProperty('--git-graph-cdvWidth', widthPx);
			return;
		}

		let height = this.gitRepos[this.currentRepo].cdvHeight, windowHeight = window.innerHeight;
		if (height > windowHeight - 40) {
			height = Math.max(windowHeight - 40, 100);
			if (height !== this.gitRepos[this.currentRepo].cdvHeight) {
				this.gitRepos[this.currentRepo].cdvHeight = height;
				this.saveRepoState();
			}
		}

		let heightPx = height + 'px';
		elem.style.height = heightPx;
		if (isDocked) this.viewElem.style.bottom = heightPx;
	}

	private setCdvDivider() {
		let percent = (this.gitRepos[this.currentRepo].cdvDivider * 100).toFixed(2) + '%';
		let summaryElem = document.getElementById('cdvSummary'), dividerElem = document.getElementById('cdvDivider'), filesElem = document.getElementById('cdvFiles');
		if (this.isCdvDocked() && this.isCdvDockedRight()) {
			// The summary is above the files
			if (summaryElem !== null) summaryElem.style.height = percent;
			if (dividerElem !== null) dividerElem.style.top = percent;
			if (filesElem !== null) filesElem.style.top = percent;
		} else {
			if (summaryElem !== null) summaryElem.style.width = percent;
			if (dividerElem !== null) dividerElem.style.left = percent;
			if (filesElem !== null) filesElem.style.left = percent;
		}
	}

	/**
	 * Get the width of the Commit Details View when it's docked to the right, limited to the width of the Webview.
	 * @returns The width (in pixels).
	 */
	private getCdvWidth() {
		const maxWidth = Math.max(window.innerWidth - 240, CDV_MIN_WIDTH);
		return Math.min(Math.max(this.gitRepos[this.currentRepo].cdvWidth || CDV_DEFAULT_WIDTH, CDV_MIN_WIDTH), maxWidth);
	}

	private makeCdvResizable() {
		let prevY = -1, prevX = -1;

		const processResizingCdvWidth: EventListener = (e) => {
			if (prevX < 0) return;
			const delta = (<MouseEvent>e).pageX - prevX;
			prevX = (<MouseEvent>e).pageX;
			const width = Math.min(Math.max(this.getCdvWidth() - delta, CDV_MIN_WIDTH), Math.max(window.innerWidth - 240, CDV_MIN_WIDTH));
			if (this.gitRepos[this.currentRepo].cdvWidth !== width) {
				this.gitRepos[this.currentRepo].cdvWidth = width;
				const elem = document.getElementById('cdv');
				if (elem !== null) this.setCdvHeight(elem, true);
			}
		};
		const stopResizingCdvWidth: EventListener = (e) => {
			if (prevX < 0) return;
			processResizingCdvWidth(e);
			this.saveRepoState();
			prevX = -1;
			eventOverlay.remove();
		};

		const processResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			let delta = (<MouseEvent>e).pageY - prevY, isDocked = this.isCdvDocked(), windowHeight = window.innerHeight;
			prevY = (<MouseEvent>e).pageY;
			let height = this.gitRepos[this.currentRepo].cdvHeight + (isDocked ? -delta : delta);
			if (height < 100) height = 100;
			else if (height > 600) height = 600;
			if (height > windowHeight - 40) height = Math.max(windowHeight - 40, 100);

			if (this.gitRepos[this.currentRepo].cdvHeight !== height) {
				this.gitRepos[this.currentRepo].cdvHeight = height;
				let elem = document.getElementById('cdv');
				if (elem !== null) this.setCdvHeight(elem, isDocked);
				if (!isDocked) this.renderGraph();
			}
		};
		const stopResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			processResizingCdvHeight(e);
			this.saveRepoState();
			prevY = -1;
			eventOverlay.remove();
		};

		addListenerToClass('cdvHeightResize', 'mousedown', (e) => {
			if (this.isCdvDocked() && this.isCdvDockedRight()) {
				prevX = (<MouseEvent>e).pageX;
				eventOverlay.create('colResize', processResizingCdvWidth, stopResizingCdvWidth);
			} else {
				prevY = (<MouseEvent>e).pageY;
				eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);
			}
		});
	}

	private makeCdvDividerDraggable() {
		let minX = -1, width = -1, vertical = false;

		const processDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			let percent = ((vertical ? (<MouseEvent>e).clientY : (<MouseEvent>e).clientX) - minX) / width;
			if (percent < 0.2) percent = 0.2;
			else if (percent > 0.8) percent = 0.8;

			if (this.gitRepos[this.currentRepo].cdvDivider !== percent) {
				this.gitRepos[this.currentRepo].cdvDivider = percent;
				this.setCdvDivider();
			}
		};
		const stopDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			processDraggingCdvDivider(e);
			this.saveRepoState();
			minX = -1;
			eventOverlay.remove();
		};

		document.getElementById('cdvDivider')!.addEventListener('mousedown', () => {
			const contentElem = document.getElementById('cdvContent');
			if (contentElem === null) return;

			const bounds = contentElem.getBoundingClientRect();
			vertical = this.isCdvDocked() && this.isCdvDockedRight();
			minX = vertical ? bounds.top : bounds.left;
			width = vertical ? bounds.height : bounds.width;
			eventOverlay.create(vertical ? 'rowResize' : 'colResize', processDraggingCdvDivider, stopDraggingCdvDivider);
		});
	}

	public isCdvDocked() {
		return this.config.commitDetailsView.location !== GG.CommitDetailsViewLocation.Inline;
	}

	private isCdvDockedRight() {
		return this.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToRight;
	}

	public isCdvOpen(commitHash: string, compareWithHash: string | null) {
		return this.expandedCommit !== null && this.expandedCommit.commitHash === commitHash && this.expandedCommit.compareWithHash === compareWithHash;
	}

	public getCommitOrder(hash1: string, hash2: string) {
		if (this.commitLookup[hash1] > this.commitLookup[hash2]) {
			return { from: hash1, to: hash2 };
		} else {
			return { from: hash2, to: hash1 };
		}
	}

	public static closeCdvContextMenuIfOpen(expandedCommit: ExpandedCommit) {
		if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {
			expandedCommit.contextMenuOpen.summary = false;
			expandedCommit.contextMenuOpen.fileView = -1;
			contextMenu.close();
		}
	}


	/* Code Review */

	public startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {
		if (this.expandedCommit === null || this.expandedCommit.commitHash !== commitHash || this.expandedCommit.compareWithHash !== compareWithHash) return;
		this.saveAndRenderCodeReview(codeReview);
	}

	public endCodeReview() {
		if (this.expandedCommit === null || this.expandedCommit.codeReview === null) return;
		this.saveAndRenderCodeReview(null);
	}

	private saveAndRenderCodeReview(codeReview: GG.CodeReview | null) {
		let filesElem = getCdvFileViewElem();
		if (this.expandedCommit === null || this.expandedCommit.fileTree === null || filesElem === null) return;

		this.expandedCommit.codeReview = codeReview;
		setFileTreeReviewed(this.expandedCommit.fileTree, codeReview === null);
		this.saveState();
		this.renderCodeReviewBtn();
		updateFileTreeHtml(filesElem, this.expandedCommit.fileTree);
	}

	public renderCodeReviewBtn() {
		if (this.expandedCommit === null) return;
		let btnElem = document.getElementById('cdvCodeReview');
		if (btnElem === null) return;

		let active = this.expandedCommit.codeReview !== null;
		alterClass(btnElem, CLASS_ACTIVE, active);
		btnElem.title = active ? t('End Code Review') : t('Start Code Review');
	}
}


/* Main */

const contextMenu = new ContextMenu(), dialog = new Dialog(), eventOverlay = new EventOverlay(), titleTooltip = new TitleTooltip(), fileIcons = new FileIcons();
let loaded = false;

window.addEventListener('load', () => {
	if (loaded) return;
	loaded = true;

	TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);

	const viewElem = document.getElementById('view');
	if (viewElem === null) return;

	const gitGraph = new GitGraphView(viewElem, VSCODE_API.getState());
	const imageResizer = new ImageResizer();

	observeResponseMessages(gitGraph, imageResizer);
});
