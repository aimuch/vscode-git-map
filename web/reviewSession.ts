/**
 * Interactive Review Session & Worktree WIP Inspector overlay.
 * - Review Session supports scope presets (Uncommitted, Unpushed, Current Branch vs Base),
 *   persistent viewed-file checklists, Next Unviewed navigation (Alt+N), severity-tagged file notes,
 *   one-click AI review, and structured Markdown export for coding agents.
 * - Worktree WIP Inspector displays uncommitted files of any worktree and opens diffs inline without switching windows.
 */
class ReviewSessionModal {
	private readonly view: GitGraphView;
	private mode: 'closed' | 'review' | 'worktreeWip' = 'closed';
	private scope: GG.ReviewSessionScope = 'uncommitted';
	private loading: boolean = false;
	private error: string | null = null;
	private reviewData: GG.ResponseLoadReviewSession | null = null;
	private selectedFile: string | null = null;
	private worktreeTarget: GG.GitWorktree | null = null;
	private worktreeFiles: ReadonlyArray<GG.WorkingTreeStatusItem> = [];
	private evidenceExpanded: boolean = false;
	private elem: HTMLElement | null = null;

	constructor(view: GitGraphView) {
		this.view = view;
	}

	public isOpen() {
		return this.mode !== 'closed';
	}

	public close() {
		this.mode = 'closed';
		if (this.elem !== null) {
			this.elem.remove();
			this.elem = null;
		}
	}

	public openReview(scope: GG.ReviewSessionScope = 'uncommitted') {
		this.mode = 'review';
		this.scope = scope;
		this.loading = true;
		this.error = null;
		this.reviewData = null;
		this.selectedFile = null;
		this.ensureContainer();
		this.render();
		sendMessage({ command: 'loadReviewSession', repo: this.view.currentRepo, scope: scope });
	}

	public openWorktreeWip(wt: GG.GitWorktree) {
		this.mode = 'worktreeWip';
		this.worktreeTarget = wt;
		this.worktreeFiles = [];
		this.loading = true;
		this.error = null;
		this.ensureContainer();
		this.render();
		sendMessage({ command: 'loadWorktreeWip', worktreePath: wt.path });
	}

	public processLoadReviewSessionResponse(msg: GG.ResponseLoadReviewSession) {
		if (this.mode !== 'review' || msg.scope !== this.scope) return;
		this.loading = false;
		this.error = msg.error;
		this.reviewData = msg;
		if (msg.files.length > 0 && (this.selectedFile === null || !msg.files.some((f) => f.newFilePath === this.selectedFile))) {
			this.selectedFile = msg.files[0].newFilePath;
		}
		this.render();
	}

	public processUpdateReviewSessionResponse(msg: GG.ResponseUpdateReviewSession) {
		if (this.mode !== 'review' || this.reviewData === null || this.reviewData.scopeKey !== msg.session.scopeKey) return;
		this.reviewData = Object.assign({}, this.reviewData, { session: msg.session });
		this.render();
	}

	public processLoadWorktreeWipResponse(msg: GG.ResponseLoadWorktreeWip) {
		if (this.mode !== 'worktreeWip' || this.worktreeTarget === null || this.worktreeTarget.path !== msg.worktreePath) return;
		this.loading = false;
		this.error = msg.error;
		this.worktreeFiles = msg.files;
		this.render();
	}

	private ensureContainer() {
		if (this.elem !== null) return;
		this.elem = document.createElement('div');
		this.elem.id = 'reviewSessionModal';
		this.elem.className = 'reviewSessionOverlay';
		document.body.appendChild(this.elem);

		this.elem.addEventListener('click', (e) => {
			const target = <Element>e.target;
			if (target === this.elem || target.closest('[data-rs="close"]') !== null) {
				this.close();
				return;
			}
			const scopeBtn = target.closest<HTMLElement>('[data-rs-scope]');
			if (scopeBtn !== null) {
				const nextScope = <GG.ReviewSessionScope>scopeBtn.dataset.rsScope!;
				if (nextScope !== this.scope || this.error !== null) this.openReview(nextScope);
				return;
			}
			if (target.closest('[data-rs="nextUnviewed"]') !== null) {
				this.openNextUnviewed();
				return;
			}
			if (target.closest('[data-rs="resetProgress"]') !== null && this.reviewData !== null) {
				sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: this.reviewData.scopeKey, clear: true });
				return;
			}
			if (target.closest('[data-rs="aiReviewScope"]') !== null && this.reviewData !== null) {
				if (this.scope === 'uncommitted') {
					sendMessage({ command: 'openCompanionFeature', feature: 'aiReview', repo: this.view.currentRepo, mode: 'uncommitted', label: t('Uncommitted Changes') });
				} else {
					sendMessage({ command: 'openCompanionFeature', feature: 'aiReview', repo: this.view.currentRepo, mode: 'range', fromRef: this.reviewData.fromHash, toRef: this.reviewData.toHash, label: this.reviewData.baseLabel + ' → ' + this.reviewData.headLabel });
				}
				return;
			}
			if (target.closest('[data-rs="copyForAgent"]') !== null && this.reviewData !== null) {
				this.copyReviewForAgent();
				return;
			}
			if (target.closest('[data-rs="toggleEvidence"]') !== null) {
				this.evidenceExpanded = !this.evidenceExpanded;
				this.render();
				return;
			}
			const tplBtn = target.closest<HTMLElement>('[data-rs-template]');
			if (tplBtn !== null && this.reviewData !== null) {
				this.applyChecklistTemplate(tplBtn.dataset.rsTemplate!);
				return;
			}
			if (target.closest('[data-rs="exportBlueprint"]') !== null && this.reviewData !== null) {
				this.exportBlueprintJson();
				return;
			}
			if (target.closest('[data-rs="importBlueprint"]') !== null && this.reviewData !== null) {
				this.openImportBlueprintDialog();
				return;
			}
			const toggleCheck = target.closest<HTMLInputElement>('[data-rs-viewed]');
			if (toggleCheck !== null && this.reviewData !== null) {
				e.stopPropagation();
				this.toggleViewedFile(toggleCheck.dataset.rsViewed!, toggleCheck.checked);
				return;
			}
			const fileItem = target.closest<HTMLElement>('[data-rs-file]');
			if (fileItem !== null && this.reviewData !== null) {
				const fp = fileItem.dataset.rsFile!;
				this.selectedFile = fp;
				this.openDiffForReviewFile(fp);
				return;
			}
			if (target.closest('[data-rs="addComment"]') !== null && this.reviewData !== null) {
				this.addComment();
				return;
			}
			const delComment = target.closest<HTMLElement>('[data-rs-del-comment]');
			if (delComment !== null && this.reviewData !== null) {
				const id = delComment.dataset.rsDelComment!;
				const next = this.reviewData.session.comments.filter((c) => c.id !== id);
				sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: this.reviewData.scopeKey, comments: next });
				return;
			}
			const wtFile = target.closest<HTMLElement>('[data-wt-file]');
			if (wtFile !== null && this.worktreeTarget !== null) {
				const fp = wtFile.dataset.wtFile!;
				const oldFp = wtFile.dataset.wtOldFile || fp;
				const status = <GG.GitFileStatus>(wtFile.dataset.wtStatus || GG.GitFileStatus.Modified);
				sendMessage({ command: 'viewDiff', repo: this.worktreeTarget.path, fromHash: 'HEAD', toHash: UNCOMMITTED, oldFilePath: oldFp, newFilePath: fp, type: status });
				return;
			}
			if (target.closest('[data-rs="openWtWindow"]') !== null && this.worktreeTarget !== null) {
				sendMessage({ command: 'openWorktree', path: this.worktreeTarget.path });
				return;
			}
			if (target.closest('[data-rs="copyWtPath"]') !== null && this.worktreeTarget !== null) {
				sendMessage({ command: 'copyToClipboard', type: t('Worktree Path'), data: this.worktreeTarget.path });
				return;
			}
		});

		this.elem.addEventListener('keydown', (e) => {
			if (e.altKey && (e.key === 'n' || e.key === 'N') && this.mode === 'review') {
				handledEvent(e);
				this.openNextUnviewed();
			}
		});
	}

	private toggleViewedFile(filePath: string, viewed: boolean) {
		if (this.reviewData === null) return;
		const set = new Set(this.reviewData.session.viewedFiles);
		if (viewed) set.add(filePath);
		else set.delete(filePath);
		sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: this.reviewData.scopeKey, viewedFiles: Array.from(set) });
	}

	private openDiffForReviewFile(filePath: string) {
		if (this.reviewData === null) return;
		const file = this.reviewData.files.find((f) => f.newFilePath === filePath);
		if (typeof file === 'undefined') return;
		sendMessage({
			command: 'viewDiff',
			repo: this.view.currentRepo,
			fromHash: this.reviewData.fromHash,
			toHash: this.reviewData.toHash,
			oldFilePath: file.oldFilePath,
			newFilePath: file.newFilePath,
			type: file.type
		});
		const set = new Set(this.reviewData.session.viewedFiles);
		if (!set.has(filePath)) {
			set.add(filePath);
			sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: this.reviewData.scopeKey, viewedFiles: Array.from(set) });
		} else {
			this.render();
		}
	}

	public openNextUnviewed() {
		if (this.reviewData === null || this.reviewData.files.length === 0) return;
		const viewed = new Set(this.reviewData.session.viewedFiles);
		const next = this.reviewData.files.find((f) => !viewed.has(f.newFilePath));
		if (typeof next !== 'undefined') {
			this.selectedFile = next.newFilePath;
			this.openDiffForReviewFile(next.newFilePath);
		}
	}

	private addComment() {
		if (this.reviewData === null || this.elem === null) return;
		const input = this.elem.querySelector<HTMLTextAreaElement>('#rsCommentInput');
		const sevSel = this.elem.querySelector<HTMLSelectElement>('#rsCommentSeverity');
		if (input === null || sevSel === null) return;
		const text = input.value.trim();
		if (text === '') return;
		const filePath = this.selectedFile || (this.reviewData.files[0] ? this.reviewData.files[0].newFilePath : '');
		const comment: GG.ReviewSessionComment = {
			id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
			filePath: filePath,
			severity: <'blocker' | 'suggestion' | 'note'>sevSel.value,
			text: text,
			createdAt: Date.now()
		};
		const next = this.reviewData.session.comments.concat([comment]);
		input.value = '';
		sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: this.reviewData.scopeKey, comments: next });
	}

	private copyReviewForAgent() {
		if (this.reviewData === null) return;
		const d = this.reviewData;
		const viewed = new Set(d.session.viewedFiles);
		const lines: string[] = [
			'# Code Review Session (' + d.baseLabel + ' → ' + d.headLabel + ')',
			'- Scope: `' + d.scope + '` (' + d.files.length + ' files, ' + d.session.viewedFiles.length + ' viewed)'
		];
		if (d.session.comments.length > 0) {
			lines.push('', '## Actionable Review Notes');
			d.session.comments.forEach((c) => {
				lines.push('- **[' + c.severity.toUpperCase() + ']** `' + c.filePath + '`: ' + c.text);
			});
		}
		const unviewed = d.files.filter((f) => !viewed.has(f.newFilePath));
		if (unviewed.length > 0) {
			lines.push('', '## Remaining Unviewed Files');
			unviewed.forEach((f) => lines.push('- `' + f.newFilePath + '` (' + f.type + ')'));
		}
		sendMessage({ command: 'copyToClipboard', type: t('Review Session Notes'), data: lines.join('\n') });
	}

	private applyChecklistTemplate(templateId: string) {
		if (this.reviewData === null) return;
		const templates: { [id: string]: ReadonlyArray<{ severity: 'blocker' | 'suggestion' | 'note', text: string }> } = {
			release: [
				{ severity: 'blocker', text: t('[Release] Verify version bump, CHANGELOG entry, and migration safety') },
				{ severity: 'suggestion', text: t('[Release] Confirm unit & E2E tests cover all newly added edge cases') },
				{ severity: 'note', text: t('[Release] Double-check i18n/localization strings and fallback copy') }
			],
			security: [
				{ severity: 'blocker', text: t('[Security] Check for path traversal, shell injection, and unsanitized HTML') },
				{ severity: 'blocker', text: t('[Security] Confirm no secrets, API keys, or debug logs were introduced') },
				{ severity: 'suggestion', text: t('[Security] Validate input bounds and error handling on external payloads') }
			],
			refactor: [
				{ severity: 'suggestion', text: t('[Refactor] Ensure zero unintended behavior changes in public contracts') },
				{ severity: 'note', text: t('[Refactor] Verify hot paths avoid redundant DOM thrashing or git spawns') }
			]
		};
		const picked = templates[templateId];
		if (!picked) return;
		const fp = this.selectedFile || (this.reviewData.files[0] ? this.reviewData.files[0].newFilePath : 'scope');
		const existingTexts = new Set(this.reviewData.session.comments.map((c) => c.text));
		const additions: GG.ReviewSessionComment[] = picked
			.filter((item) => !existingTexts.has(item.text))
			.map((item, idx) => ({
				id: Date.now().toString(36) + '-' + idx + '-' + Math.random().toString(36).slice(2, 5),
				filePath: fp,
				severity: item.severity,
				text: item.text,
				createdAt: Date.now()
			}));
		if (additions.length === 0) return;
		sendMessage({
			command: 'updateReviewSession',
			repo: this.view.currentRepo,
			scopeKey: this.reviewData.scopeKey,
			comments: this.reviewData.session.comments.concat(additions)
		});
	}

	private exportBlueprintJson() {
		if (this.reviewData === null) return;
		const blueprint = {
			schema: 'git-map.review-blueprint.v1',
			scope: this.reviewData.scope,
			notes: this.reviewData.session.comments.map((c) => ({ filePath: c.filePath, severity: c.severity, text: c.text }))
		};
		sendMessage({ command: 'copyToClipboard', type: t('Review Blueprint JSON'), data: JSON.stringify(blueprint, null, 2) });
	}

	private openImportBlueprintDialog() {
		if (this.reviewData === null) return;
		const scopeKey = this.reviewData.scopeKey;
		const existing = this.reviewData.session.comments;
		dialog.showForm(
			t('Paste a portable Review Blueprint JSON to import checklist items into this session:'),
			[{ type: DialogInputType.TextArea, name: t('Blueprint JSON'), default: '', placeholder: '{"notes":[{"severity":"blocker","text":"..."}]}' }],
			t('Import Notes'),
			(values) => {
				try {
					const parsed = JSON.parse(String(values[0] || ''));
					const rawNotes = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.notes) ? parsed.notes : []);
					const imported: GG.ReviewSessionComment[] = [];
					for (let i = 0; i < rawNotes.length; i++) {
						const n = rawNotes[i];
						if (!n || typeof n.text !== 'string' || n.text.trim() === '') continue;
						const sev = n.severity === 'blocker' || n.severity === 'note' ? n.severity : 'suggestion';
						imported.push({
							id: Date.now().toString(36) + '-imp-' + i,
							filePath: typeof n.filePath === 'string' && n.filePath.trim() !== '' ? n.filePath.trim() : (this.selectedFile || 'scope'),
							severity: sev,
							text: n.text.trim().slice(0, 400),
							createdAt: Date.now()
						});
					}
					if (imported.length === 0) {
						dialog.showError(t('Import Review Blueprint'), t('No valid checklist notes were found in the pasted JSON.'), null, null);
						return;
					}
					sendMessage({ command: 'updateReviewSession', repo: this.view.currentRepo, scopeKey: scopeKey, comments: existing.concat(imported) });
				} catch (_) {
					dialog.showError(t('Import Review Blueprint'), t('Invalid JSON format.'), null, null);
				}
			},
			null
		);
	}

	private render() {
		if (this.elem === null) return;
		if (this.mode === 'worktreeWip') {
			this.renderWorktreeWip();
			return;
		}
		const d = this.reviewData;
		const viewedSet = new Set(d ? d.session.viewedFiles : []);
		const total = d ? d.files.length : 0;
		const viewedCount = d ? d.files.filter((f) => viewedSet.has(f.newFilePath)).length : 0;
		const pct = total > 0 ? Math.round((viewedCount / total) * 100) : 0;

		const scopes: [GG.ReviewSessionScope, string][] = [
			['uncommitted', t('Uncommitted')],
			['unpushed', t('Unpushed')],
			['branch', t('Current Branch')]
		];
		const scopeTabs = scopes.map(([s, label]) =>
			'<button type="button" class="rsScopePill' + (this.scope === s ? ' active' : '') + '" data-rs-scope="' + s + '">' + label + '</button>'
		).join('');

		let bodyHtml = '';
		if (this.loading) {
			bodyHtml = '<div class="rsEmpty">' + SVG_ICONS.loading + ' ' + t('Loading review scope…') + '</div>';
		} else if (this.error !== null) {
			bodyHtml = '<div class="rsEmpty rsError">' + escapeHtml(this.error) + '</div>';
		} else if (d === null || d.files.length === 0) {
			bodyHtml = '<div class="rsEmpty">' + t('No changed files in this review scope.') + '</div>';
		} else {
			const filesHtml = d.files.map((f) => {
				const isViewed = viewedSet.has(f.newFilePath);
				const isSelected = f.newFilePath === this.selectedFile;
				const commentCount = d.session.comments.filter((c) => c.filePath === f.newFilePath).length;
				const stats = (f.additions !== null || f.deletions !== null)
					? '<span class="rsFileStats"><span class="add">+' + (f.additions || 0) + '</span> <span class="del">−' + (f.deletions || 0) + '</span></span>'
					: '';
				return '<div class="rsFileItem' + (isViewed ? ' viewed' : '') + (isSelected ? ' selected' : '') + '" data-rs-file="' + escapeHtml(f.newFilePath) + '">' +
					'<input type="checkbox" class="rsFileCheck" data-rs-viewed="' + escapeHtml(f.newFilePath) + '"' + (isViewed ? ' checked' : '') + ' title="' + escapeHtml(t('Mark as viewed')) + '"/>' +
					'<span class="rsFileType type-' + escapeHtml(f.type) + '">' + escapeHtml(f.type) + '</span>' +
					'<span class="rsFilePath" title="' + escapeHtml(f.newFilePath) + '">' + escapeHtml(f.newFilePath) + '</span>' +
					stats +
					(commentCount > 0 ? '<span class="rsCommentBadge">' + commentCount + '</span>' : '') +
				'</div>';
			}).join('');

			const commentsHtml = d.session.comments.length === 0
				? '<div class="rsNoComments">' + t('No review notes yet. Add notes for yourself or copy them for a coding agent.') + '</div>'
				: d.session.comments.map((c) =>
					'<div class="rsCommentCard sev-' + escapeHtml(c.severity) + '">' +
						'<div class="rsCommentMeta"><span class="rsSevBadge">' + escapeHtml(c.severity.toUpperCase()) + '</span><span class="rsCommentFile">' + escapeHtml(c.filePath) + '</span><button type="button" class="rsDelComment" data-rs-del-comment="' + escapeHtml(c.id) + '" title="' + escapeHtml(t('Delete')) + '">' + SVG_ICONS.close + '</button></div>' +
						'<div class="rsCommentText">' + escapeHtml(c.text) + '</div>' +
					'</div>'
				).join('');

			const risk = d.riskReport;
			const riskHtml = risk
				? '<div class="rsRiskBar grade-' + escapeHtml(risk.grade) + '">' +
					'<span class="rsRiskScore">' + t('Health {0}/100', String(risk.score)) + '</span>' +
					'<span class="rsRiskSummary">' + escapeHtml(risk.evidence[0] ? risk.evidence[0].label : '') + (risk.evidence.length > 1 ? ' (+' + (risk.evidence.length - 1) + ')' : '') + '</span>' +
					'<button type="button" class="rsLinkBtn" data-rs="toggleEvidence">' + (this.evidenceExpanded ? t('Hide Evidence') : t('Inspect Evidence')) + '</button>' +
				'</div>' +
				(this.evidenceExpanded
					? '<div class="rsEvidenceList">' + risk.evidence.map((ev) =>
						'<div class="rsEvidenceItem sev-' + escapeHtml(ev.severity) + '"><span class="rsEvScore">' + (ev.deduction > 0 ? '−' + ev.deduction : '✓') + '</span><b>' + escapeHtml(ev.label) + '</b><span class="rsEvDetail">' + escapeHtml(ev.detail) + '</span></div>'
					).join('') + '</div>'
					: '')
				: '';

			bodyHtml =
				riskHtml +
				'<div class="rsProgressRow">' +
					'<span class="rsRangeLabel">' + escapeHtml(d.baseLabel + ' → ' + d.headLabel) + (d.commitCount > 0 ? ' · ' + d.commitCount + ' ' + t('commits') : '') + '</span>' +
					'<div class="rsProgressBarWrap"><div class="rsProgressBar" style="width:' + pct + '%"></div></div>' +
					'<span class="rsProgressText">' + viewedCount + ' / ' + total + ' ' + t('viewed') + '</span>' +
					'<button type="button" class="rsBtn primary" data-rs="nextUnviewed"' + (viewedCount >= total ? ' disabled' : '') + ' title="Alt+N">' + t('Next Unviewed') + '</button>' +
				'</div>' +
				'<div class="rsGrid">' +
					'<div class="rsFileList">' + filesHtml + '</div>' +
					'<div class="rsNotesPane">' +
						'<div class="rsNotesHeader">' +
							'<span>' + t('Review Notes') + (this.selectedFile ? ' · <code>' + escapeHtml(this.selectedFile) + '</code>' : '') + '</span>' +
							'<span class="rsTemplateBar">' +
								'<button type="button" class="rsTinyBtn" data-rs-template="release" title="' + escapeHtml(t('Insert Release Readiness checklist')) + '">' + t('Release') + '</button>' +
								'<button type="button" class="rsTinyBtn" data-rs-template="security" title="' + escapeHtml(t('Insert Security Audit checklist')) + '">' + t('Security') + '</button>' +
								'<button type="button" class="rsTinyBtn" data-rs-template="refactor" title="' + escapeHtml(t('Insert Refactor / Perf checklist')) + '">' + t('Refactor') + '</button>' +
								'<button type="button" class="rsTinyBtn" data-rs="exportBlueprint" title="' + escapeHtml(t('Copy portable Review Blueprint JSON')) + '">' + t('Export') + '</button>' +
								'<button type="button" class="rsTinyBtn" data-rs="importBlueprint" title="' + escapeHtml(t('Import portable Review Blueprint JSON')) + '">' + t('Import') + '</button>' +
							'</span>' +
						'</div>' +
						'<div class="rsNotesList">' + commentsHtml + '</div>' +
						'<div class="rsComposer">' +
							'<select id="rsCommentSeverity" class="rsSeveritySelect"><option value="blocker">' + t('Blocker') + '</option><option value="suggestion" selected>' + t('Suggestion') + '</option><option value="note">' + t('Note') + '</option></select>' +
							'<textarea id="rsCommentInput" class="rsCommentInput" rows="2" placeholder="' + escapeHtml(t('Add a review note for the selected file…')) + '"></textarea>' +
							'<button type="button" class="rsBtn" data-rs="addComment">' + t('Add Note') + '</button>' +
						'</div>' +
					'</div>' +
				'</div>';
		}

		this.elem.innerHTML =
			'<div class="rsPanel" role="dialog" aria-modal="true" aria-label="' + escapeHtml(t('Review Session')) + '">' +
				'<div class="rsHeader">' +
					'<span class="rsTitle">' + SVG_ICONS.review + '<span>' + t('Review Session') + '</span></span>' +
					'<div class="rsScopes">' + scopeTabs + '</div>' +
					'<button type="button" class="rsCloseBtn" data-rs="close" title="' + t('Close') + '">' + SVG_ICONS.close + '</button>' +
				'</div>' +
				'<div class="rsBody">' + bodyHtml + '</div>' +
				'<div class="rsFooter">' +
					'<button type="button" class="rsBtn" data-rs="aiReviewScope"' + (d === null || d.files.length === 0 ? ' disabled' : '') + '>' + MENU_ICONS.sparkle + t('AI Review Scope') + '</button>' +
					'<button type="button" class="rsBtn" data-rs="copyForAgent"' + (d === null ? ' disabled' : '') + '>' + t('Copy for Coding Agent') + '</button>' +
					'<button type="button" class="rsBtn" data-rs="resetProgress"' + (d === null ? ' disabled' : '') + '>' + t('Reset Progress') + '</button>' +
					'<span class="rsFooterSpacer"></span>' +
					'<button type="button" class="rsBtn" data-rs="close">' + t('Close') + '</button>' +
				'</div>' +
			'</div>';
	}

	private renderWorktreeWip() {
		if (this.elem === null || this.worktreeTarget === null) return;
		const wt = this.worktreeTarget;
		const title = (wt.branch !== null ? wt.branch : (wt.head ? abbrevCommit(wt.head) : t('Detached HEAD')));
		let bodyHtml = '';
		if (this.loading) {
			bodyHtml = '<div class="rsEmpty">' + SVG_ICONS.loading + ' ' + t('Loading worktree changes…') + '</div>';
		} else if (this.error !== null) {
			bodyHtml = '<div class="rsEmpty rsError">' + escapeHtml(this.error) + '</div>';
		} else if (this.worktreeFiles.length === 0) {
			bodyHtml = '<div class="rsEmpty">' + t('This worktree has a clean working tree.') + '</div>';
		} else {
			bodyHtml = '<div class="rsFileList rsWtFileList">' + this.worktreeFiles.map((f) => {
				const badge = f.conflicted ? 'C' : (f.untracked ? 'U' : (f.staged && f.unstaged ? 'SM' : (f.staged ? 'S' : 'M')));
				const gitType = f.untracked ? GG.GitFileStatus.Untracked : (f.indexStatus === 'A' ? GG.GitFileStatus.Added : (f.indexStatus === 'D' || f.workTreeStatus === 'D' ? GG.GitFileStatus.Deleted : (f.indexStatus === 'R' ? GG.GitFileStatus.Renamed : GG.GitFileStatus.Modified)));
				return '<div class="rsFileItem" data-wt-file="' + escapeHtml(f.path) + '" data-wt-old-file="' + escapeHtml(f.oldPath || f.path) + '" data-wt-status="' + escapeHtml(gitType) + '">' +
					'<span class="rsFileType type-' + escapeHtml(gitType) + '">' + badge + '</span>' +
					'<span class="rsFilePath" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>' +
				'</div>';
			}).join('') + '</div>';
		}

		this.elem.innerHTML =
			'<div class="rsPanel rsPanelCompact" role="dialog" aria-modal="true" aria-label="' + escapeHtml(t('Worktree Working Changes')) + '">' +
				'<div class="rsHeader">' +
					'<span class="rsTitle">' + MENU_ICONS.branch + '<span>' + t('Worktree WIP: {0}', escapeHtml(title)) + '</span></span>' +
					'<button type="button" class="rsCloseBtn" data-rs="close" title="' + t('Close') + '">' + SVG_ICONS.close + '</button>' +
				'</div>' +
				'<div class="rsWtPathBar"><code>' + escapeHtml(wt.path) + '</code></div>' +
				'<div class="rsBody">' + bodyHtml + '</div>' +
				'<div class="rsFooter">' +
					(!wt.isCurrent ? '<button type="button" class="rsBtn primary" data-rs="openWtWindow">' + t('Open Worktree in New Window') + '</button>' : '') +
					'<button type="button" class="rsBtn" data-rs="copyWtPath">' + t('Copy Path') + '</button>' +
					'<span class="rsFooterSpacer"></span>' +
					'<button type="button" class="rsBtn" data-rs="close">' + t('Close') + '</button>' +
				'</div>' +
			'</div>';
	}
}
