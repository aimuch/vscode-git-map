/**
 * Builds the context menus of the branches, tags, stashes & commits in the Git Map View, and runs the actions in them (showing the
 * dialogs that confirm them first).
 */
class ViewActions {
	private readonly view: GitGraphView;
	private editMessageTarget: (DialogTarget & CommitTarget) | null = null; // The target of the Edit Commit Message dialog (while its message is loaded)
	private stashTarget: DialogTarget | null = null; // The target of the Stash dialog (while the files are loaded)

	/**
	 * Construct a new ViewActions instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/* Context Menus */

	public getBranchContextMenuActions(target: DialogTarget & RefTarget): ContextMenuActions {
		const refName = target.ref, visibility = this.view.config.contextMenuActionsVisibility.branch;
		const isSelectedInBranchesDropdown = this.view.branchDropdown.isSelected(refName);
		return [[
			{
				title: t('Checkout Branch'),
				visible: visibility.checkout && this.view.gitBranchHead !== refName,
				onClick: () => this.checkoutBranchAction(refName, null, null, target)
			}, {
				title: t('Rename Branch') + ELLIPSIS,
				visible: visibility.rename,
				onClick: () => {
					dialog.showRefInput(t('Enter the new name for branch <b><i>{0}</i></b>:', escapeHtml(refName)), refName, t('Rename Branch'), (newName) => {
						runAction({ command: 'renameBranch', repo: this.view.currentRepo, oldName: refName, newName: newName }, t('Renaming Branch'));
					}, target);
				}
			}, {
				title: t('Delete Branch') + ELLIPSIS,
				visible: visibility.delete && this.view.gitBranchHead !== refName,
				onClick: () => {
					let remotesWithBranch = this.view.gitRemotes.filter(remote => this.view.gitBranches.includes('remotes/' + remote + '/' + refName));
					let inputs: DialogInput[] = [{ type: DialogInputType.Checkbox, name: t('Force Delete'), value: this.view.config.dialogDefaults.deleteBranch.forceDelete }];
					if (remotesWithBranch.length > 0) {
						inputs.push({
							type: DialogInputType.Checkbox,
							name: t('Delete this branch on the remote{0}', (this.view.gitRemotes.length > 1 ? 's' : '')),
							value: false,
							info: t('This branch is on the remote{0}{1}', (remotesWithBranch.length > 1 ? 's: ' : ' '), formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"')))
						});
					}
					dialog.asDangerous().showForm(t('Are you sure you want to delete the branch <b><i>{0}</i></b>?', escapeHtml(refName)), inputs, t('Yes, delete'), (values) => {
						runAction({ command: 'deleteBranch', repo: this.view.currentRepo, branchName: refName, forceDelete: <boolean>values[0], deleteOnRemotes: remotesWithBranch.length > 0 && <boolean>values[1] ? remotesWithBranch : [] }, t('Deleting Branch'));
					}, target);
				}
			}, {
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge && this.view.gitBranchHead !== refName,
				onClick: () => this.mergeAction(refName, refName, GG.MergeActionOn.Branch, target)
			}, {
				title: t('Rebase current branch on Branch') + ELLIPSIS,
				visible: visibility.rebase && this.view.gitBranchHead !== refName,
				onClick: () => this.rebaseAction(refName, refName, GG.RebaseActionOn.Branch, target)
			}, {
				title: t('Push Branch') + ELLIPSIS,
				visible: visibility.push && this.view.gitRemotes.length > 0,
				onClick: () => this.pushBranchAction(refName, target)
			}
		], [
			this.getViewIssueAction(refName, visibility.viewIssue, target),
			{
				title: t('Create Pull Request') + ELLIPSIS,
				visible: visibility.createPullRequest && this.view.gitRepos[this.view.currentRepo].pullRequestConfig !== null,
				onClick: () => {
					const config = this.view.gitRepos[this.view.currentRepo].pullRequestConfig;
					if (config === null) return;
					dialog.showCheckbox(t('Are you sure you want to create a Pull Request for branch <b><i>{0}</i></b>?', escapeHtml(refName)), t('Push branch before creating the Pull Request'), true, t('Yes, create Pull Request'), (push) => {
						runAction({ command: 'createPullRequest', repo: this.view.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, t('Creating Pull Request'));
					}, target);
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.view.currentRepo, ref: refName }, t('Creating Archive'));
				}
			},
			{
				title: t('Create Worktree') + ELLIPSIS,
				visible: visibility.createWorktree && this.view.gitBranchHead !== refName && this.view.worktreeList.getOtherWorktreeOfBranch(refName) === null,
				onClick: () => this.view.worktreeList.createWorktreeAction(refName, true, target)
			},
			{
				title: t('Select in Branches Dropdown'),
				visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,
				onClick: () => this.view.branchDropdown.selectOption(refName)
			},
			{
				title: t('Unselect in Branches Dropdown'),
				visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
				onClick: () => this.view.branchDropdown.unselectOption(refName)
			}
		], [
			{
				title: t('Copy Branch Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Branch Name'), data: refName });
				}
			}
		], [
			{
				title: t('Compare with Branch') + ELLIPSIS,
				visible: visibility.compare,
				onClick: () => this.view.branchCompare.chooseAndCompare(refName, target)
			}
		]];
	}

	public getCommitContextMenuActions(target: DialogTarget & CommitTarget): ContextMenuActions {
		const hash = target.hash, visibility = this.view.config.contextMenuActionsVisibility.commit;
		const commit = this.view.commits[this.view.commitLookup[hash]];
		const isHead = hash === this.view.getCommitHead(), rebasable = this.view.graph.dropCommitPossible(this.view.commitLookup[hash]);
		const bisect = this.view.getBisectState();
		return [[
			{
				title: t('Add Tag') + ELLIPSIS,
				visible: visibility.addTag,
				onClick: () => this.addTagAction(hash, '', this.view.config.dialogDefaults.addTag.type, '', null, target)
			}, {
				id: 'createBranch',
				title: t('Create Branch') + ELLIPSIS,
				visible: visibility.createBranch,
				onClick: () => this.createBranchAction(hash, '', this.view.config.dialogDefaults.createBranch.checkout, target)
			}, {
				title: t('Create Worktree') + ELLIPSIS,
				visible: visibility.createWorktree,
				onClick: () => this.view.worktreeList.createWorktreeAction(hash, false, target)
			}
		], [
			{
				id: 'checkout',
				title: t('Checkout') + (globalState.alwaysAcceptCheckoutCommit ? '' : ELLIPSIS),
				visible: visibility.checkout,
				onClick: () => {
					const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: this.view.currentRepo, commitHash: hash }, t('Checking out Commit'));
					if (globalState.alwaysAcceptCheckoutCommit) {
						checkoutCommit();
					} else {
						dialog.showCheckbox(t('Are you sure you want to checkout commit <b><i>{0}</i></b>? This will result in a \'detached HEAD\' state.', abbrevCommit(hash)), t('Always Accept'), false, t('Yes, checkout'), (alwaysAccept) => {
							if (alwaysAccept) {
								updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
							}
							checkoutCommit();
						}, target);
					}
				}
			}, {
				id: 'cherrypick',
				title: t('Cherry Pick') + ELLIPSIS,
				visible: visibility.cherrypick,
				onClick: () => {
					const isMerge = commit.parents.length > 1;
					let inputs: DialogInput[] = [];
					if (isMerge) {
						let options = commit.parents.map((hash, index) => ({
							name: abbrevCommit(hash) + (typeof this.view.commitLookup[hash] === 'number' ? ': ' + this.view.commits[this.view.commitLookup[hash]].message : ''),
							value: (index + 1).toString()
						}));
						inputs.push({
							type: DialogInputType.Select,
							name: t('Parent Hash'),
							options: options,
							default: '1',
							info: t('Choose the parent hash on the main branch, to cherry pick the commit relative to.')
						});
					}
					inputs.push({
						type: DialogInputType.Checkbox,
						name: t('Record Origin'),
						value: this.view.config.dialogDefaults.cherryPick.recordOrigin,
						info: t('Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...​)".')
					}, {
						type: DialogInputType.Checkbox,
						name: t('No Commit'),
						value: this.view.config.dialogDefaults.cherryPick.noCommit,
						info: t('Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit.')
					});

					dialog.showForm(t('Are you sure you want to cherry pick commit <b><i>{0}</i></b>?', abbrevCommit(hash)), inputs, t('Yes, cherry pick'), (values) => {
						let parentIndex = isMerge ? parseInt(<string>values.shift()) : 0;
						runAction({
							command: 'cherrypickCommit',
							repo: this.view.currentRepo,
							commitHash: hash,
							parentIndex: parentIndex,
							recordOrigin: <boolean>values[0],
							noCommit: <boolean>values[1]
						}, t('Cherry picking Commit'));
					}, target);
				}
			}, {
				title: t('Revert') + ELLIPSIS,
				visible: visibility.revert,
				onClick: () => {
					if (commit.parents.length > 1) {
						let options = commit.parents.map((hash, index) => ({
							name: abbrevCommit(hash) + (typeof this.view.commitLookup[hash] === 'number' ? ': ' + this.view.commits[this.view.commitLookup[hash]].message : ''),
							value: (index + 1).toString()
						}));
						dialog.showSelect(t('Are you sure you want to revert merge commit <b><i>{0}</i></b>? Choose the parent hash on the main branch, to revert the commit relative to:', abbrevCommit(hash)), '1', options, t('Yes, revert'), (parentIndex) => {
							runAction({ command: 'revertCommit', repo: this.view.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, t('Reverting Commit'));
						}, target);
					} else {
						dialog.showConfirmation(t('Are you sure you want to revert commit <b><i>{0}</i></b>?', abbrevCommit(hash)), t('Yes, revert'), () => {
							runAction({ command: 'revertCommit', repo: this.view.currentRepo, commitHash: hash, parentIndex: 0 }, t('Reverting Commit'));
						}, target);
					}
				}
			}, {
				title: t('Drop') + ELLIPSIS,
				visible: visibility.drop && rebasable,
				onClick: () => {
					dialog.asDangerous().showConfirmation(t('Are you sure you want to permanently drop commit <b><i>{0}</i></b>?{1}', abbrevCommit(hash), (this.view.onlyFollowFirstParent ? t('<br/><i>Note: By enabling "Only follow the first parent of commits", some commits may have been hidden from the Git Map View that could affect the outcome of performing this action.</i>') : '')), t('Yes, drop'), () => {
						runAction({ command: 'dropCommit', repo: this.view.currentRepo, commitHash: hash }, t('Dropping Commit'));
					}, target);
				}
			}
		], [
			{
				title: t('Edit Commit Message') + ELLIPSIS,
				visible: visibility.editMessage && commit.parents.length < 2 && (isHead || rebasable),
				onClick: () => {
					this.editMessageTarget = target;
					sendMessage({ command: 'loadCommitMessage', repo: this.view.currentRepo, commitHash: hash });
				}
			}, {
				title: t('Undo Commit') + ELLIPSIS,
				visible: visibility.undoCommit && isHead && commit.parents.length === 1,
				onClick: () => {
					dialog.showForm(t('Undo commit <b><i>{0}</i></b>? The current branch moves back to its parent, and the changes of the commit are kept:', abbrevCommit(hash)), [{
						type: DialogInputType.Radio,
						name: t('Keep the changes'),
						options: [
							{ name: t('Staged (soft)'), value: 'soft' },
							{ name: t('In the working tree, not staged (mixed)'), value: 'mixed' }
						],
						default: 'soft'
					}], t('Undo Commit'), (values) => {
						runAction({ command: 'undoCommit', repo: this.view.currentRepo, mode: <'soft' | 'mixed'>values[0] }, t('Undoing Commit'));
					}, target);
				}
			}, {
				title: t('Fix Up Staged Changes into this Commit') + ELLIPSIS,
				visible: visibility.fixup && commit.parents.length < 2 && (isHead || rebasable),
				onClick: () => {
					dialog.showConfirmation(t('Add the staged changes to commit <b><i>{0}</i></b>?', abbrevCommit(hash)) + '<br/><i>' + (isHead ? t('Unstaged changes are kept.') : t('The later commits are rebased onto the changed commit (they get new hashes). Unstaged changes are kept.')) + '</i>', t('Fix Up'), () => {
						runAction({ command: 'fixupCommit', repo: this.view.currentRepo, commitHash: hash }, t('Fixing Up Commit'));
					}, target);
				}
			}
		], [
			{
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge,
				onClick: () => this.mergeAction(hash, abbrevCommit(hash), GG.MergeActionOn.Commit, target)
			}, {
				title: t('Rebase current branch on this Commit') + ELLIPSIS,
				visible: visibility.rebase,
				onClick: () => this.rebaseAction(hash, abbrevCommit(hash), GG.RebaseActionOn.Commit, target)
			}, {
				title: t('Reset current branch to this Commit') + ELLIPSIS,
				visible: visibility.reset,
				onClick: () => {
					dialog.asDangerous().showSelect(t('Are you sure you want to reset {0} to commit <b><i>{1}</i></b>?', (this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch')), abbrevCommit(hash)), this.view.config.dialogDefaults.resetCommit.mode, [
						{ name: t('Soft - Keep all changes, but reset head'), value: GG.GitResetMode.Soft },
						{ name: t('Mixed - Keep working tree, but reset index'), value: GG.GitResetMode.Mixed },
						{ name: t('Hard - Discard all changes'), value: GG.GitResetMode.Hard }
					], t('Yes, reset'), (mode) => {
						runAction({ command: 'resetToCommit', repo: this.view.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, t('Resetting to Commit'));
					}, target);
				}
			}
		], [
			{
				title: t('Start Bisecting: This Commit is Bad') + ELLIPSIS,
				visible: visibility.bisect && bisect === null,
				onClick: () => this.startBisectAction(hash, true, target)
			}, {
				title: t('Start Bisecting: This Commit is Good') + ELLIPSIS,
				visible: visibility.bisect && bisect === null,
				onClick: () => this.startBisectAction(hash, false, target)
			}, {
				title: t('Mark as Good'),
				visible: visibility.bisect && bisect !== null && bisect.firstBad === null,
				onClick: () => runAction({ command: 'bisect', repo: this.view.currentRepo, action: 'good', commitHash: hash, goodRef: null }, t('Bisecting'))
			}, {
				title: t('Mark as Bad'),
				visible: visibility.bisect && bisect !== null && bisect.firstBad === null,
				onClick: () => runAction({ command: 'bisect', repo: this.view.currentRepo, action: 'bad', commitHash: hash, goodRef: null }, t('Bisecting'))
			}, {
				title: t('Skip (Can\'t Be Tested)'),
				visible: visibility.bisect && bisect !== null && bisect.firstBad === null,
				onClick: () => runAction({ command: 'bisect', repo: this.view.currentRepo, action: 'skip', commitHash: hash, goodRef: null }, t('Bisecting'))
			}
		], [
			{
				id: 'copyHash',
				title: t('Copy Commit Hash to Clipboard'),
				visible: visibility.copyHash,
				shortcut: (/Mac/.test(navigator.platform) ? '\u2318' : 'Ctrl+') + 'C',
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: hash });
				}
			},
			{
				title: t('Copy Commit Subject to Clipboard'),
				visible: visibility.copySubject,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Commit Subject'), data: commit.message });
				}
			},
			{
				title: t('Save as Patch') + ELLIPSIS,
				visible: visibility.savePatch,
				onClick: () => this.savePatchAction('commits', [hash], getPatchName(hash, commit.message), false)
			},
			{
				title: t('Copy as Patch'),
				visible: visibility.savePatch,
				onClick: () => this.savePatchAction('commits', [hash], '', true)
			}
		]];
	}

	/**
	 * Get the context menu of the selected commits (when a selected commit is right clicked).
	 * @param commits The selected commits (oldest first).
	 * @param target The target of the context menu.
	 * @returns The context menu actions.
	 */
	public getSelectedCommitsContextMenuActions(commits: ReadonlyArray<GG.GitCommit>, target: DialogTarget & CommitTarget): ContextMenuActions {
		const visibility = this.view.config.contextMenuActionsVisibility.commit;
		return [[
			{
				title: t('Cherry Pick {0} Commits', commits.length) + ELLIPSIS,
				visible: visibility.cherrypick,
				onClick: () => this.cherrypickCommitsAction(commits, target)
			}
		], [
			{
				title: t('Copy {0} Commit Hashes to Clipboard', commits.length),
				visible: visibility.copyHash,
				onClick: () => this.copyCommitsToClipboard(commits, false)
			},
			{
				title: t('Copy {0} Commit Subjects to Clipboard', commits.length),
				visible: visibility.copySubject,
				onClick: () => this.copyCommitsToClipboard(commits, true)
			},
			{
				title: t('Save {0} Commits as Patch', commits.length) + ELLIPSIS,
				visible: visibility.savePatch && commits.every((commit) => commit.parents.length < 2),
				onClick: () => this.savePatchAction('commits', commits.map((commit) => commit.hash), commits.length + '-commits.patch', false)
			}
		], [
			{
				title: t('Clear Selection'),
				visible: true,
				onClick: () => this.view.clearCommitSelection()
			}
		]];
	}

	public getRemoteBranchContextMenuActions(remote: string, target: DialogTarget & RefTarget): ContextMenuActions {
		const refName = target.ref, visibility = this.view.config.contextMenuActionsVisibility.remoteBranch;
		const branchName = remote !== '' ? refName.substring(remote.length + 1) : '';
		const prefixedRefName = 'remotes/' + refName;
		const isSelectedInBranchesDropdown = this.view.branchDropdown.isSelected(prefixedRefName);
		return [[
			{
				title: t('Checkout Branch') + ELLIPSIS,
				visible: visibility.checkout,
				onClick: () => this.checkoutBranchAction(refName, remote, null, target)
			}, {
				title: t('Delete Remote Branch') + ELLIPSIS,
				visible: visibility.delete && remote !== '',
				onClick: () => {
					dialog.asDangerous().showConfirmation(t('Are you sure you want to delete the remote branch <b><i>{0}</i></b>?', escapeHtml(refName)), t('Yes, delete'), () => {
						runAction({ command: 'deleteRemoteBranch', repo: this.view.currentRepo, branchName: branchName, remote: remote }, t('Deleting Remote Branch'));
					}, target);
				}
			}, {
				title: t('Fetch into local branch') + ELLIPSIS,
				visible: visibility.fetch && remote !== '' && this.view.gitBranches.includes(branchName) && this.view.gitBranchHead !== branchName,
				onClick: () => {
					dialog.showForm(t('Are you sure you want to fetch the remote branch <b><i>{0}</i></b> into the local branch <b><i>{1}</i></b>?', escapeHtml(refName), escapeHtml(branchName)), [{
						type: DialogInputType.Checkbox,
						name: t('Force Fetch'),
						value: this.view.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
						info: t('Force the local branch to be reset to this remote branch.')
					}], t('Yes, fetch'), (values) => {
						runAction({ command: 'fetchIntoLocalBranch', repo: this.view.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: <boolean>values[0] }, t('Fetching Branch'));
					}, target);
				}
			}, {
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge,
				onClick: () => this.mergeAction(refName, refName, GG.MergeActionOn.RemoteTrackingBranch, target)
			}, {
				title: t('Pull into current branch') + ELLIPSIS,
				visible: visibility.pull && remote !== '',
				onClick: () => this.pullBranchAction(refName, remote, branchName, target)
			}
		], [
			this.getViewIssueAction(refName, visibility.viewIssue, target),
			{
				title: t('Create Pull Request'),
				visible: visibility.createPullRequest && this.view.gitRepos[this.view.currentRepo].pullRequestConfig !== null && branchName !== 'HEAD' &&
					(this.view.gitRepos[this.view.currentRepo].pullRequestConfig!.sourceRemote === remote || this.view.gitRepos[this.view.currentRepo].pullRequestConfig!.destRemote === remote),
				onClick: () => {
					const config = this.view.gitRepos[this.view.currentRepo].pullRequestConfig;
					if (config === null) return;
					const isDestRemote = config.destRemote === remote;
					runAction({
						command: 'createPullRequest',
						repo: this.view.currentRepo,
						config: config,
						sourceRemote: isDestRemote ? config.destRemote! : config.sourceRemote,
						sourceOwner: isDestRemote ? config.destOwner : config.sourceOwner,
						sourceRepo: isDestRemote ? config.destRepo : config.sourceRepo,
						sourceBranch: branchName,
						push: false
					}, t('Creating Pull Request'));
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.view.currentRepo, ref: refName }, t('Creating Archive'));
				}
			},
			{
				title: t('Select in Branches Dropdown'),
				visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,
				onClick: () => this.view.branchDropdown.selectOption(prefixedRefName)
			},
			{
				title: t('Unselect in Branches Dropdown'),
				visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
				onClick: () => this.view.branchDropdown.unselectOption(prefixedRefName)
			}
		], [
			{
				title: t('Copy Branch Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Branch Name'), data: refName });
				}
			}
		], [
			{
				title: t('Compare with Branch') + ELLIPSIS,
				visible: visibility.compare && branchName !== 'HEAD',
				onClick: () => this.view.branchCompare.chooseAndCompare(refName, target)
			}
		]];
	}

	public getStashContextMenuActions(target: DialogTarget & RefTarget): ContextMenuActions {
		const hash = target.hash, selector = target.ref, visibility = this.view.config.contextMenuActionsVisibility.stash;
		return [[
			{
				title: t('Apply Stash') + ELLIPSIS,
				visible: visibility.apply,
				onClick: () => this.applyStashAction(selector, target)
			}, {
				title: t('Create Branch from Stash') + ELLIPSIS,
				visible: visibility.createBranch,
				onClick: () => {
					dialog.showRefInput(t('Create a branch from stash <b><i>{0}</i></b> with the name:', escapeHtml(selector.substring(5))), '', t('Create Branch'), (branchName) => {
						runAction({ command: 'branchFromStash', repo: this.view.currentRepo, selector: selector, branchName: branchName }, t('Creating Branch'));
					}, target);
				}
			}, {
				title: t('Pop Stash') + ELLIPSIS,
				visible: visibility.pop,
				onClick: () => this.popStashAction(selector, target)
			}, {
				title: t('Drop Stash') + ELLIPSIS,
				visible: visibility.drop,
				onClick: () => this.dropStashAction(selector, target)
			}
		], [
			{
				title: t('Copy Stash Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Stash Name'), data: selector });
				}
			}, {
				title: t('Copy Stash Hash to Clipboard'),
				visible: visibility.copyHash,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Stash Hash'), data: hash });
				}
			}, {
				title: t('Save as Patch') + ELLIPSIS,
				visible: visibility.savePatch,
				onClick: () => this.savePatchAction('stash', [hash], selector.substring(5).replace(/[@{}]/g, '') + '.patch', false)
			}
		]];
	}

	public getTagContextMenuActions(isAnnotated: boolean, target: DialogTarget & RefTarget): ContextMenuActions {
		const hash = target.hash, tagName = target.ref, visibility = this.view.config.contextMenuActionsVisibility.tag;
		return [[
			{
				title: t('View Details'),
				visible: visibility.viewDetails && isAnnotated,
				onClick: () => {
					runAction({ command: 'tagDetails', repo: this.view.currentRepo, tagName: tagName, commitHash: hash }, t('Retrieving Tag Details'));
				}
			}, {
				title: t('Delete Tag') + ELLIPSIS,
				visible: visibility.delete,
				onClick: () => {
					let message = t('Are you sure you want to delete the tag <b><i>{0}</i></b>?', escapeHtml(tagName));
					if (this.view.gitRemotes.length > 1) {
						let options = [{ name: t('Don\'t delete on any remote'), value: '-1' }];
						this.view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
						dialog.asDangerous().showSelect(message + t('<br>Do you also want to delete the tag on a remote:'), '-1', options, t('Yes, delete'), remoteIndex => {
							this.deleteTagAction(tagName, remoteIndex !== '-1' ? this.view.gitRemotes[parseInt(remoteIndex)] : null);
						}, target);
					} else if (this.view.gitRemotes.length === 1) {
						dialog.asDangerous().showCheckbox(message, t('Also delete on remote'), false, t('Yes, delete'), deleteOnRemote => {
							this.deleteTagAction(tagName, deleteOnRemote ? this.view.gitRemotes[0] : null);
						}, target);
					} else {
						dialog.asDangerous().showConfirmation(message, t('Yes, delete'), () => {
							this.deleteTagAction(tagName, null);
						}, target);
					}
				}
			}, {
				title: t('Push Tag') + ELLIPSIS,
				visible: visibility.push && this.view.gitRemotes.length > 0,
				onClick: () => {
					const runPushTagAction = (remotes: string[]) => {
						runAction({
							command: 'pushTag',
							repo: this.view.currentRepo,
							tagName: tagName,
							remotes: remotes,
							commitHash: hash,
							skipRemoteCheck: globalState.pushTagSkipRemoteCheck
						}, t('Pushing Tag'));
					};

					if (this.view.gitRemotes.length === 1) {
						dialog.showConfirmation(t('Are you sure you want to push the tag <b><i>{0}</i></b> to the remote <b><i>{1}</i></b>?', escapeHtml(tagName), escapeHtml(this.view.gitRemotes[0])), t('Yes, push'), () => {
							runPushTagAction([this.view.gitRemotes[0]]);
						}, target);
					} else if (this.view.gitRemotes.length > 1) {
						const defaults = [this.view.getPushRemote()];
						const options = this.view.gitRemotes.map((remote) => ({ name: remote, value: remote }));
						dialog.showMultiSelect(t('Are you sure you want to push the tag <b><i>{0}</i></b>? Select the remote(s) to push the tag to:', escapeHtml(tagName)), defaults, options, t('Yes, push'), (remotes) => {
							runPushTagAction(remotes);
						}, target);
					}
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.view.currentRepo, ref: tagName }, t('Creating Archive'));
				}
			},
			{
				title: t('Copy Tag Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Tag Name'), data: tagName });
				}
			}
		]];
	}

	public getUncommittedChangesContextMenuActions(target: DialogTarget & CommitTarget): ContextMenuActions {
		let visibility = this.view.config.contextMenuActionsVisibility.uncommittedChanges;
		return [[
			{
				title: t('Stash uncommitted changes') + ELLIPSIS,
				visible: visibility.stash,
				onClick: () => this.stashUncommittedChangesAction(target)
			}, {
				title: t('Save Changes as Patch') + ELLIPSIS,
				visible: visibility.savePatch,
				onClick: () => this.savePatchAction('uncommitted', [], 'uncommitted-changes.patch', false)
			}, {
				title: t('Apply Patch') + ELLIPSIS,
				visible: visibility.applyPatch,
				onClick: () => sendMessage({ command: 'checkPatch', repo: this.view.currentRepo })
			}
		], [
			{
				title: t('Reset uncommitted changes') + ELLIPSIS,
				visible: visibility.reset,
				onClick: () => {
					dialog.asDangerous().showSelect(t('Are you sure you want to reset the <b>uncommitted changes</b> to <b>HEAD</b>?'), this.view.config.dialogDefaults.resetUncommitted.mode, [
						{ name: t('Mixed - Keep working tree, but reset index'), value: GG.GitResetMode.Mixed },
						{ name: t('Hard - Discard all changes'), value: GG.GitResetMode.Hard }
					], t('Yes, reset'), (mode) => {
						runAction({ command: 'resetToCommit', repo: this.view.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, t('Resetting uncommitted changes'));
					}, target);
				}
			}, {
				title: t('Clean untracked files') + ELLIPSIS,
				visible: visibility.clean,
				onClick: () => {
					dialog.asDangerous().showCheckbox(t('Are you sure you want to clean all untracked files?'), t('Clean untracked directories'), true, t('Yes, clean'), directories => {
						runAction({ command: 'cleanUntrackedFiles', repo: this.view.currentRepo, directories: directories }, t('Cleaning untracked files'));
					}, target);
				}
			}
		], [
			{
				title: t('Open Source Control View'),
				visible: visibility.openSourceControlView,
				onClick: () => {
					sendMessage({ command: 'viewScm' });
				}
			}
		]];
	}

	private getViewIssueAction(refName: string, visible: boolean, target: DialogTarget & RefTarget): ContextMenuAction {
		const issueLinks: { url: string, displayText: string }[] = [];

		let issueLinking: IssueLinking | null, match: RegExpExecArray | null;
		if (visible && (issueLinking = parseIssueLinkingConfig(this.view.gitRepos[this.view.currentRepo].issueLinkingConfig)) !== null) {
			issueLinking.regexp.lastIndex = 0;
			while (match = issueLinking.regexp.exec(refName)) {
				if (match[0].length === 0) break;
				issueLinks.push({
					url: generateIssueLinkFromMatch(match, issueLinking),
					displayText: match[0]
				});
			}
		}

		return {
			title: t('View Issue{0}', (issueLinks.length > 1 ? ELLIPSIS : '')),
			visible: issueLinks.length > 0,
			onClick: () => {
				if (issueLinks.length > 1) {
					dialog.showSelect(t('Select which issue you want to view for this branch:'), '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), t('View Issue'), (value) => {
						sendMessage({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });
					}, target);
				} else if (issueLinks.length === 1) {
					sendMessage({ command: 'openExternalUrl', url: issueLinks[0].url });
				}
			}
		};
	}


	/* Actions */

	private addTagAction(hash: string, initialName: string, initialType: GG.TagType, initialMessage: string, initialPushToRemote: string | null, target: DialogTarget & CommitTarget, isInitialLoad: boolean = true) {
		let mostRecentTagsIndex = -1;
		for (let i = 0; i < this.view.commits.length; i++) {
			if (this.view.commits[i].tags.length > 0 && (mostRecentTagsIndex === -1 || this.view.commits[i].date > this.view.commits[mostRecentTagsIndex].date)) {
				mostRecentTagsIndex = i;
			}
		}
		const mostRecentTags = mostRecentTagsIndex > -1 ? this.view.commits[mostRecentTagsIndex].tags.map((tag) => '"' + tag.name + '"') : [];

		const inputs: DialogInput[] = [
			{ type: DialogInputType.TextRef, name: t('Name'), default: initialName, info: mostRecentTags.length > 0 ? t('The most recent tag{0} in the loaded commits {1} {2}.', (mostRecentTags.length > 1 ? 's' : ''), (mostRecentTags.length > 1 ? 'are' : 'is'), formatCommaSeparatedList(mostRecentTags)) : undefined },
			{ type: DialogInputType.Select, name: t('Type'), default: initialType === GG.TagType.Annotated ? 'annotated' : 'lightweight', options: [{ name: t('Annotated'), value: 'annotated' }, { name: t('Lightweight'), value: 'lightweight' }] },
			{ type: DialogInputType.Text, name: t('Message'), default: initialMessage, placeholder: t('Optional'), info: t('A message can only be added to an annotated tag.') }
		];
		if (this.view.gitRemotes.length > 1) {
			const options = [{ name: t('Don\'t push'), value: '-1' }];
			this.view.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
			const defaultOption = initialPushToRemote !== null
				? this.view.gitRemotes.indexOf(initialPushToRemote)
				: isInitialLoad && this.view.config.dialogDefaults.addTag.pushToRemote
					? this.view.gitRemotes.indexOf(this.view.getPushRemote())
					: -1;
			inputs.push({ type: DialogInputType.Select, name: t('Push to remote'), options: options, default: defaultOption.toString(), info: t('Once this tag has been added, push it to this remote.') });
		} else if (this.view.gitRemotes.length === 1) {
			const defaultValue = initialPushToRemote !== null || (isInitialLoad && this.view.config.dialogDefaults.addTag.pushToRemote);
			inputs.push({ type: DialogInputType.Checkbox, name: t('Push to remote'), value: defaultValue, info: t('Once this tag has been added, push it to the repositories remote.') });
		}

		dialog.showForm(t('Add tag to commit <b><i>{0}</i></b>:', abbrevCommit(hash)), inputs, t('Add Tag'), (values) => {
			const tagName = <string>values[0];
			const type = <string>values[1] === 'annotated' ? GG.TagType.Annotated : GG.TagType.Lightweight;
			const message = <string>values[2];
			const pushToRemote = this.view.gitRemotes.length > 1 && <string>values[3] !== '-1'
				? this.view.gitRemotes[parseInt(<string>values[3])]
				: this.view.gitRemotes.length === 1 && <boolean>values[3]
					? this.view.gitRemotes[0]
					: null;

			const runAddTagAction = (force: boolean) => {
				runAction({
					command: 'addTag',
					repo: this.view.currentRepo,
					tagName: tagName,
					commitHash: hash,
					type: type,
					message: message,
					pushToRemote: pushToRemote,
					pushSkipRemoteCheck: globalState.pushTagSkipRemoteCheck,
					force: force
				}, t('Adding Tag'));
			};

			if (this.view.gitTags.includes(tagName)) {
				dialog.showTwoButtons(t('A tag named <b><i>{0}</i></b> already exists, do you want to replace it with this new tag?', escapeHtml(tagName)), t('Yes, replace the existing tag'), () => {
					runAddTagAction(true);
				}, t('No, choose another tag name'), () => {
					this.addTagAction(hash, tagName, type, message, pushToRemote, target, false);
				}, target);
			} else {
				runAddTagAction(false);
			}
		}, target);
	}

	public checkoutBranchAction(refName: string, remote: string | null, prefillName: string | null, target: DialogTarget & (CommitTarget | RefTarget)) {
		if (remote !== null) {
			dialog.showRefInput(t('Enter the name of the new branch you would like to create when checking out <b><i>{0}</i></b>:', escapeHtml(refName)), (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), t('Checkout Branch'), newBranch => {
				if (this.view.gitBranches.includes(newBranch)) {
					const canPullFromRemote = remote !== '';
					dialog.showTwoButtons(t('The name <b><i>{0}</i></b> is already used by another branch:', escapeHtml(newBranch)), t('Choose another branch name'), () => {
						this.checkoutBranchAction(refName, remote, newBranch, target);
					}, t('Checkout the existing branch{0}', (canPullFromRemote ? t(' & pull changes') : '')), () => {
						runAction({
							command: 'checkoutBranch',
							repo: this.view.currentRepo,
							branchName: newBranch,
							remoteBranch: null,
							pullAfterwards: canPullFromRemote
								? {
									branchName: refName.substring(remote.length + 1),
									remote: remote,
									createNewCommit: this.view.config.dialogDefaults.pullBranch.noFastForward,
									squash: this.view.config.dialogDefaults.pullBranch.squash
								}
								: null
						}, t('Checking out Branch{0}', (canPullFromRemote ? t(' & Pulling Changes') : '')));
					}, target);
				} else {
					runAction({ command: 'checkoutBranch', repo: this.view.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, t('Checking out Branch'));
				}
			}, target);
		} else {
			runAction({ command: 'checkoutBranch', repo: this.view.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, t('Checking out Branch'));
		}
	}

	/**
	 * Cherry pick the selected commits into the current branch (after confirming it). Merge commits can only be cherry picked one at a time.
	 * @param commits The selected commits (oldest first).
	 * @param target The target of the dialog, or NULL if the action wasn't started from a commit.
	 */
	public cherrypickCommitsAction(commits: ReadonlyArray<GG.GitCommit>, target: (DialogTarget & CommitTarget) | null) {
		if (commits.length === 0) return;
		const merges = commits.filter((commit) => commit.parents.length > 1);
		if (merges.length > 0) {
			dialog.showError(t('Merge commits can\'t be cherry picked with other commits.'), t('Unselect the merge commits ({0}), and cherry pick them one at a time.', merges.map((commit) => abbrevCommit(commit.hash)).join(', ')), null, null);
			return;
		}
		const branch = this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch');
		dialog.showForm(t('Are you sure you want to cherry pick these {0} commits into {1}? They are cherry picked from the oldest to the newest:', commits.length, branch) + '<br/>' + commits.map((commit) => '<b>' + abbrevCommit(commit.hash) + '</b> ' + escapeHtml(commit.message)).join('<br/>'), [
			{
				type: DialogInputType.Checkbox,
				name: t('Record Origin'),
				value: this.view.config.dialogDefaults.cherryPick.recordOrigin,
				info: t('Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...​)".')
			},
			{
				type: DialogInputType.Checkbox,
				name: t('No Commit'),
				value: this.view.config.dialogDefaults.cherryPick.noCommit,
				info: t('Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit.')
			}
		], t('Yes, cherry pick'), (values) => {
			runAction({ command: 'cherrypickCommits', repo: this.view.currentRepo, commitHashes: commits.map((commit) => commit.hash), recordOrigin: <boolean>values[0], noCommit: <boolean>values[1] }, t('Cherry picking Commits'));
			this.view.clearCommitSelection();
		}, target);
	}

	/**
	 * Copy the hashes or subjects of commits to the clipboard (one per line).
	 * @param commits The commits (oldest first).
	 * @param subjects Copy the subjects of the commits (instead of their hashes).
	 */
	public copyCommitsToClipboard(commits: ReadonlyArray<GG.GitCommit>, subjects: boolean) {
		if (commits.length === 0) return;
		sendMessage({ command: 'copyToClipboard', type: subjects ? t('Commit Subjects') : t('Commit Hashes'), data: commits.map((commit) => subjects ? commit.message : commit.hash).join('\n') });
	}

	private createBranchAction(hash: string, initialName: string, initialCheckOut: boolean, target: DialogTarget & CommitTarget) {
		dialog.showForm(t('Create branch at commit <b><i>{0}</i></b>:', abbrevCommit(hash)), [
			{ type: DialogInputType.TextRef, name: t('Name'), default: initialName },
			{ type: DialogInputType.Checkbox, name: t('Check out'), value: initialCheckOut }
		], t('Create Branch'), (values) => {
			const branchName = <string>values[0], checkOut = <boolean>values[1];
			if (this.view.gitBranches.includes(branchName)) {
				dialog.showTwoButtons(t('A branch named <b><i>{0}</i></b> already exists, do you want to replace it with this new branch?', escapeHtml(branchName)), t('Yes, replace the existing branch'), () => {
					runAction({ command: 'createBranch', repo: this.view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, t('Creating Branch'));
				}, t('No, choose another branch name'), () => {
					this.createBranchAction(hash, branchName, checkOut, target);
				}, target);
			} else {
				runAction({ command: 'createBranch', repo: this.view.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, t('Creating Branch'));
			}
		}, target);
	}

	private deleteTagAction(refName: string, deleteOnRemote: string | null) {
		runAction({ command: 'deleteTag', repo: this.view.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, t('Deleting Tag'));
	}

	/**
	 * Show the dialog to push a branch to the remote(s).
	 * @param refName The name of the branch.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public pushBranchAction(refName: string, target: DialogTarget | null) {
		const multipleRemotes = this.view.gitRemotes.length > 1;
		const inputs: DialogInput[] = [
			{ type: DialogInputType.Checkbox, name: t('Set Upstream'), value: true },
			{
				type: DialogInputType.Radio,
				name: t('Push Mode'),
				options: [
					{ name: t('Normal'), value: GG.GitPushBranchMode.Normal },
					{ name: t('Force With Lease'), value: GG.GitPushBranchMode.ForceWithLease },
					{ name: t('Force'), value: GG.GitPushBranchMode.Force }
				],
				default: GG.GitPushBranchMode.Normal
			}
		];

		if (multipleRemotes) {
			inputs.unshift({
				type: DialogInputType.Select,
				name: t('Push to Remote(s)'),
				defaults: [this.view.getPushRemote(refName)],
				options: this.view.gitRemotes.map((remote) => ({ name: remote, value: remote })),
				multiple: true
			});
		}

		dialog.showForm(t('Are you sure you want to push the branch <b><i>{0}</i></b>{1}?', escapeHtml(refName), (multipleRemotes ? '' : t(' to the remote <b><i>{0}</i></b>', escapeHtml(this.view.gitRemotes[0])))), inputs, t('Yes, push'), (values) => {
			const remotes = multipleRemotes ? <string[]>values.shift() : [this.view.gitRemotes[0]];
			const setUpstream = <boolean>values[0];
			runAction({
				command: 'pushBranch',
				repo: this.view.currentRepo,
				branchName: refName,
				remotes: remotes,
				setUpstream: setUpstream,
				mode: <GG.GitPushBranchMode>values[1],
				willUpdateBranchConfig: setUpstream && remotes.length > 0 && (this.view.gitConfig === null || typeof this.view.gitConfig.branches[refName] === 'undefined' || this.view.gitConfig.branches[refName].remote !== remotes[remotes.length - 1])
			}, t('Pushing Branch'));
		}, target);
	}

	/**
	 * Show the dialog to pull a remote branch into the current branch.
	 * @param refName The name of the remote branch (including the name of the remote).
	 * @param remote The name of the remote.
	 * @param branchName The name of the branch on the remote.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public pullBranchAction(refName: string, remote: string, branchName: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to pull the remote branch <b><i>{0}</i></b> into {1}? If a merge is required:', escapeHtml(refName), (this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch'))), [
			{ type: DialogInputType.Checkbox, name: t('Create a new commit even if fast-forward is possible'), value: this.view.config.dialogDefaults.pullBranch.noFastForward },
			{ type: DialogInputType.Checkbox, name: t('Squash Commits'), value: this.view.config.dialogDefaults.pullBranch.squash, info: t('Create a single commit on the current branch whose effect is the same as merging this remote branch.') }
		], t('Yes, pull'), (values) => {
			runAction({ command: 'pullBranch', repo: this.view.currentRepo, branchName: branchName, remote: remote, createNewCommit: <boolean>values[0], squash: <boolean>values[1] }, t('Pulling Branch'));
		}, target);
	}

	/**
	 * Show the dialog to apply a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public applyStashAction(selector: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to apply the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), [{
			type: DialogInputType.Checkbox,
			name: t('Reinstate Index'),
			value: this.view.config.dialogDefaults.applyStash.reinstateIndex,
			info: t('Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.')
		}], t('Yes, apply stash'), (values) => {
			runAction({ command: 'applyStash', repo: this.view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, t('Applying Stash'));
		}, target);
	}

	/**
	 * Show the dialog to pop a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public popStashAction(selector: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to pop the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), [{
			type: DialogInputType.Checkbox,
			name: t('Reinstate Index'),
			value: this.view.config.dialogDefaults.popStash.reinstateIndex,
			info: t('Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.')
		}], t('Yes, pop stash'), (values) => {
			runAction({ command: 'popStash', repo: this.view.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, t('Popping Stash'));
		}, target);
	}

	/**
	 * Show the dialog to drop a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public dropStashAction(selector: string, target: DialogTarget | null) {
		dialog.asDangerous().showConfirmation(t('Are you sure you want to drop the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), t('Yes, drop'), () => {
			runAction({ command: 'dropStash', repo: this.view.currentRepo, selector: selector }, t('Dropping Stash'));
		}, target);
	}

	/**
	 * Show the dialog to stash the uncommitted changes.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	public stashUncommittedChangesAction(target: DialogTarget | null, filePath: string | null = null) {
		this.stashTarget = target;
		sendMessage({ command: 'loadStashableFiles', repo: this.view.currentRepo, filePath: filePath });
	}

	/**
	 * Show the dialog to stash the uncommitted changes (all of them, or the files chosen), once the files with changes are loaded.
	 * @param msg The message containing the files.
	 */
	public processLoadStashableFilesResponse(msg: GG.ResponseLoadStashableFiles) {
		const target = this.stashTarget;
		this.stashTarget = null;
		if (msg.error !== null) {
			dialog.showError(t('Unable to Stash Uncommitted Changes'), msg.error, null, null);
			return;
		}
		const files = msg.files, selectable = files.length > 1 && files.length <= 30;
		const inputs: DialogInput[] = [{ type: DialogInputType.Text, name: t('Message'), default: '', placeholder: t('Optional') }];
		if (selectable) {
			files.forEach((file) => inputs.push({
				type: DialogInputType.Checkbox,
				name: escapeHtml(file.path) + ' <span class="dialogFileStatus">' + (file.untracked ? t('untracked') : file.staged && file.unstaged ? t('staged & modified') : file.staged ? t('staged') : t('modified')) + '</span>',
				value: msg.filePath === null || file.path === msg.filePath
			}));
		}
		const hasStaged = files.some((file) => file.staged);
		if (msg.stagedSupported && hasStaged) inputs.push({ type: DialogInputType.Checkbox, name: t('Only the staged changes'), value: false, info: t('Stash only the changes that are staged, keeping the other changes in the working tree.') });
		inputs.push({ type: DialogInputType.Checkbox, name: t('Include Untracked'), value: this.view.config.dialogDefaults.stashUncommittedChanges.includeUntracked || (msg.filePath !== null && files.some((file) => file.path === msg.filePath && file.untracked)), info: t('Include all untracked files in the stash, and then clean them from the working directory.') });
		const message = msg.filePath !== null && !selectable ? t('Are you sure you want to stash the changes to <b><i>{0}</i></b>?', escapeHtml(msg.filePath)) : t('Are you sure you want to stash the <b>uncommitted changes</b>?');
		dialog.showForm(message, inputs, t('Yes, stash'), (values) => {
			let index = 1;
			let paths: string[] | null = null;
			if (selectable) {
				paths = files.filter((_, i) => <boolean>values[index + i]).map((file) => file.path);
				index += files.length;
				if (paths.length === 0) {
					dialog.showError(t('Unable to Stash Uncommitted Changes'), t('No files were selected.'), null, null);
					return;
				}
				if (paths.length === files.length) paths = null;
			} else if (msg.filePath !== null) {
				paths = [msg.filePath];
			}
			const onlyStaged = msg.stagedSupported && hasStaged ? <boolean>values[index++] : false;
			runAction({ command: 'pushStash', repo: this.view.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[index], paths: paths, onlyStaged: onlyStaged }, t('Stashing uncommitted changes'));
		}, target);
	}

	/**
	 * Show the dialog to edit the message of a commit, once its message is loaded.
	 * @param msg The message containing the message of the commit.
	 */
	public processLoadCommitMessageResponse(msg: GG.ResponseLoadCommitMessage) {
		const target = this.editMessageTarget;
		this.editMessageTarget = null;
		if (msg.error !== null) {
			dialog.showError(t('Unable to Edit Commit Message'), msg.error, null, null);
			return;
		}
		const isHead = msg.commitHash === this.view.getCommitHead();
		dialog.showForm(t('Edit the message of commit <b><i>{0}</i></b>:', abbrevCommit(msg.commitHash)) + '<br/><i>' + (isHead
			? t('If the commit has been pushed, the branch must be force pushed afterwards.')
			: t('The later commits are rebased onto the changed commit (they get new hashes). If they have been pushed, the branch must be force pushed afterwards.')) + '</i>', [
			{ type: DialogInputType.TextArea, name: t('Message'), default: msg.message, placeholder: null }
		], t('Save Message'), (values) => {
			const message = (<string>values[0]).trim();
			if (message === '') {
				dialog.showError(t('Unable to Edit Commit Message'), t('The message can\'t be empty.'), null, null);
				return;
			}
			runAction({ command: 'editCommitMessage', repo: this.view.currentRepo, commitHash: msg.commitHash, message: message }, t('Saving Commit Message'));
		}, target);
	}

	/**
	 * Show the dialog to apply a patch, once the patch file has been chosen and checked.
	 * @param msg The message describing the patch.
	 */
	public processCheckPatchResponse(msg: GG.ResponseCheckPatch) {
		if (msg.error !== null) {
			dialog.showError(t('Unable to Apply Patch'), msg.error, null, null);
			return;
		}
		const patch = msg.patch;
		if (patch === null) return; // No file was chosen
		const stats = (patch.commits > 0 ? (patch.commits !== 1 ? t('{0} commits', patch.commits) : t('1 commit')) + ' · ' : '') + (patch.files !== 1 ? t('{0} files', patch.files) : t('{0} file', patch.files)) +
			' <span class="fileTreeFileAdd">+' + patch.additions + '</span> <span class="fileTreeFileDel">−' + patch.deletions + '</span>';
		const check = patch.appliesCleanly
			? '<span class="dialogNote ok">' + SVG_ICONS.check + t('It applies cleanly.') + '</span>'
			: '<span class="dialogNote warning">' + SVG_ICONS.alert + t('It doesn\'t apply cleanly: {0}', escapeHtml(patch.checkError !== null ? patch.checkError : '')) + '</span>';
		const message = t('Apply the patch <b><i>{0}</i></b>?', escapeHtml(patch.name)) + '<br/>' + stats + '<br/>' + check;
		const apply = (asCommits: boolean) => runAction({ command: 'applyPatch', repo: this.view.currentRepo, file: patch.file, asCommits: asCommits }, t('Applying Patch'));
		if (patch.commits > 0) {
			dialog.showForm(message, [{
				type: DialogInputType.Radio,
				name: t('How'),
				options: [
					{ name: t('As commits on the current branch (keeping their authors & messages)'), value: 'commits' },
					{ name: t('As uncommitted changes'), value: 'changes' }
				],
				default: 'commits'
			}], t('Apply'), (values) => apply(values[0] === 'commits'), null);
		} else {
			dialog.showConfirmation(message, t('Apply'), () => apply(false), null);
		}
	}

	/**
	 * Save a patch to a file, or copy it to the clipboard.
	 */
	private savePatchAction(kind: 'commits' | 'stash' | 'uncommitted', hashes: string[], name: string, copy: boolean) {
		runAction({ command: 'savePatch', repo: this.view.currentRepo, kind: kind, hashes: hashes, name: name, copy: copy }, copy ? t('Copying Patch') : t('Saving Patch'));
	}

	/**
	 * Show the dialog to start bisecting from a commit (asking for the other end).
	 * @param hash The commit.
	 * @param isBad Is the commit the bad end (otherwise, it's the good end).
	 * @param target The target of the dialog.
	 */
	private startBisectAction(hash: string, isBad: boolean, target: DialogTarget & CommitTarget) {
		dialog.showForm(t('Start bisecting to find the commit that introduced a bug:') + '<br/><i>' + (isBad ? t('Bad: {0}', abbrevCommit(hash)) : t('Good: {0}', abbrevCommit(hash))) + '</i>', [
			{ type: DialogInputType.Text, name: isBad ? t('A commit that was good (hash, tag or branch)') : t('A commit that is bad (hash, tag or branch)'), default: isBad ? '' : 'HEAD', placeholder: isBad ? t('e.g. v1.0.0') : null }
		], t('Start Bisecting'), (values) => {
			const other = (<string>values[0]).trim();
			if (other === '') return;
			runAction({ command: 'bisect', repo: this.view.currentRepo, action: 'start', commitHash: isBad ? hash : other, goodRef: isBad ? other : hash }, t('Starting to Bisect'));
		}, target);
	}

	public fetchFromRemotesAction() {
		runAction({ command: 'fetch', repo: this.view.currentRepo, name: null, prune: this.view.config.fetchAndPrune, pruneTags: this.view.config.fetchAndPruneTags }, t('Fetching from Remote(s)'));
	}

	private mergeAction(obj: string, name: string, actionOn: GG.MergeActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {
		dialog.showForm(t('Are you sure you want to merge {0} <b><i>{1}</i></b> into {2}?', t(actionOn).toLowerCase(), escapeHtml(name), (this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch'))), [
			{ type: DialogInputType.Checkbox, name: t('Create a new commit even if fast-forward is possible'), value: this.view.config.dialogDefaults.merge.noFastForward },
			{ type: DialogInputType.Checkbox, name: t('Squash Commits'), value: this.view.config.dialogDefaults.merge.squash, info: t('Create a single commit on the current branch whose effect is the same as merging this {0}.', t(actionOn).toLowerCase()) },
			{ type: DialogInputType.Checkbox, name: t('No Commit'), value: this.view.config.dialogDefaults.merge.noCommit, info: t('The changes of the merge will be staged but not committed, so that you can review and/or modify the merge result before committing.') }
		], t('Yes, merge'), (values) => {
			runAction({ command: 'merge', repo: this.view.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: <boolean>values[0], squash: <boolean>values[1], noCommit: <boolean>values[2] }, t('Merging {0}', t(actionOn)));
		}, target);
	}

	private rebaseAction(obj: string, name: string, actionOn: GG.RebaseActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {
		dialog.showForm(t('Are you sure you want to rebase {0} on {1} <b><i>{2}</i></b>?', (this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch')), actionOn.toLowerCase(), escapeHtml(name)), [
			{ type: DialogInputType.Checkbox, name: t('Interactive Rebase'), value: this.view.config.dialogDefaults.rebase.interactive, info: t('Choose how each commit is rebased (reorder, reword, squash or drop commits) in the Rebase Editor.') },
			{ type: DialogInputType.Checkbox, name: t('Ignore Date'), value: this.view.config.dialogDefaults.rebase.ignoreDate, info: t('Only applicable to a non-interactive rebase.') }
		], t('Yes, rebase'), (values) => {
			if (<boolean>values[0]) {
				this.view.rebaseEditor.show(obj, name);
			} else {
				runAction({ command: 'rebase', repo: this.view.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: <boolean>values[1], interactive: false }, t('Rebasing on {0}', t(actionOn)));
			}
		}, target);
	}
}

/**
 * Get the name of the file a commit's patch is saved to (its abbreviated hash, and its subject).
 * @param hash The hash of the commit.
 * @param subject The subject of the commit.
 */
function getPatchName(hash: string, subject: string) {
	const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 50);
	return abbrevCommit(hash) + (slug !== '' ? '-' + slug : '') + '.patch';
}
