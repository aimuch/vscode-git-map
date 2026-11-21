interface CommandPaletteItem {
	readonly kind: 'branch' | 'tag' | 'commit' | 'action';
	readonly title: string;
	readonly detail: string;
	readonly badge: string;
	readonly run: () => void;
}

/**
 * In-Graph Command Palette (Ctrl/Cmd+Shift+K) for fuzzy jumping to branches, tags, commits, companion tools, and workflow macros.
 */
class GraphCommandPalette {
	private readonly view: GitGraphView;
	private elem: HTMLElement | null = null;
	private activeIdx: number = 0;
	private filtered: CommandPaletteItem[] = [];

	constructor(view: GitGraphView) {
		this.view = view;
	}

	public isOpen() {
		return this.elem !== null;
	}

	public close() {
		if (this.elem !== null) {
			this.elem.remove();
			this.elem = null;
		}
		this.filtered = [];
		this.view.syncAxState();
	}

	private buildItems(): CommandPaletteItem[] {
		const items: CommandPaletteItem[] = [];
		const repo = this.view.currentRepo;

		// Quick actions & companion tools
		if (this.view.commitHead !== null) {
			items.push({
				kind: 'action',
				title: t('Amend HEAD Commit') + ELLIPSIS,
				detail: t('Modify commit message, staged changes, or date of HEAD (git commit --amend)'),
				badge: 'Git',
				run: () => this.view.actions.openAmendCommitDialog(this.view.commitHead!, null)
			});
		}
		items.push(
			{ kind: 'action', title: t('Compare Commits Across Branches') + ELLIPSIS, detail: t('Pick any two commits from two branches and inspect their diff'), badge: 'Diff', run: () => this.view.openBranchCommitCompareModal() },
			{ kind: 'action', title: t('Pre-Commit Guard Check'), detail: t('Scan changes for secrets, console.log, and FIXME markers'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'preCommitCheck', repo: repo }) },
			{ kind: 'action', title: t('AI Smart Commit Splitter'), detail: t('Group working-tree files into atomic commits'), badge: 'AI', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'aiSmartCommitSplit', repo: repo }) },
			{ kind: 'action', title: t('Conflict Assistant'), detail: t('Inspect and resolve merge or rebase conflict blocks'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'conflictAssistant', repo: repo }) },
			{ kind: 'action', title: t('Branch Lifecycle Dashboard'), detail: t('Inspect stale, merged, and PR-linked branches'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'branchDashboard', repo: repo }) },
			{ kind: 'action', title: t('Submodule Manager'), detail: t('Inspect, init, sync, and update Git submodules'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'submoduleManager', repo: repo }) },
			{ kind: 'action', title: t('Visual Reflog Explorer'), detail: t('Inspect HEAD reflog and recover orphaned commits'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'reflogExplorer', repo: repo }) },
			{ kind: 'action', title: t('Repository Insights & Hotspots'), detail: t('Churn hotspots, bus-factor silos, and heatmap'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'repoInsights', repo: repo }) },
			{ kind: 'action', title: t('Multi-Repository Overview'), detail: t('View branch, dirty state, and sync status across workspace repositories'), badge: 'Tool', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'multiRepoOverview', repo: repo }) },
			{ kind: 'action', title: t('Export Graph as SVG'), detail: t('Save current commit graph as a standalone SVG file'), badge: 'Export', run: () => this.view.exportGraphSvg() },
			{ kind: 'action', title: t('Export Changelog / Weekly Report'), detail: t('Generate Markdown changelog grouped by commit type'), badge: 'Export', run: () => sendMessage({ command: 'openCompanionFeature', feature: 'exportChangelog', repo: repo }) },
			{ kind: 'action', title: t('Macro: Fetch + Rebase Upstream + Prune'), detail: t('Run fetch --all --prune and rebase onto tracking branch'), badge: 'Macro', run: () => runAction({ command: 'runWorkflowMacro', repo: repo, macroId: 'fetch-rebase-prune' }, t('Running Macro')) },
			{ kind: 'action', title: t('Macro: Stash + Pull (--rebase) + Pop'), detail: t('Auto-stash dirty files, pull with rebase, and restore'), badge: 'Macro', run: () => runAction({ command: 'runWorkflowMacro', repo: repo, macroId: 'stash-pull-pop' }, t('Running Macro')) }
		);

		// User-configured workflow macros
		if (Array.isArray(this.view.config.workflowMacros)) {
			this.view.config.workflowMacros.forEach((m) => {
				if (!m || typeof m.id !== 'string' || m.id === '' || m.id === 'fetch-rebase-prune' || m.id === 'stash-pull-pop') return;
				items.push({
					kind: 'action',
					title: t('Macro: {0}', m.name || m.id),
					detail: Array.isArray(m.steps) ? m.steps.join(' && ') : m.id,
					badge: 'Macro',
					run: () => runAction({ command: 'runWorkflowMacro', repo: repo, macroId: m.id }, t('Running Macro'))
				});
			});
		}

		// Branches
		this.view.gitBranches.forEach((b) => {
			const clean = b.startsWith('remotes/') ? b.substring(8) : b;
			const isLocal = !b.startsWith('remotes/');
			items.push({
				kind: 'branch',
				title: clean,
				detail: isLocal ? t('Checkout local branch') : t('Filter or inspect remote branch'),
				badge: isLocal ? 'Branch' : 'Remote',
				run: () => {
					if (isLocal && clean !== this.view.gitBranchHead) {
						runAction({ command: 'checkoutBranch', repo: repo, branchName: clean, remoteBranch: null, pullAfterwards: null }, t('Checking out Branch'));
					} else {
						this.view.setShownBranches([b]);
					}
				}
			});
		});

		// Loaded commits (up to 150 recent)
		const commits = this.view.getCommits();
		const limit = Math.min(commits.length, 150);
		for (let i = 0; i < limit; i++) {
			const c = commits[i];
			if (c.hash === UNCOMMITTED) continue;
			items.push({
				kind: 'commit',
				title: c.message,
				detail: abbrevCommit(c.hash) + ' · ' + c.author,
				badge: abbrevCommit(c.hash),
				run: () => {
					this.view.scrollToCommit(c.hash, true, true);
					const elem = this.view.getCommitElem(i);
					if (elem !== null) this.view.loadCommitDetails(elem);
				}
			});
		}
		return items;
	}

	public open() {
		this.close();
		closeDialogAndContextMenu();
		const allItems = this.buildItems();
		const modal = document.createElement('div');
		modal.id = 'graphCmdPalette';
		modal.setAttribute('role', 'dialog');
		modal.setAttribute('aria-modal', 'true');
		modal.innerHTML = '<div class="gcpCard">' +
			'<input id="gcpInput" class="gcpInput" type="text" role="combobox" aria-expanded="true" aria-controls="gcpList" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(t('Jump to branch, commit, tool, or macro… (Esc to close)')) + '">' +
			'<div id="gcpList" class="gcpList" role="listbox"></div></div>';
		modal.addEventListener('mousedown', (e) => {
			if (e.target === modal) this.close();
		});
		document.body.appendChild(modal);
		this.elem = modal;
		this.view.syncAxState();

		const input = <HTMLInputElement>document.getElementById('gcpInput')!;
		const list = document.getElementById('gcpList')!;

		const updateActiveHighlight = (scrollIntoView: boolean) => {
			const rows = list.querySelectorAll<HTMLElement>('.gcpRow');
			rows.forEach((row, idx) => {
				const isAct = idx === this.activeIdx;
				row.classList.toggle('active', isAct);
				row.setAttribute('aria-selected', isAct ? 'true' : 'false');
				if (isAct) {
					input.setAttribute('aria-activedescendant', row.id);
					if (scrollIntoView && typeof row.scrollIntoView === 'function') {
						row.scrollIntoView({ block: 'nearest' });
					}
				}
			});
			if (rows.length === 0) input.removeAttribute('aria-activedescendant');
		};

		const render = (scrollActive: boolean = false) => {
			const q = input.value.trim().toLowerCase();
			this.filtered = (q === ''
				? allItems.slice(0, 30)
				: allItems.filter((it) => it.title.toLowerCase().includes(q) || it.detail.toLowerCase().includes(q) || it.badge.toLowerCase().includes(q)).slice(0, 40));
			if (this.activeIdx >= this.filtered.length) this.activeIdx = 0;
			list.innerHTML = this.filtered.length === 0
				? '<div class="gcpEmpty">' + escapeHtml(t('No matching commands, branches, or commits.')) + '</div>'
				: this.filtered.map((it, idx) =>
					'<div id="gcpOpt-' + idx + '" role="option" aria-selected="' + (idx === this.activeIdx ? 'true' : 'false') + '" class="gcpRow' + (idx === this.activeIdx ? ' active' : '') + '" data-gcp-idx="' + idx + '">' +
					'<span class="gcpBadge">' + escapeHtml(it.badge) + '</span>' +
					'<span class="gcpTitle">' + escapeHtml(it.title) + '</span>' +
					'<span class="gcpDetail">' + escapeHtml(it.detail) + '</span></div>'
				).join('');
			updateActiveHighlight(scrollActive);
		};

		input.addEventListener('input', () => {
			this.activeIdx = 0;
			render(true);
		});
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				handledEvent(e);
				if (this.filtered.length > 0) {
					this.activeIdx = (this.activeIdx + 1) % this.filtered.length;
					updateActiveHighlight(true);
				}
			} else if (e.key === 'ArrowUp') {
				handledEvent(e);
				if (this.filtered.length > 0) {
					this.activeIdx = (this.activeIdx - 1 + this.filtered.length) % this.filtered.length;
					updateActiveHighlight(true);
				}
			} else if (e.key === 'Enter') {
				handledEvent(e);
				const chosen = this.filtered[this.activeIdx];
				if (chosen) {
					this.close();
					chosen.run();
				}
			} else if (e.key === 'Escape') {
				handledEvent(e);
				this.close();
			}
		});
		list.addEventListener('mousemove', (e) => {
			const row = e.target instanceof Element ? <HTMLElement | null>e.target.closest('[data-gcp-idx]') : null;
			if (row === null) return;
			const idx = parseInt(row.dataset.gcpIdx || '-1', 10);
			if (idx >= 0 && idx < this.filtered.length && idx !== this.activeIdx) {
				this.activeIdx = idx;
				updateActiveHighlight(false);
			}
		});
		list.addEventListener('click', (e) => {
			const row = e.target instanceof Element ? <HTMLElement | null>e.target.closest('[data-gcp-idx]') : null;
			if (row === null) return;
			const idx = parseInt(row.dataset.gcpIdx || '-1', 10);
			const chosen = this.filtered[idx];
			if (chosen) {
				this.close();
				chosen.run();
			}
		});

		render();
		input.focus();
	}
}
