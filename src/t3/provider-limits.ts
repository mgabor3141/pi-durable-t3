// A provider's limit (T3's limit recovery). A request failed and the provider said how long to wait: the harness's own
// retries know nothing of that wait and would fail every time until it is over. So the run ends at the first such
// failure, the thread records when the limit resets, and a reset that is near enough is waited for: the run is
// continued then, with no message written. T3 shows it as its usage limit: "Resumes 9:40 PM", or "Resets …".
import { messageOf } from "../host-errors.ts";
import type { Thread } from "../threads.ts";
import type { BridgeCore } from "./bridge-core.ts";
import { CommandError } from "./errors.ts";
import { limitResetAt, requestedRetryDelayMs } from "./projection.ts";
import { isAssistantEntry, stopReason } from "./runs.ts";
import type { SidebarState } from "./sidebar-state.ts";
import { ThreadTimers } from "./thread-timers.ts";
import type { ThreadView } from "./thread-view.ts";

/** A provider's limit that resets within this long is waited for: the run is continued then. A longer one ends the run,
 * and the user may ask for the same (T3's "Resume at reset"). */
const AUTO_RESUME_WITHIN_MS = 5 * 60 * 60_000;

/** T3's `OrchestrationV2LimitRecoveryUpdate`. */
export type RecoveryUpdate = { readonly runId: string; readonly resetAt: string; readonly autoResume?: boolean; readonly snooze?: boolean };

type Core = Pick<BridgeCore, "config" | "log" | "store" | "closed" | "thread" | "acquire">;

export class ProviderLimits {
	/** How long after the reset a run is continued: a request on the very second is one the provider may still refuse. */
	static resumeMarginMs = 30_000;

	readonly #bridge: Core;
	readonly #sidebar: SidebarState;
	/** Threads whose run is being ended for a limit. */
	readonly #ending = new Set<string>();
	/** The threads that are continued at their reset. */
	readonly #timers: ThreadTimers;

	constructor(bridge: Core, sidebar: SidebarState) {
		this.#bridge = bridge;
		this.#sidebar = sidebar;
		this.#timers = new ThreadTimers((threadId, error) => bridge.log.warn("a run was not continued when its provider's limit reset", { threadId, error: messageOf(error) }));
	}

	/**
	 * After a projection: when the running request failed with a stated wait (`requestedRetryDelayMs`), end the run and
	 * record when the limit resets (`Threads.limitReached`); `arm` then waits for a reset that is near enough.
	 */
	reached(view: ThreadView): void {
		const bridge = this.#bridge;
		const threadId = view.threadId;
		const live = view.view?.docs["pi.live"];
		if (bridge.closed() || this.#ending.has(threadId) || live?.run === undefined || requestedRetryDelayMs(live.generation?.retry?.error) === undefined) return;
		const head = bridge.thread(threadId)?.head;
		const run = view.result?.projection.runs.findLast((candidate) => candidate.status === "running");
		const failed = view.transcript.findLast((entry) => isAssistantEntry(entry) && stopReason(entry) === "error");
		const message = failed?.model?.[0];
		const resetAt = message?.role === "assistant" ? limitResetAt(message) : undefined;
		if (head === undefined || run === undefined || resetAt === undefined) return;
		this.#ending.add(threadId);
		const release = bridge.acquire(threadId);
		void (async () => {
			// Recorded first, so the run ends as one that is waited for: nobody is told in between that it failed.
			// T3's setting "Auto-resume limited threads" waits for any reset, however far; without it, a near one only.
			const autoResume = bridge.config.settings.current().autoResumeLimitedThreads === true || resetAt - Date.now() < AUTO_RESUME_WITHIN_MS;
			await bridge.store.limitReached({ threadId, conversationId: head, runId: run.id as string, resetAt, autoResume });
			// The messages queued behind the run stay queued (`Threads.abort`): they follow it when it is continued.
			await bridge.store.queue.abort({ threadId, conversationId: head });
			bridge.log.info("a provider's limit ended a run", { threadId, resetAt: new Date(resetAt).toISOString(), autoResume });
		})()
			.catch((error: unknown) => bridge.log.warn("a run that reached a provider's limit was not ended; it goes on retrying", { threadId, error: String(error) }))
			.finally(() => {
				this.#ending.delete(threadId);
				release();
			});
	}

	/**
	 * Set, or clear, the timer that continues a thread's run when its limit has reset (`LimitRecovery.autoResume`). It is
	 * read from the thread's record, so a restart keeps the wait.
	 */
	arm(threadId: string, thread: Thread | undefined): void {
		const bridge = this.#bridge;
		const recovery = thread?.limitRecovery;
		this.#timers.arm(threadId, recovery?.autoResume === true ? recovery.resetAt + ProviderLimits.resumeMarginMs : undefined, async () => {
			const release = bridge.acquire(threadId);
			try {
				bridge.log.info("a provider's limit has reset", { threadId, did: await bridge.store.resumeAfterLimit(threadId) });
			} finally {
				release();
			}
		});
	}

	/**
	 * T3's `thread.metadata.update` with `limitRecovery`: "Resume at reset" and "Cancel auto-resume" set `autoResume`,
	 * the snooze beside them hides the thread until the reset. Refused, in T3's words, when the limit it names is not
	 * the one the thread stands at.
	 */
	async configure(threadId: string, update: RecoveryUpdate | null): Promise<void> {
		const bridge = this.#bridge;
		const recovery = bridge.thread(threadId)?.limitRecovery;
		if (update === null) {
			if (recovery !== undefined) await bridge.store.updateRecord(threadId, (record) => void delete record.limitRecovery);
			return;
		}
		const resetAt = Date.parse(update.resetAt);
		if (update.snooze === true && resetAt <= Date.now()) throw new CommandError("The reset time has passed. Retry the thread manually.");
		if (recovery === undefined || recovery.runId !== update.runId || recovery.resetAt !== resetAt || bridge.thread(threadId)?.settledOverride === "settled") {
			throw new CommandError("The provider limit changed before recovery could be configured.");
		}
		const snoozed = recovery.snooze === true;
		await bridge.store.updateRecord(threadId, (record) => {
			if (record.limitRecovery === undefined) return false;
			if (update.autoResume !== undefined) record.limitRecovery.autoResume = update.autoResume;
			if (update.snooze !== undefined) record.limitRecovery.snooze = update.snooze;
		});
		if (update.snooze === true) await this.#sidebar.snooze(threadId, update.resetAt);
		else if (update.snooze === false && snoozed) await this.#sidebar.unsnooze(threadId);
	}

	close(): void {
		this.#timers.close();
	}
}
