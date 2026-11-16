// A thread's queue: the messages waiting in its head conversation's inbox (T3's queued runs), and the commands on
// them (remove, edit, send now, promote to a steer), Stop, and "send now" ahead of the queue. pi-durable's abort
// withdraws whatever is queued, so the operations that abort hold the queue aside for the length of that commit
// (`#aroundQueue`), in a document, so a host that dies in between does not lose it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, InboxDoc, LiveDoc, type LiveState, type Submission, type SubmissionId, type TaskId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { hostError } from "./host-errors.ts";
import { HeldQueueDoc, type Thread } from "./thread-records.ts";
import type { ContentBlock } from "./t3/model-types.ts";
import { readQueuedInputs, withQueuedText } from "./t3/queued.ts";
import { compactCommand } from "./t3/queued-compaction.ts";
import type { MessageInput } from "./threads.ts";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** What the queue uses of the threads layer. */
type QueueHost = {
	readonly harness: Harness;
	thread(threadId: string): Promise<Thread | undefined>;
	submit(input: MessageInput, whenBusy: "steer" | "followUp" | undefined): Promise<Submission>;
	compact(threadId: string, guidance: string | undefined, messageId?: string): Promise<void>;
};

export class ThreadQueue {
	readonly #threads: QueueHost;

	constructor(threads: QueueHost) {
		this.#threads = threads;
	}

	/** A host that died while it held a conversation's queue aside (`#aroundQueue`) puts it back when it starts. */
	async restoreHeld(): Promise<void> {
		const aside = await this.#threads.harness.snapshot(HeldQueueDoc, BACKGROUND_CONTEXT);
		if (aside !== undefined && Object.keys(aside.held).length > 0) {
			await this.#threads.harness.commit(async (tx) => {
				const doc = await tx.doc(HeldQueueDoc);
				for (const [conversationId, held] of Object.entries(doc.held)) {
					(await tx.doc(InboxDoc, Number(conversationId) as ConversationId)).items.unshift(...(copy(held) as never[]));
					delete doc.held[conversationId];
				}
			}, BACKGROUND_CONTEXT);
		}
	}

	/** The head conversation a queued-message command edits, and the thread it belongs to. */
	async #queueTarget(threadId: string): Promise<{ thread: Thread; conversationId: ConversationId }> {
		const thread = await this.#threads.thread(threadId);
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
		const result = await this.#threads.harness.abortSubmission(submissionId, BACKGROUND_CONTEXT, conversationId);
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
		const held = await this.#threads.harness.commit(async (tx) => {
			// A read of the live run first: a Send now while a turn is live would only queue the message again.
			const live = await tx.doc(LiveDoc, conversationId);
			const inbox = await tx.doc(InboxDoc, conversationId);
			// `queue.resume` behind a live run (T3 sends it after its Resume continued the run): the queue follows that run.
			if (live.run !== undefined && runId === undefined) return undefined;
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
			// A queued `/compact` is a command, never a prompt: it leaves the queue and compacts, and the others stay
			// queued behind the compaction, which places them when its summary lands.
			const guidance = compactCommand(input.text);
			if (guidance !== undefined) {
				tx.settleSubmission(target.id, { status: "unanswered", reason: "started" });
				inbox.items.splice(inbox.items.indexOf(target), 1);
				return { compact: { guidance, messageId: input.messageId }, input, rest: [], awaitsContext: false };
			}
			const rest = candidates.filter((item) => item.id !== target.id).map((item) => copy(item));
			// The selected submission becomes the new run; the others keep their queued submissions while they wait.
			tx.settleSubmission(target.id, { status: "unanswered", reason: "started" });
			for (let index = inbox.items.length - 1; index >= 0; index--) {
				if (inbox.items[index]?.mode !== "write") inbox.items.splice(index, 1);
			}
			return { input, rest, awaitsContext: input.entry?.data?.["awaitsContext"] === true, compact: undefined };
		}, BACKGROUND_CONTEXT);
		if (held === undefined) return;
		if (held.compact !== undefined) return this.#threads.compact(threadId, held.compact.guidance === "" ? undefined : held.compact.guidance, held.compact.messageId);
		const content = held.input.content;
		const blocks = Array.isArray(content)
			? content.filter((block): block is ContentBlock => typeof block === "object" && block !== null && (block as { type?: unknown }).type !== "text")
			: undefined;
		await this.#threads.submit({
			threadId,
			conversationId,
			requestId,
			message: held.input.text,
			messageId: held.input.messageId,
			...(blocks === undefined || blocks.length === 0 ? {} : { blocks }),
			...(held.input.attachments.length === 0 ? {} : { attachments: held.input.attachments }),
			...(held.awaitsContext ? { awaitsContext: true } : {}),
		}, undefined);
		if (held.rest.length > 0) {
			await this.#threads.harness.commit(async (tx) => {
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
		await this.#threads.harness.commit(async (tx) => {
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

	/** Promote a queued follow-up to a steer: the next boundary places it in the active run. */
	async promoteQueued(threadId: string, runId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = this.#queuedSubmission(runId);
		const compact = await this.#threads.harness.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversationId);
			const item = inbox.items.find((candidate) => candidate.id === submissionId);
			if (item === undefined || item.mode === "write") throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			// A queued `/compact` sent now: it compacts now, beside the run, as one typed without queueing does.
			const [input] = readQueuedInputs([item]);
			const guidance = input === undefined ? undefined : compactCommand(input.text);
			if (input === undefined || guidance === undefined) return void (item.mode = "steer");
			tx.settleSubmission(item.id, { status: "unanswered", reason: "started" });
			inbox.items.splice(inbox.items.indexOf(item), 1);
			return { guidance, messageId: input.messageId };
		}, BACKGROUND_CONTEXT);
		if (compact !== undefined) await this.#threads.compact(threadId, compact.guidance === "" ? undefined : compact.guidance, compact.messageId);
	}

	/**
	 * The queued messages, taken out of the inbox for what `between` does and returned to it right after: each keeps its
	 * queued submission, so it is the same queued message when it is back. `between` runs once it has asked for its own
	 * commit (the Session admits commits in the order they are asked for, so the commit that returns the messages
	 * follows it), and `settled` is awaited last. A host that dies before they are back loses them.
	 */
	async #aroundQueue<T>(conversationId: ConversationId, between: () => Promise<T>, settled: (result: T) => Promise<void> = async () => {}): Promise<T> {
		const held = await this.#threads.harness.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversationId);
			const queued = inbox.items.filter((item) => item.mode !== "write").map((item) => copy(item));
			for (let index = inbox.items.length - 1; index >= 0; index--) {
				if (inbox.items[index]?.mode !== "write") inbox.items.splice(index, 1);
			}
			// Kept where a restart finds them, until they are back.
			if (queued.length > 0) (await tx.doc(HeldQueueDoc)).held[String(conversationId)] = queued as unknown as JsonValue[];
			return queued;
		}, BACKGROUND_CONTEXT);
		const giveBack = async () => {
			if (held.length === 0) return;
			await this.#threads.harness.commit(async (tx) => {
				// Ahead of anything queued since: they were queued first.
				(await tx.doc(InboxDoc, conversationId)).items.unshift(...held);
				delete (await tx.doc(HeldQueueDoc)).held[String(conversationId)];
			}, BACKGROUND_CONTEXT);
		};
		let result: T;
		try {
			result = await between();
		} catch (error) {
			await giveBack();
			throw error;
		}
		await giveBack();
		await settled(result);
		return result;
	}

	/**
	 * Aborts the named conversation; never promotes. The messages queued behind the run stay queued, as T3's Stop and
	 * restart keep them: pi-durable's abort withdraws every queued input in the commit that admits it, so they are out
	 * of the inbox for that commit. They are back before the run has ended (the abort resolves only then).
	 */
	async abort(input: { threadId: string; conversationId: number }): Promise<void> {
		const conversationId = input.conversationId as ConversationId;
		const conversation = await this.#threads.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		await this.#aroundQueue(
			conversationId,
			// Asked for, not awaited: the abort's commit is in line, and its end is awaited once the queue is back.
			async () => {
				const ended = conversation.abort(BACKGROUND_CONTEXT);
				// Its failure is thrown where it is awaited, below; until then it must not count as unhandled.
				ended.catch(() => {});
				return { ended };
			},
			({ ended }) => ended,
		);
	}

	/**
	 * A message that runs now, ahead of the messages queued: they follow it, as T3 puts a restart's message first in its
	 * queue. pi-durable starts an idle conversation's next run with what is queued, so they are out of the inbox while
	 * this message starts its run.
	 */
	async submitFirst(input: MessageInput): Promise<Submission> {
		return this.#aroundQueue(input.conversationId as ConversationId, () => this.#threads.submit(input, undefined));
	}

	/**
	 * End a run that nothing is running any more: `pi.live` shows a run (or a compaction) whose task, and every tool call
	 * it lists, has ended or does not exist. pi-durable ends a run in the same commit as its task, so this happens only
	 * when the task records were changed outside pi-durable (an edited database), and the thread would show it running
	 * forever, with every message queued behind it. Ended as pi-durable's `endRun` ends an aborted run: its inputs
	 * unanswered, a `runFailure`, and the run's presentation removed; the call it left without a result gets the result
	 * context derivation gives any orphaned call. A live task leaves the run alone: its own end clears it. Returns
	 * the run's task and the compactions' tasks it ended.
	 */
	async endDeadRun(input: { threadId: string; conversationId: number }): Promise<{ readonly run?: number; readonly compactions: readonly number[] }> {
		const conversation = await this.#threads.harness.conversation(input.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		return conversation.commit(async (tx) => {
			const live = (await tx.doc(LiveDoc, input.conversationId as ConversationId)) as LiveState;
			const ended = async (taskId: number | undefined) => {
				if (taskId === undefined) return true;
				const task = await tx.task(taskId as TaskId);
				return task === undefined || task.state.status === "terminal";
			};
			let endedRun: number | undefined;
			const run = live.run;
			if (run !== undefined) {
				const calls = [...(live.tools ?? []).map((slot) => slot.taskId), ...(live.nestedTools ?? []).map((slot) => slot.taskId)];
				const dead = (await ended(run.taskId)) && (await Promise.all(calls.map(ended))).every(Boolean);
				if (dead) {
					const inputs = [...run.inputs];
					// A run that answered and runs only its `afterRun` tasks records no failure (`endRun`).
					if ((run as { afterRun?: unknown }).afterRun === undefined) {
						for (const id of inputs) tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
						live.runFailure = { taskId: run.taskId, inputs, reason: "aborted", ...(run.first === undefined ? {} : { first: run.first }) };
					}
					delete live.run;
					delete live.generation;
					delete live.tools;
					delete live.nestedTools;
					endedRun = run.taskId as number;
				}
			}
			const compactions: number[] = [];
			for (const status of [...(live.compactions ?? [])]) if (await ended(status.taskId as number)) compactions.push(status.taskId as number);
			if (compactions.length > 0) {
				live.compactions = (live.compactions ?? []).filter((status) => !compactions.includes(status.taskId as number));
				if (live.compactions.length === 0) delete live.compactions;
			}
			return { ...(endedRun === undefined ? {} : { run: endedRun }), compactions };
		}, BACKGROUND_CONTEXT);
	}
}
