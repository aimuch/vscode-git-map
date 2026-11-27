/**
 * The categories of the Settings panel, declared like the Settings page of GitLens (gitkraken/vscode-gitlens,
 * src/webviews/apps/settings/categories, MIT License): each category is a page in the navigation rail, with an optional switch for the
 * whole feature, the command that toggles it, a live preview, and its controls. Every control is an Extension Setting of Git Map (named
 * without `git-map.`), and controls can depend on other settings (`enabledWhen` / `visibleWhen`, see evaluateSettingsExpression).
 */

type SettingsCategoryGroup = 'integrations' | 'views' | 'editor' | 'general';

type SettingsStatusBarBadgeKind = 'statusBarBlame' | 'statusBarLaunchpad' | 'statusBarMode';

interface SettingsControlBase {
	readonly label: string;
	readonly hint?: string; // Shown below the control
	readonly enabledWhen?: string; // The control is disabled unless this is true
	readonly visibleWhen?: string; // The control is hidden unless this is true
	readonly indent?: number; // Shown indented below the control above it (1 or 2 levels)
	readonly field?: keyof GG.EditorAnnotationsSnapshot; // The state of the live previews of the Editor Annotations updated by the control
	readonly previewBadge?: SettingsStatusBarBadgeKind; // Inline Status Bar item preview shown beside the switch
}

type SettingsControl =
	| (SettingsControlBase & { readonly kind: 'check', readonly key: string, readonly path?: string, readonly valueOn?: unknown, readonly valueOff?: unknown })
	| (SettingsControlBase & { readonly kind: 'select' | 'segmented', readonly key: string, readonly path?: string, readonly options: ReadonlyArray<[string, string]>, readonly numeric?: boolean })
	| (SettingsControlBase & { readonly kind: 'text', readonly key: string, readonly placeholder?: string, readonly example?: SettingsExampleKind, readonly exampleDefault?: string, readonly tokens?: SettingsTokenSet })
	| (SettingsControlBase & { readonly kind: 'number', readonly key: string, readonly placeholder?: string, readonly min?: number })
	| (SettingsControlBase & { readonly kind: 'colour', readonly key: string })
	| (SettingsControlBase & { readonly kind: 'checkgroup', readonly key: string, readonly options: ReadonlyArray<[string, string, string]> })
	| { readonly kind: 'info', readonly text: string, readonly visibleWhen?: string, readonly boxed?: boolean, readonly indent?: number }
	| { readonly kind: 'custom', readonly id: string, readonly label: string };

/**
 * How the example below a text control is produced: a blame annotation, the uncommitted changes, a date (with the format, or the default
 * format when it's empty), the locale of dates, a commit / stash / file of the Git Map SCM view, or a branch name of Start Work.
 */
type SettingsExampleKind = 'blame' | 'uncommitted' | 'date' | 'shortDate' | 'time' | 'locale' | 'commit' | 'stash' | 'file' | 'tooltip' | 'branch';

/**
 * The tokens offered by the token menu of a text control.
 */
type SettingsTokenSet = 'commit' | 'stash' | 'file' | 'branch' | 'date';

interface SettingsCategoryDef {
	readonly id: string;
	readonly name: string;
	readonly group: SettingsCategoryGroup;
	readonly icon: keyof typeof MENU_ICONS;
	readonly hint: string;
	readonly master?: { readonly key: string, readonly label: string };
	readonly command?: { readonly title: string, readonly command: string }; // Shown as a tip: the command that overrides the setting for the current window
	readonly search: string; // What "More options" searches for in the Settings editor of Visual Studio Code
	readonly preview?: string; // The live preview shown at the top of the category
	readonly controls: ReadonlyArray<SettingsControl>;
}

/**
 * Evaluate an expression of the state of settings (the grammar of GitLens's Settings page): terms joined with `&` (all must be true), each
 * `key` (truthy), `key=value`, `key!value` (not equal) or `key+value` (the array contains the value).
 */
function evaluateSettingsExpression(expression: string, getValue: (key: string) => unknown): boolean {
	return expression.split('&').every((term) => {
		const match = /^\s*([^=!+]+?)\s*(?:([=!+])\s*(.*?))?\s*$/.exec(term);
		if (match === null) return false;
		const value = getValue(match[1]), op = match[2], rhs = match[3];
		if (typeof op === 'undefined') return !!value;
		if (op === '+') return Array.isArray(value) && value.includes(rhs);
		const equal = String(value === null || typeof value === 'undefined' ? false : value) === rhs;
		return op === '=' ? equal : !equal;
	});
}

/**
 * Get the tokens offered by the token menus of text controls (each with its description).
 */
function getSettingsTokens(set: SettingsTokenSet): ReadonlyArray<[string, string]> {
	const tokens: { readonly [set: string]: ReadonlyArray<[string, string]> } = {
		commit: [['${author}', t('Author')], ['${agoOrDate}', t('Relative or absolute date')], ['${ago}', t('Relative date')], ['${date}', t('Absolute date')], ['${message}', t('Commit message')], ['${message|50?}', t('Message (truncated to 50)')], ['${sha}', t('Short commit SHA')], ['${\' via \'pullRequest}', t('Pull request (if any)')]],
		stash: [['${message}', t('Stash message')], ['${stashOnRef, }', t('The branch it was made on')], ['${agoOrDate}', t('Relative or absolute date')], ['${ago}', t('Relative date')], ['${date}', t('Absolute date')], ['${sha}', t('Short SHA')]],
		file: [['${file}', t('File name')], ['${directory}', t('Directory')], ['${path}', t('Full path')]],
		branch: [['${id}', t('Issue ID')], ['${title}', t('Issue title')]],
		date: [['YYYY-MM-DD', t('ISO date')], ['MMMM Do, YYYY', t('Long date')], ['MMM D', t('Short date')], ['HH:mm', t('24-hour time')], ['h:mma', t('12-hour time')], ['dddd', t('Weekday')]]
	};
	return tokens[set];
}

/**
 * Get the categories of the Settings panel, in the order of the navigation rail.
 */
function getSettingsCategories(): ReadonlyArray<SettingsCategoryDef> {
	const toggleModes: ReadonlyArray<[string, string]> = [['file', t('individually for each file')], ['window', t('for all files')]];
	const locations: ReadonlyArray<[string, string, string]> = [['gutter', t('Add gutter indicator'), t('Mark the lines in the gutter')], ['line', t('Add line highlight'), t('Highlight the whole lines')], ['overviewRuler', t('Add scroll bar indicator'), t('Mark the lines alongside the scrollbar')]];
	const markerTypes: ReadonlyArray<[string, string, string]> = [
		['localBranches', t('Local Branches'), t('Mark the positions of local branches')],
		['remoteBranches', t('Remote Branches'), t('Mark the positions of remote branches')],
		['pullRequests', t('Pull Requests'), t('Mark the positions of pull requests')],
		['stashes', t('Stashes'), t('Mark the positions of stashes')],
		['tags', t('Tags'), t('Mark the positions of tags')],
		['worktrees', t('Worktrees'), t('Mark the positions of the other worktrees (where each is checked out)')]
	];
	const lensCommands: ReadonlyArray<[string, string]> = [
		['git-map.viewLineHistory', t('shows the history of the lines')], ['git-map.inspect', t('shows the commit in the Inspect view')], ['git-map.viewCommitInGitMap', t('views the commit in Git Map')],
		['git-map.openLineChanges', t('opens the changes of the commit')], ['git-map.viewFileHistory', t('shows the history of the file')], ['git-map.toggleFileBlame', t('toggles the File Blame')],
		['git-map.toggleFileHeatmap', t('toggles the File Heatmap')], ['git-map.toggleFileChanges', t('toggles the File Changes')], ['none', t('does nothing')]
	];
	const prInfo = t('Requires a connected remote service (e.g. a GitHub token for PR & CI badges).');
	const dateFormatHint = t('Used for absolute dates (e.g. the ${date} token). Empty: the default date format.');
	return [
		// Integrations
		{
			id: 'ai', name: t('AI'), group: 'integrations', icon: 'sparkle', search: 'git-map.ai',
			hint: t('Composing commits, reviewing changes, resolving conflicts and explaining history'),
			controls: [{ kind: 'custom', id: 'aiModels', label: t('AI Provider & Model') }, { kind: 'custom', id: 'aiPanel', label: t('Language Model') }]
		},
		{
			id: 'agents', name: t('Agents'), group: 'integrations', icon: 'agent', search: 'git-map.agents',
			hint: t('Set your default coding agent, and install the Git Map MCP server & Git hooks for supported agents'),
			controls: [{ kind: 'custom', id: 'agents', label: t('Agents') }]
		},
		{
			id: 'cloud-integrations', name: t('Cloud Integrations'), group: 'integrations', icon: 'cloud', search: 'git-map.integrations',
			hint: t('Connect hosting services like GitHub to show the pull requests & CI statuses of your branches'),
			master: { key: 'integrations.pullRequestStatus.enabled', label: t('Cloud Integrations') },
			controls: [{ kind: 'custom', id: 'cloudIntegrations', label: t('Hosting services') }]
		},
		{
			id: 'remotes', name: t('Custom Remotes'), group: 'integrations', icon: 'repo', search: 'git-map.remotes',
			hint: t('Match your Git remotes to a provider so Git Map can open files, commits and pull requests on self-hosted or custom Git hosts.'),
			controls: [{ kind: 'custom', id: 'remotes', label: t('Custom Remotes') }]
		},
		{
			id: 'autolinks', name: t('Autolinks'), group: 'integrations', icon: 'link', search: 'git-map.autolinks',
			hint: t('Use autolinks to linkify external references, like Jira issues or Zendesk tickets, in commit messages.'),
			controls: [{ kind: 'custom', id: 'autolinks', label: t('Autolinks') }]
		},
		{
			id: 'launchpad', name: t('Launchpad'), group: 'integrations', icon: 'rocket', search: 'git-map.launchpad', preview: 'launchpad',
			hint: t('Adds a Status Bar indicator of the pull requests needing your attention, grouped by the action they need'),
			master: { key: 'launchpad.indicator.enabled', label: t('Launchpad Indicator') },
			command: { title: t('Git Map: Open Pull Request Launchpad...'), command: 'git-map.openLaunchpad' },
			controls: [
				{ kind: 'select', key: 'launchpad.indicator.icon', label: t('Show'), enabledWhen: 'launchpad.indicator.enabled', options: [['default', t('the Launchpad icon (default)')], ['group', t('the icon of the highest priority group')]] },
				{ kind: 'select', key: 'launchpad.indicator.label', label: t('Label'), enabledWhen: 'launchpad.indicator.enabled', options: [['false', t('hidden')], ['item', t('the highest priority group needing your attention (default)')], ['counts', t('the number of pull requests in each group')]] },
				{
					kind: 'checkgroup', key: 'launchpad.indicator.groups', label: t('Include these groups in the indicator'), enabledWhen: 'launchpad.indicator.enabled', options: [
						['mergeable', t('Mergeable'), t('Shows the mergeable pull requests')], ['blocked', t('Blocked'), t('Shows the blocked pull requests')],
						['needsReview', t('Needs Review'), t('Shows the pull requests needing your review')], ['followUp', t('Follow-up'), t('Shows the pull requests needing follow-up')]
					]
				},
				{ kind: 'check', key: 'launchpad.indicator.useColors', label: t('Use colors on the indicator'), enabledWhen: 'launchpad.indicator.enabled' },
				{ kind: 'check', key: 'launchpad.indicator.polling.enabled', label: t('Fetch and display pull request data'), enabledWhen: 'launchpad.indicator.enabled' },
				{ kind: 'number', key: 'launchpad.pollingIntervalMinutes', label: t('Poll for updates every (minutes)'), hint: t('Use 0 to turn off automatic polling'), min: 0, indent: 1, enabledWhen: 'launchpad.indicator.enabled & launchpad.indicator.polling.enabled' },
				{ kind: 'number', key: 'launchpad.staleThresholdDays', label: t('Consider a pull request stale after (days)'), hint: t('Stale pull requests are moved to Other. Use 0 to never consider a pull request stale'), min: 0 }
			]
		},
		{
			id: 'terminal-links', name: t('Terminal Links'), group: 'integrations', icon: 'terminal', search: 'git-map.terminalLinks', preview: 'terminalLinks',
			hint: t('Adds links to the branches, tags, commits and ranges of commits in the integrated terminal'),
			master: { key: 'terminalLinks.enabled', label: t('Terminal Links') },
			controls: [
				{ kind: 'select', key: 'terminalLinks.showIn', label: t('Open commit and ref links in'), enabledWhen: 'terminalLinks.enabled', options: [['graph', t('the Git Map View (default)')], ['inspect', t('the Inspect view')], ['quickpick', t('a Quick Pick of the actions of the commit')]] },
				{ kind: 'check', key: 'terminalLinks.showDetailsView', label: t('Open the Commit Details View of the commit'), indent: 1, enabledWhen: 'terminalLinks.enabled', visibleWhen: 'terminalLinks.showIn=graph' },
				{ kind: 'check', key: 'graph.followTerminal.enabled', label: t('Show the repository of the active terminal in the Git Map View') },
				{ kind: 'check', key: 'graph.followTerminal.allowRepositorySwitching', label: t('Switch to the repository of the terminal (otherwise only within the current repository)'), indent: 1, enabledWhen: 'graph.followTerminal.enabled' }
			]
		},
		{
			id: 'start-work', name: t('Start Work'), group: 'integrations', icon: 'branch', search: 'git-map.startWork', preview: 'startWork',
			hint: t('Customize the names of the branches created when starting work on an issue'),
			command: { title: t('Git Map: Start Work (Create Branch from Issue)...'), command: 'git-map.startWork' },
			controls: [{ kind: 'text', key: 'startWork.branchNameFormat', label: t('Branch name format'), hint: t('Use ${id} for the issue ID and ${title} for its title. Branch names are normalized for Git.'), placeholder: '${id}-${title}', example: 'branch', exampleDefault: '${id}-${title}', tokens: 'branch' }]
		},

		// Views
		{
			id: 'commit-graph', name: t('Commit Graph'), group: 'views', icon: 'branch', search: 'git-map.graph', preview: 'graph',
			hint: t('The Git Map View visualizes, explores and manages the history of a repository'),
			controls: [
				{ kind: 'custom', id: 'graphAppearance', label: t('Appearance') },
				{ kind: 'segmented', key: 'ui.iconColorStyle', label: t('Icon colour style'), hint: t('AI & Coding Agent icons stay colourful in both modes. Status Bar uses multi-colour icons with high-contrast text.'), options: [['monochrome', t('Monochrome')], ['colorful', t('Colorful')]] },
				{ kind: 'number', key: 'repository.commits.initialLoad', label: t('Show this many rows at first'), min: 1 },
				{ kind: 'number', key: 'repository.commits.loadMore', label: t('Then load this many more rows'), min: 1 },
				{ kind: 'check', key: 'repository.commits.loadMoreAutomatically', label: t('Load more rows automatically when scrolling to the bottom') },
				{ kind: 'check', key: 'graph.scrollMarkers.enabled', label: t('Show markers on the scrollbar of the graph') },
				{ kind: 'checkgroup', key: 'graph.scrollMarkers.types', label: t('Also mark these on the scrollbar'), options: markerTypes, indent: 1, enabledWhen: 'graph.scrollMarkers.enabled' },
				{ kind: 'check', key: 'graph.minimap', label: t('Show a minimap of the commit activity above the graph') },
				{ kind: 'checkgroup', key: 'graph.minimap.additionalTypes', label: t('Also mark these on the minimap'), options: markerTypes, indent: 1, enabledWhen: 'graph.minimap' },
				{ kind: 'check', key: 'graph.showGhostRefsOnRowHover', label: t('Show the branches & tags of a commit when hovering over or selecting it') },
				{ kind: 'check', key: 'graph.overviewBar.enabled', label: t('Show the overview bar of the graph') },
				{ kind: 'check', key: 'repository.commits.mute.mergeCommits', label: t('Dim merge commit rows') },
				{ kind: 'check', key: 'repository.commits.mute.commitsThatAreNotAncestorsOfHead', label: t('Dim the commits that aren\'t ancestors of HEAD') },
				{ kind: 'check', key: 'referenceLabels.combineLocalAndRemoteBranchLabels', label: t('Combine the labels of local & remote branches on the same commit') },
				{ kind: 'select', key: 'graph.maxVisibleRefsPerCommit', numeric: true, label: t('Show this many branch and tag labels on each row before collapsing the rest'), options: [['0', t('all of them (default)')], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']] },
				{ kind: 'select', key: 'referenceLabels.alignment', label: t('Branch and tag label layout'), options: [['Branches & Tags (in a separate column)', t('in a separate column (default)')], ['Normal', t('inline with the commit')], ['Branches (on the left) & Tags (on the right)', t('branches on the left, tags on the right')], ['Branches (aligned to the graph) & Tags (on the right)', t('branches aligned to the graph, tags on the right')]] },
				{ kind: 'check', key: 'graph.showUpstreamStatus', label: t('Show the upstream status of local branches with remotes') },
				{ kind: 'check', key: 'integrations.pullRequestStatus.enabled', label: t('Show the pull requests & CI statuses of branches'), hint: prInfo },
				{ kind: 'check', key: 'repository.commits.fetchAvatars', label: t('Use the avatars of authors') },
				{ kind: 'select', key: 'repository.commits.order', label: t('Order commits'), options: [['date', t('by commit date, descending (default)')], ['author-date', t('by author date, descending')], ['topo', t('by commit date, descending, without intermixing lines of history')]] },
				{ kind: 'select', key: 'graph.multiselect', label: t('Allow selecting multiple commits'), hint: t('Topological restriction keeps a multi-selection along a single line of history'), options: [['off', t('no')], ['on', t('yes, without restriction (default)')], ['topological', t('yes, restricted topologically')]] },
				{ kind: 'select', key: 'date.format', label: t('Date format of the Date column'), options: [['Date & Time', t('date & time (default)')], ['Date Only', t('date only')], ['ISO Date & Time', t('ISO date & time')], ['ISO Date Only', t('ISO date only')], ['Relative', t('relative (e.g. 1 day ago)')]] }
			]
		},
		{
			id: 'scm-views', name: t('Git Map SCM'), group: 'views', icon: 'scm', search: 'git-map.views.scm', preview: 'scmViews',
			hint: t('Folds the views of Git Map into one Git Map SCM view, alongside the built-in Source Control view'),
			master: { key: 'views.scm.grouped.enabled', label: t('Git Map SCM View') },
			controls: [{ kind: 'custom', id: 'scmViews', label: t('Sections') }]
		},
		{
			id: 'commits-view', name: t('Commits View'), group: 'views', icon: 'commit', search: 'git-map.views', preview: 'commitsView',
			hint: t('The commits of the Git Map SCM view'),
			controls: [
				{ kind: 'text', key: 'views.commits.labelFormat', label: t('Commit label format'), placeholder: '${message}', example: 'commit', exampleDefault: '${message}', tokens: 'commit' },
				{ kind: 'text', key: 'views.commits.descriptionFormat', label: t('Commit description format'), placeholder: '${author, }${agoOrDate}', example: 'commit', exampleDefault: '${author, }${agoOrDate}', tokens: 'commit' },
				{ kind: 'text', key: 'views.commits.tooltipFormat', label: t('Commit tooltip format'), placeholder: '__${author}__, ${agoAndDate}\\n\\n${message}', example: 'tooltip', exampleDefault: '${sha} ${message} ${author}', tokens: 'commit' },
				{ kind: 'text', key: 'views.files.labelFormat', label: t('File format'), hint: t('Formats the file rows shown throughout the Git Map SCM view'), placeholder: '${file}', example: 'file', exampleDefault: '${file}', tokens: 'file' },
				{ kind: 'text', key: 'views.files.descriptionFormat', label: t('File description format'), hint: t('Formats the description of the file rows shown throughout the Git Map SCM view'), placeholder: '${directory}', example: 'file', exampleDefault: '${directory}', tokens: 'file' }
			]
		},
		{
			id: 'stashes-view', name: t('Stashes View'), group: 'views', icon: 'stash', search: 'git-map.views.stashes', preview: 'stashesView',
			hint: t('The stashes of the Git Map SCM view'),
			controls: [
				{ kind: 'text', key: 'views.stashes.labelFormat', label: t('Stash label format'), placeholder: '${message}', example: 'stash', exampleDefault: '${message}', tokens: 'stash' },
				{ kind: 'text', key: 'views.stashes.descriptionFormat', label: t('Stash description format'), placeholder: '${stashOnRef, }${agoOrDate}', example: 'stash', exampleDefault: '${agoOrDate}', tokens: 'stash' },
				{ kind: 'text', key: 'views.stashes.tooltipFormat', label: t('Stash tooltip format'), placeholder: '${sha}${\' on \'stashOnRef}\\n\\n${agoAndDate} ${message}', example: 'tooltip', exampleDefault: '${sha} ${message}', tokens: 'stash' }
			]
		},

		// Editor
		{
			id: 'current-line', name: t('Inline Blame'), group: 'editor', icon: 'eye', search: 'git-map.blame.currentLine', preview: 'inlineBlame',
			hint: t('Adds an unobtrusive blame annotation at the end of the current line'),
			master: { key: 'blame.currentLine', label: t('Inline Blame') },
			command: { title: t('Git Map: Toggle Current Line Blame'), command: 'git-map.toggleLineBlame' },
			controls: [
				{ kind: 'check', key: 'blame.currentLine.pullRequests.enabled', field: 'currentLinePullRequests', label: t('Show the pull request that introduced the commit (if any)'), enabledWhen: 'blame.currentLine' },
				{ kind: 'info', text: prInfo, boxed: true, visibleWhen: 'blame.currentLine.pullRequests.enabled' },
				{ kind: 'text', key: 'blame.currentLine.format', field: 'currentLineFormat', label: t('Annotation format'), placeholder: '${author, }${agoOrDate}${\' via \'pullRequest}${\' • \'message|50?}', example: 'blame', tokens: 'commit', enabledWhen: 'blame.currentLine' },
				{ kind: 'check', key: 'blame.currentLine.useUncommittedFormat', label: t('Override the format for uncommitted changes'), enabledWhen: 'blame.currentLine' },
				{ kind: 'text', key: 'blame.currentLine.uncommittedFormat', field: 'currentLineUncommittedFormat', label: t('Uncommitted changes format'), placeholder: 'You, Uncommitted changes (${ago})', example: 'uncommitted', tokens: 'commit', indent: 1, enabledWhen: 'blame.currentLine', visibleWhen: 'blame.currentLine.useUncommittedFormat' },
				{ kind: 'text', key: 'blame.currentLine.dateFormat', field: 'currentLineDateFormat', label: t('Date format'), placeholder: t('defaults to the value of "{0}"', 'defaultDateFormat'), example: 'date', tokens: 'date', hint: dateFormatHint, enabledWhen: 'blame.currentLine' },
				{ kind: 'check', key: 'blame.currentLine.scrollable', field: 'currentLineScrollable', label: t('Include the annotation when scrolling the editor horizontally'), hint: t('When on, the annotation can be scrolled into view when it\'s beyond the viewport.'), enabledWhen: 'blame.currentLine' },
				{ kind: 'info', text: t('Turning this off keeps hovers from showing over the annotation; set "git-map.hovers.currentLine.over" to "line" to show them anywhere on the line.'), boxed: true, visibleWhen: 'blame.currentLine.scrollable=false' },
				{ kind: 'check', key: 'blame.ignoreWhitespace', label: t('Ignore changes to whitespace (also in the Status Bar & the File Blame)') }
			]
		},
		{
			id: 'code-lens', name: t('Git CodeLens'), group: 'editor', icon: 'person', search: 'git-map.codeLens', preview: 'codeLens',
			hint: t('Adds the authors of the code as CodeLens, at the top of files and code blocks'),
			master: { key: 'codeLens.enabled', label: t('Git CodeLens') },
			command: { title: t('Git Map: Toggle Git CodeLens'), command: 'git-map.toggleCodeLens' },
			controls: [
				{ kind: 'check', key: 'codeLens.recentChange.enabled', field: 'codeLensRecentChange', label: t('Add the author and date of the most recent change of the file or code block'), enabledWhen: 'codeLens.enabled' },
				{ kind: 'select', key: 'codeLens.recentChange.command', label: t('When clicked'), options: lensCommands, indent: 1, enabledWhen: 'codeLens.enabled & codeLens.recentChange.enabled' },
				{ kind: 'check', key: 'codeLens.authors.enabled', field: 'codeLensAuthors', label: t('Add the number of authors and the most prominent author of the file or code block'), enabledWhen: 'codeLens.enabled' },
				{ kind: 'select', key: 'codeLens.authors.command', label: t('When clicked'), options: lensCommands, indent: 1, enabledWhen: 'codeLens.enabled & codeLens.authors.enabled' },
				{ kind: 'text', key: 'codeLens.dateFormat', label: t('Date format'), placeholder: t('defaults to the value of "{0}"', 'defaultDateFormat'), example: 'date', tokens: 'date', hint: t('Used for absolute dates in the Git CodeLens'), enabledWhen: 'codeLens.enabled' },
				{ kind: 'checkgroup', key: 'codeLens.scopes', label: t('Add the CodeLens to the following scopes'), enabledWhen: 'codeLens.enabled', options: [['document', t('File scope'), t('At the top of the file')], ['containers', t('Containers scope'), t('At the start of modules, classes, interfaces, etc.')], ['blocks', t('Block scope'), t('At the start of functions, methods, etc.')]] }
			]
		},
		{
			id: 'status-bar', name: t('Status Bar Blame'), group: 'editor', icon: 'layout', search: 'git-map.blame.statusBar', preview: 'statusBar',
			hint: t('Adds the blame of the current line to the Status Bar'),
			master: { key: 'blame.statusBar', label: t('Status Bar Blame') },
			controls: [
				{ kind: 'check', key: 'blame.statusBar.pullRequests.enabled', field: 'statusBarPullRequests', label: t('Show the pull request that introduced the commit (if any)'), enabledWhen: 'blame.statusBar' },
				{ kind: 'info', text: prInfo, boxed: true, visibleWhen: 'blame.statusBar.pullRequests.enabled' },
				{ kind: 'text', key: 'blame.statusBar.format', field: 'statusBarFormat', label: t('Annotation format'), placeholder: '${author}, ${agoOrDate}${\' via \'pullRequest}', example: 'blame', tokens: 'commit', enabledWhen: 'blame.statusBar' },
				{ kind: 'text', key: 'blame.statusBar.dateFormat', field: 'statusBarDateFormat', label: t('Date format'), placeholder: t('defaults to the value of "{0}"', 'defaultDateFormat'), example: 'date', tokens: 'date', hint: dateFormatHint, enabledWhen: 'blame.statusBar' },
				{ kind: 'segmented', key: 'blame.statusBar.alignment', field: 'statusBarAlignment', label: t('Position the annotation on the'), options: [['left', t('left')], ['right', t('right')]], enabledWhen: 'blame.statusBar' },
				{ kind: 'select', key: 'blame.statusBar.command', field: 'statusBarCommand', label: t('When clicked'), enabledWhen: 'blame.statusBar', options: [['viewLineHistory', t('shows the history of the line (default)')], ['inspect', t('shows the commit in the Inspect view')], ['viewCommitInGitMap', t('views the commit in Git Map')], ['openLineChanges', t('opens the changes of the commit')], ['viewFileHistory', t('shows the history of the file')], ['toggleFileBlame', t('toggles the File Blame')], ['toggleFileHeatmap', t('toggles the File Heatmap')], ['toggleFileChanges', t('toggles the File Changes')], ['toggleCodeLens', t('toggles the Git CodeLens')]] },
				{ kind: 'check', key: 'blame.statusBar.reduceFlicker', field: 'statusBarReduceFlicker', label: t('Reduce flashing when updating the annotation'), hint: t('Keeps the previous blame while the line changes, to reduce the "flicker" of the Status Bar.'), enabledWhen: 'blame.statusBar' },
				{ kind: 'text', key: 'blame.statusBar.tooltipFormat', label: t('Hover tooltip format'), placeholder: t('format (in Markdown) of the tooltip shown over the blame in the Status Bar'), example: 'blame', tokens: 'commit', enabledWhen: 'blame.statusBar' }
			]
		},
		{
			id: 'hovers', name: t('Hovers'), group: 'editor', icon: 'subject', search: 'git-map.hovers', preview: 'hovers',
			hint: t('Adds the details of the blame, available by hovering'),
			master: { key: 'hovers.enabled', label: t('Hovers') },
			controls: [
				{ kind: 'check', key: 'hovers.autolinks.enabled', field: 'hoversAutolinks', label: t('Show autolinks in commit messages'), enabledWhen: 'hovers.enabled' },
				{ kind: 'check', key: 'hovers.pullRequests.enabled', field: 'hoversPullRequests', label: t('Show the pull request that introduced the commit (if any)'), enabledWhen: 'hovers.enabled' },
				{ kind: 'info', text: prInfo, boxed: true, visibleWhen: 'hovers.pullRequests.enabled' },
				{ kind: 'check', key: 'hovers.currentLine.enabled', field: 'hoversCurrentLineEnabled', label: t('Show hovers for the current line'), enabledWhen: 'hovers.enabled' },
				{ kind: 'select', key: 'hovers.currentLine.over', field: 'hoversCurrentLineOver', label: t('Shown when over the'), options: [['annotation', t('annotation only')], ['line', t('line & annotation')]], indent: 1, enabledWhen: 'hovers.enabled & hovers.currentLine.enabled' },
				{ kind: 'check', key: 'hovers.currentLine.details', field: 'hoversDetails', label: t('Add blame details'), indent: 1, enabledWhen: 'hovers.enabled & hovers.currentLine.enabled' },
				{ kind: 'check', key: 'hovers.currentLine.changes', field: 'hoversChanges', label: t('Add changes (diff)'), indent: 1, enabledWhen: 'hovers.enabled & hovers.currentLine.enabled' },
				{ kind: 'check', key: 'hovers.annotations.enabled', field: 'hoversAnnotations', label: t('Show hovers while annotating'), enabledWhen: 'hovers.enabled' },
				{ kind: 'select', key: 'hovers.annotations.over', label: t('Shown when over the'), options: [['annotation', t('annotation only')], ['line', t('line & annotation')]], indent: 1, enabledWhen: 'hovers.enabled & hovers.annotations.enabled' },
				{ kind: 'check', key: 'hovers.annotations.details', label: t('Add blame details'), indent: 1, enabledWhen: 'hovers.enabled & hovers.annotations.enabled' }
			]
		},
		{
			id: 'file-blame', name: t('File Blame'), group: 'editor', icon: 'blame', search: 'git-map.fileBlame', preview: 'fileBlame',
			hint: t('Adds on-demand blame annotations for the whole file'),
			command: { title: t('Git Map: Toggle File Blame'), command: 'git-map.toggleFileBlame' },
			controls: [
				{ kind: 'select', key: 'fileBlame.toggleMode', field: 'fileBlameToggleMode', label: t('Toggle annotations'), options: toggleModes },
				{ kind: 'text', key: 'fileBlame.format', field: 'fileBlameFormat', label: t('Annotation format'), placeholder: '${date} ${author|16?}', example: 'blame', exampleDefault: '${date} ${author|16?}', tokens: 'commit', hint: t('${token|N-} pads the value to N characters, to align the annotations.') },
				{ kind: 'text', key: 'fileBlame.dateFormat', field: 'fileBlameDateFormat', label: t('Date format'), placeholder: t('defaults to the value of "{0}"', 'defaultDateShortFormat'), example: 'shortDate', tokens: 'date' },
				{ kind: 'number', key: 'fileBlame.delayAfterEdit', field: 'fileBlameDelayAfterEdit', label: t('After unsaved changes, pause recomputing the annotations for (ms)'), hint: t('Smaller delays give a better experience, but have a greater performance impact. Also applies to the inline blame.'), min: 100 },
				{ kind: 'number', key: 'fileBlame.sizeThresholdAfterEdit', field: 'fileBlameSizeThresholdAfterEdit', label: t('After unsaved changes, don\'t recompute the annotations of files with more than (lines)'), hint: t('Files larger than the threshold are only recomputed when they\'re saved. Also applies to the inline blame.'), min: 0 },
				{ kind: 'check', key: 'fileBlame.heatmap.enabled', field: 'fileBlameHeatmap', label: t('Add a heatmap (age) indicator to show how recently the lines changed'), hint: t('The colour of the indicator shows how recent the change is (hot or cold), and its brightness how new it is compared with the other changes.') },
				{ kind: 'segmented', key: 'fileBlame.heatmap.location', field: 'fileBlameHeatmapLocation', label: t('Position the heatmap on the'), options: [['left', t('left')], ['right', t('right')]], indent: 1, enabledWhen: 'fileBlame.heatmap.enabled' },
				{ kind: 'check', key: 'fileBlame.compact', field: 'fileBlameCompact', label: t('Use a compact view'), hint: t('Hides the annotation of the lines that are changed by the same commit as the line above.') },
				{ kind: 'check', key: 'fileBlame.highlight.enabled', field: 'fileBlameHighlightSameCommit', label: t('Highlight the other lines changed by the same commit as the current line') },
				{ kind: 'checkgroup', key: 'fileBlame.highlight.locations', field: 'fileBlameHighlightLocations', label: '', options: locations, indent: 1, enabledWhen: 'fileBlame.highlight.enabled' }
			]
		},
		{
			id: 'file-changes', name: t('File Changes'), group: 'editor', icon: 'diff', search: 'git-map.fileChanges', preview: 'fileChanges',
			hint: t('Adds on-demand annotations of the changes of a file, highlighting the lines changed locally (or by the latest commit)'),
			command: { title: t('Git Map: Toggle File Change Annotations'), command: 'git-map.toggleFileChanges' },
			controls: [
				{ kind: 'select', key: 'fileChanges.toggleMode', field: 'fileChangesToggleMode', label: t('Toggle annotations'), options: toggleModes },
				{ kind: 'checkgroup', key: 'fileChanges.locations', field: 'fileChangesLocations', label: '', options: locations }
			]
		},
		{
			id: 'file-heatmap', name: t('File Heatmap'), group: 'editor', icon: 'history', search: 'git-map.fileHeatmap', preview: 'fileHeatmap',
			hint: t('Adds on-demand heatmap (age) indicators to a file, to show how recently its lines changed'),
			command: { title: t('Git Map: Toggle File Heatmap Annotations'), command: 'git-map.toggleFileHeatmap' },
			controls: [
				{ kind: 'info', text: t('The colour of the indicator shows how recent the change is (hot or cold), and its brightness how new it is compared with the other changes.'), boxed: true },
				{ kind: 'select', key: 'fileHeatmap.toggleMode', field: 'fileHeatmapToggleMode', label: t('Toggle annotations'), options: toggleModes },
				{ kind: 'checkgroup', key: 'fileHeatmap.locations', field: 'fileHeatmapLocations', label: '', options: locations },
				{ kind: 'check', key: 'fileHeatmap.fadeLines', field: 'fileHeatmapFadeLines', label: t('Fade out older lines') },
				{ kind: 'number', key: 'fileHeatmap.ageThreshold', field: 'fileHeatmapAgeThreshold', label: t('Hot / cold threshold (days)'), min: 1 },
				{ kind: 'colour', key: 'fileHeatmap.hotColor', field: 'fileHeatmapHotColor', label: t('Hot colour') },
				{ kind: 'colour', key: 'fileHeatmap.coldColor', field: 'fileHeatmapColdColor', label: t('Cold colour') }
			]
		},
		{
			id: 'editor-modes', name: t('Editor Modes'), group: 'editor', icon: 'palette', search: 'git-map.mode', preview: 'editorModes',
			hint: t('Switch between sets of editor annotations: Zen hides them, Review shows them all'),
			command: { title: t('Git Map: Switch Editor Annotation Mode...'), command: 'git-map.switchMode' },
			controls: [
				{ kind: 'segmented', key: 'mode.active', field: 'activeMode', label: t('Active mode'), options: [['default', t('Default')], ['zen', t('Zen')], ['review', t('Review')]] },
				{ kind: 'check', key: 'mode.statusBar.enabled', label: t('Show the active mode in the Status Bar') }
			]
		},

		// General
		{
			id: 'dates', name: t('Dates & Times'), group: 'general', icon: 'calendar', search: 'git-map.default', preview: 'dates',
			hint: t('Controls how dates and times are formatted and shown throughout Git Map'),
			controls: [
				{ kind: 'check', key: 'defaultDateStyle', field: 'dateStyle', label: t('Allow relative date formatting'), valueOn: 'relative', valueOff: 'absolute' },
				{ kind: 'info', text: t('Shows some dates relatively, e.g. 1 day ago'), boxed: true, visibleWhen: 'defaultDateStyle=relative' },
				{ kind: 'info', text: t('Shows dates absolutely, using the date format below'), boxed: true, visibleWhen: 'defaultDateStyle=absolute' },
				{ kind: 'text', key: 'defaultDateLocale', label: t('Date locale'), placeholder: t('defaults to the language of Git Map'), example: 'locale', hint: t('Use "system" for the locale of the system, or a language tag, e.g. en-US') },
				{ kind: 'text', key: 'defaultDateFormat', label: t('Date format'), placeholder: t('defaults to {0}', 'MMMM Do, YYYY h:mma'), example: 'date', exampleDefault: 'MMMM Do, YYYY h:mma', tokens: 'date', hint: t('Tokens like Moment.js: YYYY MM DD Do HH mm ss, MMM (month), ddd (weekday), A / a (AM / PM), [text].') },
				{ kind: 'text', key: 'defaultDateShortFormat', label: t('Short date format'), placeholder: t('defaults to the short date of the locale'), example: 'shortDate', tokens: 'date' },
				{ kind: 'text', key: 'defaultTimeFormat', label: t('Time format'), placeholder: t('defaults to {0}', 'h:mma'), example: 'time', exampleDefault: 'h:mma', tokens: 'date' },
				{ kind: 'select', key: 'date.type', label: t('Use the'), hint: t('Whether the dates of commits are the dates they were authored or committed'), options: [['Author Date', t('authored date (default)')], ['Commit Date', t('committed date')]] }
			]
		},
		{
			id: 'menus', name: t('Menus & Toolbars'), group: 'general', icon: 'menus', search: 'git-map.menus', preview: 'menus',
			hint: t('Adds many helpful commands to the built-in menus & toolbars'),
			master: { key: '#menus', label: t('Menus & Toolbars') },
			controls: [
				{ kind: 'check', key: 'menus.editor.enabled', label: t('Add to the editor context menu'), enabledWhen: '#menus' },
				{ kind: 'custom', id: 'editorContextMenu', label: t('Editor context menu') },
				{ kind: 'check', key: 'menus.editorGutter.enabled', label: t('Add to the context menu of the editor\'s line numbers (gutter)'), enabledWhen: '#menus' },
				{ kind: 'check', key: 'menus.editorGutter.lineHistory', label: t('Add View Line History'), indent: 1, enabledWhen: 'menus.editorGutter.enabled' },
				{ kind: 'check', key: 'menus.editorGutter.remote', label: t('Add Copy Remote Link & Open on Remote'), indent: 1, enabledWhen: 'menus.editorGutter.enabled' },
				{ kind: 'check', key: 'menus.editorTab.enabled', label: t('Add to the editor tab context menu'), enabledWhen: '#menus' },
				{ kind: 'check', key: 'menus.editorTab.fileHistory', label: t('Add View File History in Git Map'), indent: 1, enabledWhen: 'menus.editorTab.enabled' },
				{ kind: 'check', key: 'menus.editorTab.timeMachine', label: t('Add File Time Machine'), indent: 1, enabledWhen: 'menus.editorTab.enabled' },
				{ kind: 'check', key: 'menus.editorTab.visualHistory', label: t('Add Visual File History'), indent: 1, enabledWhen: 'menus.editorTab.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.enabled', label: t('Add to the editor group toolbar'), enabledWhen: '#menus' },
				{ kind: 'check', key: 'menus.editorGroup.revisionNavigation', label: t('Add revision history navigation commands'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.diffMode', label: t('Add the Changes Only / Full File toggle of diffs'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.openFile', label: t('Add Open File to diffs'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.timeMachine', label: t('Add File Time Machine'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.conflictAssistant', label: t('Add Conflict Assistant to files with conflicts'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'check', key: 'menus.editorGroup.fileAnnotations', label: t('Add a File Annotations submenu or command'), indent: 1, enabledWhen: 'menus.editorGroup.enabled' },
				{ kind: 'select', key: 'fileAnnotations.command', label: t('Add'), indent: 2, enabledWhen: 'menus.editorGroup.enabled & menus.editorGroup.fileAnnotations', options: [['submenu', t('File Annotations submenu')], ['blame', t('Toggle File Blame command')], ['heatmap', t('Toggle File Heatmap command')], ['changes', t('Toggle File Changes command')]] },
				{ kind: 'check', key: 'menus.explorer.enabled', label: t('Add to the Explorer items context menu'), enabledWhen: '#menus' },
				{ kind: 'check', key: 'menus.explorer.fileHistory', label: t('Add View File History in Git Map'), indent: 1, enabledWhen: 'menus.explorer.enabled' },
				{ kind: 'check', key: 'menus.explorer.folderHistory', label: t('Add View Folder History & Visual Folder History'), indent: 1, enabledWhen: 'menus.explorer.enabled' },
				{ kind: 'check', key: 'menus.explorer.visualHistory', label: t('Add Visual File History'), indent: 1, enabledWhen: 'menus.explorer.enabled' },
				{ kind: 'check', key: 'menus.explorer.timeMachine', label: t('Add File Time Machine'), indent: 1, enabledWhen: 'menus.explorer.enabled' },
				{ kind: 'check', key: 'menus.explorer.removeFromHistory', label: t('Add Remove Files from History'), indent: 1, enabledWhen: 'menus.explorer.enabled' },
				{ kind: 'check', key: 'menus.scm.enabled', label: t('Add to the Source Control toolbar & menu'), enabledWhen: '#menus' },
				{ kind: 'check', key: 'menus.scm.view', label: t('Add View Git Map'), indent: 1, enabledWhen: 'menus.scm.enabled' },
				{ kind: 'select', key: 'sourceCodeProviderIntegrationLocation', label: t('Show it'), indent: 2, enabledWhen: 'menus.scm.enabled & menus.scm.view', options: [['Inline', t('in the toolbar (default)')], ['More Actions', t('in the More Actions menu')]] },
				{ kind: 'check', key: 'menus.scm.generateCommitMessage', label: t('Add Generate Commit Message with AI'), indent: 1, enabledWhen: 'menus.scm.enabled' },
				{ kind: 'check', key: 'menus.scm.reviewChanges', label: t('Add AI Review Uncommitted Changes'), indent: 1, enabledWhen: 'menus.scm.enabled' },
				{ kind: 'check', key: 'menus.scm.explainChanges', label: t('Add Explain Changes with AI'), indent: 1, enabledWhen: 'menus.scm.enabled' },
				{ kind: 'check', key: 'menus.scm.conflictAssistant', label: t('Add Conflict Assistant'), indent: 1, enabledWhen: 'menus.scm.enabled' },
				{ kind: 'check', key: 'menus.scm.reflogExplorer', label: t('Add Visual Reflog Explorer'), indent: 1, enabledWhen: 'menus.scm.enabled' }
			]
		},
		{
			id: 'language', name: t('Language'), group: 'general', icon: 'globe', search: 'git-map.language',
			hint: t('The language Git Map is displayed in'),
			controls: [{ kind: 'custom', id: 'language', label: t('Language') }]
		},
		{
			id: 'status-bar-item', name: t('Status Bar'), group: 'general', icon: 'layout', search: 'git-map.statusBarItem', preview: 'statusBarItems',
			hint: t('The items Git Map adds to the Status Bar'),
			controls: [
				{ kind: 'check', key: 'showStatusBarItem', label: t('Show the Git Map item, which opens the Git Map View') },
				{ kind: 'custom', id: 'statusBarItem', label: t('Status Bar Item') },
				{ kind: 'check', key: 'blame.statusBar', field: 'statusBarEnabled', label: t('Show the blame of the current line (Status Bar Blame)'), previewBadge: 'statusBarBlame' },
				{ kind: 'check', key: 'launchpad.indicator.enabled', label: t('Show the Launchpad indicator of the pull requests needing your attention'), hint: t('Shown only when the PR & CI status badges (Cloud Integrations) are turned on'), previewBadge: 'statusBarLaunchpad' },
				{ kind: 'check', key: 'mode.statusBar.enabled', label: t('Show the active editor mode'), previewBadge: 'statusBarMode' },
				{ kind: 'segmented', key: 'ui.iconColorStyle', label: t('Icon colour style'), hint: t('AI & Coding Agent icons stay colourful in both modes. Status Bar uses multi-colour icons with high-contrast text.'), options: [['monochrome', t('Monochrome')], ['colorful', t('Colorful')]] }
			]
		}
	];
}

/**
 * The setting keys of the location switches of the menus (the switch of "Menus & Toolbars" turns all of them on or off).
 */
const SETTINGS_MENU_LOCATIONS: ReadonlyArray<string> = ['menus.editor.enabled', 'menus.editorGutter.enabled', 'menus.editorTab.enabled', 'menus.editorGroup.enabled', 'menus.explorer.enabled', 'menus.scm.enabled'];
