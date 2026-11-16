// A Stop that was pressed: the thread shows "Stopping" until its run ends, and "not responding" when that takes long.
import type { BridgeCore } from "./bridge-core.ts";
import type { ThreadMeta } from "./projection.ts";
import type { ThreadView } from "./thread-view.ts";

type Core = Pick<BridgeCore, "log" | "republish">;

export class Stops {
	readonly #bridge: Core;

	constructor(bridge: Core) {
		this.#bridge = bridge;
	}

	/** Stops of running runs, by thread: the run's task, when Stop was pressed, and when it was found not ending. */
	readonly #stops = new Map<string, { readonly taskId: number; readonly requestedAt: number; unresponsiveAt?: number; readonly timer: ReturnType<typeof setTimeout> }>();

	/** How long a stopped run may take to end before the thread shows it not responding (T3's Claude adapter waits as
	 * long for a Stop to be confirmed). */
	static confirmMs = 10_000;

	requested(threadId: string, state: ThreadView): void {
		const taskId = state.view?.docs["pi.live"]?.run?.taskId as number | undefined;
		if (taskId === undefined || this.#stops.get(threadId)?.taskId === taskId) return;
		this.clear(threadId);
		const timer = setTimeout(() => {
			const stop = this.#stops.get(threadId);
			if (stop?.timer !== timer) return;
			stop.unresponsiveAt = Date.now();
			this.#bridge.log.warn("stop: the run has not ended", { threadId, runTask: taskId, waitedMs: Stops.confirmMs });
			this.#bridge.republish(threadId);
		}, Stops.confirmMs);
		timer.unref();
		this.#stops.set(threadId, { taskId, requestedAt: Date.now(), timer });
		this.#bridge.republish(threadId);
	}

	clear(threadId: string): void {
		const stop = this.#stops.get(threadId);
		if (stop === undefined) return;
		clearTimeout(stop.timer);
		this.#stops.delete(threadId);
	}

	/** The Stop shown on the thread's running run, if its run is the one stopped. */
	of(threadId: string, state: ThreadView | undefined): ThreadMeta["stop"] {
		const stop = this.#stops.get(threadId);
		if (stop === undefined || state?.view?.docs["pi.live"]?.run?.taskId !== stop.taskId) return undefined;
		return { requestedAt: stop.requestedAt, ...(stop.unresponsiveAt === undefined ? {} : { unresponsiveAt: stop.unresponsiveAt }) };
	}

	/** After a projection: a stop whose run is no longer the thread's is over. */
	settle(view: ThreadView): void {
		const stop = this.#stops.get(view.threadId);
		if (stop !== undefined && view.view?.docs["pi.live"]?.run?.taskId !== stop.taskId) this.clear(view.threadId);
	}

	close(): void {
		for (const threadId of [...this.#stops.keys()]) this.clear(threadId);
	}
}
