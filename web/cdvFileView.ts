/**
 * Implements the files changed by the commit (or commits) in the Commit Details View: the file tree or list, its view type & external
 * diff buttons, and the actions on the files (viewing their diff, opening them, marking them as reviewed, ...).
 */
class CdvFileView {
	private readonly view: GitGraphView;

	/**
	 * Construct a new CdvFileView instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Updates the state of a file in the Commit Details View.
	 * @param file The file that was affected.
	 * @param fileElem The HTML Element of the file.
	 * @param isReviewed TRUE/FALSE => Set the files reviewed state accordingly, NULL => Don't update the files reviewed state.
	 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
	 */
	private cdvUpdateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {
		const expandedCommit = this.view.expandedCommit, filesElem = getCdvFileViewElem(), filePath = file.newFilePath;
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		if (fileWasViewed) {
			expandedCommit.lastViewedFile = filePath;
			let lastViewedElem = document.getElementById('cdvLastFileViewed');
			if (lastViewedElem !== null) lastViewedElem.remove();
			lastViewedElem = document.createElement('span');
			lastViewedElem.id = 'cdvLastFileViewed';
			lastViewedElem.title = t('Last File Viewed');
			lastViewedElem.innerHTML = SVG_ICONS.eyeOpen;
			insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
		}

		if (expandedCommit.codeReview !== null) {
			if (isReviewed !== null) {
				if (isReviewed) {
					expandedCommit.codeReview.remainingFiles = expandedCommit.codeReview.remainingFiles.filter((path: string) => path !== filePath);
				} else {
					expandedCommit.codeReview.remainingFiles.push(filePath);
				}

				alterFileTreeFileReviewed(expandedCommit.fileTree, filePath, isReviewed);
				updateFileTreeHtmlFileReviewed(filesElem, expandedCommit.fileTree, filePath);
			}

			sendMessage({
				command: 'updateCodeReview',
				repo: this.view.currentRepo,
				id: expandedCommit.codeReview.id,
				remainingFiles: expandedCommit.codeReview.remainingFiles,
				lastViewedFile: expandedCommit.lastViewedFile
			});

			if (expandedCommit.codeReview.remainingFiles.length === 0) {
				expandedCommit.codeReview = null;
				this.view.renderCodeReviewBtn();
			}
		}

		this.view.saveState();
	}

	public getFileViewType() {
		return this.view.gitRepos[this.view.currentRepo].fileViewType === GG.FileViewType.Default
			? this.view.config.commitDetailsView.fileViewType
			: this.view.gitRepos[this.view.currentRepo].fileViewType;
	}

	private setFileViewType(type: GG.FileViewType) {
		this.view.gitRepos[this.view.currentRepo].fileViewType = type;
		this.view.saveRepoState();
	}

	/**
	 * Re-render the file view of the Commit Details View (if it's open), e.g. after the file icon theme has changed.
	 */
	public refreshCdvFileView() {
		if (this.view.expandedCommit !== null && this.view.expandedCommit.fileTree !== null && !this.view.expandedCommit.loading) {
			this.changeFileViewType(this.getFileViewType());
		}
	}

	public changeFileViewType(type: GG.FileViewType) {
		const expandedCommit = this.view.expandedCommit, filesElem = getCdvFileViewElem();
		if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		this.setFileViewType(type);
		const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		filesElem.innerHTML = generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED);
		this.makeCdvFileViewInteractive();
		this.renderCdvFileViewTypeBtns();
	}

	public makeCdvFileViewInteractive() {
		const getFileElemOfEventTarget = (target: EventTarget) => <HTMLElement>(<Element>target).closest('.fileTreeFileRecord');
		const getFileOfFileElem = (fileChanges: ReadonlyArray<GG.GitFileChange>, fileElem: HTMLElement) => fileChanges[parseInt(fileElem.dataset.index!)];

		const getCommitHashForFile = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => {
			const commit = this.view.commits[this.view.commitLookup[expandedCommit.commitHash]];
			if (expandedCommit.compareWithHash !== null) {
				return this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash).to;
			} else if (commit.stash !== null && file.type === GG.GitFileStatus.Untracked) {
				return commit.stash.untrackedFilesHash!;
			} else {
				return expandedCommit.commitHash;
			}
		};

		const triggerViewFileDiff = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			let commit = this.view.commits[this.view.commitLookup[expandedCommit.commitHash]], fromHash: string, toHash: string, fileStatus = file.type;
			if (expandedCommit.compareWithHash !== null) {
				// Commit Comparison
				const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
				fromHash = commitOrder.from;
				toHash = commitOrder.to;
			} else if (commit.stash !== null) {
				// Stash Commit
				if (fileStatus === GG.GitFileStatus.Untracked) {
					fromHash = commit.stash.untrackedFilesHash!;
					toHash = commit.stash.untrackedFilesHash!;
					fileStatus = GG.GitFileStatus.Added;
				} else {
					fromHash = commit.stash.baseHash;
					toHash = expandedCommit.commitHash;
				}
			} else {
				// Single Commit
				fromHash = expandedCommit.commitHash;
				toHash = expandedCommit.commitHash;
			}

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({
				command: 'viewDiff',
				repo: this.view.currentRepo,
				fromHash: fromHash,
				toHash: toHash,
				oldFilePath: file.oldFilePath,
				newFilePath: file.newFilePath,
				type: fileStatus
			});
		};

		const triggerCopyFilePath = (file: GG.GitFileChange, absolute: boolean) => {
			sendMessage({ command: 'copyFilePath', repo: this.view.currentRepo, filePath: file.newFilePath, absolute: absolute });
		};

		const triggerResetFileToRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			const commitHash = getCommitHashForFile(file, expandedCommit);
			dialog.asDangerous().showConfirmation(t('Are you sure you want to reset <b><i>{0}</i></b> to it\'s state at commit <b><i>{1}</i></b>? Any uncommitted changes made to this file will be overwritten.', escapeHtml(file.newFilePath), abbrevCommit(commitHash)), t('Yes, reset file'), () => {
				runAction({ command: 'resetFileToRevision', repo: this.view.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, t('Resetting file'));
			}, {
				type: TargetType.CommitDetailsView,
				hash: commitHash,
				elem: fileElem
			});
		};

		const triggerViewFileAtRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({ command: 'viewFileAtRevision', repo: this.view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		const triggerViewFileDiffWithWorkingFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, null, true);
			sendMessage({ command: 'viewDiffWithWorkingFile', repo: this.view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		const triggerOpenFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({ command: 'openFile', repo: this.view.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		addListenerToClass('fileTreeFolder', 'click', (e) => {
			let expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileTree === null || e.target === null) return;

			let sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFolder');
			let parent = sourceElem.parentElement!;
			parent.classList.toggle('closed');
			let isOpen = !parent.classList.contains('closed');
			const folderName = sourceElem.querySelector('.gitFolderName')!.textContent!;
			parent.children[0].children[0].innerHTML = fileIcons.getFolderIcon(folderName.substring(folderName.lastIndexOf(' / ') + 1).trim(), isOpen);
			parent.children[1].classList.toggle('hidden');
			alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), isOpen);
			this.view.saveState();
		});

		addListenerToClass('fileTreeRepo', 'click', (e) => {
			if (e.target === null) return;
			this.view.loadRepos(this.view.gitRepos, null, {
				repo: decodeURIComponent((<HTMLElement>(<Element>e.target).closest('.fileTreeRepo')).dataset.path!)
			});
		});

		addListenerToClass('fileTreeFile', 'click', (e) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFile'), fileElem = getFileElemOfEventTarget(e.target);
			if (!sourceElem.classList.contains('gitDiffPossible')) return;
			triggerViewFileDiff(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('copyGitFile', 'click', (e) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerCopyFilePath(getFileOfFileElem(expandedCommit.fileChanges, fileElem), true);
		});

		addListenerToClass('viewGitFileAtRevision', 'click', (e) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerViewFileAtRevision(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('openGitFile', 'click', (e) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerOpenFile(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('fileTreeFileRecord', 'contextmenu', (e: Event) => {
			handledEvent(e);
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;
			const fileElem = getFileElemOfEventTarget(e.target);
			const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);
			const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
			const isUncommitted = commitOrder.to === UNCOMMITTED;

			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
			expandedCommit.contextMenuOpen.fileView = parseInt(fileElem.dataset.index!);

			const target: ContextMenuTarget & CommitTarget = {
				type: TargetType.CommitDetailsView,
				hash: expandedCommit.commitHash,
				index: this.view.commitLookup[expandedCommit.commitHash],
				elem: fileElem
			};
			const diffPossible = file.type === GG.GitFileStatus.Untracked || (file.additions !== null && file.deletions !== null);
			const fileExistsAtThisRevision = file.type !== GG.GitFileStatus.Deleted && !isUncommitted;
			const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && diffPossible;
			const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);
			const visibility = this.view.config.contextMenuActionsVisibility.commitDetailsViewFile;

			contextMenu.show([
				[
					{
						title: t('View Diff'),
						visible: visibility.viewDiff && diffPossible,
						onClick: () => triggerViewFileDiff(file, fileElem)
					},
					{
						title: t('View File at this Revision'),
						visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileAtRevision(file, fileElem)
					},
					{
						title: t('View Diff with Working File'),
						visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)
					},
					{
						title: t('Open File'),
						visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,
						onClick: () => triggerOpenFile(file, fileElem)
					},
					{
						title: t('View File History'),
						visible: file.type !== GG.GitFileStatus.Untracked && this.view.fileHistory !== file.newFilePath,
						onClick: () => this.view.setFileHistory(file.newFilePath)
					}
				],
				[
					{
						title: t('Mark as Reviewed'),
						visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, true, false)
					},
					{
						title: t('Mark as Not Reviewed'),
						visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, false, false)
					}
				],
				[
					{
						title: t('Reset File to this Revision') + ELLIPSIS,
						visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,
						onClick: () => triggerResetFileToRevision(file, fileElem)
					},
					{
						// The extension shows what removing the file will do, and asks for confirmation (also removing its previous name, if it was renamed)
						title: t('Remove File from History') + ELLIPSIS,
						visible: visibility.removeFromHistory && file.type !== GG.GitFileStatus.Untracked,
						onClick: () => sendMessage({ command: 'removeFilesFromHistory', repo: this.view.currentRepo, filePaths: file.oldFilePath !== file.newFilePath ? [file.newFilePath, file.oldFilePath] : [file.newFilePath] })
					}
				],
				[
					{
						title: t('Copy Absolute File Path to Clipboard'),
						visible: visibility.copyAbsoluteFilePath,
						onClick: () => triggerCopyFilePath(file, true)
					},
					{
						title: t('Copy Relative File Path to Clipboard'),
						visible: visibility.copyRelativeFilePath,
						onClick: () => triggerCopyFilePath(file, false)
					}
				]
			], false, target, <MouseEvent>e, this.view.isCdvDocked() ? document.body : this.view.viewElem, () => {
				expandedCommit.contextMenuOpen.fileView = -1;
			});
		});
	}

	public renderCdvFileViewTypeBtns() {
		if (this.view.expandedCommit === null) return;
		let treeBtnElem = document.getElementById('cdvFileViewTypeTree'), listBtnElem = document.getElementById('cdvFileViewTypeList');
		if (treeBtnElem === null || listBtnElem === null) return;

		let listView = this.getFileViewType() === GG.FileViewType.List;
		alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
		alterClass(listBtnElem, CLASS_ACTIVE, listView);
	}

	public renderCdvExternalDiffBtn() {
		if (this.view.expandedCommit === null) return;
		const externalDiffBtnElem = document.getElementById('cdvExternalDiff');
		if (externalDiffBtnElem === null) return;

		alterClass(externalDiffBtnElem, CLASS_ENABLED, this.view.gitConfig !== null && (this.view.gitConfig.diffTool !== null || this.view.gitConfig.guiDiffTool !== null));
		const toolName = this.view.gitConfig !== null
			? this.view.gitConfig.guiDiffTool !== null
				? this.view.gitConfig.guiDiffTool
				: this.view.gitConfig.diffTool
			: null;
		externalDiffBtnElem.title = (toolName !== null ? t('Open External Directory Diff with "{0}"', toolName) : t('Open External Directory Diff'));
	}
}
