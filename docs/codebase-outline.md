# Codebase Outline

Git Map has two parts that communicate with messages: the extension (`src/`, runs in the Visual Studio Code Extension Host), and the Git Map View's front-end (`web/`, runs in a Webview). The messages exchanged between them are typed in `src/types.ts` (`RequestMessage` & `ResponseMessage`), which is shared by both parts.

## Extension (`src/`)

| File | Responsibility |
|---|---|
| `extension.ts` | Activation: creates the components below, and registers them for disposal. |
| `commands.ts` | The commands contributed to the Command Palette (e.g. "Git Map: View Git Map"). |
| `gitGraphView.ts` | The Git Map View's Webview panel: its HTML & initial state, and the handling of every message from the front-end. |
| `dataSource.ts` | Runs Git commands, and parses their output (commits, refs, config, etc.). |
| `repoManager.ts` | Discovers the repositories in the workspace, and keeps their state. |
| `repoFileWatcher.ts` | Watches a repository (including its Git directory) to refresh the view when it changes. |
| `extensionState.ts` | State persisted by Visual Studio Code: repository state, Code Reviews, avatars, etc. |
| `avatarManager.ts` | Fetches & caches the avatars of commit authors (when enabled). |
| `diffDocProvider.ts` | Provides the contents of files at a revision to the Visual Studio Code Diff View. |
| `statusBarItem.ts` | The Git Map Status Bar Item. |
| `config.ts` | Typed access to the `git-map.*` Extension Settings. |
| `lineHistory.ts`, `lineHistoryDrawer.ts`, `lineHistoryInline.ts` | The history of lines: the drawer (a Webview view in the Secondary Side Bar) and the inline window (a comment thread), and their actions. |
| `lineMapping.ts` | Maps the lines of an editor's contents to the same lines in HEAD (Myers' diff algorithm). |
| `lineBlame.ts`, `fileBlame.ts` | The blame of the current line (and its hover), and the File Blame (with a heatmap). |
| `revisionNavigation.ts` | Show Previous / Next Revision of a file. |
| `codeLens.ts` | The optional Git CodeLens. |
| `removeFromHistory.ts`, `historyRewrite.ts`, `historyFilter.ts` | Remove Files from History: the commands & their confirmation (`removeFromHistory.ts`), running `git fast-export` & `git fast-import`, the backup, restoring it & cleaning up (`historyRewrite.ts`, which doesn't depend on Visual Studio Code), and the filter that removes the files from the fast-export stream (`historyFilter.ts`). |
| `gitFeatures.ts` | The Git operations of comparing & cleaning up branches, rewriting the latest commits, bisecting, patches, stashing & restoring files, the timeline of a file, and the changes of a commit that's explained (doesn't depend on Visual Studio Code). |
| `visualFileHistory.ts` | The Visual File History panel (a Webview with its own page). |
| `explainCommit.ts` | Explains a commit with a language model provided in Visual Studio Code (the Language Model API, when it exists). |
| `remoteLinks.ts` | Links to lines & commits on the web pages of remote repositories. |
| `settingsMigration.ts` | Copies the Extension Settings named `git-graph.*` (before version 2.1.0, and by the original Git Graph extension) to `git-map.*` when Git Map starts. |
| `l10n.ts` | Translation of messages (see [Localisation](#localisation)). |
| `askpass/` | Git Map's integrated Askpass, which prompts for credentials needed by Git. |
| `utils.ts`, `utils/` | Shared helpers (Visual Studio Code APIs, Git executable discovery, events, disposables, queues). |

## Front-end (`web/`)

| File | Responsibility |
|---|---|
| `main.ts` | The `GitGraphView` class: the control bar, commit table, Commit Details View, and the actions on context menus & dialogs. |
| `graph.ts` | Lays out and renders the graph (SVG). |
| `minimap.ts` | The Minimap (activity of the loaded commits) at the top of the view, and the markers alongside the scrollbar. |
| `contextMenu.ts`, `dialog.ts`, `dropdown.ts`, `findWidget.ts`, `settingsWidget.ts` | UI components (`settingsWidget.ts` is the Repository Settings). |
| `branchCompare.ts`, `branchCleanup.ts` | Branch Comparison (its bar & panel of the changed files) and Clean Up Branches. |
| `explainCommit.ts` | The Explain tab of the Commit Details View. |
| `rebaseEditor.ts` | The Rebase Editor, and the operation bar (an operation in progress, or bisecting). |
| `textFormatter.ts` | Formats commit messages (Markdown, emoji shortcodes, Issue Linking & URLs). |
| `utils.ts` | Shared helpers (dates, HTML escaping, tooltips, messaging). |
| `styles/` | Stylesheets. |

The front-end is compiled with `module: none` and bundled (by `.vscode/package-web.js`) into `media/out.min.js` & `media/out.min.css`.

## Localisation

Messages are translated with `t('English message {0}', ...args)` in both parts; the English message is the key of its translations in `l10n/bundle.l10n.<language>.json` (the front-end receives the bundle in its initial state). The descriptions of commands & settings in `package.json` are `%key%` placeholders, described in `package.nls.json` and translated in `package.nls.<language>.json`. `npm run lint` runs `.vscode/check-l10n.js`, which checks that every message and description has a translation.

## Tests

* `tests/`: Unit tests (Jest), with Visual Studio Code mocked by `tests/mocks/vscode.ts`. Run with `npm run test`.
* `e2e/`: End-to-end tests, run in a real instance of Visual Studio Code against real Git repositories. `e2e/webview-harness.js` drives the Git Map View's UI in a real Webview. Run with `npm run test-e2e` (after `npm run compile`); the report is written to `e2e/.artifacts/report.json`.

## Build & Release

* `npm run compile`: Lint, then compile the extension (`out/`) and the front-end (`media/`).
* `npm run package`: Create `git-map-<version>.vsix`.
* `.github/workflows/build-and-test.yml`: On every push & pull request, lints, compiles, tests and packages the extension, uploading the VSIX as the `git-graph-vsix` artifact. Each push to the main branch replaces the `dev` pre-release with the new VSIX, and pushing a `v<version>` tag (which must match the version in `package.json`) creates a GitHub Release with the VSIX attached.
