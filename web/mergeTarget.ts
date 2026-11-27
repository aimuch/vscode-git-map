/**
 * Implements "Merge Target…" (in the context menu of a branch): the branch that a branch's work is meant to be merged into (the default
 * branch, unless another branch is chosen for it), how many commits each has that the other doesn't, and whether the branch's work has
 * already landed in it (merged, rebased or squashed into it). The merge target is also used to explain the changes of the branch.
 */
class MergeTarget {
	private readonly view: GitGraphView;
	private pending: { readonly repo: string, readonly branch: string, readonly target: DialogTarget | null } | null = null;

	/**
	 * Construct a new MergeTarget instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
	}

	/**
	 * Open the Merge Target dialog of a local branch.
	 * @param branch The branch.
	 * @param target The target of the dialog.
	 */
	public open(branch: string, target: DialogTarget | null) {
		this.pending = { repo: this.view.currentRepo, branch: branch, target: target };
		dialog.showActionRunning(t('Loading Merge Target'));
		sendMessage({ command: 'loadMergeTargetStatus', repo: this.view.currentRepo, branch: branch });
	}

	/**
	 * Process the status of a branch compared with its merge target, showing the Merge Target dialog.
	 * @param msg The message.
	 */
	public processLoadMergeTargetStatusResponse(msg: GG.ResponseLoadMergeTargetStatus) {
		const pending = this.pending;
		if (pending === null || pending.repo !== msg.repo || pending.branch !== msg.branch || msg.repo !== this.view.currentRepo) return;
		this.pending = null;
		if (msg.error !== null || msg.status === null) {
			dialog.showError(t('Unable to Load the Merge Target'), msg.error, null, null);
			return;
		}
		const status = msg.status, branch = escapeHtml(status.branch);
		const lines: string[] = [];
		if (status.target === null) {
			lines.push(t('<b><i>{0}</i></b> has no merge target: the repository has no default branch. Choose the branch its work is meant to be merged into.', branch));
		} else {
			const targetHtml = '<b><i>' + escapeHtml(status.target) + '</i></b>';
			lines.push(t('The work of <b><i>{0}</i></b> is meant to be merged into {1} ({2}).', branch, targetHtml, status.chosen ? t('chosen for this branch') : t('the default branch')));
			if (status.landed !== null) {
				lines.push('<span class="mergeTargetLanded">' + SVG_ICONS.check + (status.landed === 'squashed'
					? t('Its work has landed in {0}: it was squashed into one commit.', targetHtml)
					: status.landed === 'rebased' ? t('Its work has landed in {0}: it was rebased onto it.', targetHtml)
						: t('Its work has landed in {0}: it\'s merged.', targetHtml)) + ' ' + t('The branch can be deleted.') + '</span>');
			}
			if (status.landed !== 'merged') {
				lines.push(t('{0} ahead · {1} behind {2}', '<b>' + status.ahead + '</b>', '<b>' + status.behind + '</b>', targetHtml));
			}
		}
		lines.push(t('Merge target:'));
		const options: DialogSelectInputOption[] = [{ name: t('Default Branch'), value: '' }];
		this.view.gitBranches.forEach((name) => {
			if (name === status.branch || name.endsWith('/HEAD')) return;
			const display = name.startsWith('remotes/') ? name.substring(8) : name;
			options.push({ name: display, value: display });
		});
		dialog.showSelect(lines.join('<br>'), status.chosen && status.target !== null ? status.target : '', options, t('Save Merge Target'), (value) => {
			runAction({ command: 'setMergeTarget', repo: pending.repo, branch: status.branch, target: value === '' ? null : value }, t('Saving Merge Target'));
		}, pending.target);
	}
}
