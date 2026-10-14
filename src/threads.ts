// The threads layer: the only state this host adds is one document, `pi-durable-t3.threads`, in the Harness's own storage.
// The integrator brings a Harness (storage, extensions, tools, env builder) and a project list; this adds named
// pointers ("threads") to conversations, and the writes that keep a pointer honest. Every write names the conversation the
// client shows and carries a `requestId`; a write to a conversation that is no longer any thread's head promotes it to
// a new child thread — conflicts become forks, never "stale" errors.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
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

import type { ProjectRegistry } from "./registry.ts";

/** The entry kind this host places a client prompt as, so the client's message id rides durably in the entry's `data`.
 * It must not start with `pi.` (pi-durable's rule for an input's own entry kind); the facet reads the id back in the projection. */
export const APP_USER_ENTRY = "app.user";

/** Entry kinds that name a user turn, for the rewind's `not_rewindable` check: pi-durable's default placement and this
 * host's id-carrying placement. Mirrors the facet's `USER_ENTRY_KINDS` (the host and facet each own the shared literal). */
const USER_ENTRY_KINDS: ReadonlySet<string> = new Set([UserEntry.kind, APP_USER_ENTRY]);

/** A thread's parent, recorded when it is promoted or forked off another thread. */
type ThreadParent = { threadId: string; entryId: number | null };

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
 * The document state. `removed` is the REMOVAL RECORD: one id per removal — the head conversation of every thread
 * `remove` deleted. It exists so a removal is durable: a prompt admitted before (or racing) a delete must not
 * resurrect the thread through the promote path or boot repair. The doc checkpoints on every write, so the record
 * costs one base row, never a delta per removal.
 */
type ThreadsState = { threads: Thread[]; undos: AppliedUndo[]; removed: number[] };

export const ThreadsDoc = defineDoc<ThreadsState>({
	kind: "pi-durable-t3.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: [], undos: [], removed: [] }),
	// Checkpoint on every write, as `pi.agent` does. This is a session (current-only) document, so a base write drops the
	// delta rows it supersedes and the stored doc stays at one base row. With no policy the doc appends a delta row per
	// create/remove/undo and grows without bound. Nothing reads this document's history — `snapshotAsOf` is not even
	// offered for a session doc, and every read here is a current read (`snapshot` / `tx.doc` / `watchDoc`).
	checkpointWhen: () => true,
});

type ThreadsDeps = {
	readonly harness: Harness;
	/** The live project registry (the instance file). A project's id is derived from its path, so a UI add/remove is
	 * visible without rebuilding this layer; threads look their project's cwd up here at create. */
	readonly registry: ProjectRegistry;
	readonly context?: Context;
	/** The model a newly created thread starts on; absent leaves the model unset until `pi.models` selects one. */
	readonly defaultModel?: ModelRef;
	/** The thinking level a newly created thread starts on (from the instance file's defaults). */
	readonly defaultThinkingLevel?: string;
	/**
	 * Provides the instructions text for a newly created conversation, read fresh at create time so a changed file
	 * affects new threads only. Absent or empty leaves the conversation on just the base prompt. Stored on the
	 * conversation, so forks and undo copies inherit it.
	 */
	readonly instructions?: () => string | undefined;
	/** Injectable clock, for a deterministic `createdAt` in tests. */
	readonly now?: () => number;
	/**
	 * Called when a prompt's run is committed but its promote-into-a-thread step fails. The turn is running and will be
	 * adopted by `repair()` on the next start or by a later write to the conversation; the submit itself succeeded.
	 */
	readonly onWarn?: (message: string, error: unknown) => void;
};

type CreateInput = { readonly threadId: string; readonly projectId: string; readonly title?: string };
type MessageInput = {
	readonly threadId: string;
	readonly conversationId: number;
	readonly requestId: string;
	readonly message: string;
	readonly images?: readonly { mimeType: string; data: string }[];
	/** The client's id for this message. When present the input is placed as an `app.user` entry carrying it, so the
	 * projection reads the id back from the entry (no side store); absent leaves the default `pi.user` placement. */
	readonly messageId?: string;
};
type RewindInput = {
	readonly threadId: string;
	readonly expectedHead: number;
	readonly entryId: number;
	readonly requestId: string;
};

/**
 * Copy a resolved agent's configuration into an `AgentChange` for a fresh conversation. Only the fields the head
 * actually carries are set, so undo-to-baseline reproduces the same model, tools, instructions, and cwd.
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
	readonly #context: Context;
	readonly #defaultModel: ModelRef | undefined;
	readonly #defaultThinkingLevel: string | undefined;
	readonly #instructions: (() => string | undefined) | undefined;
	readonly #now: () => number;
	readonly #onWarn: (message: string, error: unknown) => void;

	constructor(deps: ThreadsDeps) {
		this.#harness = deps.harness;
		this.#registry = deps.registry;
		this.#context = deps.context ?? BACKGROUND_CONTEXT;
		this.#defaultModel = deps.defaultModel;
		this.#defaultThinkingLevel = deps.defaultThinkingLevel;
		this.#instructions = deps.instructions;
		this.#now = deps.now ?? (() => Date.now());
		this.#onWarn = deps.onWarn ?? (() => {});
	}

	get context(): Context {
		return this.#context;
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
		const state = await this.#harness.snapshot(ThreadsDoc, this.#context);
		return state?.threads.map((thread) => ({ ...thread })) ?? [];
	}

	async thread(threadId: string): Promise<Thread | undefined> {
		return (await this.list()).find((candidate) => candidate.threadId === threadId);
	}

	/**
	 * A new thread pointer with a freshly minted id and the current time. `parent` is set only when the thread is
	 * promoted or forked off another; a plain `create` names its own threadId and does not go through here.
	 */
	#newThread(head: number, projectId: string, title: string, parent?: ThreadParent): Thread {
		return { threadId: randomUUID(), projectId, head, title, createdAt: this.#now(), ...(parent === undefined ? {} : { parent }) };
	}

	/**
	 * One commit: if `threadId` already names a thread, return it (a retried create is a no-op and creates no second
	 * conversation); else create a conversation with the project's `cwd` and add the thread.
	 */
	async create(input: CreateInput): Promise<Thread> {
		const project = this.projects.find((candidate) => candidate.id === input.projectId);
		if (project === undefined) throw hostError("unknown_project", `no such project: ${input.projectId}`);
		// A registered path that exists as a non-directory (a hand-edited registry naming a file — boot skipped it with a
		// warning) cannot host a thread: refuse with the typed project error naming the path, not a run stranded in a cwd
		// no tool can enter. A MISSING cwd is left alone: boot creates registered folders, and create stays usable.
		let cwdIsDirectory = true;
		try {
			cwdIsDirectory = statSync(project.cwd).isDirectory();
		}
		catch {
			/* missing/unreadable: boot's per-project mkdir (with its warning) owns that case. */
		}
		if (!cwdIsDirectory) throw hostError("unknown_project", `project ${input.projectId} is not a directory: ${project.cwd}`);
		// New-thread defaults are read live (the instance file, edited by the UI), so a settings change affects threads
		// created after it. The model falls back to the resolved default (first available) when the file sets none.
		const defaults = this.#registry.defaults();
		const model = defaults.model ?? this.#defaultModel;
		const thinking = defaults.thinkingLevel ?? this.#defaultThinkingLevel;
		const instructions = this.#instructions?.();
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const existing = doc.threads.find((candidate) => candidate.threadId === input.threadId);
			if (existing !== undefined) return { ...existing };
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, conversation.id, { cwd: project.cwd, ...(model === undefined ? {} : { model }), ...(thinking === undefined ? {} : { thinkingLevel: thinking as never }), ...(instructions === undefined || instructions === "" ? {} : { instructions }) });
			const thread: Thread = {
				threadId: input.threadId,
				projectId: input.projectId,
				head: conversation.id,
				title: input.title ?? "",
				createdAt: this.#now(),
			};
			doc.threads.push(thread);
			return { ...thread };
		}, this.#context);
	}

	/** A prompt: submit to the named conversation (deduped by `requestId`), then promote it. `whenBusy` is steer/followUp. */
	async submit(input: MessageInput, whenBusy: "steer" | "followUp" | undefined): Promise<Submission> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, this.#context);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		const images = input.images ?? [];
		const content =
			images.length === 0
				? input.message
				: [
						{ type: "text" as const, text: input.message },
						...images.map((image) => ({ type: "image" as const, mimeType: image.mimeType, data: image.data })),
					];
		const submission = await conversation.submit(
			{
				type: "input",
				requestId: input.requestId,
				content,
				...(whenBusy === undefined ? {} : { whenBusy }),
				// Carry the client's message id in the entry's data: an application entry the projection reads the id back from.
				...(input.messageId === undefined ? {} : { entry: { kind: APP_USER_ENTRY, data: { messageId: input.messageId } } }),
			},
			this.#context,
		);
		// The turn is committed and running. Promoting it into a thread is best-effort: if that commit fails, the prompt
		// still succeeded (the run is live), and it is adopted by `repair()` on the next start or a later write — so do
		// not report a false failure to the caller.
		try {
			await this.promote(input.threadId, input.conversationId);
		} catch (error) {
			this.#onWarn(`prompt committed but its thread promote failed (will be retried at repair/next write): ${String(error)}`, error);
		}
		return submission;
	}

	/**
	 * The project that OWNS a conversation, from the conversation's own recorded `pi.agent.cwd` through the registry:
	 * the project rooted at the cwd, or the one whose root covers it. `undefined` when no project covers it — a
	 * promoted conversation is then REFUSED (ownerless, logged), never attached to the first registered project and
	 * never written with `""`: a `projectId` is a foreign key, and list order is not a fact about the conversation.
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
	 * One commit: if no thread's head is `conversationId`, add a child thread for it (inheriting the named thread's
	 * title). The project comes from the conversation's OWN cwd (see `#projectForConversation`); a conversation no
	 * project covers is not promoted — it stays ownerless and the log names it. Concurrent promotions of the same
	 * conversation add exactly one thread: commits serialize on the one storage, so the second sees the head already
	 * present.
	 */
	async promote(viaThreadId: string, conversationId: number): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			if (doc.threads.some((candidate) => candidate.head === conversationId)) return;
			// A tombstoned conversation stays removed: the removal record outranks any prompt admitted before it.
			if ((doc.removed ?? []).includes(conversationId)) return;
			const projectId = await this.#projectForConversation(tx, conversationId);
			if (projectId === undefined) {
				this.#onWarn(`not promoting conversation ${conversationId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return;
			}
			const via = doc.threads.find((candidate) => candidate.threadId === viaThreadId);
			doc.threads.push(this.#newThread(conversationId, projectId, via?.title ?? "", { threadId: viaThreadId, entryId: null }));
		}, this.#context);
	}

	/** Aborts the named conversation; never promotes. */
	async abort(input: { threadId: string; conversationId: number }): Promise<void> {
		const conversation = await this.#harness.conversation(input.conversationId as ConversationId, this.#context);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		await conversation.abort(this.#context);
	}

	/**
	 * T3's undo, one commit. `entryId` names the USER turn being reverted; the whole run disappears. Because a fork is
	 * inclusive of its fork entry, the new conversation forks at the entry just BEFORE `entryId` (dropping the reverted
	 * user message too); if `entryId` is the first entry, nothing precedes it, so a fresh conversation is created that
	 * copies the head's agent config (undo to baseline → empty). A retried `requestId` returns its earlier result
	 * (idempotent). The entry must start a user turn in `expectedHead`'s active context (`not_rewindable`). If the named
	 * thread's head is still `expectedHead`, refuse `turn_running` while it has a run or queued input, else move the head
	 * to the new conversation; if the head has moved on, leave the thread and add the new conversation as a child thread.
	 */
	async rewind(input: RewindInput): Promise<number> {
		const expectedHead = input.expectedHead as ConversationId;
		const head = await this.#harness.conversation(expectedHead, this.#context);
		if (head === undefined) throw hostError("unknown_thread", `no such conversation: ${input.expectedHead}`);
		const active = (await head.context(this.#context)).entries;
		const targetIndex = active.findIndex((entry) => entry.id === input.entryId);
		const target = targetIndex < 0 ? undefined : active[targetIndex]!;
		if (target === undefined || !USER_ENTRY_KINDS.has(target.kind)) {
			throw hostError("not_rewindable", `entry ${input.entryId} is not a user turn in the head's active context`);
		}
		// A fork is INCLUSIVE of its fork entry, so to drop the reverted user turn we fork at the entry just before it.
		// If the reverted turn is the first entry there is nothing before it to fork at: create a fresh conversation
		// that copies the head's agent config (model, tools, instructions, cwd) instead, so undo to baseline is empty.
		const forkAt: number | undefined = targetIndex > 0 ? active[targetIndex - 1]!.id : undefined;
		const headAgent = forkAt === undefined ? await head.agent(this.#context) : undefined;
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
			// The head moved on: leave the thread and record the fork as a new child thread — in the project the FORK's
			// own cwd covers (it inherits the head's agent config). No cover, no row: an ownerless fork is logged, never
			// a thread under the first registered project and never an empty `projectId`.
			const projectId = await this.#projectForConversation(tx, fork.id);
			if (projectId === undefined) {
				this.#onWarn(`not promoting the undo fork ${fork.id} of thread ${input.threadId}: its cwd matches no registered project; it stays ownerless`, undefined);
				return fork.id;
			}
			doc.threads.push(this.#newThread(fork.id, projectId, thread?.title ?? "", { threadId: input.threadId, entryId: input.entryId }));
			doc.undos.push({ requestId: input.requestId, head: fork.id });
			return fork.id;
		}, this.#context);
	}

	/**
	 * Delete a thread: stop its head's turn, then drop the pointer. Conversations stay (pi-durable has no delete), but the
	 * run must not outlive the thread: aborting the head withdraws any queued inputs, interrupts the running turn, and
	 * waits for idle — so boot `repair()` sees nothing owed and cannot resurrect a deleted thread.
	 */
	async remove(threadId: string): Promise<void> {
		const thread = await this.thread(threadId);
		if (thread === undefined) throw hostError("unknown_thread", `no such thread: ${threadId}`);
		const head = await this.#harness.conversation(thread.head as ConversationId, this.#context);
		await head?.abort(this.#context);
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const index = doc.threads.findIndex((candidate) => candidate.threadId === threadId);
			if (index < 0) throw hostError("unknown_thread", `no such thread: ${threadId}`);
			doc.threads.splice(index, 1);
			// The removal is DURABLE: one id per removal (the head conversation). The promote path, the undo-fork and
			// boot repair skip tombstoned conversations — a prompt racing this removal can never resurrect the thread.
			const removed = (doc.removed ??= []);
			if (!removed.includes(thread.head)) removed.push(thread.head);
		}, this.#context);
	}

	/**
	 * Boot repair, one commit: promote every conversation that has a run or a queued input but is nobody's head — the
	 * crash-between-submit-and-promote gap. A promoted conversation takes its project from its OWN recorded cwd
	 * (`#projectForConversation`); a conversation no registered project covers is not promoted — it stays ownerless
	 * and the log names it. Existing conversations keep working from the cwd they record; a lost registry costs
	 * names, not work.
	 */
	async repair(): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const heads = new Set(doc.threads.map((thread) => thread.head));
			for (const record of await scanConversations(tx)) {
				if (heads.has(record.id)) continue;
				// A tombstoned conversation stays removed — even when it owes work (a prompt admitted during the delete
				// that the abort could not outrun). The removal record outranks boot repair's adoption.
				if ((doc.removed ?? []).includes(record.id)) {
					this.#onWarn(`boot repair: conversation ${record.id} was removed (tombstoned); it stays unthreaded even though it ${await owedIn(tx, record.id) ? "owes work" : "is idle"}`, undefined);
					continue;
				}
				if (!(await owedIn(tx, record.id))) continue;
				const projectId = await this.#projectForConversation(tx, record.id);
				if (projectId === undefined) {
					this.#onWarn(`boot repair: not promoting conversation ${record.id}: its cwd matches no registered project; it stays ownerless`, undefined);
					continue;
				}
				doc.threads.push(this.#newThread(record.id, projectId, ""));
				heads.add(record.id);
			}
		}, this.#context);
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
