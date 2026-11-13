/**
 * The Explain tab of the Commit Details View (when `git-map.ai.explainCommit.enabled` is on): a language model provided in Visual Studio
 * Code (e.g. by GitHub Copilot) explains the commit. Nothing is sent until the person asks for it, and the first time they confirm which
 * model the commit is sent to (unless they choose not to be asked again).
 */
class CommitExplainer {
	public static readonly ICON = '<svg class="explainIcon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z"/></svg>';

	private readonly view: GitGraphView;
	private models: ReadonlyArray<GG.LanguageModelInfo> | null = null;
	private modelsError: GG.ErrorInfo = null;
	private readonly results: Map<string, { text: string, done: boolean, model: string | null, truncated: boolean, error: GG.ErrorInfo }> = new Map();
	private shownHash: string | null = null;

	/**
	 * Construct a new CommitExplainer instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		document.addEventListener('click', (e) => {
			const elem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('#cdvExplainView [data-explain]') : null;
			if (elem === null || this.shownHash === null) return;
			const hash = this.shownHash;
			switch (elem.dataset.explain) {
				case 'explain': {
					const select = <HTMLSelectElement | null>document.getElementById('explainModel'), dontAsk = <HTMLInputElement | null>document.getElementById('explainDontAsk');
					const modelId = select !== null && select.value !== '' ? select.value : null;
					updateGlobalViewState('explainCommitModel', modelId);
					if (dontAsk !== null && dontAsk.checked) updateGlobalViewState('explainCommitAccepted', true);
					this.start(hash);
					break;
				}
				case 'regenerate':
					this.start(hash);
					break;
				case 'copy': {
					const result = this.results.get(hash);
					if (typeof result !== 'undefined') sendMessage({ command: 'copyToClipboard', type: t('Explanation'), data: result.text });
					break;
				}
				case 'cancel': {
					const filesTab = <HTMLElement | null>document.querySelector('.cdvTab[data-tab="files"]');
					if (filesTab !== null) filesTab.click();
					break;
				}
			}
		});
	}

	/**
	 * Show the explanation of a commit in the Explain tab (when it's selected), explaining it if the person has agreed to it.
	 * @param hash The hash of the commit.
	 */
	public show(hash: string) {
		this.shownHash = hash;
		if (!this.results.has(hash) && globalState.explainCommitAccepted === true) {
			this.start(hash);
			return;
		}
		if (this.models === null && this.modelsError === null) sendMessage({ command: 'loadLanguageModels' });
		this.render();
	}

	/**
	 * Process the language models available, loaded by the extension.
	 * @param msg The message containing the models.
	 */
	public processLoadLanguageModelsResponse(msg: GG.ResponseLoadLanguageModels) {
		this.models = msg.models;
		this.modelsError = msg.models.length === 0 ? msg.error : null;
		this.render();
	}

	/**
	 * Process (part of) the explanation of a commit, sent by the extension as it's received.
	 * @param msg The message containing the explanation.
	 */
	public processExplainCommitResponse(msg: GG.ResponseExplainCommit) {
		this.results.set(msg.commitHash, { text: msg.text, done: msg.done, model: msg.model, truncated: msg.truncated, error: msg.error });
		if (msg.commitHash === this.shownHash) this.render();
	}

	private start(hash: string) {
		this.results.set(hash, { text: '', done: false, model: null, truncated: false, error: null });
		sendMessage({ command: 'explainCommit', repo: this.view.currentRepo, commitHash: hash, modelId: typeof globalState.explainCommitModel === 'string' ? globalState.explainCommitModel : null });
		this.render();
	}

	private render() {
		const elem = document.getElementById('cdvExplainView');
		if (elem === null || this.shownHash === null) return;
		const result = this.results.get(this.shownHash);
		if (typeof result === 'undefined') {
			elem.innerHTML = this.getConsentHtml();
			return;
		}
		elem.innerHTML = '<div class="explainResult">' +
			(result.text !== '' ? '<div class="explainText">' + renderExplanationMarkdown(result.text) + '</div>' : '') +
			(!result.done ? '<div class="explainLoading">' + SVG_ICONS.loading + t('Explaining') + ELLIPSIS + '</div>' : '') +
			(result.error !== null ? '<div class="explainError">' + SVG_ICONS.alert + escapeHtml(result.error) + '</div>' : '') +
			(result.done ? '<div class="explainFooter"><span>' + (result.model !== null ? escapeHtml(t('{0} · may be inaccurate', result.model)) : '') + (result.truncated ? ' · ' + t('Only the first part of the changes was sent.') : '') + '</span><span class="explainSpacer"></span>' +
				(result.text !== '' ? '<button type="button" class="cdvActionBtn" data-explain="copy">' + t('Copy') + '</button>' : '') + '<button type="button" class="cdvActionBtn" data-explain="regenerate">' + (result.error !== null && result.text === '' ? t('Try Again') : t('Regenerate')) + '</button></div>' : '') +
			'</div>';
	}

	private getConsentHtml() {
		if (this.modelsError !== null) {
			return '<div class="explainConsent"><div class="explainError">' + SVG_ICONS.alert + escapeHtml(this.modelsError) + '</div></div>';
		}
		const models = this.models, chosen = typeof globalState.explainCommitModel === 'string' ? globalState.explainCommitModel : null;
		const first = models !== null && models.length > 0 ? (models.find((model) => model.id === chosen) || models[0]) : null;
		return '<div class="explainConsent"><div class="explainConsentTitle">' + t('Explain this commit with a language model?') + '</div>' +
			'<p>' + t('The message of the commit and its changes (up to 3,000 lines) are sent to the language model you choose, provided in Visual Studio Code (e.g. by GitHub Copilot). Git Map doesn\'t send them anywhere else.') + '</p>' +
			(models === null
				? '<div class="explainLoading">' + SVG_ICONS.loading + t('Loading') + ELLIPSIS + '</div>'
				: '<label for="explainModel" class="explainLabel">' + t('Model') + '</label><select id="explainModel">' + models.map((model) => '<option value="' + escapeHtml(model.id) + '"' + (first !== null && model.id === first.id ? ' selected' : '') + '>' + escapeHtml(model.name + ' (' + model.vendor + ')') + '</option>').join('') + '</select>' +
				'<label class="explainDontAsk"><input type="checkbox" id="explainDontAsk">' + t('Don\'t ask again') + '</label>' +
				'<div class="explainButtons"><button type="button" class="cdvActionBtn primary" data-explain="explain">' + t('Explain') + '</button><button type="button" class="cdvActionBtn" data-explain="cancel">' + t('Cancel') + '</button></div>') +
			'</div>';
	}
}

/**
 * Render the Markdown of an explanation (headings, lists, bold & code): the text is escaped first, so no HTML in it is rendered.
 * @param markdown The Markdown.
 * @returns The HTML.
 */
function renderExplanationMarkdown(markdown: string) {
	const inline = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
	let html = '', list: 'ul' | 'ol' | null = null;
	const closeList = () => {
		if (list !== null) html += '</' + list + '>';
		list = null;
	};
	markdown.split(/\r?\n/).forEach((line) => {
		let match: RegExpMatchArray | null;
		if ((match = line.match(/^\s*#{1,6}\s+(.*)$/)) !== null) {
			closeList();
			html += '<div class="explainHeading">' + inline(match[1].replace(/\*\*/g, '')) + '</div>';
		} else if ((match = line.match(/^\s*[-*]\s+(.*)$/)) !== null || (match = line.match(/^\s*\d+[.)]\s+(.*)$/)) !== null) {
			const type = /^\s*\d/.test(line) ? 'ol' : 'ul';
			if (list !== type) {
				closeList();
				html += '<' + type + '>';
				list = type;
			}
			html += '<li>' + inline(match[1]) + '</li>';
		} else if (line.trim() === '') {
			closeList();
		} else {
			closeList();
			html += '<p>' + inline(line) + '</p>';
		}
	});
	closeList();
	return html;
}
