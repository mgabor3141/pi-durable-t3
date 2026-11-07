// The threads layer: the documents this host adds to the Harness — one record per thread (a named pointer to its head
// conversation, shaped after T3's `OrchestrationV2AppThread`), one sidebar summary per thread, and a directory of thread
// ids and heads. Every rule it enforces is an invariant in docs/design.md; this file is the code, not the case.
//
// This layer is the only writer of those documents, so it keeps them in memory: reads are synchronous, and every
// committed change is announced to `onChange` listeners before the write returns.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	type AgentChange,
	AgentDoc,
	configure,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	defineDoc,
	defineDocFamily,
	type EntryId,
	InboxDoc,
	LiveDoc,
	type Submission,
	type SubmissionId,
	type TaskId,
	type Tx,
	UserEntry,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { hostError } from "./host-errors.ts";
import type { Project } from "./config.ts";
import { readQueuedInputs, withQueuedText } from "./t3/queued.ts";
import type { ContentBlock } from "./t3/model-types.ts";
import { APP_COMPACT_ENTRY, APP_NOTE_ENTRY } from "./t3/runs.ts";
import type { Message } from "@earendil-works/pi-ai";
import { searchThreads, searchCandidate, type SearchCandidate, type ThreadSearchMatch } from "./t3/thread-search.ts";

import { type ProjectRegistry, projectsInCommit } from "./registry.ts";

/** The entry kind a client prompt is placed as, carrying the client's message id in its `data` (state.md: no side
 * store). It must not start with `pi.` — pi-durable's namespace for an input's own entry kinds. */
export const APP_USER_ENTRY = "app.user";

/** Entry kinds that name a user turn, for the rewind's `not_rewindable` check; the facet owns a copy of this literal. */
const USER_ENTRY_KINDS: ReadonlySet<string> = new Set([UserEntry.kind, APP_USER_ENTRY]);

/** Who created a thread or a message (T3's `OrchestrationV2Actor`). */
export type Actor = "user" | "agent" | "system";
/** Where it came from (T3's `OrchestrationV2CreationSource`). */
export type CreationSource = "web" | "mobile" | "mcp" | "provider" | "server";
/** T3's creation fields: a thread's, and a user-role message's. */
/** Who wrote something, and for a message one thread sends another, the sending thread (T3's `senderThreadId`). */
export type Provenance = { readonly createdBy: Actor; readonly creationSource: CreationSource; readonly senderThreadId?: string };
/** What a write that names no provenance gets: a person in T3's web app, as T3's own server assumes. */
export const USER_WEB: Provenance = { createdBy: "user", creationSource: "web" };

/** T3's `OrchestrationV2AppThreadLineage`. */
export type ThreadLineage = {
	parentThreadId: string | null;
	relationshipToParent: "fork" | "subagent" | null;
	rootThreadId: string;
};
/** T3's `OrchestrationV2LinkOrigin`: the linked environment's session whose agent started this work here. Set once. */
export type LinkOrigin = { sessionId: string; label: string; access?: string };
/** T3's `OrchestrationV2DelegatedFrom`: the thread in a linked environment that delegated this one. */
export type DelegatedFrom = { environmentId: string; threadId: string; title: string };
/**
 * A message that asked to be answered (`thread_prompt`'s `notify`): when the activity it started or joined in this thread
 * settles, the activity's report is posted into `threadId`, the sender's thread. Kept on the receiving thread's record
 * until it is delivered; the delivery's command id is `id`, so a retry after a crash is answered from its receipt.
 */
export type NotifyRequest = { id: string; threadId: string; messageId: string; createdAt: number };
/** How a child thread was started: the parent's run (where its card is), the message, and how its latest run ended
 * (written when it settles, so the card is right while the child's thread is closed). */
export type Spawn = {
	parentRunId: string;
	prompt: string;
	outcome?: { status: "completed" | "failed" | "interrupted" | "cancelled"; result: string | null; completedAt: number };
};

/** The sidebar's durable snapshot of a thread's latest visible message, so an unopened thread still sorts and previews
 * correctly after a restart. Updated on prompts and at run boundaries, not per token. */
export type ThreadSummary = {
	updatedAt: number;
	latestVisibleMessage: { id: string; role: string; text: string; updatedAt: number } | null;
	latestUserMessageAt: number | null;
	itemCount: number;
	visibleItemCount: number;
};
type StoredSummary = ThreadSummary & { revision: number };
/** A thread with no summary yet (revision 0: never written). */
const NO_SUMMARY: StoredSummary = { updatedAt: 0, latestVisibleMessage: null, latestUserMessageAt: null, itemCount: 0, visibleItemCount: 0, revision: 0 };

/** An applied undo, so a retried `requestId` returns the same fork instead of forking again. */
/** An undo this thread applied: the head it moved to and the head it left. The runs the left head has and the new one
 * does not are the undo's rolled-back runs (`undoneHeads`): nothing about them is stored but this pair. */
export type AppliedUndo = { requestId: string; head: number; from: number };
/** Undos kept per thread: a retry arrives within seconds, not after fifty more undos. */
const MAX_UNDOS = 50;

/** A command the host accepted, and the sequence it was answered with: a retried `commandId` gets the same answer
 * (T3's command receipts). */
type Receipt = { commandId: string; sequence: number };
/** Receipts kept: a retry arrives within seconds or minutes, not after a thousand more commands. */
const MAX_RECEIPTS = 1000;

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
	linkOrigin?: LinkOrigin;
	delegatedFrom?: DelegatedFrom;
	/** T3's manual settlement: `settled` hides the thread in the sidebar until it is un-settled. */
	settledOverride?: "settled" | "active";
	settledAt?: number;
	unsettledAt?: number;
	deletedAt: number | null;
	undos: AppliedUndo[];
	/** The last rollback asked of this thread, and why it failed (`null`: it did not), as T3 keeps it on the thread. */
	rollback?: { requestId: string; failure: string | null };
	/** Bumped on every write, so an older in-memory copy never replaces a newer one. */
	revision: number;
};

/** One live thread as the bridge reads it: its record and, once it has one, its sidebar summary. */
export type Thread = ThreadRecord & { summary?: ThreadSummary };

/** Every thread's record, keyed by thread id. Checkpointed on every write: one stored row per thread. */
const ThreadRecordDoc = defineDocFamily<ThreadRecord, ThreadRecord>({
	kind: "pi-durable-t3.thread",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** Every thread's sidebar summary, keyed by thread id: the hot write (each prompt and each run boundary) touches only it. */
const ThreadSummaryDoc = defineDocFamily<StoredSummary, StoredSummary>({
	kind: "pi-durable-t3.thread-summary",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => seed,
	checkpointWhen: () => true,
});

/** The live thread ids in creation order, and every head ever (deleted threads' too) by conversation id. */
type Directory = { threads: string[]; heads: Record<string, string>; revision: number };

/** The last commands the host accepted, newest last: one store for every command, as T3 keeps one. */
const ReceiptsDoc = defineDoc<{ receipts: Receipt[] }>({
	kind: "pi-durable-t3.command-receipts",
	version: 1,
	scope: "session",
	initial: () => ({ receipts: [] }),
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

type ThreadsDeps = {
	readonly harness: Harness;
	/** The live project registry: the foreign key's target, and the source of a new thread's `cwd`. */
	readonly registry: ProjectRegistry;
	/** The execution environment a thread's folder is checked in. Absent: a local stat (tests and older integrators). */
	readonly env?: ExecutionEnv;
	/** Invocation context for environment calls. */
	readonly context?: Context;
	/** Notified when a prompt's commit lands and its promote fails; the run stays ownerless until a later promote adopts it. */
	readonly onWarn?: (message: string, error: unknown) => void;
};

/** A new thread: the client's id and project, and what the record carries from the start. */
type CreateInput = {
	readonly threadId: string;
	readonly projectId: string;
	readonly cwd?: string;
	readonly title?: string;
	readonly provenance?: Provenance;
	readonly lineage?: ThreadLineage;
	readonly forkedFrom?: ThreadRecord["forkedFrom"];
	readonly spawn?: Spawn;
	readonly linkOrigin?: LinkOrigin;
	readonly delegatedFrom?: DelegatedFrom;
};
type MessageInput = {
	readonly threadId: string;
	readonly conversationId: number;
	readonly requestId: string;
	readonly message: string;
	/** The client's id for this message, placed in the entry's `data` (state.md: no side store). */
	readonly messageId?: string;
	/** Who sent it: placed in the entry's `data`, so the projection reports it (absent: a person in the web app). */
	readonly provenance?: Provenance;
	/** Extra content blocks (an image) appended after the text block, so the model receives the image inline. */
	readonly blocks?: readonly ContentBlock[];
	/** The message's persisted images and files, placed in the entry's `data` (the projection shows them after a restart). */
	readonly attachments?: readonly { type?: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number }[];
	/** T3's structured composer context: the records its text references resolve against. Placed in the entry's `data`. */
	readonly context?: JsonValue;
	/** A note: added to the conversation without starting a turn (`APP_NOTE_ENTRY`); the next turn sees it. */
	readonly note?: boolean;
};
type RewindInput = {
	readonly threadId: string;
	readonly expectedHead: number;
	readonly entryId: number;
	readonly requestId: string;
};

/**
 * Copy a resolved agent's configuration into an `AgentChange` for a fresh conversation: only the fields the head
 * carries are set, so an undo to baseline reproduces the same model, thinking level, tools, prompt text and cwd.
 */
function agentCopy(agent: Awaited<ReturnType<Conversation["agent"]>>): AgentChange {
	return {
		...(agent.model !== undefined ? { model: agent.model } : {}),
		...(agent.thinkingLevel !== undefined ? { thinkingLevel: agent.thinkingLevel } : {}),
		...(agent.tools !== undefined && agent.tools.length > 0 ? { tools: agent.tools } : {}),
		...(agent.extensions !== undefined && agent.extensions.length > 0 ? { extensions: agent.extensions } : {}),
		...(agent.instructions !== undefined ? { instructions: agent.instructions } : {}),
		...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
	};
}

/** A fresh, empty conversation carrying the reverted head's agent config — used for undo to baseline. */
async function configureNewConversation(tx: Tx, agent: Awaited<ReturnType<Conversation["agent"]>>) {
	const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
	await configure(tx, created.id, agentCopy(agent));
	return created;
}

/** Whether a conversation owes a turn right now: a run in progress or an input queued behind a failed one. */
async function owedIn(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	const live = await tx.doc(LiveDoc, conversationId);
	if (live.run !== undefined) return true;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return (inbox.items?.length ?? 0) > 0;
}

/** A plain copy: documents are JSON, and a draft (a proxy) cannot be structured-cloned. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Replace a document draft's content with `value`. */
function overwrite(draft: object, value: object): void {
	const target = draft as Record<string, unknown>;
	for (const key of Object.keys(target)) if (!(key in value)) delete target[key];
	Object.assign(target, copy(value));
}

/**
 * One commit's view of the documents and the writes it makes. Reads go to the commit, not to memory: another threads
 * layer on the same Harness (a test's, a tool's) cannot make a write lose its changes. Each write is staged for memory
 * and for the change event.
 */
class Writes {
	directory: Directory | undefined;
	readonly records = new Map<string, ThreadRecord>();
	readonly summaries = new Map<string, StoredSummary>();
	readonly #tx: Tx;

	constructor(tx: Tx) {
		this.#tx = tx;
	}

	/** The directory as this commit sees it. */
	async readDirectory(): Promise<Directory> {
		if (this.directory === undefined) this.directory = copy((await this.#tx.doc(ThreadsDoc)) as Directory);
		return copy(this.directory);
	}

	/** A record as this commit sees it (deleted ones included), or `undefined`. */
	async record(threadId: string): Promise<ThreadRecord | undefined> {
		const staged = this.records.get(threadId);
		if (staged !== undefined) return copy(staged);
		const directory = await this.readDirectory();
		// A record exists once its thread entered the directory (a deleted thread keeps its head there).
		if (!directory.threads.includes(threadId) && !Object.values(directory.heads).includes(threadId)) return undefined;
		const stored = copy((await this.#tx.doc(ThreadRecordDoc, threadId, {} as never)) as ThreadRecord);
		this.records.set(threadId, stored);
		return copy(stored);
	}

	/** The live record, or the typed not-found. */
	async live(threadId: string): Promise<ThreadRecord> {
		const record = await this.record(threadId);
		if (record === undefined || record.deletedAt !== null) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		return record;
	}

	/** A summary as this commit sees it, or `undefined` when the thread has none yet. */
	async summary(threadId: string): Promise<StoredSummary | undefined> {
		const staged = this.summaries.get(threadId);
		if (staged !== undefined) return copy(staged);
		const stored = copy((await this.#tx.doc(ThreadSummaryDoc, threadId, NO_SUMMARY)) as StoredSummary);
		return stored.revision === 0 ? undefined : stored;
	}

	async putRecord(record: ThreadRecord): Promise<void> {
		record.revision += 1;
		overwrite(await this.#tx.doc(ThreadRecordDoc, record.threadId, record), record);
		this.records.set(record.threadId, copy(record));
		this.written.add(record.threadId);
	}

	async putDirectory(directory: Directory): Promise<void> {
		directory.revision += 1;
		overwrite(await this.#tx.doc(ThreadsDoc), directory);
		this.directory = copy(directory);
		this.directoryWritten = true;
	}

	async putSummary(threadId: string, summary: StoredSummary): Promise<void> {
		summary.revision += 1;
		overwrite(await this.#tx.doc(ThreadSummaryDoc, threadId, summary), summary);
		this.summaries.set(threadId, copy(summary));
		this.summariesWritten.add(threadId);
	}

	/** What this commit wrote (reads are staged too, but only writes reach memory). */
	readonly written = new Set<string>();
	readonly summariesWritten = new Set<string>();
	directoryWritten = false;
}

/** The threads layer over a caller-provided Harness. Its only state is the Harness's documents and their memory copy. */
export class Threads {
	readonly #harness: Harness;
	readonly #registry: ProjectRegistry;
	readonly #env: ExecutionEnv | undefined;
	readonly #context: Context;
	readonly #onWarn: (message: string, error: unknown) => void;
	/** One compaction wait per thread. Repeated clicks join the running summary instead of starting another one. */
	readonly #compacting = new Map<string, Promise<void>>();
	#directory: Directory = { threads: [], heads: {}, revision: 0 };
	readonly #records = new Map<string, ThreadRecord>();
	readonly #summaries = new Map<string, StoredSummary>();
	readonly #receipts = new Map<string, number>();
	readonly #listeners = new Set<(threadIds: ReadonlySet<string>) => void>();
	#loading: Promise<void> | undefined;

	constructor(deps: ThreadsDeps) {
		this.#harness = deps.harness;
		this.#registry = deps.registry;
		this.#env = deps.env;
		this.#context = deps.context ?? BACKGROUND_CONTEXT;
		this.#onWarn = deps.onWarn ?? (() => {});
	}

	/** The integrator's Harness; the bridge reads and watches conversation views through it. */
	get harness(): Harness {
		return this.#harness;
	}

	get projects(): readonly Project[] {
		return this.#registry.list();
	}

	/** Load the documents into memory, once. Every read and write awaits it. */
	load(): Promise<void> {
		this.#loading ??= (async () => {
			const receipts = await this.#harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
			for (const receipt of receipts?.receipts ?? []) this.#receipts.set(receipt.commandId, receipt.sequence);
			const directory = await this.#harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT);
			if (directory === undefined) return;
			this.#directory = copy(directory) as Directory;
			for (const threadId of new Set(Object.values(this.#directory.heads))) {
				const record = await this.#harness.snapshot(ThreadRecordDoc, threadId, BACKGROUND_CONTEXT);
				if (record !== undefined) this.#records.set(threadId, copy(record) as ThreadRecord);
			}
			for (const threadId of this.#directory.threads) {
				const summary = await this.#harness.snapshot(ThreadSummaryDoc, threadId, BACKGROUND_CONTEXT);
				if (summary !== undefined) this.#summaries.set(threadId, copy(summary) as StoredSummary);
			}
		})();
		return this.#loading;
	}

	/** Called after every committed change with the threads it touched, before the write that made it returns. */
	onChange(listener: (threadIds: ReadonlySet<string>) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** One commit through the threads layer: `run` stages its writes; once committed they reach memory and then the change
	 * listeners, before this returns. A newer copy in memory is never replaced by an older one. */
	async #commit<T>(run: (tx: Tx, writes: Writes) => Promise<T>): Promise<T> {
		await this.load();
		let writes: Writes | undefined;
		const result = await this.#harness.commit(async (tx) => {
			writes = new Writes(tx);
			return run(tx, writes);
		}, BACKGROUND_CONTEXT);
		const staged = writes!;
		const touched = new Set<string>();
		if (staged.directoryWritten && staged.directory !== undefined && staged.directory.revision > this.#directory.revision) {
			const before = new Set(this.#directory.threads);
			const after = new Set(staged.directory.threads);
			for (const id of before) if (!after.has(id)) touched.add(id);
			for (const id of after) if (!before.has(id)) touched.add(id);
			this.#directory = staged.directory;
		}
		for (const [threadId, record] of staged.records) {
			if (!staged.written.has(threadId) || record.revision <= (this.#records.get(threadId)?.revision ?? 0)) continue;
			this.#records.set(threadId, record);
			touched.add(threadId);
		}
		for (const [threadId, summary] of staged.summaries) {
			if (!staged.summariesWritten.has(threadId) || summary.revision <= (this.#summaries.get(threadId)?.revision ?? 0)) continue;
			this.#summaries.set(threadId, summary);
			touched.add(threadId);
		}
		if (touched.size > 0) for (const listener of this.#listeners) listener(touched);
		return result;
	}

	/** The live threads in creation order, each with its summary: a read of memory, valid once `load()` settled. */
	snapshot(): Thread[] {
		const threads: Thread[] = [];
		for (const threadId of this.#directory.threads) {
			const record = this.#records.get(threadId);
			if (record === undefined || record.deletedAt !== null) continue;
			const stored = this.#summaries.get(threadId);
			if (stored === undefined) {
				threads.push(copy(record));
				continue;
			}
			const { revision: _revision, ...summary } = stored;
			threads.push({ ...copy(record), summary: copy(summary) });
		}
		return threads;
	}

	/** The live threads in creation order, each with its summary. */
	async list(): Promise<Thread[]> {
		await this.load();
		return this.snapshot();
	}

	/** Keep the sidebar snapshot current without loading the transcript again: a prompt writes the user message, and a
	 * loaded or finished run writes its projection. A late, older write never overwrites a newer snapshot. */
	async remember(threadId: string, summary: Partial<ThreadSummary> & { updatedAt: number }): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const record = await writes.record(threadId);
			if (record === undefined || record.deletedAt !== null) return;
			const existing = await writes.summary(threadId);
			const incomingMessageAt = summary.latestVisibleMessage?.updatedAt ?? -Infinity;
			const existingMessageAt = existing?.latestVisibleMessage?.updatedAt ?? -Infinity;
			if (existing !== undefined && summary.updatedAt < existing.updatedAt && incomingMessageAt <= existingMessageAt) return;
			await writes.putSummary(threadId, {
				updatedAt: existing === undefined ? summary.updatedAt : Math.max(existing.updatedAt, summary.updatedAt),
				latestVisibleMessage: summary.latestVisibleMessage === undefined ? (existing?.latestVisibleMessage ?? null) : summary.latestVisibleMessage,
				latestUserMessageAt: summary.latestUserMessageAt === undefined ? (existing?.latestUserMessageAt ?? null) : summary.latestUserMessageAt,
				itemCount: summary.itemCount ?? existing?.itemCount ?? 0,
				visibleItemCount: summary.visibleItemCount ?? existing?.visibleItemCount ?? 0,
				revision: existing?.revision ?? 0,
			});
		});
	}

	/** The answer the host gave a command it accepted, while it keeps that receipt. */
	async receipt(commandId: string): Promise<number | undefined> {
		await this.load();
		return this.#receipts.get(commandId);
	}

	/** Keep the receipt of an accepted command. */
	async recordReceipt(commandId: string, sequence: number): Promise<void> {
		await this.load();
		const kept = await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ReceiptsDoc);
			const receipts = copy(doc.receipts);
			if (receipts.some((receipt) => receipt.commandId === commandId)) return receipts;
			const next = [...receipts, { commandId, sequence }].slice(-MAX_RECEIPTS);
			overwrite(doc, { receipts: next });
			return next;
		}, BACKGROUND_CONTEXT);
		this.#receipts.clear();
		for (const receipt of kept) this.#receipts.set(receipt.commandId, receipt.sequence);
	}

	/** The live thread whose head is `conversationId`, if any. */
	async threadIdForConversation(conversationId: number): Promise<string | undefined> {
		await this.load();
		const threadId = this.#directory.heads[String(conversationId)];
		const record = threadId === undefined ? undefined : this.#records.get(threadId);
		return record !== undefined && record.deletedAt === null && record.head === conversationId ? threadId : undefined;
	}

	/**
	 * T3's `orchestration.searchThreads`, answered from the conversations this host already has (design.md). It mirrors
	 * T3's `ThreadSearch.search` semantics (in `t3/thread-search.ts`): every thread's committed user/assistant messages are
	 * read, matched by an ASCII-case-insensitive substring, ranked per thread (a user message first, then newest, then
	 * lowest entry id), and ordered globally (user-first thread, then most-recently-updated, then thread id), capped at
	 * `limit`. A thread is searched by its HEAD conversation — the sidebar's live thread. Deleted threads are absent from
	 * the document, so a search never names one (design.md, Invariants).
	 */
	async search(query: string, limit: number): Promise<ThreadSearchMatch[]> {
		const threads = await this.list();
		const threadUpdatedAt = new Map<string, number>();
		const candidates: SearchCandidate[] = [];
		for (const thread of threads) {
			// T3's `threads.updated_at`: the most-recent activity on the head. A message's timestamp is the activity this
			// host records, so the newest message time (falling back to creation) is the thread's recency.
			let updatedAt = thread.createdAt;
			const conversation = await this.#harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
			if (conversation === undefined) continue;
			const { entries } = await conversation.context(BACKGROUND_CONTEXT);
			for (const entry of entries as readonly import("./t3/model-types.ts").EntryRecord[]) {
				const candidate = searchCandidate(entry, thread.threadId, thread.projectId);
				if (candidate === undefined) continue;
				if (candidate.messageCreatedAt !== undefined && candidate.messageCreatedAt !== null && candidate.messageCreatedAt > updatedAt) {
					updatedAt = candidate.messageCreatedAt;
				}
				candidates.push(candidate);
			}
			threadUpdatedAt.set(thread.threadId, updatedAt);
		}
		return searchThreads(candidates, threadUpdatedAt, query, limit);
	}

	async thread(threadId: string): Promise<Thread | undefined> {
		return (await this.list()).find((candidate) => candidate.threadId === threadId);
	}

	/** A new record; `lineage` defaults to a root thread of its own. */
	#newRecord(input: {
		threadId: string;
		projectId: string;
		head: number;
		title: string;
		provenance: Provenance;
		lineage?: ThreadLineage;
		forkedFrom?: ThreadRecord["forkedFrom"];
		spawn?: Spawn;
		linkOrigin?: LinkOrigin;
		delegatedFrom?: DelegatedFrom;
	}): ThreadRecord {
		return {
			threadId: input.threadId,
			projectId: input.projectId,
			head: input.head,
			title: input.title,
			createdAt: Date.now(),
			createdBy: input.provenance.createdBy,
			creationSource: input.provenance.creationSource,
			lineage: input.lineage ?? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
			forkedFrom: input.forkedFrom ?? null,
			...(input.spawn === undefined ? {} : { spawn: input.spawn }),
			...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
			...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
			deletedAt: null,
			undos: [],
			revision: 0,
		};
	}

	/** Add a new record to the directory, its head included. */
	async #addThread(writes: Writes, record: ThreadRecord): Promise<void> {
		const directory = await writes.readDirectory();
		directory.threads.push(record.threadId);
		directory.heads[String(record.head)] = record.threadId;
		await writes.putRecord(record);
		await writes.putDirectory(directory);
	}

	/** A promoted child thread of `via`: an undo fork of a head that moved on, or a conversation written to after its
	 * thread moved past it. It inherits its parent's provenance, title and root. */
	#childOf(via: ThreadRecord | undefined, viaThreadId: string, head: number, projectId: string): ThreadRecord {
		const threadId = randomUUID();
		return this.#newRecord({
			threadId,
			projectId,
			head,
			title: via?.title ?? "",
			provenance: via === undefined ? USER_WEB : { createdBy: via.createdBy, creationSource: via.creationSource },
			lineage: { parentThreadId: viaThreadId, relationshipToParent: "fork", rootThreadId: via?.lineage.rootThreadId ?? viaThreadId },
			...(via?.linkOrigin === undefined ? {} : { linkOrigin: via.linkOrigin }),
		});
	}

	/**
	 * One commit: a retried create is a no-op, and the `projectId` foreign key is checked AT COMMIT TIME (design.md,
	 * IDs: the registry lives in the other store, so only a check inside the commit sees a project removed mid-call).
	 * `cwd` overrides the project's root for a thread that runs in a folder of its own (a Scratch thread's folder); the
	 * FK still resolves through the registry's cover rule, so the folder must live under a registered project.
	 */
	async create(input: CreateInput): Promise<Thread> {
		const project = this.projects.find((candidate) => candidate.id === input.projectId);
		if (project === undefined) throw hostError("unknown_project", `no such project: ${input.projectId}`);
		const cwd = input.cwd ?? project.cwd;
		// A thread's folder must exist as a directory: a caller that names one (the Scratch claim) creates it first, and
		// anything else is a refusal naming the path (design.md, Invariants).
		let cwdIsDirectory = true;
		if (this.#env !== undefined) {
			// A project may be registered at a symlink; `fileInfo` is an lstat, so resolve first and compare the target.
			const canonical = await this.#env.canonicalPath(cwd, this.#context);
			if (canonical.ok) {
				const info = await this.#env.fileInfo(canonical.value, this.#context);
				if (info.ok) cwdIsDirectory = info.value.kind === "directory";
				else if (info.error.code !== "not_found") throw hostError("unknown_project", `thread folder is not readable: ${cwd} (${info.error.message})`);
			} else if (canonical.error.code !== "not_found") throw hostError("unknown_project", `thread folder is not readable: ${cwd} (${canonical.error.message})`);
		} else {
			try {
				cwdIsDirectory = statSync(cwd).isDirectory();
			}
			catch {
				/* missing/unreadable: the boot mkdir in `attachT3` (with its warning) owns the missing-project case. */
			}
		}
		if (!cwdIsDirectory) throw hostError("unknown_project", `thread folder is not a directory: ${cwd}`);
		return this.#commit(async (tx, writes) => {
			const existing = await writes.record(input.threadId);
			if (existing !== undefined) {
				if (existing.deletedAt !== null) throw hostError("unknown_thread", `thread ${input.threadId} was deleted`);
				return existing;
			}
			// The FK, re-checked inside the commit (design.md, IDs).
			const committed = (await projectsInCommit(tx)).find((candidate) => candidate.id === input.projectId);
			if (committed === undefined) throw hostError("unknown_project", `no such project: ${input.projectId}`);
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			// A fresh thread carries its own cwd — the project's root, or the folder claimed for it — and nothing else
			// (design.md: the bridge decides nothing about the agent).
			await configure(tx, conversation.id, { cwd });
			const record = this.#newRecord({
				threadId: input.threadId,
				projectId: input.projectId,
				head: conversation.id,
				// The client names the title on create and launch (T3 creates the thread with it).
				title: input.title ?? "",
				provenance: input.provenance ?? USER_WEB,
				...(input.lineage === undefined ? {} : { lineage: input.lineage }),
				...(input.forkedFrom === undefined ? {} : { forkedFrom: input.forkedFrom }),
				...(input.spawn === undefined ? {} : { spawn: input.spawn }),
				...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
				...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
			});
			await this.#addThread(writes, record);
			return record;
		});
	}

	/** Change a live thread's record in one commit; `change` returns false to write nothing. */
	async updateRecord(threadId: string, change: (record: ThreadRecord) => boolean | void): Promise<ThreadRecord> {
		return this.#commit(async (_tx, writes) => {
			const record = await writes.live(threadId);
			if (change(record) !== false) await writes.putRecord(record);
			return record;
		});
	}

	/** Set a thread's title: one commit on its record, so a rename survives a restart. */
	async rename(threadId: string, title: string): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const record = await writes.live(threadId);
			record.title = title;
			await writes.putRecord(record);
		});
	}

	/** A prompt: submit to the named conversation (deduped by `requestId`), then promote it. `whenBusy` is steer/followUp. */
	async submit(input: MessageInput, whenBusy: "steer" | "followUp" | undefined): Promise<Submission> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		// Text-only keeps a plain-string content (unchanged prompt-cache shape); an image appends its block after the
		// text block, so the model receives [text, image] exactly as pi-ai's user content carries an image.
		const content: UserInput =
			input.blocks === undefined || input.blocks.length === 0
				? input.message
				: ([{ type: "text", text: input.message }, ...input.blocks] as UserInput);
		// The entry's data carries the message id and the message's images (state.md: no side store — the entry is the record).
		const data: Record<string, JsonValue> = {};
		if (input.messageId !== undefined) data.messageId = input.messageId;
		// Who sent it; the projection reports a user-role message without these as a person in the web app.
		if (input.provenance !== undefined) {
			data.createdBy = input.provenance.createdBy;
			data.creationSource = input.provenance.creationSource;
			if (input.provenance.senderThreadId !== undefined) data.senderThreadId = input.provenance.senderThreadId;
		}
		if (input.attachments !== undefined && input.attachments.length > 0) data.attachments = input.attachments.map((a) => ({ ...a }));
		if (input.context !== undefined) data.context = input.context;
		// A note reaches the model's context without starting a turn: a write whose entry carries the user message. Idle,
		// it is appended at once; busy, pi-durable places it at the run's next boundary.
		if (input.note === true) {
			const message = { role: "user", content, timestamp: Date.now() } as unknown as Message;
			const submission = await conversation.submit({ type: "write", requestId: input.requestId, entry: { kind: APP_NOTE_ENTRY, data, model: [message] } }, BACKGROUND_CONTEXT);
			await this.#rememberInput(input);
			return submission;
		}
		// A manual compaction is conversation-owned work, not a pi run. Queue prompts behind it explicitly: pi's
		// admission sees no `live.run`, so it would otherwise place the prompt and start a turn alongside the summary.
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		const compacting = (((view.value.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined)?.compactions?.length) ?? 0) > 0;
		if (compacting) {
			const queued = await this.#enqueueInput(
				input.conversationId as ConversationId,
				input.requestId,
				content,
				Object.keys(data).length === 0 ? undefined : { kind: APP_USER_ENTRY, data },
			);
			await this.#rememberInput(input);
			return queued;
		}
		const submission = await conversation.submit(
			{
				type: "input",
				requestId: input.requestId,
				content,
				...(whenBusy === undefined ? {} : { whenBusy }),
				...(Object.keys(data).length === 0 ? {} : { entry: { kind: APP_USER_ENTRY, data } }),
			},
			BACKGROUND_CONTEXT,
		);
		// Promote is its own commit and best-effort (design.md): the run is live, so a failed promote is a warning, not a
		// false failure to the caller.
		try {
			await this.promote(input.threadId, input.conversationId);
		} catch (error) {
			this.#onWarn(`prompt committed but its thread promote failed (the run lives; the next promote of this conversation adopts it): ${String(error)}`, error);
		}
		// The sidebar preview must show the prompt before the run starts; the run boundary updates the assistant reply.
		await this.#rememberInput(input);
		return submission;
	}

	/** Queue a prompt behind a live manual compaction without starting a run. The summary's write submission sees the
	 * queued inbox items and places them at its final boundary, so the prompt starts after the new context exists. */
	async #enqueueInput(
		conversationId: ConversationId,
		requestId: string,
		content: UserInput,
		entry: { kind: string; data: Record<string, JsonValue> } | undefined,
	): Promise<Submission> {
		return this.#harness.commit(async (tx) => {
			const existing = await tx.submissionByRequest(conversationId, requestId);
			if (existing !== undefined) return { id: existing.id, status: existing.status } as unknown as Submission;
			const created = await tx.createSubmission({ conversationId, requestId, type: "input", status: "queued" });
			const inbox = await tx.doc(InboxDoc, conversationId);
			inbox.items.push({
				id: created.id,
				mode: "followUp",
				content: structuredClone(content) as never,
				...(entry === undefined ? {} : { entry: { kind: entry.kind, data: structuredClone(entry.data) } }),
			});
			return { id: created.id, status: "queued" } as unknown as Submission;
		}, BACKGROUND_CONTEXT);
	}

	async #rememberInput(input: MessageInput): Promise<void> {
		try {
			const at = Date.now();
			await this.remember(input.threadId, {
				updatedAt: at,
				latestVisibleMessage: { id: input.messageId ?? `user-${at}`, role: "user", text: input.message.slice(0, 500), updatedAt: at },
				latestUserMessageAt: at,
			});
		} catch (error) {
			this.#onWarn(`prompt committed but its sidebar summary failed: ${String(error)}`, error);
		}
	}

	/**
	 * The project that OWNS a conversation, from its own recorded `pi.agent.cwd` through the registry: the project
	 * rooted at the cwd, or the one whose root covers it. `undefined` when none covers it, and a promoted conversation
	 * is then REFUSED — a `projectId` is a foreign key, never a guess from list order (design.md, IDs).
	 */
	async #projectForConversation(tx: Tx, conversationId: number): Promise<string | undefined> {
		const agent = await tx.doc(AgentDoc, conversationId as ConversationId);
		const cwd = agent.cwd;
		if (cwd === undefined) return undefined;
		const projects = await projectsInCommit(tx);
		const exact = projects.find((project) => project.cwd === cwd);
		if (exact !== undefined) return exact.id;
		return projects.find((project) => cwd.startsWith(`${project.cwd}/`))?.id;
	}

	/**
	 * One commit: a conversation that is nobody's head becomes a child thread of the named thread, taking the project
	 * from its OWN cwd. Commits serialize on the one storage, so racing promotes add exactly one thread (design.md).
	 */
	async promote(viaThreadId: string, conversationId: number): Promise<void> {
		await this.#commit(async (tx, writes) => {
			const owner = (await writes.readDirectory()).heads[String(conversationId)];
			const record = owner === undefined ? undefined : await writes.record(owner);
			// A live thread's head needs no promote; a deleted thread's head stays removed: the tombstone outranks the
			// prompt (design.md, Invariants).
			if (record !== undefined && record.head === conversationId) return;
			const projectId = await this.#projectForConversation(tx, conversationId);
			if (projectId === undefined) {
				this.#onWarn(`not promoting conversation ${conversationId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return;
			}
			await this.#addThread(writes, this.#childOf(await writes.record(viaThreadId), viaThreadId, conversationId, projectId));
		});
	}

	/** The head conversation a queued-message command edits, and the thread it belongs to. */
	async #queueTarget(threadId: string): Promise<{ thread: Thread; conversationId: ConversationId }> {
		const thread = await this.thread(threadId);
		if (thread === undefined) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		return { thread, conversationId: thread.head as ConversationId };
	}

	/** The queued follow-up a T3 run id (`q<submissionId>`) names; a plain id addresses a submission directly. */
	#queuedSubmission(runId: string): SubmissionId {
		const value = runId.startsWith("q") ? runId.slice(1) : runId;
		if (!/^[0-9]+$/.test(value)) throw hostError("unknown_queued_message", `not a queued message: ${runId}`);
		return Number(value) as unknown as SubmissionId;
	}

	/** Cancel a queued follow-up: withdraw its submission, which removes it from the inbox and the queue row. */
	async cancelQueued(threadId: string, runId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = this.#queuedSubmission(runId);
		const result = await this.#harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversationId);
		if (result === "already_placed" || result === "settled" || result === "not_found") {
			throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
		}
	}

	/** T3's "Send now" (`queued-run.start`) and `queue.resume`: start the named queued input (or the first) now, leaving
	 * the others queued. pi has no "start this queued item" primitive, so remove the queued user items, submit the
	 * selected one as a fresh run, then restore the others in place. */
	async startQueued(threadId: string, runId: string | undefined, requestId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = runId === undefined ? undefined : this.#queuedSubmission(runId);
		const held = await this.#harness.commit(async (tx) => {
			// A read of the live run first: a Send now while a turn is live would only queue the message again.
			const live = await tx.doc(LiveDoc, conversationId);
			const inbox = await tx.doc(InboxDoc, conversationId);
			if (live.run !== undefined) throw hostError("turn_running", "a turn is running");
			const candidates = inbox.items.filter((item) => item.mode !== "write");
			if (candidates.length === 0) {
				// `queue.resume` may arrive with nothing queued; there is nothing to do.
				if (runId === undefined) return undefined;
				throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			}
			const target = submissionId === undefined ? candidates[0] : candidates.find((item) => item.id === submissionId);
			if (target === undefined) throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			const [input] = readQueuedInputs([target]);
			if (input === undefined) throw hostError("unknown_queued_message", `queued message ${runId} is not a user message`);
			const rest = candidates.filter((item) => item.id !== target.id).map((item) => structuredClone(item));
			// The selected submission becomes the new run; the others keep their queued submissions while they wait.
			tx.settleSubmission(target.id, { status: "unanswered", reason: "started" });
			for (let index = inbox.items.length - 1; index >= 0; index--) {
				if (inbox.items[index]?.mode !== "write") inbox.items.splice(index, 1);
			}
			return { input, rest };
		}, BACKGROUND_CONTEXT);
		if (held === undefined) return;
		const content = held.input.content;
		const blocks = Array.isArray(content)
			? content.filter((block): block is ContentBlock => typeof block === "object" && block !== null && (block as { type?: unknown }).type !== "text")
			: undefined;
		await this.submit({
			threadId,
			conversationId,
			requestId,
			message: held.input.text,
			messageId: held.input.messageId,
			...(blocks === undefined || blocks.length === 0 ? {} : { blocks }),
			...(held.input.attachments.length === 0 ? {} : { attachments: held.input.attachments }),
		}, undefined);
		if (held.rest.length > 0) {
			await this.#harness.commit(async (tx) => {
				const inbox = await tx.doc(InboxDoc, conversationId);
				inbox.items.push(...held.rest);
			}, BACKGROUND_CONTEXT);
		}
	}

	/** Edit a queued follow-up in place: keep its submission id and message id, replace the text, keep the attachments. */
	async editQueued(
		threadId: string,
		runId: string,
		text: string,
		attachments?: readonly { type?: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number }[],
	): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = this.#queuedSubmission(runId);
		await this.#harness.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversationId);
			const item = inbox.items.find((candidate) => candidate.id === submissionId);
			if (item === undefined || item.mode === "write") throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			item.content = withQueuedText(item.content, text) as never;
			if (attachments !== undefined && item.entry !== undefined) {
				const entry = item.entry as { kind: string; data?: Record<string, unknown> };
				entry.data = { ...(entry.data ?? {}), ...(attachments.length === 0 ? {} : { attachments: attachments.map((attachment) => ({ ...attachment })) }) };
				if (attachments.length === 0) delete entry.data.attachments;
			}
		}, BACKGROUND_CONTEXT);
	}

	/** T3's `thread.settle`: a durable manual settlement, keeping the first stamp when it is already settled. */
	/** Keep the outcome of a rollback on the thread (T3's `rollbackRequestId` / `rollbackFailure`). */
	async recordRollback(threadId: string, requestId: string, failure: string | null): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const record = await writes.record(threadId);
			if (record === undefined || record.deletedAt !== null) return;
			record.rollback = { requestId, failure };
			await writes.putRecord(record);
		});
	}

	async settle(threadId: string, settledAt?: number): Promise<void> {
		const at = settledAt ?? Date.now();
		await this.#commit(async (_tx, writes) => {
			const thread = await writes.live(threadId);
			const already = thread.settledOverride === "settled";
			thread.settledOverride = "settled";
			thread.settledAt = already ? (thread.settledAt ?? at) : at;
			delete thread.unsettledAt;
			await writes.putRecord(thread);
		});
	}

	/** T3's `thread.unsettle`: the thread is explicitly active again, with a durable wake stamp. */
	async unsettle(threadId: string): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const thread = await writes.live(threadId);
			const already = thread.settledOverride === "active";
			thread.settledOverride = "active";
			delete thread.settledAt;
			thread.unsettledAt = already ? (thread.unsettledAt ?? Date.now()) : Date.now();
			await writes.putRecord(thread);
		});
	}

	/** T3's automatic un-settle on new activity: no explicit override remains, only a wake stamp. */
	async wake(threadId: string): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const thread = await writes.record(threadId);
			if (thread === undefined || thread.deletedAt !== null || thread.settledOverride === undefined) return;
			const wasActive = thread.settledOverride === "active";
			delete thread.settledOverride;
			delete thread.settledAt;
			if (!wasActive) thread.unsettledAt = Date.now();
			await writes.putRecord(thread);
		});
	}

	/** T3's `/compact`: start a manual compaction and return at once.
	 * The prompt request must not stay open for the whole summary: that serializes the bridge and makes a prompt sent
	 * during compaction time out. The live compaction is projected as the command's run, so T3 still shows the work;
	 * prompts submitted while it runs are queued and land at the summary boundary. A repeated call while a compaction
	 * is live is a no-op. */
	async compact(threadId: string, guidance: string | undefined, messageId?: string): Promise<void> {
		const running = this.#compacting.get(threadId);
		if (running !== undefined) return running;
		const pending = this.#compactConversation(threadId, guidance, messageId);
		this.#compacting.set(threadId, pending);
		try {
			await pending;
		} finally {
			if (this.#compacting.get(threadId) === pending) this.#compacting.delete(threadId);
		}
	}

	async #compactConversation(threadId: string, guidance: string | undefined, messageId: string | undefined): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: `);
		// A compaction may still be live after a bridge restart, when the per-thread map is empty. Leave it be rather
		// than summarize the same cut twice.
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		const live = view.value.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined;
		if ((live?.compactions?.length ?? 0) > 0) return;
		// A display-only command belongs to T3's projection and the durable thread, not to pi's model context. It must
		// not carry `model`: otherwise a later turn sees `/compact` as if the user had typed it as a prompt.
		if (messageId !== undefined) {
			// T3 recognizes a compaction command by its text, and the guidance lives in the compaction task, not the
			// transcript; keep the display text stable so the command and its card become one row.
			const text = "/compact";
			await this.#harness.commit(async (tx) => {
				await tx.appendEntry(conversationId, {
					kind: APP_COMPACT_ENTRY,
					data: { messageId, compact: true, text, timestamp: Date.now() },
				});
			}, BACKGROUND_CONTEXT);
		}
		const taskId = await conversation.compact(guidance, BACKGROUND_CONTEXT);
		// The task is now live and projected. Wait in the background only so a failed compaction does not strand
		// queued prompts; the successful path places them at the summary boundary itself.
		void this.#finishCompaction(threadId, conversationId, taskId);
	}

	async #finishCompaction(threadId: string, conversationId: ConversationId, taskId: TaskId<unknown>): Promise<void> {
		try {
			await this.#harness.waitForTask(taskId, BACKGROUND_CONTEXT);
		} catch (error) {
			this.#onWarn("manual compaction task ended without a summary", error);
		}
		try {
			await this.#drainQueuedAfterCompact(threadId, conversationId);
		} catch (error) {
			this.#onWarn("manual compaction did not drain its queued prompts", error);
		}
	}

	/** Start a queued follow-up if a compaction ended without a summary boundary to place it (failure/abort). */
	async #drainQueuedAfterCompact(threadId: string, conversationId: ConversationId): Promise<void> {
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return;
		const view = await conversation.viewState(BACKGROUND_CONTEXT);
		const live = view.value.docs["pi.live"] as { run?: unknown; compactions?: readonly unknown[] } | undefined;
		if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) return;
		const inbox = view.value.docs["pi.inbox"] as { items?: readonly { mode: string }[] } | undefined;
		if ((inbox?.items ?? []).some((item) => item.mode !== "write")) {
			await this.startQueued(threadId, undefined, randomUUID());
		}
	}

	/** Promote a queued follow-up to a steer: the next boundary places it in the active run. */
	async promoteQueued(threadId: string, runId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = this.#queuedSubmission(runId);
		await this.#harness.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversationId);
			const item = inbox.items.find((candidate) => candidate.id === submissionId);
			if (item === undefined || item.mode === "write") throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			item.mode = "steer";
		}, BACKGROUND_CONTEXT);
	}

	/** Aborts the named conversation; never promotes. */
	async abort(input: { threadId: string; conversationId: number }): Promise<void> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		await conversation.abort(BACKGROUND_CONTEXT);
	}

	/**
	 * T3's undo, one commit: fork at the entry just BEFORE the reverted user turn (a fork is inclusive of its fork
	 * entry, so the reverted message goes with it), or create a fresh conversation carrying the head's agent config
	 * when nothing precedes it. A retried `requestId` returns its earlier fork; the entry must start a user turn in
	 * `expectedHead`'s active context (`not_rewindable`); a head that has moved on gets the fork as a child thread
	 * (design.md, Invariants).
	 */
	async rewind(input: RewindInput): Promise<number> {
		const expectedHead = input.expectedHead as ConversationId;
		const head = await this.#harness.conversation(expectedHead, BACKGROUND_CONTEXT);
		if (head === undefined) throw hostError("unknown_thread", `no such conversation: ${input.expectedHead}`);
		const active = (await head.context(BACKGROUND_CONTEXT)).entries;
		const targetIndex = active.findIndex((entry) => entry.id === input.entryId);
		const target = targetIndex < 0 ? undefined : active[targetIndex]!;
		if (target === undefined || !USER_ENTRY_KINDS.has(target.kind)) {
			throw hostError("not_rewindable", `entry ${input.entryId} is not a user turn in the head's active context`);
		}
		// A fork is INCLUSIVE of its fork entry: fork one entry earlier to drop the reverted turn; a first entry has
		// nothing before it, so baseline is a fresh conversation with the head's agent config (design.md, Invariants).
		const forkAt: number | undefined = targetIndex > 0 ? active[targetIndex - 1]!.id : undefined;
		const headAgent = forkAt === undefined ? await head.agent(BACKGROUND_CONTEXT) : undefined;
		return this.#commit(async (tx, writes) => {
			const thread = await writes.record(input.threadId);
			const applied = thread?.undos.find((undo) => undo.requestId === input.requestId);
			if (applied !== undefined) return applied.head;
			const fork =
				forkAt === undefined
					? await configureNewConversation(tx, headAgent!)
					: await tx.forkConversation(expectedHead, forkAt as EntryId, { ownership: { kind: "ownerless" } });
			const receipt = (record: ThreadRecord): void => {
				record.undos = [...record.undos, { requestId: input.requestId, head: fork.id, from: input.expectedHead }].slice(-MAX_UNDOS);
			};
			if (thread === undefined) {
				this.#onWarn(`not promoting the undo fork ${fork.id}: thread ${input.threadId} does not exist; the fork stays ownerless`, undefined);
				return fork.id;
			}
			if (thread.deletedAt !== null) {
				// The thread was deleted: its removal won the race. The fork is a FRESH conversation, so no tombstone names
				// it — the removal's promise is enforced at this door: the undo of a deleted thread adds no thread. The
				// receipt is recorded, so a retried `requestId` returns this fork instead of forking again.
				this.#onWarn(`not promoting the undo fork ${fork.id}: thread ${input.threadId} is removed; the fork stays ownerless`, undefined);
				receipt(thread);
				await writes.putRecord(thread);
				return fork.id;
			}
			if (thread.head === input.expectedHead) {
				// Move this thread's head to the fork — unless a turn is owed on it, then roll the fork back.
				if (await owedIn(tx, expectedHead)) throw hostError("turn_running", "a turn is running");
				thread.head = fork.id;
				receipt(thread);
				await writes.putRecord(thread);
				const directory = await writes.readDirectory();
				directory.heads[String(fork.id)] = thread.threadId;
				await writes.putDirectory(directory);
				return fork.id;
			}
			// The head moved on: leave the thread and record the fork as a child thread, in the project the FORK's own
			// cwd covers. No cover, no row (design.md, IDs).
			const projectId = await this.#projectForConversation(tx, fork.id);
			if (projectId === undefined) {
				this.#onWarn(`not promoting the undo fork ${fork.id} of thread ${input.threadId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return fork.id;
			}
			await this.#addThread(writes, this.#childOf(thread, input.threadId, fork.id, projectId));
			receipt(thread);
			await writes.putRecord(thread);
			return fork.id;
		});
	}

	/**
	 * T3's `thread.fork`: a new thread whose head is a fork of `sourceThreadId`'s head at `entryId` (inclusive), so a
	 * response can be continued in its own thread. The target id is the client's, so a retried fork returns the same row.
	 */
	async fork(input: {
		sourceThreadId: string;
		targetThreadId: string;
		entryId: number;
		runId?: string;
		title?: string;
		provenance?: Provenance;
		/** A child started with its parent's history: a child's lineage, card node and parent run instead of a fork's. */
		child?: { readonly spawn: Spawn; readonly nodeId: string };
	}): Promise<ThreadRecord> {
		return this.#commit(async (tx, writes) => {
			const existing = await writes.record(input.targetThreadId);
			if (existing !== undefined) {
				if (existing.deletedAt !== null) throw hostError("unknown_thread", `thread ${input.targetThreadId} was deleted`);
				return existing;
			}
			const source = await writes.live(input.sourceThreadId);
			const fork = await tx.forkConversation(source.head as ConversationId, input.entryId as EntryId, { ownership: { kind: "ownerless" } });
			const projectId = await this.#projectForConversation(tx, fork.id);
			if (projectId === undefined) throw hostError("unknown_project", `the fork of ${input.sourceThreadId} matches no registered project`);
			// T3's `ThreadForkService`: the source's title with " fork" unless one is named, the source's root, and the run
			// it forked from.
			const record = this.#newRecord({
				threadId: input.targetThreadId,
				projectId,
				head: fork.id,
				title: input.title ?? `${source.title} fork`,
				provenance: input.provenance ?? USER_WEB,
				lineage: { parentThreadId: source.threadId, relationshipToParent: input.child === undefined ? "fork" : "subagent", rootThreadId: source.lineage.rootThreadId },
				forkedFrom:
					input.child !== undefined
						? { type: "node", nodeId: input.child.nodeId }
						: input.runId === undefined
							? null
							: { type: "run", threadId: source.threadId, runId: input.runId },
				...(input.child === undefined ? {} : { spawn: input.child.spawn }),
				...(source.linkOrigin === undefined ? {} : { linkOrigin: source.linkOrigin }),
			});
			await this.#addThread(writes, record);
			return record;
		});
	}

	/**
	 * Delete a thread: abort its head first — so the abort→commit window leaves nothing owed running — then drop the
	 * pointer and tombstone the removal. Conversations stay: storage only grows (design.md, Invariants).
	 */
	async remove(threadId: string): Promise<void> {
		const thread = await this.thread(threadId);
		if (thread === undefined) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		const head = await this.#harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
		await head?.abort(BACKGROUND_CONTEXT);
		await this.#commit(async (_tx, writes) => {
			const record = await writes.live(threadId);
			// The removal is DURABLE: the record stays as the tombstone, so the promote path and the undo fork skip its head.
			record.deletedAt = Date.now();
			await writes.putRecord(record);
			const directory = await writes.readDirectory();
			directory.threads = directory.threads.filter((id) => id !== threadId);
			await writes.putDirectory(directory);
		});
		// The removal must also win the RUN: interrupt the head again after the commit, so a prompt admitted in the
		// abort→commit window leaves no live turn on a thread the document has removed (design.md, Invariants).
		await head?.abort(BACKGROUND_CONTEXT);
	}
}

/** Read every conversation via the transaction's scan, following the page cursor to the end. Exported for tests. */
export async function scanConversations(tx: Tx): Promise<ConversationRecord[]> {
	const records: ConversationRecord[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await tx.scanConversations({}, 256, cursor);
		records.push(...page.items);
		if (page.next === undefined || page.items.length === 0) break;
		cursor = page.next;
	}
	return records;
}
