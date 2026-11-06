// One open thread: the watch on its head conversation, the projection of each view, and the stream its subscribers
// read. It lives while it is held (a command, a read, a subscriber) and for a short idle time after; released, it keeps
// nothing but the small documents the shell reads. Everything it shows is derived from stored state: the head's view,
// the history above a compaction, and the runs the head's undos rolled back.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Cursor, EntryId, Harness, WatchHandle } from "@earendil-works/pi-durable";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { AppliedUndo } from "../threads.ts";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import type { ConversationView, EntryRecord, ModelRef } from "./model-types.ts";
import { type ProjectionResult, projectThread, type ThreadMeta } from "./projection.ts";
import { decideThreadResume, THREAD_RESUME_MAX_REPLAY_EVENTS } from "./t3-server.ts";
import { diffProjection, eventItem, type ThreadStreamItem } from "./thread-stream.ts";
import { type RolledBackRun, rolledBackRuns, undoneHeads } from "./undo.ts";

/** What a thread subscriber is sent: a whole projection (formatted per subscriber), or events. */
export type StreamUpdate =
	| { readonly kind: "snapshot"; readonly sequence: number; readonly projection: OrchestrationV2ThreadProjection }
	| { readonly kind: "events"; readonly items: readonly ThreadStreamItem[] };

/** The stream as subscribers were last brought to it. */
export type StreamState = { readonly sequence: number; readonly projection: OrchestrationV2ThreadProjection };

/** A model the host offers, with what it accepts. */
export type CatalogEntry = { provider: string; modelId: string; input: string[]; contextWindow: number };

/** The head conversation's model and thinking level. */
export type Configuration = { model: ModelRef | null; thinkingLevel: string };

/** What a thread view needs from the host. */
export interface ThreadViewHost {
	readonly harness: Harness;
	readonly log: Logger;
	/** The conversation the thread shows now (its head; a subagent's child conversation), if it has one. */
	head(threadId: string): number | undefined;
	/** The thread's applied undos, from its record. */
	undos(threadId: string): readonly AppliedUndo[];
	/** A subagent's thread reads its conversation and nothing else: no model controls. */
	isSubagent(threadId: string): boolean;
	catalog(): CatalogEntry[];
	/** The thread's metadata, from its record and (when given) this view. */
	meta(threadId: string, view: ThreadView | undefined): ThreadMeta;
	nextSequence(): number;
	/** After every projection: `loaded` for the first one of an open, `settled` when a run just ended. */
	projected(view: ThreadView, change: { readonly loaded: boolean; readonly settled: boolean }): void;
}

interface StreamSubscriber {
	readonly update: (update: StreamUpdate) => void;
	/** Set until the subscriber got its first update: the sequence it resumes after, or `null` for a snapshot. */
	pending: { readonly afterSequence: number | null } | undefined;
}

/** The watch on the head while the thread is open. A head switch (undo, fork promotion) restarts it on the new head. */
interface Follower {
	head: number | undefined;
	watch: WatchHandle<ConversationView> | undefined;
	/** Bumped on every head switch, so a callback of a superseded watch changes nothing. */
	generation: number;
	/** Bumped on every view, so a slow history load cannot overwrite a newer view. */
	viewSeq: number;
	/** The compaction cut the cached history was loaded for (`-1`: none). */
	historyCutoff: number;
	history: EntryRecord[];
	/** The head's `pi.agent` document as last read; its configuration is re-read only when it changes. */
	agentKey: string | undefined;
	closed: boolean;
}

/** T3's coalescing window for live updates (`ThreadLiveEventCoalescer`): changes within it go out as one batch. */
const FLUSH_MS = 50;
/** The replay T3 allows before it sends a snapshot instead (`ThreadStream.ts`). */
const MAX_LOG_EVENTS = THREAD_RESUME_MAX_REPLAY_EVENTS;
/** How long a thread nobody holds stays open. */
const IDLE_MS = 30_000;

/** The view of a head conversation that does not exist: no entries, no docs. */
const EMPTY_VIEW = { conversation: {}, entries: [], docs: {} } as unknown as ConversationView;

/** The entry before the active context's first kept entry, when the view starts at a compaction; else `-1`. */
function compactionCutoff(view: ConversationView): number {
	const head = view.entries[0];
	if (head?.kind !== "pi.compaction") return -1;
	const firstKept = view.entries[1];
	return (firstKept?.id ?? head.id) - 1;
}

/** The entries above a compaction cut, for display only: compaction keeps them durably but drops them from the view. */
async function loadHistory(conversation: Conversation, cutoff: number): Promise<EntryRecord[]> {
	if (cutoff <= 0) return [];
	const items: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending", maxEntryId: cutoff as EntryId }, 500, cursor, BACKGROUND_CONTEXT);
		items.push(...(page.items as unknown as EntryRecord[]));
		cursor = page.next;
	} while (cursor !== undefined);
	// Compaction markers are rendered as cards by the projection; an older summary here would be a stray bubble.
	return items.filter((entry) => entry.kind !== "pi.compaction" && entry.id <= cutoff);
}

export class ThreadView {
	readonly threadId: string;
	readonly #host: ThreadViewHost;
	#holds = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#follower: Follower | undefined;
	/** Replaced and settled on every load-state change (a view, a release, a removal): what waiters wait on. */
	#changed = Promise.withResolvers<void>();
	#gone: Error | undefined;
	/** The head's real view has been projected once since the thread was opened. */
	#loaded = false;
	#result: ProjectionResult | undefined;
	#view: ConversationView | undefined;
	/** Display-only transcript above the active context's compaction cut. */
	#history: EntryRecord[] | undefined;
	#rolledBack: RolledBackRun[] = [];
	#conversationId: number | undefined;
	#configuration: Configuration | undefined;
	#catalog: CatalogEntry[] = [];
	#stream: StreamState | undefined;
	/** The events since `#logFloor`, oldest first: what a resuming subscriber is replayed. */
	#log: ThreadStreamItem[] = [];
	#logFloor = 0;
	#flushTimer: NodeJS.Timeout | undefined;
	readonly #subscribers = new Set<StreamSubscriber>();
	/** Called when the thread is gone (deleted, or unknown to the host); subscriptions end. */
	readonly #enders = new Set<() => void>();

	constructor(threadId: string, host: ThreadViewHost) {
		this.threadId = threadId;
		this.#host = host;
	}

	/** The last projection; `undefined` until the head's view is first projected after an open. */
	get result(): ProjectionResult | undefined {
		return this.#result;
	}
	get loaded(): boolean {
		return this.#loaded;
	}
	get view(): ConversationView | undefined {
		return this.#view;
	}
	get rolledBack(): readonly RolledBackRun[] {
		return this.#rolledBack;
	}
	/** The head conversation (the write target) once its view has loaded. */
	get conversationId(): number | undefined {
		return this.#conversationId;
	}
	get configuration(): Configuration | undefined {
		return this.#configuration;
	}
	/** The catalog entries, each with its input modalities, so the send path knows which models accept images. */
	get catalog(): readonly CatalogEntry[] {
		return this.#catalog;
	}
	/** The stream's state as subscribers were last brought to it, without a flush (a slow subscriber's catch-up). */
	get stream(): StreamState | undefined {
		return this.#stream;
	}

	// ---- lifetime ---------------------------------------------------------------------------------------------

	/** Keep the thread open until the returned release; the last release starts the idle timer. */
	hold(): () => void {
		this.#holds++;
		this.#open();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#holds--;
			if (this.#holds > 0) return;
			this.#idleTimer = setTimeout(() => {
				if (this.#holds === 0) this.release();
			}, IDLE_MS);
			this.#idleTimer.unref();
		};
	}

	/** The head moved (an undo, a promotion): an open thread follows it. */
	moved(head: number): void {
		if (this.#follower !== undefined && this.#follower.head !== head) void this.#follow(head);
	}

	/** Stop following (idle release, shutdown); the result and transcript are dropped and re-read on the next open.
	 * Keeping `view.entries` and the history here would retain every opened transcript for the life of the process. */
	release(): void {
		const follower = this.#follower;
		this.#follower = undefined;
		if (follower !== undefined) {
			follower.closed = true;
			void follower.watch?.stop().catch(() => {});
		}
		this.#result = undefined;
		this.#history = undefined;
		this.#stream = undefined;
		this.#log = [];
		if (this.#flushTimer !== undefined) clearTimeout(this.#flushTimer);
		this.#flushTimer = undefined;
		// Keep the small `docs` for shell metadata; release the entry arrays that dominate memory.
		if (this.#view !== undefined) this.#view = { ...this.#view, entries: [] };
		this.#loaded = false;
		// The head may move while released: a write after the next open waits for the head it then loads.
		this.#conversationId = undefined;
		this.#signal();
	}

	/** The thread no longer exists: release it and end its subscriptions. */
	forget(error: Error): void {
		this.#gone = error;
		if (this.#idleTimer !== undefined) clearTimeout(this.#idleTimer);
		this.release();
		for (const end of this.#enders) end();
		this.#subscribers.clear();
		this.#enders.clear();
		this.#host.log.info("thread forgotten", { threadId: this.threadId, reason: error.message });
	}

	#open(): void {
		if (this.#idleTimer !== undefined) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = undefined;
		}
		if (this.#follower !== undefined) return;
		this.#follower = { head: undefined, watch: undefined, generation: 0, viewSeq: 0, historyCutoff: -1, history: [], agentKey: undefined, closed: false };
		this.#catalog = this.#host.isSubagent(this.threadId) ? [] : this.#host.catalog();
		const head = this.#host.head(this.threadId);
		if (head !== undefined) void this.#follow(head);
	}

	// ---- waiting ----------------------------------------------------------------------------------------------

	/** Settle the waiters of the load state and arm a fresh signal. */
	#signal(): void {
		const previous = this.#changed;
		this.#changed = Promise.withResolvers<void>();
		previous.resolve();
	}

	/** Wait until `read` answers, the thread is gone, `signal` aborts, or the time is up. Every new view and every
	 * load-state change wakes it; nothing polls. */
	async waitFor<T>(read: () => T | undefined, timeoutMs: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (this.#gone !== undefined) throw new CommandError(`Unknown thread: ${this.threadId}`);
			if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
			const value = read();
			if (value !== undefined) return value;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw onTimeout();
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			await Promise.race([
				this.#changed.promise,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, remaining);
					onAbort = resolve;
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
			clearTimeout(timer);
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		}
	}

	/** The projection, once the head's view has loaded. */
	projection(timeoutMs: number): Promise<ProjectionResult> {
		return this.waitFor(() => (this.#loaded ? this.#result : undefined), timeoutMs, () => new CommandError(`Timed out loading thread ${this.threadId}`));
	}

	/**
	 * The head conversation's id, once its view has loaded: a freshly created or just reopened thread follows its head a
	 * few awaits after `hold`, so every write path awaits the real head first — no cold message loss, and no reliance on
	 * an earlier call having warmed the transcript (design.md).
	 */
	head(timeoutMs = 15_000): Promise<number> {
		return this.waitFor(() => this.#conversationId, timeoutMs, () => new CommandError(`The thread ${this.threadId} is still loading; send again in a moment.`));
	}

	// ---- following the head -----------------------------------------------------------------------------------

	/** Point the open thread at `head`: watch that conversation, and project each of its views. */
	async #follow(head: number): Promise<void> {
		const follower = this.#follower;
		if (follower === undefined || follower.closed || follower.head === head) return;
		follower.head = head;
		const generation = ++follower.generation;
		const previous = follower.watch;
		follower.watch = undefined;
		follower.historyCutoff = -1;
		follower.history = [];
		follower.agentKey = undefined;
		await previous?.stop().catch(() => {});
		const current = (): boolean => this.#follower === follower && !follower.closed && follower.generation === generation;
		try {
			const conversation = await this.#host.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
			if (!current()) return;
			const rolledBack = await this.#readRolledBack(head);
			if (!current()) return;
			this.#rolledBack = rolledBack;
			if (conversation === undefined) {
				await this.#setView(head, EMPTY_VIEW, undefined, current);
				return;
			}
			const watch = (await conversation.watch(BACKGROUND_CONTEXT)) as unknown as WatchHandle<ConversationView>;
			if (!current()) {
				await watch.stop().catch(() => {});
				return;
			}
			follower.watch = watch;
			watch.start(async (view) => {
				if (current()) await this.#setView(head, view, conversation, current);
			});
			await this.#setView(head, watch.value, conversation, current);
		} catch (error) {
			this.#host.log.warn("could not follow a thread's head", { threadId: this.threadId, head, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * The runs `head`'s undos rolled back: every run of the heads they left (`undoneHeads`) as it was there, marked rolled
	 * back. The projection drops the ones `head` still has, so the undo record is all that is stored (design.md, Invariants).
	 */
	async #readRolledBack(head: number): Promise<RolledBackRun[]> {
		const chain = undoneHeads(this.#host.undos(this.threadId), head);
		const runs = new Map<string, RolledBackRun>();
		for (const from of chain.reverse()) {
			const conversation = await this.#host.harness.conversation(from as ConversationId, BACKGROUND_CONTEXT).catch(() => undefined);
			if (conversation === undefined) continue;
			const { entries } = await conversation.context(BACKGROUND_CONTEXT);
			const view = { conversation: {}, entries, docs: {} } as unknown as ConversationView;
			const { projection } = projectThread(this.#host.meta(this.threadId, undefined), view, { rolledBack: [] });
			for (const run of rolledBackRuns(projection)) if (!runs.has(run.run.id)) runs.set(run.run.id, run);
		}
		return [...runs.values()];
	}

	/** One view of the head: the history above its compaction cut (loaded once per cut), its configuration (re-read only
	 * when its `pi.agent` document changes), then the projection. A newer view started meanwhile wins. */
	async #setView(head: number, view: ConversationView, conversation: Conversation | undefined, current: () => boolean): Promise<void> {
		const follower = this.#follower!;
		const seq = ++follower.viewSeq;
		const latest = (): boolean => current() && follower.viewSeq === seq;
		const cutoff = compactionCutoff(view);
		if (cutoff !== follower.historyCutoff) {
			const history = conversation === undefined ? [] : await loadHistory(conversation, cutoff).catch(() => []);
			if (!latest()) return;
			follower.history = history;
			follower.historyCutoff = cutoff;
		}
		const agentKey = JSON.stringify(view.docs["pi.agent"] ?? null);
		if (!this.#host.isSubagent(this.threadId) && agentKey !== follower.agentKey) {
			const agent = conversation === undefined ? undefined : await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined);
			if (!latest()) return;
			follower.agentKey = agentKey;
			this.#configuration = {
				model: agent?.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
				thinkingLevel: agent?.thinkingLevel ?? "off",
			};
		}
		this.#view = view;
		this.#history = follower.history;
		this.#conversationId = head;
		this.recompute();
		this.#signal();
	}

	/** The head's configuration was just written: show it now, and re-read it on the next view. */
	configured(configuration: Configuration): void {
		this.#configuration = configuration;
		if (this.#follower !== undefined) this.#follower.agentKey = undefined;
		this.recompute();
	}

	// ---- projection and stream --------------------------------------------------------------------------------

	/** Project the current view (the thread's metadata may have changed too), and schedule a flush for subscribers. */
	recompute(): void {
		if (this.#view === undefined) return;
		const wasRunning = this.#result?.shell.status === "running";
		// Only a projection of the head's real view counts as loaded.
		const loaded = this.#conversationId !== undefined && !this.#loaded;
		if (loaded) this.#loaded = true;
		this.#result = projectThread(this.#host.meta(this.threadId, this), this.#view, { rolledBack: this.#rolledBack, history: this.#history });
		this.#host.projected(this, { loaded, settled: wasRunning && this.#result.shell.status !== "running" });
		if (this.#subscribers.size === 0 || this.#flushTimer !== undefined) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = undefined;
			this.flush();
		}, FLUSH_MS);
	}

	/** The history above the compaction cut, and the view's entries: the whole transcript this view shows. */
	get transcript(): readonly EntryRecord[] {
		return [...(this.#history ?? []), ...(this.#view?.entries ?? [])];
	}

	/**
	 * Bring the stream to the current projection: the records that changed since the last flush go out as events (a
	 * change no event can express, as a snapshot), the events are kept for a resume, and a subscriber still waiting for
	 * its first update gets it. Answers the stream's state.
	 */
	flush(): StreamState | undefined {
		if (this.#flushTimer !== undefined) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = undefined;
		}
		const next = this.#loaded ? this.#result?.projection : undefined;
		if (next === undefined) return this.#stream;
		const live = [...this.#subscribers].filter((subscriber) => subscriber.pending === undefined);
		if (this.#stream === undefined) {
			this.#restartStream(next);
		} else if (this.#stream.projection !== next) {
			const diff = diffProjection(this.#stream.projection, next);
			if ("snapshot" in diff) {
				this.#host.log.info("thread stream sent a snapshot", { threadId: this.threadId, reason: diff.snapshot });
				const stream = this.#restartStream(next);
				for (const subscriber of live) subscriber.update({ kind: "snapshot", ...stream });
			} else if (diff.events.length === 0) {
				this.#stream = { sequence: this.#stream.sequence, projection: next };
			} else {
				const items = diff.events.map((event) => eventItem(this.#host.nextSequence(), event));
				this.#log.push(...items);
				if (this.#log.length > MAX_LOG_EVENTS) {
					const dropped = this.#log.splice(0, this.#log.length - MAX_LOG_EVENTS);
					this.#logFloor = (dropped.at(-1) as { sequence: number }).sequence;
				}
				this.#stream = { sequence: (items.at(-1) as { sequence: number }).sequence, projection: next };
				for (const subscriber of live) subscriber.update({ kind: "events", items });
			}
		}
		for (const subscriber of this.#subscribers) if (subscriber.pending !== undefined) this.#serve(subscriber);
		return this.#stream;
	}

	/** Start the stream over at `projection`: a new sequence, an empty log. */
	#restartStream(projection: OrchestrationV2ThreadProjection): StreamState {
		const sequence = this.#host.nextSequence();
		this.#stream = { sequence, projection };
		this.#log = [];
		this.#logFloor = sequence;
		return this.#stream;
	}

	/** A subscriber's first update: the events after the sequence it resumes from, when the log still holds them and
	 * T3's replay bounds allow it; otherwise the current projection. */
	#serve(subscriber: StreamSubscriber): void {
		const stream = this.#stream;
		if (stream === undefined) return;
		const after = subscriber.pending?.afterSequence ?? null;
		subscriber.pending = undefined;
		if (after !== null && after >= this.#logFloor && after <= stream.sequence) {
			const replay = this.#log.filter((item) => (item as { sequence: number }).sequence > after);
			const plan = decideThreadResume({ afterSequence: after, highWater: stream.sequence, replayEventCount: replay.length, replayEncodedBytes: JSON.stringify(replay).length });
			if (plan.mode === "replay") {
				subscriber.update({ kind: "events", items: replay });
				return;
			}
		}
		subscriber.update({ kind: "snapshot", sequence: stream.sequence, projection: stream.projection });
	}

	/**
	 * Subscribe to the stream: first the events after `afterSequence` when they can be replayed, else the current
	 * projection; then every flush's events (or a snapshot, when no event can express a change). The first update
	 * arrives once the transcript loads. The thread stays open while subscribed.
	 */
	subscribe(afterSequence: number | undefined, update: (update: StreamUpdate) => void, onEnd: () => void): () => void {
		const release = this.hold();
		const subscriber: StreamSubscriber = { update, pending: { afterSequence: afterSequence ?? null } };
		this.#subscribers.add(subscriber);
		this.#enders.add(onEnd);
		if (this.#loaded) this.flush();
		return () => {
			this.#subscribers.delete(subscriber);
			this.#enders.delete(onEnd);
			release();
		};
	}
}
