const CLASS_FIND_CURRENT_COMMIT = 'findCurrentCommit';
const CLASS_FIND_MATCH = 'findMatch';
const CLASS_FIND_MATCH_ROW = 'findMatchRow';

const enum FindMode {
	Highlight = 'highlight',
	Filter = 'filter'
}

interface FindWidgetState {
	readonly text: string;
	readonly currentHash: string | null;
	readonly visible: boolean;
	readonly mode?: FindMode;
}

interface FindQuery {
	readonly text: string;
	readonly author: string[];
	readonly message: string[];
	readonly commit: string[];
	readonly file: string[];
	readonly change: string[];
	readonly after: string[];
	readonly before: string[];
}

const FIND_OPERATORS: { readonly [operator: string]: 'author' | 'message' | 'commit' | 'file' | 'change' | 'after' | 'before' } = {
	'author:': 'author', '@:': 'author',
	'message:': 'message', '=:': 'message',
	'commit:': 'commit', '#:': 'commit',
	'file:': 'file', '?:': 'file',
	'change:': 'change', '~:': 'change',
	'after:': 'after', '>:': 'after',
	'before:': 'before', '<:': 'before'
};

/**
 * Implements the Git Map View's Find Widget: the search box in the control bar (whose conditions are shown as chips), and the bar of
 * its results (the number of matches, the previous / next match, whether matches are highlighted or only the matches are shown, and the
 * search operators).
 */
class FindWidget {
	private readonly view: GitGraphView;
	private chips: string[] = [];
	private text: string = '';
	private matches: { hash: string }[] = [];
	private highlight: { pattern: RegExp, findPattern: RegExp | null, commitPatternUsed: boolean, colVisibility: { date: boolean, author: boolean, commit: boolean } } | null = null; // How the matches are highlighted
	private position: number = -1;
	private visible: boolean = false;
	private mode: FindMode = FindMode.Highlight;
	private savedFilters: ReadonlyArray<GG.SavedFilterPreset> = [];

	/* The commits matched by the file: & change: operators, which are searched for by the extension */
	private searchId: number = 0;
	private searchKey: string | null = null;
	private searchHashes: ReadonlySet<string> | null = null;

	private readonly widgetElem: HTMLElement;
	private readonly resultsElem: HTMLElement;
	private readonly chipsElem: HTMLElement;
	private readonly inputElem: HTMLInputElement;
	private readonly caseSensitiveElem: HTMLElement;
	private readonly regexElem: HTMLElement;
	private readonly countElem: HTMLElement;
	private readonly positionElem: HTMLElement;
	private readonly prevElem: HTMLElement;
	private readonly nextElem: HTMLElement;

	/**
	 * Construct a new FindWidget instance.
	 * @param view The Git Map View that the FindWidget is for.
	 * @returns The FindWidget instance.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		const controlsElem = document.getElementById('controls')!;

		this.widgetElem = document.createElement('div');
		this.widgetElem.className = 'findWidget';
		this.widgetElem.setAttribute('role', 'search');
		this.widgetElem.innerHTML = '<span id="findBtn" title="' + t('Find') + '">' + SVG_ICONS.search + '</span><span id="findChips"></span>' +
			'<input id="findInput" type="text" placeholder="' + t('Search commits') + ELLIPSIS + '" title="' + t('Search operators: author: (or @:), message: (or =:), commit: (or #:), file: (or ?:), change: (or ~:), after: (or >:), before: (or <:). Enclose a value containing spaces in double quotes. Press Enter to add the condition as a chip.') + '" tabindex="-1"/>' +
			'<span id="findCaseSensitive" class="findModifier" title="' + t('Match Case') + '">Aa</span><span id="findRegex" class="findModifier" title="' + t('Use Regular Expression') + '">.*</span>' +
			'<span id="findAiBtn" class="findModifier" title="' + t('AI Natural Language Search') + '">✨</span>' +
			'<span id="findClose" title="' + t('Clear Search (Escape)') + '">' + SVG_ICONS.close + '</span>';
		controlsElem.insertBefore(this.widgetElem, document.getElementById('scrollToHeadBtn'));

		this.resultsElem = document.createElement('div');
		this.resultsElem.id = 'findResults';
		this.resultsElem.innerHTML = '<span id="findCount"></span><span id="findPosition"></span><span id="findPrev" title="' + t('Previous match (Shift+Enter)') + '">' + SVG_ICONS.arrowUp + '</span><span id="findNext" title="' + t('Next match (Enter)') + '">' + SVG_ICONS.arrowDown + '</span>' +
			'<span id="findOpenCdv" title="' + t('Open the Commit Details View for the current match') + '">' + SVG_ICONS.cdv + '</span>' +
			'<span id="findModes" role="group"><span class="findMode" data-mode="' + FindMode.Highlight + '">' + t('Highlight Matches') + '</span><span class="findMode" data-mode="' + FindMode.Filter + '">' + t('Only Show Matches') + '</span></span>' +
			'<span class="findResultsSpacer"></span><span class="findSyntaxLabel">' + t('Search Syntax') + '</span>' +
			[
				{ operator: 'message:', short: '=:', description: t('The commit message contains') },
				{ operator: 'author:', short: '@:', description: t('The name or email of the author contains') },
				{ operator: 'commit:', short: '#:', description: t('The commit hash starts with') },
				{ operator: 'file:', short: '?:', description: t('A file whose path contains this is changed') },
				{ operator: 'change:', short: '~:', description: t('A line containing this is added or removed') },
				{ operator: 'after:', short: '>:', description: t('The commit is on or after this date (the date shown in the Date column): YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday, or a number of days, weeks, months or years ago (e.g. 7d, 2w, 3m, 1y)') },
				{ operator: 'before:', short: '<:', description: t('The commit is before this date (the date shown in the Date column): YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday, or a number of days, weeks, months or years ago (e.g. 7d, 2w, 3m, 1y)') }
			].map((button) => '<span class="findOperator" data-operator="' + button.operator + '" title="' + button.description + '">' + button.operator + '<span>' + button.short + '</span></span>').join('') +
			'<span id="findPresetsBtn" class="findPresetBtn" title="' + escapeHtml(t('Saved & Built-in Search Filter Presets')) + '">★ ' + t('Presets') + '</span>' +
			'<span id="findSavePresetBtn" class="findPresetBtn" title="' + escapeHtml(t('Save Current Search as Preset')) + '">' + t('Save') + '</span>' +
			'<span id="findClear">' + t('Clear Search') + '</span>';
		controlsElem.insertBefore(this.resultsElem, document.getElementById('minimap'));

		document.getElementById('findBtn')!.addEventListener('click', () => this.show(true));
		this.chipsElem = document.getElementById('findChips')!;
		this.chipsElem.addEventListener('click', (e) => {
			const removeElem = (<Element>e.target).closest('.findChipRemove');
			if (removeElem === null) return;
			this.chips.splice(parseInt((<HTMLElement>removeElem.parentElement!).dataset.index!), 1);
			this.renderChips();
			this.textChanged();
			this.inputElem.focus();
		});

		this.inputElem = <HTMLInputElement>document.getElementById('findInput')!;
		this.inputElem.addEventListener('focus', () => this.show(false));
		this.inputElem.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				if (this.inputElem.value.trim() !== '' && !e.shiftKey) {
					// Add the condition as a chip
					this.chips.push(this.inputElem.value.trim());
					this.inputElem.value = '';
					this.renderChips();
					this.textChanged();
				} else if (e.shiftKey) {
					this.prev();
				} else {
					this.next();
				}
				handledEvent(e);
			} else if (e.key === 'Backspace' && this.inputElem.value === '' && this.chips.length > 0) {
				// Edit the last chip
				this.inputElem.value = this.chips.pop()!;
				this.renderChips();
				handledEvent(e);
			}
		});
		let keyupTimeout: number | null = null;
		this.inputElem.addEventListener('keyup', () => {
			if (keyupTimeout !== null) clearTimeout(keyupTimeout);
			const combined = this.chips.concat(this.inputElem.value).join(' ');
			const delay = /(?:^|\s)(?:file:|\?:|change:|~:)\S/.test(combined) ? 450 : 200;
			keyupTimeout = setTimeout(() => {
				keyupTimeout = null;
				this.textChanged();
			}, delay);
		});

		this.caseSensitiveElem = document.getElementById('findCaseSensitive')!;
		alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
		this.caseSensitiveElem.addEventListener('click', () => {
			updateWorkspaceViewState('findIsCaseSensitive', !workspaceState.findIsCaseSensitive);
			alterClass(this.caseSensitiveElem, CLASS_ACTIVE, workspaceState.findIsCaseSensitive);
			this.update(true);
		});

		this.regexElem = document.getElementById('findRegex')!;
		alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
		this.regexElem.addEventListener('click', () => {
			updateWorkspaceViewState('findIsRegex', !workspaceState.findIsRegex);
			alterClass(this.regexElem, CLASS_ACTIVE, workspaceState.findIsRegex);
			this.update(true);
		});

		const findAiBtn = document.getElementById('findAiBtn');
		if (findAiBtn !== null) {
			findAiBtn.addEventListener('click', () => this.openAiSearchDialog());
		}

		const presetsBtn = document.getElementById('findPresetsBtn');
		if (presetsBtn !== null) {
			presetsBtn.addEventListener('click', (e) => this.openPresetsMenu(presetsBtn, e));
		}

		const savePresetBtn = document.getElementById('findSavePresetBtn');
		if (savePresetBtn !== null) {
			savePresetBtn.addEventListener('click', () => this.openSavePresetDialog());
		}

		this.countElem = document.getElementById('findCount')!;
		this.positionElem = document.getElementById('findPosition')!;

		this.prevElem = document.getElementById('findPrev')!;
		this.prevElem.classList.add(CLASS_DISABLED);
		this.prevElem.addEventListener('click', () => this.prev());

		this.nextElem = document.getElementById('findNext')!;
		this.nextElem.classList.add(CLASS_DISABLED);
		this.nextElem.addEventListener('click', () => this.next());

		const openCdvElem = document.getElementById('findOpenCdv')!;
		alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
		openCdvElem.addEventListener('click', () => {
			updateWorkspaceViewState('findOpenCommitDetailsView', !workspaceState.findOpenCommitDetailsView);
			alterClass(openCdvElem, CLASS_ACTIVE, workspaceState.findOpenCommitDetailsView);
			this.openCommitDetailsViewForCurrentMatchIfEnabled();
		});

		addListenerToClass('findMode', 'click', (e) => {
			const mode = <FindMode>(<HTMLElement>(<Element>e.target).closest('.findMode')!).dataset.mode;
			if (mode === this.mode) return;
			this.mode = mode;
			this.renderMode();
			this.update(true);
		});
		this.renderMode();

		addListenerToClass('findOperator', 'click', (e) => {
			const operator = (<HTMLElement>(<Element>e.target).closest('.findOperator')!).dataset.operator!;
			const value = this.inputElem.value;
			this.inputElem.value = value + (value !== '' && !/\s$/.test(value) ? ' ' : '') + operator;
			this.inputElem.focus();
		});

		document.getElementById('findClear')!.addEventListener('click', () => this.close());
		document.getElementById('findClose')!.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Find Widget's results, and focus its search box.
	 * @param focus Should the search box be focused.
	 */
	public show(focus: boolean) {
		if (!this.visible) {
			this.visible = true;
			this.updatePosition(-1, false);
			this.widgetElem.classList.add(CLASS_ACTIVE);
			this.resultsElem.classList.add(CLASS_ACTIVE);
			this.view.saveState();
		}
		if (focus) this.inputElem.focus();
	}

	/**
	 * Clear the search, and hide the Find Widget's results.
	 */
	public close() {
		if (!this.visible) return;
		this.visible = false;
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.resultsElem.classList.remove(CLASS_ACTIVE);
		this.clearMatches();
		this.chips = [];
		this.text = '';
		this.matches = [];
		this.highlight = null;
		this.position = -1;
		this.searchKey = null;
		this.searchHashes = null;
		this.inputElem.value = '';
		this.renderChips();
		this.inputElem.blur();
		this.widgetElem.removeAttribute(ATTR_ERROR);
		this.prevElem.classList.add(CLASS_DISABLED);
		this.nextElem.classList.add(CLASS_DISABLED);
		this.view.setCommitFilter(null);
		this.view.saveState();
		this.view.renderScrollMarkers();
	}

	/**
	 * Search for the commits in a range of dates (replacing the conditions on dates that were already added).
	 * @param after The first day of the range (YYYY-MM-DD).
	 * @param before The day after the range (YYYY-MM-DD).
	 */
	public searchDateRange(after: string, before: string) {
		this.chips = this.chips.filter((chip) => !/^(after:|>:|before:|<:)\S+$/.test(chip)).concat(['after:' + after, 'before:' + before]);
		this.renderChips();
		this.show(false);
		this.textChanged();
	}

	/**
	 * Get the hashes of the commits that match the Find Widget's criteria.
	 * @returns The hashes.
	 */
	public getMatchHashes() {
		return this.matches.map((match) => match.hash);
	}

	/**
	 * Refresh the Find Widget's state / matches after the commits have changed.
	 */
	public refresh() {
		if (this.visible) {
			this.requestSearchIfRequired(FindWidget.parseQuery(this.text));
			this.findMatches(this.getCurrentHash(), false);
		}
	}

	/**
	 * Set the colours used to indicate the find matches.
	 * @param colour The base colour for the find matches.
	 */
	public setColour(colour: string) {
		document.body.style.setProperty('--git-graph-findMatch', colour);
		document.body.style.setProperty('--git-graph-findMatchCommit', modifyColourOpacity(colour, 0.5));
	}


	/* State */

	/**
	 * Get the current state of the Find Widget.
	 */
	public getState(): FindWidgetState {
		return {
			text: this.text,
			currentHash: this.getCurrentHash(),
			visible: this.visible,
			mode: this.mode
		};
	}

	/**
	 * Get the commit hash of the current find match.
	 * @returns The commit hash, or NULL if no commit is currently matched.
	 */
	public getCurrentHash() {
		return this.position > -1 ? this.matches[this.position].hash : null;
	}

	/**
	 * Restore the Find Widget to an existing state.
	 * @param state The previous Find Widget state.
	 */
	public restoreState(state: FindWidgetState) {
		if (!state.visible) return;
		this.chips = state.text !== '' ? [state.text] : [];
		this.text = state.text;
		this.mode = state.mode || FindMode.Highlight;
		this.renderChips();
		this.renderMode();
		this.show(false);
		if (this.text !== '') this.update(false, state.currentHash);
	}

	/**
	 * Is the Find Widget currently visible.
	 * @returns TRUE => The Find Widget is visible, FALSE => The Find Widget is not visible
	 */
	public isVisible() {
		return this.visible;
	}

	/**
	 * Are only the commits that match the Find Widget's criteria shown.
	 * @returns TRUE => Only the matching commits are shown, FALSE => All commits are shown.
	 */
	public isFiltering() {
		return this.visible && this.mode === FindMode.Filter && this.text !== '';
	}

	/**
	 * Process the commits matched by the file: & change: operators, which were searched for by the extension.
	 * @param msg The message containing the matched commits.
	 */
	public processSearchCommitsResponse(msg: GG.ResponseSearchCommits) {
		if (msg.id !== this.searchId) return;
		if (msg.error !== null) {
			this.searchHashes = new Set();
			this.widgetElem.setAttribute(ATTR_ERROR, msg.error);
		} else {
			this.searchHashes = new Set(msg.hashes);
		}
		this.update(true);
	}


	/* Matching */

	/**
	 * Parse the text entered into the Find Widget into the text to find, and the values of the search operators it contains:
	 * `author:` (or `@:`), `message:` (or `=:`), `commit:` (or `#:`), `file:` (or `?:`), `change:` (or `~:`), `after:` (or `>:`) and
	 * `before:` (or `<:`). A value containing spaces can be enclosed in double quotes.
	 * @param text The text entered into the Find Widget.
	 * @returns The parsed query.
	 */
	public static parseQuery(text: string): FindQuery {
		const query: FindQuery = { text: '', author: [], message: [], commit: [], file: [], change: [], after: [], before: [] }, remaining: string[] = [];
		const pattern = /(author:|@:|message:|=:|commit:|#:|file:|\?:|change:|~:|after:|>:|before:|<:)(?:"([^"]*)"|(\S*))/g;
		let lastIndex = 0, match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			if (match.index > 0 && !/\s/.test(text.charAt(match.index - 1))) continue; // Only operators at the start of a word
			remaining.push(text.substring(lastIndex, match.index));
			lastIndex = pattern.lastIndex;
			const value = typeof match[2] === 'string' ? match[2] : match[3];
			if (value !== '') query[FIND_OPERATORS[match[1]]].push(value);
		}
		remaining.push(text.substring(lastIndex));
		return Object.assign(query, { text: remaining.join(' ').trim().replace(/\s+/g, ' ') });
	}

	/**
	 * Parse the value of the `after:` & `before:` search operators into the start of the day, month or year it refers to.
	 * @param value The value: YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday, or a number of days, weeks, months or years ago (e.g. 7d, 2w,
	 * 3m, 1y).
	 * @param now The current date.
	 * @returns The Unix timestamp (in seconds) of the start of the day, month or year (in local time), or NULL if the value isn't a date.
	 */
	public static parseDate(value: string, now: Date = new Date()) {
		const text = value.trim().toLowerCase();
		let match = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/), date: Date;
		if (match !== null) {
			const year = parseInt(match[1]), month = typeof match[2] === 'string' ? parseInt(match[2]) - 1 : 0, day = typeof match[3] === 'string' ? parseInt(match[3]) : 1;
			date = new Date(year, month, day);
			if (month < 0 || month > 11 || day < 1 || date.getMonth() !== month) return null; // e.g. 2026-13 or 2026-02-30
		} else if (text === 'today' || text === 'yesterday') {
			date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (text === 'yesterday' ? 1 : 0));
		} else if ((match = text.match(/^(\d+)([dwmy])$/)) !== null) {
			const count = parseInt(match[1]);
			date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			if (match[2] === 'd') date.setDate(date.getDate() - count);
			else if (match[2] === 'w') date.setDate(date.getDate() - count * 7);
			else if (match[2] === 'm') date.setMonth(date.getMonth() - count);
			else date.setFullYear(date.getFullYear() - count);
		} else {
			return null;
		}
		return Math.round(date.getTime() / 1000);
	}

	/**
	 * Get the hashes of the commits that match the Find Widget's criteria.
	 * @param commits The commits to search.
	 * @returns The hashes of the matching commits, or NULL if the criteria are invalid (or the file: & change: operators are still being searched for).
	 */
	public getMatchingHashes(commits: ReadonlyArray<GG.GitCommit>): Set<string> | null {
		const matcher = this.getMatcher(FindWidget.parseQuery(this.text));
		return matcher !== null ? new Set(commits.filter((commit) => matcher.matches(commit)).map((commit) => commit.hash)) : null;
	}

	/**
	 * Compile the parsed query into a function that tests whether a commit matches it, and a pattern that matches the text to highlight in a matching commit.
	 * @param query The parsed query.
	 * @returns The matcher, or NULL if the query is invalid, or the file: & change: operators are still being searched for.
	 */
	private getMatcher(query: FindQuery): { matches: (commit: GG.GitCommit) => boolean, findPattern: RegExp | null, highlight: RegExp } | null {
		const colVisibility = this.view.getColumnVisibility();
		const toRegexText = (text: string) => workspaceState.findIsRegex ? text : text.replace(/[\\\[\](){}|.*+?^$]/g, '\\$&'), flags = 'u' + (workspaceState.findIsCaseSensitive ? '' : 'i');
		const highlightText = [query.text].concat(query.author, query.message).filter((text) => text !== '').map((text) => '(?:' + toRegexText(text) + ')').join('|');
		let findPattern: RegExp | null, authorPatterns: RegExp[], messagePatterns: RegExp[], commitPatterns: RegExp[], highlight: RegExp, after: number[], before: number[];
		try {
			const parseDate = (value: string) => {
				const date = FindWidget.parseDate(value);
				if (date === null) throw new Error(t('"{0}" isn\'t a date. Use YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday, or a number of days, weeks, months or years ago (e.g. 7d, 2w, 3m, 1y).', value));
				return date;
			};
			after = query.after.map(parseDate);
			before = query.before.map(parseDate);
			findPattern = query.text !== '' ? new RegExp(toRegexText(query.text), flags) : null;
			authorPatterns = query.author.map((text) => new RegExp(toRegexText(text), flags));
			messagePatterns = query.message.map((text) => new RegExp(toRegexText(text), flags));
			commitPatterns = query.commit.map((text) => new RegExp('^(?:' + toRegexText(text) + ')', flags));
			highlight = new RegExp(highlightText !== '' ? highlightText : '(?!)', 'g' + flags);
			if (this.searchHashes !== null || (query.file.length === 0 && query.change.length === 0)) this.widgetElem.removeAttribute(ATTR_ERROR);
		} catch (e) {
			this.widgetElem.setAttribute(ATTR_ERROR, e instanceof Error ? e.message : String(e));
			return null;
		}
		const searchHashes = query.file.length > 0 || query.change.length > 0 ? this.searchHashes : undefined;
		if (searchHashes === null) return null; // The file: & change: operators are still being searched for

		return {
			matches: (commit) => {
				if (commit.hash === UNCOMMITTED) return false;
				if (typeof searchHashes !== 'undefined' && !searchHashes.has(commit.hash)) return false;
				if (!after.every((date) => commit.date >= date) || !before.every((date) => commit.date < date)) return false;
				if (!authorPatterns.every((pattern) => pattern.test(commit.author) || pattern.test(commit.email))) return false;
				if (!messagePatterns.every((pattern) => pattern.test(commit.message))) return false;
				if (!commitPatterns.every((pattern) => pattern.test(commit.hash))) return false;
				if (findPattern === null) return true;
				if ((colVisibility.author && findPattern.test(commit.author))
					|| (colVisibility.commit && (commit.hash.search(findPattern) === 0 || findPattern.test(abbrevCommit(commit.hash))))
					|| findPattern.test(commit.message)
					|| commit.tags.some(tag => findPattern!.test(tag.name))
					|| (commit.stash !== null && findPattern.test(commit.stash.selector))) {
					return true;
				}
				const branchLabels = getBranchLabels(commit.heads, commit.remotes);
				return branchLabels.heads.some(head => findPattern!.test(head.name) || head.remotes.some(remote => findPattern!.test(remote)))
					|| branchLabels.remotes.some(remote => findPattern!.test(remote.name))
					|| (colVisibility.date && findPattern.test(formatShortDate(commit.date).formatted));
			},
			findPattern: findPattern,
			highlight: highlight
		};
	}

	/**
	 * Request the extension to search for the commits matched by the file: & change: operators of a query (if it hasn't already been requested).
	 * @param query The parsed query.
	 */
	private requestSearchIfRequired(query: FindQuery) {
		if (query.file.length === 0 && query.change.length === 0) {
			this.searchKey = null;
			this.searchHashes = null;
			return;
		}
		const since = this.view.getOldestLoadedCommitDate();
		const key = JSON.stringify([query.file, query.change, workspaceState.findIsRegex, workspaceState.findIsCaseSensitive, since]);
		if (key === this.searchKey) return;
		this.searchKey = key;
		this.searchHashes = null;
		this.searchId++;
		sendMessage({
			command: 'searchCommits',
			repo: this.view.getCurrentRepo(),
			id: this.searchId,
			files: query.file,
			changes: query.change,
			isRegex: workspaceState.findIsRegex,
			isCaseSensitive: workspaceState.findIsCaseSensitive,
			since: since
		});
	}

	/**
	 * The text entered into the Find Widget (its chips & search box) may have changed, update the matches if it has.
	 */
	private textChanged() {
		const text = this.chips.concat(this.inputElem.value.trim()).filter((text) => text !== '').join(' ');
		if (text === this.text) return;
		this.text = text;
		this.update(true);
	}

	/**
	 * Update the matches (and the commits shown, when only the matches are shown) after the Find Widget's criteria have changed.
	 * @param scrollToCommit Should the resultant find match be scrolled to (so it's visible in the view).
	 * @param goToCommitHash If this commit hash matches the criteria, directly go to this commit instead of starting at the current match.
	 */
	private update(scrollToCommit: boolean, goToCommitHash: string | null = this.getCurrentHash()) {
		this.show(false);
		this.requestSearchIfRequired(FindWidget.parseQuery(this.text));
		this.clearMatches();
		this.matches = [];
		this.position = -1;
		// When only the matches are shown, show the commits that match (all commits are shown while the file: & change: operators are being searched for)
		this.view.setCommitFilter(this.isFiltering() ? this.getMatchingHashes(this.view.getLoadedCommits()) : null);
		this.findMatches(goToCommitHash, scrollToCommit);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/**
	 * Find all matches based on the user's criteria.
	 * @param goToCommitHash If this commit hash matches the criteria, directly go to this commit instead of starting at the first match.
	 * @param scrollToCommit Should the resultant find match be scrolled to (so it's visible in the view).
	 */
	private findMatches(goToCommitHash: string | null, scrollToCommit: boolean) {
		this.clearMatches();
		this.matches = [];
		this.position = -1;
		this.highlight = null;

		const query = FindWidget.parseQuery(this.text);
		const searching = (query.file.length > 0 || query.change.length > 0) && this.searchHashes === null;
		if (this.text !== '') {
			const matcher = this.getMatcher(query);
			if (matcher !== null) {
				// The commit data is searched for the matching commits (which aren't all rendered when the rows of the commits are virtualised)
				const commits = this.view.getCommits();
				for (let i = 0; i < commits.length; i++) {
					if (matcher.matches(commits[i])) this.matches.push({ hash: commits[i].hash });
				}
				this.highlight = { pattern: matcher.highlight, findPattern: matcher.findPattern, commitPatternUsed: query.commit.length > 0, colVisibility: this.view.getColumnVisibility() };
				if (!this.highlightRenderedMatches()) {
					this.widgetElem.setAttribute(ATTR_ERROR, t('Cannot use a regular expression which has zero length matches'));
					this.clearMatches();
					this.matches = [];
				}
			}
		} else {
			this.widgetElem.removeAttribute(ATTR_ERROR);
		}

		alterClass(this.prevElem, CLASS_DISABLED, this.matches.length === 0);
		alterClass(this.nextElem, CLASS_DISABLED, this.matches.length === 0);
		this.countElem.innerHTML = this.text === ''
			? t('Enter the text or conditions to search for')
			: searching
				? t('Searching') + ELLIPSIS
				: this.matches.length !== 1 ? t('{0} commits match', this.matches.length) : t('{0} commit matches', this.matches.length);
		alterClass(this.countElem, 'noMatches', this.text !== '' && !searching && this.matches.length === 0);

		let newPos = -1;
		if (this.matches.length > 0) {
			newPos = 0;
			if (goToCommitHash !== null) {
				let pos = this.matches.findIndex(match => match.hash === goToCommitHash);
				if (pos > -1) newPos = pos;
			}
		}
		this.updatePosition(newPos, scrollToCommit);
		this.view.renderScrollMarkers();
	}

	/**
	 * Highlight the find matches in the rows of the commits that are rendered (all of the rows, unless they are virtualised, in which case
	 * this is also called when the rows that are rendered change).
	 * @returns FALSE if the find pattern has zero length matches (which can't be highlighted), otherwise TRUE.
	 */
	public highlightRenderedMatches() {
		this.clearMatches();
		const highlight = this.highlight;
		if (highlight === null || this.matches.length === 0) return true;
		const matching = new Set(this.matches.map((match) => match.hash)), currentHash = this.getCurrentHash(), commitElems = getCommitElems();
		for (let j = 0; j < commitElems.length; j++) {
			const commit = this.view.getCommitOfElem(commitElems[j]);
			if (commit === null || !matching.has(commit.hash)) continue;
			commitElems[j].classList.add(CLASS_FIND_MATCH_ROW);
			if (commit.hash === currentHash) commitElems[j].classList.add(CLASS_FIND_CURRENT_COMMIT);

			// Highlight matches
			const textElems = getChildNodesWithTextContent(commitElems[j]);
			for (let k = 0; k < textElems.length; k++) {
				const textElem = textElems[k], text = textElem.textContent!;
				let matchStart = 0, matchEnd = 0, match: RegExpExecArray | null;
				highlight.pattern.lastIndex = 0;
				while (match = highlight.pattern.exec(text)) {
					if (match[0].length === 0) return false;
					if (matchEnd !== match.index) {
						// This match isn't immediately after the previous match, or isn't at the beginning of the text
						if (matchStart !== matchEnd) {
							// There was a previous match, insert it in a text node
							textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
						}
						// Insert a text node containing the text between the last match and the current match
						textElem.parentNode!.insertBefore(document.createTextNode(text.substring(matchEnd, match.index)), textElem);
						matchStart = match.index;
					}
					matchEnd = highlight.pattern.lastIndex;
				}
				if (matchEnd > 0) {
					// There were one or more matches
					if (matchStart !== matchEnd) {
						// There was a match, insert it in a text node
						textElem.parentNode!.insertBefore(FindWidget.createMatchElem(text.substring(matchStart, matchEnd)), textElem);
					}
					if (matchEnd !== text.length) {
						// There was some text after last match, update the textElem (the last node of it's parent) to contain the remaining text.
						textElem.textContent = text.substring(matchEnd);
					} else {
						// The last match was at the end of the text, the textElem is no longer required, so delete it
						textElem.parentNode!.removeChild(textElem);
					}
				}
			}
			const findPattern = highlight.findPattern;
			if (highlight.colVisibility.commit && ((findPattern !== null && commit.hash.search(findPattern) === 0 && !findPattern.test(abbrevCommit(commit.hash))) || highlight.commitPatternUsed) && textElems.length > 0) {
				// The commit matches on more than the abbreviated commit, so the commit should be highlighted
				const commitNode = textElems[textElems.length - 1]; // Commit is always the last column if it is visible
				commitNode.parentNode!.replaceChild(FindWidget.createMatchElem(commitNode.textContent!), commitNode);
			}
		}
		return true;
	}

	/**
	 * Clear all of the highlighted find matches in the rows of the commits that are rendered.
	 */
	private clearMatches() {
		document.querySelectorAll<HTMLElement>('#commitTable tr.' + CLASS_FIND_MATCH_ROW + ', #commitTable tr.' + CLASS_FIND_CURRENT_COMMIT).forEach((rowElem) => {
			rowElem.classList.remove(CLASS_FIND_MATCH_ROW, CLASS_FIND_CURRENT_COMMIT);
			const matchElems = getChildrenWithClassName(rowElem, CLASS_FIND_MATCH);
			for (let j = 0; j < matchElems.length; j++) {
				const matchElem = matchElems[j];
				let text = matchElem.childNodes[0].textContent!;

				// Combine current text with the text from previous sibling text nodes
				let node = matchElem.previousSibling, elem = matchElem.previousElementSibling;
				while (node !== null && node !== elem && node.textContent !== null) {
					text = node.textContent + text;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.previousSibling;
				}

				// Combine current text with the text from next sibling text nodes
				node = matchElem.nextSibling;
				elem = matchElem.nextElementSibling;
				while (node !== null && node !== elem && node.textContent !== null) {
					text = text + node.textContent;
					matchElem.parentNode!.removeChild(node);
					node = matchElem.nextSibling;
				}

				matchElem.parentNode!.replaceChild(document.createTextNode(text), matchElem);
			}
		});
	}

	/**
	 * Update the user's position in the set of find matches.
	 * @param position The new position index within the find matches.
	 * @param scrollToCommit After updating the user's position in the set of find matches, should the current match be scrolled to (so it's visible in the view).
	 */
	private updatePosition(position: number, scrollToCommit: boolean) {
		document.querySelectorAll('#commitTable tr.' + CLASS_FIND_CURRENT_COMMIT).forEach((rowElem) => rowElem.classList.remove(CLASS_FIND_CURRENT_COMMIT));
		this.position = position;
		if (this.position > -1) {
			const hash = this.matches[position].hash;
			if (scrollToCommit) this.view.scrollToCommit(hash, false);
			const commitElem = findCommitElemWithId(getCommitElems(), this.view.getCommitId(hash));
			if (commitElem !== null) commitElem.classList.add(CLASS_FIND_CURRENT_COMMIT);
		}
		this.positionElem.innerHTML = this.matches.length > 0 ? t('{0} of {1}', this.position + 1, this.matches.length) : (this.text !== '' ? t('No Results') : '');
		this.view.saveState();
	}

	/**
	 * Move the user's position to the previous match in the set of find matches.
	 */
	private prev() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position > 0 ? this.position - 1 : this.matches.length - 1, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/**
	 * Move the user's position to the next match in the set of find matches.
	 */
	private next() {
		if (this.matches.length === 0) return;
		this.updatePosition(this.position < this.matches.length - 1 ? this.position + 1 : 0, true);
		this.openCommitDetailsViewForCurrentMatchIfEnabled();
	}

	/**
	 * If the Find Widget is configured to open the Commit Details View for the current find match, load the Commit Details View accordingly.
	 */
	private openCommitDetailsViewForCurrentMatchIfEnabled() {
		if (workspaceState.findOpenCommitDetailsView) {
			const commitHash = this.getCurrentHash();
			if (commitHash !== null && !this.view.isCdvOpen(commitHash, null)) {
				const commitElem = this.view.getCommitElem(this.view.getCommitId(commitHash));
				if (commitElem !== null) {
					this.view.loadCommitDetails(commitElem);
				}
			}
		}
	}


	/* Rendering */

	public openAiSearchDialog() {
		this.show(false);
		dialog.showForm(
			t('Describe the commits you want to find in natural language. AI translates it into transparent Git Map search chips (<code>author:</code>, <code>file:</code>, <code>change:</code>, <code>after:</code>, <code>before:</code>):'),
			[{
				type: DialogInputType.Text,
				name: t('Natural Language Query'),
				default: this.inputElem.value.trim(),
				placeholder: t('e.g. commits by Andy modifying auth timeout last month')
			}],
			t('Translate & Search'),
			(values) => {
				const query = (<string>values[0]).trim();
				if (query === '') return;
				const authors = this.view.getKnownAuthors();
				const branches = this.view.getAllBranchNames().filter((b) => !b.startsWith('remotes/'));
				const aiBtn = document.getElementById('findAiBtn');
				if (aiBtn !== null) aiBtn.classList.add('loading');
				sendMessage({
					command: 'aiSearchCommits',
					repo: this.view.currentRepo,
					naturalQuery: query,
					authors: authors,
					branches: branches
				});
			},
			null
		);
	}

	public setSavedFilters(filters: ReadonlyArray<GG.SavedFilterPreset>) {
		this.savedFilters = filters;
	}

	private applyQueryString(query: string) {
		const trimmed = query.trim();
		if (trimmed === '') return;
		const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [trimmed];
		this.chips = tokens.filter((tok) => tok.trim() !== '');
		this.inputElem.value = '';
		this.show(false);
		this.renderChips();
		this.textChanged();
	}

	private openSavePresetDialog() {
		const currentQuery = this.chips.concat(this.inputElem.value.trim() !== '' ? [this.inputElem.value.trim()] : []).join(' ').trim();
		if (currentQuery === '') {
			dialog.showError(t('Save Search Preset'), t('Enter at least one search term or operator before saving a preset.'), null, null);
			return;
		}
		dialog.showForm(
			t('Save search filter <code>{0}</code> as a reusable preset for this repository:', escapeHtml(currentQuery)),
			[{ type: DialogInputType.Text, name: t('Preset Name'), default: '', placeholder: t('e.g. Auth changes this week') }],
			t('Save Preset'),
			(values) => {
				const name = (<string>values[0]).trim();
				if (name === '') return;
				sendMessage({ command: 'saveFilterPreset', repo: this.view.currentRepo, name: name, query: currentQuery });
			},
			null
		);
	}

	private openPresetsMenu(btnElem: HTMLElement, e: MouseEvent) {
		handledEvent(e);
		this.view.ensureRepoMetadataLoaded();
		const target: RepoTarget = { type: TargetType.Repo };
		const builtIns: ContextMenuAction[] = [
			{ title: t('Last 7 Days') + ' (after:7d)', icon: SVG_ICONS.search, visible: true, onClick: () => this.applyQueryString('after:7d') },
			{ title: t('Last 30 Days') + ' (after:30d)', icon: SVG_ICONS.search, visible: true, onClick: () => this.applyQueryString('after:30d') },
			{ title: t('Bug Fixes') + ' (message:fix)', icon: SVG_ICONS.search, visible: true, onClick: () => this.applyQueryString('message:fix') }
		];
		const userGroup: ContextMenuAction[] = this.savedFilters.map((preset) => ({
			title: preset.name + '  —  ' + preset.query,
			icon: MENU_ICONS.tag,
			visible: true,
			onClick: () => this.applyQueryString(preset.query)
		}));
		const manageGroup: ContextMenuAction[] = this.savedFilters.map((preset) => ({
			title: t('Delete Preset "{0}"', preset.name),
			icon: MENU_ICONS.trash,
			visible: true,
			onClick: () => sendMessage({ command: 'deleteFilterPreset', repo: this.view.currentRepo, id: preset.id })
		}));
		const groups: ContextMenuAction[][] = [builtIns];
		if (userGroup.length > 0) groups.push(userGroup);
		if (manageGroup.length > 0) groups.push(manageGroup);
		const bounds = btnElem.getBoundingClientRect();
		contextMenu.show(groups, false, target, new MouseEvent('contextmenu', { clientX: Math.round(bounds.left), clientY: Math.round(bounds.bottom + 4) }), this.view.viewElem);
	}

	public processAiSearchResponse(msg: GG.ResponseAiSearchCommits) {
		const aiBtn = document.getElementById('findAiBtn');
		if (aiBtn !== null) aiBtn.classList.remove('loading');
		if (msg.error !== null) {
			dialog.showError(t('AI Search Unavailable'), msg.error, null, null);
			return;
		}
		const translated = msg.query.trim();
		if (translated === '') {
			dialog.showError(t('AI Search'), t('Could not translate that request into search operators.'), null, null);
			return;
		}
		this.applyQueryString(translated);
	}

	/**
	 * Render the chips of the conditions that have been added to the search box.
	 */
	private renderChips() {
		this.chipsElem.innerHTML = this.chips.map((chip, index) => {
			const query = FindWidget.parseQuery(chip), isOperator = query.text === '';
			return '<span class="findChip' + (isOperator ? ' operator' : '') + '" data-index="' + index + '" title="' + escapeHtml(chip) + '">' + escapeHtml(chip) + '<span class="findChipRemove" title="' + t('Remove') + '">' + SVG_ICONS.close + '</span></span>';
		}).join('');
		alterClass(this.widgetElem, 'hasChips', this.chips.length > 0);
		// (The placeholder is text, not HTML, so it can't contain the HTML entity of an ellipsis)
		this.inputElem.placeholder = (this.chips.length > 0 ? t('Add a condition') : t('Search commits')) + '…';
	}

	/**
	 * Render whether the matches are highlighted, or only the matches are shown.
	 */
	private renderMode() {
		this.resultsElem.querySelectorAll<HTMLElement>('.findMode').forEach((elem) => {
			alterClass(elem, CLASS_ACTIVE, elem.dataset.mode === this.mode);
			elem.setAttribute('aria-pressed', elem.dataset.mode === this.mode ? 'true' : 'false');
		});
	}

	/**
	 * Create a find match element containing the specified text.
	 * @param text The text content of the find match.
	 * @returns The HTML element for the find match.
	 */
	private static createMatchElem(text: string) {
		const span = document.createElement('span');
		span.className = CLASS_FIND_MATCH;
		span.textContent = text;
		return span;
	}
}
