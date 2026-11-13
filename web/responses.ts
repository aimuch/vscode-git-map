/**
 * Process the messages that the extension sends to the Git Map View (the responses to its requests, and the events it notifies the view of).
 * @param gitGraph The Git Map View.
 * @param imageResizer Resizes the avatars of authors (which are shown in the view).
 */
function observeResponseMessages(gitGraph: GitGraphView, imageResizer: ImageResizer) {
	window.addEventListener('message', event => {
		const msg: GG.ResponseMessage = event.data;
		switch (msg.command) {
			case 'addRemote':
				refreshOrDisplayError(msg.error, t('Unable to Add Remote'), true);
				break;
			case 'addTag':
				if (msg.pushToRemote !== null && msg.errors.length === 2 && msg.errors[0] === null && isExtensionErrorInfo(msg.errors[1], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					gitGraph.refresh(false);
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.errors[1]!);
				} else {
					refreshAndDisplayErrors(msg.errors, t('Unable to Add Tag'));
				}
				break;
			case 'applyStash':
				refreshOrDisplayError(msg.error, t('Unable to Apply Stash'));
				break;
			case 'branchFromStash':
				refreshOrDisplayError(msg.error, t('Unable to Create Branch from Stash'));
				break;
			case 'checkoutBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Checkout Branch{0}', (msg.pullAfterwards !== null ? t(' & Pull Changes') : '')));
				break;
			case 'checkoutCommit':
				refreshOrDisplayError(msg.error, t('Unable to Checkout Commit'));
				break;
			case 'cherrypickCommit':
				refreshAndDisplayErrors(msg.errors, t('Unable to Cherry Pick Commit'));
				break;
			case 'cherrypickCommits':
				refreshAndDisplayErrors(msg.errors, t('Unable to Cherry Pick Commits'));
				break;
			case 'undo':
				refreshOrDisplayError(msg.error, t('Unable to Undo'));
				break;
			case 'compareBranches':
				gitGraph.branchCompare.processCompareBranchesResponse(msg);
				break;
			case 'openAllChanges':
				finishOrDisplayError(msg.error, t('Unable to Open All Changes'));
				break;
			case 'loadBranchCleanup':
				gitGraph.branchCleanup.processLoadBranchCleanupResponse(msg);
				break;
			case 'deleteBranches':
				refreshAndDisplayErrors(msg.errors.length > 0 || msg.deleted === 0 ? msg.errors.concat(msg.deleted > 0 ? [null] : []) : [null], t('Unable to Delete Branches'));
				break;
			case 'loadCommitMessage':
				gitGraph.actions.processLoadCommitMessageResponse(msg);
				break;
			case 'editCommitMessage':
				refreshOrDisplayError(msg.error, t('Unable to Edit Commit Message'));
				break;
			case 'undoCommit':
				refreshOrDisplayError(msg.error, t('Unable to Undo Commit'));
				break;
			case 'fixupCommit':
				refreshOrDisplayError(msg.error, t('Unable to Fix Up Commit'));
				break;
			case 'bisect':
				refreshOrDisplayError(msg.error, msg.action === 'start' ? t('Unable to Start Bisecting') : msg.action === 'reset' ? t('Unable to Stop Bisecting') : t('Unable to Bisect'));
				break;
			case 'loadBisectState':
				gitGraph.processLoadBisectStateResponse(msg);
				break;
			case 'viewBisectLog':
				if (msg.error !== null) dialog.showError(t('Unable to View the Bisect Log'), msg.error, null, null);
				break;
			case 'savePatch':
				finishOrDisplayError(msg.error, t('Unable to Save Patch'), true);
				break;
			case 'checkPatch':
				gitGraph.actions.processCheckPatchResponse(msg);
				break;
			case 'applyPatch':
				refreshOrDisplayError(msg.error, t('Unable to Apply Patch'));
				break;
			case 'loadStashableFiles':
				gitGraph.actions.processLoadStashableFilesResponse(msg);
				break;
			case 'restoreFileFromStash':
				if (msg.error !== null) {
					dialog.showError(t('Unable to Restore File from Stash'), msg.error, null, null);
				} else if (msg.hasChanges) {
					dialog.asDangerous().showConfirmation(t('Restore <b><i>{0}</i></b> from <b><i>{1}</i></b>? It has uncommitted changes, which are replaced by the stashed version. The stash is kept.', escapeHtml(msg.filePath), escapeHtml(msg.selector.substring(5))), t('Restore File'), () => {
						runAction({ command: 'restoreFileFromStash', repo: gitGraph.currentRepo, stashHash: msg.stashHash, selector: msg.selector, filePath: msg.filePath, untracked: msg.untracked, force: true }, t('Restoring File'));
					}, null);
				} else {
					gitGraph.refresh(false);
				}
				break;
			case 'loadLanguageModels':
				gitGraph.commitExplainer.processLoadLanguageModelsResponse(msg);
				break;
			case 'explainCommit':
				gitGraph.commitExplainer.processExplainCommitResponse(msg);
				break;
			case 'loadRebaseCommits':
				gitGraph.rebaseEditor.processLoadRebaseCommitsResponse(msg);
				break;
			case 'rebaseInteractive':
				refreshOrDisplayError(msg.error, t('Unable to Rebase'));
				break;
			case 'loadOperationInProgress':
				gitGraph.processLoadOperationInProgressResponse(msg);
				break;
			case 'controlOperation':
				refreshOrDisplayError(msg.error, msg.action === 'continue' ? t('Unable to Continue') : msg.action === 'skip' ? t('Unable to Skip the Commit') : t('Unable to Abort'));
				break;
			case 'loadWorktrees':
				gitGraph.worktreeList.processLoadWorktreesResponse(msg);
				break;
			case 'addWorktree':
				refreshAndDisplayErrors(msg.errors, t('Unable to Create Worktree'));
				break;
			case 'removeWorktree':
				refreshOrDisplayError(msg.error, t('Unable to Remove Worktree'));
				break;
			case 'pruneWorktrees':
				refreshOrDisplayError(msg.error, t('Unable to Prune Worktrees'));
				break;
			case 'openWorktree':
				finishOrDisplayError(msg.error, t('Unable to Open Worktree'), true);
				break;
			case 'cleanUntrackedFiles':
				refreshOrDisplayError(msg.error, t('Unable to Clean Untracked Files'));
				break;
			case 'commitDetails':
				if (msg.commitDetails !== null) {
					gitGraph.showCommitDetails(msg.commitDetails, gitGraph.createFileTree(msg.commitDetails.fileChanges, msg.codeReview), msg.avatar, msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					gitGraph.closeCommitDetails(true);
					dialog.showError(t('Unable to load Commit Details'), msg.error, null, null);
				}
				break;
			case 'compareCommits':
				if (msg.error === null) {
					gitGraph.showCommitComparison(msg.commitHash, msg.compareWithHash, msg.fileChanges, gitGraph.createFileTree(msg.fileChanges, msg.codeReview), msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					gitGraph.closeCommitComparison(true);
					dialog.showError(t('Unable to load Commit Comparison'), msg.error, null, null);
				}
				break;
			case 'copyFilePath':
				finishOrDisplayError(msg.error, t('Unable to Copy File Path to Clipboard'));
				break;
			case 'copyToClipboard':
				finishOrDisplayError(msg.error, t('Unable to Copy {0} to Clipboard', msg.type));
				break;
			case 'createArchive':
				finishOrDisplayError(msg.error, t('Unable to Create Archive'), true);
				break;
			case 'createBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Create Branch'));
				break;
			case 'createPullRequest':
				finishOrDisplayErrors(msg.errors, t('Unable to Create Pull Request'), () => {
					if (msg.push) {
						gitGraph.refresh(false);
					}
				}, true);
				break;
			case 'deleteBranch':
				handleResponseDeleteBranch(msg);
				break;
			case 'deleteRemote':
				refreshOrDisplayError(msg.error, t('Unable to Delete Remote'), true);
				break;
			case 'deleteRemoteBranch':
				refreshOrDisplayError(msg.error, t('Unable to Delete Remote Branch'));
				break;
			case 'deleteTag':
				refreshOrDisplayError(msg.error, t('Unable to Delete Tag'));
				break;
			case 'deleteUserDetails':
				finishOrDisplayErrors(msg.errors, t('Unable to Remove Git User Details'), () => gitGraph.requestLoadConfig(), true);
				break;
			case 'dropCommit':
				refreshOrDisplayError(msg.error, t('Unable to Drop Commit'));
				break;
			case 'dropStash':
				refreshOrDisplayError(msg.error, t('Unable to Drop Stash'));
				break;
			case 'editRemote':
				refreshOrDisplayError(msg.error, t('Unable to Save Changes to Remote'), true);
				break;
			case 'editUserDetails':
				finishOrDisplayErrors(msg.errors, t('Unable to Save Git User Details'), () => gitGraph.requestLoadConfig(), true);
				break;
			case 'exportRepoConfig':
				refreshOrDisplayError(msg.error, t('Unable to Export Repository Configuration'));
				break;
			case 'fetch':
				refreshOrDisplayError(msg.error, t('Unable to Fetch from Remote(s)'));
				break;
			case 'fetchAvatar':
				imageResizer.resize(msg.image, (resizedImage) => {
					gitGraph.loadAvatar(msg.email, resizedImage);
				});
				break;
			case 'fetchIntoLocalBranch':
				refreshOrDisplayError(msg.error, t('Unable to Fetch into Local Branch'));
				break;
			case 'loadCommits':
				gitGraph.processLoadCommitsResponse(msg);
				break;
			case 'loadConfig':
				gitGraph.processLoadConfig(msg);
				break;
			case 'loadRepoInfo':
				gitGraph.processLoadRepoInfoResponse(msg);
				break;
			case 'loadStashStats':
				gitGraph.stashList.processLoadStashStatsResponse(msg);
				break;
			case 'loadFileDiff':
				gitGraph.processLoadFileDiffResponse(msg);
				break;
			case 'loadCommitStats':
				gitGraph.processLoadCommitStatsResponse(msg);
				break;
			case 'loadFileIconTheme':
				fileIcons.setTheme(msg.theme);
				gitGraph.cdvFileView.refreshCdvFileView();
				break;
			case 'loadRepos':
				gitGraph.loadRepos(msg.repos, msg.lastActiveRepo, msg.loadViewTo);
				break;
			case 'searchCommits':
				gitGraph.processSearchCommitsResponse(msg);
				break;
			case 'merge':
				refreshOrDisplayError(msg.error, t('Unable to Merge {0}', t(msg.actionOn)));
				break;
			case 'openExtensionSettings':
				finishOrDisplayError(msg.error, t('Unable to Open Extension Settings'));
				break;
			case 'updateExtensionSetting':
				finishOrDisplayError(msg.error, t('Unable to Update Extension Setting'));
				break;
			case 'openExternalDirDiff':
				finishOrDisplayError(msg.error, t('Unable to Open External Directory Diff'), true);
				break;
			case 'openExternalUrl':
				finishOrDisplayError(msg.error, t('Unable to Open External URL'));
				break;
			case 'openFile':
				finishOrDisplayError(msg.error, t('Unable to Open File'));
				break;
			case 'openTerminal':
				finishOrDisplayError(msg.error, t('Unable to Open Terminal'), true);
				break;
			case 'popStash':
				refreshOrDisplayError(msg.error, t('Unable to Pop Stash'));
				break;
			case 'pruneRemote':
				refreshOrDisplayError(msg.error, t('Unable to Prune Remote'));
				break;
			case 'pullBranch':
				refreshOrDisplayError(msg.error, t('Unable to Pull Branch'));
				break;
			case 'pushBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Push Branch'), msg.willUpdateBranchConfig);
				break;
			case 'pushStash':
				refreshOrDisplayError(msg.error, t('Unable to Stash Uncommitted Changes'));
				break;
			case 'pushTag':
				if (msg.errors.length === 1 && isExtensionErrorInfo(msg.errors[0], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.errors[0]!);
				} else {
					refreshAndDisplayErrors(msg.errors, t('Unable to Push Tag'));
				}
				break;
			case 'rebase':
				if (msg.error === null) {
					if (msg.interactive) {
						dialog.closeActionRunning();
					} else {
						gitGraph.refresh(false);
					}
				} else {
					dialog.showError(t('Unable to Rebase current branch on {0}', t(msg.actionOn)), msg.error, null, null);
				}
				break;
			case 'refresh':
				gitGraph.refresh(false);
				break;
			case 'renameBranch':
				refreshOrDisplayError(msg.error, t('Unable to Rename Branch'));
				break;
			case 'resetFileToRevision':
				refreshOrDisplayError(msg.error, t('Unable to Reset File to Revision'));
				break;
			case 'resetToCommit':
				refreshOrDisplayError(msg.error, t('Unable to Reset to Commit'));
				break;
			case 'revertCommit':
				refreshOrDisplayError(msg.error, t('Unable to Revert Commit'));
				break;
			case 'setGlobalViewState':
				finishOrDisplayError(msg.error, t('Unable to save the Global View State'));
				break;
			case 'setWorkspaceViewState':
				finishOrDisplayError(msg.error, t('Unable to save the Workspace View State'));
				break;
			case 'startCodeReview':
				if (msg.error === null) {
					gitGraph.startCodeReview(msg.commitHash, msg.compareWithHash, msg.codeReview);
				} else {
					dialog.showError(t('Unable to Start Code Review'), msg.error, null, null);
				}
				break;
			case 'tagDetails':
				if (msg.details !== null) {
					gitGraph.renderTagDetails(msg.tagName, msg.commitHash, msg.details);
				} else {
					dialog.showError(t('Unable to retrieve Tag Details'), msg.error, null, null);
				}
				break;
			case 'updateCodeReview':
				if (msg.error !== null) {
					dialog.showError(t('Unable to update Code Review'), msg.error, null, null);
				}
				break;
			case 'viewDiff':
				finishOrDisplayError(msg.error, t('Unable to View Diff'));
				break;
			case 'viewDiffWithWorkingFile':
				finishOrDisplayError(msg.error, t('Unable to View Diff with Working File'));
				break;
			case 'viewFileAtRevision':
				finishOrDisplayError(msg.error, t('Unable to View File at Revision'));
				break;
			case 'viewScm':
				finishOrDisplayError(msg.error, t('Unable to open the Source Control View'));
				break;
		}
	});

	function handleResponseDeleteBranch(msg: GG.ResponseDeleteBranch) {
		if (msg.errors.length > 0 && msg.errors[0] !== null && msg.errors[0].includes('git branch -D')) {
			dialog.asDangerous().showConfirmation(t('The branch <b><i>{0}</i></b> is not fully merged. Would you like to force delete it?', escapeHtml(msg.branchName)), t('Yes, force delete branch'), () => {
				runAction({ command: 'deleteBranch', repo: msg.repo, branchName: msg.branchName, forceDelete: true, deleteOnRemotes: msg.deleteOnRemotes }, t('Deleting Branch'));
			}, { type: TargetType.Repo });
		} else {
			refreshAndDisplayErrors(msg.errors, t('Unable to Delete Branch'));
		}
	}

	function handleResponsePushTagCommitNotOnRemote(repo: string, tagName: string, remotes: string[], commitHash: string, error: string) {
		const remotesNotContainingCommit: string[] = parseExtensionErrorInfo(error, GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote);

		const html = '<span class="dialogAlert">' + SVG_ICONS.alert + (remotesNotContainingCommit.length > 1 ? t('Warning: Commit is not on Remotes') : t('Warning: Commit is not on Remote')) + ' </span><br>' +
			'<span class="messageContent">' +
			'<p style="margin:0 0 6px 0;">' + t('The tag <b><i>{0}</i></b> is on a commit that isn\'t on any known branch on the remote{1} {2}.', escapeHtml(tagName), (remotesNotContainingCommit.length > 1 ? 's' : ''), formatCommaSeparatedList(remotesNotContainingCommit.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'<p style="margin:0;">' + t('Would you like to proceed to push the tag to the remote{0} {1} anyway?', (remotes.length > 1 ? 's' : ''), formatCommaSeparatedList(remotes.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'</span>';

		dialog.showForm(html, [{ type: DialogInputType.Checkbox, name: t('Always Proceed'), value: false }], t('Proceed to Push'), (values) => {
			if (<boolean>values[0]) {
				updateGlobalViewState('pushTagSkipRemoteCheck', true);
			}
			runAction({
				command: 'pushTag',
				repo: repo,
				tagName: tagName,
				remotes: remotes,
				commitHash: commitHash,
				skipRemoteCheck: true
			}, t('Pushing Tag'));
		}, { type: TargetType.Repo }, t('Cancel'), null);
	}

	function refreshOrDisplayError(error: GG.ErrorInfo, errorMessage: string, configChanges: boolean = false) {
		if (error === null) {
			gitGraph.refresh(false, configChanges);
		} else {
			dialog.showError(errorMessage, error, null, null);
		}
	}

	function refreshAndDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, configChanges: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		if (reducedErrors.error !== null) {
			dialog.showError(errorMessage, reducedErrors.error, null, null);
		}
		if (reducedErrors.partialOrCompleteSuccess) {
			gitGraph.refresh(false, configChanges);
		} else if (configChanges) {
			gitGraph.requestLoadConfig();
		}
	}

	function finishOrDisplayError(error: GG.ErrorInfo, errorMessage: string, dismissActionRunning: boolean = false) {
		if (error !== null) {
			dialog.showError(errorMessage, error, null, null);
		} else if (dismissActionRunning) {
			dialog.closeActionRunning();
		}
	}

	function finishOrDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, partialOrCompleteSuccessCallback: () => void, dismissActionRunning: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		finishOrDisplayError(reducedErrors.error, errorMessage, dismissActionRunning);
		if (reducedErrors.partialOrCompleteSuccess) {
			partialOrCompleteSuccessCallback();
		}
	}

	function reduceErrorInfos(errors: GG.ErrorInfo[]) {
		let error: GG.ErrorInfo = null, partialOrCompleteSuccess = false;
		for (let i = 0; i < errors.length; i++) {
			if (errors[i] !== null) {
				error = error !== null ? error + '\n\n' + errors[i] : errors[i];
			} else {
				partialOrCompleteSuccess = true;
			}
		}

		return {
			error: error,
			partialOrCompleteSuccess: partialOrCompleteSuccess
		};
	}

	/**
	 * Checks whether the given ErrorInfo has an ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to check.
	 * @param prefix The ErrorInfoExtensionPrefix to test.
	 * @returns TRUE => ErrorInfo has the ErrorInfoExtensionPrefix, FALSE => ErrorInfo doesn\'t have the ErrorInfoExtensionPrefix
	 */
	function isExtensionErrorInfo(error: GG.ErrorInfo, prefix: GG.ErrorInfoExtensionPrefix) {
		return error !== null && error.startsWith(prefix);
	}

	/**
	 * Parses the JSON data from an ErrorInfo prefixed by the provided ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to parse.
	 * @param prefix The ErrorInfoExtensionPrefix used by `error`.
	 * @returns The parsed JSON data.
	 */
	function parseExtensionErrorInfo(error: string, prefix: GG.ErrorInfoExtensionPrefix) {
		return JSON.parse(error.substring(prefix.length));
	}
}
