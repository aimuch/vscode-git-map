/**
 * Implements the files changed by the commit (or commits) in the Commit Details View: the file tree or list, its view type & external
 * diff buttons, and the actions on the files (viewing their diff, opening them, marking them as reviewed, ...).
 */
class CdvFileView {
	private readonly view: GitGraphView;
	private selectedFileIndices: Set<number> = new Set();
	private selectionAnchor: number | null = null;

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
			alterClassOfCollection(<HTMLCollectionOf<HTMLElement>>filesElem.getElementsByClassName(CLASS_LAST_VIEWED_FILE), CLASS_LAST_VIEWED_FILE, false);
			fileElem.classList.add(CLASS_LAST_VIEWED_FILE);
			let lastViewedElem = document.getElementById('cdvLastFileViewed');
			if (lastViewedElem !== null) lastViewedElem.remove();
			lastViewedElem = document.createElement('span');
			lastViewedElem.id = 'cdvLastFileViewed';
			lastViewedElem.title = t('Last File Viewed');
			lastViewedElem.innerHTML = SVG_ICONS.eyeOpen;
			insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
			const scrollElem = document.getElementById('cdvFiles') || document.getElementById('cdvContent');
			if (scrollElem !== null) {
				expandedCommit.scrollTop.fileView = scrollElem.scrollTop;
			}
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

		if (fileWasViewed) {
			this.view.saveStateNow();
		} else {
			this.view.saveState();
		}
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
			this.changeFileViewType(this.getFileViewType(), true);
		}
	}

	public changeFileViewType(type: GG.FileViewType, force: boolean = false) {
		if (!force && type === this.getFileViewType()) return;
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
		this.selectedFileIndices.clear();
		this.selectionAnchor = null;
		const getFileElemOfEventTarget = (target: EventTarget) => <HTMLElement>(<Element>target).closest('.fileTreeFileRecord');
		const getFileOfFileElem = (fileChanges: ReadonlyArray<GG.GitFileChange>, fileElem: HTMLElement) => fileChanges[parseInt(fileElem.dataset.index!)];

		const updateBulkSelectionUi = () => {
			const filesElem = getCdvFileViewElem(), expandedCommit = this.view.expandedCommit;
			if (filesElem === null || expandedCommit === null || expandedCommit.fileChanges === null) return;
			filesElem.querySelectorAll<HTMLElement>('.fileTreeFileRecord').forEach((rec) => {
				const idx = parseInt(rec.dataset.index!);
				alterClass(rec, 'cdvFileMultiSelected', this.selectedFileIndices.has(idx));
			});
			let bar = document.getElementById('cdvFileBulkBar');
			if (this.selectedFileIndices.size < 2) {
				if (bar !== null) bar.remove();
				return;
			}
			if (bar === null) {
				bar = document.createElement('div');
				bar.id = 'cdvFileBulkBar';
				bar.className = 'cdvFileBulkBar';
				filesElem.insertBefore(bar, filesElem.firstChild);
			}
			const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
			const isUncommitted = commitOrder.to === UNCOMMITTED;
			const count = this.selectedFileIndices.size;
			bar.innerHTML =
				'<span class="cdvBulkCount">' + t('{0} files selected', String(count)) + '</span>' +
				'<button type="button" class="cdvMiniBtn primary" data-bulk="openDiffs">' + t('Open Diffs') + '</button>' +
				(isUncommitted
					? '<button type="button" class="cdvMiniBtn" data-bulk="stage">' + t('Stage') + '</button>' +
						'<button type="button" class="cdvMiniBtn" data-bulk="unstage">' + t('Unstage') + '</button>' +
						'<button type="button" class="cdvMiniBtn danger" data-bulk="discard">' + t('Discard') + ELLIPSIS + '</button>'
					: '<button type="button" class="cdvMiniBtn" data-bulk="restore">' + t('Restore') + ELLIPSIS + '</button>') +
				'<button type="button" class="cdvMiniBtn" data-bulk="copyPaths">' + t('Copy Paths') + '</button>' +
				'<button type="button" class="cdvMiniBtn" data-bulk="clear">' + t('Clear') + '</button>';

			bar.onclick = (ev: MouseEvent) => {
				const btn = ev.target instanceof Element ? <HTMLElement | null>ev.target.closest('[data-bulk]') : null;
				if (btn === null || this.view.expandedCommit === null || this.view.expandedCommit.fileChanges === null) return;
				const files = Array.from(this.selectedFileIndices)
					.sort((a, b) => a - b)
					.map((idx) => this.view.expandedCommit!.fileChanges![idx])
					.filter((f): f is GG.GitFileChange => typeof f !== 'undefined');
				const paths = files.map((f) => f.newFilePath);
				switch (btn.dataset.bulk) {
					case 'clear':
						this.selectedFileIndices.clear();
						this.selectionAnchor = null;
						updateBulkSelectionUi();
						break;
					case 'copyPaths':
						sendMessage({ command: 'copyToClipboard', type: t('File Paths'), data: paths.join('\n') });
						break;
					case 'openDiffs': {
						const ord = this.view.getCommitOrder(this.view.expandedCommit.commitHash, this.view.expandedCommit.compareWithHash === null ? this.view.expandedCommit.commitHash : this.view.expandedCommit.compareWithHash);
						const fromH = this.view.expandedCommit.compareWithHash !== null ? ord.from : (this.view.expandedCommit.commitHash === UNCOMMITTED ? 'HEAD' : this.view.expandedCommit.commitHash + '^');
						const toH = this.view.expandedCommit.compareWithHash !== null ? ord.to : this.view.expandedCommit.commitHash;
						sendMessage({
							command: 'openAllChanges',
							repo: this.view.currentRepo,
							fromHash: fromH,
							toHash: toH,
							title: t('{0} Selected Files', String(files.length)),
							fileChanges: files
						});
						break;
					}
					case 'stage':
						sendMessage({ command: 'stageFiles', repo: this.view.currentRepo, paths: paths });
						this.selectedFileIndices.clear();
						updateBulkSelectionUi();
						break;
					case 'unstage':
						sendMessage({ command: 'unstageFiles', repo: this.view.currentRepo, paths: paths });
						this.selectedFileIndices.clear();
						updateBulkSelectionUi();
						break;
					case 'discard': {
						const trackedPaths = files.filter((f) => f.type !== GG.GitFileStatus.Untracked).map((f) => f.newFilePath);
						const untrackedPaths = files.filter((f) => f.type === GG.GitFileStatus.Untracked).map((f) => f.newFilePath);
						dialog.asDangerous().showConfirmation(t('Are you sure you want to discard uncommitted changes in <b>{0} selected files</b>? This cannot be undone.', String(paths.length)), t('Yes, discard'), () => {
							sendMessage({ command: 'discardWorkingChanges', repo: this.view.currentRepo, trackedPaths: trackedPaths, untrackedPaths: untrackedPaths });
							this.selectedFileIndices.clear();
							updateBulkSelectionUi();
						}, null);
						break;
					}
					case 'restore': {
						const targetHash = this.view.expandedCommit.compareWithHash !== null
							? this.view.getCommitOrder(this.view.expandedCommit.commitHash, this.view.expandedCommit.compareWithHash).to
							: this.view.expandedCommit.commitHash;
						dialog.asDangerous().showConfirmation(t('Are you sure you want to restore <b>{0} selected files</b> to their state at commit <b><i>{1}</i></b>?', String(paths.length), abbrevCommit(targetHash)), t('Yes, restore'), () => {
							runAction({ command: 'restoreFilesFromCommit', repo: this.view.currentRepo, commitHash: targetHash, filePaths: paths }, t('Restoring files'));
							this.selectedFileIndices.clear();
							updateBulkSelectionUi();
						}, null);
						break;
					}
				}
			};
		};

		const getCommitHashForFile = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => {
			const commit = this.view.commits[this.view.commitLookup[expandedCommit.commitHash]];
			if (expandedCommit.compareWithHash !== null) {
				return this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash).to;
			} else if (typeof commit !== 'undefined' && commit.stash !== null && file.type === GG.GitFileStatus.Untracked) {
				return commit.stash.untrackedFilesHash!;
			} else {
				return expandedCommit.commitHash;
			}
		};

		const triggerViewFileDiff = (file: GG.GitFileChange, fileElem: HTMLElement, onlyChanges?: boolean) => {
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null) return;

			let commit = this.view.commits[this.view.commitLookup[expandedCommit.commitHash]], fromHash: string, toHash: string, fileStatus = file.type;
			if (expandedCommit.compareWithHash !== null) {
				// Commit Comparison
				const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
				fromHash = commitOrder.from;
				toHash = commitOrder.to;
			} else if (typeof commit !== 'undefined' && commit.stash !== null) {
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
			if (typeof onlyChanges === 'boolean') {
				this.view.setHideUnchangedRegions(onlyChanges, false);
			}
			sendMessage({
				command: 'viewDiff',
				repo: this.view.currentRepo,
				fromHash: fromHash,
				toHash: toHash,
				oldFilePath: file.oldFilePath,
				newFilePath: file.newFilePath,
				type: fileStatus,
				...(typeof onlyChanges === 'boolean' ? { onlyChanges: onlyChanges } : {})
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
			const mouseEv = <MouseEvent>e;
			const clickedIndex = parseInt(fileElem.dataset.index!);
			if (mouseEv.shiftKey || mouseEv.ctrlKey || mouseEv.metaKey) {
				handledEvent(e);
				const filesElem = getCdvFileViewElem();
				const orderedIndices = filesElem !== null
					? Array.from(filesElem.querySelectorAll<HTMLElement>('.fileTreeFileRecord')).map((el) => parseInt(el.dataset.index!))
					: [];
				if (mouseEv.shiftKey && this.selectionAnchor !== null && orderedIndices.length > 0) {
					const aPos = orderedIndices.indexOf(this.selectionAnchor);
					const bPos = orderedIndices.indexOf(clickedIndex);
					if (aPos !== -1 && bPos !== -1) {
						if (!mouseEv.ctrlKey && !mouseEv.metaKey) this.selectedFileIndices.clear();
						const [lo, hi] = aPos <= bPos ? [aPos, bPos] : [bPos, aPos];
						for (let k = lo; k <= hi; k++) this.selectedFileIndices.add(orderedIndices[k]);
					} else {
						this.selectedFileIndices.add(clickedIndex);
					}
				} else {
					if (this.selectedFileIndices.has(clickedIndex)) this.selectedFileIndices.delete(clickedIndex);
					else this.selectedFileIndices.add(clickedIndex);
					this.selectionAnchor = clickedIndex;
				}
				updateBulkSelectionUi();
				return;
			}
			if (this.selectedFileIndices.size > 0) {
				this.selectedFileIndices.clear();
				updateBulkSelectionUi();
			}
			this.selectionAnchor = clickedIndex;
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

		// Pointer-following floating action pill for Changed Files in Commit Details View
		const filesElem = getCdvFileViewElem();
		if (filesElem !== null) {
			filesElem.classList.add('hasFloatingFileBar');
			let barElem = document.getElementById('cdvFileFloatingBar');
			if (barElem === null) {
				barElem = document.createElement('div');
				barElem.id = 'cdvFileFloatingBar';
				barElem.className = 'hidden';
				barElem.setAttribute('role', 'toolbar');
			}
			filesElem.appendChild(barElem);

			let currentRecord: HTMLElement | null = null;
			const hideBar = () => {
				if (currentRecord !== null) currentRecord.classList.remove('rowActionsTarget');
				currentRecord = null;
				barElem!.classList.remove('gliding', 'tip-below');
				barElem!.classList.add('hidden');
			};
			const placeBar = (clientX: number, updateVertical: boolean) => {
				if (currentRecord === null || barElem!.classList.contains('hidden')) return;
				const hostRect = filesElem.getBoundingClientRect();
				const rowRect = currentRecord.getBoundingClientRect();
				const barW = barElem!.offsetWidth || 76;
				const barH = barElem!.offsetHeight || 24;
				const minL = 10;
				const maxL = Math.max(minL, hostRect.width - barW - 14);
				const relX = clientX - hostRect.left;
				let left = relX + 18;
				if (left > maxL) left = relX - 18 - barW;
				left = Math.max(minL, Math.min(left, maxL));
				if (updateVertical) {
					barElem!.classList.remove('gliding');
					barElem!.classList.toggle('tip-below', rowRect.top - hostRect.top < 28);
					const top = rowRect.top - hostRect.top + filesElem.scrollTop + (rowRect.height - barH) / 2;
					barElem!.style.top = Math.round(top) + 'px';
				} else {
					barElem!.classList.add('gliding');
				}
				barElem!.style.left = Math.round(left + filesElem.scrollLeft) + 'px';
			};
			filesElem.onmousemove = (ev: MouseEvent) => {
				if (ev.altKey || contextMenu.isOpen() || dialog.isOpen()) {
					hideBar();
					return;
				}
				const targetEl = ev.target instanceof Element ? ev.target : null;
				if (targetEl && barElem!.contains(targetEl)) return;
				const rec = targetEl ? <HTMLElement | null>targetEl.closest('.fileTreeFileRecord') : null;
				const expandedCommit = this.view.expandedCommit;
				if (rec === null || expandedCommit === null || expandedCommit.fileChanges === null) {
					hideBar();
					return;
				}
				if (rec === currentRecord && !barElem!.classList.contains('hidden')) {
					const bRect = barElem!.getBoundingClientRect();
					if (ev.clientX < bRect.left - 22 || ev.clientX > bRect.right + 22) {
						placeBar(ev.clientX, false);
					}
					return;
				}
				if (currentRecord !== null) currentRecord.classList.remove('rowActionsTarget');
				currentRecord = rec;
				currentRecord.classList.add('rowActionsTarget');
				const file = getFileOfFileElem(expandedCommit.fileChanges, rec);
				const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
				const isUncommitted = commitOrder.to === UNCOMMITTED;
				const textFile = file.additions !== null && file.deletions !== null;
				const diffPossible = file.type === GG.GitFileStatus.Untracked || textFile;
				const copyTitle = escapeHtml(t('Copy Absolute File Path to Clipboard'));
				const revTitle = escapeHtml(t('View File at this Revision'));
				const openTitle = escapeHtml(t('Open File'));
				let html = '<button type="button" class="rowAction" data-cdv-act="copy" data-tip="' + copyTitle + '" aria-label="' + copyTitle + '">' + SVG_ICONS.copy + '</button>';
				if (file.type !== GG.GitFileStatus.Deleted) {
					if (diffPossible && !isUncommitted) {
						html += '<button type="button" class="rowAction" data-cdv-act="rev" data-tip="' + revTitle + '" aria-label="' + revTitle + '">' + SVG_ICONS.commit + '</button>';
					}
					html += '<button type="button" class="rowAction" data-cdv-act="open" data-tip="' + openTitle + '" aria-label="' + openTitle + '">' + SVG_ICONS.openFile + '</button>';
				}
				barElem!.innerHTML = html;
				barElem!.classList.remove('hidden');
				placeBar(ev.clientX, true);
			};
			filesElem.onmouseleave = () => hideBar();
			filesElem.onscroll = () => hideBar();
			const cdvContentElem = document.getElementById('cdvContent');
			if (cdvContentElem !== null) cdvContentElem.addEventListener('scroll', () => hideBar(), { passive: true });
			barElem.onclick = (ev: MouseEvent) => {
				handledEvent(ev);
				const btn = ev.target instanceof Element ? <HTMLElement | null>ev.target.closest('[data-cdv-act]') : null;
				const expandedCommit = this.view.expandedCommit;
				if (btn === null || currentRecord === null || expandedCommit === null || expandedCommit.fileChanges === null) return;
				const file = getFileOfFileElem(expandedCommit.fileChanges, currentRecord);
				switch (btn.dataset.cdvAct) {
					case 'copy':
						triggerCopyFilePath(file, true);
						break;
					case 'rev':
						triggerViewFileAtRevision(file, currentRecord);
						break;
					case 'open':
						triggerOpenFile(file, currentRecord);
						break;
				}
			};
		}

		addListenerToClass('fileTreeFileRecord', 'contextmenu', (e: Event) => {
			handledEvent(e);
			const expandedCommit = this.view.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;
			const fileElem = getFileElemOfEventTarget(e.target);
			const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);
			const commitOrder = this.view.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
			const isUncommitted = commitOrder.to === UNCOMMITTED;

			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
			const clickedIdx = parseInt(fileElem.dataset.index!);
			expandedCommit.contextMenuOpen.fileView = clickedIdx;

			const target: ContextMenuTarget & CommitTarget = {
				type: TargetType.CommitDetailsView,
				hash: expandedCommit.commitHash,
				index: this.view.commitLookup[expandedCommit.commitHash],
				elem: fileElem
			};
			if (this.selectedFileIndices.size >= 2 && this.selectedFileIndices.has(clickedIdx)) {
				const selFiles = Array.from(this.selectedFileIndices)
					.sort((a, b) => a - b)
					.map((idx) => expandedCommit.fileChanges![idx])
					.filter((f): f is GG.GitFileChange => typeof f !== 'undefined');
				const selPaths = selFiles.map((f) => f.newFilePath);
				const countStr = String(selFiles.length);
				contextMenu.show([
					[
						{
							title: t('Open {0} Selected Diffs', countStr),
							icon: MENU_ICONS.diff,
							visible: true,
							onClick: () => {
								const fromH = expandedCommit.compareWithHash !== null ? commitOrder.from : (expandedCommit.commitHash === UNCOMMITTED ? 'HEAD' : expandedCommit.commitHash + '^');
								const toH = expandedCommit.compareWithHash !== null ? commitOrder.to : expandedCommit.commitHash;
								sendMessage({ command: 'openAllChanges', repo: this.view.currentRepo, fromHash: fromH, toHash: toH, title: t('{0} Selected Files', countStr), fileChanges: selFiles });
							}
						},
						{
							title: t('Copy {0} File Paths', countStr),
							icon: MENU_ICONS.copy,
							visible: true,
							onClick: () => sendMessage({ command: 'copyToClipboard', type: t('File Paths'), data: selPaths.join('\n') })
						}
					],
					isUncommitted
						? [
							{
								title: t('Stage {0} Selected Files', countStr),
								icon: MENU_ICONS.fixup,
								visible: true,
								onClick: () => {
									sendMessage({ command: 'stageFiles', repo: this.view.currentRepo, paths: selPaths });
									this.selectedFileIndices.clear();
									updateBulkSelectionUi();
								}
							},
							{
								title: t('Unstage {0} Selected Files', countStr),
								icon: MENU_ICONS.revert,
								visible: true,
								onClick: () => {
									sendMessage({ command: 'unstageFiles', repo: this.view.currentRepo, paths: selPaths });
									this.selectedFileIndices.clear();
									updateBulkSelectionUi();
								}
							},
							{
								title: t('Discard {0} Selected Files', countStr) + ELLIPSIS,
								icon: MENU_ICONS.trash,
								visible: true,
								onClick: () => {
									const trackedPaths = selFiles.filter((f) => f.type !== GG.GitFileStatus.Untracked).map((f) => f.newFilePath);
									const untrackedPaths = selFiles.filter((f) => f.type === GG.GitFileStatus.Untracked).map((f) => f.newFilePath);
									dialog.asDangerous().showConfirmation(t('Are you sure you want to discard uncommitted changes in <b>{0} selected files</b>? This cannot be undone.', countStr), t('Yes, discard'), () => {
										sendMessage({ command: 'discardWorkingChanges', repo: this.view.currentRepo, trackedPaths: trackedPaths, untrackedPaths: untrackedPaths });
										this.selectedFileIndices.clear();
										updateBulkSelectionUi();
									}, null);
								}
							}
						]
						: [
							{
								title: t('Restore {0} Selected Files to this Revision', countStr) + ELLIPSIS,
								icon: MENU_ICONS.reset,
								visible: true,
								onClick: () => {
									const targetHash = expandedCommit.compareWithHash !== null ? commitOrder.to : expandedCommit.commitHash;
									dialog.asDangerous().showConfirmation(t('Are you sure you want to restore <b>{0} selected files</b> to their state at commit <b><i>{1}</i></b>?', countStr, abbrevCommit(targetHash)), t('Yes, restore'), () => {
										runAction({ command: 'restoreFilesFromCommit', repo: this.view.currentRepo, commitHash: targetHash, filePaths: selPaths }, t('Restoring files'));
										this.selectedFileIndices.clear();
										updateBulkSelectionUi();
									}, null);
								}
							}
						],
					[
						{
							title: t('Clear Selection'),
							icon: MENU_ICONS.clear,
							visible: true,
							onClick: () => {
								this.selectedFileIndices.clear();
								this.selectionAnchor = null;
								updateBulkSelectionUi();
							}
						}
					]
				], false, target, <MouseEvent>e, this.view.viewElem, () => {
					if (this.view.expandedCommit !== null) this.view.expandedCommit.contextMenuOpen.fileView = -1;
				});
				return;
			}
			const diffPossible = file.type === GG.GitFileStatus.Untracked || (file.additions !== null && file.deletions !== null);
			const fileExistsAtThisRevision = file.type !== GG.GitFileStatus.Deleted && !isUncommitted;
			const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && diffPossible;
			const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);
			const visibility = this.view.config.contextMenuActionsVisibility.commitDetailsViewFile;
			const commit = this.view.commits[this.view.commitLookup[expandedCommit.commitHash]];
			const stash = expandedCommit.compareWithHash === null && typeof commit !== 'undefined' ? commit.stash : null;

			contextMenu.show([
				[
					{
						title: t('View Diff'),
						icon: MENU_ICONS.diff,
						visible: visibility.viewDiff && diffPossible,
						onClick: () => triggerViewFileDiff(file, fileElem)
					},
					{
						title: t('View Diff (Changes Only)'),
						icon: MENU_ICONS.foldDiff,
						visible: visibility.viewDiff && diffPossible,
						onClick: () => triggerViewFileDiff(file, fileElem, true)
					},
					{
						title: t('View Diff (Full File)'),
						icon: MENU_ICONS.file,
						visible: visibility.viewDiff && diffPossible && this.view.isHideUnchangedRegions(),
						onClick: () => triggerViewFileDiff(file, fileElem, false)
					},
					{
						title: t('View File at this Revision'),
						icon: MENU_ICONS.file,
						visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileAtRevision(file, fileElem)
					},
					{
						title: t('View Diff with Working File'),
						icon: MENU_ICONS.compare,
						visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)
					},
					{
						title: t('Open File'),
						icon: MENU_ICONS.external,
						visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,
						onClick: () => triggerOpenFile(file, fileElem)
					},
					{
						title: t('View File History'),
						icon: MENU_ICONS.history,
						visible: file.type !== GG.GitFileStatus.Untracked && this.view.fileHistory !== file.newFilePath,
						onClick: () => this.view.setFileHistory(file.newFilePath)
					},
					{
						title: t('File Time Machine'),
						icon: MENU_ICONS.history,
						visible: visibility.visualFileHistory && file.type !== GG.GitFileStatus.Untracked && !(isUncommitted && file.type === GG.GitFileStatus.Added),
						onClick: () => sendMessage({ command: 'viewFileTimeMachine', repo: this.view.currentRepo, filePath: file.newFilePath, commitHash: isUncommitted ? null : commitOrder.to })
					},
					{
						title: t('Visual File History'),
						icon: MENU_ICONS.chart,
						visible: visibility.visualFileHistory && file.type !== GG.GitFileStatus.Untracked && !(isUncommitted && file.type === GG.GitFileStatus.Added),
						onClick: () => sendMessage({ command: 'viewVisualFileHistory', repo: this.view.currentRepo, filePath: file.newFilePath, commitHash: isUncommitted ? null : commitOrder.to })
					}
				],
				[
					{
						title: t('Mark as Reviewed'),
						icon: MENU_ICONS.eye,
						visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, true, false)
					},
					{
						title: t('Mark as Not Reviewed'),
						icon: MENU_ICONS.eyeOff,
						visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, false, false)
					}
				],
				[
					{
						title: t('Reset File to this Revision') + ELLIPSIS,
						icon: MENU_ICONS.reset,
						visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,
						onClick: () => triggerResetFileToRevision(file, fileElem)
					},
					{
						title: t('Stage File'),
						icon: MENU_ICONS.plus,
						visible: isUncommitted && expandedCommit.compareWithHash === null,
						onClick: () => runAction({ command: 'stageFiles', repo: this.view.currentRepo, paths: [file.newFilePath] }, t('Staging File'))
					},
					{
						title: t('Unstage File'),
						icon: MENU_ICONS.revert,
						visible: isUncommitted && expandedCommit.compareWithHash === null && file.type !== GG.GitFileStatus.Untracked,
						onClick: () => runAction({ command: 'unstageFiles', repo: this.view.currentRepo, paths: [file.newFilePath] }, t('Unstaging File'))
					},
					{
						title: t('Stage / Unstage Hunks') + ELLIPSIS,
						icon: MENU_ICONS.diff,
						visible: isUncommitted && expandedCommit.compareWithHash === null && file.type !== GG.GitFileStatus.Untracked,
						onClick: () => this.view.openHunkStagingModal(file.newFilePath, false)
					},
					{
						title: t('Discard File Changes') + ELLIPSIS,
						icon: MENU_ICONS.trash,
						visible: isUncommitted && expandedCommit.compareWithHash === null,
						onClick: () => {
							dialog.asDangerous().showConfirmation(
								t('Are you sure you want to permanently discard uncommitted changes to <b><i>{0}</i></b>?', escapeHtml(file.newFilePath)),
								t('Yes, discard'),
								() => runAction({
									command: 'discardWorkingChanges',
									repo: this.view.currentRepo,
									trackedPaths: file.type === GG.GitFileStatus.Untracked ? [] : [file.newFilePath],
									untrackedPaths: file.type === GG.GitFileStatus.Untracked ? [file.newFilePath] : []
								}, t('Discarding Changes')),
								target
							);
						}
					},
					{
						title: t('Stash this File') + ELLIPSIS,
						icon: MENU_ICONS.stash,
						visible: visibility.stashFile && isUncommitted && expandedCommit.compareWithHash === null,
						onClick: () => this.view.actions.stashUncommittedChangesAction(null, file.newFilePath)
					},
					{
						title: t('Restore File from this Stash') + ELLIPSIS,
						icon: MENU_ICONS.stashPop,
						visible: visibility.restoreFromStash && stash !== null && file.type !== GG.GitFileStatus.Deleted,
						onClick: () => {
							if (stash === null) return;
							sendMessage({ command: 'restoreFileFromStash', repo: this.view.currentRepo, stashHash: expandedCommit.commitHash, selector: stash.selector, filePath: file.newFilePath, untracked: file.type === GG.GitFileStatus.Untracked, force: false });
						}
					},
					{
						// The extension shows what removing the file will do, and asks for confirmation (also removing its previous name, if it was renamed)
						title: t('Remove File from History') + ELLIPSIS,
						icon: MENU_ICONS.trash,
						visible: visibility.removeFromHistory && file.type !== GG.GitFileStatus.Untracked,
						onClick: () => sendMessage({ command: 'removeFilesFromHistory', repo: this.view.currentRepo, filePaths: file.oldFilePath !== file.newFilePath ? [file.newFilePath, file.oldFilePath] : [file.newFilePath] })
					}
				],
				[
					{
						title: t('Copy Absolute File Path to Clipboard'),
						icon: MENU_ICONS.copy,
						visible: visibility.copyAbsoluteFilePath,
						onClick: () => triggerCopyFilePath(file, true)
					},
					{
						title: t('Copy Relative File Path to Clipboard'),
						icon: MENU_ICONS.copy,
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

	public renderCdvHideUnchangedBtn() {
		if (this.view.expandedCommit === null) return;
		const btnElem = document.getElementById('cdvHideUnchanged');
		if (btnElem === null) return;
		const active = this.view.isHideUnchangedRegions();
		alterClass(btnElem, CLASS_ACTIVE, active);
		btnElem.title = active
			? t('Diff View: Changes Only (Click to show full file)')
			: t('Diff View: Full File (Click to only show changes)');
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
