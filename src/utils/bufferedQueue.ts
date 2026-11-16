import { Disposable, toDisposable } from './disposable';

/**
 * Represents a BufferedQueue, which is queue that buffers items for a short period of time before processing them.
 */
export class BufferedQueue<T> extends Disposable {
	private readonly items: Set<T> = new Set();
	private timeout: NodeJS.Timeout | null = null;
	private processing: boolean = false;

	private readonly bufferDuration: number;
	private onItem: (item: T) => Promise<boolean>;
	private onChanges: () => void;

	protected get queue() {
		return Array.from(this.items);
	}

	/**
	 * Constructs a BufferedQueue instance.
	 * @param onItem A callback invoked to process an item in the queue.
	 * @param onChanges A callback invoked when a change was indicated by onItem.
	 * @param bufferDuration The number of milliseconds to buffer items in the queue.
	 * @returns The BufferedQueue instance.
	 */
	constructor(onItem: (item: T) => Promise<boolean>, onChanges: () => void, bufferDuration: number = 1000) {
		super();
		this.bufferDuration = bufferDuration;
		this.onItem = onItem;
		this.onChanges = onChanges;

		this.registerDisposable(toDisposable(() => {
			if (this.timeout !== null) {
				clearTimeout(this.timeout);
				this.timeout = null;
			}
		}));
	}

	/**
	 * Enqueue an item if it doesn't already exist in the queue.
	 * @param item The item to enqueue.
	 */
	public enqueue(item: T) {
		this.items.delete(item);
		this.items.add(item);

		if (!this.processing) {
			if (this.timeout !== null) {
				clearTimeout(this.timeout);
			}
			this.timeout = setTimeout(() => {
				this.timeout = null;
				this.run();
			}, this.bufferDuration);
		}
	}

	/**
	 * Process all of the items that are currently queued, and call the onChanges callback if any of the items resulted in a change
	 */
	private async run() {
		this.processing = true;
		let changes = false;
		while (this.items.size > 0) {
			const item = this.items.values().next().value!;
			this.items.delete(item);
			if (await this.onItem(item)) {
				changes = true;
			}
		}
		this.processing = false;
		if (changes) this.onChanges();
	}
}
