/**
 * The Explain tab of the Commit Details View (when `git-map.ai.explainCommit.enabled` is on): a language model (provided in Visual Studio
 * Code, e.g. by GitHub Copilot, or called directly via `git-map.ai.provider`) explains the commit. Nothing is sent until the person asks
 * for it, and the first time they confirm which model & destination the commit is sent to (unless they choose not to be asked again for
 * that destination).
 */
class CommitExplainer {
	public static readonly ICON = '<svg class="explainIcon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z"/></svg>';
	private static readonly MAX_CACHED_RESULTS = 50;

	private readonly view: GitGraphView;
	private models: ReadonlyArray<GG.LanguageModelInfo> | null = null;
	private modelsError: GG.ErrorInfo = null;
	private needsApiKey: boolean = false;
	private readonly results: Map<string, { text: string, done: boolean, model: string | null, truncated: boolean, error: GG.ErrorInfo, stopped: boolean }> = new Map();
	private shownHash: string | null = null;
	private autoStartHash: string | null = null; // Commit waiting for models to load so target consent can be verified

	/**
	 * Construct a new CommitExplainer instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		document.addEventListener('change', (e) => {
			// The consent names the model chosen
			if (!(e.target instanceof HTMLSelectElement) || e.target.id !== 'explainModel' || this.models === null) return;
			const model = this.models.find((model) => model.id === (<HTMLSelectElement>e.target).value), textElem = document.getElementById('explainConsentText');
			if (typeof model !== 'undefined' && textElem !== null) textElem.innerHTML = CommitExplainer.getConsentText(model);
		});
		document.addEventListener('click', (e) => {
			const elem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('#cdvExplainView [data-explain]') : null;
			if (elem === null || this.shownHash === null) return;
			const hash = this.shownHash;
			switch (elem.dataset.explain) {
				case 'explain': {
					const select = <HTMLSelectElement | null>document.getElementById('explainModel'), dontAsk = <HTMLInputElement | null>document.getElementById('explainDontAsk');
					const modelId = select !== null && select.value !== '' ? select.value : null;
					const selected = this.getSelectedModel(modelId);
					updateGlobalViewState('explainCommitModel', modelId);
					if (dontAsk !== null && dontAsk.checked && selected !== null) {
						updateGlobalViewState('explainCommitAccepted', true);
						updateGlobalViewState('explainCommitAcceptedTarget', CommitExplainer.getConsentTarget(selected));
					}
					this.start(hash);
					break;
				}
				case 'setApiKey':
					sendMessage({ command: 'setAiApiKey' });
					break;
				case 'stop':
					sendMessage({ command: 'cancelExplainCommit' });
					break;
				case 'changeModel':
					updateGlobalViewState('explainCommitAccepted', false);
					updateGlobalViewState('explainCommitAcceptedTarget', null);
					this.results.delete(this.getKey(hash));
					sendMessage({ command: 'loadLanguageModels' });
					this.render();
					break;
				case 'regenerate':
					if (!this.isTargetAccepted()) {
						this.results.delete(this.getKey(hash));
						if (this.models === null || this.modelsError !== null) sendMessage({ command: 'loadLanguageModels' });
						this.render();
					} else {
						this.start(hash);
					}
					break;
				case 'copy': {
					const result = this.results.get(this.getKey(hash));
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

	private getKey(hash: string) {
		return this.view.currentRepo + ':' + hash;
	}

	private getSelectedModel(preferredId?: string | null): GG.LanguageModelInfo | null {
		if (this.models === null || this.models.length === 0) return null;
		const chosen = typeof preferredId !== 'undefined' ? preferredId : (typeof globalState.explainCommitModel === 'string' ? globalState.explainCommitModel : null);
		return this.models.find((model) => model.id === chosen) || this.models[0];
	}

	private static getConsentTarget(model: GG.LanguageModelInfo) {
		return model.endpoint !== null ? 'direct:' + model.vendor + ':' + model.endpoint : 'vscode:' + model.vendor;
	}

	private isTargetAccepted() {
		if (globalState.explainCommitAccepted !== true) return false;
		const selected = this.getSelectedModel();
		if (selected === null) return false;
		return typeof globalState.explainCommitAcceptedTarget === 'string' && globalState.explainCommitAcceptedTarget === CommitExplainer.getConsentTarget(selected);
	}

	/**
	 * Cancel an in-progress explanation stream when closing the Commit Details View or switching commits.
	 */
	public cancelIfStreaming() {
		let streaming = false;
		this.results.forEach((entry) => {
			if (!entry.done) streaming = true;
		});
		if (streaming) sendMessage({ command: 'cancelExplainCommit' });
	}

	/**
	 * Show the explanation of a commit in the Explain tab (when it's selected), explaining it if the person has agreed to the active destination.
	 * @param hash The hash of the commit.
	 */
	public show(hash: string) {
		this.shownHash = hash;
		this.autoStartHash = null;
		if (!this.results.has(this.getKey(hash)) && globalState.explainCommitAccepted === true) {
			if (this.isTargetAccepted()) {
				this.start(hash);
				return;
			}
			if (this.models === null && this.modelsError === null) {
				this.autoStartHash = hash;
			}
		}
		if (this.models === null || this.modelsError !== null) sendMessage({ command: 'loadLanguageModels' });
		this.render();
	}

	/**
	 * Process the language models available, loaded by the extension.
	 * @param msg The message containing the models.
	 */
	public processLoadLanguageModelsResponse(msg: GG.ResponseLoadLanguageModels) {
		this.models = msg.models;
		this.modelsError = msg.models.length === 0 ? msg.error : null;
		this.needsApiKey = msg.models.length === 0 && msg.needsApiKey;
		if (this.autoStartHash !== null && this.autoStartHash === this.shownHash && !this.results.has(this.getKey(this.autoStartHash))) {
			const hash = this.autoStartHash;
			this.autoStartHash = null;
			if (this.isTargetAccepted()) {
				this.start(hash);
				return;
			}
		}
		this.autoStartHash = null;
		this.render();
	}

	/**
	 * Process (part of) the explanation of a commit, sent by the extension as it's received.
	 * @param msg The message containing the explanation.
	 */
	public processExplainCommitResponse(msg: GG.ResponseExplainCommit) {
		const key = this.getKey(msg.commitHash);
		if (msg.cancelled === true) {
			if (msg.text === '') {
				this.results.delete(key);
			} else {
				this.setResult(key, { text: msg.text, done: true, model: msg.model, truncated: msg.truncated, error: null, stopped: true });
			}
		} else {
			this.setResult(key, { text: msg.text, done: msg.done, model: msg.model, truncated: msg.truncated, error: msg.error, stopped: false });
		}
		if (msg.commitHash === this.shownHash) this.render(!msg.done);
	}

	private setResult(key: string, value: { text: string, done: boolean, model: string | null, truncated: boolean, error: GG.ErrorInfo, stopped: boolean }) {
		if (!this.results.has(key) && this.results.size >= CommitExplainer.MAX_CACHED_RESULTS) {
			const oldest = this.results.keys().next().value;
			if (typeof oldest === 'string') this.results.delete(oldest);
		}
		this.results.set(key, value);
	}

	private start(hash: string) {
		const selected = this.getSelectedModel();
		const modelId = selected !== null ? selected.id : (typeof globalState.explainCommitModel === 'string' ? globalState.explainCommitModel : null);
		this.setResult(this.getKey(hash), { text: '', done: false, model: null, truncated: false, error: null, stopped: false });
		sendMessage({
			command: 'explainCommit',
			repo: this.view.currentRepo,
			commitHash: hash,
			modelId: modelId,
			endpoint: selected !== null ? selected.endpoint : undefined
		});
		this.render();
	}

	private render(streamingChunk: boolean = false) {
		const elem = document.getElementById('cdvExplainView');
		if (elem === null || this.shownHash === null || elem.classList.contains('hidden')) return;
		const result = this.results.get(this.getKey(this.shownHash));
		if (typeof result === 'undefined') {
			elem.innerHTML = this.getConsentHtml();
			return;
		}
		if (streamingChunk && !result.done && result.error === null) {
			const existingResult = elem.querySelector('.explainResult'), existingLoading = elem.querySelector('.explainLoading');
			if (existingResult !== null && existingLoading !== null) {
				let textElem = existingResult.querySelector('.explainText');
				const selection = window.getSelection();
				if (selection !== null && !selection.isCollapsed && textElem !== null && textElem.contains(selection.anchorNode)) {
					return; // Preserve active text selection until streaming finishes
				}
				if (result.text !== '') {
					if (textElem === null) {
						textElem = document.createElement('div');
						textElem.className = 'explainText';
						existingResult.insertBefore(textElem, existingLoading);
					}
					textElem.innerHTML = renderExplanationMarkdown(result.text);
				}
				return;
			}
		}
		const meta: string[] = [];
		if (result.model !== null) meta.push(escapeHtml(t('{0} · may be inaccurate', result.model)));
		if (result.stopped) meta.push(escapeHtml(t('Stopped')));
		if (result.truncated) meta.push(escapeHtml(t('Only the first part of the changes was sent.')));
		elem.innerHTML = '<div class="explainResult">' +
			(result.text !== '' ? '<div class="explainText">' + renderExplanationMarkdown(result.text) + '</div>' : '') +
			(!result.done ? '<div class="explainLoading">' + SVG_ICONS.loading + '<span>' + t('Explaining') + ELLIPSIS + '</span><span class="explainSpacer"></span><button type="button" class="cdvActionBtn" data-explain="stop">' + t('Stop') + '</button></div>' : '') +
			(result.error !== null ? '<div class="explainError">' + SVG_ICONS.alert + escapeHtml(result.error) + '</div>' : '') +
			(result.done ? '<div class="explainFooter"><span>' + meta.join(' · ') + '</span><span class="explainSpacer"></span>' +
				'<button type="button" class="cdvActionBtn" data-explain="changeModel">' + t('Model') + ELLIPSIS + '</button>' +
				(result.text !== '' ? '<button type="button" class="cdvActionBtn" data-explain="copy">' + t('Copy') + '</button>' : '') + '<button type="button" class="cdvActionBtn" data-explain="regenerate">' + (result.error !== null && result.text === '' ? t('Try Again') : t('Regenerate')) + '</button></div>' : '') +
			'</div>';
	}

	/**
	 * Get the name of the provider of a language model (e.g. "GitHub Copilot" for the vendor "copilot").
	 */
	private static getProviderName(model: GG.LanguageModelInfo) {
		return model.vendor === 'copilot' ? 'GitHub Copilot' : model.vendor;
	}

	/**
	 * Get the text saying what's sent to a language model, which model it is, and where it's sent.
	 */
	private static getConsentText(model: GG.LanguageModelInfo | null) {
		if (model === null) {
			return t('The message of the commit and its changes (up to 3,000 lines) are only sent when you ask for an explanation.');
		}
		if (model.endpoint !== null) {
			return t('The message of the commit and its changes (up to 3,000 lines) are sent to {0} ({1}) at {2}. Git Map doesn\'t send them anywhere else.', '<b>' + escapeHtml(model.name) + '</b>', escapeHtml(CommitExplainer.getProviderName(model)), '<b>' + escapeHtml(model.endpoint) + '</b>');
		}
		return t('The message of the commit and its changes (up to 3,000 lines) are sent to {0}, provided by {1} in Visual Studio Code. Git Map doesn\'t send them anywhere else.', '<b>' + escapeHtml(model.name) + '</b>', '<b>' + escapeHtml(CommitExplainer.getProviderName(model)) + '</b>');
	}

	private getConsentHtml() {
		if (this.modelsError !== null) {
			return '<div class="explainConsent"><div class="explainError">' + SVG_ICONS.alert + escapeHtml(this.modelsError) + '</div>' +
				(this.needsApiKey ? '<div class="explainButtons"><button type="button" class="cdvActionBtn primary" data-explain="setApiKey">' + t('Set API Key') + ELLIPSIS + '</button></div>' : '') +
				'</div>';
		}
		const models = this.models, first = this.getSelectedModel();
		return '<div class="explainConsent"><div class="explainConsentTitle">' + t('Explain this commit with a language model?') + '</div>' +
			'<p id="explainConsentText">' + CommitExplainer.getConsentText(first) + '</p>' +
			(models === null
				? '<div class="explainLoading">' + SVG_ICONS.loading + t('Loading') + ELLIPSIS + '</div>'
				: '<label for="explainModel" class="explainLabel">' + t('Model') + '</label><select id="explainModel">' + models.map((model) => '<option value="' + escapeHtml(model.id) + '"' + (first !== null && model.id === first.id ? ' selected' : '') + '>' + escapeHtml(model.name + ' (' + CommitExplainer.getProviderName(model) + ')') + '</option>').join('') + '</select>' +
				'<label class="explainDontAsk"><input type="checkbox" id="explainDontAsk"><span class="customCheckbox"></span>' + t('Don\'t ask again') + '</label>' +
				'<div class="explainButtons"><button type="button" class="cdvActionBtn primary" data-explain="explain">' + t('Explain') + '</button><button type="button" class="cdvActionBtn" data-explain="cancel">' + t('Cancel') + '</button></div>') +
			'</div>';
	}
}

/**
 * Render the Markdown of an explanation (headings, lists, fenced code blocks, bold & inline code): the text is escaped first, so no HTML in
 * it is rendered, and inline code spans are protected from bold formatting.
 * @param markdown The Markdown.
 * @returns The HTML.
 */
function renderExplanationMarkdown(markdown: string) {
	const inline = (text: string) => text.split(/(`[^`]+`)/g).map((part) => {
		if (part.length >= 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
			return '<code>' + escapeHtml(part.substring(1, part.length - 1)) + '</code>';
		}
		return escapeHtml(part).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
	}).join('');
	let html = '', list: 'ul' | 'ol' | null = null, codeFence: string | null = null, codeLines: string[] = [];
	const closeList = () => {
		if (list !== null) html += '</' + list + '>';
		list = null;
	};
	const closeCode = () => {
		if (codeFence !== null) {
			html += '<pre class="explainCode"><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>';
			codeFence = null;
			codeLines = [];
		}
	};
	markdown.split(/\r?\n/).forEach((line) => {
		let match: RegExpMatchArray | null;
		if (codeFence !== null) {
			if (new RegExp('^\\s*' + codeFence + '\\s*$').test(line)) {
				closeCode();
			} else {
				codeLines.push(line);
			}
			return;
		}
		if ((match = line.match(/^\s*(`{3,})/)) !== null) {
			closeList();
			codeFence = match[1];
			return;
		}
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
	closeCode();
	closeList();
	return html;
}
