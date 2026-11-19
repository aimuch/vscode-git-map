/**
 * Drag-and-drop controller for dragging branch pills and commit rows onto target commits in Git Map.
 */
class GraphDragDropController {
	private readonly view: GitGraphView;
	private payload: { kind: 'branch', branch: string, sourceHash: string } | { kind: 'commit', hash: string } | null = null;

	constructor(view: GitGraphView) {
		this.view = view;
	}

	public observe(tableElem: HTMLElement) {
		const clearTargets = () => {
			const targets = tableElem.getElementsByClassName('dragDropTarget');
			while (targets.length > 0) {
				targets[0].classList.remove('dragDropTarget');
			}
		};

		tableElem.addEventListener('dragstart', (e: DragEvent) => {
			if (!(e.target instanceof Element)) return;
			const refElem = <HTMLElement | null>e.target.closest('.gitRef.head');
			if (refElem !== null) {
				const commitElem = <HTMLElement | null>refElem.closest('.commit');
				const commit = commitElem !== null ? this.view.getCommitOfElem(commitElem) : null;
				if (commit === null || typeof refElem.dataset.name !== 'string') {
					e.preventDefault();
					return;
				}
				const branch = unescapeHtml(refElem.dataset.name);
				this.payload = { kind: 'branch', branch: branch, sourceHash: commit.hash };
				if (e.dataTransfer !== null) {
					e.dataTransfer.effectAllowed = 'move';
					e.dataTransfer.setData('text/plain', branch);
				}
				return;
			}
			const commitElem = <HTMLElement | null>e.target.closest('.commit');
			const commit = commitElem !== null ? this.view.getCommitOfElem(commitElem) : null;
			if (commit === null || commit.hash === UNCOMMITTED || commit.stash !== null) {
				e.preventDefault();
				return;
			}
			this.payload = { kind: 'commit', hash: commit.hash };
			if (e.dataTransfer !== null) {
				e.dataTransfer.effectAllowed = 'copyMove';
				e.dataTransfer.setData('text/plain', commit.hash);
			}
		});

		tableElem.addEventListener('dragover', (e: DragEvent) => {
			if (this.payload === null || !(e.target instanceof Element)) return;
			const commitElem = <HTMLElement | null>e.target.closest('.commit');
			const commit = commitElem !== null ? this.view.getCommitOfElem(commitElem) : null;
			clearTargets();
			if (commitElem === null || commit === null || commit.hash === UNCOMMITTED || commit.stash !== null) return;
			const sameSource = (this.payload.kind === 'branch' && this.payload.sourceHash === commit.hash)
				|| (this.payload.kind === 'commit' && this.payload.hash === commit.hash);
			if (sameSource) return;
			e.preventDefault();
			if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
			commitElem.classList.add('dragDropTarget');
		});

		tableElem.addEventListener('dragleave', (e: DragEvent) => {
			if (e.relatedTarget instanceof Node && tableElem.contains(e.relatedTarget)) return;
			clearTargets();
		});

		tableElem.addEventListener('dragend', () => {
			clearTargets();
			this.payload = null;
		});

		tableElem.addEventListener('drop', (e: DragEvent) => {
			clearTargets();
			const payload = this.payload;
			this.payload = null;
			if (payload === null || !(e.target instanceof Element)) return;
			const commitElem = <HTMLElement | null>e.target.closest('.commit');
			const targetCommit = commitElem !== null ? this.view.getCommitOfElem(commitElem) : null;
			if (commitElem === null || targetCommit === null || targetCommit.hash === UNCOMMITTED || targetCommit.stash !== null) return;
			e.preventDefault();

			const target: ContextMenuTarget & DialogTarget & CommitTarget = {
				type: TargetType.Commit,
				hash: targetCommit.hash,
				index: parseInt(commitElem.dataset.id!),
				elem: commitElem
			};

			if (payload.kind === 'branch') {
				if (payload.sourceHash === targetCommit.hash) return;
				const isCurrentBranch = payload.branch === this.view.gitBranchHead;
				contextMenu.show([
					[
						{
							title: t('Move Branch "{0}" Here', payload.branch) + ELLIPSIS,
							icon: MENU_ICONS.branch,
							visible: !isCurrentBranch,
							onClick: () => {
								dialog.asDangerous().showConfirmation(t('Move branch <b><i>{0}</i></b> to commit <b><i>{1}</i></b>?', escapeHtml(payload.branch), abbrevCommit(targetCommit.hash)), t('Move Branch'), () => {
									runAction({ command: 'moveBranch', repo: this.view.currentRepo, branchName: payload.branch, targetHash: targetCommit.hash }, t('Moving Branch'));
								}, target);
							}
						},
						{
							title: t('Merge "{0}" into Current Branch', payload.branch) + ELLIPSIS,
							icon: MENU_ICONS.merge,
							visible: !isCurrentBranch && this.view.gitBranchHead !== null && targetCommit.hash === this.view.commitHead,
							onClick: () => this.view.actions.mergeAction(payload.branch, payload.branch, GG.MergeActionOn.Branch, target)
						},
						{
							title: t('Reset Current Branch Here') + ELLIPSIS,
							icon: MENU_ICONS.reset,
							visible: isCurrentBranch,
							onClick: () => {
								dialog.asDangerous().showSelect(t('Are you sure you want to reset {0} to commit <b><i>{1}</i></b>?', (this.view.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.view.gitBranchHead)) : t('the current branch')), abbrevCommit(targetCommit.hash)), this.view.config.dialogDefaults.resetCommit.mode, [
									{ name: t('Soft - Keep all changes, but reset head'), value: GG.GitResetMode.Soft },
									{ name: t('Mixed - Keep working tree, but reset index'), value: GG.GitResetMode.Mixed },
									{ name: t('Hard - Discard all changes'), value: GG.GitResetMode.Hard }
								], t('Yes, reset'), (mode) => {
									runAction({ command: 'resetToCommit', repo: this.view.currentRepo, commit: targetCommit.hash, resetMode: <GG.GitResetMode>mode }, t('Resetting to Commit'));
								}, target);
							}
						},
						{
							title: t('Rebase Current Branch onto {0}', abbrevCommit(targetCommit.hash)) + ELLIPSIS,
							icon: MENU_ICONS.rebase,
							visible: isCurrentBranch,
							onClick: () => this.view.actions.rebaseAction(targetCommit.hash, abbrevCommit(targetCommit.hash), GG.RebaseActionOn.Commit, target)
						},
						{
							title: t('Merge {0} into Current Branch', abbrevCommit(targetCommit.hash)) + ELLIPSIS,
							icon: MENU_ICONS.merge,
							visible: isCurrentBranch,
							onClick: () => this.view.actions.mergeAction(targetCommit.hash, abbrevCommit(targetCommit.hash), GG.MergeActionOn.Commit, target)
						},
						{
							title: t('Compare "{0}" with Target', payload.branch),
							icon: MENU_ICONS.compare,
							visible: targetCommit.heads.length > 0 && targetCommit.heads[0] !== payload.branch,
							onClick: () => this.view.branchCompare.start(payload.branch, targetCommit.heads[0])
						}
					]
				], false, target, e, this.view.viewElem);
			} else {
				if (payload.hash === targetCommit.hash) return;
				const srcIndex = this.view.getCommitId(payload.hash);
				const srcCommit = srcIndex !== null ? this.view.getCommits()[srcIndex] : null;
				const srcElem = srcIndex !== null ? this.view.getCommitElem(srcIndex) : null;
				contextMenu.show([
					[
						{
							title: t('Cherry Pick {0} onto Current Branch', abbrevCommit(payload.hash)) + ELLIPSIS,
							icon: MENU_ICONS.cherrypick,
							visible: srcCommit !== null,
							onClick: () => {
								if (srcCommit !== null) this.view.actions.cherrypickCommitsAction([srcCommit], target);
							}
						},
						{
							title: t('Compare {0} with {1}', abbrevCommit(payload.hash), abbrevCommit(targetCommit.hash)),
							icon: MENU_ICONS.compare,
							visible: srcElem !== null,
							onClick: () => {
								if (srcElem !== null) this.view.openCommitComparison(srcElem, commitElem);
							}
						},
						{
							title: t('Rebase Current Branch onto {0}', abbrevCommit(targetCommit.hash)) + ELLIPSIS,
							icon: MENU_ICONS.rebase,
							visible: this.view.gitBranchHead !== null && targetCommit.hash !== this.view.commitHead,
							onClick: () => this.view.actions.rebaseAction(targetCommit.hash, abbrevCommit(targetCommit.hash), GG.RebaseActionOn.Commit, target)
						}
					]
				], false, target, e, this.view.viewElem);
			}
		});
	}
}
