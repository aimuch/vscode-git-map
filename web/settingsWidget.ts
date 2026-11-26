interface SettingsWidgetState {
	readonly currentRepo: string | null;
	readonly scrollTop: number;
}

/**
 * Implements the Git Map View's Settings Widget.
 */
class SettingsWidget {
	private readonly view: GitGraphView;

	private currentRepo: string | null = null;
	private repo: Readonly<GG.GitRepoState> | null = null;
	private config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	private scrollTop: number = 0;
	private appearance: GG.AppearanceConfig = initialState.config.appearance;
	private ai: GG.AiSettingsConfig = initialState.config.ai;
	private prStatusEnabled: boolean = initialState.config.pullRequestStatusEnabled;
	private discoveredAiModels: ReadonlyArray<string> = [];
	private aiModelsStatus: string | null = null;
	private aiModelsLoading: boolean = false;
	private codingAgents: ReadonlyArray<GG.CodingAgentStatus> = [];
	private codingAgentsLoaded: boolean = false;
	private extState: {
		autolinks: GG.AutolinkRule[];
		customRemotes: GG.CustomRemoteConfig[];
		defaultAgent: string;
		startWorkBranchFormat: string;
		terminalLinksEnabled: boolean;
		terminalLinksShowDetails: boolean;
		followTerminalEnabled: boolean;
		launchpadEnabled: boolean;
		launchpadUseColors: boolean;
		overviewBarEnabled: boolean;
		maxVisibleRefsPerCommit: number;
		shortcutOverrides: { [action: string]: string };
		scrollMarkersEnabled: boolean;
		scrollMarkersTypes: GG.GraphMarkerType[];
		showGhostRefs: boolean;
		multiselect: GG.GraphMultiSelectMode;
		scmGroupedEnabled: boolean;
		scmHiddenSections: string[];
		scmDefaultSection: string;
		scmFormats: {
			commitLabel: string;
			commitDesc: string;
			stashLabel: string;
			stashDesc: string;
			fileLabel: string;
			fileDesc: string;
		};
		editor: {
			currentLineEnabled: boolean;
			currentLinePullRequests: boolean;
			currentLineScrollable: boolean;
			currentLineFormat: string;
			currentLineUncommittedFormat: string;
			statusBarEnabled: boolean;
			statusBarFormat: string;
			statusBarReduceFlicker: boolean;
			codeLensEnabled: boolean;
			codeLensRecentChange: boolean;
			codeLensAuthors: boolean;
			hoversEnabled: boolean;
			hoversAutolinks: boolean;
			fileBlameCompact: boolean;
			fileBlameHeatmap: boolean;
			fileBlameHighlightSameCommit: boolean;
			fileHeatmapFadeLines: boolean;
			activeMode: string;
		};
		menus: {
			editor: boolean;
			editorGroup: boolean;
			explorer: boolean;
			scm: boolean;
			editorTab: boolean;
		};
	} = SettingsWidget.buildInitialExtendedState();

	private static buildInitialExtendedState() {
		const cfg = initialState.config;
		const ed = cfg.editorAnnotations;
		const scm = cfg.scmViews;
		return {
			autolinks: Array.isArray(cfg.autolinks) ? cfg.autolinks.map((r) => Object.assign({}, r)) : [],
			customRemotes: Array.isArray(cfg.customRemotes) ? cfg.customRemotes.map((r) => Object.assign({}, r)) : [],
			defaultAgent: cfg.defaultAgent || '',
			startWorkBranchFormat: cfg.startWorkBranchFormat || '${id}-${title}',
			terminalLinksEnabled: cfg.terminalLinks ? cfg.terminalLinks.enabled : true,
			terminalLinksShowDetails: cfg.terminalLinks ? cfg.terminalLinks.showDetailsView : true,
			followTerminalEnabled: cfg.graph.followTerminal ? cfg.graph.followTerminal.enabled : false,
			launchpadEnabled: cfg.launchpad ? cfg.launchpad.indicatorEnabled : true,
			launchpadUseColors: cfg.launchpad ? cfg.launchpad.useColors : true,
			overviewBarEnabled: cfg.graph.overviewBarEnabled !== false,
			maxVisibleRefsPerCommit: cfg.graph.maxVisibleRefsPerCommit || 0,
			shortcutOverrides: Object.assign({}, cfg.graph.shortcutOverrides || {}),
			scrollMarkersEnabled: cfg.graph.scrollMarkers ? cfg.graph.scrollMarkers.enabled : true,
			scrollMarkersTypes: cfg.graph.scrollMarkers ? cfg.graph.scrollMarkers.types.slice() : <GG.GraphMarkerType[]>['localBranches', 'remoteBranches', 'pullRequests', 'stashes', 'tags', 'worktrees'],
			showGhostRefs: cfg.graph.showGhostRefsOnRowHover !== false,
			multiselect: cfg.graph.multiselect || 'on',
			scmGroupedEnabled: scm ? scm.enabled : true,
			scmHiddenSections: scm ? scm.hiddenSections.slice() : [],
			scmDefaultSection: scm ? scm.defaultSection : 'commits',
			scmFormats: {
				commitLabel: scm ? scm.commitLabelFormat : '${message}',
				commitDesc: scm ? scm.commitDescriptionFormat : '${author, }${agoOrDate}',
				stashLabel: scm ? scm.stashLabelFormat : '${message}',
				stashDesc: scm ? scm.stashDescriptionFormat : '${agoOrDate}',
				fileLabel: scm ? scm.fileLabelFormat : '${file}',
				fileDesc: scm ? scm.fileDescriptionFormat : '${directory}'
			},
			editor: {
				currentLineEnabled: ed ? ed.currentLineEnabled : true,
				currentLinePullRequests: ed ? ed.currentLinePullRequests : true,
				currentLineScrollable: ed ? ed.currentLineScrollable : true,
				currentLineFormat: ed ? ed.currentLineFormat : '${author, }${agoOrDate}${ via |pullRequest}${ • |message|50?}',
				currentLineUncommittedFormat: ed ? ed.currentLineUncommittedFormat : '\u270E ${ago}',
				statusBarEnabled: ed ? ed.statusBarEnabled : true,
				statusBarFormat: ed ? ed.statusBarFormat : '${author}, ${ago}',
				statusBarReduceFlicker: ed ? ed.statusBarReduceFlicker : false,
				codeLensEnabled: ed ? ed.codeLensEnabled : false,
				codeLensRecentChange: ed ? ed.codeLensRecentChange : true,
				codeLensAuthors: ed ? ed.codeLensAuthors : true,
				hoversEnabled: ed ? ed.hoversEnabled : true,
				hoversAutolinks: ed ? ed.hoversAutolinks : true,
				fileBlameCompact: ed ? ed.fileBlameCompact : false,
				fileBlameHeatmap: ed ? ed.fileBlameHeatmap : true,
				fileBlameHighlightSameCommit: ed ? ed.fileBlameHighlightSameCommit : true,
				fileHeatmapFadeLines: ed ? ed.fileHeatmapFadeLines : false,
				activeMode: ed ? ed.activeMode : 'default'
			},
			menus: {
				editor: true,
				editorGroup: true,
				explorer: true,
				scm: true,
				editorTab: true
			}
		};
	}

	private readonly widgetElem: HTMLElement;
	private readonly repoNameElem: HTMLElement;
	private readonly navRailElem: HTMLElement;
	private readonly searchInputElem: HTMLInputElement;
	private readonly contentsElem: HTMLElement;
	private readonly footerElem: HTMLElement;
	private readonly loadingElem: HTMLElement;
	private searchQuery: string = '';
	private activeSectionIndex: number = 0;

	/**
	 * Construct a new SettingsWidget instance.
	 * @param view The Git Map View that the SettingsWidget is for.
	 * @returns The SettingsWidget instance.
	 */
	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'settingsWidget';
		this.widgetElem.innerHTML =
			'<div id="settingsHeader"><h2>' + MENU_ICONS.settings + t('Settings') + '</h2><span id="settingsRepoName"></span><div id="settingsClose" title="' + t('Close') + '"></div></div>' +
			'<div id="settingsSearchBar"><span class="settingsSearchIcon">' + SVG_ICONS.search + '</span><input id="settingsSearchInput" type="text" placeholder="' + escapeHtml(t('Filter settings…')) + '" autocomplete="off"/><button type="button" id="settingsSearchClear" class="hidden" title="' + escapeHtml(t('Clear')) + '">' + SVG_ICONS.close + '</button></div>' +
			'<div id="settingsBody"><nav id="settingsNavRail" aria-label="' + escapeHtml(t('Setting Categories')) + '"></nav><div id="settingsContent"></div></div>' +
			'<div id="settingsFooter"></div><div id="settingsLoading"></div>';
		document.body.appendChild(this.widgetElem);

		observeElemScroll('settingsContent', this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
			this.syncActiveNavCategory();
		}, () => {
			if (this.currentRepo !== null) {
				this.view.saveState();
			}
		});

		this.repoNameElem = document.getElementById('settingsRepoName')!;
		this.navRailElem = document.getElementById('settingsNavRail')!;
		this.searchInputElem = <HTMLInputElement>document.getElementById('settingsSearchInput')!;
		this.contentsElem = document.getElementById('settingsContent')!;
		this.footerElem = document.getElementById('settingsFooter')!;
		this.loadingElem = document.getElementById('settingsLoading')!;

		const clearBtn = document.getElementById('settingsSearchClear')!;
		this.searchInputElem.addEventListener('input', () => {
			this.searchQuery = this.searchInputElem.value;
			alterClass(clearBtn, 'hidden', this.searchQuery.trim() === '');
			this.applySearchFilter();
		});
		clearBtn.addEventListener('click', () => {
			this.searchQuery = '';
			this.searchInputElem.value = '';
			clearBtn.classList.add('hidden');
			this.applySearchFilter();
			this.searchInputElem.focus();
		});
		this.navRailElem.addEventListener('click', (e) => {
			const item = e.target instanceof Element ? <HTMLElement | null>e.target.closest('[data-settings-nav]') : null;
			if (item === null) return;
			const idx = parseInt(item.dataset.settingsNav!, 10);
			const sections = this.contentsElem.querySelectorAll<HTMLElement>('.settingsSection');
			if (idx >= 0 && idx < sections.length) {
				this.activeSectionIndex = idx;
				if (this.searchQuery.trim() !== '') {
					this.searchQuery = '';
					this.searchInputElem.value = '';
					clearBtn.classList.add('hidden');
					this.applySearchFilter();
				}
				sections[idx].scrollIntoView({ behavior: 'smooth', block: 'start' });
				this.updateNavRailHighlight();
			}
		});

		const settingsClose = document.getElementById('settingsClose')!;
		settingsClose.innerHTML = SVG_ICONS.close;
		settingsClose.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Settings Widget.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param isInitialLoad Is this the initial load of the Setting Widget, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Settings Widget should initially be set to.
	 */
	public show(currentRepo: string, isInitialLoad: boolean = true, scrollTop: number = 0) {
		if (this.currentRepo !== null) return;
		this.currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.view.saveState();
		this.refresh();
		if (isInitialLoad) {
			this.view.requestLoadConfig();
			sendMessage({ command: 'loadAiConfig' });
			sendMessage({ command: 'loadCodingAgents', repo: currentRepo });
		} else if (!this.codingAgentsLoaded) {
			sendMessage({ command: 'loadCodingAgents', repo: currentRepo });
		}
	}

	public processCodingAgentsResponse(agents: ReadonlyArray<GG.CodingAgentStatus>) {
		this.codingAgents = agents;
		this.codingAgentsLoaded = true;
		const foundDefault = agents.find((a) => a.isDefault);
		if (foundDefault) this.extState.defaultAgent = foundDefault.id;
		if (this.isVisible()) this.render();
	}

	/**
	 * Update the AI settings displayed in the Settings Widget, preserving focus if the user is typing in an AI input.
	 */
	public setAiConfig(ai: GG.AiSettingsConfig) {
		if (ai.provider !== this.ai.provider) {
			this.discoveredAiModels = [];
			this.aiModelsStatus = null;
			this.aiModelsLoading = false;
		}
		this.ai = ai;
		if (!this.isVisible()) return;
		const active = document.activeElement;
		if (active instanceof HTMLInputElement && (active.id === 'settingsAiModel' || active.id === 'settingsAiBaseUrl')) {
			const activeId = active.id, draft = active.value, start = active.selectionStart, end = active.selectionEnd;
			this.render();
			const restored = <HTMLInputElement | null>document.getElementById(activeId);
			if (restored !== null) {
				restored.value = draft;
				restored.focus();
				if (start !== null && end !== null) restored.setSelectionRange(start, end);
			}
			return;
		}
		this.render();
	}

	public processFetchAiModelsResponse(msg: GG.ResponseFetchAiModels) {
		this.aiModelsLoading = false;
		this.discoveredAiModels = msg.models;
		this.aiModelsStatus = msg.error !== null
			? msg.error
			: (msg.models.length === 0 ? t('No models were listed by the endpoint — enter a model ID manually.') : null);
		if (this.isVisible()) this.render();
	}

	/**
	 * Sync the Diff View segmented control when `diff.hideUnchangedRegions` changes outside the Settings Widget.
	 */
	public setHideUnchangedRegions(enabled: boolean) {
		if (!this.isVisible()) return;
		const group = this.contentsElem.querySelector<HTMLElement>('.settingsSegmented[data-setting="diff.hideUnchangedRegions"]');
		if (group === null) return;
		const expected = enabled ? 'true' : 'false';
		group.querySelectorAll<HTMLElement>('.settingsSegment').forEach((segment) => {
			const selected = segment.dataset.value === expected;
			alterClass(segment, CLASS_SELECTED, selected);
			segment.setAttribute('aria-checked', selected ? 'true' : 'false');
		});
	}

	public setPrStatusEnabled(enabled: boolean) {
		this.prStatusEnabled = enabled;
		if (!this.isVisible()) return;
		const cb = <HTMLInputElement | null>document.getElementById('settingsPrStatusBadgesCheckbox');
		if (cb !== null) cb.checked = enabled;
	}

	/**
	 * Refresh the Settings Widget after an action affecting it's content has completed.
	 */
	public refresh() {
		if (this.currentRepo === null) return;
		this.repo = this.view.getRepoState(this.currentRepo);
		this.config = this.view.getRepoConfig();
		this.loading = this.view.isConfigLoading();
		this.render();
	}

	/**
	 * Close the Settings Widget, sliding it up out of view.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.repo = null;
		this.config = null;
		this.loading = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		this.contentsElem.innerHTML = '';
		this.footerElem.innerHTML = '';
		this.loadingElem.innerHTML = '';
		this.view.saveState();
	}


	/* State */

	/**
	 * Get the current state of the Settings Widget.
	 */
	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop
		};
	}

	/**
	 * Restore the Settings Widget to an existing state.
	 * @param state The previous Settings Widget state.
	 */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop);
	}

	/**
	 * Is the Settings Widget currently visible.
	 * @returns TRUE => The Settings Widget is visible, FALSE => The Settings Widget is not visible
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* Render Methods */

	/**
	 * Render the Settings Widget.
	 */
	private render() {
		if (this.currentRepo !== null && this.repo !== null) {
			const escapedRepoName = escapeHtml(this.repo.name || getRepoName(this.currentRepo));

			const initialBranchesLocallyConfigured = this.repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || this.repo.onRepoLoadShowSpecificBranches !== null;
			const initialBranches: string[] = [];
			if (getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch)) {
				initialBranches.push(t('Checked Out'));
			}
			const branchOptions = this.view.getBranchOptions();
			getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches).forEach((branch) => {
				const option = branchOptions.find((option) => option.value === branch);
				if (option) {
					initialBranches.push(option.name);
				}
			});
			const initialBranchesStr = initialBranches.length > 0
				? escapeHtml(formatCommaSeparatedList(initialBranches))
				: t('Show All');

			const appearance = this.appearance, card = (title: string, buttons: string, body: string) => '<div class="settingsCard"><div class="settingsCardHeader"><h4>' + title + '</h4><span class="settingsCardButtons">' + buttons + '</span></div>' + body + '</div>';
			const button = (id: string, className: string, label: string) => '<button type="button" id="' + id + '" class="settingsBtn ' + className + '" tabindex="-1">' + label + '</button>';
			const segmented = (setting: string, options: ReadonlyArray<[string, string]>, selected: string) => '<div class="settingsSegmented" role="radiogroup" data-setting="' + setting + '">' + options.map((option) => '<button type="button" role="radio" aria-checked="' + (option[0] === selected) + '" class="settingsSegment' + (option[0] === selected ? ' selected' : '') + '" data-value="' + escapeHtml(option[0]) + '" tabindex="-1">' + option[1] + '</button>').join('') + '</div>';
			const checkbox = (id: string, label: string, info: string | null) => '<label id="' + id + '"><input type="checkbox" id="' + id + 'Checkbox" tabindex="-1"><span class="customCheckbox"></span>' + label + '</label>' + (info !== null ? '<span class="settingsWidgetInfo" title="' + info + '">' + SVG_ICONS.info + '</span>' : '');
			const displayLanguage = /^zh(-(cn|sg|hans.*))?$/i.test(appearance.displayLanguage) ? '简体中文' : /^en\b/i.test(appearance.displayLanguage) ? 'English' : appearance.displayLanguage;
			const statusBarDisplay = appearance.statusBarItemDisplay === GG.StatusBarItemDisplay.Icon ? 'Icon' : appearance.statusBarItemDisplay === GG.StatusBarItemDisplay.Text ? 'Text' : 'Icon & Text';
			const ext = this.extState;
			const graphStyle = initialState.config.graph.style === GG.GraphStyle.Angular ? 'angular' : 'rounded';
			const graphDensity = initialState.config.graph.density === GG.GraphDensity.Compact ? 'Compact' : 'Comfortable';
			const graphNodeStyle = initialState.config.graph.nodeStyle === GG.GraphNodeStyle.Avatar ? 'Avatar' : 'Dot';
			const extBoolCount = (flags: boolean[]) => flags.filter(Boolean).length;
			const extCheckbox = (id: string, key: string, checked: boolean, label: string, info?: string) =>
				'<label id="' + id + '"><input type="checkbox" class="settingsExtCheckbox" id="' + id + 'Checkbox" data-ext-key="' + escapeHtml(key) + '"' + (checked ? ' checked' : '') + ' tabindex="-1"><span class="customCheckbox"></span>' + label + '</label>' +
				(info ? '<span class="settingsWidgetInfo" title="' + escapeHtml(info) + '">' + SVG_ICONS.info + '</span>' : '');
			const extSegmented = (key: string, options: ReadonlyArray<[string, string]>, selected: string) =>
				'<div class="settingsExtSegmented" role="radiogroup" data-ext-key="' + escapeHtml(key) + '">' +
				options.map((o) => '<button type="button" role="radio" aria-checked="' + (o[0] === selected) + '" class="settingsSegment' + (o[0] === selected ? ' selected' : '') + '" data-value="' + escapeHtml(o[0]) + '" tabindex="-1">' + o[1] + '</button>').join('') +
				'</div>';

			const presetColours = (appearance.colourPresets.find((p) => p.name === appearance.colourPreset) || { colours: initialState.config.graph.colours }).colours;
			const viewsEnabled = extBoolCount([ext.overviewBarEnabled, ext.scrollMarkersEnabled, ext.showGhostRefs, ext.multiselect !== 'off', ext.scmGroupedEnabled]);
			const markerTypeOptions: ReadonlyArray<[GG.GraphMarkerType, string]> = [
				['localBranches', t('Local Branches')],
				['remoteBranches', t('Remote Branches')],
				['pullRequests', t('Pull Requests')],
				['stashes', t('Stashes')],
				['tags', t('Tags')],
				['worktrees', t('Worktrees')]
			];
			let html = '<div class="settingsSection" data-nav-group="views" data-nav-label="' + escapeHtml(t('Commit Graph & Views')) + '" data-nav-enabled="' + viewsEnabled + '" data-nav-total="5"><h3>' + MENU_ICONS.palette + t('Appearance · All Repositories') + '</h3>' +
				'<div class="settingsLivePreview" id="settingsGraphLivePreview">' + this.renderGraphPreviewHtml(presetColours, graphDensity, graphNodeStyle, ext.showGhostRefs) + '</div>' +
				'<div class="settingsLabel">' + t('Branch Line Colours') + '</div>' +
				'<div class="settingsPresets">' + appearance.colourPresets.map((preset) => '<button type="button" class="settingsPreset' + (preset.name === appearance.colourPreset ? ' selected' : '') + '" data-preset="' + escapeHtml(preset.name) + '" aria-pressed="' + (preset.name === appearance.colourPreset) + '" tabindex="-1"><span class="settingsPresetColours">' + preset.colours.map((colour) => '<span style="background-color:' + escapeHtml(colour) + '"></span>').join('') + '</span><span class="settingsPresetName">' + escapeHtml(t(preset.name)) + '</span></button>').join('') + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Line Style') + '</span>' + segmented('graph.style', [['rounded', t('Rounded')], ['angular', t('Angular')]], graphStyle) + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Row Density') + '</span>' + segmented('graph.density', [['Comfortable', t('Comfortable')], ['Compact', t('Compact')]], graphDensity) + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Commit Nodes') + '</span>' + segmented('graph.nodeStyle', [['Dot', t('Dot')], ['Avatar', t('Author Avatar')]], graphNodeStyle) + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Column Headers') + '</span>' + segmented('graph.freezeColumnHeaders', [['true', t('Frozen')], ['false', t('Scroll with the Commits')]], initialState.config.graph.freezeColumnHeaders ? 'true' : 'false') + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Footer') + '</span>' + segmented('graph.freezeFooter', [['true', t('Frozen')], ['false', t('Scroll with the Commits')]], initialState.config.graph.freezeFooter ? 'true' : 'false') + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Diff View') + '</span>' + segmented('diff.hideUnchangedRegions', [['false', t('Full File')], ['true', t('Changes Only')]], this.view.isHideUnchangedRegions() ? 'true' : 'false') + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Multi-Commit Selection') + '</span>' + extSegmented('graph.multiselect', [['off', t('Off')], ['on', t('Free')], ['topological', t('Topological')]], ext.multiselect) + '</div>' +
				'<div class="settingsCheckboxes two">' +
				'<span>' + extCheckbox('settingsOverviewBar', 'graph.overviewBar.enabled', ext.overviewBarEnabled, t('Graph Overview Bar')) + '</span>' +
				'<span>' + extCheckbox('settingsScrollMarkers', 'graph.scrollMarkers.enabled', ext.scrollMarkersEnabled, t('Scrollbar Markers')) + '</span>' +
				'<span>' + extCheckbox('settingsGhostRefs', 'graph.showGhostRefsOnRowHover', ext.showGhostRefs, t('Ghost Refs on Row Hover')) + '</span>' +
				'<span>' + extCheckbox('settingsScmGroupedView', 'views.scm.grouped.enabled', ext.scmGroupedEnabled, t('Git Map SCM View')) + '</span>' +
				'</div>' +
				'<div class="settingsSubGroup"><div class="settingsSubLabel">' + t('Scrollbar Marker Categories') + '</div><div class="settingsCheckboxes three">' +
				markerTypeOptions.map((m) => '<span><label><input type="checkbox" class="settingsMarkerTypeCheckbox" data-marker-type="' + m[0] + '"' + (ext.scrollMarkersTypes.includes(m[0]) ? ' checked' : '') + ' tabindex="-1"><span class="customCheckbox"></span>' + escapeHtml(m[1]) + '</label></span>').join('') +
				'</div></div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Max Visible Refs (+N Folding)') + '</span><select id="settingsMaxVisibleRefs" class="settingsSelect" style="max-width:180px">' +
				[[0, t('Unlimited')], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']].map((o) => '<option value="' + o[0] + '"' + (ext.maxVisibleRefsPerCommit === o[0] ? ' selected' : '') + '>' + escapeHtml(String(o[1])) + '</option>').join('') +
				'</select></div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Graph Shortcuts (Ctrl/Cmd + Key)') + '</span><div class="settingsShortcutOverrides">' +
				(<const>[['find', t('Find'), initialState.config.keybindings.find || 'f'], ['refresh', t('Refresh'), initialState.config.keybindings.refresh || 'r'], ['scrollToHead', 'HEAD', initialState.config.keybindings.scrollToHead || 'h'], ['scrollToStash', t('Stash'), initialState.config.keybindings.scrollToStash || 's']]).map((sc) =>
					'<label class="settingsShortcutChip"><span>' + escapeHtml(sc[1]) + '</span><input type="text" maxlength="1" class="settingsInput mono settingsShortcutOverrideInput" data-shortcut-act="' + sc[0] + '" value="' + escapeHtml(ext.shortcutOverrides[sc[0]] || '') + '" placeholder="' + escapeHtml(sc[2]) + '"></label>'
				).join('') +
				'<button type="button" id="settingsOpenShortcutsHelp" class="settingsBtn" tabindex="-1">? ' + t('Cheatsheet') + '</button>' +
				'</div></div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Action Bar') + '</span>' + button('settingsCustomizeCdvActions', '', MENU_ICONS.settings + t('Customize Action Buttons') + ELLIPSIS) + '</div>' +
				'</div>';

			const scmSectionDefs: ReadonlyArray<[string, string]> = [
				['commits', t('Commits')],
				['branches', t('Branches')],
				['remotes', t('Remotes')],
				['stashes', t('Stashes')],
				['tags', t('Tags')],
				['worktrees', t('Worktrees')],
				['contributors', t('Contributors')],
				['repositories', t('Repositories')],
				['searchAndCompare', t('Search & Compare')],
				['launchpad', t('Launchpad PRs')],
				['fileHistory', t('File History')]
			];
			const scmVisibleCount = scmSectionDefs.filter((s) => !ext.scmHiddenSections.includes(s[0])).length;
			html += '<div class="settingsSection" id="settingsScmSection" data-nav-group="views" data-nav-label="' + escapeHtml(t('Git Map SCM & Views')) + '" data-nav-enabled="' + scmVisibleCount + '" data-nav-total="' + scmSectionDefs.length + '"><h3>' + MENU_ICONS.branch + t('Git Map SCM & View Formats') + '</h3>' +
				'<table class="settingsMatrixTable"><thead><tr><th>' + t('Section') + '</th><th>' + t('Visible') + '</th><th>' + t('Default Expanded') + '</th></tr></thead><tbody>' +
				scmSectionDefs.map((sec) => {
					const vis = !ext.scmHiddenSections.includes(sec[0]);
					const isDef = ext.scmDefaultSection === sec[0];
					return '<tr><td>' + escapeHtml(sec[1]) + '</td>' +
						'<td><label><input type="checkbox" class="settingsScmVisCheckbox" data-scm-sec="' + sec[0] + '"' + (vis ? ' checked' : '') + ' tabindex="-1"><span class="customCheckbox"></span></label></td>' +
						'<td><label><input type="radio" name="settingsScmDefaultSection" class="settingsScmDefaultRadio" value="' + sec[0] + '"' + (isDef ? ' checked' : '') + ' tabindex="-1"><span class="customRadio"></span></label></td></tr>';
				}).join('') +
				'</tbody></table>' +
				card(MENU_ICONS.commit + t('Commit, Stash & File View Formats'), '', '<div class="settingsFormatGrid">' +
					this.renderScmFormatFieldHtml('commitLabel', 'views.commits.labelFormat', t('Commit Label Format'), ext.scmFormats.commitLabel) +
					this.renderScmFormatFieldHtml('commitDesc', 'views.commits.descriptionFormat', t('Commit Description Format'), ext.scmFormats.commitDesc) +
					this.renderScmFormatFieldHtml('stashLabel', 'views.stashes.labelFormat', t('Stash Label Format'), ext.scmFormats.stashLabel) +
					this.renderScmFormatFieldHtml('stashDesc', 'views.stashes.descriptionFormat', t('Stash Description Format'), ext.scmFormats.stashDesc) +
					this.renderScmFormatFieldHtml('fileLabel', 'views.files.labelFormat', t('File Label Format'), ext.scmFormats.fileLabel) +
					this.renderScmFormatFieldHtml('fileDesc', 'views.files.descriptionFormat', t('File Description Format'), ext.scmFormats.fileDesc) +
				'</div>') +
				'</div>';

			html += '<div class="settingsSection" data-nav-group="general" data-nav-label="' + escapeHtml(t('Language')) + '"><h3>' + MENU_ICONS.globe + t('Language · All Repositories') + '</h3><div class="settingsChoices" data-setting="language">' +
				[['Auto', t('Follow Visual Studio Code (Current: {0})', escapeHtml(displayLanguage))], ['English', 'English'], ['Simplified Chinese', '简体中文']].map((option) => '<label class="settingsChoice' + (appearance.language === option[0] ? ' selected' : '') + '"><input type="radio" name="settingsLanguage" value="' + option[0] + '"' + (appearance.language === option[0] ? ' checked' : '') + ' tabindex="-1"><span class="customRadio"></span>' + option[1] + '</label>').join('') +
				'</div></div>';

			html += '<div class="settingsSection" data-nav-group="general" data-nav-label="' + escapeHtml(t('Status Bar')) + '" data-nav-enabled="1" data-nav-total="1"><h3>' + MENU_ICONS.layout + t('Status Bar · All Repositories') + '</h3><div class="settingsRow">' +
				segmented('statusBarItemDisplay', [['Icon & Text', t('Icon & Text')], ['Icon', t('Icon Only')], ['Text', t('Text Only')]], statusBarDisplay) +
				'<span class="settingsStatusBarPreview" title="' + t('Preview') + '">' + (statusBarDisplay !== 'Text' ? SVG_ICONS.logo : '') + (statusBarDisplay !== 'Icon' ? '<span>Git Map</span>' : '') + '</span>' +
				'</div></div>';

			const menusEnabled = extBoolCount([ext.menus.editor, ext.menus.editorGroup, ext.menus.explorer, ext.menus.scm, ext.menus.editorTab]);
			html += '<div class="settingsSection" id="settingsMenusSection" data-nav-group="general" data-nav-label="' + escapeHtml(t('Menus & Toolbars')) + '" data-nav-enabled="' + menusEnabled + '" data-nav-total="5"><h3>' + MENU_ICONS.settings + t('Menus & Toolbars') + '</h3>' +
				'<div class="settingsCheckboxes two">' +
				'<span>' + extCheckbox('settingsMenuEditor', 'menus.editor.enabled', ext.menus.editor, t('Editor Context Menu')) + '</span>' +
				'<span>' + extCheckbox('settingsMenuEditorGroup', 'menus.editorGroup.enabled', ext.menus.editorGroup, t('Editor Title Toolbar')) + '</span>' +
				'<span>' + extCheckbox('settingsMenuExplorer', 'menus.explorer.enabled', ext.menus.explorer, t('Explorer Context Menu')) + '</span>' +
				'<span>' + extCheckbox('settingsMenuScm', 'menus.scm.enabled', ext.menus.scm, t('SCM Title & Repository Menu')) + '</span>' +
				'<span>' + extCheckbox('settingsMenuEditorTab', 'menus.editorTab.enabled', ext.menus.editorTab, t('Editor Tab Context Menu')) + '</span>' +
				'</div></div>';

			const ai = this.ai;
			const activePreset = ai.presets.find((p) => p.id === ai.provider) || ai.presets[0];
			const isDirectAi = ai.provider !== 'VS Code';
			const aiButtons = isDirectAi
				? button('settingsSetAiApiKey', 'addBtn', MENU_ICONS.key + t('Set API Key') + ELLIPSIS) + (ai.hasApiKey ? button('settingsClearAiApiKey', 'removeBtn', MENU_ICONS.trash + t('Clear API Key')) : '')
				: '';
			const providerLabel = (preset: GG.AiProviderPresetInfo) => {
				switch (preset.id) {
					case 'VS Code': return t('VS Code (Built-in / Copilot)');
					case 'Ollama': return t('Ollama (Local)');
					case 'Magpie': return t('Magpie (Local Gateway)');
					case 'CC Switch': return t('CC Switch (Local Routing)');
					case 'OpenAI Compatible': return t('OpenAI Compatible');
					default: return preset.name;
				}
			};
			const modelPlaceholder = activePreset && activePreset.defaultModel !== ''
				? t('Default: {0}', activePreset.defaultModel)
				: ai.provider === 'Kimi' ? 'moonshot-v1-8k'
					: ai.provider === 'Doubao' ? 'doubao-seed-1-6-250615 / ep-...'
						: ai.provider === 'OpenAI' ? 'gpt-4o-mini'
							: ai.provider === 'Ollama' ? t('Auto-detect from Ollama, or e.g. qwen2.5-coder:7b')
								: ai.provider === 'Magpie' ? t('Auto-detect from Magpie, or e.g. claude-sonnet-4-5')
									: ai.provider === 'CC Switch' ? t('Auto-detect / routed by CC Switch, or e.g. gpt-5-codex')
										: t('Model or endpoint ID');
			const baseUrlPlaceholder = activePreset && activePreset.defaultBaseUrl !== ''
				? activePreset.defaultBaseUrl
				: 'https://api.example.com/v1';
			const apiKeyStatus = ai.hasApiKey
				? '<span class="settingsAiKeyStatus ok">' + escapeHtml(t('Saved in Visual Studio Code Secret Storage')) + '</span>'
				: (activePreset && activePreset.requiresApiKey
					? '<span class="settingsAiKeyStatus missing">' + escapeHtml(t('Not set — click "Set API Key…" above')) + '</span>'
					: '<span class="settingsAiKeyStatus optional">' + escapeHtml(t('Not set (optional)')) + '</span>');
			const discoveredChips = isDirectAi && this.discoveredAiModels.length > 0
				? '<div class="settingsAiModelChips">' + this.discoveredAiModels.slice(0, 16).map((m) => '<button type="button" class="settingsAiModelChip' + (m === ai.model ? ' active' : '') + '" data-ai-model="' + escapeHtml(m) + '" tabindex="-1">' + escapeHtml(m) + '</button>').join('') + '</div>'
				: (isDirectAi && this.aiModelsStatus !== null ? '<div class="settingsAiModelHint">' + escapeHtml(this.aiModelsStatus) + '</div>' : '');
			const aiCardBody = '<div class="settingsGrid two settingsAiGrid">' +
				'<label class="settingsKey" for="settingsAiProvider">' + t('Provider:') + '</label>' +
				'<select id="settingsAiProvider" class="settingsSelect">' + ai.presets.map((preset) => '<option value="' + escapeHtml(preset.id) + '"' + (preset.id === ai.provider ? ' selected' : '') + '>' + escapeHtml(providerLabel(preset)) + '</option>').join('') + '</select>' +
				(isDirectAi
					? '<label class="settingsKey" for="settingsAiModel">' + t('Model:') + '</label>' +
					'<div class="settingsAiModelField"><div class="settingsAiModelInputRow"><input id="settingsAiModel" type="text" class="settingsInput mono" value="' + escapeHtml(ai.model) + '" placeholder="' + escapeHtml(modelPlaceholder) + '" spellcheck="false">' +
					'<button type="button" id="settingsDetectAiModels" class="settingsBtn settingsDetectBtn" title="' + escapeHtml(t('Query /models from the configured endpoint')) + '"' + (this.aiModelsLoading ? ' disabled' : '') + ' tabindex="-1">' + MENU_ICONS.fetch + (this.aiModelsLoading ? t('Loading…') : t('Detect Models')) + '</button></div>' + discoveredChips + '</div>' +
					'<label class="settingsKey" for="settingsAiBaseUrl">' + t('Base URL:') + '</label>' +
					'<input id="settingsAiBaseUrl" type="text" class="settingsInput mono" value="' + escapeHtml(ai.baseUrl) + '" placeholder="' + escapeHtml(baseUrlPlaceholder) + '" spellcheck="false">' +
					'<span class="settingsKey">' + t('API Key:') + '</span><span class="settingsValue">' + apiKeyStatus + '</span>'
					: '') +
				'</div>' +
				(!isDirectAi ? '<p class="settingsDescription">' + t('Uses the language models provided in Visual Studio Code (e.g. GitHub Copilot Chat). No API URL or API key is needed.') + '</p>'
					: ai.provider === 'Magpie' ? '<p class="settingsDescription">' + t('Requests go through the local gateway of Magpie, which calls the providers signed in to it. Keep Magpie running; leave Model blank to auto-detect or pick one above.') + '</p>'
						: ai.provider === 'CC Switch' ? '<p class="settingsDescription">' + t('Requests go through the local routing of CC Switch to the provider currently selected for Codex. Turn on local routing in CC Switch; leave Model blank to use its active route or pick one above.') + '</p>'
							: '');
			const aiEnabledCount = (ai.commitMessage ? 1 : 0) + (ai.explainCommit ? 1 : 0);
			const taskModels: GG.AiTaskModelsConfig = ai.taskModels || {};
			const aiTaskRows = (<const>['commitMessage', 'reviewChanges', 'resolveConflicts', 'explainAndSearch']).map((task) => {
				const cur = taskModels[task]?.model || '';
				return '<label class="settingsKey">' + escapeHtml(task) + ':</label><input type="text" class="settingsInput mono settingsAiTaskModelInput" data-ai-task="' + task + '" value="' + escapeHtml(cur) + '" placeholder="' + escapeHtml(t('Use default model')) + '">';
			}).join('');
			const aiExcludeStr = Array.isArray(ai.excludeFiles) ? ai.excludeFiles.join(', ') : '';
			const customInstr: Partial<GG.AiCustomInstructionsConfig> = ai.customInstructions || {};
			const aiInstrRows = (<const>['commitMessage', 'reviewChanges', 'resolveConflicts', 'explainChanges', 'generateChangelog', 'generateStashMessage']).map((taskKey) => {
				const cur = customInstr[taskKey] || '';
				return '<label class="settingsKey">' + escapeHtml(taskKey) + ':</label><input type="text" class="settingsInput settingsAiInstructionInput" data-ai-instr-task="' + taskKey + '" value="' + escapeHtml(cur) + '" placeholder="' + escapeHtml(t('Optional custom prompt instructions…')) + '">';
			}).join('');
			html += '<div class="settingsSection" id="settingsAiSection" data-nav-group="integrations" data-nav-label="' + escapeHtml(t('AI')) + '" data-nav-enabled="' + aiEnabledCount + '" data-nav-total="2"><h3>' + MENU_ICONS.sparkle + t('AI · All Repositories') + '</h3>' +
				'<div class="settingsCheckboxes two">' +
				'<span>' + checkbox('settingsAiCommitMessage', t('Generate Commit Messages'), t('Adds an action to generate commit messages from uncommitted changes in the Source Control view and the Git Map View.')) + '</span>' +
				'<span>' + checkbox('settingsAiExplainCommit', t('Explain Commits'), t('Shows an "Explain" tab in the Commit Details View, where a language model explains the selected commit.')) + '</span>' +
				'</div>' +
				card(MENU_ICONS.sparkle + t('Language Model'), aiButtons, aiCardBody) +
				card(MENU_ICONS.settings + t('AI Task Model Routing & Safety'), '', '<div class="settingsGrid two">' +
					aiTaskRows +
					'<label class="settingsKey">' + t('Exclude Files:') + '</label><input id="settingsAiExcludeFiles" type="text" class="settingsInput mono" value="' + escapeHtml(aiExcludeStr) + '" placeholder="**/*.lock, dist/**">' +
					'<label class="settingsKey">' + t('Token Warning:') + '</label><input id="settingsAiTokenWarn" type="number" min="500" step="500" class="settingsInput mono" value="' + (ai.largePromptWarningThreshold || 6000) + '">' +
					'<label class="settingsKey">' + t('Auto-Rebase Threshold:') + '</label><input id="settingsAiAutoRebaseThreshold" type="number" min="0.5" max="1" step="0.05" class="settingsInput mono" value="' + (ai.autoRebaseConfidenceThreshold || 0.85) + '">' +
					'</div>') +
				card(MENU_ICONS.edit + t('AI Custom Instructions'), '', '<div class="settingsGrid two">' + aiInstrRows + '</div>') +
				'</div>';

			const fallbackAgents: ReadonlyArray<GG.CodingAgentStatus> = [
				{ id: 'copilot-chat', name: 'Copilot Chat', kind: 'chat', detected: false, isDefault: ext.defaultAgent === 'copilot-chat', mcpConfigured: false, hooksConfigured: false },
				{ id: 'claude-code', name: 'Claude Code', kind: 'cli', detected: false, isDefault: ext.defaultAgent === 'claude-code', mcpConfigured: false, hooksConfigured: false },
				{ id: 'codex', name: 'Codex', kind: 'cli', detected: false, isDefault: ext.defaultAgent === 'codex', mcpConfigured: false, hooksConfigured: false },
				{ id: 'copilot-cli', name: 'GitHub Copilot CLI', kind: 'cli', detected: false, isDefault: ext.defaultAgent === 'copilot-cli', mcpConfigured: false, hooksConfigured: false },
				{ id: 'opencode', name: 'OpenCode', kind: 'cli', detected: false, isDefault: ext.defaultAgent === 'opencode', mcpConfigured: false, hooksConfigured: false }
			];
			const agentsList = this.codingAgents.length > 0 ? this.codingAgents : fallbackAgents;
			const detectedAgentsCount = agentsList.filter((a) => a.detected || a.mcpConfigured).length;
			html += '<div class="settingsSection" id="settingsAgentsSection" data-nav-group="integrations" data-nav-label="' + escapeHtml(t('Agents')) + '" data-nav-enabled="' + detectedAgentsCount + '" data-nav-total="' + agentsList.length + '"><h3>' + MENU_ICONS.sparkle + t('Coding Agents, MCP & Hooks') + '</h3>' +
				'<p class="settingsDescription">' + t('Choose a default coding agent and configure the local Git Map stdio MCP server and repository Git hooks.') + '</p>' +
				'<table class="settingsMatrixTable"><thead><tr><th>' + t('Agent') + '</th><th>' + t('Default') + '</th><th>MCP</th><th>' + t('Hooks') + '</th></tr></thead><tbody>' +
				agentsList.map((ag) => {
					const statusBadge = ag.detected
						? '<span class="settingsAgentPill detected">' + escapeHtml(t('Detected')) + '</span>'
						: '<span class="settingsAgentPill">' + escapeHtml(t('Not detected')) + '</span>';
					const isDef = ext.defaultAgent === ag.id || ag.isDefault;
					const mcpBtn = '<button type="button" class="settingsBtn settingsAgentMcpBtn' + (ag.mcpConfigured ? ' active' : '') + '" data-agent-id="' + ag.id + '" data-mcp-on="' + (ag.mcpConfigured ? '1' : '0') + '" tabindex="-1">' + (ag.mcpConfigured ? '\u2713 MCP' : '+ MCP') + '</button>';
					const hookCell = ag.kind === 'chat'
						? '<span class="cdvMuted">&mdash;</span>'
						: '<button type="button" class="settingsBtn settingsAgentHookBtn' + (ag.hooksConfigured ? ' active' : '') + '" data-agent-id="' + ag.id + '" data-hook-on="' + (ag.hooksConfigured ? '1' : '0') + '" tabindex="-1">' + (ag.hooksConfigured ? '\u2713 ' + escapeHtml(t('Hook')) : '+ ' + escapeHtml(t('Hook'))) + '</button>';
					return '<tr><td><b>' + escapeHtml(ag.name) + '</b> <span class="cdvMuted">(' + ag.kind.toUpperCase() + ')</span> ' + statusBadge + '</td>' +
						'<td><label><input type="radio" name="settingsDefaultAgent" class="settingsDefaultAgentRadio" value="' + ag.id + '"' + (isDef ? ' checked' : '') + ' tabindex="-1"><span class="customRadio"></span></label></td>' +
						'<td>' + mcpBtn + '</td><td>' + hookCell + '</td></tr>';
				}).join('') +
				'</tbody></table></div>';

			const autolinkListHtml = ext.autolinks.length === 0
				? '<p class="settingsDescription">' + t('No autolink rules configured. Add a prefix such as "JIRA-" or "#" with a URL containing "<num>".') + '</p>'
				: ext.autolinks.map((r, i) => '<div class="settingsRuleChip"><span class="mono">' + escapeHtml(r.prefix) + '&lt;num&gt; &rarr; ' + escapeHtml(r.url) + '</span><button type="button" class="settingsBtn removeBtn settingsRemoveAutolinkBtn" data-rule-idx="' + i + '" tabindex="-1">&times;</button></div>').join('');
			html += '<div class="settingsSection" id="settingsAutolinksSection" data-nav-group="integrations" data-nav-label="' + escapeHtml(t('Autolinks & Start Work')) + '" data-nav-enabled="' + ext.autolinks.length + '" data-nav-total="' + Math.max(1, ext.autolinks.length) + '"><h3>' + MENU_ICONS.issue + t('Autolinks & Start Work') + '</h3>' +
				'<div class="settingsLivePreview" id="settingsAutolinkLivePreview">' + this.renderAutolinkPreviewHtml(ext.autolinks, ext.startWorkBranchFormat) + '</div>' +
				'<div class="settingsRuleList">' + autolinkListHtml + '</div>' +
				'<div class="settingsRuleRow">' +
				'<input id="settingsNewAutolinkPrefix" type="text" class="settingsInput mono" placeholder="PROJ-" style="width:90px">' +
				'<input id="settingsNewAutolinkUrl" type="text" class="settingsInput mono" placeholder="https://tracker.example.com/browse/PROJ-<num>" style="flex:1">' +
				'<button type="button" id="settingsAddAutolinkBtn" class="settingsBtn addBtn" tabindex="-1">' + t('Add Rule') + '</button>' +
				'</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Start Work Branch Format') + '</span><input id="settingsStartWorkFormat" type="text" class="settingsInput mono" value="' + escapeHtml(ext.startWorkBranchFormat) + '" style="max-width:260px"></div>' +
				'</div>';

			const customRemotesListHtml = ext.customRemotes.length === 0
				? '<p class="settingsDescription">' + t('Map self-hosted Git remotes (GitHub Enterprise, GitLab Self-Hosted, Gitea, Bitbucket Server, Azure DevOps) by domain or regex.') + '</p>'
				: ext.customRemotes.map((cr, idx) =>
					'<div class="settingsRuleChip"><span class="mono">[' + escapeHtml(cr.type) + '] ' + escapeHtml(cr.domain || cr.regex || '') + (cr.avatarUrl ? ' · ' + escapeHtml(cr.avatarUrl) : '') + '</span>' +
					'<button type="button" class="settingsBtn removeBtn settingsRemoveCustomRemoteBtn" data-cr-idx="' + idx + '" tabindex="-1">&times;</button></div>'
				).join('');
			const integrationsEnabled = extBoolCount([ext.terminalLinksEnabled, ext.followTerminalEnabled, ext.launchpadEnabled]);
			html += '<div class="settingsSection" id="settingsIntegrationsSection" data-nav-group="integrations" data-nav-label="' + escapeHtml(t('Terminal Links & Launchpad')) + '" data-nav-enabled="' + integrationsEnabled + '" data-nav-total="3"><h3>' + MENU_ICONS.cloud + t('Terminal Links, Launchpad & Custom Remotes') + '</h3>' +
				'<div class="settingsCheckboxes two">' +
				'<span>' + extCheckbox('settingsTerminalLinks', 'terminalLinks.enabled', ext.terminalLinksEnabled, t('Terminal Git Links')) + '</span>' +
				'<span>' + extCheckbox('settingsTerminalDetails', 'terminalLinks.showDetailsView', ext.terminalLinksShowDetails, t('Open Details View on Link Click')) + '</span>' +
				'<span>' + extCheckbox('settingsFollowTerminal', 'graph.followTerminal.enabled', ext.followTerminalEnabled, t('Follow Active Terminal Repo')) + '</span>' +
				'<span>' + extCheckbox('settingsLaunchpad', 'launchpad.indicator.enabled', ext.launchpadEnabled, t('Status Bar PR Launchpad')) + '</span>' +
				'<span>' + extCheckbox('settingsLaunchpadColors', 'launchpad.indicator.useColors', ext.launchpadUseColors, t('Use Launchpad Status Colors')) + '</span>' +
				'</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Launchpad Quick Triage') + '</span><button type="button" id="settingsOpenLaunchpadBtn" class="settingsBtn" tabindex="-1">' + t('Open Launchpad') + ELLIPSIS + '</button></div>' +
				card(MENU_ICONS.cloud + t('Custom Remotes'), '', '<div class="settingsRuleList">' + customRemotesListHtml + '</div>' +
					'<div class="settingsRuleRow">' +
					'<select id="settingsNewCustomRemoteType" class="settingsSelect" style="width:120px">' +
					['github', 'gitlab', 'gitea', 'bitbucket', 'azure', 'custom'].map((tp) => '<option value="' + tp + '">' + tp + '</option>').join('') +
					'</select>' +
					'<input id="settingsNewCustomRemoteDomain" type="text" class="settingsInput mono" placeholder="git.corp.example.com" style="flex:1">' +
					'<button type="button" id="settingsAddCustomRemoteBtn" class="settingsBtn addBtn" tabindex="-1">+ ' + t('Add Remote') + '</button>' +
					'</div>') +
				'</div>';

			const editorEnabledCount = extBoolCount([ext.editor.currentLineEnabled, ext.editor.statusBarEnabled, ext.editor.codeLensEnabled, ext.editor.hoversEnabled, ext.editor.fileBlameHeatmap, ext.editor.fileBlameHighlightSameCommit]);
			html += '<div class="settingsSection" id="settingsEditorSection" data-nav-group="editor" data-nav-label="' + escapeHtml(t('Editor Annotations')) + '" data-nav-enabled="' + editorEnabledCount + '" data-nav-total="6"><h3>' + MENU_ICONS.edit + t('Editor Annotations & Modes · All Repositories') + '</h3>' +
				'<div class="settingsLivePreview" id="settingsEditorLivePreview">' + this.renderEditorPreviewHtml(ext.editor) + '</div>' +
				'<div class="settingsRow"><span class="settingsLabel">' + t('Active Editor Mode') + '</span>' + extSegmented('mode.active', [['default', t('Default')], ['zen', t('Zen')], ['review', t('Review')]], ext.editor.activeMode) + '</div>' +
				'<div class="settingsCheckboxes two">' +
				'<span>' + extCheckbox('settingsEdCurrentLine', 'blame.currentLine', ext.editor.currentLineEnabled, t('Current Line Inline Blame')) + '</span>' +
				'<span>' + extCheckbox('settingsEdLinePr', 'blame.currentLine.pullRequests.enabled', ext.editor.currentLinePullRequests, t('Pull Request in Line Blame')) + '</span>' +
				'<span>' + extCheckbox('settingsEdLineScroll', 'blame.currentLine.scrollable', ext.editor.currentLineScrollable, t('Scrollable Inline Annotation')) + '</span>' +
				'<span>' + extCheckbox('settingsEdStatusBar', 'blame.statusBar', ext.editor.statusBarEnabled, t('Status Bar Blame')) + '</span>' +
				'<span>' + extCheckbox('settingsEdStatusFlicker', 'blame.statusBar.reduceFlicker', ext.editor.statusBarReduceFlicker, t('Reduce Status Bar Flicker')) + '</span>' +
				'<span>' + extCheckbox('settingsEdCodeLens', 'codeLens.enabled', ext.editor.codeLensEnabled, t('Git CodeLens')) + '</span>' +
				'<span>' + extCheckbox('settingsEdLensRecent', 'codeLens.recentChange.enabled', ext.editor.codeLensRecentChange, t('CodeLens: Recent Change')) + '</span>' +
				'<span>' + extCheckbox('settingsEdLensAuthors', 'codeLens.authors.enabled', ext.editor.codeLensAuthors, t('CodeLens: Authors')) + '</span>' +
				'<span>' + extCheckbox('settingsEdHovers', 'hovers.enabled', ext.editor.hoversEnabled, t('Rich Blame Hovers')) + '</span>' +
				'<span>' + extCheckbox('settingsEdHoverAutolinks', 'hovers.autolinks.enabled', ext.editor.hoversAutolinks, t('Autolinks in Hovers')) + '</span>' +
				'<span>' + extCheckbox('settingsEdFileBlameCompact', 'fileBlame.compact', ext.editor.fileBlameCompact, t('Compact File Blame')) + '</span>' +
				'<span>' + extCheckbox('settingsEdFileBlameHeatmap', 'fileBlame.heatmap.enabled', ext.editor.fileBlameHeatmap, t('File Blame Heatmap')) + '</span>' +
				'<span>' + extCheckbox('settingsEdSameCommit', 'fileBlame.highlight.enabled', ext.editor.fileBlameHighlightSameCommit, t('Highlight Same-Commit Lines')) + '</span>' +
				'<span>' + extCheckbox('settingsEdHeatmapFade', 'fileHeatmap.fadeLines', ext.editor.fileHeatmapFadeLines, t('Fade Old Lines in Heatmap')) + '</span>' +
				'</div>' +
				card(MENU_ICONS.edit + t('Blame Annotation Format Templates'), '', '<div class="settingsGrid two">' +
					'<label class="settingsKey" for="settingsBlameInlineFormat">' + t('Inline Blame Format:') + '</label>' +
					'<input id="settingsBlameInlineFormat" type="text" class="settingsInput mono" value="' + escapeHtml(ext.editor.currentLineFormat) + '" spellcheck="false">' +
					'<label class="settingsKey" for="settingsBlameUncommittedFormat">' + t('Uncommitted Blame Format:') + '</label>' +
					'<input id="settingsBlameUncommittedFormat" type="text" class="settingsInput mono" value="' + escapeHtml(ext.editor.currentLineUncommittedFormat) + '" spellcheck="false">' +
					'<label class="settingsKey" for="settingsBlameStatusBarFormat">' + t('Status Bar Blame Format:') + '</label>' +
					'<input id="settingsBlameStatusBarFormat" type="text" class="settingsInput mono" value="' + escapeHtml(ext.editor.statusBarFormat) + '" spellcheck="false">' +
					'</div>') +
				'</div>';

			html += '<div class="settingsSection" data-nav-group="views" data-nav-label="' + escapeHtml(t('This Repository')) + '"><h3>' + MENU_ICONS.repo + t('This Repository') + '</h3>' +
				'<div class="settingsCheckboxes">' +
				'<span>' + checkbox('settingsShowRemoteBranches', t('Show Remote Branches'), null) + '</span>' +
				'<span>' + checkbox('settingsShowStashes', t('Show Stashes'), null) + '</span>' +
				'<span>' + checkbox('settingsShowTags', t('Show Tags'), null) + '</span>' +
				'</div>';

			let generalHtml = card(MENU_ICONS.settings + t('General'), '', '<div class="settingsGrid">' +
				'<span class="settingsKey">' + t('Name:') + '</span><span class="settingsValue" title="' + escapedRepoName + (this.repo.name === null ? t(' (Default Name from the File System)') : '') + '">' + escapedRepoName + '</span><span class="btns"><div id="editRepoName" title="' + t('Edit Name') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (this.repo.name !== null ? ' <div id="deleteRepoName" title="' + t('Delete Name') + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</span>' +
				'<span class="settingsKey">' + t('Initial Branches:') + '</span><span class="settingsValue" title="' + initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? t('Local') : t('Global')) + ')">' + initialBranchesStr + '</span><span class="btns"><div id="editInitialBranches" title="' + t('Edit Initial Branches') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (initialBranchesLocallyConfigured ? ' <div id="clearInitialBranches" title="' + t('Clear Initial Branches') + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</span>' +
				'</div>' +
				'<div class="settingsOptions">' +
				'<span>' + checkbox('settingsIncludeCommitsMentionedByReflogs', t('Include commits only mentioned by reflogs'), t('Only applies when showing all branches.')) + '</span>' +
				'<span>' + checkbox('settingsOnlyFollowFirstParent', t('Only follow the first parent of commits'), t('Instead of following all parents of commits, only follow the first parent when discovering the commits to load.')) + '</span>' +
				'</div>');

			let userNameSet = false, userEmailSet = false;
			if (this.config !== null) {
				const userName = this.config.user.name, userEmail = this.config.user.email;
				userNameSet = userName.local !== null || userName.global !== null;
				userEmailSet = userEmail.local !== null || userEmail.global !== null;
				if (userNameSet || userEmailSet) {
					const escapedUserName = escapeHtml(userName.local ?? userName.global ?? t('Not Set'));
					const escapedUserEmail = escapeHtml(userEmail.local ?? userEmail.global ?? t('Not Set'));
					generalHtml += card(MENU_ICONS.person + t('User Details'), button('editUserDetails', 'editBtn', MENU_ICONS.edit + t('Edit')) + button('removeUserDetails', 'removeBtn', MENU_ICONS.trash + t('Remove')), '<div class="settingsGrid two">' +
						'<span class="settingsKey">' + t('User Name:') + '</span><span class="settingsValue" title="' + escapedUserName + (userNameSet ? ' (' + (userName.local !== null ? t('Local') : t('Global')) + ')' : '') + '">' + escapedUserName + '</span>' +
						'<span class="settingsKey">' + t('User Email:') + '</span><span class="settingsValue" title="' + escapedUserEmail + (userEmailSet ? ' (' + (userEmail.local !== null ? t('Local') : t('Global')) + ')' : '') + '">' + escapedUserEmail + '</span>' +
						'</div>');
				} else {
					generalHtml += card(MENU_ICONS.person + t('User Details'), button('editUserDetails', 'addBtn', MENU_ICONS.plus + t('Add User Details')), '<p class="settingsDescription">' + t('User Details (such as name and email) are used by Git to record the Author and Committer of commit objects.') + '</p>');
				}
			}

			const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
			if (issueLinkingConfig !== null) {
				const escapedIssue = escapeHtml(issueLinkingConfig.issue), escapedUrl = escapeHtml(issueLinkingConfig.url);
				html += card(MENU_ICONS.issue + t('Issue Linking'), button('editIssueLinking', 'editBtn', MENU_ICONS.edit + t('Edit')) + button('removeIssueLinking', 'removeBtn', MENU_ICONS.trash + t('Remove')), '<div class="settingsGrid two">' +
					'<span class="settingsKey">' + t('Issue Regex:') + '</span><span class="settingsValue mono" title="' + escapedIssue + '">' + escapedIssue + '</span>' +
					'<span class="settingsKey">' + t('Issue URL:') + '</span><span class="settingsValue mono" title="' + escapedUrl + '">' + escapedUrl + '</span>' +
					'</div>');
			} else {
				html += card(MENU_ICONS.issue + t('Issue Linking'), button('editIssueLinking', 'addBtn', MENU_ICONS.plus + t('Add Issue Linking')), '<p class="settingsDescription">' + t('Issue Linking converts issue numbers in commit &amp; tag messages into hyperlinks, that open the issue in your issue tracking system. If a branch\'s name contains an issue number, the issue can be viewed via the branch\'s context menu.') + '</p>');
			}

			if (this.config !== null) {
				let remotesHtml = '';
				if (this.config.remotes.length > 0) {
					const hideRemotes = this.repo.hideRemotes;
					this.config.remotes.forEach((remote, i) => {
						const hidden = hideRemotes.includes(remote.name);
						const fetchUrl = escapeHtml(remote.url || t('Not Set')), pushUrl = escapeHtml(remote.pushUrl || remote.url || t('Not Set'));
						const separatePushUrl = remote.pushUrl !== null && remote.pushUrl !== remote.url;
						remotesHtml += '<div class="settingsRemote">' +
							'<span class="settingsRemoteName"><span class="hideRemoteBtn" data-index="' + i + '" title="' + (hidden ? t('Click to show branches of this remote.') : t('Click to hide branches of this remote.')) + '">' + (hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen) + '</span><b>' + escapeHtml(remote.name) + '</b></span>' +
							'<span class="settingsRemoteUrls"><span class="settingsValue mono" title="' + t('Fetch URL:') + ' ' + fetchUrl + '">' + fetchUrl + '</span>' + (separatePushUrl ? '<span class="settingsValue mono" title="' + t('Push URL:') + ' ' + pushUrl + '"><span class="settingsKey">' + t('Push') + '</span> ' + pushUrl + '</span>' : '') + '</span>' +
							'<span class="btns remoteBtns" data-index="' + i + '"><div class="fetchRemote" title="' + t('Fetch from Remote') + ELLIPSIS + '">' + SVG_ICONS.download + '</div><div class="pruneRemote" title="' + t('Prune Remote') + ELLIPSIS + '">' + SVG_ICONS.branch + '</div><div class="editRemote" title="' + t('Edit Remote') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div><div class="deleteRemote" title="' + t('Delete Remote') + ELLIPSIS + '">' + SVG_ICONS.close + '</div></span>' +
							'</div>';
					});
				} else {
					remotesHtml = '<p class="settingsDescription">' + t('There are no remotes configured for this repository.') + '</p>';
				}
				html += card(MENU_ICONS.cloud + t('Remotes'), button('settingsAddRemote', 'addBtn', MENU_ICONS.plus + t('Add Remote') + ELLIPSIS), remotesHtml);
				html += generalHtml;
				generalHtml = '';

				const pullRequestConfig = this.repo.pullRequestConfig;
				if (pullRequestConfig !== null) {
					const provider = escapeHtml((pullRequestConfig.provider === GG.PullRequestProvider.Bitbucket
						? 'Bitbucket'
						: pullRequestConfig.provider === GG.PullRequestProvider.Custom
							? pullRequestConfig.custom.name
							: pullRequestConfig.provider === GG.PullRequestProvider.GitHub
								? 'GitHub'
								: 'GitLab'
					) + ' (' + pullRequestConfig.hostRootUrl + ')');
					const source = escapeHtml(pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')');
					const destination = escapeHtml(pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : ''));
					const destinationBranch = escapeHtml(pullRequestConfig.destBranch);
					html += card(MENU_ICONS.pullRequest + t('Pull Request Creation'), button('editPullRequestIntegration', 'editBtn', MENU_ICONS.edit + t('Edit')) + button('removePullRequestIntegration', 'removeBtn', MENU_ICONS.trash + t('Remove')), '<div class="settingsGrid two">' +
						'<span class="settingsKey">' + t('Provider:') + '</span><span class="settingsValue" title="' + provider + '">' + provider + '</span>' +
						'<span class="settingsKey">' + t('Source Repo:') + '</span><span class="settingsValue" title="' + source + '">' + source + '</span>' +
						'<span class="settingsKey">' + t('Destination Repo:') + '</span><span class="settingsValue" title="' + destination + '">' + destination + '</span>' +
						'<span class="settingsKey">' + t('Destination Branch:') + '</span><span class="settingsValue" title="' + destinationBranch + '">' + destinationBranch + '</span>' +
						'</div>');
				} else {
					html += card(MENU_ICONS.pullRequest + t('Pull Request Creation'), button('editPullRequestIntegration', 'addBtn', MENU_ICONS.settings + t('Configure') + ELLIPSIS), '<p class="settingsDescription">' + t('Pull Request Creation automates the opening and pre-filling of a Pull Request form, directly from a branch\'s context menu.') + '</p>');
				}
				html += card(
					MENU_ICONS.pullRequest + t('PR & CI Status Badges'),
					button('settingsSetHostingToken', 'editBtn', MENU_ICONS.key + t('Set Token') + ELLIPSIS) + button('settingsClearHostingToken', 'removeBtn', MENU_ICONS.trash + t('Clear Token')),
					'<div class="settingsOptions"><span>' + checkbox('settingsPrStatusBadges', t('Show open PR / MR numbers & CI status badges on local branch labels'), t('Supports GitHub, GitLab, Gitea / Forgejo / Codeberg, Bitbucket & Azure DevOps.')) + '</span></div>'
				);
			}
			html += generalHtml +
				card(
					MENU_ICONS.settings + t('Repository Health & SSH Signing'),
					button('settingsCheckRepoHealthBtn', 'editBtn', MENU_ICONS.settings + t('Check & Optimize') + ELLIPSIS) +
					button('settingsEditSshSignersBtn', 'editBtn', MENU_ICONS.key + t('SSH Allowed Signers') + ELLIPSIS),
					'<p class="settingsDescription">' + t('Inspect commit-graph indexes, pack loose objects with git gc, or configure local SSH allowed_signers signature verification.') + '</p>'
				) +
				'</div>';

			this.contentsElem.innerHTML = html;
			this.repoNameElem.textContent = this.repo.name || getRepoName(this.currentRepo);
			this.footerElem.innerHTML = '<button type="button" id="exportRepositoryConfig" class="settingsBtn" tabindex="-1">' + SVG_ICONS.package + t('Export Repository Configuration') + '</button><span id="openExtensionSettings" class="settingsLink" tabindex="-1">' + t('Open Git Map Extension Settings') + '</span>';
			this.renderNavRail();
			this.applySearchFilter();
			this.renderAppearanceListeners();

			const showRemoteBranchesElem = <HTMLInputElement>document.getElementById('settingsShowRemoteBranchesCheckbox');
			showRemoteBranchesElem.checked = getShowRemoteBranches(this.repo.showRemoteBranchesV2);
			showRemoteBranchesElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				this.view.setShowRemoteBranches(showRemoteBranchesElem.checked);
			});

			document.getElementById('editRepoName')!.addEventListener('click', () => {
				if (this.currentRepo === null || this.repo === null) return;
				dialog.showForm(t('Specify a Name for this Repository:'), [
					{ type: DialogInputType.Text, name: t('Name'), default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
				], t('Save Name'), (values) => {
					if (this.currentRepo === null) return;
					this.view.saveRepoStateValue(this.currentRepo, 'name', <string>values[0] || null);
					this.view.renderRepoDropdownOptions();
					this.render();
				}, null);
			});

			if (this.repo.name !== null) {
				document.getElementById('deleteRepoName')!.addEventListener('click', () => {
					if (this.currentRepo === null || this.repo === null || this.repo.name === null) return;
					dialog.showConfirmation(t('Are you sure you want to delete the manually configured name <b><i>{0}</i></b> for this repository, and use the default name from the File System <b><i>{1}</i></b>?', escapeHtml(this.repo.name), escapeHtml(getRepoName(this.currentRepo))), t('Yes, delete'), () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'name', null);
						this.view.renderRepoDropdownOptions();
						this.render();
					}, null);
				});
			}

			document.getElementById('editInitialBranches')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch);
				const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches);
				dialog.showForm('<b>' + t('Configure Initial Branches') + '</b><p style="margin:6px 0;">' + t('Configure the branches that are initially shown when this repository is loaded in the Git Map View.') + '</p><p style="font-size:12px; margin:6px 0 0 0;">' + t('Note: When "Checked Out Branch" is Disabled, and no "Specific Branches" are selected, all branches will be shown.') + '</p>', [
					{ type: DialogInputType.Checkbox, name: t('Checked Out Branch'), value: showCheckedOutBranch },
					{ type: DialogInputType.Select, name: t('Specific Branches'), options: this.view.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
				], t('Save Configuration'), (values) => {
					if (this.currentRepo === null) return;
					if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
						this.render();
					}
				}, null, t('Cancel'), null);
			});

			if (initialBranchesLocallyConfigured) {
				document.getElementById('clearInitialBranches')!.addEventListener('click', () => {
					dialog.showConfirmation(t('Are you sure you want to clear the branches that are initially shown when this repository is loaded in the Git Map View?'), t('Yes, clear'), () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
						this.render();
					}, null);
				});
			}

			const showStashesElem = <HTMLInputElement>document.getElementById('settingsShowStashesCheckbox');
			showStashesElem.checked = getShowStashes(this.repo.showStashes);
			showStashesElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowStashesCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showStashes', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const showTagsElem = <HTMLInputElement>document.getElementById('settingsShowTagsCheckbox');
			showTagsElem.checked = getShowTags(this.repo.showTags);
			showTagsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowTagsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showTags', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const includeCommitsMentionedByReflogsElem = <HTMLInputElement>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
			includeCommitsMentionedByReflogsElem.checked = getIncludeCommitsMentionedByReflogs(this.repo.includeCommitsMentionedByReflogs);
			includeCommitsMentionedByReflogsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'includeCommitsMentionedByReflogs', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const settingsOnlyFollowFirstParentElem = <HTMLInputElement>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
			settingsOnlyFollowFirstParentElem.checked = getOnlyFollowFirstParent(this.repo.onlyFollowFirstParent);
			settingsOnlyFollowFirstParentElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'onlyFollowFirstParent', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			if (this.config !== null) {
				document.getElementById('editUserDetails')!.addEventListener('click', () => {
					if (this.config === null) return;
					const userName = this.config.user.name, userEmail = this.config.user.email;
					dialog.showForm(t('Set the user name and email used by Git to record the Author and Committer of commit objects:'), [
						{ type: DialogInputType.Text, name: t('User Name'), default: userName.local ?? userName.global ?? '', placeholder: null },
						{ type: DialogInputType.Text, name: t('User Email'), default: userEmail.local ?? userEmail.global ?? '', placeholder: null },
						{ type: DialogInputType.Checkbox, name: t('Use Globally'), value: userName.local === null && userEmail.local === null, info: t('Use the "User Name" and "User Email" globally for all Git repositories (it can be overridden per repository).') }
					], t('Set User Details'), (values) => {
						if (this.currentRepo === null) return;
						const useGlobally = <boolean>values[2];
						runAction({
							command: 'editUserDetails',
							repo: this.currentRepo,
							name: <string>values[0],
							email: <string>values[1],
							location: useGlobally ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local,
							deleteLocalName: useGlobally && userName.local !== null,
							deleteLocalEmail: useGlobally && userEmail.local !== null
						}, t('Setting User Details'));
					}, null);
				});

				if (userNameSet || userEmailSet) {
					document.getElementById('removeUserDetails')!.addEventListener('click', () => {
						if (this.config === null) return;
						const userName = this.config.user.name, userEmail = this.config.user.email;
						const isGlobal = userName.local === null && userEmail.local === null;
						dialog.showConfirmation((isGlobal ? t('Are you sure you want to remove the <b>globally configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?') : t('Are you sure you want to remove the <b>locally configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?')), t('Yes, remove'), () => {
							if (this.currentRepo === null) return;
							runAction({
								command: 'deleteUserDetails',
								repo: this.currentRepo,
								name: (isGlobal ? userName.global : userName.local) !== null,
								email: (isGlobal ? userEmail.global : userEmail.local) !== null,
								location: isGlobal ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local
							}, t('Removing User Details'));
						}, null);
					});
				}

				const pushUrlPlaceholder = t('Leave blank to use the Fetch URL');
				document.getElementById('settingsAddRemote')!.addEventListener('click', () => {
					dialog.showForm(t('Add a new remote to this repository:'), [
						{ type: DialogInputType.Text, name: t('Name'), default: '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Fetch URL'), default: '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Push URL'), default: '', placeholder: pushUrlPlaceholder },
						{ type: DialogInputType.Checkbox, name: t('Fetch Immediately'), value: true }
					], t('Add Remote'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'addRemote', repo: this.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, t('Adding Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('editRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(t('Edit the remote <b><i>{0}</i></b>:', escapeHtml(remote.name)), [
						{ type: DialogInputType.Text, name: t('Name'), default: remote.name, placeholder: null },
						{ type: DialogInputType.Text, name: t('Fetch URL'), default: remote.url !== null ? remote.url : '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Push URL'), default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: pushUrlPlaceholder }
					], t('Save Changes'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, t('Saving Changes to Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('deleteRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.asDangerous().showConfirmation(t('Are you sure you want to delete the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), t('Yes, delete'), () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, t('Deleting Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('fetchRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(t('Are you sure you want to fetch from the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), [
						{ type: DialogInputType.Checkbox, name: t('Prune'), value: initialState.config.dialogDefaults.fetchRemote.prune, info: t('Before fetching, remove any remote-tracking references that no longer exist on the remote.') },
						{ type: DialogInputType.Checkbox, name: t('Prune Tags'), value: initialState.config.dialogDefaults.fetchRemote.pruneTags, info: t('Before fetching, remove any local tags that no longer exist on the remote. Requires Git >= 2.17.0, and "Prune" to be enabled.') }
					], t('Yes, fetch'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, t('Fetching from Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('pruneRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation(t('Are you sure you want to prune remote-tracking references that no longer exist on the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), t('Yes, prune'), () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, t('Pruning Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('hideRemoteBtn', 'click', (e) => {
					if (this.currentRepo === null || this.repo === null || this.config === null) return;
					const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
					const remote = this.config.remotes[parseInt(source.dataset.index!)].name;
					const hideRemote = !this.repo.hideRemotes.includes(remote);
					source.title = (hideRemote ? t('Click to show branches of this remote.') : t('Click to hide branches of this remote.'));
					source.innerHTML = hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen;
					if (hideRemote) {
						this.repo.hideRemotes.push(remote);
					} else {
						this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
					}
					this.view.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
					this.view.refresh(true);
				});
			}

			document.getElementById('editIssueLinking')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
				if (issueLinkingConfig !== null) {
					this.showIssueLinkingDialog(issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalState.issueLinkingConfig !== null, true);
				} else {
					this.showIssueLinkingDialog(null, null, false, false);
				}
			});

			if (this.repo.issueLinkingConfig !== null || globalState.issueLinkingConfig !== null) {
				document.getElementById('removeIssueLinking')!.addEventListener('click', () => {
					if (this.repo === null) return;
					const locallyConfigured = this.repo.issueLinkingConfig !== null;
					dialog.showConfirmation(t('Are you sure you want to remove {0}?', (locallyConfigured ? (globalState.issueLinkingConfig !== null ? t('the <b>locally configured</b> ') : '') + t('Issue Linking from this repository') : t('the <b>globally configured</b> Issue Linking in Git Map'))), t('Yes, remove'), () => {
						this.setIssueLinkingConfig(null, !locallyConfigured);
					}, null);
				});
			}

			if (this.config !== null) {
				document.getElementById('editPullRequestIntegration')!.addEventListener('click', () => {
					if (this.repo === null || this.config === null) return;

					if (this.config.remotes.length === 0) {
						dialog.showError(t('Unable to configure the "Pull Request Creation" Integration'), t('The repository must have at least one remote to configure the "Pull Request Creation" Integration. There are no remotes in the current repository.'), null, null);
						return;
					}

					let config: GG.DeepWriteable<GG.PullRequestConfig>;
					if (this.repo.pullRequestConfig === null) {
						let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
						let sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
						let provider: GG.PullRequestProvider;
						if (sourceRemoteUrl !== null) {
							if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*github/) !== null) {
								provider = GG.PullRequestProvider.GitHub;
							} else if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*gitlab/) !== null) {
								provider = GG.PullRequestProvider.GitLab;
							} else {
								provider = GG.PullRequestProvider.Bitbucket;
							}
						} else {
							provider = GG.PullRequestProvider.Bitbucket;
						}
						config = {
							provider: provider, hostRootUrl: '',
							sourceRemote: '', sourceOwner: '', sourceRepo: '',
							destRemote: '', destOwner: '', destRepo: '', destProjectId: '', destBranch: '',
							custom: null
						};
					} else {
						config = Object.assign({}, this.repo.pullRequestConfig);
					}
					this.showCreatePullRequestIntegrationDialog1(config);
				});

				if (this.repo.pullRequestConfig !== null) {
					document.getElementById('removePullRequestIntegration')!.addEventListener('click', () => {
						dialog.showConfirmation(t('Are you sure you want to remove the configured "Pull Request Creation" Integration?'), t('Yes, remove'), () => {
							this.setPullRequestConfig(null);
						}, null);
					});
				}

				const prBadgesCb = <HTMLInputElement | null>document.getElementById('settingsPrStatusBadgesCheckbox');
				if (prBadgesCb !== null) {
					prBadgesCb.checked = this.prStatusEnabled;
					prBadgesCb.addEventListener('change', () => {
						this.prStatusEnabled = prBadgesCb.checked;
						this.view.setPrStatusEnabled(this.prStatusEnabled, true);
					});
				}
				const setHostTokBtn = document.getElementById('settingsSetHostingToken');
				if (setHostTokBtn !== null) {
					setHostTokBtn.addEventListener('click', () => {
						sendMessage({ command: 'openCompanionFeature', feature: 'setHostingToken', repo: this.currentRepo || undefined });
					});
				}
				const clrHostTokBtn = document.getElementById('settingsClearHostingToken');
				if (clrHostTokBtn !== null) {
					clrHostTokBtn.addEventListener('click', () => {
						sendMessage({ command: 'openCompanionFeature', feature: 'clearHostingToken', repo: this.currentRepo || undefined });
					});
				}
			}

			document.getElementById('openExtensionSettings')!.addEventListener('click', () => {
				sendMessage({ command: 'openExtensionSettings' });
			});

			document.getElementById('exportRepositoryConfig')!.addEventListener('click', () => {
				dialog.showConfirmation(t('Exporting the Git Map Repository Configuration will generate a file that can be committed in this repository. It allows others working in this repository to use the same configuration.'), t('Yes, export'), () => {
					if (this.currentRepo === null) return;
					runAction({ command: 'exportRepoConfig', repo: this.currentRepo }, t('Exporting Repository Configuration'));
				}, null);
			});
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + t('Loading ...') + '</span>' : '';
		this.contentsElem.scrollTop = this.scrollTop;
	}

	/**
	 * Add the event listeners to the controls of the settings that apply to all repositories (the colour preset, line style, language & Status Bar Item).
	 */
	private renderAppearanceListeners() {
		const update = (key: GG.RequestUpdateExtensionSetting['key'], value: string | boolean) => {
			sendMessage({ command: 'updateExtensionSetting', key: key, value: value });
		};

		this.contentsElem.querySelectorAll<HTMLElement>('.settingsPreset').forEach((elem) => {
			elem.addEventListener('click', () => {
				const preset = elem.dataset.preset!;
				if (preset === this.appearance.colourPreset) return;
				this.appearance = Object.assign({}, this.appearance, { colourPreset: preset });
				this.render();
				update('graph.colourPreset', preset);
			});
		});

		this.contentsElem.querySelectorAll<HTMLElement>('.settingsSegmented').forEach((group) => {
			group.querySelectorAll<HTMLElement>('.settingsSegment').forEach((elem) => {
				elem.addEventListener('click', () => {
					if (elem.classList.contains(CLASS_SELECTED)) return;
					const setting = group.dataset.setting!, value = elem.dataset.value!;
					if (setting === 'statusBarItemDisplay') {
						this.appearance = Object.assign({}, this.appearance, { statusBarItemDisplay: value === 'Icon' ? GG.StatusBarItemDisplay.Icon : value === 'Text' ? GG.StatusBarItemDisplay.Text : GG.StatusBarItemDisplay.IconAndText });
						update('statusBarItemDisplay', value);
					} else if (setting === 'graph.freezeColumnHeaders' || setting === 'graph.freezeFooter') {
						update(setting, value === 'true');
					} else if (setting === 'diff.hideUnchangedRegions') {
						this.view.setHideUnchangedRegions(value === 'true', true);
					} else {
						update(<GG.RequestUpdateExtensionSetting['key']>setting, value);
					}
					group.querySelectorAll<HTMLElement>('.settingsSegment').forEach((segment) => {
						alterClass(segment, CLASS_SELECTED, segment === elem);
						segment.setAttribute('aria-checked', segment === elem ? 'true' : 'false');
					});
					if (setting === 'statusBarItemDisplay') this.render();
				});
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('input[name="settingsLanguage"]').forEach((elem) => {
			elem.addEventListener('change', () => {
				if (!elem.checked || elem.value === this.appearance.language) return;
				this.appearance = Object.assign({}, this.appearance, { language: elem.value });
				this.render();
				update('language', elem.value);
			});
		});

		const aiCommitMsgCheckbox = <HTMLInputElement | null>document.getElementById('settingsAiCommitMessageCheckbox');
		if (aiCommitMsgCheckbox !== null) {
			aiCommitMsgCheckbox.checked = this.ai.commitMessage;
			aiCommitMsgCheckbox.addEventListener('change', () => {
				this.ai = Object.assign({}, this.ai, { commitMessage: aiCommitMsgCheckbox.checked });
				this.view.setAiConfig(this.ai);
				update('ai.commitMessage.enabled', aiCommitMsgCheckbox.checked);
			});
		}

		const aiExplainCheckbox = <HTMLInputElement | null>document.getElementById('settingsAiExplainCommitCheckbox');
		if (aiExplainCheckbox !== null) {
			aiExplainCheckbox.checked = this.ai.explainCommit;
			aiExplainCheckbox.addEventListener('change', () => {
				this.ai = Object.assign({}, this.ai, { explainCommit: aiExplainCheckbox.checked });
				this.view.setAiConfig(this.ai);
				update('ai.explainCommit.enabled', aiExplainCheckbox.checked);
			});
		}

		const aiProviderSelect = <HTMLSelectElement | null>document.getElementById('settingsAiProvider');
		if (aiProviderSelect !== null) {
			aiProviderSelect.addEventListener('change', () => {
				const provider = aiProviderSelect.value;
				if (provider === this.ai.provider) return;
				this.discoveredAiModels = [];
				this.aiModelsStatus = null;
				this.aiModelsLoading = false;
				this.ai = Object.assign({}, this.ai, { provider: provider, hasApiKey: false });
				this.view.setAiConfig(this.ai);
				update('ai.provider', provider);
			});
		}

		const aiModelInput = <HTMLInputElement | null>document.getElementById('settingsAiModel');
		const aiBaseUrlInput = <HTMLInputElement | null>document.getElementById('settingsAiBaseUrl');
		const flushAiTextInputs = () => {
			let changed = false;
			if (aiModelInput !== null) {
				const model = aiModelInput.value.trim();
				if (model !== this.ai.model) {
					this.ai = Object.assign({}, this.ai, { model: model });
					changed = true;
					update('ai.model', model);
				}
			}
			if (aiBaseUrlInput !== null) {
				const baseUrl = aiBaseUrlInput.value.trim();
				if (baseUrl !== this.ai.baseUrl) {
					this.ai = Object.assign({}, this.ai, { baseUrl: baseUrl });
					changed = true;
					update('ai.baseUrl', baseUrl);
				}
			}
			if (changed) this.view.setAiConfig(this.ai);
		};
		if (aiModelInput !== null) {
			aiModelInput.addEventListener('change', flushAiTextInputs);
			aiModelInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					aiModelInput.blur();
				}
			});
		}
		if (aiBaseUrlInput !== null) {
			aiBaseUrlInput.addEventListener('change', flushAiTextInputs);
			aiBaseUrlInput.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					aiBaseUrlInput.blur();
				}
			});
		}

		const setApiKeyBtn = document.getElementById('settingsSetAiApiKey');
		if (setApiKeyBtn !== null) {
			setApiKeyBtn.addEventListener('click', () => {
				flushAiTextInputs();
				sendMessage({ command: 'setAiApiKey' });
			});
		}
		const clearApiKeyBtn = document.getElementById('settingsClearAiApiKey');
		if (clearApiKeyBtn !== null) {
			clearApiKeyBtn.addEventListener('click', () => {
				sendMessage({ command: 'clearAiApiKey' });
			});
		}
		const detectAiModelsBtn = document.getElementById('settingsDetectAiModels');
		if (detectAiModelsBtn !== null) {
			detectAiModelsBtn.addEventListener('click', () => {
				if (this.aiModelsLoading) return;
				flushAiTextInputs();
				this.aiModelsLoading = true;
				this.aiModelsStatus = null;
				this.render();
				sendMessage({ command: 'fetchAiModels' });
			});
		}
		this.contentsElem.querySelectorAll<HTMLElement>('.settingsAiModelChip').forEach((chip) => {
			chip.addEventListener('click', () => {
				const pickedModel = chip.dataset.aiModel || '';
				if (pickedModel === '' || pickedModel === this.ai.model) return;
				this.ai = Object.assign({}, this.ai, { model: pickedModel });
				this.view.setAiConfig(this.ai);
				update('ai.model', pickedModel);
			});
		});
		const customizeCdvActionsBtn = document.getElementById('settingsCustomizeCdvActions');
		if (customizeCdvActionsBtn !== null) {
			customizeCdvActionsBtn.addEventListener('click', () => {
				this.view.openCdvActionsCustomizer();
			});
		}

		const saveExt = (patch: { [key: string]: unknown }) => {
			sendMessage({ command: 'saveExtendedSettings', settings: patch });
		};

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsExtCheckbox').forEach((cb) => {
			cb.addEventListener('change', () => {
				const k = cb.dataset.extKey;
				if (!k) return;
				const checked = cb.checked;
				switch (k) {
					case 'terminalLinks.enabled': this.extState.terminalLinksEnabled = checked; break;
					case 'terminalLinks.showDetailsView': this.extState.terminalLinksShowDetails = checked; break;
					case 'graph.followTerminal.enabled': this.extState.followTerminalEnabled = checked; break;
					case 'launchpad.indicator.enabled': this.extState.launchpadEnabled = checked; break;
					case 'launchpad.indicator.useColors': this.extState.launchpadUseColors = checked; break;
					case 'graph.overviewBar.enabled': this.extState.overviewBarEnabled = checked; break;
					case 'graph.scrollMarkers.enabled': this.extState.scrollMarkersEnabled = checked; break;
					case 'graph.showGhostRefsOnRowHover': this.extState.showGhostRefs = checked; break;
					case 'views.scm.grouped.enabled': this.extState.scmGroupedEnabled = checked; break;
					case 'blame.currentLine': this.extState.editor.currentLineEnabled = checked; break;
					case 'blame.currentLine.pullRequests.enabled': this.extState.editor.currentLinePullRequests = checked; break;
					case 'blame.currentLine.scrollable': this.extState.editor.currentLineScrollable = checked; break;
					case 'blame.statusBar': this.extState.editor.statusBarEnabled = checked; break;
					case 'blame.statusBar.reduceFlicker': this.extState.editor.statusBarReduceFlicker = checked; break;
					case 'codeLens.enabled': this.extState.editor.codeLensEnabled = checked; break;
					case 'codeLens.recentChange.enabled': this.extState.editor.codeLensRecentChange = checked; break;
					case 'codeLens.authors.enabled': this.extState.editor.codeLensAuthors = checked; break;
					case 'hovers.enabled': this.extState.editor.hoversEnabled = checked; break;
					case 'hovers.autolinks.enabled': this.extState.editor.hoversAutolinks = checked; break;
					case 'fileBlame.compact': this.extState.editor.fileBlameCompact = checked; break;
					case 'fileBlame.heatmap.enabled': this.extState.editor.fileBlameHeatmap = checked; break;
					case 'fileBlame.highlight.enabled': this.extState.editor.fileBlameHighlightSameCommit = checked; break;
					case 'fileHeatmap.fadeLines': this.extState.editor.fileHeatmapFadeLines = checked; break;
					case 'menus.editor.enabled': this.extState.menus.editor = checked; break;
					case 'menus.editorGroup.enabled': this.extState.menus.editorGroup = checked; break;
					case 'menus.explorer.enabled': this.extState.menus.explorer = checked; break;
					case 'menus.scm.enabled': this.extState.menus.scm = checked; break;
					case 'menus.editorTab.enabled': this.extState.menus.editorTab = checked; break;
				}
				saveExt({ [k]: checked });
				this.updateLivePreviews();
			});
		});

		this.contentsElem.querySelectorAll<HTMLElement>('.settingsExtSegmented').forEach((group) => {
			const extKey = group.dataset.extKey;
			if (!extKey) return;
			group.querySelectorAll<HTMLElement>('.settingsSegment').forEach((seg) => {
				seg.addEventListener('click', () => {
					const val = seg.dataset.value!;
					if (extKey === 'graph.multiselect') this.extState.multiselect = <GG.GraphMultiSelectMode>val;
					if (extKey === 'mode.active') this.extState.editor.activeMode = val;
					group.querySelectorAll<HTMLElement>('.settingsSegment').forEach((s) => {
						alterClass(s, CLASS_SELECTED, s === seg);
						s.setAttribute('aria-checked', s === seg ? 'true' : 'false');
					});
					saveExt({ [extKey]: val });
					this.updateLivePreviews();
				});
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsAiTaskModelInput').forEach((inp) => {
			inp.addEventListener('change', () => {
				const task = inp.dataset.aiTask as GG.AiTaskKey | undefined;
				if (!task) return;
				const next: { [K in GG.AiTaskKey]?: GG.AiTaskModelOverride } = Object.assign({}, this.ai.taskModels || {});
				const val = inp.value.trim();
				if (val === '') {
					delete next[task];
				} else {
					next[task] = { model: val };
				}
				this.ai = Object.assign({}, this.ai, { taskModels: next });
				saveExt({ 'ai.taskModels': next });
			});
		});

		const excludeInput = <HTMLInputElement | null>document.getElementById('settingsAiExcludeFiles');
		if (excludeInput !== null) {
			excludeInput.addEventListener('change', () => {
				const list = excludeInput.value.split(',').map((s) => s.trim()).filter(Boolean);
				saveExt({ 'ai.exclude.files': list });
			});
		}
		const warnInput = <HTMLInputElement | null>document.getElementById('settingsAiTokenWarn');
		if (warnInput !== null) {
			warnInput.addEventListener('change', () => {
				const v = parseInt(warnInput.value, 10);
				if (!isNaN(v) && v >= 500) saveExt({ 'ai.largePromptWarningThreshold': v });
			});
		}
		const autoRebaseThresh = <HTMLInputElement | null>document.getElementById('settingsAiAutoRebaseThreshold');
		if (autoRebaseThresh !== null) {
			autoRebaseThresh.addEventListener('change', () => {
				const v = parseFloat(autoRebaseThresh.value);
				if (!isNaN(v) && v >= 0.1 && v <= 1) saveExt({ 'ai.autoRebase.confidenceThreshold': v });
			});
		}

		const addAutolinkBtn = document.getElementById('settingsAddAutolinkBtn');
		if (addAutolinkBtn !== null) {
			addAutolinkBtn.addEventListener('click', () => {
				const prefixEl = <HTMLInputElement | null>document.getElementById('settingsNewAutolinkPrefix');
				const urlEl = <HTMLInputElement | null>document.getElementById('settingsNewAutolinkUrl');
				if (prefixEl === null || urlEl === null) return;
				const prefix = prefixEl.value.trim(), url = urlEl.value.trim();
				if (prefix === '' || !url.includes('<num>')) return;
				this.extState.autolinks.push({ prefix: prefix, url: url });
				saveExt({ autolinks: this.extState.autolinks });
				this.render();
			});
		}
		this.contentsElem.querySelectorAll<HTMLElement>('.settingsRemoveAutolinkBtn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const idx = parseInt(btn.dataset.ruleIdx || '-1', 10);
				if (idx >= 0 && idx < this.extState.autolinks.length) {
					this.extState.autolinks.splice(idx, 1);
					saveExt({ autolinks: this.extState.autolinks });
					this.render();
				}
			});
		});

		const startWorkFmt = <HTMLInputElement | null>document.getElementById('settingsStartWorkFormat');
		if (startWorkFmt !== null) {
			startWorkFmt.addEventListener('input', () => {
				this.extState.startWorkBranchFormat = startWorkFmt.value || '${id}-${title}';
				this.updateLivePreviews();
			});
			startWorkFmt.addEventListener('change', () => {
				this.extState.startWorkBranchFormat = startWorkFmt.value || '${id}-${title}';
				saveExt({ 'startWork.branchNameFormat': this.extState.startWorkBranchFormat });
			});
		}

		const openLaunchpadBtn = document.getElementById('settingsOpenLaunchpadBtn');
		if (openLaunchpadBtn !== null) {
			openLaunchpadBtn.addEventListener('click', () => {
				sendMessage({ command: 'openCompanionFeature', feature: 'openLaunchpad' });
			});
		}

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsMarkerTypeCheckbox').forEach((cb) => {
			cb.addEventListener('change', () => {
				const mt = cb.dataset.markerType as GG.GraphMarkerType | undefined;
				if (!mt) return;
				const set = new Set<GG.GraphMarkerType>(this.extState.scrollMarkersTypes);
				if (cb.checked) set.add(mt);
				else set.delete(mt);
				this.extState.scrollMarkersTypes = Array.from(set);
				saveExt({ 'graph.scrollMarkers.types': this.extState.scrollMarkersTypes });
			});
		});

		const maxRefsSel = <HTMLSelectElement | null>document.getElementById('settingsMaxVisibleRefs');
		if (maxRefsSel !== null) {
			maxRefsSel.addEventListener('change', () => {
				const v = parseInt(maxRefsSel.value, 10) || 0;
				this.extState.maxVisibleRefsPerCommit = v;
				saveExt({ 'graph.maxVisibleRefsPerCommit': v });
			});
		}

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsShortcutOverrideInput').forEach((inp) => {
			inp.addEventListener('change', () => {
				const act = inp.dataset.shortcutAct;
				if (!act) return;
				const next = Object.assign({}, this.extState.shortcutOverrides);
				const val = inp.value.trim().toLowerCase();
				if (val === '') delete next[act];
				else next[act] = val[0];
				this.extState.shortcutOverrides = next;
				saveExt({ 'graph.shortcuts.overrides': next });
			});
		});

		const openShortcutsHelpBtn = document.getElementById('settingsOpenShortcutsHelp');
		if (openShortcutsHelpBtn !== null) {
			openShortcutsHelpBtn.addEventListener('click', () => {
				this.close();
				this.view.openShortcutsModal();
			});
		}

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsScmVisCheckbox').forEach((cb) => {
			cb.addEventListener('change', () => {
				const sec = cb.dataset.scmSec;
				if (!sec) return;
				const hidden = new Set(this.extState.scmHiddenSections);
				if (cb.checked) hidden.delete(sec);
				else hidden.add(sec);
				this.extState.scmHiddenSections = Array.from(hidden);
				saveExt({
					'views.scm.grouped.hiddenSections': this.extState.scmHiddenSections,
					'views.scm.hiddenSections': this.extState.scmHiddenSections
				});
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsScmDefaultRadio').forEach((rad) => {
			rad.addEventListener('change', () => {
				if (!rad.checked) return;
				this.extState.scmDefaultSection = rad.value;
				saveExt({ 'views.scm.grouped.defaultSection': rad.value });
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsScmFormatInput').forEach((inp) => {
			const syncFmtPreview = () => {
				const prop = inp.dataset.fmtProp as keyof SettingsWidget['extState']['scmFormats'] | undefined;
				if (!prop) return;
				this.extState.scmFormats[prop] = inp.value;
				const exEl = this.contentsElem.querySelector<HTMLElement>('[data-fmt-example="' + prop + '"]');
				if (exEl !== null) exEl.textContent = t('Example: {0}', this.formatSampleTemplate(inp.value));
			};
			inp.addEventListener('input', syncFmtPreview);
			inp.addEventListener('change', () => {
				syncFmtPreview();
				const settingKey = inp.dataset.fmtKey;
				if (settingKey) saveExt({ [settingKey]: inp.value });
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsAiInstructionInput').forEach((inp) => {
			inp.addEventListener('change', () => {
				const taskKey = inp.dataset.aiInstrTask as keyof GG.AiCustomInstructionsConfig | undefined;
				if (!taskKey) return;
				const next: GG.Writeable<Partial<GG.AiCustomInstructionsConfig>> = Object.assign({}, this.ai.customInstructions || {});
				const val = inp.value.trim();
				if (val === '') delete next[taskKey];
				else next[taskKey] = val;
				this.ai = Object.assign({}, this.ai, { customInstructions: <GG.AiCustomInstructionsConfig>next });
				saveExt({ 'ai.customInstructions': next });
			});
		});

		this.contentsElem.querySelectorAll<HTMLInputElement>('.settingsDefaultAgentRadio').forEach((rad) => {
			rad.addEventListener('change', () => {
				if (!rad.checked) return;
				this.extState.defaultAgent = rad.value;
				saveExt({ 'agents.default': rad.value });
			});
		});

		this.contentsElem.querySelectorAll<HTMLElement>('.settingsAgentMcpBtn').forEach((btn) => {
			btn.addEventListener('click', () => {
				if (this.currentRepo === null) return;
				const agentId = btn.dataset.agentId as GG.CodingAgentId | undefined;
				if (!agentId) return;
				const enable = btn.dataset.mcpOn !== '1';
				sendMessage({ command: 'toggleCodingAgentMcp', repo: this.currentRepo, agentId: agentId, enable: enable });
			});
		});

		this.contentsElem.querySelectorAll<HTMLElement>('.settingsAgentHookBtn').forEach((btn) => {
			btn.addEventListener('click', () => {
				if (this.currentRepo === null) return;
				const agentId = btn.dataset.agentId as GG.CodingAgentId | undefined;
				if (!agentId) return;
				const enable = btn.dataset.hookOn !== '1';
				sendMessage({ command: 'toggleCodingAgentHooks', repo: this.currentRepo, agentId: agentId, enable: enable });
			});
		});

		const addCrBtn = document.getElementById('settingsAddCustomRemoteBtn');
		if (addCrBtn !== null) {
			addCrBtn.addEventListener('click', () => {
				const tpEl = <HTMLSelectElement | null>document.getElementById('settingsNewCustomRemoteType');
				const dmEl = <HTMLInputElement | null>document.getElementById('settingsNewCustomRemoteDomain');
				if (tpEl === null || dmEl === null) return;
				const domain = dmEl.value.trim();
				if (domain === '') return;
				this.extState.customRemotes.push({
					type: <GG.CustomRemoteConfig['type']>tpEl.value,
					domain: domain
				});
				saveExt({ remotes: this.extState.customRemotes });
				this.render();
			});
		}
		this.contentsElem.querySelectorAll<HTMLElement>('.settingsRemoveCustomRemoteBtn').forEach((btn) => {
			btn.addEventListener('click', () => {
				const idx = parseInt(btn.dataset.crIdx || '-1', 10);
				if (idx >= 0 && idx < this.extState.customRemotes.length) {
					this.extState.customRemotes.splice(idx, 1);
					saveExt({ remotes: this.extState.customRemotes });
					this.render();
				}
			});
		});

		const inlineBlameFmt = <HTMLInputElement | null>document.getElementById('settingsBlameInlineFormat');
		if (inlineBlameFmt !== null) {
			inlineBlameFmt.addEventListener('input', () => {
				this.extState.editor.currentLineFormat = inlineBlameFmt.value;
				this.updateLivePreviews();
			});
			inlineBlameFmt.addEventListener('change', () => {
				this.extState.editor.currentLineFormat = inlineBlameFmt.value;
				saveExt({ 'blame.currentLine.format': inlineBlameFmt.value });
			});
		}
		const uncommBlameFmt = <HTMLInputElement | null>document.getElementById('settingsBlameUncommittedFormat');
		if (uncommBlameFmt !== null) {
			uncommBlameFmt.addEventListener('change', () => {
				this.extState.editor.currentLineUncommittedFormat = uncommBlameFmt.value;
				saveExt({ 'blame.currentLine.uncommittedFormat': uncommBlameFmt.value });
			});
		}
		const sbBlameFmt = <HTMLInputElement | null>document.getElementById('settingsBlameStatusBarFormat');
		if (sbBlameFmt !== null) {
			sbBlameFmt.addEventListener('input', () => {
				this.extState.editor.statusBarFormat = sbBlameFmt.value;
				this.updateLivePreviews();
			});
			sbBlameFmt.addEventListener('change', () => {
				this.extState.editor.statusBarFormat = sbBlameFmt.value;
				saveExt({ 'blame.statusBar.format': sbBlameFmt.value });
			});
		}

		const healthBtn = document.getElementById('settingsCheckRepoHealthBtn');
		if (healthBtn !== null) {
			healthBtn.addEventListener('click', () => {
				sendMessage({ command: 'openCompanionFeature', feature: 'checkRepoHealth', repo: this.currentRepo || undefined });
			});
		}
		const sshSignersBtn = document.getElementById('settingsEditSshSignersBtn');
		if (sshSignersBtn !== null) {
			sshSignersBtn.addEventListener('click', () => {
				sendMessage({ command: 'openCompanionFeature', feature: 'editSshAllowedSigners', repo: this.currentRepo || undefined });
			});
		}
	}

	private updateLivePreviews() {
		const gp = document.getElementById('settingsGraphLivePreview');
		if (gp !== null) {
			const presetColours = (this.appearance.colourPresets.find((p) => p.name === this.appearance.colourPreset) || { colours: initialState.config.graph.colours }).colours;
			gp.innerHTML = this.renderGraphPreviewHtml(
				presetColours,
				initialState.config.graph.density === GG.GraphDensity.Compact ? 'Compact' : 'Comfortable',
				initialState.config.graph.nodeStyle === GG.GraphNodeStyle.Avatar ? 'Avatar' : 'Dot',
				this.extState.showGhostRefs
			);
		}
		const ep = document.getElementById('settingsEditorLivePreview');
		if (ep !== null) ep.innerHTML = this.renderEditorPreviewHtml(this.extState.editor);
		const ap = document.getElementById('settingsAutolinkLivePreview');
		if (ap !== null) ap.innerHTML = this.renderAutolinkPreviewHtml(this.extState.autolinks, this.extState.startWorkBranchFormat);
	}

	private renderGraphPreviewHtml(colours: ReadonlyArray<string>, density: string, nodeStyle: string, ghostRefs: boolean) {
		const c0 = colours[0] || '#3b82f6', c1 = colours[1 % colours.length] || '#10b981';
		const rowCls = 'settingsGraphPreviewRow' + (density === 'Compact' ? ' compact' : '');
		const node = (c: string, init: string) => nodeStyle === 'Avatar'
			? '<span class="settingsGraphNodeAvatar" style="background:' + escapeHtml(c) + '">' + init + '</span>'
			: '<span class="settingsGraphNodeDot" style="background:' + escapeHtml(c) + '"></span>';
		return '<div class="settingsLivePreviewHeader"><span>' + t('Live Preview: Commit Graph') + '</span><span>' + escapeHtml(density + ' · ' + nodeStyle) + '</span></div>' +
			'<div class="settingsGraphPreviewRows">' +
			'<div class="' + rowCls + '">' + node(c0, 'A') + '<span class="gitRef head">main</span><span>feat: integrate terminal &amp; editor suite</span>' + (ghostRefs ? '<span class="ghostRefBtn">+ Branch</span>' : '') + '</div>' +
			'<div class="' + rowCls + '">' + node(c1, 'B') + '<span>fix: preserve topological multiselect</span>' + (ghostRefs ? '<span class="ghostRefBtn">+ Tag</span>' : '') + '</div>' +
			'</div>';
	}

	private renderScmFormatFieldHtml(prop: keyof SettingsWidget['extState']['scmFormats'], settingKey: string, label: string, value: string) {
		return '<div class="settingsFormatField"><label class="settingsKey">' + escapeHtml(label) + '</label>' +
			'<input type="text" class="settingsInput mono settingsScmFormatInput" data-fmt-prop="' + prop + '" data-fmt-key="' + escapeHtml(settingKey) + '" value="' + escapeHtml(value) + '" spellcheck="false">' +
			'<div class="settingsFormatExample" data-fmt-example="' + prop + '">' + escapeHtml(t('Example: {0}', this.formatSampleTemplate(value))) + '</div></div>';
	}

	private formatSampleTemplate(template: string, includePr: boolean = true): string {
		const sampleVars: { [k: string]: string } = {
			author: 'You',
			ago: '2h ago',
			agoOrDate: '2h ago',
			date: '2026-11-26',
			message: 'feat: optimize parser',
			pullRequest: includePr ? 'PR #42' : '',
			id: 'fe26af4',
			sha: 'fe26af4',
			stashOnRef: 'main',
			file: 'supercharge.ts',
			directory: 'src/core',
			working: '',
			originalPath: ''
		};
		return template
			.replace(/\$\{'([^']*)'([a-zA-Z0-9_]+)\}/g, (_, prefix: string, key: string) => sampleVars[key] ? prefix + sampleVars[key] : '')
			.replace(/\$\{([^|{}]+)\|([a-zA-Z0-9_]+)(?:\|[^}]*)?\}/g, (_, prefix: string, key: string) => sampleVars[key] ? prefix + sampleVars[key] : '')
			.replace(/\$\{([a-zA-Z0-9_]+)(?:\|[0-9]+\?)?\}/g, (_, key: string) => sampleVars[key] || '')
			.replace(/\$\{([a-zA-Z0-9_]+)([^a-zA-Z0-9_|{}]+)\}/g, (_, key: string, suffix: string) => sampleVars[key] ? sampleVars[key] + suffix : '')
			.replace(/\$\{[^}]+\}/g, '')
			.trim();
	}

	private renderEditorPreviewHtml(ed: SettingsWidget['extState']['editor']) {
		const blameText = this.formatSampleTemplate(ed.currentLineFormat || '${author, }${agoOrDate}', ed.currentLinePullRequests) || 'You, 2h ago';
		const statusBarText = this.formatSampleTemplate(ed.statusBarFormat || '${author}, ${ago}', ed.currentLinePullRequests) || 'You, 2h ago';
		return '<div class="settingsLivePreviewHeader"><span>supercharge.ts</span><span>' + escapeHtml(t('Mode') + ': ' + ed.activeMode) + '</span></div>' +
			'<div class="settingsEditorPreviewCode">' +
			(ed.codeLensEnabled ? '<div class="settingsEditorCodeLens">' + (ed.codeLensRecentChange ? 'You, 2h ago' : '') + (ed.codeLensRecentChange && ed.codeLensAuthors ? ' | ' : '') + (ed.codeLensAuthors ? '2 authors (You)' : '') + '</div>' : '') +
			'<div class="settingsEditorLine' + (ed.fileBlameHeatmap ? ' hot' : '') + '"><span class="settingsEditorLn">2</span><code>export function supercharge(code: string) {</code></div>' +
			'<div class="settingsEditorLine' + (ed.fileBlameHighlightSameCommit ? ' changed' : '') + '"><span class="settingsEditorLn">3</span><code>&nbsp;&nbsp;return optimize(parse(code));</code>' +
			(ed.currentLineEnabled ? '<span class="settingsEditorInlineBlame">' + escapeHtml(blameText) + '</span>' : '') +
			'</div>' +
			'<div class="settingsEditorLine"><span class="settingsEditorLn">4</span><code>}</code></div>' +
			(ed.statusBarEnabled ? '<div class="settingsEditorStatusBarStrip">&#9673; ' + escapeHtml(statusBarText) + '</div>' : '') +
			'</div>';
	}

	private renderAutolinkPreviewHtml(rules: ReadonlyArray<GG.AutolinkRule>, branchFmt: string) {
		const sampleBranch = branchFmt.replace(/\$\{id\}/gi, 'PROJ-42').replace(/\$\{title\}/gi, 'fix-login-flow');
		const sampleRule = rules.length > 0 ? rules[0] : { prefix: 'PROJ-', url: 'https://tracker.example.com/browse/PROJ-<num>' };
		return '<div class="settingsLivePreviewHeader"><span>' + t('Live Preview: Autolinks & Start Work') + '</span><span class="mono">' + escapeHtml(sampleBranch) + '</span></div>' +
			'<div class="settingsEditorPreviewCode"><span class="mono">' + escapeHtml(sampleRule.prefix + '42') + '</span> &rarr; <span class="cdvMuted">' + escapeHtml(sampleRule.url.replace(/<num>/g, '42')) + '</span></div>';
	}


	/* Private Helper Methods */

	/**
	 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
	 * @param config The issue linking configuration to save.
	 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
	 */
	private setIssueLinkingConfig(config: GG.IssueLinkingConfig | null, global: boolean) {
		if (this.currentRepo === null || this.repo === null) return;

		if (global) {
			if (this.repo.issueLinkingConfig !== null) {
				this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
			}
			updateGlobalViewState('issueLinkingConfig', config);
		} else {
			this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
		}

		this.view.refresh(true);
		this.render();
	}

	/**
	 * Save the pull request configuration for this repository.
	 * @param config The pull request configuration to save.
	 */
	private setPullRequestConfig(config: GG.PullRequestConfig | null) {
		if (this.currentRepo === null) return;
		this.view.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
		this.render();
	}

	/**
	 * Show the dialog allowing the user to configure the issue linking for this repository.
	 * @param defaultIssueRegex The default regular expression used to match issue numbers.
	 * @param defaultIssueUrl The default URL for the issue number to be substituted into.
	 * @param defaultUseGlobally The default value for the checkbox determining whether the issue linking configuration should be used globally (for all repositories).
	 * @param isEdit Is the dialog editing an existing issue linking configuration.
	 */
	private showIssueLinkingDialog(defaultIssueRegex: string | null, defaultIssueUrl: string | null, defaultUseGlobally: boolean, isEdit: boolean) {
		let html = t('<b>{0} this Repository</b>', (isEdit ? t('Edit Issue Linking for') : t('Add Issue Linking to')));
		html += '<p style="font-size:12px; margin:6px 0;">' + t('The following example links {0} in commit messages to {1}:', '<b>#123</b>', '<b>https://github.com/owner/repo/issues/123</b>') + '</p>';
		html += '<table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>' + t('Issue Regex:') + '</td><td>#(\\d+)</td></tr><tr><td>' + t('Issue URL:') + '</td><td>https://github.com/owner/repo/issues/$1</td></tr></tbody></table>';

		if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
			defaultIssueRegex = SettingsWidget.autoDetectIssueRegex(this.view.getCommits());
			if (defaultIssueRegex !== null) {
				defaultIssueUrl = this.config !== null ? SettingsWidget.autoDetectIssueUrl(defaultIssueRegex, this.config.remotes) : null;
				html += '<p style="font-size:12px"><i>' + (defaultIssueUrl !== null ? t('The prefilled Issue Regex and Issue URL were detected from the commit messages and remote in this repository. Review and/or correct them if necessary.') : t('The prefilled Issue Regex was detected in commit messages in this repository. Review and/or correct it if necessary.')) + '</i></p>';
			}
		}

		dialog.showForm(html, [
			{ type: DialogInputType.Text, name: t('Issue Regex'), default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: t('A regular expression that matches your issue numbers, with one or more capturing groups ( ) that will be substituted into the "Issue URL".') },
			{ type: DialogInputType.Text, name: t('Issue URL'), default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: t('The issue\'s URL in your issue tracking system, with placeholders ($1, $2, etc.) for the groups captured ( ) in the "Issue Regex".') },
			{ type: DialogInputType.Checkbox, name: t('Use Globally'), value: defaultUseGlobally, info: t('Use the "Issue Regex" and "Issue URL" for all repositories by default (it can be overridden per repository). Note: "Use Globally" is only suitable if identical Issue Linking applies to the majority of your repositories (e.g. when using JIRA or Pivotal Tracker).') }
		], t('Save'), (values) => {
			let issueRegex = (<string>values[0]).trim(), issueUrl = (<string>values[1]).trim(), useGlobally = <boolean>values[2];
			let regExpParseError = null;
			try {
				if (issueRegex.indexOf('(') === -1 || issueRegex.indexOf(')') === -1) {
					regExpParseError = t('The regular expression does not contain a capturing group ( ).');
				} else if (new RegExp(issueRegex, 'gu')) {
					regExpParseError = null;
				}
			} catch (e) {
				regExpParseError = e instanceof Error ? e.message : String(e);
			}
			if (regExpParseError !== null) {
				dialog.showError(t('Invalid Issue Regex'), regExpParseError, t('Go Back'), () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
				dialog.showError(t('Invalid Issue URL'), t('The Issue URL does not contain any placeholders ($1, $2, etc.) for the issue number components captured in the Issue Regex.'), t('Go Back'), () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else {
				this.setIssueLinkingConfig({ issue: issueRegex, url: issueUrl }, useGlobally);
			}
		}, null, t('Cancel'), null);
	}

	/**
	 * Show the first dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog1(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
		let upstreamIndex = this.config.remotes.findIndex((remote) => remote.name === 'upstream');
		let sourceRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.sourceRemote);
		let destRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.destRemote);

		if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
			sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
		}
		if (config.destRemote === '') {
			destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
		}

		let defaultProvider = config.provider.toString();
		let providerOptions = [
			{ name: t('Bitbucket'), value: (GG.PullRequestProvider.Bitbucket).toString() },
			{ name: t('GitHub'), value: (GG.PullRequestProvider.GitHub).toString() },
			{ name: t('GitLab'), value: (GG.PullRequestProvider.GitLab).toString() }
		];
		let providerTemplateLookup: { [name: string]: string } = {};
		initialState.config.customPullRequestProviders.forEach((provider) => {
			providerOptions.push({ name: provider.name, value: (providerOptions.length + 1).toString() });
			providerTemplateLookup[provider.name] = provider.templateUrl;
		});
		if (config.provider === GG.PullRequestProvider.Custom) {
			if (!providerOptions.some((provider) => provider.name === config.custom.name)) {
				// The existing custom Pull Request provider no longer exists, so add it.
				providerOptions.push({ name: config.custom.name, value: (providerOptions.length + 1).toString() });
				providerTemplateLookup[config.custom.name] = config.custom.templateUrl;
			}
			defaultProvider = providerOptions.find((provider) => provider.name === config.custom.name)!.value;
		}
		providerOptions.sort((a, b) => a.name.localeCompare(b.name));

		let sourceRemoteOptions = this.config.remotes.map((remote, index) => ({ name: remote.name, value: index.toString() }));
		let destRemoteOptions = sourceRemoteOptions.map((option) => option);
		destRemoteOptions.push({ name: t('Not a remote'), value: '-1' });

		dialog.showForm(t('Configure "Pull Request Creation" Integration (Step&nbsp;1/2)'), [
			{
				type: DialogInputType.Select, name: t('Provider'),
				options: providerOptions, default: defaultProvider,
				info: t('In addition to the built-in publicly hosted Pull Request providers, custom providers can be configured using the Extension Setting "git-map.customPullRequestProviders" (e.g. for use with privately hosted Pull Request providers).')
			},
			{
				type: DialogInputType.Select, name: t('Source Remote'),
				options: sourceRemoteOptions, default: sourceRemoteIndex.toString(),
				info: t('The remote that corresponds to the source of the Pull Request.')
			},
			{
				type: DialogInputType.Select, name: t('Destination Remote'),
				options: destRemoteOptions, default: destRemoteIndex.toString(),
				info: t('The remote that corresponds to the destination / target of the Pull Request.')
			}
		], t('Next'), (values) => {
			if (this.config === null) return;

			let newProvider = <GG.PullRequestProvider>parseInt(<string>values[0]);
			if (newProvider > 3) newProvider = GG.PullRequestProvider.Custom;

			const newSourceRemoteIndex = parseInt(<string>values[1]);
			const newDestRemoteIndex = parseInt(<string>values[2]);
			const newSourceRemote = this.config.remotes[newSourceRemoteIndex].name;
			const newDestRemote = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].name : null;
			const newSourceUrl = this.config.remotes[newSourceRemoteIndex].url;
			const newDestUrl = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].url : null;

			if (config.hostRootUrl === '' || config.provider !== newProvider) {
				const remoteUrlForHost = newSourceUrl !== null ? newSourceUrl : newDestUrl;
				if (remoteUrlForHost !== null) {
					const match = remoteUrlForHost.match(/^(https?:\/\/|git@)((?=[^/]+@)[^@]+@|(?![^/]+@))([^/:]+)/);
					config.hostRootUrl = match !== null ? 'https://' + match[3] : '';
				} else {
					config.hostRootUrl = '';
				}
			}

			if (newProvider === GG.PullRequestProvider.Custom) {
				const customProviderName = providerOptions.find((provider) => provider.value === <string>values[0])!.name;
				config.custom = { name: customProviderName, templateUrl: providerTemplateLookup[customProviderName] };
			} else {
				config.custom = null;
			}
			config.provider = newProvider;

			if (config.sourceRemote !== newSourceRemote) {
				config.sourceRemote = newSourceRemote;
				const match = newSourceUrl !== null ? newSourceUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
				config.sourceOwner = match !== null ? match[2] : '';
				config.sourceRepo = match !== null ? match[3] : '';
			}

			if (config.provider !== GG.PullRequestProvider.GitLab || config.destRemote !== newDestRemote) {
				config.destProjectId = '';
			}

			if (config.destRemote !== newDestRemote) {
				config.destRemote = newDestRemote;
				if (newDestRemote !== null) {
					const match = newDestUrl !== null ? newDestUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
					config.destOwner = match !== null ? match[2] : '';
					config.destRepo = match !== null ? match[3] : '';
					const branches = this.view.getBranches()
						.filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
						.map((branch) => branch.substring(newDestRemote.length + 9));
					config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
				} else {
					config.destOwner = '';
					config.destRepo = '';
					config.destBranch = '';
				}
			}

			this.showCreatePullRequestIntegrationDialog2(config);
		}, { type: TargetType.Repo });
	}

	/**
	 * Show the second dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog2(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		const destBranches = config.destRemote !== null
			? this.view.getBranches()
				.filter((branch) => branch.startsWith('remotes/' + config.destRemote + '/') && branch !== ('remotes/' + config.destRemote + '/HEAD'))
				.map((branch) => branch.substring(config.destRemote!.length + 9))
			: [];
		const destBranchInfo = t('The name of the branch that is the destination / target of the Pull Request.');

		const updateConfigWithFormValues = (values: DialogInputValue[]) => {
			const hostRootUri = <string>values[0];
			config.hostRootUrl = hostRootUri.endsWith('/') ? hostRootUri.substring(0, hostRootUri.length - 1) : hostRootUri;
			config.sourceOwner = <string>values[1];
			config.sourceRepo = <string>values[2];
			config.destOwner = <string>values[3];
			config.destRepo = <string>values[4];
			config.destProjectId = config.provider === GG.PullRequestProvider.GitLab ? <string>values[5] : '';
			const destBranch = <string>values[config.provider === GG.PullRequestProvider.GitLab ? 6 : 5];
			config.destBranch = config.destRemote === null || destBranches.length === 0
				? destBranch
				: destBranches[parseInt(destBranch)];
		};

		const inputs: DialogInput[] = [
			{ type: DialogInputType.Text, name: t('Host Root URL'), default: config.hostRootUrl, placeholder: null, info: t('The Pull Request provider\'s Host Root URL (e.g. https://github.com).') },
			{ type: DialogInputType.Text, name: t('Source Owner'), default: config.sourceOwner, placeholder: null, info: t('The owner of the repository that is the source of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Source Repo'), default: config.sourceRepo, placeholder: null, info: t('The name of the repository that is the source of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Destination Owner'), default: config.destOwner, placeholder: null, info: t('The owner of the repository that is the destination / target of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Destination Repo'), default: config.destRepo, placeholder: null, info: t('The name of the repository that is the destination / target of the Pull Request.') }
		];
		if (config.provider === GG.PullRequestProvider.GitLab) {
			inputs.push({ type: DialogInputType.Text, name: t('Destination Project ID'), default: config.destProjectId, placeholder: null, info: t('The GitLab Project ID of the destination / target of the Pull Request. Leave this field blank to use the default destination / target configured in GitLab.') });
		}
		inputs.push(config.destRemote === null || destBranches.length === 0
			? { type: DialogInputType.Text, name: t('Destination Branch'), default: config.destBranch, placeholder: null, info: destBranchInfo }
			: {
				type: DialogInputType.Select,
				name: t('Destination Branch'),
				options: destBranches.map((branch, index) => ({ name: branch, value: index.toString() })),
				default: destBranches.includes(config.destBranch) ? destBranches.indexOf(config.destBranch).toString() : '0',
				info: destBranchInfo
			}
		);

		dialog.showForm(t('Configure "Pull Request Creation" Integration (Step&nbsp;2/2)'), inputs, t('Save Configuration'), (values) => {
			updateConfigWithFormValues(values);
			this.setPullRequestConfig(config);
		}, { type: TargetType.Repo }, t('Back'), (values) => {
			updateConfigWithFormValues(values);
			this.showCreatePullRequestIntegrationDialog1(config);
		});
	}

	/**
	 * Get the remote details corresponding to a mouse event.
	 * @param e The mouse event.
	 * @returns The details of the remote.
	 */
	private getRemoteForBtnEvent(e: Event) {
		return this.config !== null
			? this.config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
			: null;
	}

	/**
	 * Automatically detect common issue number formats in the specified commits, returning the most common.
	 * @param commits The commits to analyse.
	 * @returns The regular expression of the most likely issue number format.
	 */
	private static autoDetectIssueRegex(commits: ReadonlyArray<GG.GitCommit>) {
		const patterns = ['#(\\d+)', '^(\\d+)\\.(?=\\s|$)', '^(\\d+):(?=\\s|$)', '([A-Za-z]+-\\d+)'].map((pattern) => {
			const regexp = new RegExp(pattern);
			return {
				pattern: pattern,
				matches: commits.filter((commit) => regexp.test(commit.message)).length
			};
		}).sort((a, b) => b.matches - a.matches);

		if (patterns[0].matches > 0.1 * commits.length) {
			// If the most common pattern was matched in more than 10% of commits, return the pattern
			return patterns[0].pattern;
		}
		return null;
	}

	/**
	 * Automatically detect the Issue URL for "#123" style issue references, if the repository's remote is hosted on GitHub, GitLab or Bitbucket.
	 * @param issueRegex The Issue Regex being used.
	 * @param remotes The remotes of the repository.
	 * @returns The Issue URL, or NULL if it couldn't be detected.
	 */
	private renderNavRail() {
		const sections = Array.from(this.contentsElem.querySelectorAll<HTMLElement>('.settingsSection'));
		const groups: { id: string, title: string, items: { idx: number, label: string, enabled: number | null, total: number | null }[] }[] = [
			{ id: 'integrations', title: t('Integrations'), items: [] },
			{ id: 'views', title: t('Views'), items: [] },
			{ id: 'editor', title: t('Editor'), items: [] },
			{ id: 'general', title: t('General'), items: [] }
		];
		sections.forEach((sec, idx) => {
			const groupId = sec.dataset.navGroup || 'general';
			const h3 = sec.querySelector('h3');
			const label = sec.dataset.navLabel || (h3 ? (h3.textContent || '').trim() : ('Section ' + (idx + 1)));
			const enabled = typeof sec.dataset.navEnabled === 'string' ? parseInt(sec.dataset.navEnabled, 10) : null;
			const total = typeof sec.dataset.navTotal === 'string' ? parseInt(sec.dataset.navTotal, 10) : null;
			const bucket = groups.find((g) => g.id === groupId) || groups[3];
			bucket.items.push({ idx: idx, label: label, enabled: enabled, total: total });
		});
		this.navRailElem.innerHTML = groups.filter((g) => g.items.length > 0).map((g) =>
			'<div class="settingsNavGroup">' + escapeHtml(g.title) + '</div>' +
			g.items.map((item) => {
				const hasRatio = item.enabled !== null && item.total !== null && item.total > 0;
				const dotClass = 'settingsNavDot' + (item.enabled !== null && item.enabled > 0 ? ' on' : '');
				return '<button type="button" class="settingsNavItem' + (item.idx === this.activeSectionIndex ? ' active' : '') + '" data-settings-nav="' + item.idx + '" title="' + escapeHtml(item.label) + '">' +
					'<span class="settingsNavItemLabel"><span class="' + dotClass + '"></span><span>' + escapeHtml(item.label) + '</span></span>' +
					(hasRatio ? '<span class="settingsNavRatio">' + item.enabled + '/' + item.total + '</span>' : '') +
					'</button>';
			}).join('')
		).join('');
	}

	private updateNavRailHighlight() {
		this.navRailElem.querySelectorAll<HTMLElement>('.settingsNavItem').forEach((item) => {
			alterClass(item, CLASS_ACTIVE, parseInt(item.dataset.settingsNav!, 10) === this.activeSectionIndex);
		});
	}

	private syncActiveNavCategory() {
		const sections = Array.from(this.contentsElem.querySelectorAll<HTMLElement>('.settingsSection'));
		if (sections.length === 0) return;
		const scrollTop = this.contentsElem.scrollTop + 40;
		let bestIdx = 0;
		for (let i = 0; i < sections.length; i++) {
			if (sections[i].style.display === 'none') continue;
			if (sections[i].offsetTop <= scrollTop) bestIdx = i;
		}
		if (bestIdx !== this.activeSectionIndex) {
			this.activeSectionIndex = bestIdx;
			this.updateNavRailHighlight();
		}
	}

	private applySearchFilter() {
		const q = this.searchQuery.trim().toLowerCase();
		const existingEmpty = this.contentsElem.querySelector('.settingsEmptySearch');
		if (existingEmpty !== null) existingEmpty.remove();

		const sections = Array.from(this.contentsElem.querySelectorAll<HTMLElement>('.settingsSection'));
		let visibleCount = 0;
		sections.forEach((sec) => {
			if (q === '') {
				sec.style.display = '';
				sec.querySelectorAll<HTMLElement>('.settingsCard, .settingsRow').forEach((el) => { el.style.display = ''; });
				visibleCount++;
				return;
			}
			const secText = (sec.querySelector('h3')?.textContent || '').toLowerCase();
			if (secText.includes(q)) {
				sec.style.display = '';
				sec.querySelectorAll<HTMLElement>('.settingsCard, .settingsRow').forEach((el) => { el.style.display = ''; });
				visibleCount++;
				return;
			}
			const cards = Array.from(sec.querySelectorAll<HTMLElement>(':scope > .settingsCard, :scope > .settingsRow'));
			if (cards.length === 0) {
				const match = (sec.textContent || '').toLowerCase().includes(q);
				sec.style.display = match ? '' : 'none';
				if (match) visibleCount++;
				return;
			}
			let sectionHasMatch = false;
			cards.forEach((card) => {
				const match = (card.textContent || '').toLowerCase().includes(q);
				card.style.display = match ? '' : 'none';
				if (match) sectionHasMatch = true;
			});
			sec.style.display = sectionHasMatch ? '' : 'none';
			if (sectionHasMatch) visibleCount++;
		});
		if (q !== '' && visibleCount === 0) {
			const empty = document.createElement('div');
			empty.className = 'settingsEmptySearch';
			empty.textContent = t('No settings match "{0}".', this.searchQuery.trim());
			this.contentsElem.appendChild(empty);
		}
	}

	private static autoDetectIssueUrl(issueRegex: string, remotes: ReadonlyArray<{ readonly name: string, readonly url: string | null }>) {
		if (issueRegex !== '#(\\d+)' || remotes.length === 0) return null;

		const originIndex = remotes.findIndex((remote) => remote.name === 'origin');
		const remoteUrl = remotes[originIndex > -1 ? originIndex : 0].url;
		const match = remoteUrl !== null ? remoteUrl.match(/^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/) : null;
		if (match === null) return null;

		const host = match[1], path = match[2];
		if (host.includes('github')) {
			return 'https://' + host + '/' + path + '/issues/$1';
		} else if (host.includes('gitlab')) {
			return 'https://' + host + '/' + path + '/-/issues/$1';
		} else if (host.includes('bitbucket')) {
			return 'https://' + host + '/' + path + '/issues/$1';
		}
		return null;
	}
}
