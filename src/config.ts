import { AI_PROVIDER_VALUES, AiProvider, getAiSettingsSnapshot } from './aiProviders';
import * as vscode from 'vscode';
import {
	AiCustomInstructionsConfig,
	AiSettingsConfig,
	AiTaskKey,
	AiTaskModelOverride,
	AiTaskModelsConfig,
	AnnotationLocation,
	AnnotationToggleMode,
	AppearanceConfig,
	AutolinkRule,
	CommitDetailsViewConfig,
	CommitDetailsViewLocation,
	CommitOrdering,
	ContextMenuActionsVisibility,
	CustomBranchGlobPattern,
	CustomEmojiShortcodeMapping,
	CustomPullRequestProvider,
	CustomRemoteConfig,
	DateFormat,
	DateFormatType,
	DateType,
	DefaultColumnVisibility,
	DialogDefaults,
	EditorAnnotationsSnapshot,
	EditorModeId,
	FileViewType,
	GitMapModeConfig,
	GitResetMode,
	GraphConfig,
	GraphDensity,
	GraphMarkerType,
	GraphMultiSelectMode,
	GraphNodeStyle,
	GraphStyle,
	GraphUncommittedChangesStyle,
	KeybindingConfig,
	LaunchpadBucket,
	LaunchpadConfigSnapshot,
	LineHistoryLocation,
	MuteCommitsConfig,
	OnRepoLoadConfig,
	RefLabelAlignment,
	ReferenceLabelsConfig,
	RepoDropdownOrder,
	ScmViewsConfigSnapshot,
	SquashMessageFormat,
	StatusBarItemDisplay,
	TabIconColourTheme,
	TagType,
	TerminalLinksConfigSnapshot
} from './types';

export const GRAPH_COLOUR_PRESETS: { readonly [name: string]: ReadonlyArray<string> } = {
	'Pastel': ['#7aa6da', '#e29cc6', '#8fd19e', '#f2b880', '#b9a3e3', '#f28b82', '#7fd3cc', '#d7a6e0', '#c3e88d', '#f6c177', '#9ccfd8', '#ebbcba'],
	'Vivid': ['#2979ff', '#ff1744', '#00e676', '#ffc400', '#d500f9', '#00e5ff', '#ff9100', '#76ff03', '#f50057', '#651fff', '#1de9b6', '#ffea00'],
	'High Contrast': ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#808000', '#ffe119'],
	'Colour Blind Safe': ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'],
	'Tokyo Subway': ['#f62e36', '#ff9500', '#009bbf', '#00bb85', '#8f76d6', '#c1a470', '#00ac9b', '#9c5e31', '#e85298', '#0079c2', '#6cbb5a', '#b6007a']
};
export const GRAPH_COLOUR_PRESET_NAMES: ReadonlyArray<string> = ['Default', 'Pastel', 'Vivid', 'High Contrast', 'Colour Blind Safe', 'Tokyo Subway'];
export const COMMIT_ACTION_IDS: ReadonlyArray<string> = [
	'checkout', 'createBranch', 'cherrypick', 'addTag', 'createWorktree',
	'revert', 'drop', 'editMessage', 'amendCommit', 'undoCommit', 'fixup',
	'merge', 'rebase', 'reset', 'bisectBad', 'bisectGood', 'bisectSkip',
	'aiReview', 'copyHash', 'copySubject', 'savePatch', 'copyPatch'
];
export const DEFAULT_CDV_COMMIT_ACTIONS: ReadonlyArray<string> = ['checkout', 'createBranch', 'cherrypick'];
export const DEFAULT_ROW_COMMIT_ACTIONS: ReadonlyArray<string> = ['createBranch', 'checkout', 'cherrypick', 'copyHash'];
export const ROW_ACTIONS_POSITIONS: ReadonlyArray<'Pointer' | 'Description' | 'Row'> = ['Pointer', 'Description', 'Row'];

const SETTING_FALLBACK_KEY = 'settingFallbacks';
let fallbackMemento: vscode.Memento | null = null;
const memoryFallbacks: { [key: string]: unknown } = {};

export function setSettingFallbackStorage(memento: vscode.Memento | null) {
	fallbackMemento = memento;
	Object.keys(memoryFallbacks).forEach((k) => delete memoryFallbacks[k]);
}

export function getSettingFallback<T>(key: string): T | undefined {
	if (Object.prototype.hasOwnProperty.call(memoryFallbacks, key)) {
		return <T>memoryFallbacks[key];
	}
	if (fallbackMemento !== null && typeof fallbackMemento.get === 'function') {
		const stored = fallbackMemento.get<{ [k: string]: unknown }>(SETTING_FALLBACK_KEY);
		if (stored && typeof stored === 'object' && Object.prototype.hasOwnProperty.call(stored, key)) {
			return <T>stored[key];
		}
	}
	return undefined;
}

export function saveSettingFallback(key: string, value: unknown): Promise<void> {
	if (typeof value === 'undefined') {
		delete memoryFallbacks[key];
	} else {
		memoryFallbacks[key] = value;
	}
	if (fallbackMemento !== null && typeof fallbackMemento.update === 'function') {
		const current = Object.assign({}, fallbackMemento.get<{ [k: string]: unknown }>(SETTING_FALLBACK_KEY, {}));
		if (typeof value === 'undefined') {
			delete current[key];
		} else {
			current[key] = value;
		}
		return Promise.resolve(fallbackMemento.update(SETTING_FALLBACK_KEY, current)).then(() => { }, () => { });
	}
	return Promise.resolve();
}

const VIEW_COLUMN_MAPPING: { [column: string]: vscode.ViewColumn } = {
	'Active': vscode.ViewColumn.Active,
	'Beside': vscode.ViewColumn.Beside,
	'One': vscode.ViewColumn.One,
	'Two': vscode.ViewColumn.Two,
	'Three': vscode.ViewColumn.Three,
	'Four': vscode.ViewColumn.Four,
	'Five': vscode.ViewColumn.Five,
	'Six': vscode.ViewColumn.Six,
	'Seven': vscode.ViewColumn.Seven,
	'Eight': vscode.ViewColumn.Eight,
	'Nine': vscode.ViewColumn.Nine
};

/**
 * Represents the users configuration of Git Map Extension Settings.
 */
class Config {
	private readonly config: vscode.WorkspaceConfiguration;

	private static readonly KEYBINDING_REGEXP = /^CTRL\/CMD \+ [A-Z]$/;

	/**
	 * Creates a Config instance.
	 * @param repo An option path of a repository (to be used for Workspace Folder Scoped Configuration Values).
	 * @returns A Config instance.
	 */
	constructor(repo?: string) {
		this.config = vscode.workspace.getConfiguration('git-map', repo ? vscode.Uri.file(repo) : undefined);
	}

	/**
	 * Get the Commit Details View configuration from the Extension Settings.
	 */
	get commitDetailsView(): CommitDetailsViewConfig {
		return {
			actions: this.cdvActions,
			autoCenter: !!this.getRenamedExtensionSetting('commitDetailsView.autoCenter', 'autoCenterCommitDetailsView', true),
			fileTreeCompactFolders: !!this.getRenamedExtensionSetting('commitDetailsView.fileView.fileTree.compactFolders', 'commitDetailsViewFileTreeCompactFolders', true),
			fileViewType: this.getRenamedExtensionSetting<string>('commitDetailsView.fileView.type', 'defaultFileViewType', 'File Tree') === 'File List'
				? FileViewType.List
				: FileViewType.Tree,
			hideUnchangedRegions: this.hideUnchangedRegions,
			location: this.getCommitDetailsViewLocation()
		};
	}

	/**
	 * Get the value of the `git-map.commitDetailsView.actions` Extension Setting.
	 */
	get cdvActions(): ReadonlyArray<string> {
		return this.getCommitActionList('commitDetailsView.actions', DEFAULT_CDV_COMMIT_ACTIONS);
	}

	/**
	 * Get the buttons shown on the row of the commit the mouse is over (`git-map.commitRow.actions`)
	 * and where they appear (`git-map.commitRow.actionsPosition`).
	 */
	get rowActions(): { readonly actions: ReadonlyArray<string>, readonly position: 'Pointer' | 'Description' | 'Row' } {
		const fallbackPos = getSettingFallback<string>('commitRow.actionsPosition');
		const rawPos = typeof fallbackPos === 'string' ? fallbackPos : this.config.get<unknown>('commitRow.actionsPosition', 'Pointer');
		const position: 'Pointer' | 'Description' | 'Row' = rawPos === 'Description' || rawPos === 'Row' ? rawPos : 'Pointer';
		return {
			actions: this.getCommitActionList('commitRow.actions', DEFAULT_ROW_COMMIT_ACTIONS),
			position: position
		};
	}

	private getCommitActionList(key: string, defaults: ReadonlyArray<string>): ReadonlyArray<string> {
		const fallback = getSettingFallback<ReadonlyArray<string>>(key);
		const raw = Array.isArray(fallback) ? fallback : this.config.get<unknown>(key);
		if (!Array.isArray(raw)) return defaults;
		const seen = new Set<string>(), out: string[] = [];
		for (let i = 0; i < raw.length; i++) {
			const item = raw[i];
			if (typeof item === 'string' && COMMIT_ACTION_IDS.includes(item) && !seen.has(item)) {
				seen.add(item);
				out.push(item);
			}
		}
		return out;
	}

	/**
	 * Get whether unchanged regions should be collapsed when viewing diffs (`git-map.diff.hideUnchangedRegions`, falling back to `diffEditor.hideUnchangedRegions.enabled`).
	 */
	get hideUnchangedRegions(): boolean {
		const fallback = getSettingFallback<boolean>('diff.hideUnchangedRegions');
		if (typeof fallback === 'boolean') return fallback;
		const inspected = this.config.inspect<boolean>('diff.hideUnchangedRegions');
		if (typeof inspected !== 'undefined' && (typeof inspected.workspaceFolderValue === 'boolean' || typeof inspected.workspaceValue === 'boolean' || typeof inspected.globalValue === 'boolean')) {
			return !!this.config.get('diff.hideUnchangedRegions', false);
		}
		const diffCfg = vscode.workspace.getConfiguration('diffEditor');
		return !!(diffCfg && typeof diffCfg.get === 'function' && diffCfg.get('hideUnchangedRegions.enabled', false));
	}

	/**
	 * Get the value of the `git-map.advanced.maxConcurrentGitProcesses` Extension Setting (clamped to 1..32).
	 */
	get maxConcurrentGitProcesses(): number {
		const raw = this.config.get('advanced.maxConcurrentGitProcesses', 8);
		if (typeof raw !== 'number' || !Number.isFinite(raw)) return 8;
		return Math.max(1, Math.min(32, Math.floor(raw)));
	}

	/**
	 * Get the value of the `git-map.commitDetailsView.location` Extension Setting.
	 */
	private getCommitDetailsViewLocation() {
		const location = this.getRenamedExtensionSetting<string>('commitDetailsView.location', 'commitDetailsViewLocation', 'Docked to Right');
		return location === 'Inline'
			? CommitDetailsViewLocation.Inline
			: location === 'Docked to Bottom'
				? CommitDetailsViewLocation.DockedToBottom
				: CommitDetailsViewLocation.DockedToRight;
	}

	/**
	 * Get the value of the `git-map.contextMenuActionsVisibility` Extension Setting.
	 */
	get contextMenuActionsVisibility(): ContextMenuActionsVisibility {
		const userConfig = this.config.get('contextMenuActionsVisibility', {});
		const config: ContextMenuActionsVisibility = {
			branch: { checkout: true, rename: true, delete: true, merge: true, rebase: true, push: true, viewIssue: true, createPullRequest: true, createArchive: true, createWorktree: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true, compare: true },
			commit: { addTag: true, createBranch: true, createWorktree: true, checkout: true, cherrypick: true, revert: true, drop: true, merge: true, rebase: true, reset: true, copyHash: true, copySubject: true, editMessage: true, undoCommit: true, fixup: true, bisect: true, savePatch: true },
			commitDetailsViewFile: { viewDiff: true, viewFileAtThisRevision: true, viewDiffWithWorkingFile: true, openFile: true, markAsReviewed: true, markAsNotReviewed: true, resetFileToThisRevision: true, removeFromHistory: true, copyAbsoluteFilePath: true, copyRelativeFilePath: true, stashFile: true, restoreFromStash: true, visualFileHistory: true },
			remoteBranch: { checkout: true, delete: true, fetch: true, merge: true, pull: true, viewIssue: true, createPullRequest: true, createArchive: true, selectInBranchesDropdown: true, unselectInBranchesDropdown: true, copyName: true, compare: true },
			stash: { apply: true, createBranch: true, pop: true, drop: true, copyName: true, copyHash: true, savePatch: true },
			tag: { viewDetails: true, delete: true, push: true, createArchive: true, copyName: true },
			uncommittedChanges: { stash: true, reset: true, clean: true, openSourceControlView: true, savePatch: true, applyPatch: true, generateCommitMessage: true }
		};
		mergeConfigObjects(config, userConfig);
		return config;
	}

	/**
	 * Get the value of the `git-map.customBranchGlobPatterns` Extension Setting.
	 */
	get customBranchGlobPatterns(): CustomBranchGlobPattern[] {
		let inPatterns = this.config.get('customBranchGlobPatterns', <any[]>[]);
		let outPatterns: CustomBranchGlobPattern[] = [];
		for (let i = 0; i < inPatterns.length; i++) {
			if (typeof inPatterns[i].name === 'string' && typeof inPatterns[i].glob === 'string') {
				outPatterns.push({ name: inPatterns[i].name, glob: '--glob=' + inPatterns[i].glob });
			}
		}
		return outPatterns;
	}

	/**
	 * Get the value of the `git-map.customEmojiShortcodeMappings` Extension Setting.
	 */
	get customEmojiShortcodeMappings(): CustomEmojiShortcodeMapping[] {
		let inMappings = this.config.get('customEmojiShortcodeMappings', <any[]>[]);
		let outMappings: CustomEmojiShortcodeMapping[] = [];
		for (let i = 0; i < inMappings.length; i++) {
			if (typeof inMappings[i].shortcode === 'string' && typeof inMappings[i].emoji === 'string') {
				outMappings.push({ shortcode: inMappings[i].shortcode, emoji: inMappings[i].emoji });
			}
		}
		return outMappings;
	}

	/**
	 * Get the value of the `git-map.customPullRequestProviders` Extension Setting.
	 */
	get customPullRequestProviders(): CustomPullRequestProvider[] {
		let providers = this.config.get('customPullRequestProviders', <any[]>[]);
		return Array.isArray(providers)
			? providers
				.filter((provider) => typeof provider.name === 'string' && typeof provider.templateUrl === 'string')
				.map((provider) => ({ name: provider.name, templateUrl: provider.templateUrl }))
			: [];
	}

	/**
	 * Get the value of the `git-map.date.format` Extension Setting.
	 */
	get dateFormat(): DateFormat {
		let configValue = this.getRenamedExtensionSetting<string>('date.format', 'dateFormat', 'Date & Time'), type = DateFormatType.DateAndTime, iso = false;
		if (configValue === 'Relative') {
			type = DateFormatType.Relative;
		} else {
			if (configValue.endsWith('Date Only')) type = DateFormatType.DateOnly;
			if (configValue.startsWith('ISO')) iso = true;
		}
		return { type: type, iso: iso };
	}

	/**
	 * Get the value of the `git-map.date.type` Extension Setting.
	 */
	get dateType() {
		return this.getRenamedExtensionSetting<string>('date.type', 'dateType', 'Author Date') === 'Commit Date'
			? DateType.Commit
			: DateType.Author;
	}

	/**
	 * Get the value of the `git-map.defaultColumnVisibility` Extension Setting.
	 */
	get defaultColumnVisibility(): DefaultColumnVisibility {
		let obj: any = this.config.get('defaultColumnVisibility', {});
		if (typeof obj === 'object' && obj !== null && typeof obj['Date'] === 'boolean' && typeof obj['Author'] === 'boolean' && typeof obj['Commit'] === 'boolean') {
			return { author: obj['Author'], commit: obj['Commit'], date: obj['Date'] };
		} else {
			return { author: true, commit: true, date: true };
		}
	}

	/**
	 * Get the value of the `git-map.dialog.*` Extension Settings.
	 */
	get dialogDefaults(): DialogDefaults {
		let resetCommitMode = this.config.get<string>('dialog.resetCurrentBranchToCommit.mode', 'Mixed');
		let resetUncommittedMode = this.config.get<string>('dialog.resetUncommittedChanges.mode', 'Mixed');
		let refInputSpaceSubstitution = this.config.get<string>('dialog.general.referenceInputSpaceSubstitution', 'None');

		return {
			addTag: {
				pushToRemote: !!this.config.get('dialog.addTag.pushToRemote', false),
				type: this.config.get<string>('dialog.addTag.type', 'Annotated') === 'Lightweight' ? TagType.Lightweight : TagType.Annotated
			},
			applyStash: {
				reinstateIndex: !!this.config.get('dialog.applyStash.reinstateIndex', false)
			},
			cherryPick: {
				noCommit: !!this.config.get('dialog.cherryPick.noCommit', false),
				recordOrigin: !!this.config.get('dialog.cherryPick.recordOrigin', false)
			},
			createBranch: {
				checkout: !!this.config.get('dialog.createBranch.checkOut', false)
			},
			deleteBranch: {
				forceDelete: !!this.config.get('dialog.deleteBranch.forceDelete', false)
			},
			fetchIntoLocalBranch: {
				forceFetch: !!this.config.get('dialog.fetchIntoLocalBranch.forceFetch', false)
			},
			fetchRemote: {
				prune: !!this.config.get('dialog.fetchRemote.prune', false),
				pruneTags: !!this.config.get('dialog.fetchRemote.pruneTags', false)
			},
			general: {
				referenceInputSpaceSubstitution: refInputSpaceSubstitution === 'Hyphen' ? '-' : refInputSpaceSubstitution === 'Underscore' ? '_' : null
			},
			merge: {
				noCommit: !!this.config.get('dialog.merge.noCommit', false),
				noFastForward: !!this.config.get('dialog.merge.noFastForward', true),
				squash: !!this.config.get('dialog.merge.squashCommits', false)
			},
			popStash: {
				reinstateIndex: !!this.config.get('dialog.popStash.reinstateIndex', false)
			},
			pullBranch: {
				noFastForward: !!this.config.get('dialog.pullBranch.noFastForward', false),
				squash: !!this.config.get('dialog.pullBranch.squashCommits', false)
			},
			rebase: {
				ignoreDate: !!this.config.get('dialog.rebase.ignoreDate', true),
				interactive: !!this.config.get('dialog.rebase.launchInteractiveRebase', false)
			},
			resetCommit: {
				mode: resetCommitMode === 'Soft' ? GitResetMode.Soft : (resetCommitMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed)
			},
			resetUncommitted: {
				mode: resetUncommittedMode === 'Hard' ? GitResetMode.Hard : GitResetMode.Mixed
			},
			stashUncommittedChanges: {
				includeUntracked: !!this.config.get('dialog.stashUncommittedChanges.includeUntracked', true)
			}
		};
	}

	/**
	 * Get the value of the `git-map.dialog.merge.squashMessageFormat` Extension Setting.
	 */
	get squashMergeMessageFormat() {
		return this.config.get<string>('dialog.merge.squashMessageFormat', 'Default') === 'Git SQUASH_MSG'
			? SquashMessageFormat.GitSquashMsg
			: SquashMessageFormat.Default;
	}

	/**
	 * Get the value of the `git-map.dialog.pullBranch.squashMessageFormat` Extension Setting.
	 */
	get squashPullMessageFormat() {
		return this.config.get<string>('dialog.pullBranch.squashMessageFormat', 'Default') === 'Git SQUASH_MSG'
			? SquashMessageFormat.GitSquashMsg
			: SquashMessageFormat.Default;
	}

	/**
	 * Get the value of the `git-map.enhancedAccessibility` Extension Setting.
	 */
	get enhancedAccessibility() {
		return !!this.config.get('enhancedAccessibility', false);
	}

	/**
	 * Get the value of the `git-map.fileEncoding` Extension Setting.
	 */
	get fileEncoding() {
		return this.config.get<string>('fileEncoding', 'utf8');
	}

	/**
	 * Get the graph configuration from the Extension Settings.
	 */
	get graph(): GraphConfig {
		const preset = GRAPH_COLOUR_PRESETS[this.graphColourPreset];
		const nodeStyle = this.config.get<string>('graph.nodeStyle', 'Dot') === 'Avatar' ? GraphNodeStyle.Avatar : GraphNodeStyle.Dot;
		return {
			colours: typeof preset !== 'undefined' ? preset.slice() : this.defaultGraphColours,
			density: this.config.get<string>('graph.density', 'Comfortable') === 'Compact' ? GraphDensity.Compact : GraphDensity.Comfortable,
			followTerminal: this.followTerminal,
			freezeColumnHeaders: !!this.config.get('graph.freezeColumnHeaders', true),
			freezeFooter: !!this.config.get('graph.freezeFooter', true),
			maxVisibleRefsPerCommit: this.graphMaxVisibleRefs,
			minimap: !!this.config.get('graph.minimap', true),
			minimapAdditionalTypes: this.graphMinimapAdditionalTypes,
			multiselect: this.graphMultiselect,
			nodeStyle: nodeStyle,
			overviewBarEnabled: this.graphOverviewBarEnabled,
			scrollMarkers: this.graphScrollMarkers,
			shortcutOverrides: this.graphShortcutOverrides,
			showGhostRefsOnRowHover: this.graphShowGhostRefs,
			style: this.getRenamedExtensionSetting<string>('graph.style', 'graphStyle', 'rounded') === 'angular'
				? GraphStyle.Angular
				: GraphStyle.Rounded,
			grid: { x: nodeStyle === GraphNodeStyle.Avatar ? 22 : 16, y: 24, offsetX: nodeStyle === GraphNodeStyle.Avatar ? 18 : 16, offsetY: 12, expandY: 250 },
			uncommittedChanges: this.config.get<string>('graph.uncommittedChanges', 'Open Circle at the Uncommitted Changes') === 'Open Circle at the Checked Out Commit'
				? GraphUncommittedChangesStyle.OpenCircleAtTheCheckedOutCommit
				: GraphUncommittedChangesStyle.OpenCircleAtTheUncommittedChanges
		};
	}

	/**
	 * Get the colours of the "Default" graph colour preset (the `git-map.graph.colours` Extension Setting).
	 */
	private get defaultGraphColours() {
		const colours = this.getRenamedExtensionSetting<string[]>('graph.colours', 'graphColours', []);
		return Array.isArray(colours) && colours.length > 0
			? colours.filter((v) => v.match(/^\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|rgb[a]?\s*\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\))\s*$/) !== null)
			: ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9', '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23', '#6f24d6', '#ffcc00'];
	}

	/**
	 * Get the appearance settings that apply to all repositories, which can be changed in the Repository Settings Widget.
	 */
	get appearance(): AppearanceConfig {
		return {
			colourPreset: this.graphColourPreset,
			colourPresets: GRAPH_COLOUR_PRESET_NAMES.map((name) => ({ name: name, colours: (GRAPH_COLOUR_PRESETS[name] || this.defaultGraphColours).slice(0, 6) })),
			displayLanguage: vscode.env.language || 'en',
			language: this.language,
			statusBarItemDisplay: this.statusBarItemDisplay
		};
	}

	/**
	 * Get the value of the `git-map.graph.colourPreset` Extension Setting.
	 */
	get graphColourPreset() {
		const preset = this.config.get<string>('graph.colourPreset', 'Default');
		return GRAPH_COLOUR_PRESET_NAMES.includes(preset) ? preset : 'Default';
	}

	/**
	 * Get the value of the `git-map.integratedTerminalShell` Extension Setting.
	 */
	get integratedTerminalShell() {
		return this.config.get('integratedTerminalShell', '');
	}

	/**
	 * Get the keybinding configuration from the `git-map.keyboardShortcut.*` Extension Settings.
	 */
	get keybindings(): KeybindingConfig {
		return {
			find: this.getKeybinding('keyboardShortcut.find', 'f'),
			refresh: this.getKeybinding('keyboardShortcut.refresh', 'r'),
			scrollToHead: this.getKeybinding('keyboardShortcut.scrollToHead', 'h'),
			scrollToStash: this.getKeybinding('keyboardShortcut.scrollToStash', 's')
		};
	}

	/**
	 * Get the value of the `git-map.maxDepthOfRepoSearch` Extension Setting.
	 */
	get maxDepthOfRepoSearch() {
		return this.config.get('maxDepthOfRepoSearch', 0);
	}

	/**
	 * Get the value of the `git-map.markdown` Extension Setting.
	 */
	get markdown() {
		return !!this.config.get('markdown', true);
	}

	/**
	 * Get the value of the `git-map.openNewTabEditorGroup` Extension Setting.
	 */
	get openNewTabEditorGroup(): vscode.ViewColumn {
		const location = this.getRenamedExtensionSetting<string>('openNewTabEditorGroup', 'openDiffTabLocation', 'Active');
		return typeof location === 'string' && typeof VIEW_COLUMN_MAPPING[location] !== 'undefined'
			? VIEW_COLUMN_MAPPING[location]
			: vscode.ViewColumn.Active;
	}

	/**
	 * Get the value of the `git-map.openToTheRepoOfTheActiveTextEditorDocument` Extension Setting.
	 */
	get openToTheRepoOfTheActiveTextEditorDocument() {
		return !!this.config.get('openToTheRepoOfTheActiveTextEditorDocument', false);
	}

	/**
	 * Get the reference label configuration from the Extension Settings.
	 */
	get referenceLabels(): ReferenceLabelsConfig {
		const alignmentConfigValue = this.getRenamedExtensionSetting<string>('referenceLabels.alignment', 'referenceLabelAlignment', 'Branches & Tags (in a separate column)');
		const alignment = alignmentConfigValue === 'Branches (on the left) & Tags (on the right)'
			? RefLabelAlignment.BranchesOnLeftAndTagsOnRight
			: alignmentConfigValue === 'Branches (aligned to the graph) & Tags (on the right)'
				? RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight
				: alignmentConfigValue === 'Branches & Tags (in a separate column)'
					? RefLabelAlignment.SeparateColumn
					: RefLabelAlignment.Normal;
		return {
			branchLabelsAlignedToGraph: alignment === RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight,
			combineLocalAndRemoteBranchLabels: !!this.getRenamedExtensionSetting('referenceLabels.combineLocalAndRemoteBranchLabels', 'combineLocalAndRemoteBranchLabels', true),
			inSeparateColumn: alignment === RefLabelAlignment.SeparateColumn,
			tagLabelsOnRight: alignment === RefLabelAlignment.BranchesOnLeftAndTagsOnRight || alignment === RefLabelAlignment.BranchesAlignedToGraphAndTagsOnRight
		};
	}

	/**
	 * Get the value of the `git-map.blame.currentLine` Extension Setting.
	 */
	get blameCurrentLine() {
		return !!this.config.get('blame.currentLine', true);
	}

	/**
	 * Get the value of the `git-map.blame.statusBar` Extension Setting.
	 */
	get blameStatusBar() {
		return !!this.config.get('blame.statusBar', true);
	}

	/**
	 * Get the value of the `git-map.blame.ignoreWhitespace` Extension Setting.
	 */
	get blameIgnoreWhitespace() {
		return !!this.config.get('blame.ignoreWhitespace', false);
	}

	/**
	 * Get the value of the `git-map.blame.ignoreRevsFile` Extension Setting.
	 */
	get blameIgnoreRevsFile() {
		const value = this.config.get('blame.ignoreRevsFile', '.git-blame-ignore-revs');
		return typeof value === 'string' ? value.trim() : '';
	}

	/**
	 * Get the value of the `git-map.ai.explainCommit.enabled` Extension Setting.
	 */
	get explainCommit() {
		return !!this.config.get('ai.explainCommit.enabled', false);
	}

	/**
	 * Get the value of the `git-map.ai.commitMessage.enabled` Extension Setting.
	 */
	get aiCommitMessage() {
		return !!this.config.get('ai.commitMessage.enabled', true);
	}

	/**
	 * Get the value of the `git-map.ai.provider` Extension Setting.
	 */
	get aiProvider(): AiProvider {
		const value = this.config.get('ai.provider', 'VS Code');
		return typeof value === 'string' && AI_PROVIDER_VALUES.includes(value) ? <AiProvider>value : AiProvider.VsCode;
	}

	/**
	 * Get the value of the `git-map.ai.baseUrl` Extension Setting.
	 */
	get aiBaseUrl() {
		const value = this.config.get('ai.baseUrl', '');
		return typeof value === 'string' ? value.trim() : '';
	}

	/**
	 * Get the value of the `git-map.ai.model` Extension Setting.
	 */
	get aiModel() {
		const value = this.config.get('ai.model', '');
		return typeof value === 'string' ? value.trim() : '';
	}

	/**
	 * Get the AI settings snapshot for the Git Map View.
	 */
	get ai(): AiSettingsConfig {
		const base = getAiSettingsSnapshot(this.explainCommit, this.aiCommitMessage, this.aiProvider, this.aiBaseUrl, this.aiModel);
		return Object.assign({}, base, {
			taskModels: this.aiTaskModels,
			customInstructions: this.aiCustomInstructions,
			excludeFiles: this.aiExcludeFiles,
			largePromptWarningThreshold: this.aiLargePromptWarningThreshold,
			autoRebaseConfidenceThreshold: this.aiAutoRebaseConfidenceThreshold
		});
	}

	get aiTaskModels(): AiTaskModelsConfig {
		const raw = this.config.get<unknown>('ai.taskModels', {});
		if (!raw || typeof raw !== 'object') return {};
		const obj = raw as { [k: string]: unknown };
		const keys: AiTaskKey[] = ['commitMessage', 'reviewChanges', 'resolveConflicts', 'explainAndSearch'];
		const out: { [K in AiTaskKey]?: AiTaskModelOverride } = {};
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			const v = obj[k];
			if (v && typeof v === 'object') {
				const entry = v as { provider?: unknown, baseUrl?: unknown, model?: unknown };
				out[k] = {
					provider: typeof entry.provider === 'string' && entry.provider.trim() !== '' ? entry.provider.trim() : undefined,
					baseUrl: typeof entry.baseUrl === 'string' && entry.baseUrl.trim() !== '' ? entry.baseUrl.trim() : undefined,
					model: typeof entry.model === 'string' && entry.model.trim() !== '' ? entry.model.trim() : undefined
				};
			}
		}
		return out;
	}

	get aiCustomInstructions(): AiCustomInstructionsConfig {
		return {
			commitMessage: String(this.config.get('ai.customInstructions.commitMessage', '') || '').trim(),
			reviewChanges: String(this.config.get('ai.customInstructions.reviewChanges', '') || '').trim(),
			resolveConflicts: String(this.config.get('ai.customInstructions.resolveConflicts', '') || '').trim(),
			explainChanges: String(this.config.get('ai.customInstructions.explainChanges', '') || '').trim(),
			generateChangelog: String(this.config.get('ai.customInstructions.generateChangelog', '') || '').trim(),
			generateStashMessage: String(this.config.get('ai.customInstructions.generateStashMessage', '') || '').trim()
		};
	}

	get aiExcludeFiles(): ReadonlyArray<string> {
		const raw = this.config.get<unknown>('ai.exclude.files', ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/*.min.js']);
		return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
	}

	get aiLargePromptWarningThreshold(): number {
		const val = this.config.get('ai.largePromptWarningThreshold', 24000);
		return typeof val === 'number' && Number.isFinite(val) && val >= 0 ? Math.floor(val) : 24000;
	}

	get aiAutoRebaseConfidenceThreshold(): number {
		const val = this.config.get('ai.autoRebase.confidenceThreshold', 0.75);
		return typeof val === 'number' && Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0.75;
	}

	/**
	 * Get the value of the `git-map.codeLens.enabled` Extension Setting.
	 */
	get codeLensEnabled() {
		return !!this.config.get('codeLens.enabled', false);
	}

	get codeLensConfig(): {
		readonly enabled: boolean,
		readonly recentChangeEnabled: boolean,
		readonly recentChangeCommand: 'openLineHistory' | 'toggleFileBlame' | 'viewCommit',
		readonly authorsEnabled: boolean,
		readonly authorsCommand: 'openLineHistory' | 'toggleFileBlame' | 'viewCommit',
		readonly scopes: ReadonlyArray<'document' | 'containers' | 'blocks'>,
		readonly includeSingleLineSymbols: boolean
	} {
		const rawScopes = this.config.get<unknown>('codeLens.scopes', ['containers', 'blocks']);
		const validScopes = Array.isArray(rawScopes)
			? rawScopes.filter((s): s is 'document' | 'containers' | 'blocks' => s === 'document' || s === 'containers' || s === 'blocks')
			: ['containers' as const, 'blocks' as const];
		const parseCmd = (raw: unknown, fallback: 'openLineHistory' | 'toggleFileBlame' | 'viewCommit') => {
			if (raw === 'toggleFileBlame' || raw === 'git-map.toggleFileBlame') return 'toggleFileBlame';
			if (raw === 'viewCommit' || raw === 'git-map.viewCommitInGitMap') return 'viewCommit';
			if (raw === 'openLineHistory' || raw === 'git-map.viewLineHistory' || raw === 'git-map.openLineChanges') return 'openLineHistory';
			return fallback;
		};
		return {
			enabled: this.codeLensEnabled,
			recentChangeEnabled: !!this.config.get('codeLens.recentChange.enabled', true),
			recentChangeCommand: parseCmd(this.config.get('codeLens.recentChange.command', 'git-map.viewLineHistory'), 'openLineHistory'),
			authorsEnabled: !!this.config.get('codeLens.authors.enabled', true),
			authorsCommand: parseCmd(this.config.get('codeLens.authors.command', 'git-map.viewLineHistory'), 'openLineHistory'),
			scopes: validScopes.length > 0 ? validScopes : ['containers', 'blocks'],
			includeSingleLineSymbols: !!this.config.get('codeLens.includeSingleLineSymbols', false)
		};
	}

	get blameInlineFormat(): string {
		const v = this.config.get('blame.currentLine.format', '${author}, ${agoOrDate}${\' via \'pullRequest}${ • summary|60?}');
		return typeof v === 'string' && v.trim() !== '' ? v : '${author}, ${agoOrDate}${\' via \'pullRequest}${ • summary|60?}';
	}

	get blameUncommittedFormat(): string {
		const v = this.config.get('blame.currentLine.uncommittedChangesFormat', 'You, Uncommitted changes (${ago})');
		return typeof v === 'string' && v.trim() !== '' ? v : 'You, Uncommitted changes';
	}

	get blamePullRequestsEnabled(): boolean {
		return !!this.config.get('blame.pullRequests.enabled', true);
	}

	get blameScrollable(): boolean {
		return !!this.config.get('blame.currentLine.scrollable', true);
	}

	get blameStatusBarFormat(): string {
		const v = this.config.get('blame.statusBar.format', '${author}, ${agoOrDate}${\' via \'pullRequest}');
		return typeof v === 'string' && v.trim() !== '' ? v : '${author}, ${agoOrDate}${\' via \'pullRequest}';
	}

	get blameStatusBarAlignment(): 'left' | 'right' {
		return this.config.get<string>('blame.statusBar.alignment', 'left') === 'right' ? 'right' : 'left';
	}

	get blameStatusBarReduceFlicker(): boolean {
		return !!this.config.get('blame.statusBar.reduceFlicker', true);
	}

	get hoversConfig(): {
		readonly enabled: boolean,
		readonly currentLineEnabled: boolean,
		readonly currentLineOver: 'annotation' | 'line',
		readonly currentLineDetails: boolean,
		readonly currentLineChanges: boolean,
		readonly autolinksEnabled: boolean,
		readonly pullRequestsEnabled: boolean
	} {
		return {
			enabled: !!this.config.get('hovers.enabled', true),
			currentLineEnabled: !!this.config.get('hovers.currentLine.enabled', true),
			currentLineOver: this.config.get<string>('hovers.currentLine.over', 'line') === 'annotation' ? 'annotation' : 'line',
			currentLineDetails: !!this.config.get('hovers.currentLine.details', true),
			currentLineChanges: !!this.config.get('hovers.currentLine.changes', true),
			autolinksEnabled: !!this.config.get('hovers.autolinks.enabled', true),
			pullRequestsEnabled: !!this.config.get('hovers.pullRequests.enabled', true)
		};
	}

	get fileBlameConfig(): {
		readonly toggleMode: AnnotationToggleMode,
		readonly heatmapEnabled: boolean,
		readonly heatmapLocation: 'left' | 'right',
		readonly compact: boolean,
		readonly highlightEnabled: boolean,
		readonly highlightLocations: ReadonlyArray<AnnotationLocation>,
		readonly delayAfterEdit: number,
		readonly sizeThresholdAfterEdit: number,
		readonly dismissOnEscape: boolean
	} {
		const locs = this.parseLocations(this.config.get('blame.file.highlight.locations', ['gutter', 'line', 'overviewRuler']), ['gutter', 'line']);
		const delay = this.config.get('advanced.blame.delayAfterEdit', 5000);
		const sizeThresh = this.config.get('advanced.blame.sizeThresholdAfterEdit', 5000);
		return {
			toggleMode: this.config.get<string>('blame.file.toggleMode', 'file') === 'window' ? 'window' : 'file',
			heatmapEnabled: !!this.config.get('blame.file.heatmap.enabled', true),
			heatmapLocation: this.config.get<string>('blame.file.heatmap.location', 'right') === 'left' ? 'left' : 'right',
			compact: !!this.config.get('blame.file.compact', true),
			highlightEnabled: !!this.config.get('blame.file.highlight.enabled', true),
			highlightLocations: locs,
			delayAfterEdit: typeof delay === 'number' && Number.isFinite(delay) && delay >= 100 ? delay : 5000,
			sizeThresholdAfterEdit: typeof sizeThresh === 'number' && Number.isFinite(sizeThresh) && sizeThresh >= 0 ? sizeThresh : 5000,
			dismissOnEscape: !!this.config.get('fileAnnotations.dismissOnEscape', true)
		};
	}

	get fileChangesConfig(): {
		readonly toggleMode: AnnotationToggleMode,
		readonly locations: ReadonlyArray<AnnotationLocation>,
		readonly dismissOnEscape: boolean
	} {
		return {
			toggleMode: this.config.get<string>('changes.toggleMode', 'file') === 'window' ? 'window' : 'file',
			locations: this.parseLocations(this.config.get('changes.locations', ['gutter', 'line', 'overviewRuler']), ['gutter', 'overviewRuler']),
			dismissOnEscape: !!this.config.get('fileAnnotations.dismissOnEscape', true)
		};
	}

	get fileHeatmapConfig(): {
		readonly toggleMode: AnnotationToggleMode,
		readonly locations: ReadonlyArray<AnnotationLocation>,
		readonly fadeLines: boolean,
		readonly ageThreshold: number,
		readonly hotColor: string,
		readonly coldColor: string,
		readonly dismissOnEscape: boolean
	} {
		const threshold = this.config.get('heatmap.ageThreshold', 90);
		const hot = String(this.config.get('heatmap.hotColor', '#f66a0a') || '#f66a0a');
		const cold = String(this.config.get('heatmap.coldColor', '#0a60f6') || '#0a60f6');
		return {
			toggleMode: this.config.get<string>('heatmap.toggleMode', 'file') === 'window' ? 'window' : 'file',
			locations: this.parseLocations(this.config.get('heatmap.locations', ['gutter', 'overviewRuler']), ['gutter', 'overviewRuler']),
			fadeLines: !!this.config.get('heatmap.fadeLines', true),
			ageThreshold: typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 1 ? threshold : 90,
			hotColor: /^#[0-9a-fA-F]{6}$/.test(hot) ? hot : '#f66a0a',
			coldColor: /^#[0-9a-fA-F]{6}$/.test(cold) ? cold : '#0a60f6',
			dismissOnEscape: !!this.config.get('fileAnnotations.dismissOnEscape', true)
		};
	}

	get autolinks(): ReadonlyArray<AutolinkRule> {
		const raw = this.config.get<unknown>('autolinks', []);
		if (!Array.isArray(raw)) return [];
		return raw.filter((r: any): r is AutolinkRule =>
			typeof r === 'object' && r !== null && typeof r.prefix === 'string' && r.prefix !== '' && typeof r.url === 'string' && r.url.includes('<num>')
		);
	}

	get customRemotes(): ReadonlyArray<CustomRemoteConfig> {
		const raw = this.config.get<unknown>('remotes', []);
		if (!Array.isArray(raw)) return [];
		return raw.filter((r: any): r is CustomRemoteConfig =>
			typeof r === 'object' && r !== null && typeof r.type === 'string' && (typeof r.domain === 'string' || typeof r.regex === 'string')
		);
	}

	get startWorkBranchFormat(): string {
		const v = this.config.get('startWork.branchNameFormat', '${id}-${title}');
		return typeof v === 'string' && v.trim() !== '' ? v.trim() : '${id}-${title}';
	}

	get terminalLinks(): TerminalLinksConfigSnapshot {
		return {
			enabled: !!this.config.get('terminalLinks.enabled', true),
			showDetailsView: !!this.config.get('terminalLinks.showDetailsView', true)
		};
	}

	get followTerminal(): { readonly enabled: boolean, readonly allowRepositorySwitching: boolean } {
		return {
			enabled: !!this.config.get('graph.followTerminal.enabled', false),
			allowRepositorySwitching: !!this.config.get('graph.followTerminal.allowRepositorySwitching', true)
		};
	}

	get graphScrollMarkers(): { readonly enabled: boolean, readonly types: ReadonlyArray<GraphMarkerType> } {
		const raw = this.config.get<unknown>('graph.scrollMarkers.types', ['localBranches', 'tags', 'stashes', 'worktrees']);
		return {
			enabled: !!this.config.get('graph.scrollMarkers.enabled', true),
			types: this.parseMarkerTypes(raw, ['localBranches', 'tags', 'stashes', 'worktrees'])
		};
	}

	get graphMinimapAdditionalTypes(): ReadonlyArray<GraphMarkerType> {
		return this.parseMarkerTypes(
			this.config.get<unknown>('graph.minimap.additionalTypes', ['localBranches', 'stashes', 'worktrees']),
			['localBranches', 'stashes', 'worktrees']
		);
	}

	get graphShowGhostRefs(): boolean {
		return !!this.config.get('graph.showGhostRefsOnRowHover', true);
	}

	get graphMultiselect(): GraphMultiSelectMode {
		const raw = this.config.get<unknown>('graph.multiselect', 'on');
		return raw === 'off' || raw === 'on' || raw === 'topological' ? raw : 'on';
	}

	get defaultCodingAgent(): string {
		return String(this.config.get('agents.default', '') || '');
	}

	get graphOverviewBarEnabled(): boolean {
		return !!this.config.get('graph.overviewBar.enabled', true);
	}

	get graphMaxVisibleRefs(): number {
		const n = this.config.get<unknown>('graph.maxVisibleRefsPerCommit', 0);
		return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
	}

	get graphShortcutOverrides(): { readonly [action: string]: string } {
		const raw = this.config.get<unknown>('graph.shortcuts.overrides', {});
		if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
		const out: { [action: string]: string } = {};
		const rec = raw as Record<string, unknown>;
		const keys = Object.keys(rec);
		for (let i = 0; i < keys.length; i++) {
			const val = rec[keys[i]];
			if (typeof val === 'string' && val.trim() !== '') {
				out[keys[i]] = val.trim().toLowerCase();
			}
		}
		return out;
	}

	get launchpadConfig(): LaunchpadConfigSnapshot {
		const rawGroups = this.config.get<unknown>('launchpad.indicator.groups', ['mergeable', 'blocked', 'needsReview', 'followUp']);
		const groups = Array.isArray(rawGroups)
			? rawGroups.filter((g): g is LaunchpadBucket => g === 'mergeable' || g === 'blocked' || g === 'needsReview' || g === 'followUp')
			: (['mergeable', 'blocked', 'needsReview', 'followUp'] as LaunchpadBucket[]);
		const interval = this.config.get('launchpad.indicator.polling.interval', 30);
		const stale = this.config.get('launchpad.staleThreshold', 14);
		return {
			indicatorEnabled: !!this.config.get('launchpad.indicator.enabled', true),
			groups: groups,
			useColors: !!this.config.get('launchpad.indicator.useColors', true),
			pollingIntervalMinutes: typeof interval === 'number' && Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : 30,
			staleThresholdDays: typeof stale === 'number' && Number.isFinite(stale) && stale >= 0 ? Math.floor(stale) : 14
		};
	}

	get modeConfig(): {
		readonly active: EditorModeId,
		readonly statusBarEnabled: boolean,
		readonly statusBarAlignment: 'left' | 'right',
		readonly customModes: ReadonlyArray<GitMapModeConfig>
	} {
		const active = String(this.config.get('mode.active', 'default') || 'default');
		const rawModes = this.config.get<unknown>('modes', []);
		const customModes = Array.isArray(rawModes)
			? rawModes.filter((m: any): m is GitMapModeConfig => typeof m === 'object' && m !== null && typeof m.name === 'string' && m.name.trim() !== '')
			: [];
		return {
			active: active,
			statusBarEnabled: !!this.config.get('mode.statusBar.enabled', false),
			statusBarAlignment: this.config.get<string>('mode.statusBar.alignment', 'left') === 'right' ? 'right' : 'left',
			customModes: customModes
		};
	}

	get scmViewsConfig(): ScmViewsConfigSnapshot {
		const rawGrouped = this.config.get<unknown>('views.scm.grouped.hiddenSections', undefined);
		const rawLegacy = this.config.get<unknown>('views.scm.hiddenSections', []);
		const raw = Array.isArray(rawGrouped) ? rawGrouped : rawLegacy;
		const groupedEnabled = this.config.get<unknown>('views.scm.grouped.enabled', undefined);
		const enabled = typeof groupedEnabled === 'boolean' ? groupedEnabled : !!this.config.get('views.scm.enabled', true);
		return {
			enabled: enabled,
			hiddenSections: Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [],
			defaultSection: String(this.config.get('views.scm.grouped.defaultSection', 'commits') || 'commits'),
			commitLabelFormat: String(this.config.get('views.commits.labelFormat', '${message}') || '${message}'),
			commitDescriptionFormat: String(this.config.get('views.commits.descriptionFormat', '${author, }${agoOrDate}') || '${author, }${agoOrDate}'),
			stashLabelFormat: String(this.config.get('views.stashes.labelFormat', '${message}') || '${message}'),
			stashDescriptionFormat: String(this.config.get('views.stashes.descriptionFormat', '${agoOrDate}') || '${agoOrDate}'),
			fileLabelFormat: String(this.config.get('views.files.labelFormat', '${file}') || '${file}'),
			fileDescriptionFormat: String(this.config.get('views.files.descriptionFormat', '${directory}') || '${directory}')
		};
	}

	get editorAnnotationsSnapshot(): EditorAnnotationsSnapshot {
		return {
			currentLineEnabled: this.blameCurrentLine,
			currentLinePullRequests: this.blamePullRequestsEnabled,
			currentLineFormat: this.blameInlineFormat,
			currentLineUncommittedFormat: this.blameUncommittedFormat,
			currentLineScrollable: this.blameScrollable,
			statusBarEnabled: this.blameStatusBar,
			statusBarAlignment: this.blameStatusBarAlignment,
			statusBarFormat: this.blameStatusBarFormat,
			statusBarReduceFlicker: this.blameStatusBarReduceFlicker,
			codeLensEnabled: this.codeLensEnabled,
			codeLensRecentChange: this.codeLensConfig.recentChangeEnabled,
			codeLensAuthors: this.codeLensConfig.authorsEnabled,
			codeLensScopes: this.codeLensConfig.scopes,
			hoversEnabled: this.hoversConfig.enabled,
			hoversCurrentLineOver: this.hoversConfig.currentLineOver,
			hoversChanges: this.hoversConfig.currentLineChanges,
			hoversAutolinks: this.hoversConfig.autolinksEnabled,
			fileBlameHeatmap: this.fileBlameConfig.heatmapEnabled,
			fileBlameHeatmapLocation: this.fileBlameConfig.heatmapLocation,
			fileBlameCompact: this.fileBlameConfig.compact,
			fileBlameHighlightSameCommit: this.fileBlameConfig.highlightEnabled,
			fileBlameHighlightLocations: this.fileBlameConfig.highlightLocations,
			fileChangesLocations: this.fileChangesConfig.locations,
			fileHeatmapLocations: this.fileHeatmapConfig.locations,
			fileHeatmapFadeLines: this.fileHeatmapConfig.fadeLines,
			fileHeatmapAgeThreshold: this.fileHeatmapConfig.ageThreshold,
			fileHeatmapHotColor: this.fileHeatmapConfig.hotColor,
			fileHeatmapColdColor: this.fileHeatmapConfig.coldColor,
			activeMode: this.modeConfig.active,
			customModes: this.modeConfig.customModes
		};
	}

	private parseLocations(raw: unknown, fallback: AnnotationLocation[]): ReadonlyArray<AnnotationLocation> {
		if (!Array.isArray(raw)) return fallback;
		return raw.filter((l): l is AnnotationLocation => l === 'gutter' || l === 'line' || l === 'overviewRuler');
	}

	private parseMarkerTypes(raw: unknown, fallback: GraphMarkerType[]): ReadonlyArray<GraphMarkerType> {
		if (!Array.isArray(raw)) return fallback;
		const valid: GraphMarkerType[] = ['localBranches', 'remoteBranches', 'pullRequests', 'stashes', 'tags', 'worktrees'];
		return raw.filter((m): m is GraphMarkerType => typeof m === 'string' && valid.includes(<GraphMarkerType>m));
	}

	/**
	 * Get the value of the `git-map.lineHistory.location` Extension Setting.
	 */
	get lineHistoryLocation() {
		return this.config.get<string>('lineHistory.location', 'Drawer') === 'Inline Window' ? LineHistoryLocation.InlineWindow : LineHistoryLocation.Drawer;
	}

	/**
	 * Get the value of the `git-map.lineHistory.followCursor` Extension Setting.
	 */
	get lineHistoryFollowCursor() {
		return !!this.config.get('lineHistory.followCursor', false);
	}

	/**
	 * Get the value of the `git-map.repository.commits.fetchAvatars` Extension Setting.
	 */
	get fetchAvatars() {
		return !!this.getRenamedExtensionSetting('repository.commits.fetchAvatars', 'fetchAvatars', false);
	}

	/**
	 * Get the value of the `git-map.repository.commits.initialLoad` Extension Setting.
	 */
	get initialLoadCommits() {
		return this.getRenamedExtensionSetting('repository.commits.initialLoad', 'initialLoadCommits', 300);
	}


	/**
	 * Get the value of the `git-map.language` Extension Setting.
	 */
	get language() {
		const language = this.config.get<string>('language', 'Auto');
		return language === 'English' || language === 'Simplified Chinese' ? language : 'Auto';
	}

	/**
	 * Get the value of the `git-map.repository.commits.loadMore` Extension Setting.
	 */
	get loadMoreCommits() {
		return this.getRenamedExtensionSetting('repository.commits.loadMore', 'loadMoreCommits', 100);
	}

	/**
	 * Get the value of the `git-map.repository.commits.loadMoreAutomatically` Extension Setting.
	 */
	get loadMoreCommitsAutomatically() {
		return !!this.getRenamedExtensionSetting('repository.commits.loadMoreAutomatically', 'loadMoreCommitsAutomatically', true);
	}

	/**
	 * Get the mute commits configuration from the Extension Settings.
	 */
	get muteCommits(): MuteCommitsConfig {
		return {
			commitsNotAncestorsOfHead: !!this.getRenamedExtensionSetting('repository.commits.mute.commitsThatAreNotAncestorsOfHead', 'muteCommitsThatAreNotAncestorsOfHead', false),
			mergeCommits: !!this.getRenamedExtensionSetting('repository.commits.mute.mergeCommits', 'muteMergeCommits', true)
		};
	}

	/**
	 * Get the value of the `git-map.repository.commits.order` Extension Setting.
	 */
	get commitOrder() {
		const ordering = this.getRenamedExtensionSetting<string>('repository.commits.order', 'commitOrdering', 'date');
		return ordering === 'author-date'
			? CommitOrdering.AuthorDate
			: ordering === 'topo'
				? CommitOrdering.Topological
				: CommitOrdering.Date;
	}

	/**
	 * Get the value of the `git-map.repository.commits.showSignatureStatus` Extension Setting.
	 */
	get showSignatureStatus() {
		return !!this.getRenamedExtensionSetting('repository.commits.showSignatureStatus', 'showSignatureStatus', false);
	}

	/**
	 * Get the value of the `git-map.repository.fetchAndPrune` Extension Setting.
	 */
	get fetchAndPrune() {
		return !!this.getRenamedExtensionSetting('repository.fetchAndPrune', 'fetchAndPrune', false);
	}

	/**
	 * Get the value of the `git-map.repository.fetchAndPruneTags` Extension Setting.
	 */
	get fetchAndPruneTags() {
		return !!this.config.get('repository.fetchAndPruneTags', false);
	}

	/**
	 * Get the value of the `git-map.repository.includeCommitsMentionedByReflogs` Extension Setting.
	 */
	get includeCommitsMentionedByReflogs() {
		return !!this.getRenamedExtensionSetting('repository.includeCommitsMentionedByReflogs', 'includeCommitsMentionedByReflogs', false);
	}

	/**
	 * Get the On Repo Load configuration from the Extension Settings.
	 */
	get onRepoLoad(): OnRepoLoadConfig {
		const branches = this.config.get('repository.onLoad.showSpecificBranches', []);
		return {
			scrollToHead: !!this.getRenamedExtensionSetting('repository.onLoad.scrollToHead', 'openRepoToHead', false),
			showCheckedOutBranch: !!this.getRenamedExtensionSetting('repository.onLoad.showCheckedOutBranch', 'showCurrentBranchByDefault', false),
			showSpecificBranches: Array.isArray(branches)
				? branches.filter((branch) => typeof branch === 'string')
				: []
		};
	}

	/**
	 * Get the value of the `git-map.workflowMacros` Extension Setting.
	 */
	get workflowMacros(): ReadonlyArray<{ readonly id: string, readonly name: string, readonly steps: ReadonlyArray<string> }> {
		const raw = this.config.get<unknown>('workflowMacros', []);
		return Array.isArray(raw)
			? raw.filter((m: any): m is { id: string, name: string, steps: string[] } =>
				typeof m === 'object' && m !== null && typeof m.id === 'string' && typeof m.name === 'string' && Array.isArray(m.steps)
			)
			: [];
	}

	/**
	 * Get the value of the `git-map.repository.onlyFollowFirstParent` Extension Setting.
	 */
	get onlyFollowFirstParent() {
		return !!this.getRenamedExtensionSetting('repository.onlyFollowFirstParent', 'onlyFollowFirstParent', false);
	}

	/**
	 * Get the value of the `git-map.repository.showCommitsOnlyReferencedByTags` Extension Setting.
	 */
	get showCommitsOnlyReferencedByTags() {
		return !!this.getRenamedExtensionSetting('repository.showCommitsOnlyReferencedByTags', 'showCommitsOnlyReferencedByTags', true);
	}

	/**
	 * Get the value of the `git-map.repository.showRemoteBranches` Extension Setting.
	 */
	get showRemoteBranches() {
		return !!this.config.get('repository.showRemoteBranches', true);
	}

	/**
	 * Get the value of the `git-map.repository.showRemoteHeads` Extension Setting.
	 */
	get showRemoteHeads() {
		return !!this.config.get('repository.showRemoteHeads', true);
	}

	/**
	 * Get the value of the `git-map.repository.showStashes` Extension Setting.
	 */
	get showStashes() {
		return !!this.config.get('repository.showStashes', true);
	}

	/**
	 * Get the value of the `git-map.repository.showTags` Extension Setting.
	 */
	get showTags() {
		return !!this.getRenamedExtensionSetting('repository.showTags', 'showTags', true);
	}

	/**
	 * Get the value of the `git-map.repository.showUncommittedChanges` Extension Setting.
	 */
	get showUncommittedChanges() {
		return !!this.getRenamedExtensionSetting('repository.showUncommittedChanges', 'showUncommittedChanges', true);
	}

	/**
	 * Get the value of the `git-map.repository.showUntrackedFiles` Extension Setting.
	 */
	get showUntrackedFiles() {
		return !!this.getRenamedExtensionSetting('repository.showUntrackedFiles', 'showUntrackedFiles', true);
	}

	/**
	 * Get the value of the `git-map.repository.sign.commits` Extension Setting.
	 */
	get signCommits() {
		return !!this.config.get('repository.sign.commits', false);
	}

	/**
	 * Get the value of the `git-map.repository.sign.tags` Extension Setting.
	 */
	get signTags() {
		return !!this.config.get('repository.sign.tags', false);
	}

	/**
	 * Get the value of the `git-map.repository.useMailmap` Extension Setting.
	 */
	get useMailmap() {
		return !!this.getRenamedExtensionSetting('repository.useMailmap', 'useMailmap', false);
	}

	/**
	 * Get the value of the `git-map.repositoryDropdownOrder` Extension Setting.
	 */
	get repoDropdownOrder(): RepoDropdownOrder {
		const order = this.config.get<string>('repositoryDropdownOrder', 'Workspace Full Path');
		return order === 'Full Path'
			? RepoDropdownOrder.FullPath
			: order === 'Name'
				? RepoDropdownOrder.Name
				: RepoDropdownOrder.WorkspaceFullPath;
	}

	/**
	 * Get the value of the `git-map.retainContextWhenHidden` Extension Setting.
	 */
	get retainContextWhenHidden() {
		return !!this.config.get('retainContextWhenHidden', true);
	}

	/**
	 * Get the value of the `git-map.showStatusBarItem` Extension Setting.
	 */
	get showStatusBarItem() {
		return !!this.config.get('showStatusBarItem', true);
	}

	/**
	 * Get the value of the `git-map.statusBarItemDisplay` Extension Setting.
	 */
	get statusBarItemDisplay() {
		const display = this.config.get<string>('statusBarItemDisplay', 'Icon & Text');
		return display === 'Icon'
			? StatusBarItemDisplay.Icon
			: display === 'Text'
				? StatusBarItemDisplay.Text
				: StatusBarItemDisplay.IconAndText;
	}

	/**
	 * Get the value of the `git-map.tabIconColourTheme` Extension Setting.
	 */
	get tabIconColourTheme() {
		return this.config.get<string>('tabIconColourTheme', 'colour') === 'grey'
			? TabIconColourTheme.Grey
			: TabIconColourTheme.Colour;
	}

	/**
	 * Get the Git executable paths configured by the `git.path` Visual Studio Code Setting.
	 */
	get gitPaths() {
		const configValue = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path', null);
		if (configValue === null) {
			return [];
		} else if (typeof configValue === 'string') {
			return [configValue];
		} else if (Array.isArray(configValue)) {
			return configValue.filter((value) => typeof value === 'string');
		} else {
			return [];
		}
	}

	/**
	 * Get the normalised keybinding located by the provided section.
	 * @param section The section locating the keybinding setting.
	 * @param defaultValue The default keybinding.
	 * @returns The normalised keybinding.
	 */
	public get pullRequestStatusEnabled() {
		return this.config.get<boolean>('integrations.pullRequestStatus.enabled', true);
	}

	private getKeybinding(section: string, defaultValue: string) {
		const configValue = this.config.get<string>(section);
		if (typeof configValue === 'string') {
			if (configValue === 'UNASSIGNED') {
				return null;
			} else if (Config.KEYBINDING_REGEXP.test(configValue)) {
				return configValue.substring(11).toLowerCase();
			}
		}
		return defaultValue;
	}

	/**
	 * Get the value of a renamed extension setting.
	 * @param newSection The section locating the new setting.
	 * @param oldSection The section location the old setting.
	 * @param defaultValue The default value of the setting.
	 * @returns The value of the extension setting.
	 */
	private getRenamedExtensionSetting<T>(newSection: string, oldSection: string, defaultValue: T) {
		const newValues = this.config.inspect<T>(newSection), oldValues = this.config.inspect<T>(oldSection);
		if (typeof newValues !== 'undefined' && typeof newValues.workspaceValue !== 'undefined') return newValues.workspaceValue;
		if (typeof oldValues !== 'undefined' && typeof oldValues.workspaceValue !== 'undefined') return oldValues.workspaceValue;
		if (typeof newValues !== 'undefined' && typeof newValues.globalValue !== 'undefined') return newValues.globalValue;
		if (typeof oldValues !== 'undefined' && typeof oldValues.globalValue !== 'undefined') return oldValues.globalValue;
		return defaultValue;
	}
}

/**
 * Get a Config instance for retrieving the users configuration of Git Map Extension Settings.
 * @param repo An optional path of a repository (to be used for Workspace Folder Scoped Configuration Values).
 * @returns A Config instance.
 */
export function getConfig(repo?: string) {
	return new Config(repo);
}

/**
 * Recursively apply the values in a user specified object to an object containing default values.
 * @param base An object containing the default values.
 * @param user An object specified by the user.
 */
function mergeConfigObjects(base: { [key: string]: any }, user: { [key: string]: any }) {
	if (typeof base !== typeof user || user === null) return;

	let keys = Object.keys(base);
	for (let i = 0; i < keys.length; i++) {
		if (typeof base[keys[i]] === 'object') {
			if (typeof user[keys[i]] === 'object') {
				mergeConfigObjects(base[keys[i]], user[keys[i]]);
			}
		} else if (typeof user[keys[i]] === typeof base[keys[i]]) {
			base[keys[i]] = user[keys[i]];
		}
	}
}
