// The threads layer: the only state this host adds is one document, `pi-durable-t3.threads`, in the Harness's own storage.
// The integrator brings a Harness (storage, extensions, tools, env builder) and a project list; this adds named
// pointers ("threads") to conversations and the writes the design defines. Every write names the conversation the
// client shows and carries a `requestId`; a write to a conversation that is no longer any thread's head promotes it to
// a new child thread — conflicts become forks, never "stale" errors.
import { randomUUID } from "node:crypto";
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
	type InboxState,
	LiveDoc,
	type LiveState,
	type ModelRef,
	type Submission,
	type Tx,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { hostError } from "./host-errors.ts";
import type { Project } from "./config.ts";

/** A thread's parent, recorded when it is promoted or forked off another thread. */
export type ThreadParent = { threadId: string; entryId: number | null };

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
export type AppliedUndo = { requestId: string; head: number };

export type ThreadsState = { threads: Thread[]; undos: AppliedUndo[] };

export const ThreadsDoc = defineDoc<ThreadsState>({
	kind: "pi-durable-t3.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: [], undos: [] }),
});

export type ThreadsDeps = {
	readonly harness: Harness;
	readonly projects: readonly Project[];
	readonly context?: Context;
	/** The model a newly created thread starts on; absent leaves the model unset until `pi.models` selects one. */
	readonly defaultModel?: ModelRef;
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

export type CreateInput = { readonly threadId: string; readonly projectId: string; readonly title?: string };
export type MessageInput = {
	readonly threadId: string;
	readonly conversationId: number;
	readonly requestId: string;
	readonly message: string;
	readonly images?: readonly { mimeType: string; data: string }[];
};
export type RewindInput = {
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
	if ((live as LiveState).run !== undefined) return true;
	const inbox = await tx.doc(InboxDoc, conversationId);
	return ((inbox as InboxState).items?.length ?? 0) > 0;
}

/** The threads layer over a caller-provided Harness. Stateless apart from the Harness's own storage. */
export class Threads {
	readonly #harness: Harness;
	readonly #projects: readonly Project[];
	readonly #byId: Map<string, Project>;
	readonly #context: Context;
	readonly #defaultModel: ModelRef | undefined;
	readonly #instructions: (() => string | undefined) | undefined;
	readonly #now: () => number;
	readonly #onWarn: (message: string, error: unknown) => void;

	constructor(deps: ThreadsDeps) {
		this.#harness = deps.harness;
		this.#projects = deps.projects;
		this.#byId = new Map(deps.projects.map((project) => [project.id, project]));
		this.#context = deps.context ?? BACKGROUND_CONTEXT;
		this.#defaultModel = deps.defaultModel;
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
		return this.#projects;
	}

	/** The threads as stored (a read of the doc). Order is creation order. */
	async list(): Promise<Thread[]> {
		const state = await this.#harness.snapshot(ThreadsDoc, this.#context);
		return state?.threads.map((thread) => ({ ...thread })) ?? [];
	}

	async thread(threadId: string): Promise<Thread | undefined> {
		const found = (await this.list()).find((candidate) => candidate.threadId === threadId);
		return found;
	}

	/**
	 * One commit: if `threadId` already names a thread, return it (a retried create is a no-op and creates no second
	 * conversation); else create a conversation with the project's `cwd` and add the thread.
	 */
	async create(input: CreateInput): Promise<Thread> {
		const project = this.#byId.get(input.projectId);
		if (project === undefined) throw hostError("unknown_project", `no such project: ${input.projectId}`);
		const model = this.#defaultModel;
		const instructions = this.#instructions?.();
		return this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const existing = doc.threads.find((candidate) => candidate.threadId === input.threadId);
			if (existing !== undefined) return { ...existing };
			const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
			await configure(tx, conversation.id, { cwd: project.cwd, ...(model === undefined ? {} : { model }), ...(instructions === undefined || instructions === "" ? {} : { instructions }) });
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
			{ type: "input", requestId: input.requestId, content, ...(whenBusy === undefined ? {} : { whenBusy }) },
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
	 * One commit: if no thread's head is `conversationId`, add a child thread for it (inheriting the named thread's
	 * project and title). Concurrent promotions of the same conversation add exactly one thread: commits serialize on
	 * the one storage, so the second sees the head already present.
	 */
	async promote(viaThreadId: string, conversationId: number): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			if (doc.threads.some((candidate) => candidate.head === conversationId)) return;
			const via = doc.threads.find((candidate) => candidate.threadId === viaThreadId);
			const projectId = via?.projectId ?? this.#projects[0]?.id ?? "";
			doc.threads.push({
				threadId: randomUUID(),
				projectId,
				head: conversationId,
				title: via?.title ?? "",
				createdAt: this.#now(),
				parent: { threadId: viaThreadId, entryId: null },
			});
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
		if (target === undefined || target.kind !== UserEntry.kind) {
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
			// The head moved on: leave the thread and record the fork as a new child thread.
			const projectId = thread?.projectId ?? this.#projects[0]?.id ?? "";
			doc.threads.push({
				threadId: randomUUID(),
				projectId,
				head: fork.id,
				title: thread?.title ?? "",
				createdAt: this.#now(),
				parent: { threadId: input.threadId, entryId: input.entryId },
			});
			doc.undos.push({ requestId: input.requestId, head: fork.id });
			return fork.id;
		}, this.#context);
	}

	/**
	 * Delete a thread: stop its head's turn, then drop the pointer. Conversations stay (pi-durable has no delete), but the
	 * run must not outlive the thread: aborting the head withdraws any queued inputs, interrupts the running turn, and
	 * waits for idle — so boot `repair()` no longer sees an owed, headless conversation and resurrects a deleted thread (S3).
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
		}, this.#context);
	}

	/**
	 * Boot repair, one commit: promote every conversation that has a run or a queued input but is nobody's head — the
	 * crash-between-submit-and-promote gap. A promoted conversation takes the project whose `cwd` matches its agent's,
	 * falling back to the first project.
	 */
	async repair(): Promise<void> {
		await this.#harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc);
			const heads = new Set(doc.threads.map((thread) => thread.head));
			const cwdToProject = new Map<string, string>();
			for (const project of this.#projects) cwdToProject.set(project.cwd, project.id);
			for (const record of await scanConversations(tx)) {
				if (heads.has(record.id)) continue;
				if (!(await owedIn(tx, record.id))) continue;
				const agent = await tx.doc(AgentDoc, record.id);
				const projectId = (agent.cwd === undefined ? undefined : cwdToProject.get(agent.cwd)) ?? this.#projects[0]?.id ?? "";
				doc.threads.push({
					threadId: randomUUID(),
					projectId,
					head: record.id,
					title: "",
					createdAt: this.#now(),
				});
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
