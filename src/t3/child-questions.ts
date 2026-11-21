// A child's questions are its parent's to answer. T3's coordinator answers what its delegated tasks ask, and only a card
// nobody else can answer (an approval, a secret) reaches the user (`subagentAwaitsUser`); so the user is told of no
// child's question (`user-notifications.ts`), and a thread another started (`thread_prompt` with `new`) that asks with
// `ask_user` would wait unseen. Its parent is told, as T3 tells a delegated task's parent
// (`DelegatedTaskQuestionReactor.ts`), and answers with `t3_pending_request` (`thread-ops.ts`), or asks the user first:
// - A parent that waits for the child gets the question as its wait's answer (`orchestration.ts`), and has it in hand
//   while that turn runs. A turn that completes or fails with the question still open is told as below (T3's catch-up
//   after a blocking wait); one that was stopped is not. A wait made while the question is open answers with it
//   again, as T3's does, but not sooner than a second after the last.
// - Any other parent gets a message that names the request, once: steered into its running turn (pi steers without
//   interrupting tools), else queued, which starts a turn when it is idle. Never into a compaction, and never to a
//   parent that is archived or gone.
// - The message is taken back when the question is answered, dismissed or stopped while it still waits in the queue.
// Nothing is stored. The message's id is derived from the request's, so a message a previous process sent is found in
// the parent's thread, and a question that still waits after a restart is told then if it was not.
import { createHash } from "node:crypto";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { Bridge } from "./bridge.ts";
import type { Logger } from "./logging.ts";
import { isActiveIn, takesSteer } from "./reports.ts";
import { messageOf } from "../host-errors.ts";

/** The question cards a thread waits on, as T3's `t3_pending_request` lists them: its pending `user_input` requests. A
 * secret card is no request, and an approval no question: those are the user's. */
export const pendingQuestions = (projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests">): string[] =>
	projection.runtimeRequests.filter((request) => request.kind === "user_input" && request.status === "pending").map((request) => request.id as string);

/** What a parent reads of its child's question: T3's words to a delegated task's parent. */
export const questionNotice = (child: string, requestId: string): string =>
	`is blocked on a question and cannot continue until it is answered. Read it with t3_pending_request action read, threadId ${child}, and requestId ${requestId}. Answer it with action respond when the answer follows from the task or from what the user asked for; otherwise ask the user, then answer it.`;

/** A wait that a child's question ended is not ended by that child again sooner than this: a script that waits in a
 * loop until the work is done turns once a second while the question is open, not as fast as it can. */
const REASK_MS = 1_000;

/** The id of the message that tells `parent` of a question: the same for the same question, so it is sent once. */
const noticeId = (parent: string, child: string, requestId: string): string => `q-${createHash("sha256").update(`${parent}\0${child}\0${requestId}`).digest("base64url").slice(0, 20)}`;

type ShellItem = Parameters<Parameters<Bridge["onShell"]>[0]>[0];

export class ChildQuestions {
	readonly #bridge: Bridge;
	readonly #log: Logger;
	/** Does `parent` wait for `child` right now (`thread_wait`, a prompt's own wait)? Its wait answers with the question. */
	readonly #awaits: (parent: string, child: string) => boolean;
	/** The children that wait on questions, as last seen: each one's parent, of each question whether the parent needs
	 * no more telling, and when a wait of the parent's last answered with them. */
	readonly #asking = new Map<string, { readonly parent: string; readonly told: Map<string, boolean>; handedAt?: number }>();
	/** The questions a wait answered with (by child and request): the parent's turn that has them in hand. */
	readonly #handed = new Map<string, { readonly parent: string; readonly child: string; readonly requestId: string; readonly runId: string }>();
	/** The looks at each child that are under way, one after the other. */
	readonly #looks = new Map<string, Promise<void>>();
	#stop: (() => void) | undefined;
	#closed = false;

	constructor(bridge: Bridge, log: Logger, awaits: (parent: string, child: string) => boolean) {
		this.#bridge = bridge;
		this.#log = log;
		this.#awaits = awaits;
	}

	/** Before the bridge has shown a thread: each child's shell is seen from its first, so a question that waited through
	 * a restart is looked at as its thread opens. */
	start(): void {
		this.#stop = this.#bridge.onShell((item) => this.#shell(item));
	}

	close(): void {
		this.#closed = true;
		this.#stop?.();
	}

	/** A wait of `parent`'s answered with `child`'s questions: they are in the hands of its turn `runId`, when the wait
	 * was a turn's. One it was told of before is not told again. */
	handed(parent: string, child: string, requestIds: readonly string[], runId: string | undefined): void {
		const asking = this.#asking.get(child) ?? { parent, told: new Map<string, boolean>() };
		this.#asking.set(child, asking);
		asking.handedAt = Date.now();
		for (const requestId of requestIds) if (runId !== undefined && asking.told.get(requestId) !== true) this.#handed.set(`${child}\0${requestId}`, { parent, child, requestId, runId });
		this.#log.info("child question answered its parent's wait", { child, parent, requestIds });
	}

	/** How long a wait of `parent`'s for `children` holds off before it starts: until `REASK_MS` after its last wait
	 * that their questions ended. */
	pause(parent: string, children: readonly string[]): number {
		const now = Date.now();
		return Math.max(0, ...children.map((child) => {
			const asking = this.#asking.get(child);
			return asking?.parent === parent && asking.handedAt !== undefined ? asking.handedAt + REASK_MS - now : 0;
		}));
	}

	/** A wait for `child` has ended: a question it did not answer with (it ran out as the child asked) is told now. */
	waitEnded(child: string): void {
		if (this.#asking.has(child)) this.#look(child);
	}

	#shell(item: ShellItem): void {
		// A child deleted while it asked: the change that ended its question may never show (the thread is gone first).
		if (item.kind === "thread.removed" && this.#asking.has(item.threadId as string)) this.#look(item.threadId as string);
		if (item.kind !== "thread.updated") return;
		const threadId = item.thread.id as string;
		// A thread that waits on a request, or a child that did when last seen: its questions may have changed.
		if (item.thread.pendingRuntimeRequest !== null || this.#asking.has(threadId)) this.#look(threadId);
		// A parent whose turn had a question in hand, and has ended.
		for (const handed of this.#handed.values()) if (handed.parent === threadId && item.thread.activeRunId !== handed.runId) this.#look(handed.child);
	}

	#look(child: string): void {
		if (this.#closed) return;
		const next = (this.#looks.get(child) ?? Promise.resolve())
			.then(() => (this.#closed ? undefined : this.#check(child)))
			.catch((error: unknown) => {
				if (!this.#closed) this.#log.warn("a child's question could not be passed to its parent", { child, error: messageOf(error) });
			})
			.finally(() => {
				if (this.#looks.get(child) === next) this.#looks.delete(child);
			});
		this.#looks.set(child, next);
	}

	async #check(child: string): Promise<void> {
		const record = this.#bridge.threadRecord(child);
		// Only a thread another started has a parent to answer it: a thread nobody started asks the user, and so does a
		// fork, whose parent link names the thread it was forked from. A child deleted since it asked is still its parent's.
		const parent = this.#asking.get(child)?.parent ?? (record?.spawn === undefined ? null : record.lineage.parentThreadId);
		if (parent === null) return;
		// A child that is gone asks nothing.
		const pending = record === undefined ? [] : pendingQuestions((await this.#bridge.projection(child)).projection);
		const asking = this.#asking.get(child) ?? { parent, told: new Map<string, boolean>() };
		for (const [key, handed] of this.#handed) if (handed.child === child && !pending.includes(handed.requestId)) this.#handed.delete(key);
		for (const requestId of [...asking.told.keys()]) {
			if (pending.includes(requestId)) continue;
			asking.told.delete(requestId);
			await this.#takeBack(parent, child, requestId);
		}
		for (const requestId of pending) {
			if (asking.told.get(requestId) === true) continue;
			asking.told.set(requestId, false);
			this.#asking.set(child, asking);
			if (await this.#tell(parent, child, requestId)) asking.told.set(requestId, true);
		}
		if (asking.told.size === 0) this.#asking.delete(child);
	}

	/** Tell `parent` of its child's question, unless it has it or will get it another way. False: not yet, look again
	 * (when its wait ends, when its turn ends). */
	async #tell(parent: string, child: string, requestId: string): Promise<boolean> {
		const thread = this.#bridge.threadRecord(parent);
		// T3 wakes no parent that is archived or deleted.
		if (thread === undefined || thread.archivedAt !== undefined) return true;
		if (this.#awaits(parent, child)) return false;
		const projection = (await this.#bridge.projection(parent)).projection;
		const handed = this.#handed.get(`${child}\0${requestId}`);
		if (handed !== undefined) {
			const run = projection.runs.find((candidate) => (candidate.id as string) === handed.runId);
			if (run !== undefined && isActiveIn(projection)(run)) return false;
			this.#handed.delete(`${child}\0${requestId}`);
			// T3 catches up after a turn that completed or failed with the question open, not after one that was stopped.
			if (run?.status !== "completed" && run?.status !== "failed") return true;
		}
		const messageId = noticeId(parent, child, requestId);
		// Sent by an earlier process.
		if (projection.messages.some((message) => (message.id as string) === messageId)) return true;
		const title = this.#bridge.threadRecord(child)?.title ?? "";
		const steer = takesSteer(projection);
		await this.#bridge.sendMessage({
			threadId: parent,
			commandId: `ask-${messageId}`,
			messageId,
			text: `Thread ${title === "" ? child : `"${title}" (${child})`} ${questionNotice(child, requestId)} If it is no longer pending, it was answered or dismissed.`,
			mode: steer ? "steer" : "queue",
			provenance: { createdBy: "agent", creationSource: "server", senderThreadId: child },
			automatic: true,
		});
		this.#log.info("child question sent to its parent", { child, parent, requestId, steer });
		return true;
	}

	/** Take back the message about a question that no longer waits, if `parent` has not read it yet (T3 cancels the
	 * queued wake of a question that was answered, or whose task settled). */
	async #takeBack(parent: string, child: string, requestId: string): Promise<void> {
		if (!this.#bridge.hasThread(parent)) return;
		const messageId = noticeId(parent, child, requestId);
		const waiting = (await this.#bridge.waitingMessages(parent)).find((message) => message.messageId === messageId);
		if (waiting === undefined) return;
		try {
			await this.#bridge.cancelQueued(parent, String(waiting.submissionId));
			this.#log.info("child question taken back", { child, parent, requestId });
		} catch {
			// Placed meanwhile: the parent has it in its turn.
		}
	}
}
