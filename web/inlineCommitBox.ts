/**
 * Inline Staging & Commit Box controller extracted from GitGraphView.
 * Renders quick file staging controls, Pre-Commit Guard banner, Conventional Commit chips,
 * Git Hooks click-to-open badge, and Amend / Sign-off / GPG / --no-verify commit controls.
 */
class InlineCommitBox {
	private readonly view: GitGraphView;
	private workingTreeStatus: GG.ResponseLoadWorkingTreeStatus | null = null;
	private draft: string = '';
	private amend: boolean = false;
	private signoff: boolean = false;
	private gpgSign: boolean = false;
	private noVerify: boolean = false;
	private contributors: ReadonlyArray<GG.ContributorSummary> = [];
	private coauthorPickerOpen: boolean = false;

	constructor(view: GitGraphView) {
		this.view = view;
	}

	public processContributorsResponse(msg: GG.ResponseLoadContributors) {
		if (msg.repo !== this.view.currentRepo || msg.error !== null) return;
		this.contributors = msg.contributors;
		if (this.coauthorPickerOpen) this.render();
	}

	public resetStatus() {
		this.workingTreeStatus = null;
	}

	public processWorkingTreeStatusResponse(msg: GG.ResponseLoadWorkingTreeStatus) {
		this.workingTreeStatus = msg;
		if (this.draft === '' && !this.amend && typeof msg.commitTemplate === 'string' && msg.commitTemplate !== '') {
			this.draft = msg.commitTemplate;
		}
		this.render();
	}

	public setDraft(text: string) {
		this.draft = text;
		const input = <HTMLTextAreaElement | null>document.getElementById('cdvCommitInput');
		if (input !== null) input.value = text;
	}

	public clearDraft() {
		this.draft = '';
		this.amend = false;
		this.render();
	}

	public render() {
		const container = document.getElementById('cdvInlineCommitBox');
		if (container === null) return;
		const status = this.workingTreeStatus;
		const files = status !== null ? status.files : [];
		const stagedFiles = files.filter((f) => f.staged);
		const unstagedFiles = files.filter((f) => f.unstaged);
		const conflictedCount = files.filter((f) => f.conflicted).length;

		let filesSummaryHtml = '<div class="cdvStagingBar">' +
			'<span class="cdvStagingCounts">' + t('Staged: {0}', stagedFiles.length) + ' &middot; ' + t('Unstaged: {0}', unstagedFiles.length) +
			(conflictedCount > 0 ? ' &middot; <button type="button" class="cdvLinkBtn danger" data-inline-stage="conflicts">' + t('{0} Conflicted', conflictedCount) + '</button>' : '') +
			'</span>' +
			'<span class="cdvStagingBtns">' +
			(unstagedFiles.length > 0 ? '<button type="button" class="cdvMiniBtn" data-inline-stage="stageAll" title="' + escapeHtml(t('Stage All Changes')) + '">+ ' + t('Stage All') + '</button>' : '') +
			(stagedFiles.length > 0 ? '<button type="button" class="cdvMiniBtn" data-inline-stage="unstageAll" title="' + escapeHtml(t('Unstage All Changes')) + '">&minus; ' + t('Unstage All') + '</button>' : '') +
			'</span></div>';

		if (files.length > 0 && files.length <= 40) {
			filesSummaryHtml += '<div class="cdvQuickStageList">' + files.map((f) => {
				const badge = f.conflicted ? '!' : f.untracked ? 'U' : (f.staged && f.unstaged) ? 'SM' : f.staged ? 'S' : 'M';
				return '<div class="cdvQuickStageRow">' +
					'<span class="cdvQuickStageBadge status-' + badge.toLowerCase() + '">' + badge + '</span>' +
					'<span class="cdvQuickStagePath" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' +
					(!f.staged || f.unstaged ? '<button type="button" class="cdvMiniBtn" data-inline-file="' + escapeHtml(f.path) + '" data-inline-op="stage" title="' + escapeHtml(t('Stage File')) + '">+</button>' : '') +
					(f.staged ? '<button type="button" class="cdvMiniBtn" data-inline-file="' + escapeHtml(f.path) + '" data-inline-op="unstage" title="' + escapeHtml(t('Unstage File')) + '">&minus;</button>' : '') +
					(!f.untracked && !f.conflicted ? '<button type="button" class="cdvMiniBtn" data-inline-file="' + escapeHtml(f.path) + '" data-inline-staged="' + (f.staged && !f.unstaged ? '1' : '0') + '" data-inline-op="hunks" title="' + escapeHtml(t('Stage / Unstage Hunks…')) + '">&plusmn;</button>' : '') +
					(f.untracked ? '<button type="button" class="cdvMiniBtn" data-inline-file="' + escapeHtml(f.path) + '" data-inline-op="gitignore" title="' + escapeHtml(t('Add to .gitignore')) + '">.ignore</button>' : '') +
					(f.unstaged && !f.conflicted ? '<button type="button" class="cdvMiniBtn danger" data-inline-file="' + escapeHtml(f.path) + '" data-inline-untracked="' + (f.untracked ? '1' : '0') + '" data-inline-op="discard" title="' + escapeHtml(t('Discard Changes')) + '">&times;</button>' : '') +
					'</div>';
			}).join('') + '</div>';
		}

		const hooks = status && Array.isArray(status.hooks) ? status.hooks : [];
		const preIssues = status && Array.isArray(status.preCommitIssues) ? status.preCommitIssues : [];
		const highIssues = preIssues.filter((i) => i.severity === 'high').length;
		const preBannerHtml = preIssues.length > 0
			? '<div class="cdvPreCommitBanner' + (highIssues > 0 ? ' high' : '') + '"><span>&#9888; ' +
				t('Pre-Commit Guard: {0} potential issue(s)', preIssues.length) +
				(highIssues > 0 ? ' (' + highIssues + ' HIGH)' : '') +
				'</span><button type="button" class="cdvMiniBtn" data-inline-stage="preCheck">' + t('Inspect') + '</button></div>'
			: '';
		const hooksHtml = hooks.length > 0
			? '<button type="button" class="cdvHooksBadge" data-inline-stage="openHook" title="' + escapeHtml(hooks.map((h) => h.name).join(', ')) + '">' + t('Hooks: {0}', hooks.length) + '</button>'
			: '';
		const convChipsHtml = '<div class="cdvConvChips">' +
			['feat', 'fix', 'refactor', 'docs', 'chore', 'test'].map((k) => '<button type="button" class="cdvConvChip" data-conv-prefix="' + k + ': ">' + k + '</button>').join('') +
			'<button type="button" class="cdvConvChip" data-inline-stage="coauthors">+ ' + t('Co-author') + '</button>' +
			hooksHtml +
			(files.length >= 2 ? '<button type="button" class="cdvConvChip aiSplit" data-inline-stage="aiSplit">' + MENU_ICONS.sparkle + t('AI Split') + '</button>' : '') +
			'</div>' +
			(this.coauthorPickerOpen
				? '<div class="cdvCoauthorPicker">' +
					(this.contributors.length === 0
						? '<span class="cdvCoauthorEmpty">' + t('Loading contributors…') + '</span>'
						: this.contributors.slice(0, 20).map((c) => '<button type="button" class="cdvCoauthorItem" data-coauthor-name="' + escapeHtml(c.name) + '" data-coauthor-email="' + escapeHtml(c.email) + '">' + escapeHtml(c.name) + ' &lt;' + escapeHtml(c.email) + '&gt; (' + c.commits + ')</button>').join('')) +
					'</div>'
				: '');

		container.innerHTML = filesSummaryHtml + preBannerHtml +
			'<div class="cdvCommitForm">' +
			convChipsHtml +
			'<textarea id="cdvCommitInput" class="cdvCommitInput" rows="3" placeholder="' + escapeHtml(t('Commit message (Ctrl/Cmd+Enter to commit)…')) + '">' + escapeHtml(this.draft) + '</textarea>' +
			'<div class="cdvCommitControls">' +
			'<label class="cdvAmendLabel"><input type="checkbox" id="cdvCommitAmend"' + (this.amend ? ' checked' : '') + '><span class="customCheckbox"></span>' + t('Amend') + '</label>' +
			'<label class="cdvAmendLabel" title="git commit -s"><input type="checkbox" id="cdvCommitSignoff"' + (this.signoff ? ' checked' : '') + '><span class="customCheckbox"></span>' + t('Sign-off') + '</label>' +
			'<label class="cdvAmendLabel" title="git commit -S"><input type="checkbox" id="cdvCommitGpgSign"' + (this.gpgSign ? ' checked' : '') + '><span class="customCheckbox"></span>' + t('GPG') + '</label>' +
			(hooks.length > 0 ? '<label class="cdvAmendLabel" title="git commit --no-verify"><input type="checkbox" id="cdvCommitNoVerify"' + (this.noVerify ? ' checked' : '') + '><span class="customCheckbox"></span>' + t('No Verify') + '</label>' : '') +
			'<span class="cdvCommitSpacer"></span>' +
			'<button type="button" class="cdvActionBtn" data-inline-stage="aiMsg" title="' + escapeHtml(t('Generate Commit Message with AI')) + '">' + MENU_ICONS.sparkle + 'AI</button>' +
			'<button type="button" class="cdvActionBtn primary" data-inline-stage="commit">' + MENU_ICONS.checkout + (this.amend ? t('Amend Commit') : stagedFiles.length > 0 ? t('Commit Staged ({0})', stagedFiles.length) : t('Stage All & Commit')) + '</button>' +
			'</div></div>';

		const inputElem = <HTMLTextAreaElement | null>document.getElementById('cdvCommitInput');
		if (inputElem !== null) {
			inputElem.addEventListener('input', () => {
				this.draft = inputElem.value;
			});
			inputElem.addEventListener('keydown', (e: KeyboardEvent) => {
				if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
					e.preventDefault();
					const commitBtn = <HTMLElement | null>container.querySelector('[data-inline-stage="commit"]');
					if (commitBtn !== null) commitBtn.click();
				}
			});
		}

		const amendElem = <HTMLInputElement | null>document.getElementById('cdvCommitAmend');
		if (amendElem !== null) {
			amendElem.addEventListener('change', () => {
				this.amend = amendElem.checked;
				if (this.amend && this.draft.trim() === '' && status !== null && status.headMessage !== null) {
					this.draft = status.headMessage;
				}
				this.render();
			});
		}
		const signoffElem = <HTMLInputElement | null>document.getElementById('cdvCommitSignoff');
		if (signoffElem !== null) signoffElem.addEventListener('change', () => { this.signoff = signoffElem.checked; });
		const gpgElem = <HTMLInputElement | null>document.getElementById('cdvCommitGpgSign');
		if (gpgElem !== null) gpgElem.addEventListener('change', () => { this.gpgSign = gpgElem.checked; });
		const noVerifyElem = <HTMLInputElement | null>document.getElementById('cdvCommitNoVerify');
		if (noVerifyElem !== null) noVerifyElem.addEventListener('change', () => { this.noVerify = noVerifyElem.checked; });

		container.onclick = (e: MouseEvent) => {
			if (!(e.target instanceof Element)) return;
			const convChip = <HTMLElement | null>e.target.closest('[data-conv-prefix]');
			if (convChip !== null && typeof convChip.dataset.convPrefix === 'string') {
				const prefix = convChip.dataset.convPrefix;
				const stripped = this.draft.replace(/^(?:feat|fix|refactor|docs|chore|test)(?:\([^)]*\))?!?:\s*/i, '');
				this.draft = prefix + stripped;
				const ta = <HTMLTextAreaElement | null>document.getElementById('cdvCommitInput');
				if (ta !== null) {
					ta.value = this.draft;
					ta.focus();
				}
				return;
			}
			const fileBtn = <HTMLElement | null>e.target.closest('[data-inline-op]');
			if (fileBtn !== null && typeof fileBtn.dataset.inlineFile === 'string') {
				const filePath = unescapeHtml(fileBtn.dataset.inlineFile);
				const op = fileBtn.dataset.inlineOp;
				if (op === 'stage') {
					runAction({ command: 'stageFiles', repo: this.view.currentRepo, paths: [filePath] }, t('Staging File'));
				} else if (op === 'unstage') {
					runAction({ command: 'unstageFiles', repo: this.view.currentRepo, paths: [filePath] }, t('Unstaging File'));
				} else if (op === 'hunks') {
					this.view.openHunkStagingModal(filePath, fileBtn.dataset.inlineStaged === '1');
				} else if (op === 'gitignore') {
					runAction({ command: 'addToGitignore', repo: this.view.currentRepo, paths: [filePath] }, t('Adding to .gitignore'));
				} else if (op === 'discard') {
					const isUntracked = fileBtn.dataset.inlineUntracked === '1';
					dialog.asDangerous().showConfirmation(t('Are you sure you want to discard uncommitted changes to <b><i>{0}</i></b>?', escapeHtml(filePath)), t('Discard Changes'), () => {
						runAction({ command: 'discardWorkingChanges', repo: this.view.currentRepo, trackedPaths: isUntracked ? [] : [filePath], untrackedPaths: isUntracked ? [filePath] : [] }, t('Discarding Changes'));
					}, null);
				}
				return;
			}
			const coauthorBtn = <HTMLElement | null>e.target.closest('[data-coauthor-email]');
			if (coauthorBtn !== null && typeof coauthorBtn.dataset.coauthorName === 'string' && typeof coauthorBtn.dataset.coauthorEmail === 'string') {
				const trailer = 'Co-authored-by: ' + unescapeHtml(coauthorBtn.dataset.coauthorName) + ' <' + unescapeHtml(coauthorBtn.dataset.coauthorEmail) + '>';
				if (this.draft.indexOf(trailer) === -1) {
					const trimmed = this.draft.replace(/\s+$/, '');
					this.draft = trimmed === '' ? '\n\n' + trailer : trimmed + (trimmed.indexOf('Co-authored-by:') !== -1 ? '\n' : '\n\n') + trailer;
				}
				this.coauthorPickerOpen = false;
				this.render();
				const ta = <HTMLTextAreaElement | null>document.getElementById('cdvCommitInput');
				if (ta !== null) ta.focus();
				return;
			}
			const stageBtn = <HTMLElement | null>e.target.closest('[data-inline-stage]');
			if (stageBtn === null) return;
			switch (stageBtn.dataset.inlineStage) {
				case 'coauthors':
					this.coauthorPickerOpen = !this.coauthorPickerOpen;
					if (this.coauthorPickerOpen && this.contributors.length === 0) {
						sendMessage({ command: 'loadContributors', repo: this.view.currentRepo });
					}
					this.render();
					break;
				case 'stageAll':
					runAction({ command: 'stageFiles', repo: this.view.currentRepo, paths: null }, t('Staging All Changes'));
					break;
				case 'unstageAll':
					runAction({ command: 'unstageFiles', repo: this.view.currentRepo, paths: null }, t('Unstaging All Changes'));
					break;
				case 'conflicts':
					sendMessage({ command: 'openCompanionFeature', feature: 'conflictAssistant', repo: this.view.currentRepo });
					break;
				case 'preCheck':
					sendMessage({ command: 'openCompanionFeature', feature: 'preCommitCheck', repo: this.view.currentRepo });
					break;
				case 'aiSplit':
					sendMessage({ command: 'openCompanionFeature', feature: 'aiSmartCommitSplit', repo: this.view.currentRepo });
					break;
				case 'openHook':
					sendMessage({ command: 'openHookFile', repo: this.view.currentRepo });
					break;
				case 'aiMsg':
					this.view.commitExplainer.openCommitMessageModal();
					break;
				case 'commit': {
					const msg = this.draft.trim();
					if (msg === '') {
						dialog.showError(t('Unable to Commit Changes'), t('Please enter a commit message first.'), null, null);
						return;
					}
					const executeCommit = () => {
						runAction({
							command: 'commitStagedChanges',
							repo: this.view.currentRepo,
							message: msg,
							amend: this.amend,
							stageAllIfEmpty: true,
							signoff: this.signoff,
							gpgSign: this.gpgSign,
							noVerify: this.noVerify
						}, this.amend ? t('Amending Commit') : t('Committing Changes'));
					};
					if (this.noVerify) {
						dialog.asDangerous().showConfirmation(
							t('Commit with <b>--no-verify</b>? This skips Git pre-commit and commit-msg hooks.'),
							t('Commit Without Hooks'),
							executeCommit,
							null
						);
					} else {
						executeCommit();
					}
					break;
				}
			}
		};
	}
}
