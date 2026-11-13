# Extension Settings

Every Git Map setting is described in the Visual Studio Code Settings Editor (search for `@ext:aimdev.git-map`), and summarised in the [README](../README.md#extension-settings). This page documents the settings that need more explanation than fits in a description.

## Context Menu Actions Visibility

`git-map.contextMenuActionsVisibility` customises which actions are displayed on Git Map's context menus. It's an object keyed by context menu, each containing the actions to show (`true`) or hide (`false`). Actions that aren't specified are visible.

For example, to hide "Rebase current branch on Branch..." from the branch context menu, and "Drop..." from the commit context menu:

```json
"git-map.contextMenuActionsVisibility": {
	"branch": {
		"rebase": false
	},
	"commit": {
		"drop": false
	}
}
```

The context menus, and the key of each of their actions:

| Context Menu | Key | Action |
|---|---|---|
| `branch` (a local branch label) | `checkout` | Checkout Branch |
| | `rename` | Rename Branch... |
| | `delete` | Delete Branch... |
| | `merge` | Merge into current branch... |
| | `rebase` | Rebase current branch on Branch... |
| | `push` | Push Branch... |
| | `viewIssue` | View Issue |
| | `createPullRequest` | Create Pull Request... |
| | `createArchive` | Create Archive |
| | `selectInBranchesDropdown` | Select in Branches Dropdown |
| | `unselectInBranchesDropdown` | Unselect in Branches Dropdown |
| | `copyName` | Copy Branch Name to Clipboard |
| | `compare` | Compare with Branch... |
| `commit` (a commit row) | `addTag` | Add Tag... |
| | `createBranch` | Create Branch... |
| | `checkout` | Checkout... |
| | `cherrypick` | Cherry Pick... |
| | `revert` | Revert... |
| | `drop` | Drop... |
| | `merge` | Merge into current branch... |
| | `rebase` | Rebase current branch on this Commit... |
| | `reset` | Reset current branch to this Commit... |
| | `copyHash` | Copy Commit Hash to Clipboard |
| | `copySubject` | Copy Commit Subject to Clipboard |
| | `editMessage` | Edit Commit Message... |
| | `undoCommit` | Undo Commit... |
| | `fixup` | Fix Up Staged Changes into this Commit... |
| | `bisect` | Start Bisecting: This Commit is Bad / Good..., Mark as Good / Bad, Skip |
| | `savePatch` | Save as Patch... & Copy as Patch (and Save Commits as Patch... for selected commits) |
| `commitDetailsViewFile` (a file in the Commit Details View) | `viewDiff` | View Diff |
| | `viewFileAtThisRevision` | View File at this Revision |
| | `viewDiffWithWorkingFile` | View Diff with Working File |
| | `openFile` | Open File |
| | `markAsReviewed` | Mark as Reviewed |
| | `markAsNotReviewed` | Mark as Not Reviewed |
| | `resetFileToThisRevision` | Reset File to this Revision... |
| | `removeFromHistory` | Remove File from History... |
| | `copyAbsoluteFilePath` | Copy Absolute File Path to Clipboard |
| | `copyRelativeFilePath` | Copy Relative File Path to Clipboard |
| | `visualFileHistory` | Visual File History |
| | `stashFile` | Stash this File... (the Uncommitted Changes) |
| | `restoreFromStash` | Restore File from this Stash... (a stash) |
| `remoteBranch` (a remote branch label) | `checkout` | Checkout Branch... |
| | `delete` | Delete Remote Branch... |
| | `fetch` | Fetch into local branch... |
| | `merge` | Merge into current branch... |
| | `pull` | Pull into current branch... |
| | `viewIssue` | View Issue |
| | `createPullRequest` | Create Pull Request |
| | `createArchive` | Create Archive |
| | `selectInBranchesDropdown` | Select in Branches Dropdown |
| | `unselectInBranchesDropdown` | Unselect in Branches Dropdown |
| | `copyName` | Copy Branch Name to Clipboard |
| | `compare` | Compare with Branch... |
| `stash` (a stash label) | `apply` | Apply Stash... |
| | `createBranch` | Create Branch from Stash... |
| | `pop` | Pop Stash... |
| | `drop` | Drop Stash... |
| | `copyName` | Copy Stash Name to Clipboard |
| | `copyHash` | Copy Stash Hash to Clipboard |
| | `savePatch` | Save as Patch... |
| `tag` (a tag label) | `viewDetails` | View Details |
| | `delete` | Delete Tag... |
| | `push` | Push Tag... |
| | `createArchive` | Create Archive |
| | `copyName` | Copy Tag Name to Clipboard |
| `uncommittedChanges` (the Uncommitted Changes row) | `stash` | Stash uncommitted changes... |
| | `reset` | Reset uncommitted changes... |
| | `clean` | Clean untracked files... |
| | `openSourceControlView` | Open Source Control View |
| | `savePatch` | Save Changes as Patch... |
| | `applyPatch` | Apply Patch... |

## Blame

* `git-map.blame.currentLine` (default: `true`) shows the blame of the line the cursor is on at its end, and `git-map.blame.statusBar` (default: `true`) in the Status Bar (clicking it shows the history of the line).
* `git-map.blame.ignoreWhitespace` (default: `false`) ignores changes to whitespace (`git blame -w`), in the blame of the current line, the Status Bar and the File Blame.
* `git-map.blame.ignoreRevsFile` (default: `.git-blame-ignore-revs`) is the file, relative to the root of the repository, listing the commits that blame ignores (`git blame --ignore-revs-file`, Git 2.23 or later), e.g. commits that only reformat code. It's only used when it exists, so repositories without it are blamed as usual. An empty value doesn't ignore any commits. The file has a commit hash on each line (lines starting with `#` are comments), the same format as GitHub's.

## Explain Commit

`git-map.ai.explainCommit.enabled` (default: `false`) shows an "Explain" tab in the Commit Details View. A language model provided in Visual Studio Code (by an extension such as GitHub Copilot Chat, Visual Studio Code 1.90 or later) explains the commit: a summary, its main changes, and what's worth checking.

* Nothing is sent until you open the tab and choose "Explain". The first time, it says what's sent and lets you choose the model (unless you choose not to be asked again).
* The message of the commit and its changes (up to 3,000 lines; the rest isn't sent) are sent to the model you chose, through Visual Studio Code. Git Map doesn't send them anywhere else.
* The explanation is written in the language Git Map is displayed in (`git-map.language`), and may be inaccurate.

## Max Depth of Repo Search

`git-map.maxDepthOfRepoSearch` (default: `0`) is how many levels of subfolders Git Map searches when it discovers the repositories in the workspace:

* `0`: Only the workspace folders themselves (and the repository that contains each of them).
* `1`: The workspace folders, and their immediate subfolders.
* `2` or more: Each further level of subfolders.

Searching stops at the first repository found on each path, so repositories nested inside another repository (other than submodules) aren't discovered. They can be added with the command "Git Map: Add Git Repository...". Larger values make the search slower in workspaces with many folders. Changing the setting triggers a new search.

## Custom Pull Request Providers

The "Pull Request Creation" integration (configured in the Repository Settings of the Git Map View) opens a pre-filled Pull Request form from a branch's context menu. Bitbucket, GitHub & GitLab are built-in. Other providers (e.g. a self-hosted Gitea or Azure DevOps Server) are added with `git-map.customPullRequestProviders`, an array of providers, each with:

* `name`: A unique display name, which is listed as a provider in the Repository Settings.
* `templateUrl`: The URL that creates a Pull Request, containing the variables below.

| Variable | Value | Example |
|---|---|---|
| `$1` | Host Root URL | `https://git.example.com` |
| `$2` | Source Owner | `alice` |
| `$3` | Source Repo | `project` |
| `$4` | Source Branch | `feature/login` |
| `$5` | Destination Owner | `team` |
| `$6` | Destination Repo | `project` |
| `$7` | Destination Project ID (GitLab) | `123` |
| `$8` | Destination Branch | `main` |

The values are prefilled from the repository's remotes when the integration is configured, and can be edited there.

For example, a self-hosted Gitea server (which uses the same compare URL as GitHub):

```json
"git-map.customPullRequestProviders": [
	{
		"name": "Gitea",
		"templateUrl": "$1/$5/$6/compare/$8...$2:$4"
	}
]
```

For reference, the built-in providers use these template URLs:

| Provider | Template URL |
|---|---|
| Bitbucket | `$1/$2/$3/pull-requests/new?source=$2/$3::$4&dest=$5/$6::$8` |
| GitHub | `$1/$5/$6/compare/$8...$2:$4` |
| GitLab | `$1/$2/$3/-/merge_requests/new?merge_request[source_branch]=$4&merge_request[target_branch]=$8&merge_request[target_project_id]=$7` (the project ID parameter is only included when a Destination Project ID is configured) |
