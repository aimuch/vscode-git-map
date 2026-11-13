/**
 * Compares two branches in the Git Map View ("Compare with Branch…"): a bar below the control bar shows the branches, their merge base and
 * how many commits each has that the other doesn't, the graph shows only those commits (marked with the colour of their branch), and a
 * panel docked on the right lists the files changed on the first branch since it diverged from the second (what merging it would bring in).
 */
class BranchCompare {
	private readonly view: GitGraphView;
	private left: string | null = null;
	private right: string | null = null;
	private comparison: GG.GitBranchComparison | null = null;
	private fileChanges: ReadonlyArray<GG.GitFileChange> = [];
	private mode: 'left' | 'right' | 'both' = 'both';
	private previousBranches: string[] | null | undefined = undefined; // The branches shown before the comparison started (undefined => not comparing)
	private panelOpen: boolean = false;
	private readonly sides: Map<string, 'left' | 'right' | 'base'> = new Map();

	private static readonly PANEL_WIDTH = 380;

	/**
	 * Construct a new BranchCompare instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		document.getElementById('compareBar')!.addEventListener('click', (e) => {
			const target = e.target instanceof Element ? <HTMLElement | null>e.target.closest('[data-compare]') : null;
			if (target === null) return;
			switch (target.dataset.compare) {
				case 'swap':
					if (this.left !== null && this.right !== null) this.start(this.right, this.left);
					break;
				case 'left': case 'right': case 'both':
					this.setMode(target.dataset.compare);
					break;
				case 'files':
					this.setPanelOpen(!this.panelOpen);
					break;
				case 'exit':
					this.exit();
					break;
			}
		});
	}

	/**
	 * Ask which branch a branch is compared with, and compare them.
	 * @param refName The name of the branch (a remote branch includes the name of its remote, e.g. "origin/main").
	 * @param target The target of the dialog.
	 */
	public chooseAndCompare(refName: string, target: DialogTarget | null) {
		const names = this.view.gitBranches.map((branch) => branch.startsWith('remotes/') ? branch.substring(8) : branch).filter((name, index, all) => name !== refName && all.indexOf(name) === index && !/\/HEAD$/.test(name));
		if (names.length === 0) {
			dialog.showError(t('Unable to Compare Branches'), t('There isn\'t another branch to compare with.'), null, null);
			return;
		}
		const head = this.view.gitBranchHead;
		const defaultName = head !== null && head !== refName && names.includes(head) ? head : ['main', 'master', 'origin/main', 'origin/master'].find((name) => names.includes(name)) || names[0];
		dialog.showSelect(t('Compare <b><i>{0}</i></b> with the branch:', escapeHtml(refName)), defaultName, names.map((name) => ({ name: name, value: name })), t('Compare'), (other) => this.start(refName, other), target);
	}

	/**
	 * Compare two branches (only the two branches are shown on the graph while they're compared).
	 * @param left The branch whose changes are shown (e.g. the branch that would be merged).
	 * @param right The branch it's compared with (e.g. the branch it would be merged into).
	 */
	public start(left: string, right: string) {
		if (this.previousBranches === undefined) this.previousBranches = this.view.getShownBranches();
		this.left = left;
		this.right = right;
		this.comparison = null;
		this.fileChanges = [];
		this.sides.clear();
		this.view.setCompareFilter(null);
		this.view.setShownBranches([this.getDropdownValue(left), this.getDropdownValue(right)]);
		this.render();
		sendMessage({ command: 'compareBranches', repo: this.view.currentRepo, left: left, right: right });
	}

	/**
	 * Process the comparison of two branches loaded by the extension.
	 * @param msg The message containing the comparison.
	 */
	public processCompareBranchesResponse(msg: GG.ResponseCompareBranches) {
		if (this.previousBranches === undefined || msg.comparison === null || msg.comparison.left !== this.left || msg.comparison.right !== this.right) {
			if (msg.error !== null && this.previousBranches !== undefined) {
				dialog.showError(t('Unable to Compare Branches'), msg.error, null, null);
				this.exit();
			}
			return;
		}
		this.comparison = msg.comparison;
		this.fileChanges = msg.fileChanges;
		this.sides.clear();
		msg.comparison.leftOnly.forEach((hash) => this.sides.set(hash, 'left'));
		msg.comparison.rightOnly.forEach((hash) => this.sides.set(hash, 'right'));
		if (msg.comparison.mergeBase !== null) this.sides.set(msg.comparison.mergeBase, 'base');
		this.mode = 'both';
		this.applyFilter();
		this.render();
		this.setPanelOpen(true);
	}

	/**
	 * Stop comparing the branches, showing the branches that were shown before.
	 */
	public exit() {
		if (this.previousBranches === undefined) return;
		const previousBranches = this.previousBranches;
		this.previousBranches = undefined;
		this.left = this.right = this.comparison = null;
		this.fileChanges = [];
		this.sides.clear();
		this.setPanelOpen(false);
		this.render();
		this.view.setCompareFilter(null);
		this.view.setShownBranches(previousBranches);
	}

	/**
	 * Stop comparing the branches without reloading the view (e.g. when another repository is loaded).
	 */
	public reset() {
		this.previousBranches = undefined;
		this.left = this.right = this.comparison = null;
		this.sides.clear();
		this.setPanelOpen(false);
		this.render();
	}

	/**
	 * Are branches being compared.
	 */
	public isActive() {
		return this.previousBranches !== undefined;
	}

	/**
	 * Get the class of the row of a commit (marking the branch it's on, while branches are compared).
	 * @param hash The hash of the commit.
	 * @returns The class (with a leading space), or an empty string.
	 */
	public getRowClass(hash: string) {
		const side = this.sides.get(hash);
		return side === 'left' ? ' compareLeft' : side === 'right' ? ' compareRight' : side === 'base' ? ' compareBase' : '';
	}

	/**
	 * Get the HTML of the label of the merge base, shown before the message of the commit.
	 * @param hash The hash of the commit.
	 */
	public getRowLabelHtml(hash: string) {
		return this.sides.get(hash) === 'base' ? '<span class="compareBaseLabel">' + t('merge base') + '</span>' : '';
	}

	/**
	 * Close the panel of the changed files (e.g. when the details of a commit are opened, which are docked in the same place).
	 */
	public closePanel() {
		if (this.panelOpen) this.setPanelOpen(false);
	}

	/**
	 * Show only the commits of the branch (or branches) chosen.
	 */
	private setMode(mode: 'left' | 'right' | 'both') {
		this.mode = mode;
		this.applyFilter();
		this.render();
	}

	private applyFilter() {
		if (this.comparison === null) return;
		const hashes = new Set<string>(this.mode === 'left' ? this.comparison.leftOnly : this.mode === 'right' ? this.comparison.rightOnly : this.comparison.leftOnly.concat(this.comparison.rightOnly));
		if (this.comparison.mergeBase !== null) hashes.add(this.comparison.mergeBase);
		this.view.setCompareFilter(hashes);
	}

	/**
	 * Get the value of a branch in the Branches dropdown (remote branches are prefixed by "remotes/").
	 */
	private getDropdownValue(name: string) {
		return this.view.gitBranches.includes(name) ? name : this.view.gitBranches.includes('remotes/' + name) ? 'remotes/' + name : name;
	}

	/**
	 * Render the bar of the comparison.
	 */
	private render() {
		const elem = document.getElementById('compareBar')!;
		alterClass(elem, CLASS_ACTIVE, this.previousBranches !== undefined);
		if (this.previousBranches === undefined || this.left === null || this.right === null) {
			elem.innerHTML = '';
			return;
		}
		const comparison = this.comparison;
		const segment = (mode: string, label: string, count: number | null) => '<button type="button" class="compareSegment" data-compare="' + mode + '" aria-pressed="' + (this.mode === mode) + '">' + label + (count !== null ? ' <b>' + count + '</b>' : '') + '</button>';
		elem.innerHTML = SVG_ICONS.compare + '<b class="compareTitle">' + t('Comparing') + '</b>' +
			'<span class="compareBranch left" title="' + escapeHtml(this.left) + '"><i></i>' + escapeHtml(this.left) + '</span>' +
			'<button type="button" class="compareIconBtn" data-compare="swap" title="' + t('Swap the branches') + '" aria-label="' + t('Swap the branches') + '"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2 5h11l-3-3M14 11H3l3 3"/></svg></button>' +
			'<span class="compareBranch right" title="' + escapeHtml(this.right) + '"><i></i>' + escapeHtml(this.right) + '</span>' +
			(comparison === null
				? '<span class="compareMuted">' + SVG_ICONS.loading + t('Loading') + ELLIPSIS + '</span>'
				: '<span class="compareMuted">' + (comparison.mergeBase !== null ? t('Merge base {0}', '<span class="compareHash">' + abbrevCommit(comparison.mergeBase) + '</span>') : t('No common ancestor')) + '</span>' +
				'<span class="compareSegments" role="group" aria-label="' + t('Commits shown') + '">' +
				segment('left', t('Only in {0}', escapeHtml(this.left)), comparison.leftOnly.length) +
				segment('right', t('Only in {0}', escapeHtml(this.right)), comparison.rightOnly.length) +
				segment('both', t('Both'), comparison.leftOnly.length + comparison.rightOnly.length) + '</span>') +
			'<span class="compareSpacer"></span>' +
			(comparison !== null ? '<button type="button" class="compareBtn' + (this.panelOpen ? ' ' + CLASS_ACTIVE : '') + '" data-compare="files">' + SVG_ICONS.fileList + t('Changed Files') + ' <b>' + this.fileChanges.length + '</b></button>' : '') +
			'<button type="button" class="compareBtn" data-compare="exit">' + SVG_ICONS.close + t('Exit Comparison') + '</button>';
	}

	/**
	 * Open or close the panel of the changed files.
	 */
	private setPanelOpen(open: boolean) {
		let panel = document.getElementById('comparePanel');
		this.panelOpen = open && this.comparison !== null;
		if (!this.panelOpen) {
			if (panel !== null) {
				panel.remove();
				if (this.view.expandedCommit === null || !this.view.isCdvDocked()) this.view.viewElem.style.right = '';
			}
			this.render();
			return;
		}
		if (this.view.expandedCommit !== null) this.view.closeCommitDetails(true);
		if (panel === null) {
			panel = document.createElement('aside');
			panel.id = 'comparePanel';
			panel.setAttribute('aria-label', t('Branch comparison'));
			panel.style.width = BranchCompare.PANEL_WIDTH + 'px';
			document.body.appendChild(panel);
			panel.addEventListener('click', (e) => this.onPanelClick(e));
		}
		this.view.viewElem.style.right = BranchCompare.PANEL_WIDTH + 'px';
		this.renderPanel(panel);
		this.render();
	}

	private renderPanel(panel: HTMLElement) {
		const comparison = this.comparison;
		if (comparison === null || this.left === null || this.right === null) return;
		const additions = this.fileChanges.reduce((sum, file) => sum + (file.additions || 0), 0), deletions = this.fileChanges.reduce((sum, file) => sum + (file.deletions || 0), 0);
		const canCreatePullRequest = this.view.gitRepos[this.view.currentRepo].pullRequestConfig !== null && this.view.gitBranches.includes(this.left);
		panel.innerHTML = '<div class="comparePanelHeader"><b>' + escapeHtml(this.left) + ' ↔ ' + escapeHtml(this.right) + '</b><button type="button" class="compareIconBtn" data-panel="close" aria-label="' + t('Close') + '" title="' + t('Close') + '">' + SVG_ICONS.close + '</button></div>' +
			'<p class="comparePanelText">' + (comparison.mergeBase !== null
			? t('The changes on <b>{0}</b> since it diverged from <b>{1}</b> (what merging it would bring in).', escapeHtml(this.left), escapeHtml(this.right))
			: t('The differences between <b>{0}</b> and <b>{1}</b> (they don\'t have a common ancestor).', escapeHtml(this.left), escapeHtml(this.right))) + '</p>' +
			'<div class="comparePanelChips"><span>↑ ' + t('{0} ahead', comparison.leftOnly.length) + '</span><span>↓ ' + t('{0} behind', comparison.rightOnly.length) + '</span>' +
			'<span>' + (this.fileChanges.length !== 1 ? t('{0} files', this.fileChanges.length) : t('{0} file', this.fileChanges.length)) + ' <span class="fileTreeFileAdd">+' + additions + '</span> <span class="fileTreeFileDel">−' + deletions + '</span></span></div>' +
			'<div class="comparePanelFiles">' + (this.fileChanges.length > 0 ? this.fileChanges.map((file, index) => {
			const slash = file.newFilePath.lastIndexOf('/');
			return '<button type="button" class="comparePanelFile" data-index="' + index + '" title="' + escapeHtml(file.newFilePath) + '"><span class="comparePanelStatus status' + file.type + '">' + file.type + '</span>' +
					'<span class="comparePanelFileName">' + escapeHtml(file.newFilePath.substring(slash + 1)) + ' <span>' + escapeHtml(file.type === GG.GitFileStatus.Renamed ? t('{0} (from {1})', file.newFilePath.substring(0, slash + 1), file.oldFilePath) : file.newFilePath.substring(0, slash + 1)) + '</span></span>' +
					(file.additions !== null && file.deletions !== null ? '<span class="comparePanelStats"><span class="fileTreeFileAdd">+' + file.additions + '</span> <span class="fileTreeFileDel">−' + file.deletions + '</span></span>' : '') + '</button>';
		}).join('') : '<div class="comparePanelEmpty">' + t('No files are changed.') + '</div>') + '</div>' +
			'<div class="comparePanelActions">' +
			(this.fileChanges.length > 0 ? '<button type="button" class="cdvActionBtn primary" data-panel="openAll">' + t('Open All Changes') + '</button>' : '') +
			(canCreatePullRequest ? '<button type="button" class="cdvActionBtn" data-panel="pullRequest">' + t('Create Pull Request') + ELLIPSIS + '</button>' : '') +
			'<button type="button" class="cdvActionBtn" data-panel="copy">' + t('Copy Summary') + '</button></div>';
	}

	private onPanelClick(e: MouseEvent) {
		const comparison = this.comparison;
		if (comparison === null || this.left === null || this.right === null || !(e.target instanceof Element)) return;
		const fileElem = <HTMLElement | null>e.target.closest('.comparePanelFile'), actionElem = <HTMLElement | null>e.target.closest('[data-panel]');
		const fromHash = comparison.mergeBase !== null ? comparison.mergeBase : comparison.rightHash;
		if (fileElem !== null) {
			const file = this.fileChanges[parseInt(fileElem.dataset.index!)];
			if (typeof file === 'undefined') return;
			sendMessage({ command: 'viewDiff', repo: this.view.currentRepo, fromHash: fromHash, toHash: comparison.leftHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath, type: file.type });
		} else if (actionElem !== null) {
			switch (actionElem.dataset.panel) {
				case 'close':
					this.setPanelOpen(false);
					break;
				case 'openAll':
					sendMessage({ command: 'openAllChanges', repo: this.view.currentRepo, title: this.left + ' ↔ ' + this.right, fromHash: fromHash, toHash: comparison.leftHash, fileChanges: this.fileChanges });
					break;
				case 'pullRequest': {
					const config = this.view.gitRepos[this.view.currentRepo].pullRequestConfig;
					if (config === null) return;
					const branch = this.left;
					dialog.showCheckbox(t('Are you sure you want to create a Pull Request for branch <b><i>{0}</i></b>?', escapeHtml(branch)), t('Push branch before creating the Pull Request'), true, t('Yes, create Pull Request'), (push) => {
						runAction({ command: 'createPullRequest', repo: this.view.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: branch, push: push }, t('Creating Pull Request'));
					}, null);
					break;
				}
				case 'copy':
					sendMessage({ command: 'copyToClipboard', type: t('Summary'), data: this.getSummary() });
					break;
			}
		}
	}

	/**
	 * Get a text summary of the comparison (copied to the clipboard).
	 */
	private getSummary() {
		const comparison = this.comparison!, commits = this.view.getLoadedCommits();
		const subject = (hash: string) => {
			const commit = commits.find((commit) => commit.hash === hash);
			return abbrevCommit(hash) + (typeof commit !== 'undefined' ? ' ' + commit.message : '');
		};
		return [
			this.left + ' ↔ ' + this.right + (comparison.mergeBase !== null ? ' (' + t('Merge base {0}', abbrevCommit(comparison.mergeBase)) + ')' : ''),
			'',
			t('Only in {0}', this.left!) + ' (' + comparison.leftOnly.length + '):',
			...comparison.leftOnly.map((hash) => '- ' + subject(hash)),
			'',
			t('Only in {0}', this.right!) + ' (' + comparison.rightOnly.length + '):',
			...comparison.rightOnly.map((hash) => '- ' + subject(hash)),
			'',
			t('Changed Files') + ' (' + this.fileChanges.length + '):',
			...this.fileChanges.map((file) => file.type + ' ' + (file.type === GG.GitFileStatus.Renamed ? file.oldFilePath + ' → ' : '') + file.newFilePath + (file.additions !== null && file.deletions !== null ? ' (+' + file.additions + ' −' + file.deletions + ')' : ''))
		].join('\n');
	}
}
