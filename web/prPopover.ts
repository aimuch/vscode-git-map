/**
 * Interactive Pull Request detail popover extracted from GitGraphView.
 */
class PullRequestPopover {
	private readonly view: GitGraphView;
	private elem: HTMLElement | null = null;
	private branch: string | null = null;

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
		this.branch = null;
		this.view.syncAxState();
	}

	public open(branch: string, prNumber: number, fallbackUrl: string, anchorElem: HTMLElement, cached?: GG.PullRequestBadgeInfo) {
		this.close();
		const rect = anchorElem.getBoundingClientRect();
		const pop = document.createElement('div');
		pop.id = 'prDetailPopover';
		pop.setAttribute('role', 'dialog');
		pop.style.left = Math.min(Math.max(12, Math.round(rect.left)), Math.max(12, window.innerWidth - 370)) + 'px';
		pop.style.top = Math.min(Math.round(rect.bottom + 6), Math.max(12, window.innerHeight - 260)) + 'px';
		pop.innerHTML = this.renderHtml({
			number: prNumber,
			title: typeof cached !== 'undefined' ? cached.title : ('#' + prNumber),
			body: '',
			author: '',
			state: typeof cached !== 'undefined' ? cached.state : 'open',
			url: fallbackUrl || (typeof cached !== 'undefined' ? cached.url : ''),
			baseBranch: typeof cached !== 'undefined' ? cached.baseBranch : '',
			headBranch: branch,
			ciStatus: typeof cached !== 'undefined' ? cached.ciStatus : 'unknown',
			checks: [],
			reviewSummary: ''
		}, true);
		pop.addEventListener('click', (e) => {
			if (!(e.target instanceof Element)) return;
			const act = <HTMLElement | null>e.target.closest('[data-pr-act]');
			if (act === null) return;
			const cmd = act.dataset.prAct;
			const url = act.dataset.prUrl || fallbackUrl;
			if (cmd === 'close') {
				this.close();
			} else if (cmd === 'openUrl' && url !== '') {
				sendMessage({ command: 'openExternalUrl', url: url });
				this.close();
			} else if (cmd === 'checkoutPr') {
				sendMessage({ command: 'openCompanionFeature', feature: 'checkoutPullRequest', repo: this.view.currentRepo });
				this.close();
			} else if (cmd === 'aiReviewPr') {
				const base = act.dataset.prBase || 'main';
				sendMessage({ command: 'openCompanionFeature', feature: 'aiReview', repo: this.view.currentRepo, mode: 'range', fromRef: base, toRef: branch, label: 'PR #' + prNumber + ' (' + base + ' → ' + branch + ')' });
				this.close();
			}
		});
		document.body.appendChild(pop);
		this.elem = pop;
		this.branch = branch;
		this.view.syncAxState();
		sendMessage({ command: 'loadPullRequestDetails', repo: this.view.currentRepo, branch: branch, prNumber: prNumber });
	}

	public processDetailsResponse(msg: GG.ResponseLoadPullRequestDetails) {
		if (this.elem === null || this.branch !== msg.branch || msg.details === null) return;
		this.elem.innerHTML = this.renderHtml(msg.details, false);
	}

	private renderHtml(d: GG.PullRequestDetailsInfo, loading: boolean) {
		const checksHtml = d.checks.length > 0
			? '<div class="prPopChecks">' + d.checks.slice(0, 6).map((c) => '<span class="prPopCheck">' + escapeHtml(c.name) + ': ' + escapeHtml(c.status) + '</span>').join('') + '</div>'
			: '';
		return '<div class="prPopHdr"><b>#' + d.number + ' ' + escapeHtml(d.title) + '</b><button type="button" class="aiCommitClose" data-pr-act="close">' + SVG_ICONS.close + '</button></div>' +
			'<div class="prPopMeta"><span class="gitRefPrBadge ci-' + d.ciStatus + '">' + escapeHtml(d.state.toUpperCase() + ' · CI: ' + d.ciStatus) + '</span>' +
			(d.baseBranch !== '' ? '<span>' + escapeHtml(d.headBranch + ' → ' + d.baseBranch) + '</span>' : '') +
			(d.author !== '' ? '<span>@' + escapeHtml(d.author) + '</span>' : '') +
			(d.reviewSummary !== '' ? '<span>' + escapeHtml(d.reviewSummary) + '</span>' : '') + '</div>' +
			(loading ? '<div class="prPopBody">' + t('Loading ...') + '</div>' : (d.body !== '' ? '<div class="prPopBody">' + escapeHtml(d.body) + '</div>' : '')) +
			checksHtml +
			'<div class="prPopBtns">' +
			(d.url !== '' ? '<button type="button" class="cdvMiniBtn primary" data-pr-act="openUrl" data-pr-url="' + escapeHtml(d.url) + '">' + t('Open in Browser') + '</button>' : '') +
			'<button type="button" class="cdvMiniBtn" data-pr-act="checkoutPr">' + t('Checkout PR') + '</button>' +
			'<button type="button" class="cdvMiniBtn" data-pr-act="aiReviewPr" data-pr-base="' + escapeHtml(d.baseBranch || 'main') + '">' + MENU_ICONS.sparkle + t('AI Review') + '</button>' +
			'</div>';
	}
}
