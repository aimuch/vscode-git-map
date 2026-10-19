# Change Log

## 2.2.0 - Unreleased
This release brings the history of code into the editor: the history of lines in a drawer or an inline window, how a commit changed the current line, a heatmap of who changed each part of a file, revisions of a file, and links to lines on the remote. Everything uses only Visual Studio Code's API and Git (no other extension is required). All changes are covered by the end-to-end test suite (`npm run test-e2e`, 81 checks, verified with Visual Studio Code 1.142.0), which also takes screenshots of the Visual Studio Code workbench.
* Line History (right-click on lines > Git Map > View Line History, or the Command Palette) shows how the selected lines changed, without leaving the editor:
    * In a drawer on the right (a view in the Secondary Side Bar), or an inline window below the lines (using the Comments API), chosen with the new `git-map.lineHistory.location` setting and the buttons of both. The drawer is shown in the Explorer before Visual Studio Code 1.106, and the first time the inline window is shown in a window, Visual Studio Code may open its Comments panel (`comments.openView`).
    * A timeline of the uncommitted changes & each commit that changed the lines (following them as they move, and the file through renames), with the author, their avatar (or initial) and the date. The drawer shows the selected change beside the timeline (or below it, when it's narrow): its commit, and the diff of the lines with their line numbers.
    * Actions (with icons, and tooltips explaining them): open the changes (selecting the lines), open the file at the commit, show the lines before the change, view the commit in Git Map, copy a permanent link to the lines on the remote, and open the commit on the remote.
    * Escape closes what Git Map showed most recently, returning to how it was before: the inline window, the drawer (back to the editor), or the File Blame of the file in the active editor. The keybinding leaves Escape's other uses in the editor alone (selections, widgets, suggestions).
    * The drawer can follow the cursor (the new `git-map.lineHistory.followCursor` setting), load more commits, and open the history in the Git Map View ("View Line History in Git Map" still opens it directly).
    * The selected lines of an editor with uncommitted changes are mapped to the same lines in HEAD (comparing the editor's contents with HEAD), including a changed line's previous version, so the history is of the right lines (this also fixes "View Line History in Git Map").
* The hover of the blame of the current line shows how the commit changed the line, with links to view the history of the line, open the changes, view the commit in Git Map, and copy a link to the line on the remote.
* Toggle File Blame: a column on the left of the lines shows the date & author of the commit that last changed each block of lines, coloured by how recently it was made (a heatmap from blue, the oldest commit of the file, to orange, the newest and the uncommitted changes). Hovering over it shows the commit. The annotations follow the lines as the file is changed.
* Show Previous / Next Revision (the arrow buttons of the diffs & files opened by Git Map, and "Show Previous Revision" in a file's editor) step through the commits that changed a file, following it through renames, ending with the uncommitted changes.
* Copy Remote Link to Lines / Open Lines on Remote: a permanent link to the selected lines at HEAD on the remote's web page (GitHub, GitLab, Bitbucket, Gitea / Forgejo / Codeberg, Azure DevOps, and GitHub-style links for other hosts), with a warning if the commit isn't on the remote yet.
* Git CodeLens (the new `git-map.codeLens.enabled` setting, off by default): who changed each function, method & class most recently (and when), and how many authors changed it, shown above it. Clicking it shows the history of its lines.
* The Git Map items of the editor's context menu are in a "Git Map" submenu: View Line History, View Line History in Git Map, View File History in Git Map, Toggle File Blame, Toggle Current Line Blame, Show Previous Revision, Copy Remote Link to Lines & Open Lines on Remote. The new `git-map.editorContextMenu` setting puts each of them in the submenu (default), directly in the context menu, or hides it.
* "View File History in Git Map" selects (and opens the details of) the commit that last changed the line the cursor is on, or the latest commit that changed the file. "View Line History in Git Map" selects the latest commit that changed the lines.
* File icon themes are loaded again if their definition can't be read when the Git Map View asks for it (e.g. vscode-icons writes its definition when it starts), and again when it changes, so files no longer keep the built-in icons until the view is reopened. Failures are logged in the Git Map Output. The built-in icons (used when there's no file icon theme) are bigger.
* "Toggle Current Line Blame" reports whether the blame is shown, changes the workspace's setting if it overrides the user's, and explains that the blame still shown is GitLens' if GitLens also shows the blame of the current line.

## 2.1.0 - Unreleased
This release completes the redesign of the Git Map View (its control bar, commits, Commit Details View, Repository Settings, dialogs, menus & minimap), and adds the history of files & lines, the blame of the current line, lists of the stashes & worktrees, selecting several commits, undoing the last action, a Rebase Editor, and the icons of files from the Visual Studio Code file icon theme. The Git Map View stays fast with tens of thousands of commits. All changes are covered by the end-to-end test suite (`npm run test-e2e`, 71 checks, verified with Visual Studio Code 1.142.0).
* Git Map's commands & settings are named `git-map.*` instead of `git-graph.*` (as are its context key, the URI scheme of its diffs & its Status Bar icon), so that it can be installed alongside the original Git Graph extension:
    * When Git Map starts, the settings named `git-graph.*` (including their legacy names, e.g. `git-graph.dateFormat`) are copied to their new names in the same scope, once for the user settings and once for each workspace. Settings that are already set under their new names are kept.
    * A notification says how many settings were copied, and offers to remove the `git-graph.*` settings (unless Git Graph is installed, which still uses them).
    * Keybindings in `keybindings.json` that run `git-graph.*` commands need to be changed to the `git-map.*` commands by hand.
    * The Repository Configuration file (`.vscode/vscode-git-graph.json`) keeps its name, so it's shared with Git Graph.
* Control bar:
    * The Repo (also shown when there's only one repository), Branches & Authors dropdowns show icons. Dropdowns that allow multiple selections show a checkbox for each option, and the Authors dropdown shows each author's initial and the number of loaded commits by them.
    * The search box is part of the control bar. Conditions are added to it as chips (press Enter), and a bar below it shows the number of matching commits, the previous / next match, whether the matches are highlighted or only the matching commits are shown (keeping the graph connected), buttons that insert the search operators, and "Clear Search".
    * New search operators: `file:` (or `?:`) finds the commits that change a file whose path contains the value, and `change:` (or `~:`) finds the commits that add or remove a line containing it.
    * New "HEAD" button, and Fetch / Pull / Push buttons that show how many commits the current branch is behind / ahead of its upstream branch (Pull & Push open the existing dialogs for the current branch).
    * New Stashes button (shown when the repository has stashes), listing each stash with its branch, date, the number of files & lines it changes, and whether it includes untracked files. Stashes can be applied, popped or dropped from the list, and clicking on a stash scrolls to it and opens its details (loading more commits if required).
    * New search operators `after:` (or `>:`) and `before:` (or `<:`), finding the commits on or after / before a date (the date shown in the Date column): YYYY-MM-DD, YYYY-MM, YYYY, today, yesterday, or a number of days, weeks, months or years ago (e.g. 7d, 2w, 3m, 1y). An invalid date is reported.
    * New Worktrees button (shown when the repository has more than one worktree), listing its worktrees: their branch (or detached HEAD), folder, and whether they're the main / current worktree, locked, or their folder no longer exists. Worktrees can be opened in a new window, removed (after confirming, only forced if chosen) and pruned, and clicking on a worktree goes to the commit checked out in it. "Create Worktree..." is added to the context menus of branches (checking out the branch) and commits (with a new branch, or a detached HEAD), with the new `git-graph.contextMenuActionsVisibility` options `branch.createWorktree` & `commit.createWorktree`.
    * New Undo button, shown after an action that can be undone (with a notification for a few seconds), which undoes it after confirming. Merge, rebase, cherry pick, revert, reset, drop, pull & checkout move the current branch back with `git reset --keep` (or check out the previous branch / commit), so uncommitted changes are never discarded. Created branches & tags are deleted, deleted branches & tags are restored to the same commit / tag object (with the branch's upstream), renamed branches are renamed back, and dropped stashes are stored again. An action can only be undone if the repository hasn't changed since, and not while an operation is in progress. Only the local repository is changed.
    * While a rebase, merge, cherry pick or revert is in progress (e.g. stopped because of conflicts), a bar below the control bar explains it, with buttons to open the Source Control View, and continue (or commit the merge), skip the commit or abort it.
* Commits:
    * New default `git-graph.referenceLabels.alignment` option "Branches & Tags (in a separate column)": branch, tag & stash labels are shown in a "Branches / Tags" column on the left of the graph. The checked out branch has a check icon, remote branches have a cloud icon (also shown on a local branch whose remote branch is on the same commit), and local branches show how many commits they're ahead (↑) / behind (↓) their upstream branch. Set the option to "Normal" to show the labels in the Description column as before.
    * New "Changes" column, showing the lines added & deleted by each commit (merge commits are compared to their first parent), loaded on demand for the commits that are shown. Columns can be shown or hidden with the new button in the column headers (or their context menu).
    * The selected commit uses the list selection colour of the theme, the uncommitted changes are muted & italic, and a footer shows the number of commits loaded / shown, a legend of the markers alongside the scrollbar, and the "Load More Commits" button.
    * The Branches / Tags column can be resized by dragging the edge of its header (the width is remembered for each repository, and double-clicking the edge resets it). Labels that don't fit are truncated: the first label (e.g. the checked out branch) keeps most of the width, the other labels can be truncated to their icon, labels cut off by the edge of the column fade out, and the tooltip of the cell lists all of them.
    * The column headers & the footer stay visible while scrolling through the commits. They can be unfrozen with the new `git-graph.graph.freezeColumnHeaders` & `git-graph.graph.freezeFooter` settings (also in the column menu & the Repository Settings panel).
    * When the lanes of the graph don't fit in the Graph column, they're moved closer together (down to a minimum spacing), so commits on the rightmost lanes are no longer cut off.
    * New `git-graph.graph.density` setting: Comfortable (32 pixel rows, the default) or Compact (24 pixel rows).
    * New `git-graph.graph.nodeStyle` setting: commits are drawn on the graph as dots (the default), or as the avatar of their author (when avatars are fetched, otherwise their initial) in a circle outlined in the colour of their branch.
    * Commits that match the search have a marker on their left edge.
    * Several commits can be selected: Shift + click selects the commits from the commit whose details are open (or the first commit selected), and Ctrl / Cmd + Shift + click adds or removes a commit. The footer shows the number of selected commits (with Cherry Pick, Copy Hashes & Clear Selection), and the context menu of a selected commit acts on all of them. The selected commits are cherry picked together, oldest first.
    * Hovering over a commit shows buttons of its most common actions at the end of its row: Create Branch, Checkout, Cherry Pick, Copy Commit Hash & More Actions (the commit's context menu).
    * The labels of branches that are checked out in other worktrees are marked (with the worktree in their tooltip).
    * Each author's avatar is included once in the graph, instead of once for each of their commits.
    * When more than 2000 commits are loaded, only the rows near the view are rendered (the other rows are replaced by spacers of the same height). Loading 10,000 commits takes 0.24 seconds instead of 1.1 seconds, and scrolling stays smooth (19 ms frames instead of 140 ms, at the 95th percentile). A repository of 2,877 commits is rendered with 6,000 elements instead of 36,700. Finding, going to a commit, keyboard navigation and the scrollbar markers work on all of the commits.
* Rebase Editor: the "Interactive Rebase" option of the Rebase dialog opens the Rebase Editor (instead of a terminal). The commits that are rebased (oldest first) can be reordered (dragged, or moved with their buttons), and each one picked, reworded (editing its full message), squashed, fixed up or dropped. The rebase is run by the extension: no editor is opened by Git, and the base is resolved to a commit hash and new messages are read from files, so branch names & messages are never run by a shell. The rebase can still be run in a terminal from the editor.
* Commit Details View (docked to the right):
    * A header with the previous / next commit & close buttons, the author with the relative & exact date of the commit, chips to copy the commit hash, open the commit on its remote (GitHub, GitLab, Bitbucket & similar hosts) and compare it with another commit, the related issues, the branches containing the commit, and the number of files & lines it changes.
    * The changed files & the full commit message (with its details) are shown in tabs, in one scrolling column. Files show a badge of their type of change, their directory (in the list view), and a bar of the lines added & deleted.
* Files & folders show their icons from the file icon theme of Visual Studio Code (`workbench.iconTheme`, e.g. Seti or Material Icon Theme), as in its Explorer. Built-in icons of common file types are used if no file icon theme is used.
* Line history: the new "View Line History in Git Map" command (in the context menu of editors, and the Command Palette) shows the commits that change the selected lines (following them as they move, and the file through renames, from HEAD or the selected branch), with the graph kept connected, and how each commit changes the lines.
* Current line blame: the line the cursor is on shows who last changed it, and when & why (the author, date & subject of the commit), at its end (the new `git-graph.blame.currentLine` setting, on by default, and the "Git Map: Toggle Current Line Blame" command). The contents of the editor are blamed, so the lines of files with uncommitted changes match. Hovering over it shows the commit, with a link that opens it in the Git Map View.
* File history: the new "View File History in Git Map" command (in the context menus of files in the Explorer, editor tabs & the Commit Details View, and the Command Palette) shows only the commits that change a file, following it through renames:
    * A bar shows the file, the number of commits, authors & renames, and whether the history of all branches or only the current branch is shown, with buttons to open the file and exit the history.
    * A "Changes to this File" column shows the lines each commit adds & deletes in the file, and the commit that renamed the file shows its previous path.
    * The Commit Details View focuses on the file: its changes in the commit with a preview of the diff, and buttons to open the diff, open the file at the commit, or view the whole commit.
* Repository Settings is a panel on the right of the view: the appearance settings that apply to all repositories (graph colour presets, line style, row density, commit nodes, frozen column headers & footer, language & Status Bar Item display), the repository's display options, and cards for Issue Linking, Remotes, General settings, User Details & Pull Request Creation.
* Dialogs show their message as a title, followed by the commit they're for, with the labels of inputs above them and the buttons on the right (Cancel, then the action). Context menus show keyboard shortcuts: Ctrl/Cmd+C copies the hash of the commit whose context menu is open, or whose details are shown.
* Minimap:
    * A legend explains the box of the commits in view and the HEAD, branch & tag markers. The box is only outlined (with a tooltip of the dates & number of commits in view), the bars in it are highlighted, and long histories use weeks, months or years, with as many short labels on the axis as fit.
    * The minimap can be zoomed in on a range of dates with its zoom buttons, or Ctrl / Cmd + scrolling (or pinching), and its bars & axis change to days, weeks or months as needed. When zoomed in, it can be panned by dragging it or scrolling horizontally, and it follows the commits in view as the view is scrolled.
    * Dragging the box of the commits in view scrolls the view, and dragging the bottom edge of the minimap changes its height (remembered for all repositories).
    * The commits that match the search are marked below their bars, and while it's zoomed in, its new search button finds the commits in the range of dates it shows.
    * Zooming & panning renders the minimap at most once a frame, and its zoom buttons can be focused & used with the keyboard (with labels for screen readers).

## 2.0.1 - Unreleased
This release continues development from the last upstream release (1.30.0), adapting Git Graph to the latest versions of Visual Studio Code, and fixing reported issues. All fixes are covered by the new end-to-end test suite (`npm run test-e2e`), which runs Git Graph in a real instance of Visual Studio Code (verified with Visual Studio Code 1.141.2 & 1.142.0). The major version is incremented to distinguish this fork's releases from the upstream 1.x releases.
* The extension is named Git Map: the Status Bar Item, the title of the view's tab, the commands ("Git Map: ..."), the category of its settings, and its messages use the new name. The identifiers of its commands & settings (`git-graph.*`) are unchanged, so existing settings keep working.
* Redesigned Git Graph View:
    * The control bar stays at the top of the view while scrolling. The Repo / Branches / Authors dropdowns show their label inside the dropdown, and are highlighted while they filter the commits. New "Jump to HEAD" button.
    * Taller rows, rounded branch & tag labels tinted with the colour of their branch (dashed for remote branches), author initials (when avatars aren't fetched), and the commit hash in a monospace font. Colours follow the Visual Studio Code theme (list, button, input & widget colours).
    * The Commit Details View is docked to the right of the view by default (new "Docked to Right" option of `git-graph.commitDetailsView.location`, which is resizable), with the author, subject & body above the commit's details, and buttons for the most common actions (Checkout, Create Branch, Cherry Pick, and all others).
    * Restyled dialogs, context menus, dropdowns, the Find Widget & Repository Settings.
* Features inspired by [GitLens](https://github.com/gitkraken/vscode-gitlens) (no GitLens code is used):
    * Minimap of the activity of the loaded commits at the top of the view (the number of commits each day, where HEAD, branches & tags are, and the visible commits). Clicking on a day scrolls to its commits. It can be hidden with the new `git-graph.graph.minimap` setting.
    * Markers alongside the scrollbar, showing where HEAD, branches, tags, stashes & find matches are in the loaded commits.
    * Hovering over a commit highlights the branch it is on in the graph.
    * Search operators in the Find Widget: `author:` (or `@:`), `message:` (or `=:`) and `commit:` (or `#:`), which can be combined with each other and with text to find.
* Visual Studio Code compatibility:
    * #903, #871 The "View Git Graph" action is contributed to the new `scm/repository` menu, so that it's displayed on each repository in the Source Control Repositories View again.
    * Git Graph is activated once Visual Studio Code has finished starting up (`onStartupFinished`), instead of on every startup event (`*`).
    * #928 Tooltips (e.g. the (i) icons on dialogs) are now displayed by Git Graph, as Visual Studio Code doesn't reliably show the native tooltips of elements in Webviews.
    * Replaced the deprecated Node.js `url.parse()` API (which logs a deprecation warning in the Node.js versions used by recent Visual Studio Code releases).
    * The minimum supported version of Visual Studio Code is now 1.85.0.
* #940 Security: Interactive Rebase no longer includes the branch name in the command run by the shell of the Integrated Terminal (it is resolved to a commit hash first). Previously a branch name containing shell syntax (e.g. from a cloned repository) could execute arbitrary commands.
* #935, #880, #641 Commits with a raw carriage return (CR) character in their subject no longer prevent all older commits from being loaded. This is also the likely cause of #930 (in PowerShell, `` `r `` in a commit message is a CR character).
* #794 The "View Git Graph" action no longer fails with "Cannot read properties of null (reading 'rootUri')".
* #932 An existing `GIT_ASKPASS` program (e.g. provided by a remote development environment) is now used for authentication, instead of being replaced by Git Graph's integrated Askpass.
* #708 Tags and branches that have the same name can now be pushed to, and deleted from remotes (fully qualified references are used).
* #789, #668 The Git Graph View now automatically refreshes for submodules and worktrees when they're changed outside of Visual Studio Code (their Git directory, which is outside of the repository, is now also watched).
* #892, #834 The second keypress of a keybinding chord (e.g. Ctrl+K Ctrl+S) is no longer handled by Git Graph's keyboard shortcuts, so Visual Studio Code keybinding chords work when the Git Graph View is focused. Git Graph's keyboard shortcuts are not handled within 1.5 seconds of a Ctrl / Cmd keybinding that Git Graph doesn't handle.
* #856 Pasting a name into a dialog using the mouse now enables the dialog's action button (e.g. "Create Branch").
* #652 The buttons on dialogs can now be focused with the Tab key (after the dialog's inputs), and triggered with Enter or Space.
* #792 Issue links that use a custom URL scheme (e.g. `linear://`) can now be opened by clicking on them.
* #707 When adding Issue Linking, the Issue URL is prefilled for repositories hosted on GitHub, GitLab & Bitbucket, and the example no longer refers to a placeholder repository that users copied by mistake.
* #723 Renamed files display their original name in the Commit Details View.
* #857 The "Scroll to HEAD" keyboard shortcut loads more commits until the commit referenced by HEAD has been loaded (when all branches, or the checked out branch, are shown).
* #852 The mouse back & forward buttons navigate the Visual Studio Code editor history when used on the Git Graph View (if `workbench.editor.mouseBackForwardToNavigate` is enabled).
* #864 The Menu key / Shift+F10 opens the context menu of the commit selected with the keyboard.
* #171, #727 New "Authors" dropdown on the Git Graph View, to only show the commits of the selected author(s). The dropdown lists the authors of the commits loaded in the repository.
* #775 New `git-graph.graph.colourPreset` setting & "Git Graph: Select Graph Colour Preset..." command, to choose the colours of the graph from presets: Default (`git-graph.graph.colours`), Pastel, Vivid, High Contrast, Colour Blind Safe and Tokyo Subway. The open Git Graph View is re-rendered immediately when the colours change.
* Simplified Chinese: Git Graph is displayed in Simplified Chinese when it's the display language of Visual Studio Code, or when it's selected with the new `git-graph.language` setting (Auto, English or Simplified Chinese). This includes the Git Graph View (control bar, columns, dates, context menus, dialogs, Commit Details View & Repository Settings), messages & prompts, the Status Bar Item, and the descriptions of commands & settings (`package.nls.zh-cn.json`, which follows the display language of Visual Studio Code). The open Git Graph View is re-rendered immediately when the language changes. `npm run lint` checks that every message has a translation.
* New `git-graph.statusBarItemDisplay` setting, to display the Git Graph icon and "Git Graph" (default), only the icon, or only the text on the Status Bar Item. The icon is the Git Graph logo (contributed as the `git-graph-logo` product icon).
* #719 Development: The project builds again on current Node.js versions: TypeScript 5.9, ESLint 10 (flat config), Jest 30, and `@vscode/vsce` (installed as a dev dependency).
* This fork is maintained at [aimuch/vscode-git-map](https://github.com/aimuch/vscode-git-map), and is published as Git Map (`aimdev.git-map`): the publisher, author, repository & issue links refer to it, and installation instructions replace the Visual Studio Marketplace link. Uninstall the original extension (`mhutchie.git-graph`) before installing it. The demo recording is now included in the package, so it's displayed on the extension's details page.
* Removed the anonymous install / update / uninstall events that were sent to the original author's API (`api.mhutchie.com`). Git Graph no longer makes any network requests other than the ones you use it for (e.g. Git commands, avatars).

## 1.30.0 - 2021-04-05
* #395 Added a "Force Fetch" option onto the "Fetch into Local Branch" Dialog, allowing any local branch (that's not checked out) to be reset to the remote branch. This dialog is accessed via the Remote Branch Context Menu.
* #457 New "View Diff with Working File" action on the File Context Menu in the Commit Details View.
* #466 New "Copy Relative File Path to Clipboard" action on the File Context Menu in the Commit Details View.
* #471 Spaces can be automatically substituted with hyphens or underscores in reference inputs on dialogs (e.g. Create Branch, Add Tag, etc.), by configuring the new extension setting `git-graph.dialog.general.referenceInputSpaceSubstitution`.
* #476 "Open File" action is now available in the Visual Studio Code Diff View Title Menu, when the Diff View is opened from the Git Graph View. (Requires Visual Studio Code >= 1.42.0)
* #479 New Repository Dropdown Order option "Workspace Full Path", that sorts repositories according to the Visual Studio Code Workspace Folder order, then alphabetically by the full path of the repository. This is the new default order for the `git-graph.repositoryDropdownOrder` extension setting.
* #480 When loading the Working File for a file from a historical commit, and the file has since been renamed, Git is now used to detect renames and enable the Working File to be opened. For example: from the "Open File" & "View Diff with Working File" actions on the File Context Menu in the Commit Details View.
* #482 New "Mark as Reviewed" & "Mark as Not Reviewed" actions on the File Context Menu in the Commit Details View, when a Code Review is in progress. Thanks [Dan Arad (@dan1994)](https://github.com/dan1994) for implementing this!
* #486 All Git Graph View Keyboard Shortcut extension settings can now alternatively be set to "UNASSIGNED", if you don't want to have a keybinding for a specific Keyboard Shortcut.
* #491 Standardise the cross-platform rendering of Markdown inline code blocks, to ensure they don't affect the height of each commit.
* Various code improvements.

## 1.29.0 - 2021-02-28
* #390 When creating a branch or adding a tag, the name is now checked against all existing branches and tags in the repository. If a branch / tag already exists with the same name, a new dialog is displayed that allows you to: replace the existing branch / tag, or to choose another name.
* #402 New mode for the Find Widget, which will additionally open the Commit Details View as you navigate through each of the matched commits. This mode is enabled / disabled via a new button on the Find Widget.
* #404 New context menu on all link elements (e.g. Issue Links, URL's in commit messages, author email addresses), enabling the URL to be copied to the clipboard.
* #417 New context menu actions for branches, to select / unselect the branch in the Branches Dropdown.
* #424 Consume Git configuration variables (`remote.pushDefault`, `branch.<name>.remote` & `branch.<name>.pushRemote`) to set the default remote to push branches and tags to (when multiple remotes are configured for a repository).
* #426 If a diff tool is configured in Git (`diff.tool` or `diff.guitool`), you can now open a directory diff in the configured tool from the Commit Details View Control Bar. Note: `diff.tool` is opened via a Visual Studio Code Terminal, whereas `diff.guitool` is opened via a background process.
* #427 When deleting a branch that is not fully merged, and "Force Delete" is not set on the "Delete Branch" dialog, a new dialog is subsequently shown to allow one-click force deletion, instead of displaying the error message returned by Git.
* #429 Stashes can be hidden on the Git Graph View by disabling the new extension setting `git-graph.repository.showStashes`. It can be overridden per repository in the Git Graph View's Repository Settings Widget.
* #452 Explicitly override the Git configuration variable `log.showSignature` to ensure consistent parsing of commits.
* Significant code and UI improvements.

## 1.28.0 - 2020-12-01
* #399 Sign Commits and Tags created by actions in the Git Graph View, by enabling the new extension settings `git-graph.repository.sign.commits` and `git-graph.repository.sign.tags` respectively. This is an alternative to the existing method using Git config (`commit.gpgSign` and `tag.gpgSign`).
* #406 The keybindings for all Git Graph View keyboard shortcuts can now be configured using new extension settings `git-graph.keyboardShortcut.*`.
* #407 Control whether Remote Head Symbolic References (e.g. origin/HEAD) are displayed in Git Graph via the new extension setting `git-graph.repository.showRemoteHeads`. Thanks [Maciej Wilk (@wilkmaciej)](https://github.com/wilkmaciej) for helping with this!
* #409 Include built-in support for new emoji shortcodes recently added to [gitmoji](https://gitmoji.carloscuesta.me/).
* #412 New "Git Graph: Fetch from Remote(s)" command contributed to Visual Studio Code, that opens the Git Graph View and immediately runs "Fetch from Remote(s)".
* #414 Your Git Graph Repository Configuration can now be exported to a file that can be committed in the repository. It allows others working in the same repository to automatically use the same Git Graph configuration. To export your configuration, click the "Export Repository Configuration" button at the bottom of the Repository Settings Widget (on the Git Graph View).
* #416 The existing file encoding extension setting `git-graph.fileEncoding` can now also be configured at a Workspace Folder Scope.
* #419 On dialogs that refer to the "current branch" (Merge, Pull, Rebase, and Reset), the current branch is now explicitly mentioned.
* #420 Fixed an issue that prevented files that overflow horizontally in the Commit Details View Files View from being left-clicked (i.e. those shortened with an ellipsis). _(issue introduced via #381)_
* Significant code improvements.

## 1.27.0 - 2020-11-01
* #281 For the Repository Settings Widget, read values defined in additional Git config files when they're included via [include directives](https://git-scm.com/docs/git-config#_includes) in local or global Git config files.
* #364 Parse and render a frequently used subset of inline Markdown formatting rules in commit messages and tag details (bold, italics, bold & italics, and inline code blocks). Markdown parsing can be disabled using the extension setting `git-graph.markdown`.
* #381 New Commit Details View File Context Menu, which is an alternative method to run any available actions on a file ("View Diff", "View File at this Revision", "Open File", and "Copy File Path to the Clipboard").
* #383 When the Commit Details View is open, the `CTRL/CMD + Up` / `CTRL/CMD + Down` keystrokes may be used to navigate topologically to the child / parent on the same branch (the existing behaviour). Now there is a new Shift Key Modifier, that when pressed in combination with the existing keystrokes (i.e. `CTRL/CMD + SHIFT + Up` / `CTRL/CMD + SHIFT + Down`), will follow the alternative branch when a branch or a merge is encountered.
* #385 Push branches or tags to multiple remotes from their respective dialogs.
* #386 Detect commit hashes in the body of the commit that's displayed in the Commit Details View, and make them clickable links that open the Commit Details View for the referenced commit.
* #389 Use the Visual Studio Code Color Theme's text selection background colour (set by some themes and users) in the Git Graph View.
* #392 Support Visual Studio Code's `git.path` Setting containing an array of possible Git executable paths (introduced in Visual Studio Code 1.50.0).
* #393 New display option for the Uncommitted Changes in the graph. This is controlled by the new extension setting `git-graph.graph.uncommittedChanges`.
    * Open Circle at the Uncommitted Changes: Display the Uncommitted Changes as a grey open circle, connected to the commit referenced by HEAD with a solid grey line. The current file system's state is therefore always displayed as an open circle in the graph. *(the existing behaviour)*
    * Open Circle at the Checked Out Commit: Display the Uncommitted Changes as a grey closed circle, connected to the commit referenced by HEAD with a dotted grey line. The commit referenced by HEAD is therefore always displayed as an open circle in the graph. *(the new option)*
* #398 New command "Git Graph: Get Version Information", that displays basic version information of the Git Graph installation, and allows it to be easily copied to the clipboard.
* Various code improvements.

## 1.26.0 - 2020-09-13
* #318 Customise the branches that are initially shown when the Git Graph View is first opened. Each repository can have it's initial branches configured from the Repository Settings Widget on the Git Graph View, or they may inherit the global configuration set by the extension settings `git-graph.repository.onLoad.showCheckedOutBranch` & `git-graph.repository.onLoad.showSpecificBranches`.
* #341 Added a new extension setting `git-graph.repository.showRemoteBranches`, to set the default value of the "Show Remote Branches" repository setting.
* #356 More control over pruning when fetching:
    * Added a new extension setting `git-graph.repository.fetchAndPruneTags`, to enable pruning tags when fetching from remote(s) using the Fetch button on the Git Graph View Control Bar. Default: false (disabled)
    * When fetching a specific remote via the Repository Settings Widget, a "Fetch Remote" dialog is now shown. This dialog provides new options for pruning remote-tracking references and tags. The default value of these options can be set using the new extension settings `git-graph.dialog.fetchRemote.prune` & `git-graph.dialog.fetchRemote.pruneTags`.
* #357 Set a custom name for a repository via the Repository Settings Widget. If set, this custom name helps to differentiate repositories with the same name on the File System.
* #359 When the Git Graph View initially loads, Up / Down keys can now be used scroll the view.
* #361 Many extension settings have been renamed to leverage Visual Studio Code's setting grouping, to make Git Graph settings easier to find / discover. If you previously used any of the renamed settings, the value you previously set will still be used until you set the equivalent new setting.
* #363 Improved support for High Contrast Visual Studio Code Color Theme's.
* #365 Improved the topological check to determine whether the "Drop..." action is available for a commit (when viewing the Commit Context Menu).
* #369 When fetching commit author avatars from Gravatar, fetch email addresses case-insensitive.
* #372 Improved handling of repositories on Mapped Network Drives on Windows with Git >= 2.25.0.
* #376 When loading the Repository Settings Widget, no longer require a global .gitconfig file to exist.
* Significant code and UI improvements.

## 1.25.0 - 2020-07-26
* #293 Added an "Open a Terminal for this Repository" button onto the Git Graph View Control Bar.
* #321 Added a new extension setting `git-graph.repositoryDropdownOrder`, to set the order that repositories are sorted in the repository dropdown on the Git Graph View (only visible when more than one repository exists in the current Visual Studio Code Workspace). Default: Full Path
* #322 Added the "Merge into current branch..." action onto the remote branch context menu.
* #327 Added a new extension setting `git-graph.dialog.cherryPick.noCommit`, to set the default value of the "No Commit" option on the Cherry Pick Dialog.
* #331 Added two extension settings to specify the message format of the squash commit optionally created via the Merge & Pull Branch Dialogs respectively. The supported formats are: the existing squash message generated by Git Graph, and the detailed squash message generated by Git (stored in .git/SQUASH_MSG). 
* #336 Added new extension settings to set the default options on the Pull Branch Dialog.
* #337 Enhanced the Commit Details View File Tree renderer to better display deeply nested directory structures, such that folders with a single child folder are compressed into a single combined folder element. This behaviour can be disabled by using the new extension setting `git-graph.commitDetailsView.fileView.fileTree.compactFolders`.
* Significant code and UI improvements.

## 1.24.0 - 2020-06-14
* #271 Support for Visual Studio Code in Web Browsers. Git Graph officially supports Visual Studio Code in Microsoft's Visual Studio Codespaces in the Google Chrome browser, however the underlying changes allow Git Graph to be supported in most third-party Visual Studio Code browser-based platforms, and in most popular web browsers.
* #297 When checking out a remote branch & the specified branch name already exists locally, the dialog option to "Checkout the existing branch" has been replaced with "Checkout the existing branch & pull changes".
* #304 Override the globally configured commit ordering (configured by `git-graph.repository.commits.order`) per repository from the Git Graph View Column Header context menu.
* #305 Upgraded the minimum version requirement of Visual Studio Code from 1.31.0 to 1.38.0. This change has been needed for some time, however I now have to make this change due to Visual Studio Code decreasing support for older Webview integrations for all extensions. Almost all users of Git Graph will be unaffected by this change. If you are one of the few Git Graph users who use a version of Visual Studio Code older than 1.38.0, please upgrade Visual Studio Code to continue receiving updates to Git Graph. 
* #316 Include built-in support for several new emoji shortcodes recently added to [gitmoji](https://gitmoji.carloscuesta.me/).
* #319 Added a new extension setting `git-graph.enhancedAccessibility`, that enables visual file change A|M|D|R|U indicators in the Commit Details View for users with colour blindness. In the future, this setting will enable any additional accessibility related features of Git Graph that aren't enabled by default. Default: false (disabled)
* Various code improvements.

## 1.23.0 - 2020-05-24
* #89 Added a new "Include commits only mentioned by reflogs" option to the Git Graph View's Repository Settings Widget. The default value can be defined globally for all repositories using the new extension setting `git-graph.repository.includeCommitsMentionedByReflogs`. Default: false (disabled)
* #201 New Keyboard Shortcuts in the Git Graph View for scrolling to stashes:
    * `CTRL/CMD + S`: Scrolls the Git Graph View to the first (or next) stash in the loaded commits.
    * `CTRL/CMD + SHIFT + S`: Scrolls the Git Graph View to the last (or previous) stash in the loaded commits.
* #277 Open the Visual Studio Code Diff View from the Git Graph View in a specific Editor Group. Previously `git-graph.openNewTabEditorGroup` only supported `Active` & `Beside`, now it additionally supports `One`, `Two`, `Three`, ... , `Nine`.
* #279 Support Chinese / Japanese / Korean IME Keyboard Enter Events on Mac's for dialog submission. Thanks [Kazuma Ebina (@kazuma1989)](https://github.com/kazuma1989)!
* #283 After the Keyboard Shortcut `CTRL + H` is run in the Git Graph View to scroll to the HEAD commit, the commit now momentarily flashes to draw attention to it.
* #285 Added a new extension setting `git-graph.repository.showUntrackedFiles`, that controls whether untracked files are included in the uncommitted changes on the Git Graph View. Default: true (enabled)
* #286 Added a "View File at this Revision" button for each file displayed in the Commit Details / Comparison Views.
* #287 Added a new "Only follow the first parent of commits" option to the Git Graph View's Repository Settings Widget. The default value can be defined globally for all repositories using the new extension setting `git-graph.repository.onlyFollowFirstParent`. Default: false (disabled)
* #292 Create a *.tar or *.zip archive of the repository at any branch or tag from the corresponding context menu.
* #299 Previously when the Commit Details View was open on a commit, `Up` / `Down` keystrokes would open the Commit Details View on the commit directly above or below it on the Git Graph View. This is now augmented with `CTRL/CMD + Up` / `CTRL/CMD + Down` keystrokes, that open the Commit Details View on its child or parent commit on the same branch.
* #303 Added scroll bar support to dropdown menus on dialogs, to prevent dropdowns with many items overflowing off the bottom of the Git Graph View.
* Various code and UI improvements.

## 1.22.0 - 2020-03-21
* #231 New Command "Git Graph: Resume a specific Code Review in Workspace..." opens the Git Graph View to a Code Review that is already in progress.
* #248 Added a "No Commit" option to the "Merge Branch" & "Merge Commit" Dialogs. The default value of this new option can be set using the extension setting `git-graph.dialog.merge.noCommit`. Default: false (disabled)
* #250 New "Pull Request Creation" Integration automates the opening and pre-filling of a Pull Request form, directly from a branches context menu.
    * Configured from the Repository Settings Widget.
        * Support for the publicly hosted Bitbucket, GitHub and GitLab Pull Request providers is built-in.
        * Custom Pull Request providers can be configured using the extension setting `git-graph.customPullRequestProviders` (e.g. for use with privately hosted Pull Request providers). Information on how to configure custom providers is available [here](https://github.com/aimuch/vscode-git-map/blob/main/docs/extension-settings.md#custom-pull-request-providers).
    * Once configured, a new "Create Pull Request" option is available on the right click context menus of local and remote branches.
* #251 Added a "Record Origin" option to the "Cherry Pick" Dialog. The default value of this new option can be set using the extension setting `git-graph.dialog.cherryPick.recordOrigin`. Default: false (disabled)
* #253 New Command "Git Graph: End a specific Code Review in Workspace..." ends a specific Code Review without having to first open it in the Git Graph View.
* #255 Added an information tooltip to the "Name" field on the "Add Tag" Dialog, that indicates the most recent tag in the loaded commits.
* #259 Added a tooltip to the commit HEAD indicator (hollow circle) in the "Description" column, to explain what it indicates.
* #262 Issue Linking now supports multiple capturing groups in the "Issue Regex", and corresponding placeholders ($1, $2, etc.) in the "Issue URL".
* #266 Show stashes that are based on commits on deleted branches.
* #267 Added new "Copy Commit Subject to Clipboard" action on the commit context menu. Thanks [Doron Guttman (@dguttman-jacada)](https://github.com/dguttman-jacada)!
* #269 If the author date and commit date are different, both are now shown in the Commit Details View. The committer email is also now shown in the Commit Details View.
* #274 Fixed the files shown in the Commit Details View for merge commits.
* Significant code and UI improvements.

## 1.21.0 - 2020-01-13
* #225 Configure the local and global Git User Name & Email from the new "User Details" section of the Repository Settings Widget.
* #239 Added "Force With Lease" option to the "Push Branch" Dialog.
* #240 Show the commit's signature status to the right of the Committer in the Commit Details View by enabling the new extension setting `git-graph.repository.commits.showSignatureStatus`. Hovering over the signature icon displays a tooltip with the signature details.
* #241 When the view has been scrolled to the bottom, it will automatically load more commits if they exist (instead of having to press the "Load More Commits" button). The new extension setting `git-graph.repository.commits.loadMoreAutomatically` can be used to disable this.
* #243 The parents of a commit in the Commit Details View can be clicked to open the Commit Details View for the parent (only if the parent is within the commits loaded in the Git Graph View).
* Significant code and UI improvements, including:
    * Overhaul of the Git Graph View data loading & refreshing mechanism (in preparation for upcoming features).
    * Improved the rendering performance and event handling of the Git Graph View.

## 1.20.0 - 2019-12-24
* #139 Added a new extension setting `git-graph.repository.commits.mute.commitsThatAreNotAncestorsOfHead`, that when enabled will display commits that aren't ancestors of the checked-out branch / commit with a muted text colour. 
* #219 Added a new extension setting `git-graph.repository.onLoad.scrollToHead`, that when enabled will scroll the Git Graph View to be centered on the commit referenced by HEAD when opening or switching repositories. Default: false (disabled)
* #222 Resolve symbolic links when Git Graph is opened via the Visual Studio Code Source Control View.
* #223 Enhancements to Issue Linking:
    * New checkbox to use the "Issue Regex" and "Issue URL" for all repositories by default (it can be overridden per repository). Note: "Use Globally" is only suitable if identical Issue Linking applies to the majority of your repositories (e.g. when using JIRA or Pivotal Tracker).
    * Automatically prefill the "Issue Regex" field if a common issue pattern is detected in commit messages in the repository.
* #227 Format the leading whitespace of lines in commit messages (in the Commit Details View) and tag messages (in the Tag Details Dialog).
* #232 Limit the maximum width of the Control Bar dropdowns to improve support for lower resolution viewports and long branch names.
* #233 Added an "Always Accept" checkbox on the "Checkout Commit" Dialog.
* #237 When a commit in the graph is a stash, it is now displayed differently from normal commits.
* Various code and UI improvements.

## 1.19.1 - 2019-11-27
* #221 Fixed a compatibility issue with Visual Studio Code Remote Development that was introduced in Git Graph 1.19.0.

## 1.19.0 - 2019-11-27
* #220 Issue Linking - Converts issue numbers in commit messages into hyperlinks, that open the issue in your issue tracking system. This is configured in the Repository Settings Widget (opened from the Git Graph View's Control Bar).
* #208 Include the Untracked Files of Stashes in the Commit Details View.
* #213 Added a new extension setting to set the default state of the "Force Delete" checkbox on the "Delete Branch" Dialog.
* #215 Added "Open Git Graph Extension Settings" button on the Repository Settings Widget.
* #216 Added a new "Show Tags" extension setting, that can be overridden per repository in the Git Graph View's Repository Settings Widget. Default: true (enabled)
* #218 New Keyboard Shortcut `CTRL/CMD + h` scrolls the Git Graph View to be centered on the commit referenced by HEAD.
* Numerous code and UI improvements, including:
    * #209 Improved handling of Electron `*.asar` files.
    * Push Branch & Push Tag Dialogs now default to pushing to `origin` in repositories with multiple remotes (if it exists).
    * Find Widget - Updated icons, tooltips, and added a new `SHIFT+Enter` keystroke to go to the previous match.

## 1.18.0 - 2019-11-05
* #202 New File List View in the Commit Details / Comparison Views, as an alternative to the existing File Tree View. The default File View Type can be specified using the setting `git-graph.commitDetailsView.fileView.type`. This can be overridden per repository using the new controls on the right side of the Commit Details / Comparison Views.
* #197 Improved the default column widths when the table is being automatically laid out on narrow width views.
* #198 Customise which context menu actions are visible with the new extension setting `git-graph.contextMenuActionsVisibility`. For more information, see the documentation [here](https://github.com/aimuch/vscode-git-map/blob/main/docs/extension-settings.md#context-menu-actions-visibility).
* #204 Added a new option to reinstate indexed changes on both the apply and pop stash actions.
* #205 Dialogs now use custom input controls to create a more seamless experience, that respects the active Visual Studio Code Color Theme.
* Various code and UI improvements.

## 1.17.0 - 2019-10-08
* #128 New "Fetch into local branch..." action on the remote branch context menu. This only appears if a local branch shares the same name as the branch being fetched, and the local branch is not checked out.
* #185 Added two new date format options, "ISO Date & Time" and "ISO Date Only", to the extension setting `git-graph.dateFormat`.
* #186 Added a "Push to remote" option to the "Add Tag" Dialog, that enables the extension to push the tag to a remote once it is added. The default value of this new option can be set using the extension setting `git-graph.dialog.addTag.pushToRemote`. Default: false (disabled)
* #188 Added a "No Commit" option to the "Cherry Pick Commit" Dialog, that enables a commit's changes to be staged but not committed. This allows you to select and commit specific parts of the cherry picked commit.
* #189 Fixed the handling of filenames containing double quotes in the Commit Details View.
* #190 Show / hide branches of individual remotes from the Repository Settings Widget.
* #192 Fixed the handling of filenames containing URI fragment and query string separators when opening the Diff View.
* Various code, performance, and UI improvements (including #191).

## 1.16.0 - 2019-09-22
* #156 Hover over any commit vertex on the graph to see a tooltip indicating:
    * Whether the commit is included in the HEAD.
    * Which branches, tags and stashes include the commit.
* #161 New option on the "Delete Branch" Dialog to also delete the branch on the remote(s). This only appears if one or more remotes contain a branch with the same name as the branch being deleted.
* #180 New "Pop..." action on the Stash Context Menu.
* #181 Added new extension settings to set the default options on the following dialogs: Reset Current Branch To Commit, Reset Uncommitted Changes, and Stash Uncommitted Changes.
* #183 Graph construction, representation, and layout improvements, that produce a better visualisation, and enable topological analysis for exciting new and upcoming features.
* Various code and UI improvements.

## 1.15.0 - 2019-09-13
* #48 Support for Stashes
    * Show Stashes on the Git Graph View.
    * Stash Context Menu:
        * Apply Stash...
        * Create Branch from Stash...
        * Drop Stash...
        * Copy Stash Name to Clipboard
        * Copy Stash Hash to Clipboard
    * New "Stash uncommitted changes..." action on the Uncommitted Changes Context Menu.
    * Commit Details & Comparison View support for Stashes.
* #172 Prevent Visual Studio Code automatically requesting package.json files from Git Graph in the background, when README.md file diffs are opened from the Commit Details & Comparison Views.
* #173 Use .gitmodules (if configured) to automatically add Git submodules to Git Graph.
* #174 New "Drop..." action on the commit context menu to drop a single commit. This is only available on commits without branching or merging in their children.
* #175 Double clicking "Show All" in the Branches dropdown now selects/unselects all branches. This makes it faster to select all but one or two branches. Thanks [Thibault Matot (@thmatot)](https://github.com/thmatot)!
* #177 Display path hints if necessary in the "Repo" dropdown to differentiate multiple repositories that have the same name.
* #178 New setting `git-graph.repository.showCommitsOnlyReferencedByTags` specifies whether commits that are only referenced by tags should be shown in Git Graph. Default: true (enabled)
* Various code, performance, and UI improvements.

## 1.14.0 - 2019-09-02
* Commit Details & Comparison View Enhancements:
    * #122 Code Review - Keep track of which files you have reviewed in the Commit Details & Comparison Views.
        * Code Review's can be performed on any commit, or between any two commits (not on Uncommitted Changes).
        * There is a new button on the right of the Commit Details & Comparison Views to start and stop a code review.
        * When a Code Review is started, all files needing to be reviewed are bolded. When you view the diff / open a file, it will then be un-bolded.
        * Code Reviews persist across Visual Studio Code sessions.
    * #122 The last file viewed is now indicated with an "eye" icon. It's only remembered while the view is open, or until a Code Review is finished.
    * #151 The height and divider of the Commit Details View can now be dragged and resized to better suit your projects. The configured dimensions are stored per repository, across Visual Studio Code sessions.
    * #164 Increased the resolution of commit author avatars for High DPI / Retina Displays. This only applies to all avatars fetched after this update is installed. To trigger higher resolution versions of cached avatars to be fetched (instead of waiting until their next automatic background refresh), you can run the command "Git Graph: Clear Avatar Cache" once, and reopen the Git Graph View.
* #163 Fixed: Viewing branches that share the same name as a file in the repository.
* #165 If the user changes `git.path` to a valid Git executable, the extension will now switch to use it, even if another known Git executable is already being used.
* #168 Fixed: A race condition causing the stdout output of a few Git commands to only be partially returned for a small number of users.
* Various code and UI improvements.

## 1.13.0 - 2019-08-16
* #143 New setting `git-graph.repository.useMailmap` enables the use of .mailmap files when displaying author & committer names and email addresses.
* #145 Added new extension settings to set the default options on the following dialogs: Add Tag, Create Branch, Merge, and Rebase
* #146 New command "Git Graph: Remove Git Repository" removes a repository from Git Graph.
* #149 New setting `git-graph.integratedTerminalShell` allows a specific Shell (not the default) to be used by the Visual Studio Code Integrated Terminal, when opened by Git Graph during Interactive Rebase's. For security reasons, this setting can only be specified in the User Settings, not in the Workspace Settings.
* #150 New setting `git-graph.fileEncoding` specifies the character set encoding used when retrieving a specific version of repository files (e.g. in the Diff View). A list of all supported encodings can be found [here](https://github.com/ashtuchkin/iconv-lite/wiki/Supported-Encodings). Default: utf8
* #154 Fetch Enhancements:
    * New setting `git-graph.repository.fetchAndPrune` enables pruning when fetching from remote(s) using the Fetch button on the Git Graph View Control Bar. Default: false (disabled)
    * Fetch or Prune a specific remote from the Repository Settings widget.
* #155 If a known sub repository is included in the Commit Details View file tree, clicking on it will now load it in the Git Graph View.
* #158 Improved repository management for various Visual Studio Code and Git repository workflows.
* #159 Added force push option on the "Push Branch" Dialog.
* #160 Fixed: Shell color codes were included in the Branches dropdown when the user overrides Git Config "color.branch" to "always".
* Various code and UI improvements. 

## 1.12.1 - 2019-07-23
* #137 Fixed a file path construction issue when Visual Studio Code is opened to a subfolder of a repository, and the user clicks to view the current version of a file from the Commit Details View.
* #141 Include the object and commit hashes when showing the new "View Details" action on annotated tags.
* #142 New button to copy the path of any file displayed in the Commit Details View or Commit Comparison View file trees to the clipboard (to the right of each file).
* Various code improvements.

## 1.12.0 - 2019-07-21
* #129 Added logging through a Visual Studio Code Output Channel. The logs currently include all Git commands that are run, and numerous core extension events.
* #130 Added support for repositories with a significant number of branches (1000+).
* #131 When checking out a remote branch and the new branch name already exists, prompt the user with a new dialog to choose another name, or check out the existing branch.
* #135 Git Graph now behaves the same as the Visual Studio Code Git Extensions git executable detection. This allows:
    * A better first experience for users who don't have a Git executable in their PATH.
    * Two new error pages (replacing the existing "Unable to load Git Graph" error page). These new pages provide more useful information and actions to users who are presented with an error.
* #136 View annotated tag details (name, email, date and message) from the tag context menu.
* Various code improvements.

## 1.11.0 - 2019-07-13
* #95 New repository settings menu (opened by clicking on the new settings icon on the top right control bar). Thanks [Raphaël Balet (@rbalet)](https://github.com/rbalet) for helping with this! From the repository settings menu, you can:
    * View the remotes of the repository
    * Add a new remote to the repository
    * Edit an existing remote of the repository
    * Delete an existing remote of the repository
* #117 New setting `git-graph.repository.commits.order` allows you to choose the order of commits (date, date-author or topo). See [git log](https://git-scm.com/docs/git-log#_commit_ordering) for more information on each order option. Default: date
* #119 New option to immediately check out a branch after it has been created with the "Create Branch..." action.
* #123 Persist the "Show Remote Branches" checkbox state across Git Graph view sessions per repository.
* #125 Extend avatar fetching to support SSH GitHub & GitLab remotes (prior support for GitHub & GitLab was for HTTPS remotes only).
* #126 When "Show All" is selected for the visible branches, include the HEAD commit on the graph when it is not on a branch (e.g. during rebasing).
* Various code improvements.

## 1.10.0 - 2019-07-02
* #108 New button to open any file displayed in the Commit Details View or Commit Comparison View file trees (to the right of each file).
* #114 Prompt the user for remote credentials if they are requested by commands that communicate with a remote (askpass).
* #115 When running the "Delete Remote Branch..." action and the branch doesn't exist on the remote (i.e. it was already deleted), automatically delete the remote tracking branch instead of showing an error message.
* #116 Detect and generate links for HTTP/HTTPS urls in the commit body on the Commit Details View, so they can be clicked and opened in your default web browser.
* Various minor UI improvements to the Commit Details View and Commit Comparison View file trees.

## 1.9.0 - 2019-06-23
* #31 Find widget allows you to quickly find one or more commits containing a specific phrase (in the commit message / date / author / hash, branch or tag names). The find widget can be activated by the new find icon on the top right control bar, or from the new `CTRL/CMD + f` keystroke.
* #98 New "Pull into current branch..." action available from the remote branch context menu.
* #100 Show merge commits with a muted text colour. This is controlled by the new setting `git-graph.repository.commits.mute.mergeCommits`. Default: true (enabled). Thanks [Sebastian Lay (@sebastianlay)](https://github.com/sebastianlay)!
* #104 Common Emoji Shortcodes are automatically replaced with the corresponding emoji in commit messages (including all [gitmoji](https://gitmoji.carloscuesta.me/)). Custom Emoji Shortcode mappings can be defined in `git-graph.customEmojiShortcodeMappings`.
* #105 Add information for troubleshooting repositories in subfolders.
* #107 Support for displaying remote svn branches.
* #109 New option on the existing 'Delete Tag...' action to also delete the tag on a remote (only shown if remotes exist).
* Improved handling of error dialogs.

## 1.8.0 - 2019-06-08
* #90 New command "Git Graph: Add Git Repository" in the Command Palette allows additional Git repositories to be added to Git Graph (e.g. sub-repos).
* #91 New setting to enable Git Graph to open to the repository containing the active Text Editor document `git-graph.openToTheRepoOfTheActiveTextEditorDocument`. Default: false (disabled)
* #92 Various improvements for a better user experience:
    * Display the name of the running Git Action while it is occurring.
    * Maintain the users scroll position when running a Git Action from context menus.
    * The refresh button now indicates if a refresh is occurring.
    * Enabled by default the recently added setting `git-graph.retainContextWhenHidden` to provide near-instant tab restoration when switching back to Git Graph.
    * Many more small tweaks.
* #93 Updates to the push tag action so that it:
    * Only appears if remotes exist
    * Defaults to the remote if only one exists
    * Allows the user to select the remote to push to if multiple exist.
* #94 Support for pushing branches via the local branch context menu. It respects the same new remote conditions as #93.

## 1.7.0 - 2019-05-29
* #34 Support for rebasing the current branch on any branch or commit, from the corresponding branch/commit context menu.
* #57 New "Fetch from Remote(s)" button available on the top control bar (only visible when remotes exist). Redesigned refresh button.
* #79 Show/hide the Date, Author & Commit columns by right clicking on the column header row, and then clicking the desired column to toggle its visibility. The new setting `git-graph.defaultColumnVisibility` can be used to configure the default visibility of each column. For example: `{"Date": true, "Author": true, "Commit": true}`
* #87 More emphasis on the current head branch label.
* Robustness improvements when handling remotes.

## 1.6.0 - 2019-05-24
* #36 New functionality for uncommitted changes:
    * View uncommitted changes by clicking on it, like you would with any commit. 
    * Compare any commit with the uncommitted changes.
    * Three new actions are now available from the new Uncommitted Changes context menu, they are:
        * Reset uncommitted changes to HEAD
        * Clean untracked files
        * Open the Visual Studio Code Source Control View
* New ways to filter branches on the Git Graph view:
    * #77 Allow multiple branches to be selected in the 'Branches' dropdown.
    * #49 Predefine an array of custom glob patterns with the new setting `git-graph.customBranchGlobPatterns`, allowing you to use them anytime from the 'Branches' dropdown. For example: `[{"name": "Feature Requests", "glob": "heads/feature/*"}]`
* #71 Choose from a variety of branch and tag label alignment options to better suit the projects you work on. The alignment options of the new setting `git-graph.referenceLabels.alignment` are:
    * Normal: Show branch & tag labels on the left of the commit message in the 'Description' column.
    * Branches (on the left) & Tags (on the right): Show branch labels on the left of the commit message in the 'Description' column, and tag labels on the right.
    * Branches (aligned to the graph) & Tags (on the right): Show branch labels aligned to the graph in the 'Graph' column, and tag labels on the right in the 'Description' column.
* #30 New setting `git-graph.retainContextWhenHidden` enables faster Git Graph tab restoration at the cost of additional memory usage when Git Graph is opened, but not visible (running in the background). Default: false (not enabled). Thanks [Yu Zhang (@yzhang-gh)](https://github.com/yzhang-gh)!
* #76 Open and view a specific repo in Git Graph directly from the title of a Source Code Provider in the Visual Studio Code SCP View. The new setting `git-graph.sourceCodeProviderIntegrationLocation` specifies if the Git Graph menu item is inline on the title of the Source Code Provider, or on the 'More actions...' menu. Default: Inline
* #78 Combine local and remote branch labels if they refer to the same branch, and are on the same commit. When combined, the local and remote branch context menus are available from the corresponding section of the label. The new setting `git-graph.referenceLabels.combineLocalAndRemoteBranchLabels` allows you to disable this behaviour.
* #81 Support for repositories with a very large number of tags. Thanks [egi (@egi)](https://github.com/egi)!
* #83 Support for the upcoming "Remote Development" functionality of Visual Studio Code. Thanks [Kaloyan Arsov (@Dontar)](https://github.com/Dontar) for helping with this!
* #85 New setting `git-graph.openNewTabEditorGroup` allows you to choose where you'd like the Visual Studio Code Diff to open, either in the Active pane, or Beside to active pane. Default: Active

## 1.5.0 - 2019-05-15
* #29 Compare commits: When the Commit Details View is open for a commit, CTRL/CMD click on another commit to see all of the changes between the two commits.
* #60 Added a tooltip on repo dropdown items, indicating the full path of the repository.
* #62 Support for non-ASCII file names in the Commit Details View.
* #63 Commits can be squashed when merging if the "Squash commits" checkbox is checked on the commit and branch merge dialogs.
* #64 Delete remote branches from the right click context menu of the remote branch.
* #73 New keyboard shortcuts:
    * Up / Down Arrows: When the Commit Details View is open, pressing the up and down arrow keys opens the previous or next commits' Commit Details View.
    * CTRL/CMD + r: Refresh the Git Graph.
    * Enter: If a dialog is open, pressing enter submits the dialog, taking the primary (left) action.
* #74 Dock the Commit Details View to the bottom of the Git Graph view with the new setting `git-graph.commitDetailsView.location`, instead of rendering inline with the graph. Default: Inline (with graph)

## 1.4.6 - 2019-04-30
* #33 Support for git repositories in subfolders. New setting `git-graph.maxDepthOfRepoSearch` specifies the maximum depth of subfolders to search (default: 0).
* #50 Branch and repo dropdowns now have a filter to make it faster to find the desired item.
* #52 Copy branch and tag names to the clipboard.
* #53 Flattened the control bar and column header elements, to better suit the majority of Visual Studio Code Themes.
* #54 Graph rendering algorithm changes: performance improvements, and better layout of intermediate branch merges.
* #55 Robustness improvements of the avatar caching mechanism.
* #58 Removed the checkout and delete actions from the context menu of the checked out branch.
* #59 Various performance improvements for: opening Git Graph, loading commits, and opening the commit details view.

## 1.4.5 - 2019-04-15
* #26 Fetch and show commit author / committer avatars from GitHub, GitLab & Gravatar. If you'd like to use this feature, you must enable the setting `git-graph.repository.commits.fetchAvatars`. Thanks [Walter Meier (@meierw)](https://github.com/meierw) for helping with the development of this!
* #37 Columns can be resized by dragging the dividers in the table header.
* #43 Add more emphasis to the head commit.
* #44 Improved the documentation and descriptions of extension settings.
* #45 Include commits from heads that are only referenced by tags.
* #46 Fixed graph node misalignment when Visual Studio Code is zoomed.
* #51 Observe Visual Studio Code theme changes while Git Graph is open, now required due to a change in Visual Studio Code 1.33.0.

## 1.4.4 - 2019-04-01
* #27 Add lightweight or annotated tags. Add message (optional) to annotated tags.
* #35 Merge a specific commit from the commit context menu.
* #38 Push a tag to origin from the tag context menu.
* #39 Checkout a branch by double clicking on the branch label.
* #40 Reworded context menu actions. Use ellipses to differentiate non-immediate actions. Added support for dividers in the context menus to better segment actions.
* #41 Load the last viewed repo when opening Git Graph in a multi-root workspace.
* #42 New setting `git-graph.date.type` to specify the date type to be displayed, either the author or commit date.

## 1.4.3 - 2019-03-17
* #17 Automatic refresh when repo changes while Git Graph is visible.
* #32 Checkout a specific commit from the commit context menu.
* #20 Hide the "Git Graph" status bar item when the workspace has no Git repository.
* #28 Fixed the text colour used for dropdowns and dialogs, to support use with other VSCode colour themes.
* Added the Git Graph icon to the tab when Git Graph is opened. By default the icon is coloured, but it can be set to greyscale with the new configuration setting `git-graph.tabIconColourTheme`.

## 1.4.2 - 2019-03-10
* #22 New setting to show the current branch by default when Git Graph is opened, instead of showing all branches. By default `git-graph.repository.onLoad.showCheckedOutBranch` is false.
* #24 Display all lines of the commit body in the commit details view. Thanks [Shoshin Nikita (@ShoshinNikita)](https://github.com/ShoshinNikita)!

## 1.4.1 - 2019-03-09
* #13 Support for multiple Git repositories in multi-root workspaces.
* #8 Improved control bar style, for improved support of different colour themes.
* #23 Changed "Reverse this Commit" to "Revert this Commit", to match the corresponding Git command. Thanks [Larry Lu (@Larry850806)](https://github.com/Larry850806)!
* Several minor consistency improvements.

## 1.4.0 - 2019-02-28
* #12 Revert, cherry-pick & merge git commands are now available from the commit and branch context menus.
* #7 Added a new extension setting `git-graph.commitDetailsView.autoCenter` to enable / disable automatic centering of the commit details view.
* #11 Context menu closes on the next mouse interaction, instead of when the mouse leaves the context menu.
* #15 Support for portable git installations.
* #18 Fixed handling of detached HEAD's.

## 1.3.3 - 2019-02-22
* #3 & #9: Fixes an issue preventing the graph loading for a few git repositories.
* #10: Fixes an issue where lines extending past the rightmost node of the graph would be cropped.
* Press escape to close any open Git Graph dialog.
* #6: The command title in the Command Palette is changed to "Git Graph: View Git Graph (git log)".
* Refined styling of the commit details view.

## 1.3.2 - 2019-02-18
* Fixes an issue when viewing some large graphs of more than 500 commits.
* Significantly reduced package size.

## 1.3.1 - 2019-02-17
* #5 View the Visual Studio Code Diff of a file change in a commit, by clicking on the file in the commit details view.
* All git commands are run asynchronously to improve responsiveness.

## 1.3.0 - 2019-02-16
* #4 Commit details view (click on a commit to open it). This shows the full commit details, and a tree view of all file changes in the commit.
* #2 Support for git reset hard, mixed & soft.
* #1 Add the branch colour to ref labels to make them easier to read.

## 1.2.0 - 2019-02-12
* Graph generation improvements, making complex graphs easier to read
* Graph rendering performance improvements
* Improved graph styling

## 1.1.0 - 2019-02-11
* Perform Git actions directly from Git Graph by right clicking on a commit / branch / tag:
    * Create, Checkout, Rename & Delete Branches
    * Add & Delete Tags
    * Copy Commit Hash to Clipboard
* Graph generation improvements

## 1.0.1 - 2019-02-10
* Detect & display lightweight tags

## 1.0.0 - 2019-02-10
* Initial release
* Git Graph Visualisation
    * Select from Local & Remote Branches
    * Display Heads, Tags & Remotes
    * Configuration Settings:
        * `git-graph.graph.colours` - Specifies the colours used on the graph.
        * `git-graph.graph.style` - Specifies the style of the graph.
        * `git-graph.date.format` - Specifies the number of commits to initially load.
        * `git-graph.repository.commits.initialLoad` - Specifies the number of commits to initially load.
        * `git-graph.repository.commits.loadMore` - Specifies the number of commits to load when the "Load More Commits" button is pressed (only shown when more commits are available).
        * `git-graph.showStatusBarItem` - Show a Status Bar item which opens Git Graph when clicked.
        * `git-graph.repository.showUncommittedChanges` - Show uncommitted changes (set to false to decrease load time on large repositories).
* Shortcut Button in the Status Bar