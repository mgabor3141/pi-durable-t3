// Thread titles (T3's Orchestrator `titleRegeneration` and ThreadTitleRegenerationService): one current title request
// a thread, in memory only (state.md), answered by the integrator's `titleThread` hook.
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { BridgeCore } from "./bridge-core.ts";
import type { TitleThreadRequest } from "./config.ts";
import { USER_ENTRY_KINDS } from "./runs.ts";
import type { ThreadView } from "./thread-view.ts";

type Core = Pick<BridgeCore, "config" | "log" | "store" | "thread" | "acquire" | "view" | "republish" | "hasThread" | "textGenerationModel">;

/** T3's `lastTitleRegeneration`: how the last "regenerate" ended, which the web app reports ("Title kept", or why it
 * failed). In memory, as the request it answers is. */
export type TitleRegenerationOutcome = { readonly status: "renamed" | "unchanged" | "failed"; readonly message?: string; readonly requestId: string; readonly completedAt: number };

/** T3's `failureMessage`: the last line of what went wrong, at most 300 characters. */
const MAX_FAILURE_MESSAGE_LENGTH = 300;
function failureMessage(error: unknown): string {
	const detail = (error instanceof Error ? error.message : String(error))
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.at(-1);
	if (detail === undefined) return "Title generation failed.";
	return detail.length > MAX_FAILURE_MESSAGE_LENGTH ? `${detail.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…` : detail;
}

export class ThreadTitles {
	readonly #bridge: Core;
	readonly #requests = new Map<string, { requestId: string; startedAt: number; reason: TitleThreadRequest["reason"]; controller: AbortController }>();
	readonly #outcomes = new Map<string, TitleRegenerationOutcome>();

	constructor(bridge: Core) {
		this.#bridge = bridge;
	}

	/** T3's `titleRegeneration` of the thread's row: the request that is pending, or `null`. */
	pending(threadId: string): { requestId: string; startedAt: number } | null {
		const pending = this.#requests.get(threadId);
		return pending === undefined ? null : { requestId: pending.requestId, startedAt: pending.startedAt };
	}

	/** T3's `lastTitleRegeneration` of the thread's row: how its last "regenerate" ended, or `null`. */
	lastOutcome(threadId: string): TitleRegenerationOutcome | null {
		return this.#outcomes.get(threadId) ?? null;
	}

	/** Store a title and show it. `renamed`: a rename (`true`) or a generated title (`false`) sets `titleRenamed`; a
	 * first message's seed (absent) leaves it. */
	async store(threadId: string, title: string, renamed?: boolean): Promise<void> {
		await this.#bridge.store.rename(threadId, title, renamed);
		this.#bridge.republish(threadId);
	}

	/** Start a request (`titleRegeneration: { requestId, startedAt }`), superseding any pending one. */
	begin(threadId: string, requestId: string, reason: TitleThreadRequest["reason"]): void {
		if (this.#bridge.config.titleThread === undefined) return;
		this.cancel(threadId);
		this.#requests.set(threadId, { requestId, startedAt: Date.now(), reason, controller: new AbortController() });
		this.#bridge.republish(threadId);
	}

	/** Drop the pending request, aborting its signal (a rename, a newer request, a delete). */
	cancel(threadId: string): void {
		const pending = this.#requests.get(threadId);
		if (pending === undefined) return;
		this.#requests.delete(threadId);
		pending.controller.abort();
		this.#bridge.republish(threadId);
	}

	/**
	 * T3's `thread.title.regeneration.complete`: applied only while `requestId` is still current. A "New thread" (or, on
	 * regenerate, the unchanged title) changes nothing (ThreadTitleRegenerationService). A "regenerate" records how it
	 * ended (`lastOutcome`) before the request is dropped, so the client sees both in one shell update.
	 */
	async complete(threadId: string, requestId: string, result: { readonly title?: string | undefined; readonly previousTitle?: string; readonly failure?: string } = {}): Promise<void> {
		const pending = this.#requests.get(threadId);
		if (pending?.requestId !== requestId) return;
		const next = result.title?.trim();
		const renamed = result.failure === undefined && next !== undefined && next !== "" && next !== "New thread" && next !== result.previousTitle?.trim();
		if (pending.reason === "regenerate") {
			const status = result.failure !== undefined ? "failed" : renamed ? "renamed" : "unchanged";
			this.#outcomes.set(threadId, { status, ...(result.failure === undefined ? {} : { message: result.failure }), requestId, completedAt: Date.now() });
		}
		this.#requests.delete(threadId);
		if (renamed && this.#bridge.hasThread(threadId)) {
			await this.store(threadId, next, false).catch((error: unknown) => this.#bridge.log.warn("storing a generated title failed", { threadId, error: String(error) }));
		}
		this.#bridge.republish(threadId);
	}

	/** Run the integrator's hook for the current request, detached: the caller (a send, a regenerate) does not wait. */
	generate(threadId: string, requestId: string, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }): void {
		const hook = this.#bridge.config.titleThread;
		const pending = this.#requests.get(threadId);
		if (hook === undefined || pending?.requestId !== requestId) return;
		const signal = pending.controller.signal;
		void (async () => {
			const release = this.#bridge.acquire(threadId);
			let previousTitle: string | undefined;
			try {
				const record = this.#bridge.thread(threadId);
				const project = this.#bridge.config.registry.list().find((candidate) => candidate.id === record?.projectId);
				if (project === undefined) return void (await this.complete(threadId, requestId, { failure: "This thread's project no longer exists." }));
				const state = this.#bridge.view(threadId);
				const conversationId = (await state.head()) as ConversationId;
				// A side chat's history up to where it was opened is the main thread's: T3 titles a side chat from its own messages.
				const after = record?.lineage.sideChat === true ? (record.forkEntryId as EntryId | undefined) : undefined;
				const at = await this.#entry(state, kind, after, signal);
				if (signal.aborted) return void (await this.complete(threadId, requestId));
				if (at === undefined) return void (await this.complete(threadId, requestId, { failure: "This thread has no messages to title yet." }));
				const common = { threadId, conversationId, at, projectTitle: project.name, ...(after === undefined ? {} : { after }), signal };
				const request: TitleThreadRequest =
					kind.reason === "regenerate"
						? { ...common, reason: "regenerate", previousTitle: (previousTitle = record?.title || "New thread") }
						: { ...common, reason: "first-message" };
				const model = this.#bridge.textGenerationModel();
				if (model !== undefined) Object.assign(request, { model });
				// The user's title guidance (T3's `threadTitleInstructions`), capped as T3's `policyInstruction` caps it.
				const guidance = (this.#bridge.config.settings.current().threadTitleInstructions as string | undefined)?.trim();
				if (guidance) Object.assign(request, { guidance: guidance.slice(0, 20_000) });
				const title = await hook(request);
				await this.complete(threadId, requestId, { title, ...(previousTitle === undefined ? {} : { previousTitle }) });
			} catch (error) {
				// T3: a failure logs a warning and completes without a title, saying why (the hook's error stands for T3's
				// text generation error).
				if (signal.aborted) return void (await this.complete(threadId, requestId));
				this.#bridge.log.warn("Thread title generation failed", { threadId, requestId, error: (error as Error).message || String(error) });
				await this.complete(threadId, requestId, { failure: failureMessage(error) });
			} finally {
				release();
			}
		})();
	}

	/** The entry a request names: the first message's committed entry (waited for, not its reply), or the head's latest
	 * (none when the thread has nothing of its own after `after`). */
	async #entry(state: ThreadView, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }, after: EntryId | undefined, signal: AbortSignal): Promise<EntryId | undefined> {
		if (kind.reason === "regenerate") {
			const latest = state.view?.entries.at(-1)?.id as EntryId | undefined;
			return latest === undefined || (after !== undefined && latest <= after) ? undefined : latest;
		}
		const find = (): EntryId | undefined =>
			state.view?.entries.find(
				(candidate) => USER_ENTRY_KINDS.has(candidate.kind) && (candidate.data as { messageId?: unknown } | undefined)?.messageId === kind.messageId,
			)?.id as EntryId | undefined;
		return state.waitFor(find, 60_000, () => new Error("timed out"), signal).catch(() => undefined);
	}

	/** Abort every pending request. */
	close(): void {
		for (const pending of this.#requests.values()) pending.controller.abort();
		this.#requests.clear();
		this.#outcomes.clear();
	}
}
