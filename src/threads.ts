// The threads layer: the one document this host adds, `pi-durable-t3.threads` — named pointers ("threads") to the
// Harness's conversations. Every rule it enforces is an invariant in docs/design.md; this file is the code, not the case.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentChange,
	AgentDoc,
	configure,
	type Conversation,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	defineDoc,
	type EntryId,
	InboxDoc,
	LiveDoc,
	type ModelRef,
	type Submission,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { hostError } from "./host-errors.ts";
import type { Project } from "./config.ts";
import { searchThreads, searchCandidate, type SearchCandidate, type ThreadSearchMatch } from "./t3/thread-search.ts";

import type { ProjectRegistry } from "./registry.ts";

/** The entry kind a client prompt is placed as, carrying the client's message id in its `data` (state.md: no side
 * store). It must not start with `pi.` — pi-durable's namespace for an input's own entry kinds. */
export const APP_USER_ENTRY = "app.user";

/** Entry kinds that name a user turn, for the rewind's `not_rewindable` check; the facet owns a copy of this literal. */
const USER_ENTRY_KINDS: ReadonlySet<string> = new Set([UserEntry.kind, APP_USER_ENTRY]);

/** The thread this one was promoted or forked from — what T3's projection reports as `parentThreadId` with
 * `relationshipToParent: "fork"` (design.md). Only the id is kept. */
type ThreadParent = { threadId: string };

/** One sidebar entry: a named pointer to a head conversation. Stored in `pi-durable-t3.threads`. */
export type Thread = {
	threadId: string;
	projectId: string;
	head: number;
	title: string;
	createdAt: number;
	parent?: ThreadParent;
};

/** The applied result of an undo, so a retried `requestId` returns the same fork instead of forking again. */
type AppliedUndo = { requestId: string; head: number };

/**
 * The document state. `removed` is the REMOVAL RECORD — one id per removal, the reason a deleted thread stays
 * deleted across restarts (design.md, state.md). The doc checkpoints on every write (state.md).
 */
type ThreadsState = { threads: Thread[]; undos: AppliedUndo[]; removed: number[] };

export const ThreadsDoc = defineDoc<ThreadsState>({
	kind: "pi-durable-t3.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: [], undos: [], removed: [] }),
	// Checkpoint on every write, as `pi.agent` does: every read of this session document is a current read (state.md).
	checkpointWhen: () => true,
});

type ThreadsDeps = {
	readonly harness: Harness;
	/** The live project registry: the foreign key's target, and the source of a new thread's `cwd`. */
	readonly registry: ProjectRegistry;
	/** Notified when a prompt's commit lands and its promote fails; the run stays ownerless until a later promote adopts it. */
	readonly onWarn?: (message: string, error: unknown) => void;
};

type CreateInput = { readonly threadId: string; readonly projectId: string; readonly cwd?: string };
type MessageInput = {
	readonly threadId: string;
	readonly conversationId: number;
	readonly requestId: string;
	readonly message: string;
	/** The client's id for this message, placed in the entry's `data` (state.md: no side store). */
	readonly messageId?: string;
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

/** The threads layer over a caller-provided Harness. Stateless apart from the Harness's own storage. */
export class Threads {
	readonly #harness: Harness;
	readonly #registry: ProjectRegistry;
	readonly #onWarn: (message: string, error: unknown) => void;

	constructor(deps: ThreadsDeps) {
		this.#harness = deps.harness;
		this.#registry = deps.registry;
		this.#onWarn = deps.onWarn ?? (() => {});
	}

	/** The integrator's Harness; the objects layer reads/watches conversation views through it. */
	get harness(): Harness {
		return this.#harness;
	}

	get projects(): readonly Project[] {
		return this.#registry.list();
	}

	/** The threads as stored (a read of the doc). Order is creation order. */
	async list(): Promise<Thread[]> {
		const state = await this.#harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT);
		return state?.threads.map((thread) => ({ ...thread })) ?? [];
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

	/**
	 * A new thread pointer with a minted id; `parent` is set only for a promoted or forked thread (a plain `create`
	 * names its own id).
	 */
	#newThread(head: number, projectId: string, title: string, parent?: ThreadParent): Thread {
		return { threadId: randomUUID(), projectId, head, title, createdAt: Date.now(), ...(parent === undefined ? {} : { parent }) };
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
		try {
			cwdIsDirectory = statSync(cwd).isDirectory();
		}
		catch {
			/* missing/unreadable: the boot mkdir in `attachT3` (with its warning) owns the missing-project case. */
		}
		if (!cwdIsDirectory) throw hostError("unknown_project", `thread folder is not a directory: ${cwd}`);
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const existing = doc.threads.find((candidate) => candidate.threadId === input.threadId);
			if (existing !== undefined) return { ...existing };
			// The FK, re-checked inside the commit (design.md, IDs).
			const committed = this.projects.find((candidate) => candidate.id === input.projectId);
			if (committed === undefined) throw hostError("unknown_project", `no such project: ${input.projectId}`);
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			// A fresh thread carries its own cwd — the project's root, or the folder claimed for it — and nothing else
			// (design.md: the bridge decides nothing about the agent).
			await configure(tx, conversation.id, { cwd });
			const thread: Thread = {
				threadId: input.threadId,
				projectId: input.projectId,
				head: conversation.id,
				title: "",
				createdAt: Date.now(),
			};
			doc.threads.push(thread);
			return { ...thread };
		}, BACKGROUND_CONTEXT);
	}

	/** A prompt: submit to the named conversation (deduped by `requestId`), then promote it. `whenBusy` is steer/followUp. */
	async submit(input: MessageInput, whenBusy: "steer" | "followUp" | undefined): Promise<Submission> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		const content = input.message;
		const submission = await conversation.submit(
			{
				type: "input",
				requestId: input.requestId,
				content,
				...(whenBusy === undefined ? {} : { whenBusy }),
				// The client's message id rides in the entry's data (state.md: no side store).
				...(input.messageId === undefined ? {} : { entry: { kind: APP_USER_ENTRY, data: { messageId: input.messageId } } }),
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
		return submission;
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
		const exact = this.projects.find((project) => project.cwd === cwd);
		if (exact !== undefined) return exact.id;
		return this.projects.find((project) => cwd.startsWith(`${project.cwd}/`))?.id;
	}

	/**
	 * One commit: a conversation that is nobody's head becomes a child thread of the named thread, taking the project
	 * from its OWN cwd. Commits serialize on the one storage, so racing promotes add exactly one thread (design.md).
	 */
	async promote(viaThreadId: string, conversationId: number): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			if (doc.threads.some((candidate) => candidate.head === conversationId)) return;
			// A tombstoned conversation stays removed: the removal record outranks the prompt (design.md, Invariants).
			if ((doc.removed ?? []).includes(conversationId)) return;
			const projectId = await this.#projectForConversation(tx, conversationId);
			if (projectId === undefined) {
				this.#onWarn(`not promoting conversation ${conversationId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return;
			}
			const via = doc.threads.find((candidate) => candidate.threadId === viaThreadId);
			doc.threads.push(this.#newThread(conversationId, projectId, via?.title ?? "", { threadId: viaThreadId }));
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
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const applied = doc.undos.find((undo) => undo.requestId === input.requestId);
			if (applied !== undefined) return applied.head;
			const fork =
				forkAt === undefined
					? await configureNewConversation(tx, headAgent!)
					: await tx.forkConversation(expectedHead, forkAt as EntryId, { ownership: { kind: "ownerless" } });
			const thread = doc.threads.find((candidate) => candidate.threadId === input.threadId);
			if (thread !== undefined && thread.head === input.expectedHead) {
				// Move this thread's head to the fork — unless a turn is owed on it, then roll the fork back.
				if (await owedIn(tx, expectedHead)) throw hostError("turn_running", "a turn is running");
				thread.head = fork.id;
				doc.undos.push({ requestId: input.requestId, head: fork.id });
				return fork.id;
			}
			if (thread === undefined) {
				// The named thread has NO row: its removal won the race. The fork is a FRESH conversation, so no tombstone
				// names it — the removal record's promise is enforced at this door: the undo of a deleted thread adds no
				// row. The receipt is recorded, so a retried `requestId` returns this fork instead of forking again.
				this.#onWarn(`not promoting the undo fork ${fork.id}: thread ${input.threadId} is removed; the fork stays ownerless`, undefined);
				doc.undos.push({ requestId: input.requestId, head: fork.id });
				return fork.id;
			}
			// The head moved on: leave the thread and record the fork as a child thread, in the project the FORK's own
			// cwd covers. No cover, no row (design.md, IDs).
			const projectId = await this.#projectForConversation(tx, fork.id);
			if (projectId === undefined) {
				this.#onWarn(`not promoting the undo fork ${fork.id} of thread ${input.threadId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return fork.id;
			}
			doc.threads.push(this.#newThread(fork.id, projectId, thread.title, { threadId: input.threadId }));
			doc.undos.push({ requestId: input.requestId, head: fork.id });
			return fork.id;
		}, BACKGROUND_CONTEXT);
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
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const index = doc.threads.findIndex((candidate) => candidate.threadId === threadId);
			if (index < 0) throw hostError("unknown_thread", `no such thread: ${threadId}`);
			doc.threads.splice(index, 1);
			// The removal is DURABLE: the promote path and the undo fork skip tombstoned conversations.
			const removed = (doc.removed ??= []);
			if (!removed.includes(thread.head)) removed.push(thread.head);
		}, BACKGROUND_CONTEXT);
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
