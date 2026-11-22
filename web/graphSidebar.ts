/**
 * Collapsible left workbench sidebar inside the Git Map View:
 * displays Pinned Branches, Local Branches, Remotes, Tags, Stashes, and Worktrees (with live WIP badges)
 * with instant filtering, pinning, jump-to-ref, and worktree WIP inspection.
 */
class GraphSidebar {
	private readonly view: GitGraphView;
	private readonly elem: HTMLElement;
	private open: boolean = false;
	private filterText: string = '';
	private pinnedBranches: Set<string> = new Set();
	private readonly collapsedSections: Set<string> = new Set(['remotes', 'tags']);

	constructor(view: GitGraphView) {
		this.view = view;
		this.elem = document.createElement('aside');
		this.elem.id = 'graphSidebar';
		this.elem.setAttribute('aria-label', t('Repository Navigation'));
		document.body.appendChild(this.elem);

		this.elem.addEventListener('input', (e) => {
			const input = (<Element>e.target).closest<HTMLInputElement>('#graphSidebarFilter');
			if (input !== null) {
				this.filterText = input.value;
				this.renderSections();
			}
		});

		this.elem.addEventListener('click', (e) => {
			const target = <Element>e.target;

			const closeBtn = target.closest('[data-sidebar-action="close"]');
			if (closeBtn !== null) {
				this.setOpen(false);
				return;
			}

			const toggleSec = target.closest<HTMLElement>('[data-sidebar-section]');
			if (toggleSec !== null) {
				const sec = toggleSec.dataset.sidebarSection!;
				if (this.collapsedSections.has(sec)) this.collapsedSections.delete(sec);
				else this.collapsedSections.add(sec);
				this.renderSections();
				return;
			}

			const pinBtn = target.closest<HTMLElement>('[data-sidebar-pin]');
			if (pinBtn !== null) {
				e.stopPropagation();
				const branch = pinBtn.dataset.sidebarPin!;
				if (this.pinnedBranches.has(branch)) this.pinnedBranches.delete(branch);
				else this.pinnedBranches.add(branch);
				sendMessage({ command: 'togglePinBranch', repo: this.view.currentRepo, branch: branch });
				this.renderSections();
				return;
			}

			const wtWipBtn = target.closest<HTMLElement>('[data-sidebar-wt-wip]');
			if (wtWipBtn !== null) {
				e.stopPropagation();
				const wtPath = wtWipBtn.dataset.sidebarWtWip!;
				const wt = this.view.worktreeList.getWorktrees().find((w) => w.path === wtPath);
				if (typeof wt !== 'undefined') this.view.openWorktreeWipInspector(wt);
				return;
			}

			const wtOpenBtn = target.closest<HTMLElement>('[data-sidebar-wt-open]');
			if (wtOpenBtn !== null) {
				e.stopPropagation();
				const wtPath = wtOpenBtn.dataset.sidebarWtOpen!;
				sendMessage({ command: 'openWorktree', path: wtPath });
				return;
			}

			const branchRow = target.closest<HTMLElement>('[data-sidebar-branch]');
			if (branchRow !== null) {
				const branch = branchRow.dataset.sidebarBranch!;
				this.view.focusBranchOrRef(branch, branchRow.dataset.sidebarRemote === '1');
				return;
			}

			const tagRow = target.closest<HTMLElement>('[data-sidebar-tag]');
			if (tagRow !== null) {
				this.view.focusTag(tagRow.dataset.sidebarTag!);
				return;
			}

			const stashRow = target.closest<HTMLElement>('[data-sidebar-stash]');
			if (stashRow !== null) {
				const hash = stashRow.dataset.sidebarStash!;
				this.view.scrollToCommitHash(hash, true);
				return;
			}
		});

		this.elem.addEventListener('contextmenu', (e: MouseEvent) => {
			if (!(e.target instanceof Element)) return;
			const branchRow = e.target.closest<HTMLElement>('[data-sidebar-branch]');
			if (branchRow !== null) {
				handledEvent(e);
				const branch = branchRow.dataset.sidebarBranch!;
				const isRemote = branchRow.dataset.sidebarRemote === '1';
				const clean = isRemote ? branch.replace(/^remotes\//, '') : branch;
				const matchedCommit = this.view.getCommits().find((c) =>
					isRemote ? c.remotes.some((r) => r.name === clean) : c.heads.includes(clean)
				);
				const commitHash = matchedCommit ? matchedCommit.hash : (this.view.commitHead || '');
				const commitIdx = matchedCommit ? this.view.commitLookup[matchedCommit.hash] : 0;
				const target: ContextMenuTarget & DialogTarget & RefTarget = {
					type: TargetType.Ref,
					hash: commitHash,
					index: typeof commitIdx === 'number' ? commitIdx : 0,
					ref: clean,
					elem: branchRow
				};
				if (isRemote) {
					const slashIdx = clean.indexOf('/');
					const remoteName = slashIdx > 0 ? clean.substring(0, slashIdx) : '';
					if (remoteName !== '') {
						contextMenu.show(this.view.actions.getRemoteBranchContextMenuActions(remoteName, target), false, target, e, this.view.viewElem);
					}
				} else {
					const isPinned = this.pinnedBranches.has(branch);
					const baseActions = this.view.actions.getBranchContextMenuActions(target);
					const pinGroup: ContextMenuActions = [[{
						title: isPinned ? t('Unpin Branch') : t('Pin Branch'),
						icon: MENU_ICONS.branch,
						visible: true,
						onClick: () => {
							if (this.pinnedBranches.has(branch)) this.pinnedBranches.delete(branch);
							else this.pinnedBranches.add(branch);
							sendMessage({ command: 'togglePinBranch', repo: this.view.currentRepo, branch: branch });
							this.renderSections();
						}
					}]];
					contextMenu.show(pinGroup.concat(baseActions), false, target, e, this.view.viewElem);
				}
				return;
			}

			const tagRow = e.target.closest<HTMLElement>('[data-sidebar-tag]');
			if (tagRow !== null) {
				handledEvent(e);
				const tagName = tagRow.dataset.sidebarTag!;
				const matchedCommit = this.view.getCommits().find((c) => c.tags.some((tg) => tg.name === tagName));
				if (typeof matchedCommit !== 'undefined') {
					const tagObj = matchedCommit.tags.find((tg) => tg.name === tagName)!;
					const target: ContextMenuTarget & DialogTarget & RefTarget = {
						type: TargetType.Ref,
						hash: matchedCommit.hash,
						index: this.view.commitLookup[matchedCommit.hash] || 0,
						ref: tagName,
						elem: tagRow
					};
					contextMenu.show(this.view.actions.getTagContextMenuActions(tagObj.annotated, target), false, target, e, this.view.viewElem);
				}
				return;
			}

			const stashRow = e.target.closest<HTMLElement>('[data-sidebar-stash]');
			if (stashRow !== null) {
				handledEvent(e);
				const hash = stashRow.dataset.sidebarStash!;
				const stash = this.view.getStashes().find((s) => s.hash === hash);
				if (typeof stash !== 'undefined') {
					const target: ContextMenuTarget & DialogTarget & RefTarget = {
						type: TargetType.Ref,
						hash: stash.hash,
						index: typeof this.view.commitLookup[stash.hash] === 'number' ? this.view.commitLookup[stash.hash] : 0,
						ref: stash.selector,
						elem: stashRow
					};
					contextMenu.show(this.view.actions.getStashContextMenuActions(target), false, target, e, this.view.viewElem);
				}
			}
		});
	}

	public isOpen() {
		return this.open;
	}

	public toggle() {
		this.setOpen(!this.open);
	}

	public setOpen(open: boolean) {
		if (this.open === open) return;
		this.open = open;
		alterClass(this.elem, CLASS_ACTIVE, this.open);
		alterClass(document.body, 'graphSidebarOpen', this.open);
		const btn = document.getElementById('sidebarToggleBtn');
		if (btn !== null) alterClass(btn, CLASS_ACTIVE, this.open);
		if (this.open) {
			this.render();
		}
		this.view.updateViewInsets();
	}

	public setPinnedBranches(branches: ReadonlyArray<string>) {
		this.pinnedBranches = new Set(branches);
		if (this.open) this.renderSections();
	}

	public getPinnedBranches(): ReadonlyArray<string> {
		return Array.from(this.pinnedBranches);
	}

	public refresh() {
		if (this.open) this.renderSections();
	}

	public render() {
		this.elem.innerHTML =
			'<div class="graphSidebarHeader">' +
				'<span class="graphSidebarTitle">' + MENU_ICONS.branch + '<span>' + t('Navigator') + '</span></span>' +
				'<button type="button" class="graphSidebarCloseBtn" data-sidebar-action="close" title="' + t('Close') + '">' + SVG_ICONS.close + '</button>' +
			'</div>' +
			'<div class="graphSidebarSearchWrap">' +
				'<input id="graphSidebarFilter" class="graphSidebarSearch" type="text" value="' + escapeHtml(this.filterText) + '" placeholder="' + escapeHtml(t('Filter branches, tags, stashes…')) + '"/>' +
			'</div>' +
			'<div id="graphSidebarBody" class="graphSidebarBody"></div>';
		this.renderSections();
	}

	private renderSections() {
		const body = document.getElementById('graphSidebarBody');
		if (body === null) return;
		const q = this.filterText.trim().toLowerCase();
		const matches = (label: string) => q === '' || label.toLowerCase().includes(q);

		const allBranches = this.view.getAllBranchNames();
		const localBranches = allBranches.filter((b) => !b.startsWith('remotes/') && matches(b));
		const remoteBranches = allBranches.filter((b) => b.startsWith('remotes/') && matches(b));
		const pinned = localBranches.filter((b) => this.pinnedBranches.has(b));
		const unpinnedLocal = localBranches.filter((b) => !this.pinnedBranches.has(b));
		const tags = this.view.getAllTagNames().filter((tag) => matches(tag));
		const stashes = this.view.getStashes().filter((s) => matches(s.message + ' ' + s.selector));
		const worktrees = this.view.worktreeList.getWorktrees().filter((w) => matches((w.branch || '') + ' ' + w.path));
		const headBranch = this.view.gitBranchHead;
		const upstreams = this.view.getUpstreams();
		const prBadges = this.view.getPullRequestBadges();

		const wtByBranch = new Map<string, GG.GitWorktree>();
		this.view.worktreeList.getWorktrees().forEach((w) => {
			if (w.branch !== null) wtByBranch.set(w.branch, w);
		});

		const renderBranchItem = (branch: string, isRemote: boolean) => {
			const cleanName = isRemote ? branch.replace(/^remotes\//, '') : branch;
			const isHead = !isRemote && branch === headBranch;
			const isPinned = !isRemote && this.pinnedBranches.has(branch);
			const up = !isRemote ? upstreams[branch] : undefined;
			const pr = !isRemote ? prBadges[branch] : undefined;
			const wt = !isRemote ? wtByBranch.get(branch) : undefined;
			const badges: string[] = [];
			if (up) {
				if (up.gone) badges.push('<span class="gsBadge gsBadgeWarn">' + t('gone') + '</span>');
				else if (up.ahead > 0 || up.behind > 0) {
					badges.push('<span class="gsBadge">' + (up.ahead > 0 ? '↑' + up.ahead : '') + (up.behind > 0 ? '↓' + up.behind : '') + '</span>');
				}
			}
			if (pr) {
				badges.push('<span class="gsBadge gsBadgePr">#' + pr.number + (pr.stackDepth && pr.stackSize && pr.stackSize > 1 ? ' · ' + pr.stackDepth + '/' + pr.stackSize : '') + '</span>');
			}
			if (wt && typeof wt.dirtyCount === 'number' && wt.dirtyCount > 0) {
				badges.push('<span class="gsBadge gsBadgeWip" data-sidebar-wt-wip="' + escapeHtml(wt.path) + '" title="' + escapeHtml(t('Inspect Worktree WIP')) + '">WIP ' + wt.dirtyCount + '</span>');
			}
			return '<div class="gsItem' + (isHead ? ' head' : '') + '" data-sidebar-branch="' + escapeHtml(branch) + '" data-sidebar-remote="' + (isRemote ? '1' : '0') + '" title="' + escapeHtml(cleanName) + '">' +
				'<span class="gsItemIcon">' + (isHead ? '●' : (isRemote ? '☁' : '⎇')) + '</span>' +
				'<span class="gsItemLabel">' + escapeHtml(cleanName) + '</span>' +
				badges.join('') +
				(!isRemote ? '<button type="button" class="gsPinBtn' + (isPinned ? ' pinned' : '') + '" data-sidebar-pin="' + escapeHtml(branch) + '" title="' + escapeHtml(isPinned ? t('Unpin Branch') : t('Pin Branch')) + '">' + (isPinned ? '★' : '☆') + '</button>' : '') +
			'</div>';
		};

		const renderSection = (id: string, title: string, count: number, contentHtml: string) => {
			const collapsed = this.collapsedSections.has(id) && q === '';
			return '<div class="gsSection' + (collapsed ? ' collapsed' : '') + '">' +
				'<div class="gsSectionHeader" data-sidebar-section="' + id + '">' +
					'<span class="gsChevron">' + (collapsed ? '▸' : '▾') + '</span>' +
					'<span class="gsSectionTitle">' + title + '</span>' +
					'<span class="gsSectionCount">' + count + '</span>' +
				'</div>' +
				(collapsed ? '' : '<div class="gsSectionList">' + (contentHtml || '<div class="gsEmpty">' + t('None') + '</div>') + '</div>') +
			'</div>';
		};

		let html = '';
		if (pinned.length > 0) {
			html += renderSection('pinned', t('Pinned'), pinned.length, pinned.map((b) => renderBranchItem(b, false)).join(''));
		}
		html += renderSection('local', t('Branches'), unpinnedLocal.length + pinned.length, localBranches.map((b) => renderBranchItem(b, false)).join(''));
		if (worktrees.length > 0) {
			const wtHtml = worktrees.map((w) => {
				const dirty = typeof w.dirtyCount === 'number' ? w.dirtyCount : 0;
				const label = w.branch !== null ? w.branch : (w.head ? abbrevCommit(w.head) : t('Detached HEAD'));
				return '<div class="gsItem' + (w.isCurrent ? ' head' : '') + '" data-sidebar-wt-wip="' + escapeHtml(w.path) + '" title="' + escapeHtml(w.path) + '">' +
					'<span class="gsItemIcon">⊞</span>' +
					'<span class="gsItemLabel">' + escapeHtml(label) + (w.isCurrent ? ' (' + t('current') + ')' : '') + '</span>' +
					(dirty > 0 ? '<span class="gsBadge gsBadgeWip">WIP ' + dirty + '</span>' : '<span class="gsBadge">' + t('Clean') + '</span>') +
					(!w.isCurrent && !w.prunable ? '<button type="button" class="gsMiniBtn" data-sidebar-wt-open="' + escapeHtml(w.path) + '" title="' + escapeHtml(t('Open Worktree in New Window')) + '">↗</button>' : '') +
				'</div>';
			}).join('');
			html += renderSection('worktrees', t('Worktrees'), worktrees.length, wtHtml);
		}
		html += renderSection('stashes', t('Stashes'), stashes.length, stashes.map((s) =>
			'<div class="gsItem" data-sidebar-stash="' + escapeHtml(s.hash) + '" title="' + escapeHtml(s.selector + ': ' + s.message) + '">' +
				'<span class="gsItemIcon">▤</span>' +
				'<span class="gsItemLabel">' + escapeHtml(s.message || s.selector) + '</span>' +
			'</div>'
		).join(''));
		html += renderSection('tags', t('Tags'), tags.length, tags.slice(0, 120).map((tag) =>
			'<div class="gsItem" data-sidebar-tag="' + escapeHtml(tag) + '" title="' + escapeHtml(tag) + '">' +
				'<span class="gsItemIcon">🏷</span>' +
				'<span class="gsItemLabel">' + escapeHtml(tag) + '</span>' +
			'</div>'
		).join(''));
		html += renderSection('remotes', t('Remotes'), remoteBranches.length, remoteBranches.slice(0, 150).map((b) => renderBranchItem(b, true)).join(''));

		body.innerHTML = html;
	}
}
