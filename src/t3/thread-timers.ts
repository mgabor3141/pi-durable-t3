// One timer a thread, for the things the bridge does to a thread at a later time (continue it when a provider's limit
// has reset, compact it before its prompt cache expires). Arming replaces what was armed; a time further off than a
// timer can hold is waited for in pieces; no timer keeps the process alive.

/** The longest wait a timer takes (2^31 - 1 ms, about 24.8 days). */
const TIMER_MAX_MS = 2 ** 31 - 1;

export class ThreadTimers {
	readonly #armed = new Map<string, { timer?: NodeJS.Timeout }>();
	readonly #failed: (threadId: string, error: unknown) => void;
	#closed = false;

	/** `failed`: a time that could not be worked out, or a `fire` that threw. */
	constructor(failed: (threadId: string, error: unknown) => void) {
		this.#failed = failed;
	}

	/**
	 * Replace the thread's timer: `fire` runs at `at` (epoch ms; at once when that has passed), unless the thread is
	 * armed again or cleared first. `at` may still be worked out (a promise); `undefined` arms nothing.
	 */
	arm(threadId: string, at: number | undefined | Promise<number | undefined>, fire: () => void | Promise<void>): void {
		this.clear(threadId);
		if (this.#closed || at === undefined) return;
		const armed: { timer?: NodeJS.Timeout } = {};
		this.#armed.set(threadId, armed);
		const current = () => this.#armed.get(threadId) === armed;
		const wait = (atMs: number): void => {
			const ms = atMs - Date.now();
			armed.timer = setTimeout(
				() => {
					if (!current()) return;
					if (ms > TIMER_MAX_MS) return wait(atMs);
					this.#armed.delete(threadId);
					void (async () => fire())().catch((error: unknown) => this.#failed(threadId, error));
				},
				Math.min(Math.max(ms, 0), TIMER_MAX_MS),
			);
			armed.timer.unref();
		};
		if (typeof at === "number") return wait(at);
		at.then(
			(atMs) => {
				if (!current()) return;
				if (atMs === undefined) return void this.#armed.delete(threadId);
				wait(atMs);
			},
			(error: unknown) => {
				if (current()) this.#armed.delete(threadId);
				this.#failed(threadId, error);
			},
		);
	}

	clear(threadId: string): void {
		clearTimeout(this.#armed.get(threadId)?.timer);
		this.#armed.delete(threadId);
	}

	/** Clear every timer; nothing is armed afterwards. */
	close(): void {
		this.#closed = true;
		for (const armed of this.#armed.values()) clearTimeout(armed.timer);
		this.#armed.clear();
	}
}
