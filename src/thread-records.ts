// The documents the threads layer keeps in the Harness, and the shapes in them: one record per thread (a named
// pointer to its head conversation, shaped after T3's `OrchestrationV2AppThread`), one sidebar summary per thread,
// the directory of thread ids and heads, the command receipts, and the queue held aside. `threads.ts` is their
// only writer.
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";

/** Who created a thread or a message (T3's `OrchestrationV2Actor`). */
type Actor = "user" | "agent" | "system";
/** Where it came from (T3's `OrchestrationV2CreationSource`). */
type CreationSource = "web" | "mobile" | "mcp" | "provider" | "server";
/** T3's creation fields: a thread's, and a user-role message's. */
/** Who wrote something, and for a message one thread sends another, the sending thread (T3's `senderThreadId`). */
export type Provenance = { readonly createdBy: Actor; readonly creationSource: CreationSource; readonly senderThreadId?: string };
/** What a write that names no provenance gets: a person in T3's web app, as T3's own server assumes. */
export const USER_WEB: Provenance = { createdBy: "user", creationSource: "web" };

/** T3's `OrchestrationV2AppThreadLineage`. A side chat (`sideChat`) is a fork kept inside its parent's view, never in
 * thread lists (T3's `isListedThreadLineage`). */
export type ThreadLineage = {
	parentThreadId: string | null;
	relationshipToParent: "fork" | "subagent" | null;
	rootThreadId: string;
	sideChat?: true;
};
/** Context a thread's next message carries to the model (T3's pending context transfer), built when that message is
 * sent: a side chat's note about its main thread, or a fork's conversation brought back (`thread.merge_back`). */
export type PendingContext = { type: "side_chat" } | { type: "merge_back"; sourceThreadId: string; runId: string };
/**
 * A message that asked to be answered (`thread_prompt`'s `notify`): when the activity it started or joined in this thread
 * settles, the activity's report is posted into `threadId`, the sender's thread. Kept on the receiving thread's record
 * until it is delivered; the delivery's command id is `id`, so a retry after a crash is answered from its receipt.
 */
/** A request to be answered with a thread's report: `threadId` is the caller. `wake`: T3's completionWake, `always` (a
 * child started without waiting) or `settled_only` (asked when a wait ran out: not while `runId`, the caller's turn that
 * asked, still runs). `batch`: the message it went into, written before the send, so a restart does not send it twice. */
export type NotifyRequest = { id: string; threadId: string; messageId: string; createdAt: number; wake?: "always" | "settled_only"; runId?: string; batch?: string };
/** How a child thread was started: the parent's run (where its card is), the message, and how its latest run ended
 * (written when it settles, so the card is right while the child's thread is closed). */
export type Spawn = {
	parentRunId: string;
	prompt: string;
	outcome?: { status: "completed" | "failed" | "interrupted" | "cancelled"; result: string | null; completedAt: number };
};

/** A thread's latest run as the sidebar shows it: T3's shell fields `latestRunId`, `status` and the run's times. */
export type SummaryRun = {
	id: string;
	status: string;
	requestedAt: number;
	startedAt: number | null;
	completedAt: number | null;
	/** A failed run's kind of failure and, for a provider's limit, when it resets: T3's sidebar says "limited", not "failed". */
	errorClass?: string;
	resetAt?: string;
};

/** The sidebar's durable snapshot of a thread: its latest visible message and its latest run, so an unopened thread
 * still sorts, previews and shows its state as an open one does, after a restart too. Updated on prompts, on a load,
 * and whenever the latest run changes; not per token. */
export type ThreadSummary = {
	updatedAt: number;
	latestVisibleMessage: { id: string; role: string; text: string; updatedAt: number } | null;
	latestUserMessageAt: number | null;
	/** The latest message a person wrote (not an agent's prompt or a child's report: T3's `latestUserAuthoredMessageAt`).
	 * Absent in a summary written before it was kept: the latest user message stands in. */
	latestUserAuthoredMessageAt?: number | null;
	/** Absent in a summary written before runs were kept: unknown until the thread is next opened or runs. */
	latestRun?: SummaryRun | null;
	itemCount: number;
	visibleItemCount: number;
};
export type StoredSummary = ThreadSummary & { revision: number };
/** A thread with no summary yet (revision 0: never written). */
export const NO_SUMMARY: StoredSummary = { updatedAt: 0, latestVisibleMessage: null, latestUserMessageAt: null, latestRun: null, itemCount: 0, visibleItemCount: 0, revision: 0 };

/** An applied undo, so a retried `requestId` returns the same fork instead of forking again. */
/** An undo this thread applied: the head it moved to and the head it left. The runs the left head has and the new one
 * does not are the undo's rolled-back runs (`undoneHeads`): nothing about them is stored but this pair. */
export type AppliedUndo = {
	requestId: string;
	head: number;
	from: number;
	/** The newest entry `head` had when the undo made it (`null`: it started empty). While it is still the newest,
	 * nothing was written since, and the undo can be taken back (`Threads.redo`). */
	at?: number | null;
	/** Taken back by a redo: the thread is on `from` again. */
	redone?: true;
};
/**
 * T3's limit recovery: a provider's limit ended the run `runId` and resets at `resetAt`. With `autoResume` the host
 * continues the run then (`Threads.resumeAfterLimit`), provided the thread is still where the limit left it: on `head`,
 * with `at` its newest entry. Messages sent meanwhile wait in the queue.
 */
export type LimitRecovery = { runId: string; head: number; at: number | null; resetAt: number; autoResume: boolean; snooze?: boolean };
/** Undos kept per thread: a retry arrives within seconds, not after fifty more undos. */
export const MAX_UNDOS = 50;

/** A command the host accepted, and the sequence it was answered with: a retried `commandId` gets the same answer
 * (T3's command receipts). */
type Receipt = { commandId: string; sequence: number };
/** Receipts kept: a retry arrives within seconds or minutes, not after a thousand more commands. */
export const MAX_RECEIPTS = 1000;

/**
 * One thread, durably: T3's `OrchestrationV2AppThread` fields this host can honour, plus the head conversation the
 * thread points at. A deleted thread keeps its record with `deletedAt` set, as T3 keeps its row: the record is the
 * removal's tombstone, so a late prompt to its head never brings it back.
 */
export type ThreadRecord = {
	threadId: string;
	projectId: string;
	head: number;
	title: string;
	createdAt: number;
	createdBy: Actor;
	creationSource: CreationSource;
	lineage: ThreadLineage;
	forkedFrom: { type: "run"; threadId: string; runId: string } | { type: "node"; nodeId: string } | null;
	/** A child thread (`lineage.relationshipToParent: "subagent"`): how its parent started it, for the parent's card. */
	spawn?: Spawn;
	/** Messages to this thread that asked to be answered, not yet answered. */
	notify?: NotifyRequest[];
	/** What the next message carries to the model, until it is sent. */
	pendingContext?: PendingContext;
	/** A side chat's fork entry: its rows are the entries after it (T3: a side chat shows only its own rows). */
	forkEntryId?: number;
	/** T3's manual settlement: `settled` hides the thread in the sidebar until it is un-settled. */
	settledOverride?: "settled" | "active";
	settledAt?: number;
	unsettledAt?: number;
	deletedAt: number | null;
	undos: AppliedUndo[];
	/** A provider's limit ended this thread's last run and said when it resets (`LimitRecovery`). */
	limitRecovery?: LimitRecovery;
	/** The last rollback asked of this thread, and why it failed (`null`: it did not), as T3 keeps it on the thread. */
	rollback?: { requestId: string; failure: string | null };
	/** T3's sidebar state, kept on the thread as T3 keeps it on its row (`OrchestrationV2AppThread`): a pin and its place
	 * among the pins, the thread's dragged place in the active section, the read watermark (`thread.visit`), how often it
	 * was opened (for the command palette's ranking), and when automatic settlement was turned off for it. */
	pinnedAt?: number;
	pinOrderKey?: string;
	activeOrderKey?: string;
	lastVisitedAt?: number;
	opens?: ThreadOpens;
	autoSettleDisabledAt?: number;
	/** T3's thread tags, in the order they were added (exact spelling and case). */
	tags?: string[];
	/** T3's archive: hidden from the sidebar, listed in the archive. */
	archivedAt?: number;
	/** T3's snooze: hidden until `snoozedUntil` (set at `snoozedAt`); `lastSnoozeWakeAt` is when one last ended early. */
	snoozedUntil?: number;
	snoozedAt?: number;
	lastSnoozeWakeAt?: number;
	/** Bumped on every write, so an older in-memory copy never replaces a newer one. */
	revision: number;
};

/** T3's `OrchestrationV2ThreadOpens`: an open count halving every two weeks as of `openedAt`, and the palette queries
 * that picked the thread, newest first. Times in epoch milliseconds. */
export type ThreadOpens = { openedAt: number; score: number; picks: { query: string; at: number }[] };

/** One live thread as the bridge reads it: its record and, once it has one, its sidebar summary. */
export type Thread = ThreadRecord & { summary?: ThreadSummary };

/** Whose a conversation is, for an integrator that treats threads differently by where they came from. */
export type ThreadOrigin = {
	readonly threadId: string;
	/** Who started the thread: a person (`user`), an agent's `thread_prompt` (`agent`), or the host, as a scheduled task does (`system`). */
	readonly createdBy: Actor;
	readonly creationSource: CreationSource;
	readonly parentThreadId: string | null;
	readonly relationshipToParent: "fork" | "subagent" | null;
	readonly sideChat: boolean;
};

/** Every thread's record, keyed by thread id. Checkpointed on every write: one stored row per thread. */
export const ThreadRecordDoc = defineDocFamily<ThreadRecord, ThreadRecord>({
	kind: "pi-durable-t3.thread",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** Every thread's sidebar summary, keyed by thread id: the hot write (each prompt and each run boundary) touches only it. */
export const ThreadSummaryDoc = defineDocFamily<StoredSummary, StoredSummary>({
	kind: "pi-durable-t3.thread-summary",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** The live thread ids in creation order, and every head ever (deleted threads' too) by conversation id. */
export type Directory = { threads: string[]; heads: Record<string, string>; revision: number };

/** The last commands the host accepted, newest last: one store for every command, as T3 keeps one. */
export const ReceiptsDoc = defineDoc<{ receipts: Receipt[] }>({
	kind: "pi-durable-t3.command-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ receipts: [] }),
	checkpointWhen: () => true,
});

/**
 * Queued inputs taken out of a conversation's inbox for the length of one operation (`#aroundQueue`), by conversation
 * id: written in the commit that takes them out and cleared in the one that puts them back, so a host that dies in
 * between finds them here when it starts again (`load`).
 */
export const HeldQueueDoc = defineDoc<{ held: Record<string, JsonValue[]> }>({
	kind: "pi-durable-t3.held-queue",
	version: 1,
	scope: "session",
	initial: () => ({ held: {} }),
	checkpointWhen: () => true,
});

/** The directory: written only when a thread is created, deleted or moves its head. Version 2: a store written with the
 * single threads document of version 1 is refused (no migration: such a store is migrated by hand). */
export const ThreadsDoc = defineDoc<Directory>({
	kind: "pi-durable-t3.threads",
	version: 2,
	scope: "session",
	initial: () => ({ threads: [], heads: {}, revision: 0 }),
	checkpointWhen: () => true,
});
