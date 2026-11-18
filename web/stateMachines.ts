/**
 * Lightweight zero-dependency finite state machine and DOM dataset projector for the Git Map Webview.
 * Mirrors active state machine statuses onto `document.body.dataset` (`data-sm-*`) for deterministic AX & E2E inspection.
 */
class WebStateMachine<S extends { readonly status: string }, E extends { readonly type: string }> {
	private currentState: S;
	private readonly reducer: (state: S, event: E) => S;
	private boundElem: HTMLElement | null = null;
	private boundDatasetKey: string | null = null;

	constructor(initial: S, reducer: (state: S, event: E) => S) {
		this.currentState = initial;
		this.reducer = reducer;
	}

	public get state(): S {
		return this.currentState;
	}

	public get status(): S['status'] {
		return this.currentState.status;
	}

	public bindDataset(elem: HTMLElement, datasetKey: string): this {
		this.boundElem = elem;
		this.boundDatasetKey = datasetKey;
		if (elem.dataset[datasetKey] !== this.currentState.status) {
			elem.dataset[datasetKey] = this.currentState.status;
		}
		return this;
	}

	public send(event: E): S {
		const next = this.reducer(this.currentState, event);
		if (next !== this.currentState) {
			this.currentState = next;
			if (this.boundElem !== null && this.boundDatasetKey !== null && this.boundElem.dataset[this.boundDatasetKey] !== next.status) {
				this.boundElem.dataset[this.boundDatasetKey] = next.status;
			}
		}
		return this.currentState;
	}
}

function syncBodyStateAttrs(attrs: { [key: string]: string }) {
	const body = document.body;
	if (!body) return;
	const keys = Object.keys(attrs);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const val = attrs[key];
		if (body.dataset[key] !== val) {
			body.dataset[key] = val;
		}
	}
}
