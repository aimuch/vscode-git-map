/* Git Interfaces / Types */

export interface GitCommit {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
	readonly heads: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<GitCommitTag>;
	readonly remotes: ReadonlyArray<GitCommitRemote>;
	readonly stash: GitCommitStash | null; // null => not a stash, otherwise => stash info
}

export interface GitCommitTag {
	readonly name: string;
	readonly annotated: boolean;
}

export interface GitCommitRemote {
	readonly name: string;
	readonly remote: string | null; // null => remote not found, otherwise => remote name
}

export interface GitCommitStash {
	readonly selector: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
}

export interface GitCommitDetails {
	readonly hash: string;
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly committer: string;
	readonly committerEmail: string;
	readonly committerDate: number;
	readonly signature: GitSignature | null;
	readonly body: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
}

export const enum GitSignatureStatus {
	GoodAndValid = 'G',
	GoodWithUnknownValidity = 'U',
	GoodButExpired = 'X',
	GoodButMadeByExpiredKey = 'Y',
	GoodButMadeByRevokedKey = 'R',
	CannotBeChecked = 'E',
	Bad = 'B'
}

export interface GitSignature {
	readonly key: string;
	readonly signer: string;
	readonly status: GitSignatureStatus;
}

export const enum GitConfigLocation {
	Local = 'local',
	Global = 'global',
	System = 'system'
}

export interface GitFileChange {
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
	readonly additions: number | null;
	readonly deletions: number | null;
}

export const enum GitFileStatus {
	Added = 'A',
	Modified = 'M',
	Deleted = 'D',
	Renamed = 'R',
	Untracked = 'U'
}

export const enum GitPushBranchMode {
	Normal = '',
	Force = 'force',
	ForceWithLease = 'force-with-lease'
}

export interface GitRepoConfig {
	readonly branches: GitRepoConfigBranches;
	readonly diffTool: string | null;
	readonly guiDiffTool: string | null;
	readonly pushDefault: string | null;
	readonly remotes: ReadonlyArray<GitRepoSettingsRemote>;
	readonly user: {
		readonly name: {
			readonly local: string | null,
			readonly global: string | null
		},
		readonly email: {
			readonly local: string | null,
			readonly global: string | null
		}
	};
}

export type GitRepoConfigBranches = { [branchName: string]: GitRepoConfigBranch };

export interface GitRepoConfigBranch {
	readonly pushRemote: string | null;
	readonly remote: string | null;
}

export interface GitRepoSettingsRemote {
	readonly name: string;
	readonly url: string | null;
	readonly pushUrl: string | null;
}

export const enum GitResetMode {
	Soft = 'soft',
	Mixed = 'mixed',
	Hard = 'hard'
}

/* File Icon Themes */

export interface FileIconThemeDefinition {
	readonly fontCharacter: string | null;
	readonly fontColor: string | null;
	readonly fontId: string | null;
	readonly fontSize: string | null;
	readonly iconPath: string | null;
}

export interface FileIconThemeMappings {
	readonly file: string | null;
	readonly folder: string | null;
	readonly folderExpanded: string | null;
	readonly fileExtensions: { readonly [extension: string]: string };
	readonly fileNames: { readonly [fileName: string]: string };
	readonly folderNames: { readonly [folderName: string]: string };
	readonly folderNamesExpanded: { readonly [folderName: string]: string };
}

export interface FileIconThemeFont {
	readonly id: string;
	readonly src: string;
	readonly format: string | null;
	readonly weight: string | null;
	readonly style: string | null;
	readonly size: string | null;
}

/**
 * The file icon theme used by Visual Studio Code (with the URIs of its fonts & images converted into Webview URIs).
 */
export interface FileIconTheme extends FileIconThemeMappings {
	readonly id: string;
	readonly fonts: ReadonlyArray<FileIconThemeFont>;
	readonly definitions: { readonly [id: string]: FileIconThemeDefinition };
	readonly light: FileIconThemeMappings | null;
	readonly highContrast: FileIconThemeMappings | null;
}

/**
 * The upstream (remote-tracking) branch of a local branch, and how many commits the local branch is ahead / behind it.
 */
export interface GitBranchUpstream {
	readonly name: string;
	readonly ahead: number;
	readonly behind: number;
	readonly gone: boolean;
}

export interface GitBranchUpstreams {
	readonly [branchName: string]: GitBranchUpstream;
}

/**
 * The history of a file: the paths it has had (it's followed through renames), and how it's changed by each commit.
 */
export interface GitFileHistory {
	readonly filePath: string;
	readonly paths: ReadonlyArray<string>;
	readonly commits: { readonly [hash: string]: GitFileHistoryCommit };
	readonly lineRange?: GitLineRange | null; // The lines whose history is shown (only the commits that change them are shown)
}

/**
 * A range of lines of a file (1-based, inclusive).
 */
export interface GitLineRange {
	readonly start: number;
	readonly end: number;
}

/**
 * The commit that last changed a line of a file.
 */
export interface GitLineBlame {
	readonly hash: string;
	readonly committed: boolean; // FALSE => The line has uncommitted changes
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly summary: string;
	readonly originalLine: number; // The line in the commit (1-based)
	readonly originalFilePath: string; // The path of the file in the commit
}

/**
 * The blame of each line of a file.
 */
export interface GitFileBlame {
	readonly lines: ReadonlyArray<{ readonly hash: string, readonly originalLine: number }>; // The commit that last changed each line, and the line in it
	readonly commits: { readonly [hash: string]: GitBlameCommit };
}

/**
 * A commit that last changed lines of a file.
 */
export interface GitBlameCommit {
	readonly committed: boolean; // FALSE => The lines have uncommitted changes
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly summary: string;
	readonly filePath: string; // The path of the file in the commit
}

/**
 * How a commit (or the uncommitted changes) changed a range of lines of a file.
 */
export interface GitLineHistoryEntry {
	readonly hash: string; // UNCOMMITTED for the uncommitted changes
	readonly parents: ReadonlyArray<string>;
	readonly author: string;
	readonly authorEmail: string;
	readonly authorDate: number;
	readonly subject: string;
	readonly body: string;
	readonly filePath: string; // The path of the file in the commit
	readonly oldFilePath: string | null; // The path of the file before the commit, if the commit renamed it
	readonly fileAdded: boolean; // Did the commit add the file
	readonly oldRange: GitLineRange | null; // The lines before the change (NULL if the lines were added by it)
	readonly newRange: GitLineRange | null; // The lines after the change (NULL if the lines were deleted by it)
	readonly diff: ReadonlyArray<string>; // The diff of the lines (each line starts with ' ', '+' or '-')
	readonly additions: number;
	readonly deletions: number;
}

/**
 * The history of a range of lines of a file.
 */
export interface GitLineHistory {
	readonly repo: string;
	readonly filePath: string; // The path of the file (relative to the repository)
	readonly range: GitLineRange; // The lines in the current contents of the file
	readonly headRange: GitLineRange | null; // The same lines in HEAD (NULL if they're all uncommitted)
	readonly entries: ReadonlyArray<GitLineHistoryEntry>; // The uncommitted changes (if any), then the commits (newest first)
	readonly moreAvailable: boolean;
	readonly error: ErrorInfo;
}

export interface GitFileHistoryCommit {
	readonly filePath: string; // The path of the file in the commit
	readonly oldFilePath: string | null; // The path of the file before the commit, if the commit renamed it
	readonly additions: number | null;
	readonly deletions: number | null;
}

/**
 * The number of files changed by a commit (compared to its first parent), and the lines added & deleted.
 */
export interface GitCommitStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

/**
 * The number of files changed by a stash, and the lines they add & delete.
 */
export interface GitStashStats {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
	readonly untrackedFiles: number;
}

export interface GitWorktree {
	readonly path: string;
	readonly head: string | null; // The commit checked out in the worktree
	readonly branch: string | null; // The branch checked out in the worktree, or NULL if its HEAD is detached
	readonly isMain: boolean; // Is it the main worktree (of the repository)
	readonly isCurrent: boolean; // Is it the worktree shown in the Git Map View
	readonly locked: boolean;
	readonly prunable: boolean; // Its directory no longer exists
}

export interface GitStash {
	readonly hash: string;
	readonly baseHash: string;
	readonly untrackedFilesHash: string | null;
	readonly selector: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly message: string;
}

export interface GitTagDetails {
	readonly hash: string;
	readonly taggerName: string;
	readonly taggerEmail: string;
	readonly taggerDate: number;
	readonly message: string;
	readonly signature: GitSignature | null;
}


/* Git Repo State */

/**
 * A comparison of two branches: the commits on each that aren't on the other, and their merge base.
 */
export interface GitBranchComparison {
	readonly left: string;
	readonly right: string;
	readonly leftHash: string;
	readonly rightHash: string;
	readonly mergeBase: string | null; // NULL => The branches don't have a common ancestor
	readonly leftOnly: ReadonlyArray<string>; // The commits on the left branch that aren't on the right branch (newest first)
	readonly rightOnly: ReadonlyArray<string>; // The commits on the right branch that aren't on the left branch (newest first)
}

/**
 * A local branch that can be deleted: it's merged into the default branch, or its upstream branch has been deleted on the remote.
 */
export interface GitBranchCleanupCandidate {
	readonly name: string;
	readonly hash: string;
	readonly upstream: string | null;
	readonly upstreamGone: boolean;
	readonly merged: boolean; // Is it merged into the default branch
	readonly unmergedCommits: number; // The number of commits that only this branch contains (which are lost if it's deleted)
	readonly date: number;
	readonly author: string;
	readonly remotes: ReadonlyArray<string>; // The remotes that have a branch with the same name
}

/**
 * The state of a bisect in progress.
 */
export interface GitBisectState {
	readonly bad: string | null;
	readonly good: ReadonlyArray<string>;
	readonly skipped: ReadonlyArray<string>;
	readonly current: string | null; // The commit that's checked out (being tested)
	readonly remaining: number | null; // The number of commits left to test
	readonly steps: number | null; // The number of steps left (roughly)
	readonly firstBad: string | null; // The first bad commit (once it has been found)
}

/**
 * A patch file that can be applied.
 */
export interface GitPatchInfo {
	readonly file: string;
	readonly name: string;
	readonly commits: number; // The number of commits in it (0 => it's a diff without commits)
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
	readonly appliesCleanly: boolean;
	readonly checkError: string | null;
}

/**
 * A file with uncommitted changes.
 */
export interface GitStashableFile {
	readonly path: string;
	readonly staged: boolean;
	readonly unstaged: boolean;
	readonly untracked: boolean;
}

/**
 * A commit in the visual history of a file.
 */
export interface GitFileTimelineCommit {
	readonly hash: string;
	readonly author: string;
	readonly email: string;
	readonly date: number;
	readonly subject: string;
	readonly additions: number;
	readonly deletions: number;
	readonly filePath: string; // The path of the file in the commit
	readonly added: boolean; // Did the commit add the file
}

/**
 * A language model that can explain commits.
 */
export interface LanguageModelInfo {
	readonly id: string;
	readonly name: string;
	readonly vendor: string;
}

export interface CodeReview {
	id: string;
	lastActive: number;
	lastViewedFile: string | null;
	remainingFiles: string[];
}

export type ColumnWidth = number;

export type GitRepoSet = { [repo: string]: GitRepoState };

export interface IssueLinkingConfig {
	readonly issue: string;
	readonly url: string;
}

export interface PullRequestConfigBase {
	readonly hostRootUrl: string;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly destRemote: string | null;
	readonly destOwner: string;
	readonly destRepo: string;
	readonly destProjectId: string; // Only used by GitLab
	readonly destBranch: string;
}

export const enum PullRequestProvider {
	Bitbucket,
	Custom,
	GitHub,
	GitLab
}

interface PullRequestConfigBuiltIn extends PullRequestConfigBase {
	readonly provider: Exclude<PullRequestProvider, PullRequestProvider.Custom>;
	readonly custom: null;
}

interface PullRequestConfigCustom extends PullRequestConfigBase {
	readonly provider: PullRequestProvider.Custom;
	readonly custom: {
		readonly name: string,
		readonly templateUrl: string
	};
}

export type PullRequestConfig = PullRequestConfigBuiltIn | PullRequestConfigCustom;

export interface GitRepoState {
	refsColumnWidth?: number;
	showChangesColumn?: boolean;
	cdvDivider: number;
	cdvHeight: number;
	cdvWidth: number;
	columnWidths: ColumnWidth[] | null;
	commitOrdering: RepoCommitOrdering;
	fileViewType: FileViewType;
	hideRemotes: string[];
	includeCommitsMentionedByReflogs: BooleanOverride;
	issueLinkingConfig: IssueLinkingConfig | null;
	lastImportAt: number;
	name: string | null;
	onlyFollowFirstParent: BooleanOverride;
	onRepoLoadShowCheckedOutBranch: BooleanOverride;
	onRepoLoadShowSpecificBranches: string[] | null;
	pullRequestConfig: PullRequestConfig | null;
	showRemoteBranches: boolean;
	showRemoteBranchesV2: BooleanOverride;
	showStashes: BooleanOverride;
	showTags: BooleanOverride;
	workspaceFolderIndex: number | null;
}


/* Git Map View Types */

export type L10nBundle = { readonly [message: string]: string };

export interface GitGraphViewInitialState {
	readonly config: GitGraphViewConfig;
	readonly l10n: L10nBundle | null; // The translations of the messages displayed by the Git Map View (NULL => English)
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitGraphViewTo;
	readonly repos: GitRepoSet;
	readonly loadRepoInfoRefreshId: number;
	readonly loadCommitsRefreshId: number;
}

export interface AppearanceConfig {
	readonly colourPreset: string;
	readonly colourPresets: ReadonlyArray<{ readonly name: string, readonly colours: ReadonlyArray<string> }>;
	readonly displayLanguage: string; // The display language of Visual Studio Code
	readonly language: string; // The value of the git-map.language Extension Setting
	readonly statusBarItemDisplay: StatusBarItemDisplay;
}

export interface GitGraphViewConfig {
	readonly appearance: AppearanceConfig;
	readonly commitDetailsView: CommitDetailsViewConfig;
	readonly commitOrdering: CommitOrdering;
	readonly contextMenuActionsVisibility: ContextMenuActionsVisibility;
	readonly customBranchGlobPatterns: ReadonlyArray<CustomBranchGlobPattern>;
	readonly customEmojiShortcodeMappings: ReadonlyArray<CustomEmojiShortcodeMapping>;
	readonly customPullRequestProviders: ReadonlyArray<CustomPullRequestProvider>;
	readonly dateFormat: DateFormat;
	readonly defaultColumnVisibility: DefaultColumnVisibility;
	readonly dialogDefaults: DialogDefaults;
	readonly enhancedAccessibility: boolean;
	readonly explainCommit: boolean;
	readonly fetchAndPrune: boolean;
	readonly fetchAndPruneTags: boolean;
	readonly fetchAvatars: boolean;
	readonly graph: GraphConfig;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly initialLoadCommits: number;
	readonly keybindings: KeybindingConfig
	readonly loadMoreCommits: number;
	readonly loadMoreCommitsAutomatically: boolean;
	readonly markdown: boolean;
	readonly mute: MuteCommitsConfig;
	readonly onlyFollowFirstParent: boolean;
	readonly onRepoLoad: OnRepoLoadConfig;
	readonly referenceLabels: ReferenceLabelsConfig;
	readonly repoDropdownOrder: RepoDropdownOrder;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly showTags: boolean;
}

export interface GitGraphViewGlobalState {
	alwaysAcceptCheckoutCommit: boolean;
	issueLinkingConfig: IssueLinkingConfig | null;
	minimapHeight?: number;
	pushTagSkipRemoteCheck: boolean;
	explainCommitAccepted?: boolean; // Has the person agreed to send the changes of commits to a language model
	explainCommitModel?: string | null; // The id of the language model chosen to explain commits
}

export interface GitGraphViewWorkspaceState {
	findIsCaseSensitive: boolean;
	findIsRegex: boolean;
	findOpenCommitDetailsView: boolean;
}

export interface CommitDetailsViewConfig {
	readonly autoCenter: boolean;
	readonly fileTreeCompactFolders: boolean;
	readonly fileViewType: FileViewType;
	readonly location: CommitDetailsViewLocation;
}

export interface GraphConfig {
	readonly colours: ReadonlyArray<string>;
	readonly density: GraphDensity;
	readonly freezeColumnHeaders: boolean;
	readonly freezeFooter: boolean;
	readonly minimap: boolean;
	readonly nodeStyle: GraphNodeStyle;
	readonly style: GraphStyle;
	readonly grid: { x: number, y: number, offsetX: number, offsetY: number, expandY: number };
	readonly uncommittedChanges: GraphUncommittedChangesStyle;
}

export interface KeybindingConfig {
	readonly find: string | null;
	readonly refresh: string | null;
	readonly scrollToHead: string | null;
	readonly scrollToStash: string | null;
}

export type LoadGitGraphViewTo = {
	readonly repo: string,
	readonly commitDetails?: {
		readonly commitHash: string,
		readonly compareWithHash: string | null
	},
	readonly runCommandOnLoad?: 'fetch' | 'cleanUpBranches',
	readonly fileHistory?: string | null, // The path of a file whose history is shown (NULL => all commits are shown)
	readonly lineRange?: GitLineRange | null // The lines of the file whose history is shown (NULL => the whole file)
} | null;

export interface MuteCommitsConfig {
	readonly commitsNotAncestorsOfHead: boolean;
	readonly mergeCommits: boolean;
}

export interface OnRepoLoadConfig {
	readonly scrollToHead: boolean;
	readonly showCheckedOutBranch: boolean;
	readonly showSpecificBranches: ReadonlyArray<string>;
}

export interface ReferenceLabelsConfig {
	readonly branchLabelsAlignedToGraph: boolean;
	readonly combineLocalAndRemoteBranchLabels: boolean;
	readonly inSeparateColumn: boolean;
	readonly tagLabelsOnRight: boolean;
}


/* Extension Settings Types */

export const enum BooleanOverride {
	Default,
	Enabled,
	Disabled
}

export const enum CommitDetailsViewLocation {
	Inline,
	DockedToBottom,
	DockedToRight
}

export const enum CommitOrdering {
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export interface ContextMenuActionsVisibility {
	readonly branch: {
		readonly checkout: boolean;
		readonly rename: boolean;
		readonly delete: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly push: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly createWorktree: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
		readonly compare: boolean;
	};
	readonly commit: {
		readonly addTag: boolean;
		readonly createBranch: boolean;
		readonly createWorktree: boolean;
		readonly checkout: boolean;
		readonly cherrypick: boolean;
		readonly revert: boolean;
		readonly drop: boolean;
		readonly merge: boolean;
		readonly rebase: boolean;
		readonly reset: boolean;
		readonly copyHash: boolean;
		readonly copySubject: boolean;
		readonly editMessage: boolean;
		readonly undoCommit: boolean;
		readonly fixup: boolean;
		readonly bisect: boolean;
		readonly savePatch: boolean;
	};
	readonly commitDetailsViewFile: {
		readonly viewDiff: boolean;
		readonly viewFileAtThisRevision: boolean;
		readonly viewDiffWithWorkingFile: boolean;
		readonly openFile: boolean;
		readonly markAsReviewed: boolean;
		readonly markAsNotReviewed: boolean;
		readonly resetFileToThisRevision: boolean;
		readonly removeFromHistory: boolean;
		readonly copyAbsoluteFilePath: boolean;
		readonly copyRelativeFilePath: boolean;
		readonly stashFile: boolean;
		readonly restoreFromStash: boolean;
		readonly visualFileHistory: boolean;
	};
	readonly remoteBranch: {
		readonly checkout: boolean;
		readonly delete: boolean;
		readonly fetch: boolean;
		readonly merge: boolean;
		readonly pull: boolean;
		readonly viewIssue: boolean;
		readonly createPullRequest: boolean;
		readonly createArchive: boolean;
		readonly selectInBranchesDropdown: boolean;
		readonly unselectInBranchesDropdown: boolean;
		readonly copyName: boolean;
		readonly compare: boolean;
	};
	readonly stash: {
		readonly apply: boolean;
		readonly createBranch: boolean;
		readonly pop: boolean;
		readonly drop: boolean;
		readonly copyName: boolean;
		readonly copyHash: boolean;
		readonly savePatch: boolean;
	};
	readonly tag: {
		readonly viewDetails: boolean;
		readonly delete: boolean;
		readonly push: boolean;
		readonly createArchive: boolean;
		readonly copyName: boolean;
	};
	readonly uncommittedChanges: {
		readonly stash: boolean;
		readonly reset: boolean;
		readonly clean: boolean;
		readonly openSourceControlView: boolean;
		readonly savePatch: boolean;
		readonly applyPatch: boolean;
	};
}

export interface CustomBranchGlobPattern {
	readonly name: string;
	readonly glob: string;
}

export interface CustomEmojiShortcodeMapping {
	readonly shortcode: string;
	readonly emoji: string;
}

export interface CustomPullRequestProvider {
	readonly name: string;
	readonly templateUrl: string;
}

export interface DateFormat {
	readonly type: DateFormatType;
	readonly iso: boolean;
}

export const enum DateFormatType {
	DateAndTime,
	DateOnly,
	Relative
}

export const enum DateType {
	Author,
	Commit
}

export interface DefaultColumnVisibility {
	readonly date: boolean;
	readonly author: boolean;
	readonly commit: boolean;
}

export interface DialogDefaults {
	readonly addTag: {
		readonly pushToRemote: boolean,
		readonly type: TagType
	};
	readonly applyStash: {
		readonly reinstateIndex: boolean
	};
	readonly cherryPick: {
		readonly noCommit: boolean,
		readonly recordOrigin: boolean
	};
	readonly createBranch: {
		readonly checkout: boolean
	};
	readonly deleteBranch: {
		readonly forceDelete: boolean
	};
	readonly fetchIntoLocalBranch: {
		readonly forceFetch: boolean
	};
	readonly fetchRemote: {
		readonly prune: boolean,
		readonly pruneTags: boolean
	};
	readonly general: {
		readonly referenceInputSpaceSubstitution: string | null
	};
	readonly merge: {
		readonly noCommit: boolean,
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly popStash: {
		readonly reinstateIndex: boolean
	};
	readonly pullBranch: {
		readonly noFastForward: boolean,
		readonly squash: boolean
	};
	readonly rebase: {
		readonly ignoreDate: boolean,
		readonly interactive: boolean
	};
	readonly resetCommit: {
		readonly mode: GitResetMode
	};
	readonly resetUncommitted: {
		readonly mode: Exclude<GitResetMode, GitResetMode.Soft>
	};
	readonly stashUncommittedChanges: {
		readonly includeUntracked: boolean
	};
}

export const enum FileViewType {
	Default,
	Tree,
	List
}

export const enum GraphStyle {
	Rounded,
	Angular
}

export const enum LineHistoryLocation {
	Drawer,
	InlineWindow
}

export const enum GraphDensity {
	Comfortable,
	Compact
}

export const enum GraphNodeStyle {
	Dot,
	Avatar
}

export const enum GraphUncommittedChangesStyle {
	OpenCircleAtTheUncommittedChanges,
	OpenCircleAtTheCheckedOutCommit
}

export const enum RefLabelAlignment {
	Normal,
	BranchesOnLeftAndTagsOnRight,
	BranchesAlignedToGraphAndTagsOnRight,
	SeparateColumn
}

export const enum RepoCommitOrdering {
	Default = 'default',
	Date = 'date',
	AuthorDate = 'author-date',
	Topological = 'topo'
}

export const enum RepoDropdownOrder {
	FullPath,
	Name,
	WorkspaceFullPath
}

export const enum SquashMessageFormat {
	Default,
	GitSquashMsg
}

export const enum StatusBarItemDisplay {
	IconAndText,
	Icon,
	Text
}

export const enum TabIconColourTheme {
	Colour,
	Grey
}

export const enum TagType {
	Annotated,
	Lightweight
}


/* Base Interfaces for Request / Response Messages */

export interface BaseMessage {
	readonly command: string;
}

export interface RepoRequest extends BaseMessage {
	readonly repo: string;
}

export interface ResponseWithErrorInfo extends BaseMessage {
	readonly error: ErrorInfo;
}

export interface ResponseWithMultiErrorInfo extends BaseMessage {
	readonly errors: ErrorInfo[];
}

export type ErrorInfo = string | null; // null => no error, otherwise => error message

export const enum ErrorInfoExtensionPrefix {
	PushTagCommitNotOnRemote = 'VSCODE_GIT_GRAPH:PUSH_TAG:COMMIT_NOT_ON_REMOTE:'
}

/* Request / Response Messages */

export interface RequestAddRemote extends RepoRequest {
	readonly command: 'addRemote';
	readonly name: string;
	readonly url: string;
	readonly pushUrl: string | null;
	readonly fetch: boolean;
}
export interface ResponseAddRemote extends ResponseWithErrorInfo {
	readonly command: 'addRemote';
}

export interface RequestAddTag extends RepoRequest {
	readonly command: 'addTag';
	readonly commitHash: string;
	readonly tagName: string;
	readonly type: TagType;
	readonly message: string;
	readonly pushToRemote: string | null; // string => name of the remote to push the tag to, null => don't push to a remote
	readonly pushSkipRemoteCheck: boolean;
	readonly force: boolean;
}
export interface ResponseAddTag extends ResponseWithMultiErrorInfo {
	readonly command: 'addTag';
	readonly repo: string;
	readonly tagName: string;
	readonly pushToRemote: string | null;
	readonly commitHash: string;
}

export interface RequestApplyStash extends RepoRequest {
	readonly command: 'applyStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponseApplyStash extends ResponseWithErrorInfo {
	readonly command: 'applyStash';
}

export interface RequestBranchFromStash extends RepoRequest {
	readonly command: 'branchFromStash';
	readonly selector: string;
	readonly branchName: string;
}
export interface ResponseBranchFromStash extends ResponseWithErrorInfo {
	readonly command: 'branchFromStash';
}

export interface RequestCheckoutBranch extends RepoRequest {
	readonly command: 'checkoutBranch';
	readonly branchName: string;
	readonly remoteBranch: string | null;
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
		readonly createNewCommit: boolean;
		readonly squash: boolean;
	} | null; // NULL => Don't pull after checking out
}
export interface ResponseCheckoutBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'checkoutBranch';
	readonly pullAfterwards: {
		readonly branchName: string;
		readonly remote: string;
	} | null; // NULL => Don't pull after checking out
}

export interface RequestCheckoutCommit extends RepoRequest {
	readonly command: 'checkoutCommit';
	readonly commitHash: string;
}
export interface ResponseCheckoutCommit extends ResponseWithErrorInfo {
	readonly command: 'checkoutCommit';
}

export interface RequestCherrypickCommit extends RepoRequest {
	readonly command: 'cherrypickCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
}
export interface ResponseCherrypickCommit extends ResponseWithMultiErrorInfo {
	readonly command: 'cherrypickCommit';
}

export interface RequestCherrypickCommits extends RepoRequest {
	readonly command: 'cherrypickCommits';
	readonly commitHashes: ReadonlyArray<string>; // In the order they are cherry picked (oldest first)
	readonly recordOrigin: boolean;
	readonly noCommit: boolean;
}
export interface ResponseCherrypickCommits extends ResponseWithMultiErrorInfo {
	readonly command: 'cherrypickCommits';
}

export interface RequestCleanUntrackedFiles extends RepoRequest {
	readonly command: 'cleanUntrackedFiles';
	readonly directories: boolean;
}
export interface ResponseCleanUntrackedFiles extends ResponseWithErrorInfo {
	readonly command: 'cleanUntrackedFiles';
}

export interface RequestCommitDetails extends RepoRequest {
	readonly command: 'commitDetails';
	readonly commitHash: string;
	readonly hasParents: boolean;
	readonly stash: GitCommitStash | null; // null => request is for a commit, otherwise => request is for a stash
	readonly avatarEmail: string | null; // string => fetch avatar with the given email, null => don't fetch avatar
	readonly refresh: boolean;
}
export interface ResponseCommitDetails extends ResponseWithErrorInfo {
	readonly command: 'commitDetails';
	readonly commitDetails: GitCommitDetails | null;
	readonly avatar: string | null;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

export interface RequestCompareCommits extends RepoRequest {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fromHash: string;
	readonly toHash: string;
	readonly refresh: boolean;
}
export interface ResponseCompareCommits extends ResponseWithErrorInfo {
	readonly command: 'compareCommits';
	readonly commitHash: string;
	readonly compareWithHash: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
	readonly codeReview: CodeReview | null;
	readonly refresh: boolean;
}

export interface RequestCopyFilePath extends RepoRequest {
	readonly command: 'copyFilePath';
	readonly filePath: string;
	readonly absolute: boolean;
}
export interface ResponseCopyFilePath extends ResponseWithErrorInfo {
	readonly command: 'copyFilePath';
}

export interface RequestCopyToClipboard extends BaseMessage {
	readonly command: 'copyToClipboard';
	readonly type: string;
	readonly data: string;
}
export interface ResponseCopyToClipboard extends ResponseWithErrorInfo {
	readonly command: 'copyToClipboard';
	readonly type: string;
}

export interface RequestCreateArchive extends RepoRequest {
	readonly command: 'createArchive';
	readonly ref: string;
}
export interface ResponseCreateArchive extends ResponseWithErrorInfo {
	readonly command: 'createArchive';
}

export interface RequestCreateBranch extends RepoRequest {
	readonly command: 'createBranch';
	readonly commitHash: string;
	readonly branchName: string;
	readonly checkout: boolean;
	readonly force: boolean;
}
export interface ResponseCreateBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'createBranch';
}

export interface RequestCreatePullRequest extends RepoRequest {
	readonly command: 'createPullRequest';
	readonly config: PullRequestConfig;
	readonly sourceRemote: string;
	readonly sourceOwner: string;
	readonly sourceRepo: string;
	readonly sourceBranch: string;
	readonly push: boolean;
}
export interface ResponseCreatePullRequest extends ResponseWithMultiErrorInfo {
	readonly command: 'createPullRequest';
	readonly push: boolean;
}

export interface RequestDeleteBranch extends RepoRequest {
	readonly command: 'deleteBranch';
	readonly branchName: string;
	readonly forceDelete: boolean;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}
export interface ResponseDeleteBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteBranch';
	readonly repo: string;
	readonly branchName: string;
	readonly deleteOnRemotes: ReadonlyArray<string>;
}

export interface RequestDeleteRemote extends RepoRequest {
	readonly command: 'deleteRemote';
	readonly name: string;
}
export interface ResponseDeleteRemote extends ResponseWithErrorInfo {
	readonly command: 'deleteRemote';
}

export interface RequestDeleteRemoteBranch extends RepoRequest {
	readonly command: 'deleteRemoteBranch';
	readonly branchName: string;
	readonly remote: string;
}
export interface ResponseDeleteRemoteBranch extends ResponseWithErrorInfo {
	readonly command: 'deleteRemoteBranch';
}

export interface RequestDeleteTag extends RepoRequest {
	readonly command: 'deleteTag';
	readonly tagName: string;
	readonly deleteOnRemote: string | null; // null => don't delete on remote, otherwise => remote to delete on
}
export interface ResponseDeleteTag extends ResponseWithErrorInfo {
	readonly command: 'deleteTag';
}

export interface RequestDeleteUserDetails extends RepoRequest {
	readonly command: 'deleteUserDetails';
	readonly name: boolean; // TRUE => Delete Name, FALSE => Don't Delete Name
	readonly email: boolean; // TRUE => Delete Email, FALSE => Don't Delete Email
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
}
export interface ResponseDeleteUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteUserDetails';
}

export interface RequestDropCommit extends RepoRequest {
	readonly command: 'dropCommit';
	readonly commitHash: string;
}
export interface ResponseDropCommit extends ResponseWithErrorInfo {
	readonly command: 'dropCommit';
}

export interface RequestDropStash extends RepoRequest {
	readonly command: 'dropStash';
	readonly selector: string;
}
export interface ResponseDropStash extends ResponseWithErrorInfo {
	readonly command: 'dropStash';
}

export interface RequestEditRemote extends RepoRequest {
	readonly command: 'editRemote';
	readonly nameOld: string;
	readonly nameNew: string;
	readonly urlOld: string | null;
	readonly urlNew: string | null;
	readonly pushUrlOld: string | null;
	readonly pushUrlNew: string | null;
}
export interface ResponseEditRemote extends ResponseWithErrorInfo {
	readonly command: 'editRemote';
}

export interface RequestEditUserDetails extends RepoRequest {
	readonly command: 'editUserDetails';
	readonly name: string;
	readonly email: string;
	readonly location: GitConfigLocation.Global | GitConfigLocation.Local;
	readonly deleteLocalName: boolean; // TRUE => Delete Local Name, FALSE => Don't Delete Local Name
	readonly deleteLocalEmail: boolean; // TRUE => Delete Local Email, FALSE => Don't Delete Local Email
}
export interface ResponseEditUserDetails extends ResponseWithMultiErrorInfo {
	readonly command: 'editUserDetails';
}

export interface RequestEndCodeReview extends RepoRequest {
	readonly command: 'endCodeReview';
	readonly id: string;
}

export interface RequestExportRepoConfig extends RepoRequest {
	readonly command: 'exportRepoConfig';
}
export interface ResponseExportRepoConfig extends ResponseWithErrorInfo {
	readonly command: 'exportRepoConfig';
}

export interface RequestFetch extends RepoRequest {
	readonly command: 'fetch';
	readonly name: string | null; // null => Fetch all remotes
	readonly prune: boolean;
	readonly pruneTags: boolean;
}
export interface ResponseFetch extends ResponseWithErrorInfo {
	readonly command: 'fetch';
}

export interface RequestFetchAvatar extends RepoRequest {
	readonly command: 'fetchAvatar';
	readonly remote: string | null;
	readonly email: string;
	readonly commits: string[];
}
export interface ResponseFetchAvatar extends BaseMessage {
	readonly command: 'fetchAvatar';
	readonly email: string;
	readonly image: string;
}

export interface RequestFetchIntoLocalBranch extends RepoRequest {
	readonly command: 'fetchIntoLocalBranch';
	readonly remote: string;
	readonly remoteBranch: string;
	readonly localBranch: string;
	readonly force: boolean;
}
export interface ResponseFetchIntoLocalBranch extends ResponseWithErrorInfo {
	readonly command: 'fetchIntoLocalBranch';
}

export interface RequestLoadCommits extends RepoRequest {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly branches: ReadonlyArray<string> | null; // null => Show All
	readonly maxCommits: number;
	readonly showTags: boolean;
	readonly showRemoteBranches: boolean;
	readonly includeCommitsMentionedByReflogs: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly commitOrdering: CommitOrdering;
	readonly remotes: ReadonlyArray<string>;
	readonly hideRemotes: ReadonlyArray<string>;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly authors: ReadonlyArray<string> | null; // null => Show All
	readonly filePath: string | null; // null => All commits (not the history of a file)
	readonly lineRange?: GitLineRange | null; // The lines of the file whose history is shown (null => The history of the whole file)
}
export interface ResponseLoadCommits extends ResponseWithErrorInfo {
	readonly command: 'loadCommits';
	readonly refreshId: number;
	readonly commits: GitCommit[];
	readonly head: string | null;
	readonly tags: string[];
	readonly moreCommitsAvailable: boolean;
	readonly onlyFollowFirstParent: boolean;
	readonly fileHistory: GitFileHistory | null;
}

export interface RequestLoadConfig extends RepoRequest {
	readonly command: 'loadConfig';
	readonly remotes: ReadonlyArray<string>;
}
export interface ResponseLoadConfig extends ResponseWithErrorInfo {
	readonly command: 'loadConfig';
	readonly repo: string;
	readonly config: GitRepoConfig | null;
}

export interface RequestLoadRepoInfo extends RepoRequest {
	readonly command: 'loadRepoInfo';
	readonly refreshId: number;
	readonly showRemoteBranches: boolean;
	readonly showStashes: boolean;
	readonly hideRemotes: ReadonlyArray<string>;
}
export interface ResponseLoadRepoInfo extends ResponseWithErrorInfo {
	readonly command: 'loadRepoInfo';
	readonly refreshId: number;
	readonly branches: ReadonlyArray<string>;
	readonly head: string | null;
	readonly remotes: ReadonlyArray<string>;
	readonly upstreams: GitBranchUpstreams;
	readonly stashes: ReadonlyArray<GitStash>;
	readonly isRepo: boolean;
	readonly undo: UndoInfo | null; // The last action in the repository that can be undone
}

/**
 * An action that can be undone.
 */
export interface UndoInfo {
	readonly id: number; // Identifies the action (each action that can be undone has a different id)
	readonly description: string;
}

export interface RequestLoadWorktrees extends RepoRequest {
	readonly command: 'loadWorktrees';
}
export interface ResponseLoadWorktrees extends ResponseWithErrorInfo {
	readonly command: 'loadWorktrees';
	readonly repo: string;
	readonly worktrees: ReadonlyArray<GitWorktree>;
}

export interface RequestAddWorktree extends RepoRequest {
	readonly command: 'addWorktree';
	readonly path: string;
	readonly ref: string; // The branch to check out in the worktree, or the commit it's created at
	readonly newBranch: string | null; // The name of a new branch to create at `ref` (and check out in the worktree)
	readonly open: boolean; // Open the worktree in a new window after it's created
}
export interface ResponseAddWorktree extends ResponseWithMultiErrorInfo {
	readonly command: 'addWorktree';
}

export interface RequestRemoveWorktree extends RepoRequest {
	readonly command: 'removeWorktree';
	readonly path: string;
	readonly force: boolean; // Remove the worktree even if it has uncommitted changes or untracked files (which are lost)
}
export interface ResponseRemoveWorktree extends ResponseWithErrorInfo {
	readonly command: 'removeWorktree';
}

export interface RequestPruneWorktrees extends RepoRequest {
	readonly command: 'pruneWorktrees';
}
export interface ResponsePruneWorktrees extends ResponseWithErrorInfo {
	readonly command: 'pruneWorktrees';
}

export interface RequestOpenWorktree extends BaseMessage {
	readonly command: 'openWorktree';
	readonly path: string;
}
export interface ResponseOpenWorktree extends ResponseWithErrorInfo {
	readonly command: 'openWorktree';
}

/**
 * A commit that's rebased by an interactive rebase.
 */
export interface GitRebaseCommit {
	readonly hash: string;
	readonly subject: string;
	readonly message: string; // The full commit message
	readonly author: string;
	readonly date: number;
}

/**
 * How a commit is rebased by an interactive rebase.
 */
export interface GitRebaseTodoItem {
	readonly action: 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';
	readonly hash: string;
	readonly message: string | null; // The new commit message (for reword)
}

/**
 * An operation that's in progress in a repository (e.g. a rebase that stopped because of conflicts).
 */
export type GitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'am';

export interface RequestLoadRebaseCommits extends RepoRequest {
	readonly command: 'loadRebaseCommits';
	readonly base: string;
}
export interface ResponseLoadRebaseCommits extends ResponseWithErrorInfo {
	readonly command: 'loadRebaseCommits';
	readonly base: string;
	readonly commits: ReadonlyArray<GitRebaseCommit>; // Oldest first
}

export interface RequestRebaseInteractive extends RepoRequest {
	readonly command: 'rebaseInteractive';
	readonly base: string;
	readonly todo: ReadonlyArray<GitRebaseTodoItem>; // In the order the commits are rebased
}
export interface ResponseRebaseInteractive extends ResponseWithErrorInfo {
	readonly command: 'rebaseInteractive';
}

export interface RequestLoadOperationInProgress extends RepoRequest {
	readonly command: 'loadOperationInProgress';
}
export interface ResponseLoadOperationInProgress extends BaseMessage {
	readonly command: 'loadOperationInProgress';
	readonly repo: string;
	readonly operation: GitOperation | null;
}

export interface RequestControlOperation extends RepoRequest {
	readonly command: 'controlOperation';
	readonly operation: GitOperation;
	readonly action: 'continue' | 'skip' | 'abort';
}
export interface ResponseControlOperation extends ResponseWithErrorInfo {
	readonly command: 'controlOperation';
	readonly action: 'continue' | 'skip' | 'abort';
}

export interface RequestUndo extends RepoRequest {
	readonly command: 'undo';
}
export interface ResponseUndo extends ResponseWithErrorInfo {
	readonly command: 'undo';
}

export interface RequestSearchCommits extends RepoRequest {
	readonly command: 'searchCommits';
	readonly id: number;
	readonly files: ReadonlyArray<string>;
	readonly changes: ReadonlyArray<string>;
	readonly isRegex: boolean;
	readonly isCaseSensitive: boolean;
	readonly since: number;
}
export interface ResponseSearchCommits extends ResponseWithErrorInfo {
	readonly command: 'searchCommits';
	readonly id: number;
	readonly hashes: ReadonlyArray<string>;
}

export interface RequestLoadFileIconTheme extends BaseMessage {
	readonly command: 'loadFileIconTheme';
}
export interface ResponseLoadFileIconTheme extends BaseMessage {
	readonly command: 'loadFileIconTheme';
	readonly theme: FileIconTheme | null;
}

export interface RequestLoadCommitStats extends RepoRequest {
	readonly command: 'loadCommitStats';
	readonly hashes: ReadonlyArray<string>; // The uncommitted changes are requested with the hash "*"
}
export interface ResponseLoadCommitStats extends ResponseWithErrorInfo {
	readonly command: 'loadCommitStats';
	readonly stats: { readonly [hash: string]: GitCommitStats | null }; // NULL => The commit doesn't change any files (e.g. a merge commit)
}

export interface RequestLoadFileDiff extends RepoRequest {
	readonly command: 'loadFileDiff';
	readonly commitHash: string;
	readonly parentHash: string | null;
	readonly oldFilePath: string;
	readonly newFilePath: string;
}
export interface ResponseLoadFileDiff extends ResponseWithErrorInfo {
	readonly command: 'loadFileDiff';
	readonly commitHash: string;
	readonly filePath: string;
	readonly diff: string;
}

export interface RequestLoadStashStats extends RepoRequest {
	readonly command: 'loadStashStats';
	readonly stashes: ReadonlyArray<{ readonly hash: string, readonly baseHash: string, readonly untrackedFilesHash: string | null }>;
}
export interface ResponseLoadStashStats extends ResponseWithErrorInfo {
	readonly command: 'loadStashStats';
	readonly stats: { readonly [hash: string]: GitStashStats };
}

export interface RequestLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly check: boolean;
}
export interface ResponseLoadRepos extends BaseMessage {
	readonly command: 'loadRepos';
	readonly repos: GitRepoSet;
	readonly lastActiveRepo: string | null;
	readonly loadViewTo: LoadGitGraphViewTo;
}

export const enum MergeActionOn {
	Branch = 'Branch',
	RemoteTrackingBranch = 'Remote-tracking Branch',
	Commit = 'Commit'
}
export interface RequestMerge extends RepoRequest {
	readonly command: 'merge';
	readonly obj: string;
	readonly actionOn: MergeActionOn;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
	readonly noCommit: boolean;
}
export interface ResponseMerge extends ResponseWithErrorInfo {
	readonly command: 'merge';
	readonly actionOn: MergeActionOn;
}

export interface RequestUpdateExtensionSetting extends BaseMessage {
	readonly command: 'updateExtensionSetting';
	readonly key: 'graph.colourPreset' | 'graph.density' | 'graph.freezeColumnHeaders' | 'graph.freezeFooter' | 'graph.nodeStyle' | 'graph.style' | 'language' | 'statusBarItemDisplay';
	readonly value: string | boolean;
}
export interface ResponseUpdateExtensionSetting extends ResponseWithErrorInfo {
	readonly command: 'updateExtensionSetting';
}

export interface RequestOpenExtensionSettings extends BaseMessage {
	readonly command: 'openExtensionSettings';
}
export interface ResponseOpenExtensionSettings extends ResponseWithErrorInfo {
	readonly command: 'openExtensionSettings';
}

export interface RequestOpenExternalDirDiff extends RepoRequest {
	readonly command: 'openExternalDirDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly isGui: boolean;
}
export interface ResponseOpenExternalDirDiff extends ResponseWithErrorInfo {
	readonly command: 'openExternalDirDiff';
}

export interface RequestNavigateEditorHistory extends BaseMessage {
	readonly command: 'navigateEditorHistory';
	readonly forward: boolean;
}

export interface RequestOpenExternalUrl extends BaseMessage {
	readonly command: 'openExternalUrl';
	readonly url: string;
}
export interface ResponseOpenExternalUrl extends ResponseWithErrorInfo {
	readonly command: 'openExternalUrl';
}

export interface RequestOpenFile extends RepoRequest {
	readonly command: 'openFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseOpenFile extends ResponseWithErrorInfo {
	readonly command: 'openFile';
}

export interface RequestOpenTerminal extends RepoRequest {
	readonly command: 'openTerminal';
	readonly name: string;
}
export interface ResponseOpenTerminal extends ResponseWithErrorInfo {
	readonly command: 'openTerminal';
}

export interface RequestPopStash extends RepoRequest {
	readonly command: 'popStash';
	readonly selector: string;
	readonly reinstateIndex: boolean;
}
export interface ResponsePopStash extends ResponseWithErrorInfo {
	readonly command: 'popStash';
}

export interface RequestPruneRemote extends RepoRequest {
	readonly command: 'pruneRemote';
	readonly name: string;
}
export interface ResponsePruneRemote extends ResponseWithErrorInfo {
	readonly command: 'pruneRemote';
}

export interface RequestPullBranch extends RepoRequest {
	readonly command: 'pullBranch';
	readonly branchName: string;
	readonly remote: string;
	readonly createNewCommit: boolean;
	readonly squash: boolean;
}
export interface ResponsePullBranch extends ResponseWithErrorInfo {
	readonly command: 'pullBranch';
}

export interface RequestPushBranch extends RepoRequest {
	readonly command: 'pushBranch';
	readonly branchName: string;
	readonly remotes: string[];
	readonly setUpstream: boolean;
	readonly mode: GitPushBranchMode;
	readonly willUpdateBranchConfig: boolean;
}
export interface ResponsePushBranch extends ResponseWithMultiErrorInfo {
	readonly command: 'pushBranch';
	readonly willUpdateBranchConfig: boolean;
}

export interface RequestPushStash extends RepoRequest {
	readonly command: 'pushStash';
	readonly message: string;
	readonly includeUntracked: boolean;
	readonly paths: ReadonlyArray<string> | null; // The files to stash (NULL => all of the uncommitted changes)
	readonly onlyStaged: boolean;
}
export interface ResponsePushStash extends ResponseWithErrorInfo {
	readonly command: 'pushStash';
}

export interface RequestPushTag extends RepoRequest {
	readonly command: 'pushTag';
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
	readonly skipRemoteCheck: boolean;
}
export interface ResponsePushTag extends ResponseWithMultiErrorInfo {
	readonly command: 'pushTag';
	readonly repo: string;
	readonly tagName: string;
	readonly remotes: string[];
	readonly commitHash: string;
}

export const enum RebaseActionOn {
	Branch = 'Branch',
	Commit = 'Commit'
}
export interface RequestRebase extends RepoRequest {
	readonly command: 'rebase';
	readonly obj: string;
	readonly actionOn: RebaseActionOn;
	readonly ignoreDate: boolean;
	readonly interactive: boolean;
}
export interface ResponseRebase extends ResponseWithErrorInfo {
	readonly command: 'rebase';
	readonly actionOn: RebaseActionOn;
	readonly interactive: boolean;
}

export interface ResponseRefresh extends BaseMessage {
	readonly command: 'refresh';
}

export interface RequestRenameBranch extends RepoRequest {
	readonly command: 'renameBranch';
	readonly oldName: string;
	readonly newName: string;
}
export interface ResponseRenameBranch extends ResponseWithErrorInfo {
	readonly command: 'renameBranch';
}

export interface RequestRescanForRepos extends BaseMessage {
	readonly command: 'rescanForRepos';
}

export interface RequestRemoveFilesFromHistory extends RepoRequest {
	readonly command: 'removeFilesFromHistory';
	readonly filePaths: ReadonlyArray<string>;
}

export interface RequestResetFileToRevision extends RepoRequest {
	readonly command: 'resetFileToRevision';
	readonly commitHash: string;
	readonly filePath: string;
}
export interface ResponseResetFileToRevision extends ResponseWithErrorInfo {
	readonly command: 'resetFileToRevision';
}

export interface RequestResetToCommit extends RepoRequest {
	readonly command: 'resetToCommit';
	readonly commit: string;
	readonly resetMode: GitResetMode;
}
export interface ResponseResetToCommit extends ResponseWithErrorInfo {
	readonly command: 'resetToCommit';
}

export interface RequestRevertCommit extends RepoRequest {
	readonly command: 'revertCommit';
	readonly commitHash: string;
	readonly parentIndex: number;
}
export interface ResponseRevertCommit extends ResponseWithErrorInfo {
	readonly command: 'revertCommit';
}

export interface RequestSetGlobalViewState extends BaseMessage {
	readonly command: 'setGlobalViewState';
	readonly state: GitGraphViewGlobalState;
}
export interface ResponseSetGlobalViewState extends ResponseWithErrorInfo {
	readonly command: 'setGlobalViewState';
}

export interface RequestSetRepoState extends RepoRequest {
	readonly command: 'setRepoState';
	readonly state: GitRepoState;
}

export interface RequestSetWorkspaceViewState extends BaseMessage {
	readonly command: 'setWorkspaceViewState';
	readonly state: GitGraphViewWorkspaceState;
}
export interface ResponseSetWorkspaceViewState extends ResponseWithErrorInfo {
	readonly command: 'setWorkspaceViewState';
}

export interface RequestShowErrorDialog extends BaseMessage {
	readonly command: 'showErrorMessage';
	readonly message: string;
}

export interface RequestStartCodeReview extends RepoRequest {
	readonly command: 'startCodeReview';
	readonly id: string;
	readonly files: string[];
	readonly lastViewedFile: string | null;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}
export interface ResponseStartCodeReview extends ResponseWithErrorInfo {
	readonly command: 'startCodeReview';
	readonly codeReview: CodeReview;
	readonly commitHash: string;
	readonly compareWithHash: string | null;
}

export interface RequestTagDetails extends RepoRequest {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
}
export interface ResponseTagDetails extends ResponseWithErrorInfo {
	readonly command: 'tagDetails';
	readonly tagName: string;
	readonly commitHash: string;
	readonly details: GitTagDetails | null;
}

export interface RequestUpdateCodeReview extends RepoRequest {
	readonly command: 'updateCodeReview';
	readonly id: string;
	readonly remainingFiles: string[];
	readonly lastViewedFile: string | null;
}

export interface ResponseUpdateCodeReview extends ResponseWithErrorInfo {
	readonly command: 'updateCodeReview';
}

export interface RequestViewDiff extends RepoRequest {
	readonly command: 'viewDiff';
	readonly fromHash: string;
	readonly toHash: string;
	readonly oldFilePath: string;
	readonly newFilePath: string;
	readonly type: GitFileStatus;
}
export interface ResponseViewDiff extends ResponseWithErrorInfo {
	readonly command: 'viewDiff';
}

export interface RequestViewDiffWithWorkingFile extends RepoRequest {
	readonly command: 'viewDiffWithWorkingFile';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewDiffWithWorkingFile extends ResponseWithErrorInfo {
	readonly command: 'viewDiffWithWorkingFile';
}

export interface RequestViewFileAtRevision extends RepoRequest {
	readonly command: 'viewFileAtRevision';
	readonly hash: string;
	readonly filePath: string;
}
export interface ResponseViewFileAtRevision extends ResponseWithErrorInfo {
	readonly command: 'viewFileAtRevision';
}

export interface RequestViewScm extends BaseMessage {
	readonly command: 'viewScm';
}
export interface ResponseViewScm extends ResponseWithErrorInfo {
	readonly command: 'viewScm';
}

/* Branch Comparison, Branch Clean Up, Rewriting Commits, Bisect, Patches, Stashes, Visual File History & Explain Commit */

export interface RequestCompareBranches extends RepoRequest {
	readonly command: 'compareBranches';
	readonly left: string;
	readonly right: string;
}
export interface ResponseCompareBranches extends ResponseWithErrorInfo {
	readonly command: 'compareBranches';
	readonly comparison: GitBranchComparison | null;
	readonly fileChanges: GitFileChange[];
}

export interface RequestOpenAllChanges extends RepoRequest {
	readonly command: 'openAllChanges';
	readonly title: string;
	readonly fromHash: string;
	readonly toHash: string;
	readonly fileChanges: ReadonlyArray<GitFileChange>;
}
export interface ResponseOpenAllChanges extends ResponseWithErrorInfo {
	readonly command: 'openAllChanges';
}

export interface RequestLoadBranchCleanup extends RepoRequest {
	readonly command: 'loadBranchCleanup';
}
export interface ResponseLoadBranchCleanup extends ResponseWithErrorInfo {
	readonly command: 'loadBranchCleanup';
	readonly repo: string;
	readonly defaultBranch: string | null;
	readonly candidates: ReadonlyArray<GitBranchCleanupCandidate>;
}

export interface RequestDeleteBranches extends RepoRequest {
	readonly command: 'deleteBranches';
	readonly branches: ReadonlyArray<string>;
	readonly remoteBranches: ReadonlyArray<{ readonly remote: string, readonly branch: string }>;
}
export interface ResponseDeleteBranches extends ResponseWithMultiErrorInfo {
	readonly command: 'deleteBranches';
	readonly deleted: number;
}

export interface RequestEditCommitMessage extends RepoRequest {
	readonly command: 'editCommitMessage';
	readonly commitHash: string;
	readonly message: string;
}
export interface ResponseEditCommitMessage extends ResponseWithErrorInfo {
	readonly command: 'editCommitMessage';
}

export interface RequestLoadCommitMessage extends RepoRequest {
	readonly command: 'loadCommitMessage';
	readonly commitHash: string;
}
export interface ResponseLoadCommitMessage extends ResponseWithErrorInfo {
	readonly command: 'loadCommitMessage';
	readonly commitHash: string;
	readonly message: string;
}

export interface RequestUndoCommit extends RepoRequest {
	readonly command: 'undoCommit';
	readonly mode: 'soft' | 'mixed';
}
export interface ResponseUndoCommit extends ResponseWithErrorInfo {
	readonly command: 'undoCommit';
}

export interface RequestFixupCommit extends RepoRequest {
	readonly command: 'fixupCommit';
	readonly commitHash: string;
}
export interface ResponseFixupCommit extends ResponseWithErrorInfo {
	readonly command: 'fixupCommit';
}

export interface RequestBisect extends RepoRequest {
	readonly command: 'bisect';
	readonly action: 'start' | 'good' | 'bad' | 'skip' | 'reset';
	readonly commitHash: string | null;
	readonly goodRef: string | null;
}
export interface ResponseBisect extends ResponseWithErrorInfo {
	readonly command: 'bisect';
	readonly action: 'start' | 'good' | 'bad' | 'skip' | 'reset';
}

export interface RequestLoadBisectState extends RepoRequest {
	readonly command: 'loadBisectState';
}
export interface ResponseLoadBisectState extends BaseMessage {
	readonly command: 'loadBisectState';
	readonly repo: string;
	readonly state: GitBisectState | null;
}

export interface RequestSavePatch extends RepoRequest {
	readonly command: 'savePatch';
	readonly kind: 'commits' | 'stash' | 'uncommitted';
	readonly hashes: ReadonlyArray<string>; // The commits (oldest first), or the stash
	readonly name: string; // The name of the file that's suggested
	readonly copy: boolean; // Copy the patch to the clipboard (instead of saving it to a file)
}
export interface ResponseSavePatch extends ResponseWithErrorInfo {
	readonly command: 'savePatch';
}

export interface RequestCheckPatch extends RepoRequest {
	readonly command: 'checkPatch';
}
export interface ResponseCheckPatch extends ResponseWithErrorInfo {
	readonly command: 'checkPatch';
	readonly patch: GitPatchInfo | null; // NULL => No file was chosen
}

export interface RequestApplyPatch extends RepoRequest {
	readonly command: 'applyPatch';
	readonly file: string;
	readonly asCommits: boolean;
}
export interface ResponseApplyPatch extends ResponseWithErrorInfo {
	readonly command: 'applyPatch';
}

export interface RequestLoadStashableFiles extends RepoRequest {
	readonly command: 'loadStashableFiles';
	readonly filePath: string | null; // The only file that's initially selected (NULL => all of them are)
}
export interface ResponseLoadStashableFiles extends ResponseWithErrorInfo {
	readonly command: 'loadStashableFiles';
	readonly files: ReadonlyArray<GitStashableFile>;
	readonly filePath: string | null;
	readonly stagedSupported: boolean;
}

export interface RequestRestoreFileFromStash extends RepoRequest {
	readonly command: 'restoreFileFromStash';
	readonly stashHash: string;
	readonly selector: string;
	readonly filePath: string;
	readonly untracked: boolean;
	readonly force: boolean;
}
export interface ResponseRestoreFileFromStash extends ResponseWithErrorInfo {
	readonly command: 'restoreFileFromStash';
	readonly stashHash: string;
	readonly selector: string;
	readonly filePath: string;
	readonly untracked: boolean;
	readonly hasChanges: boolean; // The file wasn't restored, as it has uncommitted changes
}

export interface RequestViewVisualFileHistory extends RepoRequest {
	readonly command: 'viewVisualFileHistory';
	readonly filePath: string;
}

export interface RequestLoadLanguageModels extends BaseMessage {
	readonly command: 'loadLanguageModels';
}
export interface ResponseLoadLanguageModels extends ResponseWithErrorInfo {
	readonly command: 'loadLanguageModels';
	readonly models: ReadonlyArray<LanguageModelInfo>;
}

export interface RequestExplainCommit extends RepoRequest {
	readonly command: 'explainCommit';
	readonly commitHash: string;
	readonly modelId: string | null;
}
export interface ResponseExplainCommit extends ResponseWithErrorInfo {
	readonly command: 'explainCommit';
	readonly commitHash: string;
	readonly text: string;
	readonly done: boolean;
	readonly model: string | null;
	readonly truncated: boolean;
}

export type RequestMessage =
	RequestAddRemote
	| RequestAddTag
	| RequestApplyStash
	| RequestBranchFromStash
	| RequestCheckoutBranch
	| RequestCheckoutCommit
	| RequestCherrypickCommit
	| RequestCherrypickCommits
	| RequestUndo
	| RequestLoadRebaseCommits
	| RequestRebaseInteractive
	| RequestLoadOperationInProgress
	| RequestControlOperation
	| RequestLoadWorktrees
	| RequestAddWorktree
	| RequestRemoveWorktree
	| RequestPruneWorktrees
	| RequestOpenWorktree
	| RequestCleanUntrackedFiles
	| RequestCommitDetails
	| RequestCompareCommits
	| RequestCopyFilePath
	| RequestCopyToClipboard
	| RequestCreateArchive
	| RequestCreateBranch
	| RequestCreatePullRequest
	| RequestDeleteBranch
	| RequestDeleteRemote
	| RequestDeleteRemoteBranch
	| RequestDeleteTag
	| RequestDeleteUserDetails
	| RequestDropCommit
	| RequestDropStash
	| RequestEditRemote
	| RequestEditUserDetails
	| RequestEndCodeReview
	| RequestExportRepoConfig
	| RequestFetch
	| RequestFetchAvatar
	| RequestFetchIntoLocalBranch
	| RequestLoadCommits
	| RequestLoadConfig
	| RequestLoadRepoInfo
	| RequestLoadFileIconTheme
	| RequestLoadCommitStats
	| RequestLoadFileDiff
	| RequestLoadRepos
	| RequestLoadStashStats
	| RequestMerge
	| RequestNavigateEditorHistory
	| RequestOpenExtensionSettings
	| RequestUpdateExtensionSetting
	| RequestOpenExternalDirDiff
	| RequestOpenExternalUrl
	| RequestOpenFile
	| RequestOpenTerminal
	| RequestPopStash
	| RequestPruneRemote
	| RequestPullBranch
	| RequestPushBranch
	| RequestPushStash
	| RequestPushTag
	| RequestRebase
	| RequestRenameBranch
	| RequestRescanForRepos
	| RequestSearchCommits
	| RequestRemoveFilesFromHistory
	| RequestResetFileToRevision
	| RequestResetToCommit
	| RequestRevertCommit
	| RequestSetGlobalViewState
	| RequestSetRepoState
	| RequestSetWorkspaceViewState
	| RequestShowErrorDialog
	| RequestStartCodeReview
	| RequestTagDetails
	| RequestUpdateCodeReview
	| RequestViewDiff
	| RequestViewDiffWithWorkingFile
	| RequestViewFileAtRevision
	| RequestViewScm
	| RequestCompareBranches
	| RequestOpenAllChanges
	| RequestLoadBranchCleanup
	| RequestDeleteBranches
	| RequestEditCommitMessage
	| RequestLoadCommitMessage
	| RequestUndoCommit
	| RequestFixupCommit
	| RequestBisect
	| RequestLoadBisectState
	| RequestSavePatch
	| RequestCheckPatch
	| RequestApplyPatch
	| RequestLoadStashableFiles
	| RequestRestoreFileFromStash
	| RequestViewVisualFileHistory
	| RequestLoadLanguageModels
	| RequestExplainCommit;

export type ResponseMessage =
	ResponseAddRemote
	| ResponseAddTag
	| ResponseApplyStash
	| ResponseBranchFromStash
	| ResponseCheckoutBranch
	| ResponseCheckoutCommit
	| ResponseCherrypickCommit
	| ResponseCherrypickCommits
	| ResponseUndo
	| ResponseLoadRebaseCommits
	| ResponseRebaseInteractive
	| ResponseLoadOperationInProgress
	| ResponseControlOperation
	| ResponseLoadWorktrees
	| ResponseAddWorktree
	| ResponseRemoveWorktree
	| ResponsePruneWorktrees
	| ResponseOpenWorktree
	| ResponseCleanUntrackedFiles
	| ResponseCompareCommits
	| ResponseCommitDetails
	| ResponseCopyFilePath
	| ResponseCopyToClipboard
	| ResponseCreateArchive
	| ResponseCreateBranch
	| ResponseCreatePullRequest
	| ResponseDeleteBranch
	| ResponseDeleteRemote
	| ResponseDeleteRemoteBranch
	| ResponseDeleteTag
	| ResponseDeleteUserDetails
	| ResponseDropCommit
	| ResponseDropStash
	| ResponseEditRemote
	| ResponseEditUserDetails
	| ResponseExportRepoConfig
	| ResponseFetch
	| ResponseFetchAvatar
	| ResponseFetchIntoLocalBranch
	| ResponseLoadCommits
	| ResponseLoadConfig
	| ResponseLoadRepoInfo
	| ResponseLoadFileIconTheme
	| ResponseLoadCommitStats
	| ResponseLoadFileDiff
	| ResponseLoadRepos
	| ResponseLoadStashStats
	| ResponseMerge
	| ResponseOpenExtensionSettings
	| ResponseUpdateExtensionSetting
	| ResponseOpenExternalDirDiff
	| ResponseOpenExternalUrl
	| ResponseOpenFile
	| ResponseOpenTerminal
	| ResponsePopStash
	| ResponsePruneRemote
	| ResponsePullBranch
	| ResponsePushBranch
	| ResponsePushStash
	| ResponsePushTag
	| ResponseRebase
	| ResponseRefresh
	| ResponseRenameBranch
	| ResponseResetFileToRevision
	| ResponseResetToCommit
	| ResponseSearchCommits
	| ResponseRevertCommit
	| ResponseSetGlobalViewState
	| ResponseSetWorkspaceViewState
	| ResponseStartCodeReview
	| ResponseTagDetails
	| ResponseUpdateCodeReview
	| ResponseViewDiff
	| ResponseViewDiffWithWorkingFile
	| ResponseViewFileAtRevision
	| ResponseViewScm
	| ResponseCompareBranches
	| ResponseOpenAllChanges
	| ResponseLoadBranchCleanup
	| ResponseDeleteBranches
	| ResponseEditCommitMessage
	| ResponseLoadCommitMessage
	| ResponseUndoCommit
	| ResponseFixupCommit
	| ResponseBisect
	| ResponseLoadBisectState
	| ResponseSavePatch
	| ResponseCheckPatch
	| ResponseApplyPatch
	| ResponseLoadStashableFiles
	| ResponseRestoreFileFromStash
	| ResponseLoadLanguageModels
	| ResponseExplainCommit;


/** Helper Types */

type PrimitiveTypes = string | number | boolean | symbol | bigint | undefined | null;

/**
 * Make all properties in T writeable
 */
export type Writeable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Make all properties in T recursively readonly
 */
export type DeepReadonly<T> = T extends PrimitiveTypes
	? T
	: T extends (Array<infer U> | ReadonlyArray<infer U>)
	? ReadonlyArray<DeepReadonly<U>>
	: { readonly [K in keyof T]: DeepReadonly<T[K]> };

/**
 * Make all properties in T recursively writeable
 */
export type DeepWriteable<T> = T extends PrimitiveTypes
	? T
	: T extends (Array<infer U> | ReadonlyArray<infer U>)
	? Array<DeepWriteable<U>>
	: { -readonly [K in keyof T]: DeepWriteable<T[K]> };
