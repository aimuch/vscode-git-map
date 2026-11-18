/**
 * Typed finite state machine and async request sequencing primitives used across the Git Map Extension Host.
 * Designed to eliminate implicit boolean/nullable state drift (UX), centralize invariants (DX), and expose deterministic statuses (AX).
 */

export type StateTransitionListener<S, E> = (next: S, prev: S, event: E) => void;

export class StateMachine<S extends { readonly status: string }, E extends { readonly type: string }> {
	private current: S;
	private readonly reducer: (state: S, event: E) => S;
	private readonly listeners: Set<StateTransitionListener<S, E>> = new Set();

	constructor(initial: S, reducer: (state: S, event: E) => S) {
		this.current = initial;
		this.reducer = reducer;
	}

	public get state(): S {
		return this.current;
	}

	public get status(): S['status'] {
		return this.current.status;
	}

	public send(event: E): S {
		const prev = this.current;
		const next = this.reducer(prev, event);
		if (next !== prev) {
			this.current = next;
			this.listeners.forEach((listener) => listener(next, prev, event));
		}
		return this.current;
	}

	public onTransition(listener: StateTransitionListener<S, E>): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export type AsyncRequestState =
	| { readonly status: 'idle'; readonly seq: number }
	| { readonly status: 'loading'; readonly seq: number }
	| { readonly status: 'ready'; readonly seq: number }
	| { readonly status: 'error'; readonly seq: number };

type AsyncRequestEvent =
	| { readonly type: 'BEGIN'; readonly seq: number }
	| { readonly type: 'COMPLETE'; readonly seq: number }
	| { readonly type: 'FAIL'; readonly seq: number }
	| { readonly type: 'CANCEL'; readonly seq: number };

/**
 * Monotonic request sequencer that prevents out-of-order async Git / IPC responses from overwriting newer UI state.
 */
export class AsyncRequestSequencer {
	private counter: number = 0;
	private readonly machine: StateMachine<AsyncRequestState, AsyncRequestEvent>;

	constructor() {
		this.machine = new StateMachine<AsyncRequestState, AsyncRequestEvent>(
			{ status: 'idle', seq: 0 },
			(state, event) => {
				switch (event.type) {
					case 'BEGIN':
						return { status: 'loading', seq: event.seq };
					case 'COMPLETE':
						return state.status === 'loading' && state.seq === event.seq
							? { status: 'ready', seq: event.seq }
							: state;
					case 'FAIL':
						return state.status === 'loading' && state.seq === event.seq
							? { status: 'error', seq: event.seq }
							: state;
					case 'CANCEL':
						return { status: 'idle', seq: event.seq };
				}
			}
		);
	}

	public get status(): AsyncRequestState['status'] {
		return this.machine.status;
	}

	public get currentSeq(): number {
		return this.machine.state.seq;
	}

	public begin(): number {
		const seq = ++this.counter;
		this.machine.send({ type: 'BEGIN', seq: seq });
		return seq;
	}

	public isCurrent(seq: number): boolean {
		return this.machine.state.status === 'loading' && this.machine.state.seq === seq;
	}

	public complete(seq: number): boolean {
		if (!this.isCurrent(seq)) return false;
		this.machine.send({ type: 'COMPLETE', seq: seq });
		return true;
	}

	public fail(seq: number): boolean {
		if (!this.isCurrent(seq)) return false;
		this.machine.send({ type: 'FAIL', seq: seq });
		return true;
	}

	public cancel(): void {
		const seq = ++this.counter;
		this.machine.send({ type: 'CANCEL', seq: seq });
	}
}

export type PanelDirtyState =
	| { readonly kind: 'none' }
	| { readonly kind: 'partial'; readonly ai: boolean; readonly cdv: boolean }
	| { readonly kind: 'full' };

export interface PanelSyncState {
	readonly status: 'unloaded' | 'visible' | 'hidden';
	readonly visible: boolean;
	readonly loaded: boolean;
	readonly dirty: PanelDirtyState;
}

export type PanelSyncEvent =
	| { readonly type: 'GRAPH_RENDERED'; readonly loaded: boolean; readonly visible: boolean }
	| { readonly type: 'SET_VISIBLE'; readonly visible: boolean }
	| { readonly type: 'MARK_FULL_DIRTY' }
	| { readonly type: 'MARK_AI_DIRTY' }
	| { readonly type: 'MARK_CDV_DIRTY' }
	| { readonly type: 'CONSUME_DIRTY' };

const DIRTY_NONE: PanelDirtyState = { kind: 'none' };
const DIRTY_FULL: PanelDirtyState = { kind: 'full' };

function computePanelStatus(loaded: boolean, visible: boolean): PanelSyncState['status'] {
	if (!loaded) return 'unloaded';
	return visible ? 'visible' : 'hidden';
}

/**
 * Explicit state machine for GitGraphView visibility and deferred configuration sync.
 * Enforces the lattice `none < partial(ai, cdv) < full` so full HTML rebuilds cleanly dominate partial postMessage syncs.
 */
export class PanelSyncMachine {
	public readonly machine: StateMachine<PanelSyncState, PanelSyncEvent>;

	constructor(initiallyVisible: boolean = true) {
		this.machine = new StateMachine<PanelSyncState, PanelSyncEvent>(
			{
				status: 'unloaded',
				visible: initiallyVisible,
				loaded: false,
				dirty: DIRTY_NONE
			},
			(state, event) => {
				switch (event.type) {
					case 'GRAPH_RENDERED':
						return {
							status: computePanelStatus(event.loaded, event.visible),
							visible: event.visible,
							loaded: event.loaded,
							dirty: DIRTY_NONE
						};
					case 'SET_VISIBLE':
						if (state.visible === event.visible) return state;
						return {
							status: computePanelStatus(state.loaded, event.visible),
							visible: event.visible,
							loaded: state.loaded,
							dirty: state.dirty
						};
					case 'MARK_FULL_DIRTY':
						if (state.dirty.kind === 'full') return state;
						return { ...state, dirty: DIRTY_FULL };
					case 'MARK_AI_DIRTY': {
						if (state.dirty.kind === 'full') return state;
						const prevCdv = state.dirty.kind === 'partial' ? state.dirty.cdv : false;
						if (state.dirty.kind === 'partial' && state.dirty.ai) return state;
						return { ...state, dirty: { kind: 'partial', ai: true, cdv: prevCdv } };
					}
					case 'MARK_CDV_DIRTY': {
						if (state.dirty.kind === 'full') return state;
						const prevAi = state.dirty.kind === 'partial' ? state.dirty.ai : false;
						if (state.dirty.kind === 'partial' && state.dirty.cdv) return state;
						return { ...state, dirty: { kind: 'partial', ai: prevAi, cdv: true } };
					}
					case 'CONSUME_DIRTY':
						if (state.dirty.kind === 'none') return state;
						return { ...state, dirty: DIRTY_NONE };
				}
			}
		);
	}

	public get state(): PanelSyncState {
		return this.machine.state;
	}

	public markGraphRendered(loaded: boolean, visible: boolean): PanelSyncState {
		return this.machine.send({ type: 'GRAPH_RENDERED', loaded: loaded, visible: visible });
	}

	public setVisible(visible: boolean): PanelSyncState {
		return this.machine.send({ type: 'SET_VISIBLE', visible: visible });
	}

	public markFullDirty(): PanelSyncState {
		return this.machine.send({ type: 'MARK_FULL_DIRTY' });
	}

	public markAiDirty(): PanelSyncState {
		return this.machine.send({ type: 'MARK_AI_DIRTY' });
	}

	public markCdvDirty(): PanelSyncState {
		return this.machine.send({ type: 'MARK_CDV_DIRTY' });
	}

	public consumeDirty(): PanelDirtyState {
		const prevDirty = this.machine.state.dirty;
		this.machine.send({ type: 'CONSUME_DIRTY' });
		return prevDirty;
	}
}
