import * as cp from 'child_process';
import * as fs from 'fs';
import { decode, encodingExists } from 'iconv-lite';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AskpassEnvironment, AskpassManager } from './askpass/askpassManager';
import { getConfig } from './config';
import { getBaseRange, getRangeDiff, mapLines } from './lineMapping';
import { Logger } from './logger';
import { CommitOrdering, DateType, DeepWriteable, ErrorInfo, ErrorInfoExtensionPrefix, GitBlameCommit, GitBranchUpstream, GitBranchUpstreams, GitCommit, GitCommitDetails, GitCommitStash, GitCommitStats, GitConfigLocation, GitFileBlame, GitFileChange, GitFileHistory, GitFileHistoryCommit, GitFileStatus, GitLineBlame, GitLineHistory, GitLineHistoryEntry, GitLineRange, GitOperation, GitPushBranchMode, GitRebaseCommit, GitRebaseTodoItem, GitRepoConfig, GitRepoConfigBranches, GitResetMode, GitSignature, GitSignatureStatus, GitStash, GitStashStats, GitTagDetails, GitWorktree, MergeActionOn, RebaseActionOn, SquashMessageFormat, TagType, Writeable } from './types';
import { GitExecutable, GitVersionRequirement, UNABLE_TO_FIND_GIT_MSG, UNCOMMITTED, abbrevCommit, constructIncompatibleGitVersionMessage, doesVersionMeetRequirement, getPathFromStr, getPathFromUri, openGitTerminal, pathWithTrailingSlash, realpath, resolveSpawnOutput, showErrorMessage } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';
import { t } from './l10n';

const DRIVE_LETTER_PATH_REGEX = /^[a-z]:\//;
const EOL_REGEX = /\r\n|\r|\n/g;
const LF_REGEX = /\r?\n/g;

/**
 * The maximum number of lines of the diff of each commit in the history of a range of lines.
 */
const MAX_LINE_HISTORY_DIFF_LINES = 500;
const COMMIT_HASH_REGEXP = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const EXTENDED_REGEXP_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;
const INVALID_BRANCH_REGEXP = /^\(.* .*\)$/;
const REMOTE_HEAD_BRANCH_REGEXP = /^remotes\/.*\/HEAD$/;
const GIT_LOG_SEPARATOR = 'XX7Nal-YARtTpjCikii9nJxER19D6diSyk-AWkPb';
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const enum GitConfigKey {
	DiffGuiTool = 'diff.guitool',
	DiffTool = 'diff.tool',
	RemotePushDefault = 'remote.pushdefault',
	UserEmail = 'user.email',
	UserName = 'user.name'
}

const GPG_STATUS_CODE_PARSING_DETAILS: Readonly<{ [statusCode: string]: GpgStatusCodeParsingDetails }> = {
	'GOODSIG': { status: GitSignatureStatus.GoodAndValid, uid: true },
	'BADSIG': { status: GitSignatureStatus.Bad, uid: true },
	'ERRSIG': { status: GitSignatureStatus.CannotBeChecked, uid: false },
	'EXPSIG': { status: GitSignatureStatus.GoodButExpired, uid: true },
	'EXPKEYSIG': { status: GitSignatureStatus.GoodButMadeByExpiredKey, uid: true },
	'REVKEYSIG': { status: GitSignatureStatus.GoodButMadeByRevokedKey, uid: true }
};

/**
 * Interfaces Git Map with the Git executable to provide all Git integrations.
 */
export class DataSource extends Disposable {
	private readonly logger: Logger;
	private readonly askpassEnv: AskpassEnvironment;
	private gitExecutable!: GitExecutable | null;
	private gitExecutableSupportsGpgInfo!: boolean;
	private gitFormatCommitDetails!: string;
	private gitFormatLog!: string;
	private gitFormatStash!: string;
	private fileHistoryPathsCache: { key: string, paths: string[] } | null = null;
	private readonly rebaseDirectories: { [repo: string]: string[] } = {}; // The temporary directories of the interactive rebases run in each repository

	/**
	 * Creates the Git Map Data Source.
	 * @param gitExecutable The Git executable available to Git Map at startup.
	 * @param onDidChangeGitExecutable The Event emitting the Git executable for Git Map to use.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(gitExecutable: GitExecutable | null, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, onDidChangeGitExecutable: Event<GitExecutable>, logger: Logger) {
		super();
		this.logger = logger;
		this.setGitExecutable(gitExecutable);

		const askpassManager = new AskpassManager();
		this.askpassEnv = askpassManager.getEnv();

		this.registerDisposables(
			onDidChangeConfiguration((event) => {
				if (
					event.affectsConfiguration('git-map.date.type') || event.affectsConfiguration('git-map.dateType') ||
					event.affectsConfiguration('git-map.repository.commits.showSignatureStatus') || event.affectsConfiguration('git-map.showSignatureStatus') ||
					event.affectsConfiguration('git-map.repository.useMailmap') || event.affectsConfiguration('git-map.useMailmap')
				) {
					this.generateGitCommandFormats();
				}
			}),
			onDidChangeGitExecutable((gitExecutable) => {
				this.setGitExecutable(gitExecutable);
			}),
			askpassManager
		);
	}

	/**
	 * Check if the Git executable is unknown.
	 * @returns TRUE => Git executable is unknown, FALSE => Git executable is known.
	 */
	public isGitExecutableUnknown() {
		return this.gitExecutable === null;
	}

	/**
	 * Set the Git executable used by the DataSource.
	 * @param gitExecutable The Git executable.
	 */
	private setGitExecutable(gitExecutable: GitExecutable | null) {
		this.gitExecutable = gitExecutable;
		this.gitExecutableSupportsGpgInfo = gitExecutable !== null && doesVersionMeetRequirement(gitExecutable.version, GitVersionRequirement.GpgInfo);
		this.generateGitCommandFormats();
	}

	/**
	 * Generate the format strings used by various Git commands.
	 */
	private generateGitCommandFormats() {
		const config = getConfig();
		const dateType = config.dateType === DateType.Author ? '%at' : '%ct';
		const useMailmap = config.useMailmap;

		this.gitFormatCommitDetails = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', '%at', useMailmap ? '%cN' : '%cn', useMailmap ? '%cE' : '%ce', '%ct', // Author / Commit Information
			...(config.showSignatureStatus && this.gitExecutableSupportsGpgInfo ? ['%G?', '%GS', '%GK'] : ['', '', '']), // GPG Key Information
			'%B' // Body
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatLog = [
			'%H', '%P', // Hash & Parent Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);

		this.gitFormatStash = [
			'%H', '%P', '%gD', // Hash, Parent & Selector Information
			useMailmap ? '%aN' : '%an', useMailmap ? '%aE' : '%ae', dateType, // Author / Commit Information
			'%s' // Subject
		].join(GIT_LOG_SEPARATOR);
	}


	/* Get Data Methods - Core */

	/**
	 * Get the high-level information of a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showStashes Are stashes shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The repositories information.
	 */
	public getRepoInfo(repo: string, showRemoteBranches: boolean, showStashes: boolean, hideRemotes: ReadonlyArray<string>): Promise<GitRepoInfo> {
		return Promise.all([
			this.getBranches(repo, showRemoteBranches, hideRemotes),
			this.getRemotes(repo),
			showStashes ? this.getStashes(repo) : Promise.resolve([]),
			this.getUpstreams(repo)
		]).then((results) => {
			return { branches: results[0].branches, head: results[0].head, remotes: results[1], stashes: results[2], upstreams: results[3], error: null };
		}).catch((errorMessage) => {
			return { branches: [], head: null, remotes: [], stashes: [], upstreams: {}, error: errorMessage };
		});
	}

	/**
	 * Get the number of files changed by commits (compared to their first parent), and the lines they add & delete.
	 * @param repo The path of the repository.
	 * @param hashes The hashes of the commits (the uncommitted changes are requested with the hash "*").
	 * @returns The stats of each commit (NULL if a commit doesn't change any files, e.g. a merge commit).
	 */
	public getCommitStats(repo: string, hashes: ReadonlyArray<string>): Promise<{ stats: { [hash: string]: GitCommitStats | null }, error: ErrorInfo }> {
		const parseShortstat = (line: string): GitCommitStats | null => {
			const files = line.match(/(\d+) files? changed/), additions = line.match(/(\d+) insertions?\(\+\)/), deletions = line.match(/(\d+) deletions?\(-\)/);
			return files !== null ? { files: parseInt(files[1]), additions: additions !== null ? parseInt(additions[1]) : 0, deletions: deletions !== null ? parseInt(deletions[1]) : 0 } : null;
		};
		const commits = hashes.filter((hash) => hash !== UNCOMMITTED), batches: string[][] = [];
		for (let i = 0; i < commits.length; i += 100) batches.push(commits.slice(i, i + 100));
		return Promise.all(batches.map((batch) => this.spawnGit(['-c', 'log.showSignature=false', 'log', '--no-walk=unsorted', '-m', '--first-parent', '--format=' + GIT_LOG_SEPARATOR + '%H', '--shortstat', ...batch, '--'], repo, (stdout) => {
			const stats: { [hash: string]: GitCommitStats | null } = {};
			let hash: string | null = null;
			stdout.split(LF_REGEX).forEach((line) => {
				if (line.startsWith(GIT_LOG_SEPARATOR)) {
					hash = line.substring(GIT_LOG_SEPARATOR.length);
					stats[hash] = null;
				} else if (hash !== null && line.trim() !== '') {
					stats[hash] = parseShortstat(line);
				}
			});
			return stats;
		})).concat(hashes.includes(UNCOMMITTED)
			? [this.spawnGit(['diff', '--shortstat', 'HEAD', '--'], repo, (stdout) => ({ [UNCOMMITTED]: parseShortstat(stdout) }))]
			: []
		)).then((results) => ({ stats: Object.assign({}, ...results), error: null }), (errorMessage: string) => ({ stats: {}, error: errorMessage }));
	}

	/**
	 * Get the number of files changed by each stash (compared to the commit it was created on), the lines they add & delete, and the number of untracked files it includes.
	 * @param repo The path of the repository.
	 * @param stashes The stashes.
	 * @returns The stats of each stash (stashes whose stats couldn't be read are omitted).
	 */
	public getStashStats(repo: string, stashes: ReadonlyArray<{ hash: string, baseHash: string, untrackedFilesHash: string | null }>): Promise<{ stats: { [hash: string]: GitStashStats }, error: ErrorInfo }> {
		return Promise.all(stashes.map((stash) => Promise.all([
			this.spawnGit(['diff', '--numstat', '--no-renames', '--no-ext-diff', stash.baseHash, stash.hash, '--'], repo, (stdout) => {
				let files = 0, additions = 0, deletions = 0;
				stdout.split(LF_REGEX).forEach((line) => {
					const fields = line.split('\t');
					if (fields.length < 3) return;
					files++;
					additions += parseInt(fields[0]) || 0;
					deletions += parseInt(fields[1]) || 0;
				});
				return { files: files, additions: additions, deletions: deletions };
			}),
			stash.untrackedFilesHash !== null
				? this.spawnGit(['ls-tree', '-r', '--name-only', stash.untrackedFilesHash, '--'], repo, (stdout) => stdout.split(LF_REGEX).filter((line) => line !== '').length)
				: Promise.resolve(0)
		]).then((results) => ({ hash: stash.hash, stats: <GitStashStats>{ files: results[0].files + results[1], additions: results[0].additions, deletions: results[0].deletions, untrackedFiles: results[1] } }), () => null))).then((results) => {
			const stats: { [hash: string]: GitStashStats } = {};
			results.forEach((result) => {
				if (result !== null) stats[result.hash] = result.stats;
			});
			return { stats: stats, error: null };
		});
	}

	/**
	 * Search the commits on all branches (local & remote), tags and HEAD of a repository for those that change files matching a path, and / or whose changes add or remove lines matching some text.
	 * @param repo The path of the repository.
	 * @param files Text that the path of a file changed by a commit must contain (all must be matched by the commit).
	 * @param changes Text that a line added or removed by a commit must contain (all must be matched by the commit).
	 * @param isRegex Is the text of the changes a regular expression.
	 * @param isCaseSensitive Is the search case sensitive.
	 * @param since Only commits committed on or after this unix timestamp are searched (0 => all commits).
	 * @returns The hashes of the commits that match.
	 */
	public searchCommits(repo: string, files: ReadonlyArray<string>, changes: ReadonlyArray<string>, isRegex: boolean, isCaseSensitive: boolean, since: number): Promise<{ hashes: string[], error: ErrorInfo }> {
		const pathspecs = files.map((file) => (isCaseSensitive ? '' : ':(icase)') + '*' + file.replace(/[*?[\\]/g, '\\$&') + '*');
		const search = (change: string | null) => {
			const args = ['-c', 'log.showSignature=false', 'log', '--format=%H', '--branches', '--remotes', '--tags', 'HEAD'];
			if (since > 0) args.push('--since=' + since);
			if (change !== null) {
				args.push('-G' + (isRegex ? change : change.replace(EXTENDED_REGEXP_SPECIAL_CHARACTERS, '\\$&')));
				if (!isCaseSensitive) args.push('--regexp-ignore-case');
			}
			args.push('--', ...pathspecs);
			return this.spawnGit(args, repo, (stdout) => stdout.split(LF_REGEX).filter((hash) => hash !== ''));
		};
		// Git only supports one -G option, so each change is searched for separately (and commits that match all of them are returned)
		return Promise.all(changes.length > 0 ? changes.map((change) => search(change)) : [search(null)]).then((results) => {
			const hashes = results.reduce((matched, hashes) => {
				const set = new Set(hashes);
				return matched.filter((hash) => set.has(hash));
			});
			return { hashes: hashes, error: null };
		}).catch((errorMessage: string) => ({ hashes: <string[]>[], error: errorMessage }));
	}

	/**
	 * Get the commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param maxCommits The maximum number of commits to return.
	 * @param showTags Are tags are shown.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param includeCommitsMentionedByReflogs Should commits mentioned by reflogs being included.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param commitOrdering The order for commits to be returned.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param authors The names of the authors whose commits are returned, or NULL (all authors).
	 * @param filePath The path of a file whose history is returned (only the commits that change it, following it through renames), or NULL (all commits).
	 * @returns The commits in the repository.
	 */
	public getCommits(repo: string, branches: ReadonlyArray<string> | null, maxCommits: number, showTags: boolean, showRemoteBranches: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, commitOrdering: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, authors: ReadonlyArray<string> | null = null, filePath: string | null = null, lineRange: GitLineRange | null = null): Promise<GitCommitData> {
		const config = getConfig(), includeTags = showTags && config.showCommitsOnlyReferencedByTags;
		if (filePath !== null) stashes = []; // Stashes aren't part of the history of a file
		const revisionArgs = this.getRevisionArgs(branches, includeTags, showRemoteBranches, includeCommitsMentionedByReflogs, remotes, hideRemotes, stashes);
		let fileHistory: GitFileHistory | null = null;
		return (filePath !== null ? this.getFileHistoryPaths(repo, filePath, revisionArgs, onlyFollowFirstParent) : Promise.resolve(null)).then((paths) => Promise.all([
			this.getLog(repo, branches, maxCommits + 1, includeTags, showRemoteBranches, includeCommitsMentionedByReflogs, onlyFollowFirstParent, commitOrdering, remotes, hideRemotes, stashes, authors, paths),
			this.getRefs(repo, showRemoteBranches, config.showRemoteHeads, hideRemotes).then((refData: GitRefData) => refData, (errorMessage: string) => errorMessage),
			filePath !== null && paths !== null ? (lineRange !== null
				? this.getLineHistoryCommits(repo, branches !== null && branches.length === 1 ? branches[0] : 'HEAD', filePath, lineRange, maxCommits + 1, onlyFollowFirstParent, commitOrdering)
				: this.getFileHistoryCommits(repo, revisionArgs, paths, maxCommits + 1, onlyFollowFirstParent, commitOrdering)
			).then((commits) => {
				fileHistory = { filePath: filePath, paths: paths, commits: commits, lineRange: lineRange };
			}) : Promise.resolve()
		])).then(async (results) => {
			let commits = <GitCommitRecord[]>results[0], refData = <GitRefData | string>results[1], i;
			let moreCommitsAvailable = commits.length === maxCommits + 1;
			if (moreCommitsAvailable) commits.pop();
			if (lineRange !== null && fileHistory !== null) {
				// Only the commits that change the lines are shown (keeping the graph connected)
				commits = filterCommitRecords(commits, new Set(Object.keys((<GitFileHistory>fileHistory).commits)));
			}

			// It doesn't matter if getRefs() was rejected if no commits exist
			if (typeof refData === 'string') {
				// getRefs() returned an error message (string)
				if (commits.length > 0) {
					// Commits exist, throw the error
					throw refData;
				} else {
					// No commits exist, so getRefs() will always return an error. Set refData to the default value
					refData = { head: null, heads: [], tags: [], remotes: [] };
				}
			}

			if (refData.head !== null && config.showUncommittedChanges && filePath === null) {
				for (i = 0; i < commits.length; i++) {
					if (refData.head === commits[i].hash) {
						const numUncommittedChanges = await this.getUncommittedChanges(repo);
						if (numUncommittedChanges > 0) {
							commits.unshift({ hash: UNCOMMITTED, parents: [refData.head], author: '*', email: '', date: Math.round((new Date()).getTime() / 1000), message: t('Uncommitted Changes ({0})', numUncommittedChanges) });
						}
						break;
					}
				}
			}

			let commitNodes: DeepWriteable<GitCommit>[] = [];
			let commitLookup: { [hash: string]: number } = {};

			for (i = 0; i < commits.length; i++) {
				commitLookup[commits[i].hash] = i;
				commitNodes.push({ ...commits[i], heads: [], tags: [], remotes: [], stash: null });
			}

			/* Insert Stashes */
			let toAdd: { index: number, data: GitStash }[] = [];
			for (i = 0; i < stashes.length; i++) {
				if (typeof commitLookup[stashes[i].hash] === 'number') {
					commitNodes[commitLookup[stashes[i].hash]].stash = {
						selector: stashes[i].selector,
						baseHash: stashes[i].baseHash,
						untrackedFilesHash: stashes[i].untrackedFilesHash
					};
				} else if (typeof commitLookup[stashes[i].baseHash] === 'number') {
					toAdd.push({ index: commitLookup[stashes[i].baseHash], data: stashes[i] });
				}
			}
			toAdd.sort((a, b) => a.index !== b.index ? a.index - b.index : b.data.date - a.data.date);
			for (i = toAdd.length - 1; i >= 0; i--) {
				let stash = toAdd[i].data;
				commitNodes.splice(toAdd[i].index, 0, {
					hash: stash.hash,
					parents: [stash.baseHash],
					author: stash.author,
					email: stash.email,
					date: stash.date,
					message: stash.message,
					heads: [], tags: [], remotes: [],
					stash: {
						selector: stash.selector,
						baseHash: stash.baseHash,
						untrackedFilesHash: stash.untrackedFilesHash
					}
				});
			}
			for (i = 0; i < commitNodes.length; i++) {
				// Correct commit lookup after stashes have been spliced in
				commitLookup[commitNodes[i].hash] = i;
			}

			/* Annotate Heads */
			for (i = 0; i < refData.heads.length; i++) {
				if (typeof commitLookup[refData.heads[i].hash] === 'number') commitNodes[commitLookup[refData.heads[i].hash]].heads.push(refData.heads[i].name);
			}

			/* Annotate Tags */
			if (showTags) {
				for (i = 0; i < refData.tags.length; i++) {
					if (typeof commitLookup[refData.tags[i].hash] === 'number') commitNodes[commitLookup[refData.tags[i].hash]].tags.push({ name: refData.tags[i].name, annotated: refData.tags[i].annotated });
				}
			}

			/* Annotate Remotes */
			for (i = 0; i < refData.remotes.length; i++) {
				if (typeof commitLookup[refData.remotes[i].hash] === 'number') {
					let name = refData.remotes[i].name;
					let remote = remotes.find(remote => name.startsWith(remote + '/'));
					commitNodes[commitLookup[refData.remotes[i].hash]].remotes.push({ name: name, remote: remote ? remote : null });
				}
			}

			return {
				commits: commitNodes,
				head: refData.head,
				tags: unique(refData.tags.map((tag) => tag.name)),
				moreCommitsAvailable: moreCommitsAvailable,
				fileHistory: fileHistory,
				error: null
			};
		}).catch((errorMessage) => {
			return { commits: [], head: null, tags: [], moreCommitsAvailable: false, fileHistory: null, error: errorMessage };
		});
	}

	/**
	 * Get various Git config variables for a repository that are consumed by the Git Map View.
	 * @param repo The path of the repository.
	 * @param remotes An array of known remotes.
	 * @returns The config data.
	 */
	public getConfig(repo: string, remotes: ReadonlyArray<string>): Promise<GitRepoConfigData> {
		return Promise.all([
			this.getConfigList(repo),
			this.getConfigList(repo, GitConfigLocation.Local),
			this.getConfigList(repo, GitConfigLocation.Global)
		]).then((results) => {
			const consolidatedConfigs = results[0], localConfigs = results[1], globalConfigs = results[2];

			const branches: GitRepoConfigBranches = {};
			Object.keys(localConfigs).forEach((key) => {
				if (key.startsWith('branch.')) {
					if (key.endsWith('.remote')) {
						const branchName = key.substring(7, key.length - 7);
						branches[branchName] = {
							pushRemote: typeof branches[branchName] !== 'undefined' ? branches[branchName].pushRemote : null,
							remote: localConfigs[key]
						};
					} else if (key.endsWith('.pushremote')) {
						const branchName = key.substring(7, key.length - 11);
						branches[branchName] = {
							pushRemote: localConfigs[key],
							remote: typeof branches[branchName] !== 'undefined' ? branches[branchName].remote : null
						};
					}
				}
			});

			return {
				config: {
					branches: branches,
					diffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffTool),
					guiDiffTool: getConfigValue(consolidatedConfigs, GitConfigKey.DiffGuiTool),
					pushDefault: getConfigValue(consolidatedConfigs, GitConfigKey.RemotePushDefault),
					remotes: remotes.map((remote) => ({
						name: remote,
						url: getConfigValue(localConfigs, 'remote.' + remote + '.url'),
						pushUrl: getConfigValue(localConfigs, 'remote.' + remote + '.pushurl')
					})),
					user: {
						name: {
							local: getConfigValue(localConfigs, GitConfigKey.UserName),
							global: getConfigValue(globalConfigs, GitConfigKey.UserName)
						},
						email: {
							local: getConfigValue(localConfigs, GitConfigKey.UserEmail),
							global: getConfigValue(globalConfigs, GitConfigKey.UserEmail)
						}
					}
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { config: null, error: errorMessage };
		});
	}


	/* Get Data Methods - Commit Details View */

	/**
	 * Get the commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @param hasParents Does the commit have parents
	 * @returns The commit details.
	 */
	public getCommitDetails(repo: string, commitHash: string, hasParents: boolean): Promise<GitCommitDetailsData> {
		const fromCommit = commitHash + (hasParents ? '^' : '');
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, fromCommit, commitHash),
			this.getDiffNumStat(repo, fromCommit, commitHash)
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], results[2], null);
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the stash details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the stash commit open in the Commit Details View.
	 * @param stash The stash.
	 * @returns The stash details.
	 */
	public getStashDetails(repo: string, commitHash: string, stash: GitCommitStash): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getCommitDetailsBase(repo, commitHash),
			this.getDiffNameStatus(repo, stash.baseHash, commitHash),
			this.getDiffNumStat(repo, stash.baseHash, commitHash),
			stash.untrackedFilesHash !== null ? this.getDiffNameStatus(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([]),
			stash.untrackedFilesHash !== null ? this.getDiffNumStat(repo, stash.untrackedFilesHash, stash.untrackedFilesHash) : Promise.resolve([])
		]).then((results) => {
			results[0].fileChanges = generateFileChanges(results[1], results[2], null);
			if (stash.untrackedFilesHash !== null) {
				generateFileChanges(results[3], results[4], null).forEach((fileChange) => {
					if (fileChange.type === GitFileStatus.Added) {
						fileChange.type = GitFileStatus.Untracked;
						results[0].fileChanges.push(fileChange);
					}
				});
			}
			return { commitDetails: results[0], error: null };
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the uncommitted details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @returns The uncommitted details.
	 */
	public getUncommittedDetails(repo: string): Promise<GitCommitDetailsData> {
		return Promise.all([
			this.getDiffNameStatus(repo, 'HEAD', ''),
			this.getDiffNumStat(repo, 'HEAD', ''),
			this.getStatus(repo)
		]).then((results) => {
			return {
				commitDetails: {
					hash: UNCOMMITTED, parents: [],
					author: '', authorEmail: '', authorDate: 0,
					committer: '', committerEmail: '', committerDate: 0, signature: null,
					body: '', fileChanges: generateFileChanges(results[0], results[1], results[2])
				},
				error: null
			};
		}).catch((errorMessage) => {
			return { commitDetails: null, error: errorMessage };
		});
	}

	/**
	 * Get the comparison details for the Commit Comparison View.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the comparison is from.
	 * @param toHash The commit hash the comparison is to.
	 * @returns The comparison details.
	 */
	public getCommitComparison(repo: string, fromHash: string, toHash: string): Promise<GitCommitComparisonData> {
		return Promise.all([
			this.getDiffNameStatus(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			this.getDiffNumStat(repo, fromHash, toHash === UNCOMMITTED ? '' : toHash),
			toHash === UNCOMMITTED ? this.getStatus(repo) : Promise.resolve(null)
		]).then((results) => {
			return {
				fileChanges: generateFileChanges(results[0], results[1], results[2]),
				error: null
			};
		}).catch((errorMessage) => {
			return { fileChanges: [], error: errorMessage };
		});
	}

	/**
	 * Get the contents of a file at a specific revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash specifying the revision of the file.
	 * @param filePath The path of the file relative to the repositories root.
	 * @returns The file contents.
	 */
	public getCommitFile(repo: string, commitHash: string, filePath: string) {
		return this._spawnGit(['show', commitHash + ':' + filePath], repo, stdout => {
			const encoding = getConfig(repo).fileEncoding;
			return decode(stdout, encodingExists(encoding) ? encoding : 'utf8');
		});
	}


	/* Get Data Methods - General */

	/**
	 * Get the subject of a commit.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash.
	 * @returns The subject string, or NULL if an error occurred.
	 */
	public getCommitSubject(repo: string, commitHash: string): Promise<string | null> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--format=%s', '-n', '1', commitHash, '--'], repo, (stdout) => {
			return stdout.trim().replace(/\s+/g, ' ');
		}).then((subject) => subject, () => null);
	}

	/**
	 * Get the URL of a repositories remote.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote.
	 * @returns The URL, or NULL if an error occurred.
	 */
	public getRemoteUrl(repo: string, remote: string): Promise<string | null> {
		return this.spawnGit(['config', '--get', 'remote.' + remote + '.url'], repo, (stdout) => {
			return stdout.split(EOL_REGEX)[0];
		}).then((url) => url, () => null);
	}

	/**
	 * Get the remote used to link to a repository on the web: "origin", or the first remote if there isn't an "origin" remote.
	 * @param repo The path of the repository.
	 * @returns The name & URL of the remote, or NULL if the repository doesn't have a remote with a URL.
	 */
	public getDefaultRemote(repo: string): Promise<{ name: string, url: string } | null> {
		return this.spawnGit(['remote'], repo, (stdout) => stdout.split(LF_REGEX).filter((name) => name !== '')).then(async (names) => {
			const name = names.includes('origin') ? 'origin' : names.length > 0 ? names[0] : null;
			const url = name !== null ? await this.getRemoteUrl(repo, name) : null;
			return name !== null && url !== null && url !== '' ? { name: name, url: url } : null;
		}, () => null);
	}

	/**
	 * Is a commit on a remote: is it contained by one of the remote's remote-tracking branches (as last fetched)?
	 * @param repo The path of the repository.
	 * @param hash The hash of the commit.
	 * @param remote The name of the remote.
	 * @returns TRUE => The commit is on the remote, FALSE => It isn't (or it couldn't be determined).
	 */
	public isCommitOnRemote(repo: string, hash: string, remote: string): Promise<boolean> {
		return this.spawnGit(['branch', '-r', '--contains', hash, '--list', remote + '/*'], repo, (stdout) => stdout.trim() !== '').catch(() => false);
	}

	/**
	 * Check to see if a file has been renamed between a commit and the working tree, and return the new file path.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash where `oldFilePath` is known to have existed.
	 * @param oldFilePath The file path that may have been renamed.
	 * @returns The new renamed file path, or NULL if either: the file wasn't renamed or the Git command failed to execute.
	 */
	public getNewPathOfRenamedFile(repo: string, commitHash: string, oldFilePath: string) {
		return this.getDiffNameStatus(repo, commitHash, '', 'R').then((renamed) => {
			const renamedRecordForFile = renamed.find((record) => record.oldFilePath === oldFilePath);
			return renamedRecordForFile ? renamedRecordForFile.newFilePath : null;
		}).catch(() => null);
	}

	/**
	 * Get the details of a tag.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @returns The tag details.
	 */
	public getTagDetails(repo: string, tagName: string): Promise<GitTagDetailsData> {
		if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.TagDetails)) {
			return Promise.resolve({ details: null, error: constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.TagDetails, t('retrieving Tag Details')) });
		}

		const ref = 'refs/tags/' + tagName;
		return this.spawnGit(['for-each-ref', ref, '--format=' + ['%(objectname)', '%(taggername)', '%(taggeremail)', '%(taggerdate:unix)', '%(contents:signature)', '%(contents)'].join(GIT_LOG_SEPARATOR)], repo, (stdout) => {
			const data = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: data[0],
				taggerName: data[1],
				taggerEmail: data[2].substring(data[2].startsWith('<') ? 1 : 0, data[2].length - (data[2].endsWith('>') ? 1 : 0)),
				taggerDate: parseInt(data[3]),
				message: removeTrailingBlankLines(data.slice(5).join(GIT_LOG_SEPARATOR).replace(data[4], '').split(EOL_REGEX)).join('\n'),
				signed: data[4] !== ''
			};
		}).then(async (tag) => ({
			details: {
				hash: tag.hash,
				taggerName: tag.taggerName,
				taggerEmail: tag.taggerEmail,
				taggerDate: tag.taggerDate,
				message: tag.message,
				signature: tag.signed
					? await this.getTagSignature(repo, ref)
					: null
			},
			error: null
		})).catch((errorMessage) => ({
			details: null,
			error: errorMessage
		}));
	}

	/**
	 * Get the submodules of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of the paths of the submodules.
	 */
	public getSubmodules(repo: string) {
		return new Promise<string[]>(resolve => {
			fs.readFile(path.join(repo, '.gitmodules'), { encoding: 'utf8' }, async (err, data) => {
				let submodules: string[] = [];
				if (!err) {
					let lines = data.split(EOL_REGEX), inSubmoduleSection = false, match;
					const section = /^\s*\[.*\]\s*$/, submodule = /^\s*\[submodule "([^"]+)"\]\s*$/, pathProp = /^\s*path\s+=\s+(.*)$/;

					for (let i = 0; i < lines.length; i++) {
						if (lines[i].match(section) !== null) {
							inSubmoduleSection = lines[i].match(submodule) !== null;
							continue;
						}

						if (inSubmoduleSection && (match = lines[i].match(pathProp)) !== null) {
							let root = await this.repoRoot(getPathFromUri(vscode.Uri.file(path.join(repo, getPathFromStr(match[1])))));
							if (root !== null && !submodules.includes(root)) {
								submodules.push(root);
							}
						}
					}
				}
				resolve(submodules);
			});
		});
	}


	/* Repository Info Methods */

	/**
	 * Check if there are any staged changes in the repository.
	 * @param repo The path of the repository.
	 * @returns TRUE => Staged Changes, FALSE => No Staged Changes.
	 */
	private areStagedChanges(repo: string) {
		return this.spawnGit(['diff-index', 'HEAD'], repo, (stdout) => stdout !== '').then(changes => changes, () => false);
	}

	/**
	 * Are all of the files ignored by Git (tracked files are never ignored).
	 * @param repo The path of the repository.
	 * @param paths The paths of the files (relative to the repository).
	 * @returns TRUE => All of the files are ignored, FALSE => At least one of them isn't (or it couldn't be determined).
	 */
	public areAllIgnored(repo: string, paths: ReadonlyArray<string>): Promise<boolean> {
		if (paths.length === 0) return Promise.resolve(false);
		// The paths are written to the standard input of Git, and the ones that are ignored are output (it exits with 1 if none are)
		return this._spawnGit(['check-ignore', '--stdin', '-z'], repo, (stdout) => stdout.toString().split('\0').filter((path) => path !== '').length === paths.length, true, paths.join('\0') + '\0').catch(() => false);
	}

	/**
	 * Get the root of the repository containing the specified path.
	 * @param pathOfPotentialRepo The path that is potentially a repository (or is contained within a repository).
	 * @returns STRING => The root of the repository, NULL => `pathOfPotentialRepo` is not in a repository.
	 */
	public repoRoot(pathOfPotentialRepo: string) {
		return this.spawnGit(['rev-parse', '--show-toplevel'], pathOfPotentialRepo, (stdout) => getPathFromUri(vscode.Uri.file(path.normalize(stdout.trim())))).then(async (pathReturnedByGit) => {
			if (process.platform === 'win32') {
				// On Windows Mapped Network Drives with Git >= 2.25.0, `git rev-parse --show-toplevel` returns the UNC Path for the Mapped Network Drive, instead of the Drive Letter.
				// Attempt to replace the UNC Path with the Drive Letter.
				let driveLetterPathMatch: RegExpMatchArray | null;
				if ((driveLetterPathMatch = pathOfPotentialRepo.match(DRIVE_LETTER_PATH_REGEX)) && !pathReturnedByGit.match(DRIVE_LETTER_PATH_REGEX)) {
					const realPathForDriveLetter = pathWithTrailingSlash(await realpath(driveLetterPathMatch[0], true));
					if (realPathForDriveLetter !== driveLetterPathMatch[0] && pathReturnedByGit.startsWith(realPathForDriveLetter)) {
						pathReturnedByGit = driveLetterPathMatch[0] + pathReturnedByGit.substring(realPathForDriveLetter.length);
					}
				}
			}
			let path = pathOfPotentialRepo;
			let first = path.indexOf('/');
			while (true) {
				if (pathReturnedByGit === path || pathReturnedByGit === await realpath(path)) return path;
				let next = path.lastIndexOf('/');
				if (first !== next && next > -1) {
					path = path.substring(0, next);
				} else {
					return pathReturnedByGit;
				}
			}
		}).catch(() => null); // null => path is not in a repo
	}


	/* Git Action Methods - Remotes */

	/**
	 * Add a new remote to a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @param url The URL of the remote.
	 * @param pushUrl The Push URL of the remote.
	 * @param fetch Fetch the remote after it is added.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async addRemote(repo: string, name: string, url: string, pushUrl: string | null, fetch: boolean) {
		let status = await this.runGitCommand(['remote', 'add', name, url], repo);
		if (status !== null) return status;

		if (pushUrl !== null) {
			status = await this.runGitCommand(['remote', 'set-url', name, '--push', pushUrl], repo);
			if (status !== null) return status;
		}

		return fetch ? this.fetch(repo, name, false, false) : null;
	}

	/**
	 * Delete an existing remote from a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'remove', name], repo);
	}

	/**
	 * Edit an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param nameOld The old name of the remote.
	 * @param nameNew The new name of the remote.
	 * @param urlOld The old URL of the remote.
	 * @param urlNew The new URL of the remote.
	 * @param pushUrlOld The old Push URL of the remote.
	 * @param pushUrlNew The new Push URL of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async editRemote(repo: string, nameOld: string, nameNew: string, urlOld: string | null, urlNew: string | null, pushUrlOld: string | null, pushUrlNew: string | null) {
		if (nameOld !== nameNew) {
			let status = await this.runGitCommand(['remote', 'rename', nameOld, nameNew], repo);
			if (status !== null) return status;
		}

		if (urlOld !== urlNew) {
			let args = ['remote', 'set-url', nameNew];
			if (urlNew === null) args.push('--delete', urlOld!);
			else if (urlOld === null) args.push('--add', urlNew);
			else args.push(urlNew, urlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		if (pushUrlOld !== pushUrlNew) {
			let args = ['remote', 'set-url', '--push', nameNew];
			if (pushUrlNew === null) args.push('--delete', pushUrlOld!);
			else if (pushUrlOld === null) args.push('--add', pushUrlNew);
			else args.push(pushUrlNew, pushUrlOld);

			let status = await this.runGitCommand(args, repo);
			if (status !== null) return status;
		}

		return null;
	}

	/**
	 * Prune an existing remote of a repository.
	 * @param repo The path of the repository.
	 * @param name The name of the remote.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneRemote(repo: string, name: string) {
		return this.runGitCommand(['remote', 'prune', name], repo);
	}


	/* Git Action Methods - Tags */

	/**
	 * Add a new tag to a commit.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param commitHash The hash of the commit the tag should be added to.
	 * @param type Is the tag annotated or lightweight.
	 * @param message The message of the tag (if it is an annotated tag).
	 * @param force Force add the tag, replacing an existing tag with the same name (if it exists).
	 * @returns The ErrorInfo from the executed command.
	 */
	public addTag(repo: string, tagName: string, commitHash: string, type: TagType, message: string, force: boolean) {
		const args = ['tag'];
		if (force) {
			args.push('-f');
		}
		if (type === TagType.Lightweight) {
			args.push(tagName);
		} else {
			args.push(getConfig().signTags ? '-s' : '-a', tagName, '-m', message);
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Delete an existing tag from a repository.
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag.
	 * @param deleteOnRemote The name of the remote to delete the tag on, or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteTag(repo: string, tagName: string, deleteOnRemote: string | null) {
		if (deleteOnRemote !== null) {
			let status = await this.runGitCommand(['push', deleteOnRemote, '--delete', 'refs/tags/' + tagName], repo);
			if (status !== null) return status;
		}
		return this.runGitCommand(['tag', '-d', tagName], repo);
	}


	/* Git Action Methods - Remote Sync */

	/**
	 * Fetch from the repositories remote(s).
	 * @param repo The path of the repository.
	 * @param remote The remote to fetch, or NULL (fetch all remotes).
	 * @param prune Is pruning enabled.
	 * @param pruneTags Should tags be pruned.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetch(repo: string, remote: string | null, prune: boolean, pruneTags: boolean) {
		let args = ['fetch', remote === null ? '--all' : remote];

		if (prune) {
			args.push('--prune');
		}
		if (pruneTags) {
			if (!prune) {
				return Promise.resolve(remote !== null ? t('In order to Prune Tags, pruning must also be enabled when fetching from a remote.') : t('In order to Prune Tags, pruning must also be enabled when fetching from remote(s).'));
			} else if (this.gitExecutable !== null && !doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.FetchAndPruneTags)) {
				return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.FetchAndPruneTags, t('pruning tags when fetching')));
			}
			args.push('--prune-tags');
		}

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to a remote.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remote The remote to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushBranch(repo: string, branchName: string, remote: string, setUpstream: boolean, mode: GitPushBranchMode) {
		let args = ['push'];
		args.push(remote, 'refs/heads/' + branchName + ':refs/heads/' + branchName);
		if (setUpstream) args.push('--set-upstream');
		if (mode !== GitPushBranchMode.Normal) args.push('--' + mode);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push a branch to multiple remotes.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to push.
	 * @param remotes The remotes to push the branch to.
	 * @param setUpstream Set the branches upstream.
	 * @param mode The mode of the push.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushBranchToMultipleRemotes(repo: string, branchName: string, remotes: string[], setUpstream: boolean, mode: GitPushBranchMode): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return [t('No remote(s) were specified to push the branch {0} to.', branchName)];
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.pushBranch(repo, branchName, remotes[i], setUpstream, mode);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}

	/**
	 * Push a tag to remote(s).
	 * @param repo The path of the repository.
	 * @param tagName The name of the tag to push.
	 * @param remotes The remote(s) to push the tag to.
	 * @param commitHash The commit hash the tag is on.
	 * @param skipRemoteCheck Skip checking that the tag is on each of the `remotes`.
	 * @returns The ErrorInfo's from the executed commands.
	 */
	public async pushTag(repo: string, tagName: string, remotes: string[], commitHash: string, skipRemoteCheck: boolean): Promise<ErrorInfo[]> {
		if (remotes.length === 0) {
			return [t('No remote(s) were specified to push the tag {0} to.', tagName)];
		}

		if (!skipRemoteCheck) {
			const remotesContainingCommit = await this.getRemotesContainingCommit(repo, commitHash, remotes).catch(() => remotes);
			const remotesNotContainingCommit = remotes.filter((remote) => !remotesContainingCommit.includes(remote));
			if (remotesNotContainingCommit.length > 0) {
				return [ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote + JSON.stringify(remotesNotContainingCommit)];
			}
		}

		const results: ErrorInfo[] = [];
		for (let i = 0; i < remotes.length; i++) {
			const result = await this.runGitCommand(['push', remotes[i], 'refs/tags/' + tagName], repo);
			results.push(result);
			if (result !== null) break;
		}
		return results;
	}


	/* Git Action Methods - Branches */

	/**
	 * Checkout a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch to checkout.
	 * @param remoteBranch The name of the remote branch to check out (if not NULL).
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutBranch(repo: string, branchName: string, remoteBranch: string | null) {
		let args = ['checkout'];
		if (remoteBranch === null) args.push(branchName);
		else args.push('-b', branchName, remoteBranch);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch at a commit.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param commitHash The hash of the commit the branch should be created at.
	 * @param checkout Check out the branch after it is created.
	 * @param force Force create the branch, replacing an existing branch with the same name (if it exists).
	 * @returns The ErrorInfo's from the executed command(s).
	 */
	public async createBranch(repo: string, branchName: string, commitHash: string, checkout: boolean, force: boolean) {
		const args = [];
		if (checkout && !force) {
			args.push('checkout', '-b');
		} else {
			args.push('branch');
			if (force) {
				args.push('-f');
			}
		}
		args.push(branchName, commitHash);

		const statuses = [await this.runGitCommand(args, repo)];
		if (statuses[0] === null && checkout && force) {
			statuses.push(await this.checkoutBranch(repo, branchName, null));
		}
		return statuses;
	}

	/**
	 * Delete a branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param force Should force the branch to be deleted (even if not merged).
	 * @returns The ErrorInfo from the executed command.
	 */
	public deleteBranch(repo: string, branchName: string, force: boolean) {
		return this.runGitCommand(['branch', force ? '-D' : '-d', branchName], repo);
	}

	/**
	 * Delete a remote branch in a repository.
	 * @param repo The path of the repository.
	 * @param branchName The name of the branch.
	 * @param remote The name of the remote to delete the branch on.
	 * @returns The ErrorInfo from the executed command.
	 */
	public async deleteRemoteBranch(repo: string, branchName: string, remote: string) {
		let remoteStatus = await this.runGitCommand(['push', remote, '--delete', 'refs/heads/' + branchName], repo);
		if (remoteStatus !== null && (new RegExp('remote ref does not exist', 'i')).test(remoteStatus)) {
			let trackingBranchStatus = await this.runGitCommand(['branch', '-d', '-r', remote + '/' + branchName], repo);
			return trackingBranchStatus === null ? null : t('Branch does not exist on the remote, deleting the remote tracking branch {0}.', remote + '/' + branchName) + '\n' + trackingBranchStatus;
		}
		return remoteStatus;
	}

	/**
	 * Fetch a remote branch into a local branch.
	 * @param repo The path of the repository.
	 * @param remote The name of the remote containing the remote branch.
	 * @param remoteBranch The name of the remote branch.
	 * @param localBranch The name of the local branch.
	 * @param force Force fetch the remote branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public fetchIntoLocalBranch(repo: string, remote: string, remoteBranch: string, localBranch: string, force: boolean) {
		const args = ['fetch'];
		if (force) {
			args.push('-f');
		}
		args.push(remote, remoteBranch + ':' + localBranch);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Pull a remote branch into the current branch.
	 * @param repo The path of the repository.
	 * @param branchName The name of the remote branch.
	 * @param remote The name of the remote containing the remote branch.
	 * @param createNewCommit Is `--no-ff` enabled if a merge is required.
	 * @param squash Is `--squash` enabled if a merge is required.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pullBranch(repo: string, branchName: string, remote: string, createNewCommit: boolean, squash: boolean) {
		const args = ['pull', remote, branchName], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((pullStatus) => {
			return pullStatus === null && squash
				? this.commitSquashIfStagedChangesExist(repo, remote + '/' + branchName, MergeActionOn.Branch, config.squashPullMessageFormat, config.signCommits)
				: pullStatus;
		});
	}

	/**
	 * Rename a branch in a repository.
	 * @param repo The path of the repository.
	 * @param oldName The old name of the branch.
	 * @param newName The new name of the branch.
	 * @returns The ErrorInfo from the executed command.
	 */
	public renameBranch(repo: string, oldName: string, newName: string) {
		return this.runGitCommand(['branch', '-m', oldName, newName], repo);
	}


	/* Git Action Methods - Branches & Commits */

	/**
	 * Merge a branch or commit into the current branch.
	 * @param repo The path of the repository.
	 * @param obj The object to be merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param createNewCommit Is `--no-ff` enabled.
	 * @param squash Is `--squash` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public merge(repo: string, obj: string, actionOn: MergeActionOn, createNewCommit: boolean, squash: boolean, noCommit: boolean) {
		const args = ['merge', obj], config = getConfig();
		if (squash) {
			args.push('--squash');
		} else if (createNewCommit) {
			args.push('--no-ff');
		}
		if (noCommit) {
			args.push('--no-commit');
		}
		if (config.signCommits) {
			args.push('-S');
		}
		return this.runGitCommand(args, repo).then((mergeStatus) => {
			return mergeStatus === null && squash && !noCommit
				? this.commitSquashIfStagedChangesExist(repo, obj, actionOn, config.squashMergeMessageFormat, config.signCommits)
				: mergeStatus;
		});
	}

	/**
	 * Rebase the current branch on a branch or commit.
	 * @param repo The path of the repository.
	 * @param obj The object the current branch will be rebased onto.
	 * @param actionOn Is the rebase on a branch or commit.
	 * @param ignoreDate Is `--ignore-date` enabled.
	 * @param interactive Should the rebase be performed interactively.
	 * @returns The ErrorInfo from the executed command.
	 */
	public rebase(repo: string, obj: string, actionOn: RebaseActionOn, ignoreDate: boolean, interactive: boolean) {
		if (interactive) {
			// The command is run by the shell of the Integrated Terminal, so only the resolved commit hash (never the branch name, which may contain shell syntax) is included in it
			return this.resolveCommitHash(repo, obj).then((commitHash) => this.openGitTerminal(
				repo,
				'rebase --interactive ' + (getConfig().signCommits ? '-S ' : '') + commitHash,
				t('Rebase on "{0}"', actionOn === RebaseActionOn.Branch ? obj : abbrevCommit(obj))
			), (errorMessage: string) => errorMessage);
		} else {
			const args = ['rebase', obj];
			if (ignoreDate) {
				args.push('--ignore-date');
			}
			if (getConfig().signCommits) {
				args.push('-S');
			}
			return this.runGitCommand(args, repo);
		}
	}


	/* Git Action Methods - Branches & Tags */

	/**
	 * Create an archive of a repository at a specific reference, and save to disk.
	 * @param repo The path of the repository.
	 * @param ref The reference of the revision to archive.
	 * @param outputFilePath The file path that the archive should be saved to.
	 * @param type The type of archive.
	 * @returns The ErrorInfo from the executed command.
	 */
	public archive(repo: string, ref: string, outputFilePath: string, type: 'tar' | 'zip') {
		return this.runGitCommand(['archive', '--format=' + type, '-o', outputFilePath, ref], repo);
	}


	/* Git Action Methods - Commits */

	/**
	 * Checkout a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to check out.
	 * @returns The ErrorInfo from the executed command.
	 */
	public checkoutCommit(repo: string, commitHash: string) {
		return this.runGitCommand(['checkout', commitHash], repo);
	}

	/**
	 * Cherrypick a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to be cherry picked.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @param recordOrigin Is `-x` enabled.
	 * @param noCommit Is `--no-commit` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommit(repo: string, commitHash: string, parentIndex: number, recordOrigin: boolean, noCommit: boolean) {
		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Cherry pick several commits into the current branch of a repository (merge commits can't be cherry picked with other commits).
	 * @param repo The path of the repository.
	 * @param commitHashes The hashes of the commits, in the order they're cherry picked (oldest first).
	 * @param recordOrigin Record that each commit was the origin of its cherry pick (`-x`).
	 * @param noCommit Stage the changes of the commits without committing them.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cherrypickCommits(repo: string, commitHashes: ReadonlyArray<string>, recordOrigin: boolean, noCommit: boolean) {
		const args = ['cherry-pick'];
		if (noCommit) {
			args.push('--no-commit');
		}
		if (recordOrigin) {
			args.push('-x');
		}
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push(...commitHashes);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Drop a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to drop.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropCommit(repo: string, commitHash: string) {
		const args = ['rebase'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		args.push('--onto', commitHash + '^', commitHash);
		return this.runGitCommand(args, repo);
	}

	/**
	 * Reset the current branch to a specified commit.
	 * @param repo The path of the repository.
	 * @param commit The hash of the commit that the current branch should be reset to.
	 * @param resetMode The mode of the reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetToCommit(repo: string, commit: string, resetMode: GitResetMode) {
		return this.runGitCommand(['reset', '--' + resetMode, commit], repo);
	}

	/**
	 * Revert a commit in a repository.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit to revert.
	 * @param parentIndex The parent index if the commit is a merge.
	 * @returns The ErrorInfo from the executed command.
	 */
	public revertCommit(repo: string, commitHash: string, parentIndex: number) {
		const args = ['revert', '--no-edit'];
		if (getConfig().signCommits) {
			args.push('-S');
		}
		if (parentIndex > 0) {
			args.push('-m', parentIndex.toString());
		}
		args.push(commitHash);
		return this.runGitCommand(args, repo);
	}


	/* Git Action Methods - Config */

	/**
	 * Set a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be set.
	 * @param value The value to be set.
	 * @param location The location where the configuration value should be set.
	 * @returns The ErrorInfo from the executed command.
	 */
	public setConfigValue(repo: string, key: GitConfigKey, value: string, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, key, value], repo);
	}

	/**
	 * Unset a configuration value for a repository.
	 * @param repo The path of the repository.
	 * @param key The Git Config Key to be unset.
	 * @param location The location where the configuration value should be unset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public unsetConfigValue(repo: string, key: GitConfigKey, location: GitConfigLocation) {
		return this.runGitCommand(['config', '--' + location, '--unset-all', key], repo);
	}


	/* Git Action Methods - Uncommitted */

	/**
	 * Clean the untracked files in a repository.
	 * @param repo The path of the repository.
	 * @param directories Is `-d` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public cleanUntrackedFiles(repo: string, directories: boolean) {
		return this.runGitCommand(['clean', '-f' + (directories ? 'd' : '')], repo);
	}


	/* Git Action Methods - File */

	/**
	 * Reset a file to the specified revision.
	 * @param repo The path of the repository.
	 * @param commitHash The commit to reset the file to.
	 * @param filePath The file to reset.
	 * @returns The ErrorInfo from the executed command.
	 */
	public resetFileToRevision(repo: string, commitHash: string, filePath: string) {
		return this.runGitCommand(['checkout', commitHash, '--', filePath], repo);
	}


	/* Git Action Methods - Stash */

	/**
	 * Apply a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public applyStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'apply'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Create a branch from a stash.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param branchName The name of the branch to be created.
	 * @returns The ErrorInfo from the executed command.
	 */
	public branchFromStash(repo: string, selector: string, branchName: string) {
		return this.runGitCommand(['stash', 'branch', branchName, selector], repo);
	}

	/**
	 * Drop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @returns The ErrorInfo from the executed command.
	 */
	public dropStash(repo: string, selector: string) {
		return this.runGitCommand(['stash', 'drop', selector], repo);
	}

	/**
	 * Pop a stash in a repository.
	 * @param repo The path of the repository.
	 * @param selector The selector of the stash.
	 * @param reinstateIndex Is `--index` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public popStash(repo: string, selector: string, reinstateIndex: boolean) {
		let args = ['stash', 'pop'];
		if (reinstateIndex) args.push('--index');
		args.push(selector);

		return this.runGitCommand(args, repo);
	}

	/**
	 * Push the uncommitted changes to a stash.
	 * @param repo The path of the repository.
	 * @param message The message of the stash.
	 * @param includeUntracked Is `--include-untracked` enabled.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pushStash(repo: string, message: string, includeUntracked: boolean): Promise<ErrorInfo> {
		if (this.gitExecutable === null) {
			return Promise.resolve(UNABLE_TO_FIND_GIT_MSG);
		} else if (!doesVersionMeetRequirement(this.gitExecutable.version, GitVersionRequirement.PushStash)) {
			return Promise.resolve(constructIncompatibleGitVersionMessage(this.gitExecutable, GitVersionRequirement.PushStash));
		}

		let args = ['stash', 'push'];
		if (includeUntracked) args.push('--include-untracked');
		if (message !== '') args.push('--message', message);
		return this.runGitCommand(args, repo);
	}


	/* Public Utils */

	/**
	 * Opens an external directory diff for the specified commits.
	 * @param repo The path of the repository.
	 * @param fromHash The commit hash the diff is from.
	 * @param toHash The commit hash the diff is to.
	 * @param isGui Is the external diff tool GUI based.
	 * @returns The ErrorInfo from the executed command.
	 */
	public openExternalDirDiff(repo: string, fromHash: string, toHash: string, isGui: boolean) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				const args = ['difftool', '--dir-diff'];
				if (isGui) {
					args.push('-g');
				}
				if (fromHash === toHash) {
					if (toHash === UNCOMMITTED) {
						args.push('HEAD');
					} else {
						args.push(toHash + '^..' + toHash);
					}
				} else {
					if (toHash === UNCOMMITTED) {
						args.push(fromHash);
					} else {
						args.push(fromHash + '..' + toHash);
					}
				}
				if (isGui) {
					this.logger.log('External diff tool is being opened (' + args[args.length - 1] + ')');
					this.runGitCommand(args, repo).then((errorInfo) => {
						this.logger.log('External diff tool has exited (' + args[args.length - 1] + ')');
						if (errorInfo !== null) {
							const errorMessage = errorInfo.replace(EOL_REGEX, ' ');
							this.logger.logError(errorMessage);
							showErrorMessage(errorMessage);
						}
					});
				} else {
					openGitTerminal(repo, this.gitExecutable.path, args.join(' '), t('Open External Directory Diff'));
				}
				setTimeout(() => resolve(null), 1500);
			}
		});
	}

	/**
	 * Resolve a branch name or commit hash to the full hash of the commit it refers to.
	 * @param repo The path of the repository.
	 * @param obj The branch name or commit hash.
	 * @returns A promise resolving to the commit hash, or rejecting with an error message.
	 */
	private resolveCommitHash(repo: string, obj: string): Promise<string> {
		const errorMessage = t('Unable to resolve "{0}" to a commit.', obj);
		return this.spawnGit(['rev-parse', '--verify', '--quiet', obj + '^{commit}'], repo, (stdout) => stdout.trim()).then(
			(commitHash) => COMMIT_HASH_REGEXP.test(commitHash) ? commitHash : Promise.reject(errorMessage),
			() => Promise.reject(this.gitExecutable !== null ? errorMessage : UNABLE_TO_FIND_GIT_MSG)
		);
	}

	/**
	 * Open a new terminal, set up the Git executable, and optionally run a command.
	 * @param repo The path of the repository.
	 * @param command The command to run.
	 * @param name The name for the terminal.
	 * @returns The ErrorInfo from opening the terminal.
	 */
	public openGitTerminal(repo: string, command: string | null, name: string) {
		return new Promise<ErrorInfo>((resolve) => {
			if (this.gitExecutable === null) {
				resolve(UNABLE_TO_FIND_GIT_MSG);
			} else {
				openGitTerminal(repo, this.gitExecutable.path, command, name);
				setTimeout(() => resolve(null), 1000);
			}
		});
	}


	/* Private Data Providers */

	/**
	 * Get the branches in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The branch data.
	 */
	private getBranches(repo: string, showRemoteBranches: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['branch'];
		if (showRemoteBranches) args.push('-a');
		args.push('--no-color');

		const hideRemotePatterns = hideRemotes.map((remote) => 'remotes/' + remote + '/');
		const showRemoteHeads = getConfig().showRemoteHeads;

		return this.spawnGit(args, repo, (stdout) => {
			let branchData: GitBranchData = { branches: [], head: null, error: null };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let name = lines[i].substring(2).split(' -> ')[0];
				if (INVALID_BRANCH_REGEXP.test(name) || hideRemotePatterns.some((pattern) => name.startsWith(pattern)) || (!showRemoteHeads && REMOTE_HEAD_BRANCH_REGEXP.test(name))) {
					continue;
				}

				if (lines[i][0] === '*') {
					branchData.head = name;
					branchData.branches.unshift(name);
				} else {
					branchData.branches.push(name);
				}
			}
			return branchData;
		});
	}

	/**
	 * Get the base commit details for the Commit Details View.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit open in the Commit Details View.
	 * @returns The base commit details.
	 */
	private getCommitDetailsBase(repo: string, commitHash: string) {
		return this.spawnGit(['-c', 'log.showSignature=false', 'show', '--quiet', commitHash, '--format=' + this.gitFormatCommitDetails], repo, (stdout): DeepWriteable<GitCommitDetails> => {
			const commitInfo = stdout.split(GIT_LOG_SEPARATOR);
			return {
				hash: commitInfo[0],
				parents: commitInfo[1] !== '' ? commitInfo[1].split(' ') : [],
				author: commitInfo[2],
				authorEmail: commitInfo[3],
				authorDate: parseInt(commitInfo[4]),
				committer: commitInfo[5],
				committerEmail: commitInfo[6],
				committerDate: parseInt(commitInfo[7]),
				signature: ['G', 'U', 'X', 'Y', 'R', 'E', 'B'].includes(commitInfo[8])
					? {
						key: commitInfo[10].trim(),
						signer: commitInfo[9].trim(),
						status: <GitSignatureStatus>commitInfo[8]
					}
					: null,
				body: removeTrailingBlankLines(commitInfo.slice(11).join(GIT_LOG_SEPARATOR).split(EOL_REGEX)).join('\n'),
				fileChanges: []
			};
		});
	}

	/**
	 * Get the configuration list of a repository.
	 * @param repo The path of the repository.
	 * @param location The location of the configuration to be listed.
	 * @returns A set of key-value pairs of Git configuration records.
	 */
	private getConfigList(repo: string, location?: GitConfigLocation): Promise<GitConfigSet> {
		const args = ['--no-pager', 'config', '--list', '-z', '--includes'];
		if (location) {
			args.push('--' + location);
		}

		return this.spawnGit(args, repo, (stdout) => {
			const configs: GitConfigSet = {}, keyValuePairs = stdout.split('\0');
			const numPairs = keyValuePairs.length - 1;
			let comps, key;
			for (let i = 0; i < numPairs; i++) {
				comps = keyValuePairs[i].split(EOL_REGEX);
				key = comps.shift()!;
				configs[key] = comps.join('\n');
			}
			return configs;
		}).catch((errorMessage) => {
			if (typeof errorMessage === 'string') {
				const message = errorMessage.toLowerCase();
				if (message.startsWith('fatal: unable to read config file') && message.endsWith('no such file or directory')) {
					// If the Git command failed due to the configuration file not existing, return an empty list instead of throwing the exception
					return {};
				}
			} else {
				errorMessage = t('An unexpected error occurred while spawning the Git child process.');
			}
			throw errorMessage;
		});
	}

	/**
	 * Get the diff `--name-status` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--name-status` records.
	 */
	private getDiffNameStatus(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--name-status', filter).then((output) => {
			let records: DiffNameStatusRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let type = <GitFileStatus>output[i][0];
				if (type === GitFileStatus.Added || type === GitFileStatus.Deleted || type === GitFileStatus.Modified) {
					// Add, Modify, or Delete
					let p = getPathFromStr(output[i + 1]);
					records.push({ type: type, oldFilePath: p, newFilePath: p });
					i += 2;
				} else if (type === GitFileStatus.Renamed) {
					// Rename
					records.push({ type: type, oldFilePath: getPathFromStr(output[i + 1]), newFilePath: getPathFromStr(output[i + 2]) });
					i += 3;
				} else {
					break;
				}
			}
			return records;
		});
	}

	/**
	 * Get the diff `--numstat` records.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param filter The types of file changes to retrieve (defaults to `AMDR`).
	 * @returns An array of `--numstat` records.
	 */
	private getDiffNumStat(repo: string, fromHash: string, toHash: string, filter: string = 'AMDR') {
		return this.execDiff(repo, fromHash, toHash, '--numstat', filter).then((output) => {
			let records: DiffNumStatRecord[] = [], i = 0;
			while (i < output.length && output[i] !== '') {
				let fields = output[i].split('\t');
				if (fields.length !== 3) break;
				if (fields[2] !== '') {
					// Add, Modify, or Delete
					records.push({ filePath: getPathFromStr(fields[2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 1;
				} else {
					// Rename
					records.push({ filePath: getPathFromStr(output[i + 2]), additions: parseInt(fields[0]), deletions: parseInt(fields[1]) });
					i += 3;
				}
			}
			return records;
		});
	}

	/**
	 * Get the raw commits in a repository.
	 * @param repo The path of the repository.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param num The maximum number of commits to return.
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @param remotes An array of the known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @param authors The names of the authors whose commits are returned, or NULL (all authors).
	 * @param paths The paths of a file whose history is returned (with the parents of the commits rewritten to be the nearest commits that also change it), or NULL (all commits).
	 * @returns An array of commits.
	 */
	private getLog(repo: string, branches: ReadonlyArray<string> | null, num: number, includeTags: boolean, includeRemotes: boolean, includeCommitsMentionedByReflogs: boolean, onlyFollowFirstParent: boolean, order: CommitOrdering, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>, authors: ReadonlyArray<string> | null = null, paths: ReadonlyArray<string> | null = null) {
		const args = ['-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + this.gitFormatLog, '--' + order + '-order'];
		if (onlyFollowFirstParent) {
			args.push('--first-parent');
		}
		if (paths !== null) {
			args.push('--parents');
		}
		if (authors !== null && authors.length > 0) {
			// Each pattern matches the author's name exactly (Git matches it against "Name <email> ..."), and commits by any of the authors are returned
			args.push('--extended-regexp');
			if (getConfig().useMailmap) args.push('--use-mailmap');
			authors.forEach((author) => args.push('--author=^' + author.replace(EXTENDED_REGEXP_SPECIAL_CHARACTERS, '\\$&') + ' <'));
		}
		args.push(...this.getRevisionArgs(branches, includeTags, includeRemotes, includeCommitsMentionedByReflogs, remotes, hideRemotes, stashes));
		args.push('--');
		if (paths !== null) {
			args.push(...paths);
		}

		return this.spawnGit(args, repo, (stdout) => {
			// Records are only split on LF, as subjects can contain a raw CR character
			let lines = stdout.split(LF_REGEX);
			let commits: GitCommitRecord[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 6) continue;
				commits.push({ hash: line[0], parents: line[1] !== '' ? line[1].split(' ') : [], author: line[2], email: line[3], date: parseInt(line[4]), message: line[5] });
			}
			return commits;
		});
	}

	/**
	 * Get the arguments that specify the revisions (branches, tags, remotes, etc.) of the commits shown in the Git Map View.
	 * @param branches The list of branch heads to display, or NULL (show all).
	 * @param includeTags Include commits only referenced by tags.
	 * @param includeRemotes Include remote branches.
	 * @param includeCommitsMentionedByReflogs Include commits mentioned by reflogs.
	 * @param remotes An array of known remotes.
	 * @param hideRemotes An array of hidden remotes.
	 * @param stashes An array of all stashes in the repository.
	 * @returns The arguments.
	 */
	private getRevisionArgs(branches: ReadonlyArray<string> | null, includeTags: boolean, includeRemotes: boolean, includeCommitsMentionedByReflogs: boolean, remotes: ReadonlyArray<string>, hideRemotes: ReadonlyArray<string>, stashes: ReadonlyArray<GitStash>) {
		const args: string[] = [];
		if (branches !== null) {
			for (let i = 0; i < branches.length; i++) {
				args.push(branches[i]);
			}
		} else {
			// Show All
			args.push('--branches');
			if (includeTags) args.push('--tags');
			if (includeCommitsMentionedByReflogs) args.push('--reflog');
			if (includeRemotes) {
				if (hideRemotes.length === 0) {
					args.push('--remotes');
				} else {
					remotes.filter((remote) => !hideRemotes.includes(remote)).forEach((remote) => {
						args.push('--glob=refs/remotes/' + remote);
					});
				}
			}

			// Add the unique list of base hashes of stashes, so that commits only referenced by stashes are displayed
			const stashBaseHashes = stashes.map((stash) => stash.baseHash);
			stashBaseHashes.filter((hash, index) => stashBaseHashes.indexOf(hash) === index).forEach((hash) => args.push(hash));

			args.push('HEAD');
		}
		return args;
	}

	/**
	 * Get all of the paths that a file has had in the history of a repository (by following it through renames).
	 * @param repo The path of the repository.
	 * @param filePath The current path of the file.
	 * @param revisionArgs The revisions whose history is searched.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @returns The paths (the current path first).
	 */
	private getFileHistoryPaths(repo: string, filePath: string, revisionArgs: ReadonlyArray<string>, onlyFollowFirstParent: boolean) {
		// Following a file walks all of its history, so the paths are cached while the revisions (and HEAD) are unchanged, as the view is refreshed often
		return this.spawnGit(['rev-parse', 'HEAD'], repo, (stdout) => stdout.trim()).catch(() => '').then((head) => {
			const key = JSON.stringify([repo, filePath, revisionArgs, onlyFollowFirstParent, head]);
			if (this.fileHistoryPathsCache !== null && this.fileHistoryPathsCache.key === key) return this.fileHistoryPathsCache.paths;
			const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--follow', '-M', '--diff-filter=R', '--name-status', '--format='];
			if (onlyFollowFirstParent) args.push('--first-parent');
			args.push(...revisionArgs, '--', filePath);
			return this.spawnGit(args, repo, (stdout) => {
				const paths = [filePath];
				stdout.split(LF_REGEX).forEach((line) => {
					const fields = line.split('\t');
					if (fields.length === 3 && fields[0].startsWith('R')) {
						fields.slice(1).forEach((path) => {
							if (!paths.includes(path)) paths.push(path);
						});
					}
				});
				this.fileHistoryPathsCache = { key: key, paths: paths };
				return paths;
			}).catch(() => [filePath]);
		});
	}

	/**
	 * Get how a file is changed by each commit in its history.
	 * @param repo The path of the repository.
	 * @param revisionArgs The revisions whose history is searched.
	 * @param paths All of the paths the file has had.
	 * @param num The maximum number of commits to return.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @returns How the file is changed by each commit (merge commits are omitted).
	 */
	private getFileHistoryCommits(repo: string, revisionArgs: ReadonlyArray<string>, paths: ReadonlyArray<string>, num: number, onlyFollowFirstParent: boolean, order: CommitOrdering) {
		const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + GIT_LOG_SEPARATOR + '%H', '--numstat', '-M', '--' + order + '-order'];
		if (onlyFollowFirstParent) args.push('--first-parent');
		args.push(...revisionArgs, '--', ...paths);
		return this.spawnGit(args, repo, (stdout) => {
			const commits: { [hash: string]: GitFileHistoryCommit } = {};
			let hash: string | null = null;
			stdout.split(LF_REGEX).forEach((line) => {
				if (line.startsWith(GIT_LOG_SEPARATOR)) {
					hash = line.substring(GIT_LOG_SEPARATOR.length);
					return;
				}
				const fields = line.split('\t');
				if (hash === null || fields.length < 3) return;
				const path = parseNumstatPath(fields.slice(2).join('\t'));
				const additions = fields[0] !== '-' ? parseInt(fields[0]) : null, deletions = fields[1] !== '-' ? parseInt(fields[1]) : null;
				const existing = commits[hash];
				commits[hash] = typeof existing === 'undefined'
					? { filePath: path.newPath, oldFilePath: path.oldPath, additions: additions, deletions: deletions }
					: { filePath: existing.filePath, oldFilePath: existing.oldFilePath, additions: existing.additions !== null && additions !== null ? existing.additions + additions : null, deletions: existing.deletions !== null && deletions !== null ? existing.deletions + deletions : null };
			});
			return commits;
		}).catch(() => <{ [hash: string]: GitFileHistoryCommit }>{});
	}

	/**
	 * Get how a range of lines of a file is changed by each commit in its history (following the lines as they move, and the file
	 * through renames). The history of the lines can only be followed from one commit (`git log -L` doesn't support several).
	 * @param repo The path of the repository.
	 * @param revision The revision whose history is searched (the branch whose history is shown, or HEAD).
	 * @param filePath The current path of the file.
	 * @param lineRange The lines.
	 * @param num The maximum number of commits to return.
	 * @param onlyFollowFirstParent Only follow the first parent of commits.
	 * @param order The order for commits to be returned.
	 * @returns How the lines are changed by each commit.
	 */
	private getLineHistoryCommits(repo: string, revision: string, filePath: string, lineRange: GitLineRange, num: number, onlyFollowFirstParent: boolean, order: CommitOrdering) {
		const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--max-count=' + num, '--format=' + GIT_LOG_SEPARATOR + '%H', '--' + order + '-order', '-L', lineRange.start + ',' + lineRange.end + ':' + filePath];
		if (onlyFollowFirstParent) args.push('--first-parent');
		args.push(revision, '--');
		return this.spawnGit(args, repo, (stdout) => {
			// Each commit is followed by the diff of the lines (the lines of the diff are counted, as `-L` can't be combined with `--numstat`)
			const commits: { [hash: string]: Writeable<GitFileHistoryCommit> } = {};
			let commit: Writeable<GitFileHistoryCommit> | null = null, inHunk = false;
			stdout.split(LF_REGEX).forEach((line) => {
				if (line.startsWith(GIT_LOG_SEPARATOR)) {
					commit = commits[line.substring(GIT_LOG_SEPARATOR.length)] = { filePath: filePath, oldFilePath: null, additions: 0, deletions: 0 };
					inHunk = false;
				} else if (commit === null) {
					return;
				} else if (line.startsWith('diff --git ')) {
					inHunk = false;
				} else if (!inHunk && line.startsWith('+++ ')) {
					if (line !== '+++ /dev/null') commit.filePath = line.substring(line.startsWith('+++ b/') ? 6 : 4);
				} else if (!inHunk && line.startsWith('--- ')) {
					if (line !== '--- /dev/null') commit.oldFilePath = line.substring(line.startsWith('--- a/') ? 6 : 4);
				} else if (line.startsWith('@@')) {
					inHunk = true;
				} else if (inHunk && line.startsWith('+')) {
					commit.additions!++;
				} else if (inHunk && line.startsWith('-')) {
					commit.deletions!++;
				}
			});
			Object.keys(commits).forEach((hash) => {
				// The old path is only kept if the commit renamed the file
				if (commits[hash].oldFilePath === commits[hash].filePath) commits[hash].oldFilePath = null;
			});
			return <{ [hash: string]: GitFileHistoryCommit }>commits;
		}).catch(() => <{ [hash: string]: GitFileHistoryCommit }>{});
	}

	/**
	 * Get the commit that last changed a line of a file. The contents of the file are blamed (rather than the committed file), so that
	 * the line numbers of a file with uncommitted changes match.
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param line The line (1-based).
	 * @param contents The contents of the file.
	 * @returns The blame of the line, or NULL if it couldn't be determined (e.g. the file isn't tracked).
	 */
	public getLineBlame(repo: string, filePath: string, line: number, contents: string): Promise<GitLineBlame | null> {
		return this._spawnGit(['blame', '--porcelain', '-L', line + ',' + line, '--contents', '-', '--', filePath], repo, (stdout) => {
			const lines = stdout.toString().split(LF_REGEX), header = lines.length > 0 ? lines[0].match(/^([0-9a-f]{40,64}) (\d+) /) : null;
			if (header === null) return null;
			const field = (name: string) => {
				const fieldLine = lines.find((fieldLine) => fieldLine.startsWith(name + ' '));
				return typeof fieldLine === 'string' ? fieldLine.substring(name.length + 1) : '';
			};
			return {
				hash: header[1],
				committed: !/^0+$/.test(header[1]),
				author: field('author'),
				authorEmail: field('author-mail').replace(/^<|>$/g, ''),
				authorDate: parseInt(field('author-time')) || 0,
				summary: field('summary'),
				originalLine: parseInt(header[2]),
				originalFilePath: field('filename') || filePath
			};
		}, false, contents).catch(() => null);
	}

	/**
	 * Get the commit that last changed each line of a file. The contents of the file are blamed (rather than the committed file), so that
	 * the line numbers of a file with uncommitted changes match.
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param contents The contents of the file.
	 * @returns The blame of the file, or NULL if it couldn't be determined (e.g. the file isn't tracked).
	 */
	public getFileBlame(repo: string, filePath: string, contents: string): Promise<GitFileBlame | null> {
		return this._spawnGit(['blame', '--porcelain', '--contents', '-', '--', filePath], repo, (stdout) => {
			const lines: { hash: string, originalLine: number }[] = [], commits: { [hash: string]: Writeable<GitBlameCommit> } = {};
			let commit: Writeable<GitBlameCommit> | null = null, hash = '', match: RegExpMatchArray | null;
			stdout.toString().split(LF_REGEX).forEach((line) => {
				if ((match = line.match(/^([0-9a-f]{40,64}) (\d+) (\d+)/)) !== null) {
					hash = match[1];
					lines[parseInt(match[3]) - 1] = { hash: hash, originalLine: parseInt(match[2]) };
					commit = commits[hash] || (commits[hash] = { committed: !/^0+$/.test(hash), author: '', authorEmail: '', authorDate: 0, summary: '', filePath: filePath });
				} else if (commit !== null && !line.startsWith('\t')) {
					const space = line.indexOf(' '), key = space > -1 ? line.substring(0, space) : line, value = space > -1 ? line.substring(space + 1) : '';
					if (key === 'author') commit.author = value;
					else if (key === 'author-mail') commit.authorEmail = value.replace(/^<|>$/g, '');
					else if (key === 'author-time') commit.authorDate = parseInt(value) || 0;
					else if (key === 'summary') commit.summary = value;
					else if (key === 'filename') commit.filePath = value;
				}
			});
			return lines.length > 0 ? { lines: lines, commits: commits } : null;
		}, false, contents).catch(() => null);
	}

	/**
	 * Does a file have uncommitted changes (compared with HEAD)?
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @returns TRUE => The file has uncommitted changes, FALSE => It doesn't (or it couldn't be determined).
	 */
	public hasUncommittedChanges(repo: string, filePath: string): Promise<boolean> {
		return this.spawnGit(['-c', 'core.quotepath=false', 'diff', '--name-only', 'HEAD', '--', filePath], repo, (stdout) => stdout.trim() !== '').catch(() => false);
	}

	/**
	 * Get a commit that changed a file: the latest commit (in the history of HEAD), or the commit before or after a commit.
	 * @param repo The path of the repository.
	 * @param from The commit to start from (the latest commit is searched for from HEAD).
	 * @param filePath The path of the file in `from`.
	 * @param which "latest" => The latest commit that changed the file at or before `from`, "before" => The commit before `from` that
	 * changed the file (following it through renames), "after" => The commit after `from` that changed the file, in the history of HEAD.
	 * @returns The commit, how it changed the file, and the paths of the file before & after it, or NULL if there isn't a commit.
	 */
	public async getFileRevision(repo: string, from: string, filePath: string, which: 'latest' | 'before' | 'after'): Promise<{ hash: string, type: GitFileStatus, oldFilePath: string, newFilePath: string } | null> {
		const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--format=%x1e%H', '--name-status', '-M'];
		if (which === 'after') {
			args.push('--reverse', '--ancestry-path', from + '..HEAD');
		} else {
			args.push('--follow', '--max-count=2', from);
		}
		args.push('--', filePath);
		const revisions = await this.spawnGit(args, repo, (stdout) => stdout.split('\x1e').slice(1).map((record) => {
			const lines = record.split(LF_REGEX).filter((line) => line !== ''), change = typeof lines[1] === 'string' ? lines[1].split('\t') : [];
			const status = change.length > 0 ? change[0].charAt(0) : 'M', newPath = change.length > 2 ? change[2] : change.length > 1 ? change[1] : filePath;
			return {
				hash: lines[0],
				type: status === 'A' ? GitFileStatus.Added : status === 'D' ? GitFileStatus.Deleted : status === 'R' ? GitFileStatus.Renamed : GitFileStatus.Modified,
				oldFilePath: change.length > 2 ? change[1] : newPath,
				newFilePath: newPath
			};
		})).catch(() => []);
		if (which === 'before') {
			const fromHash = await this.resolveCommitHash(repo, from).catch(() => from);
			const before = revisions.filter((revision) => revision.hash !== fromHash);
			return before.length > 0 ? before[0] : null;
		}
		const revision = revisions.length > 0 ? revisions[0] : null;
		if (which === 'after' && revision !== null && revision.type === GitFileStatus.Deleted) {
			// The file may have been renamed by the commit (which looks like a deletion, as only its old path is in the pathspec)
			const renamedTo = await this.spawnGit(['-c', 'core.quotepath=false', 'show', '-M', '--name-status', '--format=', revision.hash], repo, (stdout) => {
				const rename = stdout.split(LF_REGEX).map((line) => line.split('\t')).find((change) => change.length === 3 && change[0].startsWith('R') && change[1] === filePath);
				return typeof rename !== 'undefined' ? rename[2] : null;
			}).catch(() => null);
			if (renamedTo !== null) return { hash: revision.hash, type: GitFileStatus.Renamed, oldFilePath: filePath, newFilePath: renamedTo };
		}
		return revision;
	}

	/**
	 * Get how a commit changed a line of a file (as found by blaming the line).
	 * @param repo The path of the repository.
	 * @param hash The hash of the commit.
	 * @param filePath The path of the file in the commit.
	 * @param line The line in the commit (1-based).
	 * @returns The change (the diff of the line, and the paths of the file), or NULL if it couldn't be determined.
	 */
	public getLineChange(repo: string, hash: string, filePath: string, line: number) {
		return this.spawnGit(['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--max-count=1', '--format=', '-L', line + ',' + line + ':' + filePath, hash, '--'], repo, (stdout) => parseLineHistoryDiff(stdout, filePath)).catch(() => null);
	}

	/**
	 * Get the latest commit that changed lines of a file (in the history of HEAD).
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param range The lines (1-based) in HEAD.
	 * @returns The hash of the commit, or NULL if it couldn't be determined.
	 */
	public getLatestCommitOfLines(repo: string, filePath: string, range: GitLineRange): Promise<string | null> {
		return this.spawnGit(['-c', 'log.showSignature=false', 'log', '--max-count=1', '--format=%H', '-L', range.start + ',' + range.end + ':' + filePath, 'HEAD', '--'], repo, (stdout) => {
			const hash = stdout.split(LF_REGEX)[0];
			return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
		}).catch(() => null);
	}

	/**
	 * Get the hash of the commit that HEAD refers to.
	 * @param repo The path of the repository.
	 * @returns The hash, or NULL if the repository doesn't have any commits.
	 */
	public getHeadHash(repo: string): Promise<string | null> {
		return this.resolveCommitHash(repo, 'HEAD').catch(() => null);
	}

	/**
	 * Get the lines in HEAD that are the same as lines of the current contents of a file (e.g. in an editor, with uncommitted changes).
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param range The lines (1-based) in the current contents of the file.
	 * @param contents The current contents of the file.
	 * @returns The first & last of the lines in HEAD, or NULL if none of the lines are in HEAD (they're all uncommitted).
	 */
	public async getLinesInHead(repo: string, filePath: string, range: GitLineRange, contents: string): Promise<GitLineRange | null> {
		const base = await this.spawnGit(['-c', 'core.quotepath=false', 'show', 'HEAD:' + filePath], repo, (stdout) => stdout).catch(() => null);
		if (base === null) return null;
		const baseLines = base.split(LF_REGEX), current = contents.split(LF_REGEX), map = mapLines(baseLines, current);
		const first = Math.max(Math.min(range.start, current.length), 1) - 1, last = Math.max(Math.min(range.end, current.length), first + 1) - 1;
		const baseRange = getBaseRange(map, baseLines.length, first, last);
		return baseRange !== null ? { start: baseRange.start + 1, end: baseRange.end + 1 } : null;
	}

	/**
	 * Get the history of a range of lines of a file: how the uncommitted changes (if any) and each commit in the history of HEAD change them
	 * (following the lines as they move, and the file through renames). The lines are in the current contents of the file (e.g. in an
	 * editor, with uncommitted changes), which are compared with the file in HEAD to find the same lines in HEAD.
	 * @param repo The path of the repository.
	 * @param filePath The path of the file (relative to the repository).
	 * @param range The lines (1-based) in the current contents of the file.
	 * @param contents The current contents of the file.
	 * @param maxCommits The maximum number of commits to return.
	 * @returns The history of the lines.
	 */
	public async getLineHistory(repo: string, filePath: string, range: GitLineRange, contents: string, maxCommits: number): Promise<GitLineHistory> {
		const base = await this.spawnGit(['-c', 'core.quotepath=false', 'show', 'HEAD:' + filePath], repo, (stdout) => stdout).catch(() => null);
		const current = contents.split(LF_REGEX), baseLines = base !== null ? base.split(LF_REGEX) : [];
		const map = mapLines(baseLines, current);
		const first = Math.max(Math.min(range.start, current.length), 1) - 1, last = Math.max(Math.min(range.end, current.length), first + 1) - 1;

		// The same lines in HEAD, and the uncommitted changes to the lines
		const baseRange = base !== null ? getBaseRange(map, baseLines.length, first, last) : null;
		const diff = getRangeDiff(map, baseLines, current, first, last, baseRange);
		const headRange = baseRange !== null ? { start: baseRange.start + 1, end: baseRange.end + 1 } : null;
		const entries: GitLineHistoryEntry[] = [];
		const additions = diff.filter((line) => line.startsWith('+')).length, deletions = diff.filter((line) => line.startsWith('-')).length;
		if (additions > 0 || deletions > 0) {
			entries.push({
				hash: UNCOMMITTED, parents: base !== null ? ['HEAD'] : [], author: '', authorEmail: '', authorDate: Math.round(Date.now() / 1000), subject: '', body: '',
				filePath: filePath, oldFilePath: null, fileAdded: base === null, oldRange: headRange, newRange: { start: first + 1, end: last + 1 }, diff: diff, additions: additions, deletions: deletions
			});
		}
		if (headRange === null) {
			return { repo: repo, filePath: filePath, range: range, headRange: null, entries: entries, moreAvailable: false, error: null };
		}

		const args = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false', 'log', '--max-count=' + (maxCommits + 1), '--format=' + GIT_LOG_SEPARATOR + '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e', '-L', headRange.start + ',' + headRange.end + ':' + filePath, 'HEAD', '--'];
		return this.spawnGit(args, repo, (stdout) => {
			stdout.split(GIT_LOG_SEPARATOR).slice(1).forEach((record) => {
				const headerEnd = record.indexOf('\x1e');
				if (headerEnd === -1) return;
				const fields = record.substring(0, headerEnd).split('\x1f');
				const entry = parseLineHistoryDiff(record.substring(headerEnd + 1), filePath);
				entries.push({
					hash: fields[0], parents: fields[1] !== '' ? fields[1].split(' ') : [], author: fields[2], authorEmail: fields[3], authorDate: parseInt(fields[4]) || 0,
					subject: fields[5], body: (fields[6] || '').trim(), ...entry
				});
			});
			const numCommits = entries.filter((entry) => entry.hash !== UNCOMMITTED).length;
			if (numCommits > maxCommits) entries.pop();
			return { repo: repo, filePath: filePath, range: range, headRange: headRange, entries: entries, moreAvailable: numCommits > maxCommits, error: null };
		}).catch((errorMessage: string) => ({ repo: repo, filePath: filePath, range: range, headRange: headRange, entries: entries, moreAvailable: false, error: errorMessage }));
	}

	/**
	 * Get the changes made to a file by a commit, as a unified diff.
	 * @param repo The path of the repository.
	 * @param commitHash The hash of the commit.
	 * @param parentHash The hash of the commit's (first) parent, or NULL if it doesn't have one.
	 * @param oldFilePath The path of the file before the commit.
	 * @param newFilePath The path of the file after the commit.
	 * @returns The diff (truncated if it's very long).
	 */
	public getFileDiff(repo: string, commitHash: string, parentHash: string | null, oldFilePath: string, newFilePath: string): Promise<{ diff: string, error: ErrorInfo }> {
		const paths = oldFilePath !== newFilePath ? [oldFilePath, newFilePath] : [newFilePath];
		return this.spawnGit(['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '-M', parentHash !== null ? parentHash : EMPTY_TREE_HASH, commitHash, '--', ...paths], repo, (stdout) => stdout.length > 200000 ? stdout.substring(0, 200000) : stdout).then(
			(diff) => ({ diff: diff, error: null }),
			(errorMessage: string) => ({ diff: '', error: errorMessage })
		);
	}

	/**
	 * Get the references in a repository.
	 * @param repo The path of the repository.
	 * @param showRemoteBranches Are remote branches shown.
	 * @param showRemoteHeads Are remote heads shown.
	 * @param hideRemotes An array of hidden remotes.
	 * @returns The references data.
	 */
	private getRefs(repo: string, showRemoteBranches: boolean, showRemoteHeads: boolean, hideRemotes: ReadonlyArray<string>) {
		let args = ['show-ref'];
		if (!showRemoteBranches) args.push('--heads', '--tags');
		args.push('-d', '--head');

		const hideRemotePatterns = hideRemotes.map((remote) => 'refs/remotes/' + remote + '/');

		return this.spawnGit(args, repo, (stdout) => {
			let refData: GitRefData = { head: null, heads: [], tags: [], remotes: [] };
			let lines = stdout.split(EOL_REGEX);
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(' ');
				if (line.length < 2) continue;

				let hash = line.shift()!;
				let ref = line.join(' ');

				if (ref.startsWith('refs/heads/')) {
					refData.heads.push({ hash: hash, name: ref.substring(11) });
				} else if (ref.startsWith('refs/tags/')) {
					let annotated = ref.endsWith('^{}');
					refData.tags.push({ hash: hash, name: (annotated ? ref.substring(10, ref.length - 3) : ref.substring(10)), annotated: annotated });
				} else if (ref.startsWith('refs/remotes/')) {
					if (!hideRemotePatterns.some((pattern) => ref.startsWith(pattern)) && (showRemoteHeads || !ref.endsWith('/HEAD'))) {
						refData.remotes.push({ hash: hash, name: ref.substring(13) });
					}
				} else if (ref === 'HEAD') {
					refData.head = hash;
				}
			}
			return refData;
		});
	}

	/**
	 * Get all of the remotes that contain the specified commit hash.
	 * @param repo The path of the repository.
	 * @param commitHash The commit hash to test.
	 * @param knownRemotes The list of known remotes to check for.
	 * @returns A promise resolving to a list of remote names.
	 */
	private getRemotesContainingCommit(repo: string, commitHash: string, knownRemotes: string[]) {
		return this.spawnGit(['branch', '-r', '--no-color', '--contains=' + commitHash], repo, (stdout) => {
			// Get the names of all known remote branches that contain commitHash
			const branchNames = stdout.split(EOL_REGEX)
				.filter((line) => line.length > 2)
				.map((line) => line.substring(2).split(' -> ')[0])
				.filter((branchName) => !INVALID_BRANCH_REGEXP.test(branchName));

			// Get all the remotes that are the prefix of at least one remote branch name
			return knownRemotes.filter((knownRemote) => {
				const knownRemotePrefix = knownRemote + '/';
				return branchNames.some((branchName) => branchName.startsWith(knownRemotePrefix));
			});
		});
	}

	/**
	 * Get the stashes in a repository.
	 * @param repo The path of the repository.
	 * @returns An array of stashes.
	 */
	private getStashes(repo: string) {
		return this.spawnGit(['reflog', '--format=' + this.gitFormatStash, 'refs/stash', '--'], repo, (stdout) => {
			// Records are only split on LF, as subjects can contain a raw CR character
			let lines = stdout.split(LF_REGEX);
			let stashes: GitStash[] = [];
			for (let i = 0; i < lines.length - 1; i++) {
				let line = lines[i].split(GIT_LOG_SEPARATOR);
				if (line.length !== 7 || line[1] === '') continue;
				let parentHashes = line[1].split(' ');
				stashes.push({
					hash: line[0],
					baseHash: parentHashes[0],
					untrackedFilesHash: parentHashes.length === 3 ? parentHashes[2] : null,
					selector: line[2],
					author: line[3],
					email: line[4],
					date: parseInt(line[5]),
					message: line[6]
				});
			}
			return stashes;
		}).catch(() => <GitStash[]>[]);
	}

	/**
	 * Get the upstream (remote-tracking) branch of each local branch in a repository, and how many commits each local branch is ahead / behind its upstream.
	 * @param repo The path of the repository.
	 * @returns The upstream of each local branch that has one (an empty object if they couldn't be read).
	 */
	private getUpstreams(repo: string) {
		return this.spawnGit(['for-each-ref', '--format=%(refname)' + GIT_LOG_SEPARATOR + '%(upstream:short)' + GIT_LOG_SEPARATOR + '%(upstream:track)', 'refs/heads'], repo, (stdout) => {
			const upstreams: { [branchName: string]: GitBranchUpstream } = {};
			stdout.split(LF_REGEX).forEach((line) => {
				const fields = line.split(GIT_LOG_SEPARATOR);
				if (fields.length !== 3 || !fields[0].startsWith('refs/heads/') || fields[1] === '') return;
				const ahead = fields[2].match(/ahead (\d+)/), behind = fields[2].match(/behind (\d+)/);
				upstreams[fields[0].substring(11)] = {
					name: fields[1],
					ahead: ahead !== null ? parseInt(ahead[1]) : 0,
					behind: behind !== null ? parseInt(behind[1]) : 0,
					gone: fields[2] === '[gone]'
				};
			});
			return <GitBranchUpstreams>upstreams;
		}).catch(() => <GitBranchUpstreams>{});
	}

	/**
	 * Get the names of the remotes of a repository.
	 * @param repo The path of the repository.
	 * @returns An array of remote names.
	 */
	private getRemotes(repo: string) {
		return this.spawnGit(['remote'], repo, (stdout) => {
			let lines = stdout.split(EOL_REGEX);
			lines.pop();
			return lines;
		});
	}

	/**
	 * Get the signature of a signed tag.
	 * @param repo The path of the repository.
	 * @param ref The reference identifying the tag.
	 * @returns A Promise resolving to the signature.
	 */
	private getTagSignature(repo: string, ref: string): Promise<GitSignature> {
		return this._spawnGit(['verify-tag', '--raw', ref], repo, (stdout, stderr) => stderr || stdout.toString(), true).then((output) => {
			const records = output.split(EOL_REGEX)
				.filter((line) => line.startsWith('[GNUPG:] '))
				.map((line) => line.split(' '));

			let signature: Writeable<GitSignature> | null = null, trustLevel: string | null = null, parsingDetails: GpgStatusCodeParsingDetails | undefined;
			for (let i = 0; i < records.length; i++) {
				parsingDetails = GPG_STATUS_CODE_PARSING_DETAILS[records[i][1]];
				if (parsingDetails) {
					if (signature !== null) {
						throw new Error('Multiple Signatures Exist: As Git currently doesn\'t support them, nor does Git Map (for consistency).');
					} else {
						signature = {
							status: parsingDetails.status,
							key: records[i][2],
							signer: parsingDetails.uid ? records[i].slice(3).join(' ') : '' // When parsingDetails.uid === TRUE, the signer is the rest of the record (so join the remaining arguments)
						};
					}
				} else if (records[i][1].startsWith('TRUST_')) {
					trustLevel = records[i][1];
				}
			}

			if (signature !== null && signature.status === GitSignatureStatus.GoodAndValid && (trustLevel === 'TRUST_UNDEFINED' || trustLevel === 'TRUST_NEVER')) {
				signature.status = GitSignatureStatus.GoodWithUnknownValidity;
			}

			if (signature !== null) {
				return signature;
			} else {
				throw new Error('No Signature could be parsed.');
			}
		}).catch(() => ({
			status: GitSignatureStatus.CannotBeChecked,
			key: '',
			signer: ''
		}));
	}

	/**
	 * Get the number of uncommitted changes in a repository.
	 * @param repo The path of the repository.
	 * @returns The number of uncommitted changes.
	 */
	private getUncommittedChanges(repo: string) {
		return this.spawnGit(['status', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain'], repo, (stdout) => {
			const numLines = stdout.split(EOL_REGEX).length;
			return numLines > 1 ? numLines - 1 : 0;
		});
	}

	/**
	 * Get the untracked and deleted files that are not staged or committed.
	 * @param repo The path of the repository.
	 * @returns The untracked and deleted files.
	 */
	private getStatus(repo: string) {
		return this.spawnGit(['status', '-s', '--untracked-files=' + (getConfig().showUntrackedFiles ? 'all' : 'no'), '--porcelain', '-z'], repo, (stdout) => {
			let output = stdout.split('\0'), i = 0;
			let status: GitStatusFiles = { deleted: [], untracked: [] };
			let path = '', c1 = '', c2 = '';
			while (i < output.length && output[i] !== '') {
				if (output[i].length < 4) break;
				path = output[i].substring(3);
				c1 = output[i].substring(0, 1);
				c2 = output[i].substring(1, 2);
				if (c1 === 'D' || c2 === 'D') status.deleted.push(path);
				else if (c1 === '?' || c2 === '?') status.untracked.push(path);

				if (c1 === 'R' || c2 === 'R' || c1 === 'C' || c2 === 'C') {
					// Renames or copies
					i += 2;
				} else {
					i += 1;
				}
			}
			return status;
		});
	}


	/* Private Utils */

	/**
	 * Check if there are staged changes that resulted from a squash merge, and if so, commit them.
	 * @param repo The path of the repository.
	 * @param obj The object being squash merged into the current branch.
	 * @param actionOn Is the merge on a branch, remote-tracking branch or commit.
	 * @param squashMessageFormat The format to be used in the commit message of the squash.
	 * @returns The ErrorInfo from the executed command.
	 */
	private commitSquashIfStagedChangesExist(repo: string, obj: string, actionOn: MergeActionOn, squashMessageFormat: SquashMessageFormat, signCommits: boolean): Promise<ErrorInfo> {
		return this.areStagedChanges(repo).then((changes) => {
			if (changes) {
				const args = ['commit'];
				if (signCommits) {
					args.push('-S');
				}
				if (squashMessageFormat === SquashMessageFormat.Default) {
					args.push('-m', 'Merge ' + actionOn.toLowerCase() + ' \'' + obj + '\'');
				} else {
					args.push('--no-edit');
				}
				return this.runGitCommand(args, repo);
			} else {
				return null;
			}
		});
	}

	/**
	 * Get the diff between two revisions.
	 * @param repo The path of the repository.
	 * @param fromHash The revision the diff is from.
	 * @param toHash The revision the diff is to.
	 * @param arg Sets the data reported from the diff.
	 * @param filter The types of file changes to retrieve.
	 * @returns The diff output.
	 */
	private execDiff(repo: string, fromHash: string, toHash: string, arg: '--numstat' | '--name-status', filter: string) {
		let args: string[];
		if (fromHash === toHash) {
			args = ['diff-tree', arg, '-r', '--root', '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
		} else {
			args = ['diff', arg, '--find-renames', '--diff-filter=' + filter, '-z', fromHash];
			if (toHash !== '') args.push(toHash);
		}

		return this.spawnGit(args, repo, (stdout) => {
			let lines = stdout.split('\0');
			if (fromHash === toHash) lines.shift();
			return lines;
		});
	}

	/* Interactive Rebase & Operations in Progress */

	/**
	 * Get the commits that an interactive rebase of the current branch on a base rebases (the commits on the current branch since it
	 * diverged from the base, except merge commits).
	 * @param repo The path of the repository.
	 * @param base The commit or branch the current branch is rebased on.
	 * @returns The commits (oldest first), and the ErrorInfo of getting them.
	 */
	public getRebaseCommits(repo: string, base: string): Promise<{ commits: GitRebaseCommit[], error: ErrorInfo }> {
		return this.resolveCommitHash(repo, base).then((baseHash) => this.spawnGit(['-c', 'log.showSignature=false', 'log', '--reverse', '--no-merges', '--format=' + GIT_LOG_SEPARATOR + '%H' + GIT_LOG_SEPARATOR + '%an' + GIT_LOG_SEPARATOR + '%at' + GIT_LOG_SEPARATOR + '%B', baseHash + '..HEAD', '--'], repo, (stdout) => {
			const commits: GitRebaseCommit[] = [];
			const records = stdout.split(GIT_LOG_SEPARATOR);
			// Each commit is: "", hash, author, date, message (the message can contain new lines)
			for (let i = 1; i + 3 < records.length; i += 4) {
				const message = records[i + 3].replace(/\s+$/, '');
				commits.push({ hash: records[i], author: records[i + 1], date: parseInt(records[i + 2]), message: message, subject: message.split(/\r?\n/)[0] });
			}
			return { commits: commits, error: null };
		})).catch((errorMessage: string) => ({ commits: [], error: errorMessage }));
	}

	/**
	 * Rebase the current branch of a repository interactively, as chosen in the Rebase Editor of the Git Map View: the commits are rebased
	 * in the order of the todo list (picked, reworded with a new message, squashed or fixed up into the previous commit, or dropped). No
	 * editor is opened by Git: the todo list is written by the sequence editor, and the messages of squashed commits are combined.
	 * @param repo The path of the repository.
	 * @param base The commit or branch the current branch is rebased on.
	 * @param todo How each commit is rebased.
	 * @returns The ErrorInfo of the rebase (e.g. if it stopped because of conflicts, in which case the rebase is in progress).
	 */
	public rebaseInteractive(repo: string, base: string, todo: ReadonlyArray<GitRebaseTodoItem>): Promise<ErrorInfo> {
		// The base is resolved to a commit hash, so that the branch name is never included in the commands run by the shell (see #940)
		return this.resolveCommitHash(repo, base).then((baseHash) => {
			const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'git-map-rebase-')), lines: string[] = [];
			(this.rebaseDirectories[repo] = this.rebaseDirectories[repo] || []).push(directory);
			todo.forEach((item, index) => {
				if (!/^[0-9a-f]{7,64}$/.test(item.hash)) throw new Error('Invalid commit hash: ' + item.hash);
				lines.push((item.action === 'reword' ? 'pick' : item.action) + ' ' + item.hash);
				if (item.action === 'reword' && item.message !== null) {
					// The new message is read from a file, so that it's never included in the command run by the shell
					const messageFile = path.join(directory, 'message-' + index + '.txt').replace(/\\/g, '/');
					fs.writeFileSync(messageFile, item.message);
					lines.push('exec git commit --amend --allow-empty --cleanup=strip -F ' + quoteForShell(messageFile));
				}
			});
			const todoFile = path.join(directory, 'git-rebase-todo').replace(/\\/g, '/');
			fs.writeFileSync(todoFile, lines.join('\n') + '\n');
			const args = ['rebase', '--interactive'];
			if (getConfig().signCommits) args.push('-S');
			args.push(baseHash);
			// The sequence editor replaces the todo list written by Git with the chosen one (Git runs it with sh, including on Windows), and
			// the editor ":" isn't run by Git (so the combined messages of squashed commits are used)
			return this._spawnGit(args, repo, () => null, false, null, { GIT_SEQUENCE_EDITOR: 'cp ' + quoteForShell(todoFile), GIT_EDITOR: ':' });
		}).catch((errorMessage: string | Error) => errorMessage instanceof Error ? errorMessage.message : errorMessage).then(async (error) => {
			await this.deleteRebaseDirectories(repo);
			return error;
		});
	}

	/**
	 * Delete the temporary directories of the interactive rebases that were run in a repository, unless a rebase is still in progress
	 * (e.g. it stopped because of conflicts), as it uses the files in them until it finishes.
	 * @param repo The path of the repository.
	 */
	private async deleteRebaseDirectories(repo: string) {
		const directories = this.rebaseDirectories[repo];
		if (typeof directories === 'undefined' || await this.getOperationInProgress(repo).catch(() => null) === 'rebase') return;
		delete this.rebaseDirectories[repo];
		directories.forEach((directory) => fs.rm(directory, { recursive: true, force: true }, () => { }));
	}

	/**
	 * Get the operation that's in progress in a repository (e.g. a rebase or merge that stopped because of conflicts).
	 * @param repo The path of the repository.
	 * @returns The operation, or NULL if no operation is in progress.
	 */
	public async getOperationInProgress(repo: string): Promise<GitOperation | null> {
		const operations: [string, GitOperation][] = [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']];
		for (const [file, operation] of operations) {
			const gitPath = await this.spawnGit(['rev-parse', '--git-path', file], repo, (stdout) => stdout.trim()).catch(() => '');
			if (gitPath !== '' && fs.existsSync(path.resolve(repo, gitPath))) return operation;
		}
		return null;
	}

	/**
	 * Continue, skip or abort an operation that's in progress in a repository. Continuing doesn't open an editor (the prepared commit
	 * message is used).
	 * @param repo The path of the repository.
	 * @param operation The operation.
	 * @param action The action.
	 * @returns The ErrorInfo from the executed command.
	 */
	public controlOperation(repo: string, operation: GitOperation, action: 'continue' | 'skip' | 'abort') {
		const args = operation === 'merge' && action === 'continue' ? ['commit', '--no-edit'] : [operation, '--' + action];
		return this._spawnGit(args, repo, () => null, false, null, { GIT_EDITOR: ':' }).catch((errorMessage: string) => errorMessage).then(async (error) => {
			await this.deleteRebaseDirectories(repo);
			return error;
		});
	}


	/* Worktrees */

	/**
	 * Get the worktrees of a repository.
	 * @param repo The path of the repository (or one of its worktrees).
	 * @returns The worktrees, and the ErrorInfo of getting them.
	 */
	public getWorktrees(repo: string): Promise<{ worktrees: GitWorktree[], error: ErrorInfo }> {
		return this.spawnGit(['worktree', 'list', '--porcelain'], repo, (stdout) => {
			const current = getPathFromStr(path.resolve(repo)), worktrees: GitWorktree[] = [];
			// Each worktree is a block of lines ("worktree <path>", "HEAD <hash>", "branch <ref>" or "detached", "locked", "prunable", "bare")
			stdout.split(/\r?\n\r?\n/).forEach((block) => {
				const lines = block.split(/\r?\n/).filter((line) => line !== ''), attribute = (name: string) => {
					const line = lines.find((line) => line === name || line.startsWith(name + ' '));
					return typeof line === 'string' ? line.substring(name.length + 1) : null;
				};
				const worktreePath = attribute('worktree');
				if (worktreePath === null || attribute('bare') !== null) return;
				const branch = attribute('branch'), normalisedPath = getPathFromStr(path.resolve(worktreePath));
				worktrees.push({
					path: normalisedPath,
					head: attribute('HEAD'),
					branch: branch !== null ? branch.replace(/^refs\/heads\//, '') : null,
					isMain: worktrees.length === 0,
					isCurrent: normalisedPath === current,
					locked: attribute('locked') !== null,
					prunable: attribute('prunable') !== null
				});
			});
			return { worktrees: worktrees, error: null };
		}).catch((errorMessage: string) => ({ worktrees: [], error: errorMessage }));
	}

	/**
	 * Add a worktree to a repository.
	 * @param repo The path of the repository.
	 * @param worktreePath The path of the new worktree.
	 * @param ref The branch to check out in the worktree, or the commit to create it at (with a detached HEAD, unless `newBranch` is given).
	 * @param newBranch The name of a new branch to create at `ref` (and check out in the worktree), or NULL.
	 * @returns The ErrorInfo from the executed command.
	 */
	public addWorktree(repo: string, worktreePath: string, ref: string, newBranch: string | null) {
		return this.runGitCommand(['worktree', 'add'].concat(newBranch !== null ? ['-b', newBranch] : [], ['--', worktreePath, ref]), repo);
	}

	/**
	 * Remove a worktree of a repository.
	 * @param repo The path of the repository.
	 * @param worktreePath The path of the worktree.
	 * @param force Remove the worktree even if it has uncommitted changes or untracked files.
	 * @returns The ErrorInfo from the executed command.
	 */
	public removeWorktree(repo: string, worktreePath: string, force: boolean) {
		return this.runGitCommand(['worktree', 'remove'].concat(force ? ['--force'] : [], ['--', worktreePath]), repo);
	}

	/**
	 * Prune the worktrees of a repository whose directories no longer exist.
	 * @param repo The path of the repository.
	 * @returns The ErrorInfo from the executed command.
	 */
	public pruneWorktrees(repo: string) {
		return this.runGitCommand(['worktree', 'prune'], repo);
	}

	/**
	 * Run a Git command, resolving with its output (or rejecting with its error message). Used to inspect & restore the state of a
	 * repository when an action is undone (see UndoManager).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The output of the command.
	 */
	public execGit(args: string[], repo: string): Promise<string> {
		return this.spawnGit(args, repo, (stdout) => stdout);
	}

	/**
	 * Spawn Git, returning its process. Used for long-running commands whose input & output are streamed, and which can be cancelled
	 * (see HistoryRewriter).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param env Additional environment variables.
	 * @returns The process.
	 * @throws If there isn't a Git executable.
	 */
	public spawnGitProcess(args: string[], repo: string, env: { [name: string]: string } = {}) {
		if (this.gitExecutable === null) throw new Error(UNABLE_TO_FIND_GIT_MSG);
		this.logger.logCmd('git', args);
		return cp.spawn(this.gitExecutable.path, args, {
			cwd: repo,
			env: Object.assign({}, process.env, this.askpassEnv, env)
		});
	}

	/**
	 * Get the version of the Git executable.
	 * @returns The version, or NULL if there isn't a Git executable.
	 */
	public getGitVersion() {
		return this.gitExecutable !== null ? this.gitExecutable.version : null;
	}

	/**
	 * Run a Git command (typically for a Git Map View action).
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @returns The returned ErrorInfo (suitable for being sent to the Git Map View).
	 */
	private runGitCommand(args: string[], repo: string): Promise<ErrorInfo> {
		return this._spawnGit(args, repo, () => null).catch((errorMessage: string) => errorMessage);
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a string.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout`.
	 */
	private spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: string): T }) {
		return this._spawnGit(args, repo, (stdout) => resolveValue(stdout.toString()));
	}

	/**
	 * Spawn Git, with the return value resolved from `stdout` as a buffer.
	 * @param args The arguments to pass to Git.
	 * @param repo The repository to run the command in.
	 * @param resolveValue A callback invoked to resolve the data from `stdout` and `stderr`.
	 * @param ignoreExitCode Ignore the exit code returned by Git (default: `FALSE`).
	 */
	private _spawnGit<T>(args: string[], repo: string, resolveValue: { (stdout: Buffer, stderr: string): T }, ignoreExitCode: boolean = false, input: string | null = null, env: { [name: string]: string } | null = null) {
		return new Promise<T>((resolve, reject) => {
			if (this.gitExecutable === null) {
				return reject(UNABLE_TO_FIND_GIT_MSG);
			}

			const gitProcess = cp.spawn(this.gitExecutable.path, args, {
				cwd: repo,
				env: Object.assign({}, process.env, this.askpassEnv, env)
			});
			if (input !== null && gitProcess.stdin) {
				// The input is written to the standard input of Git (if Git exits before reading it, the error is ignored)
				gitProcess.stdin.on('error', () => { });
				gitProcess.stdin.end(input);
			}
			resolveSpawnOutput(gitProcess).then((values) => {
				const status = values[0], stdout = values[1], stderr = values[2];
				if (status.code === 0 || ignoreExitCode) {
					resolve(resolveValue(stdout, stderr));
				} else {
					reject(getErrorMessage(status.error, stdout, stderr));
				}
			});

			this.logger.logCmd('git', args);
		});
	}
}


/**
 * Quote a path that's included in a command run by a shell (in double quotes, escaping the characters that are special within them).
 * @param filePath The path.
 * @returns The quoted path.
 */
function quoteForShell(filePath: string) {
	return '"' + filePath.replace(/["$`\\]/g, '\\$&') + '"';
}

/**
 * Generates the file changes from the diff output and status information.
 * @param nameStatusRecords The `--name-status` records.
 * @param numStatRecords The `--numstat` records.
 * @param status The deleted and untracked files.
 * @returns An array of file changes.
 */
function generateFileChanges(nameStatusRecords: DiffNameStatusRecord[], numStatRecords: DiffNumStatRecord[], status: GitStatusFiles | null) {
	let fileChanges: Writeable<GitFileChange>[] = [], fileLookup: { [file: string]: number } = {}, i = 0;

	for (i = 0; i < nameStatusRecords.length; i++) {
		fileLookup[nameStatusRecords[i].newFilePath] = fileChanges.length;
		fileChanges.push({ oldFilePath: nameStatusRecords[i].oldFilePath, newFilePath: nameStatusRecords[i].newFilePath, type: nameStatusRecords[i].type, additions: null, deletions: null });
	}

	if (status !== null) {
		let filePath;
		for (i = 0; i < status.deleted.length; i++) {
			filePath = getPathFromStr(status.deleted[i]);
			if (typeof fileLookup[filePath] === 'number') {
				fileChanges[fileLookup[filePath]].type = GitFileStatus.Deleted;
			} else {
				fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Deleted, additions: null, deletions: null });
			}
		}
		for (i = 0; i < status.untracked.length; i++) {
			filePath = getPathFromStr(status.untracked[i]);
			fileChanges.push({ oldFilePath: filePath, newFilePath: filePath, type: GitFileStatus.Untracked, additions: null, deletions: null });
		}
	}

	for (i = 0; i < numStatRecords.length; i++) {
		if (typeof fileLookup[numStatRecords[i].filePath] === 'number') {
			fileChanges[fileLookup[numStatRecords[i].filePath]].additions = numStatRecords[i].additions;
			fileChanges[fileLookup[numStatRecords[i].filePath]].deletions = numStatRecords[i].deletions;
		}
	}

	return fileChanges;
}

/**
 * Get the specified config value from a set of key-value config pairs.
 * @param configs A set key-value pairs of Git configuration records.
 * @param key The key of the desired config.
 * @returns The value for `key` if it exists, otherwise NULL.
 */
function getConfigValue(configs: GitConfigSet, key: string) {
	return typeof configs[key] !== 'undefined' ? configs[key] : null;
}

/**
 * Produce a suitable error message from a spawned Git command that terminated with an erroneous status code.
 * @param error An error generated by JavaScript (optional).
 * @param stdoutBuffer A buffer containing the data outputted to `stdout`.
 * @param stderr A string containing the data outputted to `stderr`.
 * @returns A suitable error message.
 */
function getErrorMessage(error: Error | null, stdoutBuffer: Buffer, stderr: string) {
	let stdout = stdoutBuffer.toString(), lines: string[];
	if (stdout !== '' || stderr !== '') {
		lines = (stderr + stdout).split(EOL_REGEX);
		lines.pop();
	} else if (error) {
		lines = error.message.split(EOL_REGEX);
	} else {
		lines = [];
	}
	return lines.join('\n');
}

/**
 * Remove trailing blank lines from an array of lines.
 * @param lines The array of lines.
 * @returns The same array.
 */
function removeTrailingBlankLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Get all the unique strings from an array of strings.
 * @param items The array of strings with duplicates.
 * @returns An array of unique strings.
 */
function unique(items: ReadonlyArray<string>) {
	const uniqueItems: { [item: string]: true } = {};
	items.forEach((item) => uniqueItems[item] = true);
	return Object.keys(uniqueItems);
}


/* Types */

interface DiffNameStatusRecord {
	type: GitFileStatus;
	oldFilePath: string;
	newFilePath: string;
}

interface DiffNumStatRecord {
	filePath: string;
	additions: number;
	deletions: number;
}

interface GitBranchData {
	branches: string[];
	head: string | null;
	error: ErrorInfo;
}

interface GitCommitRecord {
	hash: string;
	parents: string[];
	author: string;
	email: string;
	date: number;
	message: string;
}

/**
 * Filter commits to those in a set, rewriting the parents of each commit to its nearest ancestors in the set (so that the graph of
 * the commits stays connected).
 * @param commits The commits.
 * @param filter The hashes of the commits to keep.
 * @returns The filtered commits.
 */
function filterCommitRecords(commits: ReadonlyArray<GitCommitRecord>, filter: ReadonlySet<string>) {
	const loaded = new Set(commits.map((commit) => commit.hash)), nearestMatches: { [hash: string]: string[] } = {}, filtered: GitCommitRecord[] = [];
	const rewriteParents = (parents: ReadonlyArray<string>) => {
		const rewritten: string[] = [];
		parents.forEach((parent) => {
			// Parents that aren't loaded are kept, as the graph continues below the loaded commits
			(filter.has(parent) || !loaded.has(parent) ? [parent] : nearestMatches[parent] || []).forEach((hash) => {
				if (!rewritten.includes(hash)) rewritten.push(hash);
			});
		});
		return rewritten;
	};
	for (let i = commits.length - 1; i >= 0; i--) {
		if (filter.has(commits[i].hash)) {
			filtered.push(Object.assign({}, commits[i], { parents: rewriteParents(commits[i].parents) }));
		} else {
			nearestMatches[commits[i].hash] = rewriteParents(commits[i].parents);
		}
	}
	return filtered.reverse();
}

/**
 * Parse the path of a file in the output of `git log --numstat`, which is "old => new" (or "dir/{old => new}/file") if the file was renamed.
 * @param path The path.
 * @returns The new path, and the old path (if the file was renamed).
 */
function parseNumstatPath(path: string): { newPath: string, oldPath: string | null } {
	const braces = path.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
	if (braces !== null) {
		const join = (middle: string) => (braces[1] + middle + braces[4]).replace(/\/\//g, '/');
		return { newPath: join(braces[3]), oldPath: join(braces[2]) };
	}
	const arrow = path.indexOf(' => ');
	return arrow > -1 ? { newPath: path.substring(arrow + 4), oldPath: path.substring(0, arrow) } : { newPath: path, oldPath: null };
}

interface GitCommitData {
	commits: GitCommit[];
	head: string | null;
	tags: string[];
	moreCommitsAvailable: boolean;
	fileHistory: GitFileHistory | null;
	error: ErrorInfo;
}

export interface GitCommitDetailsData {
	commitDetails: GitCommitDetails | null;
	error: ErrorInfo;
}

interface GitCommitComparisonData {
	fileChanges: GitFileChange[];
	error: ErrorInfo;
}

type GitConfigSet = { [key: string]: string };

interface GitRef {
	hash: string;
	name: string;
}

interface GitRefTag extends GitRef {
	annotated: boolean;
}

interface GitRefData {
	head: string | null;
	heads: GitRef[];
	tags: GitRefTag[];
	remotes: GitRef[];
}

interface GitRepoInfo extends GitBranchData {
	remotes: string[];
	stashes: GitStash[];
	upstreams: GitBranchUpstreams;
}

interface GitRepoConfigData {
	config: GitRepoConfig | null;
	error: ErrorInfo;
}

interface GitStatusFiles {
	deleted: string[];
	untracked: string[];
}

interface GitTagDetailsData {
	details: GitTagDetails | null;
	error: ErrorInfo;
}

interface GpgStatusCodeParsingDetails {
	readonly status: GitSignatureStatus,
	readonly uid: boolean
}

/**
 * Parse the diff of a range of lines output by `git log -L` for a commit.
 * @param diff The diff.
 * @param filePath The current path of the file (used if the diff doesn't include the path).
 * @returns The path of the file in the commit (and before it, if it was renamed), the lines before & after the commit, and the diff of the lines.
 */
export function parseLineHistoryDiff(diff: string, filePath: string) {
	let newPath = filePath, oldPath: string | null = null, fileAdded = false, oldRange: GitLineRange | null = null, newRange: GitLineRange | null = null, inHunk = false, additions = 0, deletions = 0;
	const lines: string[] = [];
	diff.split(LF_REGEX).forEach((line) => {
		let match: RegExpMatchArray | null;
		if (line.startsWith('diff --git ')) {
			inHunk = false;
		} else if (!inHunk && line.startsWith('--- ')) {
			if (line === '--- /dev/null') fileAdded = true; else oldPath = line.substring(line.startsWith('--- a/') ? 6 : 4);
		} else if (!inHunk && line.startsWith('+++ ')) {
			if (line !== '+++ /dev/null') newPath = line.substring(line.startsWith('+++ b/') ? 6 : 4);
		} else if ((match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)) !== null) {
			// The range of the first hunk is the range of the lines (`git log -L` outputs one hunk for a range of lines)
			if (!inHunk && oldRange === null && newRange === null) {
				const oldStart = parseInt(match[1]), oldLines = typeof match[2] === 'string' ? parseInt(match[2]) : 1;
				const newStart = parseInt(match[3]), newLines = typeof match[4] === 'string' ? parseInt(match[4]) : 1;
				oldRange = oldLines > 0 ? { start: oldStart, end: oldStart + oldLines - 1 } : null;
				newRange = newLines > 0 ? { start: newStart, end: newStart + newLines - 1 } : null;
			}
			inHunk = true;
		} else if (inHunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
			if (line.startsWith('+')) additions++;
			if (line.startsWith('-')) deletions++;
			if (lines.length < MAX_LINE_HISTORY_DIFF_LINES) lines.push(line);
		}
	});
	return {
		filePath: newPath,
		oldFilePath: oldPath !== null && oldPath !== newPath ? oldPath : null,
		fileAdded: fileAdded,
		oldRange: oldRange, newRange: newRange,
		diff: lines, additions: additions, deletions: deletions
	};
}
