import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './logger';
import { getPathFromUri } from './utils';

const FILE_CHANGE_REGEX = /(^\.git\/(config|index|HEAD|packed-refs|refs\/stash|refs\/heads\/.*|refs\/remotes\/.*|refs\/tags\/.*)$)|(^(?!\.git).*$)|(^\.git[^\/]+$)/;
const GIT_DIRECTORY_FILE_CHANGE_GLOB = '{config,index,HEAD,packed-refs,refs/**}';

/**
 * Watches a Git repository for file events.
 */
export class RepoFileWatcher {
	private readonly logger: Logger;
	private readonly repoChangeCallback: () => void;
	private repo: string | null = null;
	private fsWatcher: vscode.FileSystemWatcher | null = null;
	private gitDirectoryWatchers: vscode.FileSystemWatcher[] = [];
	private watchId: number = 0;
	private refreshTimeout: NodeJS.Timeout | null = null;
	private muted: boolean = false;
	private resumeAt: number = 0;

	/**
	 * Creates a RepoFileWatcher.
	 * @param logger The Git Map Logger instance.
	 * @param repoChangeCallback A callback to be invoked when a file event occurs in the repository.
	 */
	constructor(logger: Logger, repoChangeCallback: () => void) {
		this.logger = logger;
		this.repoChangeCallback = repoChangeCallback;
	}

	/**
	 * Start watching a repository for file events.
	 * @param repo The path of the repository to watch.
	 */
	public start(repo: string) {
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.stop();
		}

		this.repo = repo;
		// Create a File System Watcher for all events within the specified repository
		this.fsWatcher = vscode.workspace.createFileSystemWatcher(repo + '/**');
		this.fsWatcher.onDidCreate(uri => this.refresh(uri));
		this.fsWatcher.onDidChange(uri => this.refresh(uri));
		this.fsWatcher.onDidDelete(uri => this.refresh(uri));
		this.logger.log('Started watching repo: ' + repo);

		// Submodules & worktrees store their Git directory outside of the repository, so it must be watched separately
		const watchId = this.watchId;
		getExternalGitDirectories(repo).then((gitDirectories) => {
			if (watchId !== this.watchId) return; // The watcher was stopped or restarted while the Git directories were being determined
			gitDirectories.forEach((gitDirectory) => {
				const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDirectory), GIT_DIRECTORY_FILE_CHANGE_GLOB));
				watcher.onDidCreate(() => this.scheduleRefresh());
				watcher.onDidChange(() => this.scheduleRefresh());
				watcher.onDidDelete(() => this.scheduleRefresh());
				this.gitDirectoryWatchers.push(watcher);
				this.logger.log('Started watching Git directory: ' + gitDirectory);
			});
		});
	}

	/**
	 * Stop watching the repository for file events.
	 */
	public stop() {
		this.watchId++;
		if (this.fsWatcher !== null) {
			// If there is an existing File System Watcher, stop it
			this.fsWatcher.dispose();
			this.fsWatcher = null;
			this.logger.log('Stopped watching repo: ' + this.repo);
		}
		this.gitDirectoryWatchers.forEach((watcher) => watcher.dispose());
		this.gitDirectoryWatchers = [];
		if (this.refreshTimeout !== null) {
			// If a timeout is active, clear it
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = null;
		}
	}

	/**
	 * Mute file events - Used to prevent many file events from being triggered when a Git action is executed by the Git Map View.
	 */
	public mute() {
		this.muted = true;
	}

	/**
	 * Unmute file events - Used to resume normal watching after a Git action executed by the Git Map View has completed.
	 */
	public unmute() {
		this.muted = false;
		this.resumeAt = (new Date()).getTime() + 1500;
	}


	/**
	 * Handle a file event triggered by the File System Watcher.
	 * @param uri The URI of the file that the event occurred on.
	 */
	private refresh(uri: vscode.Uri) {
		if (!getPathFromUri(uri).replace(this.repo + '/', '').match(FILE_CHANGE_REGEX)) return;
		this.scheduleRefresh();
	}

	/**
	 * Schedule the repository change callback to be invoked (unless file events are muted).
	 */
	private scheduleRefresh() {
		if (this.muted) return;
		if ((new Date()).getTime() < this.resumeAt) return;

		if (this.refreshTimeout !== null) {
			clearTimeout(this.refreshTimeout);
		}
		this.refreshTimeout = setTimeout(() => {
			this.refreshTimeout = null;
			this.repoChangeCallback();
		}, 750);
	}
}

/**
 * Get the Git directories of a repository that are outside of it. This occurs when the repository's `.git` is a file referring to the Git directory (e.g. for submodules & worktrees).
 * @param repo The path of the repository.
 * @returns A promise resolving to the external Git directories (the repository's Git directory, and the common Git directory of a worktree).
 */
function getExternalGitDirectories(repo: string) {
	return new Promise<string[]>((resolve) => {
		fs.readFile(path.join(repo, '.git'), 'utf8', (err, contents) => {
			const match = err ? null : contents.match(/^gitdir:\s*(.+?)\s*$/m);
			if (match === null) {
				resolve([]); // The repository's .git is a directory (or doesn't exist)
				return;
			}

			const gitDirectory = path.resolve(repo, match[1]);
			fs.readFile(path.join(gitDirectory, 'commondir'), 'utf8', (err, contents) => {
				const commonDirectory = err ? null : path.resolve(gitDirectory, contents.trim());
				resolve(commonDirectory !== null && commonDirectory !== gitDirectory ? [gitDirectory, commonDirectory] : [gitDirectory]);
			});
		});
	});
}
