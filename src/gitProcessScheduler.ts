export interface SchedulerCancellationLike {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: (listener: () => unknown) => { readonly dispose: () => unknown };
}

export interface GitProcessSchedulerStats {
	readonly active: number;
	readonly queued: number;
	readonly maxConcurrent: number;
}

interface QueuedTask {
	readonly start: () => void;
	readonly cancel: () => void;
}

/**
 * Bounds the number of concurrent Git child processes spawned by Git Map.
 * Prevents process storms and `.git/index.lock` contention during multi-repo or
 * multi-worktree refreshes while preserving FIFO fairness and cancellation.
 */
export class GitProcessScheduler {
	private maxConcurrent: number;
	private activeCount: number = 0;
	private readonly queue: QueuedTask[] = [];

	constructor(maxConcurrent: number = 8) {
		this.maxConcurrent = clampMaxConcurrent(maxConcurrent);
	}

	public setMaxConcurrent(maxConcurrent: number) {
		this.maxConcurrent = clampMaxConcurrent(maxConcurrent);
		this.drain();
	}

	public getStats(): GitProcessSchedulerStats {
		return {
			active: this.activeCount,
			queued: this.queue.length,
			maxConcurrent: this.maxConcurrent
		};
	}

	public run<T>(task: () => Promise<T>, cancellation?: SchedulerCancellationLike | null): Promise<T> {
		if (cancellation && cancellation.isCancellationRequested) {
			return Promise.reject('Cancelled');
		}
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			let cancelSub: { readonly dispose: () => unknown } | null = null;

			const cleanupCancel = () => {
				if (cancelSub !== null) {
					cancelSub.dispose();
					cancelSub = null;
				}
			};

			const execute = () => {
				if (settled) return;
				cleanupCancel();
				this.activeCount++;
				let promise: Promise<T>;
				try {
					promise = task();
				} catch (err) {
					this.activeCount = Math.max(0, this.activeCount - 1);
					settled = true;
					this.drain();
					reject(err);
					return;
				}
				promise.then((val) => {
					this.activeCount = Math.max(0, this.activeCount - 1);
					settled = true;
					this.drain();
					resolve(val);
				}, (err) => {
					this.activeCount = Math.max(0, this.activeCount - 1);
					settled = true;
					this.drain();
					reject(err);
				});
			};

			if (this.activeCount < this.maxConcurrent) {
				execute();
				return;
			}

			const entry: QueuedTask = {
				start: execute,
				cancel: () => {
					if (settled) return;
					settled = true;
					cleanupCancel();
					const idx = this.queue.indexOf(entry);
					if (idx !== -1) this.queue.splice(idx, 1);
					reject('Cancelled');
				}
			};
			this.queue.push(entry);

			if (cancellation && typeof cancellation.onCancellationRequested === 'function') {
				cancelSub = cancellation.onCancellationRequested(() => entry.cancel());
			}
		});
	}

	private drain() {
		while (this.activeCount < this.maxConcurrent && this.queue.length > 0) {
			const next = this.queue.shift()!;
			next.start();
		}
	}
}

function clampMaxConcurrent(value: number) {
	if (!Number.isFinite(value)) return 8;
	return Math.max(1, Math.min(32, Math.floor(value)));
}
