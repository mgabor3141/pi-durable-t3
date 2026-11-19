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
	type EntryId,
	InboxDoc,
	LiveDoc,
	type Submission,
	type SubmissionDraft,
	type TaskId,
	type Tx,
	UserEntry,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { HostError, hostError } from "./host-errors.ts";
import type { Project } from "./config.ts";
import type { ContentBlock } from "./t3/model-types.ts";
import { APP_COMPACT_ENTRY, APP_CONTINUE_ENTRY, APP_NOTE_ENTRY, APP_RELOAD_ENTRY } from "./t3/runs.ts";
import { AWAITS_CONTEXT } from "./t3/message-contexts.ts";
import { shownPromptSections } from "./t3/queued-commands.ts";
import type { Message } from "@earendil-works/pi-ai";
import { searchThreads, searchCandidate, type SearchCandidate, type ThreadSearchMatch } from "./t3/thread-search.ts";

import { type ProjectRegistry, projectsInCommit } from "./registry.ts";

/** The entry kind a client prompt is placed as, carrying the client's message id in its `data` (state.md: no side
 * store). It must not start with `pi.` — pi-durable's namespace for an input's own entry kinds. */
const APP_USER_ENTRY = "app.user";

/** Entry kinds that name a user turn, for the rewind's `not_rewindable` check; the facet owns a copy of this literal. */
const USER_ENTRY_KINDS: ReadonlySet<string> = new Set([UserEntry.kind, APP_USER_ENTRY]);

import { takeQueued, ThreadQueue } from "./thread-queue.ts";
import { type Provenance, USER_WEB, type ThreadLineage, type Spawn, type ThreadSummary, type ThreadRecord, type Thread, ThreadsDoc, type StoredSummary, NO_SUMMARY, MAX_UNDOS, MAX_RECEIPTS, ThreadRecordDoc, ThreadSummaryDoc, type Directory, ReceiptsDoc } from "./thread-records.ts";
export type { Provenance, ThreadLineage, PendingContext, NotifyRequest, Spawn, SummaryRun, ThreadSummary, AppliedUndo, LimitRecovery, ThreadRecord, ThreadOpens, Thread, ThreadOrigin } from "./thread-records.ts";
export { USER_WEB, HeldQueueDoc, ThreadsDoc } from "./thread-records.ts";

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
};
export type MessageInput = {
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
	/** Marked in the entry's data: the run that answers the message asks the integrator for its context first. */
	readonly awaitsContext?: boolean;
};
type RewindInput = {
	readonly threadId: string;
	readonly expectedHead: number;
	readonly entryId: number;
	readonly requestId: string;
	/** The entry is one of the agent's responses, not a user turn: it and what follows go, the user's message stays. */
	readonly step?: true;
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
	/** The queue's commands, Stop and "send now" (`thread-queue.ts`). */
	readonly queue: ThreadQueue;

	constructor(deps: ThreadsDeps) {
		this.#harness = deps.harness;
		this.#registry = deps.registry;
		this.#env = deps.env;
		this.#context = deps.context ?? BACKGROUND_CONTEXT;
		this.#onWarn = deps.onWarn ?? (() => {});
		this.queue = new ThreadQueue({ harness: deps.harness, thread: (threadId) => this.thread(threadId), watermark: (threadId) => this.watermark(threadId), draft: (input) => this.draft(input), submitted: (input) => this.submitted(input), compact: (threadId, guidance, messageId) => this.compact(threadId, guidance, messageId), reload: (threadId, messageId) => this.reload(threadId, messageId) });
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
			await this.queue.restoreHeld();
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
				latestRun: summary.latestRun === undefined ? (existing?.latestRun ?? null) : summary.latestRun,
				...(summary.latestUserAuthoredMessageAt === undefined
					? existing?.latestUserAuthoredMessageAt === undefined
						? {}
						: { latestUserAuthoredMessageAt: existing.latestUserAuthoredMessageAt }
					: { latestUserAuthoredMessageAt: summary.latestUserAuthoredMessageAt }),
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
	 * `limit`. A thread is searched by its HEAD conversation — the sidebar's live thread — and by its whole transcript. Deleted threads are absent from
	 * the document, so a search never names one (design.md, Invariants).
	 */
	async search(query: string, limit: number): Promise<ThreadSearchMatch[]> {
		const threads = await this.list();
		const threadUpdatedAt = new Map<string, number>();
		const candidates: SearchCandidate[] = [];
		const heads = new Set<number>();
		for (const thread of threads) {
			heads.add(thread.head);
			const read = await this.#searchable(thread);
			if (read === undefined) continue;
			// T3's `threads.updated_at`: the most-recent activity on the head. A message's timestamp is the activity this
			// host records, so the newest message time (falling back to creation) is the thread's recency.
			threadUpdatedAt.set(thread.threadId, Math.max(thread.createdAt, read.updatedAt));
			candidates.push(...read.candidates);
		}
		for (const head of this.#searched.keys()) if (!heads.has(head)) this.#searched.delete(head);
		return searchThreads(candidates, threadUpdatedAt, query, limit);
	}

	/** The characters search keeps of the threads it has read (the memory log). */
	searchChars(): number {
		let chars = 0;
		for (const read of this.#searched.values()) for (const candidate of read.candidates) chars += candidate.text.length;
		return chars;
	}

	/**
	 * Each head's messages as search reads them, kept between searches: entries do not change, so a search reads only
	 * the ones written since the last. The whole transcript, not the model's context: T3 searches every message, and a
	 * compaction takes none of them out of what the thread shows.
	 */
	readonly #searched = new Map<number, { last: EntryId | undefined; updatedAt: number; candidates: SearchCandidate[] }>();

	async #searchable(thread: Thread): Promise<{ updatedAt: number; candidates: readonly SearchCandidate[] } | undefined> {
		const conversation = await this.#harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) return undefined;
		const read = this.#searched.get(thread.head) ?? { last: undefined, updatedAt: 0, candidates: [] };
		this.#searched.set(thread.head, read);
		let cursor: Parameters<typeof conversation.entries>[2];
		const from = read.last === undefined ? {} : { minEntryId: ((read.last as number) + 1) as EntryId };
		do {
			const page = await conversation.entries({ ...from, order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
			for (const entry of page.items as unknown as readonly import("./t3/model-types.ts").EntryRecord[]) {
				// A search that overlaps this one may have read it already: they share `read`, and each pages on its own.
				if (read.last !== undefined && entry.id <= (read.last as number)) continue;
				read.last = entry.id as EntryId;
				const candidate = searchCandidate(entry, thread.threadId, thread.projectId);
				if (candidate === undefined) continue;
				if (candidate.messageCreatedAt !== null && candidate.messageCreatedAt > read.updatedAt) read.updatedAt = candidate.messageCreatedAt;
				read.candidates.push(candidate);
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return read;
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
	async submit(input: MessageInput, whenBusy: "steer" | "followUp" | undefined, waits = false): Promise<Submission> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		const { content, data } = this.#prompt(input);
		// A note reaches the model's context without starting a turn: a write whose entry carries the user message. Idle,
		// it is appended at once; busy, pi-durable places it at the run's next boundary.
		if (input.note === true) {
			const message = { role: "user", content, timestamp: Date.now() } as unknown as Message;
			const submission = await conversation.submit({ type: "write", requestId: input.requestId, entry: { kind: APP_NOTE_ENTRY, data, model: [message] } }, BACKGROUND_CONTEXT);
			await this.#rememberInput(input);
			return submission;
		}
		// Before the run exists, so its completion is after the watermark however fast it is.
		await this.watermark(input.threadId);
		// A manual compaction is conversation-owned work, not a pi run. Queue prompts behind it explicitly: pi's
		// admission sees no `live.run`, so it would otherwise place the prompt and start a turn alongside the summary.
		const live = await this.#harness.snapshot(LiveDoc, input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		const compacting = (live?.compactions?.length ?? 0) > 0;
		// `waits`: the thread waits for a provider's limit to reset (`LimitRecovery`). Nothing runs, and the message is
		// queued as it would be behind a run: a steer joins the run when it is continued, the others follow it.
		// How it was sent, on its entry (`SentAs`): the projection labels it a steer or a queued message by this.
		const sent = (mode: "steer" | "followUp") => ({ ...data, whenBusy: mode, sentAt: Date.now() });
		if (compacting || (waits && live?.run === undefined)) {
			const mode = waits && !compacting && whenBusy === "steer" ? "steer" : "followUp";
			const queued = await this.#enqueueInput(input.conversationId as ConversationId, input.requestId, content, { kind: APP_USER_ENTRY, data: sent(mode) }, mode);
			await this.#rememberInput(input);
			return queued;
		}
		const submission = await conversation.submit(
			whenBusy === undefined ? this.draft(input) : { type: "input", requestId: input.requestId, content, whenBusy, entry: { kind: APP_USER_ENTRY, data: sent(whenBusy) } },
			BACKGROUND_CONTEXT,
		);
		await this.submitted(input);
		return submission;
	}

	/** A message's model content and its entry's data. */
	#prompt(input: MessageInput): { content: UserInput; data: Record<string, JsonValue> } {
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
		if (input.awaitsContext === true) data[AWAITS_CONTEXT] = true;
		return { content, data };
	}

	/** The submission of a message sent with no `whenBusy`: it starts a run when the conversation is idle. For a caller
	 * that admits it in a commit of its own (`ThreadQueue`), with `watermark` before that commit and `submitted` after. */
	draft(input: MessageInput): SubmissionDraft {
		const { content, data } = this.#prompt(input);
		return { type: "input", requestId: input.requestId, content, ...(Object.keys(data).length === 0 ? {} : { entry: { kind: APP_USER_ENTRY, data } }) };
	}

	/** What follows the admission of a message that runs: its conversation promoted, and the sidebar's preview. */
	async submitted(input: MessageInput): Promise<void> {
		// Promote is its own commit and best-effort (design.md): the run is live, so a failed promote is a warning, not a
		// false failure to the caller.
		try {
			await this.promote(input.threadId, input.conversationId);
		} catch (error) {
			this.#onWarn(`prompt committed but its thread promote failed (the run lives; the next promote of this conversation adopts it): ${String(error)}`, error);
		}
		// The sidebar preview shows the prompt at once; the run boundary updates the assistant reply.
		await this.#rememberInput(input);
	}

	/** T3's first-dispatch read watermark: a thread never visited gets one just before its first run, so that run's
	 * completion shows as unread on every client. A thread with none shows nothing unread (T3 keeps imported history read). */
	async watermark(threadId: string): Promise<void> {
		if (this.#records.get(threadId)?.lastVisitedAt !== undefined) return;
		try {
			const at = Date.now() - 1;
			await this.updateRecord(threadId, (record) => {
				if (record.lastVisitedAt !== undefined) return false;
				record.lastVisitedAt = at;
			});
		} catch (error) {
			this.#onWarn(`prompt committed but its read watermark failed: ${String(error)}`, error);
		}
	}

	/** A display-only entry (no model message: pi never sees it), written into a conversation; busy, pi-durable places it
	 * at the run's next boundary. `requestId` makes a retry write it once. */
	async writeDisplayEntry(conversationId: number, requestId: string, kind: string, data: Record<string, JsonValue>): Promise<void> {
		const conversation = await this.#harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${conversationId}`);
		await conversation.submit({ type: "write", requestId, entry: { kind, data } }, BACKGROUND_CONTEXT);
	}

	/** Queue a prompt behind a live manual compaction without starting a run. The summary's write submission sees the
	 * queued inbox items and places them at its final boundary, so the prompt starts after the new context exists. */
	async #enqueueInput(
		conversationId: ConversationId,
		requestId: string,
		content: UserInput,
		entry: { kind: string; data: Record<string, JsonValue> } | undefined,
		mode: "steer" | "followUp" = "followUp",
	): Promise<Submission> {
		return this.#harness.commit(async (tx) => {
			const existing = await tx.submissionByRequest(conversationId, requestId);
			if (existing !== undefined) return { id: existing.id, status: existing.status } as unknown as Submission;
			const created = await tx.createSubmission({ conversationId, requestId, type: "input", status: "queued" });
			const inbox = await tx.doc(InboxDoc, conversationId);
			inbox.items.push({
				id: created.id,
				mode,
				content: structuredClone(content) as never,
				...(entry === undefined ? {} : { entry: { kind: entry.kind, data: structuredClone(entry.data) } }),
			});
			return { id: created.id, status: "queued" } as unknown as Submission;
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Queue a message behind the run that is working, or not at all: `false` when no run is, or when the run has
	 * answered and only finishes (its `afterRun` hooks have looked at the queue already). For a queued command
	 * (`t3/queued-commands.ts`), which must never be placed as a prompt: decided in the commit that queues it.
	 */
	async queueBehindRun(input: { readonly conversationId: number; readonly requestId: string; readonly message: string; readonly messageId: string }): Promise<boolean> {
		const conversationId = input.conversationId as ConversationId;
		return this.#harness.commit(async (tx) => {
			if ((await tx.submissionByRequest(conversationId, input.requestId)) !== undefined) return true;
			const live = await tx.doc(LiveDoc, conversationId);
			if (live.run === undefined || live.run.afterRun !== undefined) return false;
			const created = await tx.createSubmission({ conversationId, requestId: input.requestId, type: "input", status: "queued" });
			(await tx.doc(InboxDoc, conversationId)).items.push({ id: created.id, mode: "followUp", content: input.message, entry: { kind: APP_USER_ENTRY, data: { messageId: input.messageId } } });
			return true;
		}, BACKGROUND_CONTEXT);
	}

	async #rememberInput(input: MessageInput): Promise<void> {
		try {
			const at = Date.now();
			await this.remember(input.threadId, {
				updatedAt: at,
				latestVisibleMessage: { id: input.messageId ?? `user-${at}`, role: "user", text: input.message.slice(0, 500), updatedAt: at },
				latestUserMessageAt: at,
				...((input.provenance?.createdBy ?? "user") === "user" ? { latestUserAuthoredMessageAt: at } : {}),
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

	/** Keep the outcome of a rollback on the thread (T3's `rollbackRequestId` / `rollbackFailure`). */
	async recordRollback(threadId: string, requestId: string, failure: string | null): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const record = await writes.record(threadId);
			if (record === undefined || record.deletedAt !== null) return;
			record.rollback = { requestId, failure };
			await writes.putRecord(record);
		});
	}

	/** T3's `thread.settle`: a durable manual settlement, keeping the first stamp when it is already settled. */
	async settle(threadId: string, settledAt?: number): Promise<void> {
		const at = settledAt ?? Date.now();
		await this.#commit(async (_tx, writes) => {
			const thread = await writes.live(threadId);
			const already = thread.settledOverride === "settled";
			thread.settledOverride = "settled";
			thread.settledAt = already && thread.pinnedAt === undefined ? (thread.settledAt ?? at) : at;
			delete thread.unsettledAt;
			// As T3's settle: a settled thread leaves the pins, its dragged place and any snooze.
			delete thread.snoozedUntil;
			delete thread.snoozedAt;
			delete thread.pinnedAt;
			delete thread.pinOrderKey;
			delete thread.activeOrderKey;
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

	/** T3's automatic un-settle on new activity: no explicit override remains, only a wake stamp. With `snooze` (a message
	 * someone sent, not an automatic one), a snooze ends too. */
	async wake(threadId: string, snooze = false): Promise<void> {
		await this.#commit(async (_tx, writes) => {
			const thread = await writes.record(threadId);
			if (thread === undefined || thread.deletedAt !== null) return;
			const settled = thread.settledOverride !== undefined;
			const snoozed = snooze && thread.snoozedUntil !== undefined;
			if (!settled && !snoozed) return;
			if (settled) {
				const wasActive = thread.settledOverride === "active";
				delete thread.settledOverride;
				delete thread.settledAt;
				if (!wasActive) thread.unsettledAt = Date.now();
			}
			if (snoozed) {
				delete thread.snoozedUntil;
				delete thread.snoozedAt;
			}
			await writes.putRecord(thread);
		});
	}

	/** A thread's head conversation; an unknown thread is refused. */
	async #headOf(threadId: string): Promise<{ thread: Thread; conversationId: ConversationId }> {
		const thread = await this.thread(threadId);
		if (thread === undefined) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		return { thread, conversationId: thread.head as ConversationId };
	}

	/**
	 * `/reload`: render the system prompt afresh at the next request. A `pi.system` write removes every section in effect,
	 * so the next preparation renders all of them again; a host that keeps its prompt fixed for a thread (claw) renders
	 * it again only then. The write waits for a boundary, like any change to the model's context. After a compaction
	 * that has not prepared a request yet there is nothing to remove: that preparation writes the whole prompt anyway.
	 * `messageId`: the typed command, shown where it was sent (display-only).
	 */
	async reload(threadId: string, messageId?: string): Promise<void> {
		const { conversationId } = await this.#headOf(threadId);
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${threadId}`);
		if (messageId !== undefined) {
			const data = { messageId, text: "/reload", timestamp: Date.now() };
			await conversation.submit({ type: "write", requestId: `reload-command:${messageId}`, entry: { kind: APP_RELOAD_ENTRY, data } }, BACKGROUND_CONTEXT);
		}
		const shown = shownPromptSections(await conversation.context(BACKGROUND_CONTEXT));
		if (shown.length === 0) return;
		const message = { role: "system" as const, content: "", sections: Object.fromEntries(shown.map((key) => [key, null])), timestamp: Date.now() };
		await conversation.submit(
			{ type: "write", ...(messageId === undefined ? {} : { requestId: `reload:${messageId}` }), entry: { kind: "pi.system", model: [message] } },
			BACKGROUND_CONTEXT,
		);
	}

	/** T3's `/compact`: start a manual compaction and return at once.
	 * The prompt request must not stay open for the whole summary: that serializes the bridge and makes a prompt sent
	 * during compaction time out. The live compaction is projected as the command's run, so T3 still shows the work;
	 * prompts submitted while it runs are queued and land at the summary boundary. A repeated call while a compaction
	 * is live is a no-op. */
	async compact(threadId: string, guidance: string | undefined, messageId?: string, idle?: true): Promise<void> {
		const running = this.#compacting.get(threadId);
		if (running !== undefined) return running;
		const pending = this.#compactConversation(threadId, guidance, messageId, idle);
		this.#compacting.set(threadId, pending);
		try {
			await pending;
		} finally {
			if (this.#compacting.get(threadId) === pending) this.#compacting.delete(threadId);
		}
	}

	async #compactConversation(threadId: string, guidance: string | undefined, messageId: string | undefined, idle?: true): Promise<void> {
		const { conversationId } = await this.#headOf(threadId);
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: `);
		// A compaction may still be live after a bridge restart, when the per-thread map is empty. Leave it be rather
		// than summarize the same cut twice.
		const live = await this.#harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
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
					// One the host sent by itself before the prompt cache expired says so, as T3's does (`idle-compaction.ts`).
					data: { messageId, compact: true, text, timestamp: Date.now(), ...(idle === true ? { idleCompaction: "beforeCacheExpires", createdBy: "agent", creationSource: "server" } : {}) },
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
		const live = await this.#harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
		if (live?.run !== undefined || (live?.compactions?.length ?? 0) > 0) return;
		const inbox = await this.#harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT);
		if ((inbox?.items ?? []).some((item) => item.mode !== "write")) {
			await this.queue.startQueued(threadId, undefined, randomUUID());
		}
	}

	/**
	 * `/continue`: a run on the context as it is, with no new message (pi-durable's continue). The model owes an answer
	 * only to a context that ends in a user's message or in tool results (after a stop, a failed run, an undone step);
	 * any other is refused here, by name, where pi-durable would start a run and fail it. Refused too while a turn runs
	 * or a manual compaction does (pi-durable sees no run in one and would start a turn beside the summary).
	 *
	 * One commit: the messages queued stay queued and follow the run, as they follow a restart's message (pi-durable
	 * places what is queued in a continue's run, so they are out of the inbox while it is admitted); and where the run
	 * was sent on is written, display-only (`APP_CONTINUE_ENTRY`), so the model never sees it. `messageId`: a typed
	 * `/continue`, shown where it was sent; without one (T3's Resume) nothing is shown.
	 */
	async continue(input: { readonly threadId: string; readonly conversationId: number; readonly requestId: string; readonly messageId?: string }): Promise<void> {
		const conversationId = input.conversationId as ConversationId;
		const conversation = await this.#harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		const { requestId } = input;
		const last = (await conversation.context(BACKGROUND_CONTEXT)).messages.findLast((message) => message.role !== "system");
		await this.watermark(input.threadId);
		await this.#harness.commit(async (tx) => {
			if ((await tx.submissionByRequest(conversationId, requestId)) !== undefined) return;
			const live = await tx.doc(LiveDoc, conversationId);
			if (live.run !== undefined || (live.compactions?.length ?? 0) > 0) throw hostError("turn_running", "a turn is running");
			if (last?.role !== "user" && last?.role !== "toolResult") throw hostError("nothing_to_continue", last === undefined ? "nothing was asked yet" : "the conversation ends with an answer");
			const held = takeQueued((await tx.doc(InboxDoc, conversationId)).items);
			await conversation.submit(tx, { type: "continue", requestId });
			(await tx.doc(InboxDoc, conversationId)).items.unshift(...held);
			await tx.appendEntry(conversationId, { kind: APP_CONTINUE_ENTRY, data: { ...(input.messageId === undefined ? {} : { messageId: input.messageId, text: "/continue" }), timestamp: Date.now() } });
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * A provider's limit ended the head's run: record when it resets and whether the run is continued then
	 * (`LimitRecovery`), with where the thread stands now.
	 */
	async limitReached(input: { readonly threadId: string; readonly conversationId: number; readonly runId: string; readonly resetAt: number; readonly autoResume: boolean }): Promise<void> {
		const head = await this.#harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (head === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		const at = (await head.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? null;
		await this.updateRecord(input.threadId, (record) => {
			if (record.head !== input.conversationId) return false;
			record.limitRecovery = { runId: input.runId, head: input.conversationId, at, resetAt: input.resetAt, autoResume: input.autoResume };
		});
	}

	/**
	 * The limit has reset: continue the run it ended, if the thread is still where the limit left it (nothing written
	 * since, nothing running). Otherwise someone went on already; what is still queued then starts, as nothing else
	 * would start it. The recovery is over either way. Returns what was done.
	 */
	async resumeAfterLimit(threadId: string): Promise<"continued" | "queue" | "nothing"> {
		const recovery = this.#records.get(threadId)?.limitRecovery;
		if (recovery === undefined) return "nothing";
		const head = await this.#harness.conversation(recovery.head as ConversationId, BACKGROUND_CONTEXT);
		const newest = head === undefined ? undefined : ((await head.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? null);
		const record = await this.updateRecord(threadId, (current) => {
			if (current.limitRecovery === undefined) return false;
			delete current.limitRecovery;
		});
		if (record.deletedAt !== null) return "nothing";
		if (record.head === recovery.head && newest === recovery.at) {
			try {
				await this.continue({ threadId, conversationId: recovery.head, requestId: `limit-recovery:${recovery.runId}:${recovery.resetAt}` });
				return "continued";
			} catch (error) {
				// Running already, or nothing left to answer: there is nothing to continue.
				if (!(error instanceof HostError)) throw error;
			}
		}
		await this.queue.startQueued(threadId, undefined, randomUUID()).catch((error: unknown) => {
			if (!(error instanceof HostError)) throw error;
		});
		return "queue";
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
		if (target === undefined || !(input.step === true ? target.kind === "pi.assistant" : USER_ENTRY_KINDS.has(target.kind))) {
			throw hostError("not_rewindable", `entry ${input.entryId} is not ${input.step === true ? "a response of the agent" : "a user turn"} in the head's active context`);
		}
		// A fork is INCLUSIVE of its fork entry: fork at the entry just before the reverted turn in the TRANSCRIPT, so
		// everything written before it stays — a compaction summary included. Not the active context's previous entry:
		// a summary is written after the entries it keeps but leads the context, so that would cut it off and bring the
		// compacted history back. A first entry has nothing before it, so baseline is a fresh conversation with the
		// head's agent config (design.md, Invariants).
		const before = await head.entries({ maxEntryId: (target.id - 1) as EntryId, order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
		const forkAt: number | undefined = before.items[0]?.id;
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
				record.undos = [...record.undos, { requestId: input.requestId, head: fork.id, from: input.expectedHead, at: forkAt ?? null }].slice(-MAX_UNDOS);
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
	 * Take the thread's last undo back: its head returns to the conversation the undo left, which still holds everything
	 * the undo removed. Only while nothing was written since: the head the undo made must still end where it was made
	 * (`AppliedUndo.at`), and owe no turn. One redo per undo, newest first; anything written after an undo ends the
	 * chance to take it back, as in an editor. Returns the head the thread is on again.
	 */
	async redo(input: { readonly threadId: string; readonly expectedHead: number }): Promise<number> {
		const head = await this.#harness.conversation(input.expectedHead as ConversationId, BACKGROUND_CONTEXT);
		if (head === undefined) throw hostError("unknown_thread", `no such conversation: ${input.expectedHead}`);
		const newest = (await head.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? null;
		return this.#commit(async (tx, writes) => {
			const thread = await writes.live(input.threadId);
			const undo = thread.undos.findLast((candidate) => candidate.redone !== true && candidate.head === thread.head);
			if (thread.head !== input.expectedHead || undo === undefined || undo.at === undefined) throw hostError("nothing_to_redo", "there is no undo to take back");
			if (newest !== undo.at) throw hostError("nothing_to_redo", "the thread has gone on since the undo");
			if (await owedIn(tx, input.expectedHead as ConversationId)) throw hostError("turn_running", "a turn is running");
			undo.redone = true;
			thread.head = undo.from;
			await writes.putRecord(thread);
			const directory = await writes.readDirectory();
			directory.heads[String(undo.from)] = thread.threadId;
			await writes.putDirectory(directory);
			return undo.from;
		});
	}

	/**
	 * What the thread's last undo took, as a thread of its own: a fork of the conversation the undo left, whole, so
	 * the thread keeps what was written since and the new thread has what was taken back. Works where `redo` does
	 * not: when the thread has gone on. The new thread is a fork of this one, as T3 shows a fork.
	 */
	async forkUndone(input: { readonly threadId: string; readonly expectedHead: number; readonly targetThreadId: string }): Promise<ThreadRecord> {
		const thread = await this.thread(input.threadId);
		const undo = thread?.undos.findLast((candidate) => candidate.redone !== true && candidate.head === thread.head);
		if (thread === undefined || thread.head !== input.expectedHead || undo === undefined) throw hostError("nothing_to_redo", "there is no undo to take back");
		const left = await this.#harness.conversation(undo.from as ConversationId, BACKGROUND_CONTEXT);
		const newest = (await left?.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT))?.items[0]?.id;
		if (newest === undefined) throw hostError("nothing_to_redo", "there is no undo to take back");
		return this.fork({ sourceThreadId: input.threadId, targetThreadId: input.targetThreadId, entryId: newest as number, conversation: undo.from, title: thread.title === "" ? "Before undo" : `${thread.title} (before undo)` });
	}

	/**
	 * Every conversation that shares history with a thread: the ones the thread has had as its head (the current one
	 * first, then those its undos, redos and moves left or made, as far back as its record holds them), and every
	 * conversation forked from one of those, or they from it, however it came to be: another thread's, one a thread
	 * left long ago, one whose thread was deleted, one no record names. Found by the conversations' own fork links
	 * (one scan of their records), which no thread record has to be right for. `thread`: the live thread whose head a
	 * conversation is.
	 */
	async linesOf(threadId: string): Promise<{ readonly conversation: number; readonly thread?: { readonly threadId: string; readonly title: string } }[]> {
		const threads = await this.list();
		const thread = threads.find((candidate) => candidate.threadId === threadId);
		if (thread === undefined) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		const own = [...new Set([thread.head, ...thread.undos.flatMap((undo) => [undo.head, undo.from]).reverse()])];
		const records = await this.#harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
		const parents = new Map(records.map((record) => [record.id as number, record.parent?.conversationId as number | undefined]));
		const rootOf = (conversation: number): number => {
			for (let current = conversation; ; ) {
				const parent = parents.get(current);
				if (parent === undefined) return current;
				current = parent;
			}
		};
		const roots = new Set(own.map(rootOf));
		const heads = new Map(threads.map((each) => [each.head, { threadId: each.threadId, title: each.title }]));
		const related = records.map((record) => record.id as number).filter((conversation) => !own.includes(conversation) && roots.has(rootOf(conversation)));
		// Threads first: a turn two lines share is made by the first that has it, and a thread's is the one to go to.
		return [...own, ...related.filter((conversation) => heads.has(conversation)), ...related.filter((conversation) => !heads.has(conversation))].map((conversation) => {
			const named = heads.get(conversation);
			return named === undefined ? { conversation } : { conversation, thread: named };
		});
	}

	/**
	 * Move a thread to any point of any line it has had (`/tree`): its head becomes a fork of `conversation` that
	 * ends with `entryId`. Recorded as an undo is, so `/redo` goes back while nothing new is written, and the line
	 * that is left stays one of the thread's (`linesOf`). Refused when the thread is no longer on `expectedHead`
	 * (`not_rewindable`) and while a turn is owed (`turn_running`).
	 */
	async moveTo(input: { readonly threadId: string; readonly expectedHead: number; readonly conversation: number; readonly entryId: number; readonly requestId: string }): Promise<number> {
		return this.#commit(async (tx, writes) => {
			const thread = await writes.live(input.threadId);
			if (thread.head !== input.expectedHead) throw hostError("not_rewindable", "the thread has moved on");
			if (await owedIn(tx, input.expectedHead as ConversationId)) throw hostError("turn_running", "a turn is running");
			const fork = await tx.forkConversation(input.conversation as ConversationId, input.entryId as EntryId, { ownership: { kind: "ownerless" } });
			thread.head = fork.id;
			thread.undos = [...thread.undos, { requestId: input.requestId, head: fork.id, from: input.expectedHead, at: input.entryId }].slice(-MAX_UNDOS);
			await writes.putRecord(thread);
			const directory = await writes.readDirectory();
			directory.heads[String(fork.id)] = thread.threadId;
			await writes.putDirectory(directory);
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
		/** The entry to fork at; none only for a side chat whose parent has no finished turn yet: it starts empty, with the
		 * parent's agent config (T3's side chat without a source run). */
		entryId: number | undefined;
		runId?: string;
		title?: string;
		provenance?: Provenance;
		/** A child started with its parent's history: a child's lineage, card node and parent run instead of a fork's. */
		child?: { readonly spawn: Spawn; readonly nodeId: string };
		/** A side chat (T3's `thread.fork` with `sideChat`): hidden in lists, showing only its own rows, its first message
		 * carrying a note about the main thread. */
		sideChat?: boolean;
		/** Fork this conversation instead of the source's head: one the source has left (`forkUndone`). */
		conversation?: number;
	}): Promise<ThreadRecord> {
		if (input.entryId === undefined && input.sideChat !== true) throw hostError("not_rewindable", "a fork needs an entry to fork at");
		let sourceAgent: Awaited<ReturnType<Conversation["agent"]>> | undefined;
		if (input.entryId === undefined) {
			const head = await this.#harness.conversation((await this.thread(input.sourceThreadId))?.head as ConversationId, BACKGROUND_CONTEXT);
			if (head === undefined) throw hostError("unknown_thread", `no such thread: ${input.sourceThreadId}`);
			sourceAgent = await head.agent(BACKGROUND_CONTEXT);
		}
		return this.#commit(async (tx, writes) => {
			const existing = await writes.record(input.targetThreadId);
			if (existing !== undefined) {
				if (existing.deletedAt !== null) throw hostError("unknown_thread", `thread ${input.targetThreadId} was deleted`);
				return existing;
			}
			const source = await writes.live(input.sourceThreadId);
			const fork =
				input.entryId === undefined
					? await configureNewConversation(tx, sourceAgent!)
					: await tx.forkConversation((input.conversation ?? source.head) as ConversationId, input.entryId as EntryId, { ownership: { kind: "ownerless" } });
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
				lineage: {
					parentThreadId: source.threadId,
					relationshipToParent: input.child === undefined ? "fork" : "subagent",
					rootThreadId: source.lineage.rootThreadId,
					...(input.sideChat === true ? { sideChat: true as const } : {}),
				},
				forkedFrom:
					input.child !== undefined
						? { type: "node", nodeId: input.child.nodeId }
						: input.runId === undefined
							? null
							: { type: "run", threadId: source.threadId, runId: input.runId },
				...(input.child === undefined ? {} : { spawn: input.child.spawn }),
			});
			if (input.sideChat === true) {
				record.pendingContext = { type: "side_chat" };
				if (input.entryId !== undefined) record.forkEntryId = input.entryId;
			}
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
