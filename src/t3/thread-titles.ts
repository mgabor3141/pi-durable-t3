// Thread titles (T3's Orchestrator `titleRegeneration` and ThreadTitleRegenerationService): one current title request
// a thread, in memory only (state.md), answered by the integrator's `titleThread` hook.
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { BridgeCore } from "./bridge-core.ts";
import type { TitleThreadRequest } from "./config.ts";
import { USER_ENTRY_KINDS } from "./runs.ts";
import type { ThreadView } from "./thread-view.ts";

type Core = Pick<BridgeCore, "config" | "log" | "store" | "thread" | "acquire" | "view" | "republish" | "hasThread" | "textGenerationModel">;

export class ThreadTitles {
	readonly #bridge: Core;
	readonly #requests = new Map<string, { requestId: string; startedAt: number; controller: AbortController }>();

	constructor(bridge: Core) {
		this.#bridge = bridge;
	}

	/** T3's `titleRegeneration` of the thread's row: the request that is pending, or `null`. */
	pending(threadId: string): { requestId: string; startedAt: number } | null {
		const pending = this.#requests.get(threadId);
		return pending === undefined ? null : { requestId: pending.requestId, startedAt: pending.startedAt };
	}

	/** Store a title and show it. */
	async store(threadId: string, title: string): Promise<void> {
		await this.#bridge.store.rename(threadId, title);
		this.#bridge.republish(threadId);
	}

	/** Start a request (`titleRegeneration: { requestId, startedAt }`), superseding any pending one. */
	begin(threadId: string, requestId: string): void {
		if (this.#bridge.config.titleThread === undefined) return;
		this.cancel(threadId);
		this.#requests.set(threadId, { requestId, startedAt: Date.now(), controller: new AbortController() });
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
	 * regenerate, the unchanged title) changes nothing (ThreadTitleRegenerationService).
	 */
	async complete(threadId: string, requestId: string, title: string | undefined, previousTitle?: string): Promise<void> {
		const pending = this.#requests.get(threadId);
		if (pending?.requestId !== requestId) return;
		this.#requests.delete(threadId);
		const next = title?.trim();
		if (next !== undefined && next !== "" && next !== "New thread" && next !== previousTitle?.trim() && this.#bridge.hasThread(threadId)) {
			await this.store(threadId, next).catch((error: unknown) => this.#bridge.log.warn("storing a generated title failed", { threadId, error: String(error) }));
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
				const state = this.#bridge.view(threadId);
				const conversationId = (await state.head()) as ConversationId;
				const at = await this.#entry(state, kind, signal);
				if (at === undefined || signal.aborted) return void (await this.complete(threadId, requestId, undefined));
				const request: TitleThreadRequest =
					kind.reason === "regenerate"
						? { threadId, conversationId, at, reason: "regenerate", previousTitle: (previousTitle = this.#bridge.thread(threadId)?.title || "New thread"), signal }
						: { threadId, conversationId, at, reason: "first-message", signal };
				const model = this.#bridge.textGenerationModel();
				if (model !== undefined) Object.assign(request, { model });
				// The user's title guidance (T3's `threadTitleInstructions`), capped as T3's `policyInstruction` caps it.
				const guidance = (this.#bridge.config.settings.current().threadTitleInstructions as string | undefined)?.trim();
				if (guidance) Object.assign(request, { guidance: guidance.slice(0, 20_000) });
				const title = await hook(request);
				await this.complete(threadId, requestId, title, previousTitle);
			} catch (error) {
				// T3: a failure logs a warning and completes without a title.
				if (!signal.aborted) this.#bridge.log.warn("Thread title generation failed", { threadId, requestId, error: (error as Error).message || String(error) });
				await this.complete(threadId, requestId, undefined);
			} finally {
				release();
			}
		})();
	}

	/** The entry a request names: the first message's committed entry (waited for, not its reply), or the head's latest. */
	async #entry(state: ThreadView, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }, signal: AbortSignal): Promise<EntryId | undefined> {
		if (kind.reason === "regenerate") return state.view?.entries.at(-1)?.id as EntryId | undefined;
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
	}
}
