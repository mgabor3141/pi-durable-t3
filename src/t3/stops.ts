// A Stop that was asked for: the thread shows "Stopping" until its run ends, and "not responding" when that takes long.
// Who asked is kept with it, and after the run ended: the calls the Stop cuts off say so to the model
// (`plain-results.ts`), and so does the next message (`Bridge.sendMessage`). Kept in memory only: after a restart a
// stopped run is still known for one (pi-durable records why a run ended), but not who stopped it.
import type { BridgeCore } from "./bridge-core.ts";
import type { StopBy } from "./plain-results.ts";
import type { ThreadMeta } from "./projection.ts";
import type { ThreadView } from "./thread-view.ts";

type Core = Pick<BridgeCore, "log" | "republish">;

export class Stops {
	readonly #bridge: Core;

	constructor(bridge: Core) {
		this.#bridge = bridge;
	}

	/** Stops of running runs, by thread: the run's task, who asked, when, and when it was found not ending. */
	readonly #stops = new Map<string, { readonly taskId: number; readonly by: StopBy; readonly message: string; readonly requestedAt: number; unresponsiveAt?: number; readonly timer: ReturnType<typeof setTimeout> }>();
	/** Who asked for the last stop of a thread's run, by thread, with that run's task: pi-durable names the task of a run
	 * that ended stopped (`pi.live.runFailure`), so this is said of that run only. */
	readonly #last = new Map<string, { readonly taskId: number; readonly by: StopBy }>();

	/** How long a stopped run may take to end before the thread shows it not responding (T3's Claude adapter waits as
	 * long for a Stop to be confirmed). */
	static confirmMs = 10_000;

	/** `message`: what the banner says of the stop, where it is not a Stop someone pressed or an agent asked for. */
	requested(threadId: string, state: ThreadView, by: StopBy, message = stopMessage(by)): void {
		const taskId = state.view?.docs["pi.live"]?.run?.taskId as number | undefined;
		if (taskId === undefined || this.#stops.get(threadId)?.taskId === taskId) return;
		this.clear(threadId);
		this.#last.set(threadId, { taskId, by });
		const timer = setTimeout(() => {
			const stop = this.#stops.get(threadId);
			if (stop?.timer !== timer) return;
			stop.unresponsiveAt = Date.now();
			this.#bridge.log.warn("stop: the run has not ended", { threadId, runTask: taskId, waitedMs: Stops.confirmMs });
			this.#bridge.republish(threadId);
		}, Stops.confirmMs);
		timer.unref();
		this.#stops.set(threadId, { taskId, by, message, requestedAt: Date.now(), timer });
		this.#bridge.republish(threadId);
	}

	/** Who asked for the stop that is under way on the thread. */
	underWay(threadId: string): StopBy | undefined {
		return this.#stops.get(threadId)?.by;
	}

	/** Who stopped the thread's run whose task is `taskId`, if that is the run last asked to stop. */
	last(threadId: string, taskId: number): StopBy | undefined {
		const last = this.#last.get(threadId);
		return last?.taskId === taskId ? last.by : undefined;
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
		return { requestedAt: stop.requestedAt, message: stop.message, ...(stop.unresponsiveAt === undefined ? {} : { unresponsiveAt: stop.unresponsiveAt }) };
	}

	/** After a projection: a stop whose run is no longer the thread's is over. */
	settle(view: ThreadView): void {
		const stop = this.#stops.get(view.threadId);
		if (stop !== undefined && view.view?.docs["pi.live"]?.run?.taskId !== stop.taskId) this.clear(view.threadId);
	}

	close(): void {
		for (const threadId of [...this.#stops.keys()]) this.clear(threadId);
		this.#last.clear();
	}
}

/** T3's message on the stop a restart's message makes of the run it replaces (its Orchestrator's `queuedRunStop`). */
export const RESTART_STOP_MESSAGE = "Stopped to send a new message";

/** T3's message on a Stop: `RunExecutionService.USER_STOP_REASON` for a person's, and its orchestrator's
 * `agentStopReason` for an agent's, with the reason the agent gave. */
export function stopMessage(by: StopBy): string {
	if (by.by === "user") return "Stopped by user";
	return by.reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${by.reason}`;
}
