// A thread's queue: the messages waiting in its head conversation's inbox (T3's queued runs), and the commands on
// them (remove, edit, send now, promote to a steer), Stop, and "send now" ahead of the queue. Every message is
// submitted with `onAbort: "keep"` (`Threads.draft`), so Stop's abort leaves the queue where it is.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, type Harness, InboxDoc, type InboxItem, LiveDoc, type LiveState, type SubmissionDraft, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { hostError } from "./host-errors.ts";
import { AWAITS_CONTEXT } from "./t3/message-contexts.ts";
import type { Thread } from "./thread-records.ts";
import type { ContentBlock } from "./t3/model-types.ts";
import { readQueuedInputs, withQueuedText } from "./t3/queued.ts";
import { APP_UNREAD_STEER_ENTRY, authorOf } from "./t3/runs.ts";
import { queuedCommand, takeCommands, type TakenCommand } from "./t3/queued-commands.ts";
import type { MessageInput } from "./threads.ts";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Take the queued messages (steers and follow-ups; writes stay) out of an inbox's items, and return copies of them. */
export function takeQueued(items: InboxItem[]): InboxItem[] {
	const queued = items.filter((item) => item.mode !== "write").map((item) => copy(item));
	for (let index = items.length - 1; index >= 0; index--) {
		if (items[index]?.mode !== "write") items.splice(index, 1);
	}
	return queued;
}

/** What the queue uses of the threads layer. */
type QueueHost = {
	readonly harness: Harness;
	thread(threadId: string): Promise<Thread | undefined>;
	watermark(threadId: string): Promise<void>;
	draft(input: MessageInput): SubmissionDraft;
	admitting(tx: Tx, input: MessageInput): Promise<MessageInput>;
	submitted(input: MessageInput): Promise<void>;
	compact(threadId: string, guidance: string | undefined, messageId?: string): Promise<void>;
	reload(threadId: string, messageId?: string): Promise<void>;
};

/** A message waiting in a thread's inbox (`ThreadQueue.waiting`): a queued-message command addresses it by its
 * submission id. */
export interface WaitingMessage {
	readonly submissionId: number;
	readonly mode: "steer" | "followUp";
	readonly messageId: string;
	readonly text: string;
}

export class ThreadQueue {
	readonly #threads: QueueHost;

	constructor(threads: QueueHost) {
		this.#threads = threads;
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

	/** The messages waiting in a thread's inbox, steers and queued follow-ups, in inbox order. A steer is no queued run
	 * while a run takes it (T3 shows it in that run), so this, not the queue rows, names every message not placed yet; a
	 * waiting message is addressed by its submission id. */
	async waiting(threadId: string): Promise<WaitingMessage[]> {
		const { conversationId } = await this.#queueTarget(threadId);
		const items = readQueuedInputs((await this.#threads.harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))?.items);
		return items.map(({ submissionId, mode, messageId, text }) => ({ submissionId, mode, messageId, text }));
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
	 * the others queued. pi has no "start this queued item" primitive, so the selected one is submitted as a fresh run
	 * ahead of the others, as a restart's message is (`submitFirst`), in the commit that takes it out of the queue. */
	async startQueued(threadId: string, runId: string | undefined, requestId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const submissionId = runId === undefined ? undefined : this.#queuedSubmission(runId);
		const conversation = await this.#threads.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${conversationId}`);
		await this.#threads.watermark(threadId);
		const started = await this.#threads.harness.commit(async (tx) => {
			// A request seen before started its message then: another would be taken from the queue and never started.
			if ((await tx.submissionByRequest(conversationId, requestId)) !== undefined) return undefined;
			// A read of the live run first: a Send now while a turn is live would only queue the message again. A manual
			// compaction is no run to pi-durable, which would start one beside the summary; the summary places the queue.
			const live = await tx.doc(LiveDoc, conversationId);
			const inbox = await tx.doc(InboxDoc, conversationId);
			const busy = live.run !== undefined || (live.compactions?.length ?? 0) > 0;
			// `queue.resume` behind a live run (T3 sends it after its Resume continued the run): the queue follows that run.
			if (busy && runId === undefined) return undefined;
			if (busy) throw hostError("turn_running", "a turn is running");
			const candidates = inbox.items.filter((item) => item.mode !== "write");
			if (candidates.length === 0) {
				// `queue.resume` may arrive with nothing queued; there is nothing to do.
				if (runId === undefined) return undefined;
				throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			}
			const target = submissionId === undefined ? candidates[0] : candidates.find((item) => item.id === submissionId);
			if (target === undefined) throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			const [input] = readQueuedInputs([copy(target)]);
			if (input === undefined) throw hostError("unknown_queued_message", `queued message ${runId} is not a user message`);
			// A queued command (`/compact`, `/reload`) is never a prompt: it leaves the queue and is answered, with every
			// command directly behind it, since a compaction places the next queued message when its summary lands. The
			// messages stay queued.
			if (queuedCommand(input.text) !== undefined) return { commands: takeCommands(tx, inbox.items, inbox.items.indexOf(target)) };
			// The shown text is the message; its hidden blocks (where its attachments are saved) and its images go with it
			// as they were sent.
			const blocks = Array.isArray(input.content) ? (input.content as ContentBlock[]).filter((block) => block.type !== "text" || block.hidden === true) : [];
			const message: MessageInput = {
				threadId,
				conversationId,
				requestId,
				message: input.text,
				messageId: input.messageId,
				...(blocks.length === 0 ? {} : { blocks }),
				...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
				...(input.entry?.data?.[AWAITS_CONTEXT] === true ? { awaitsContext: true } : {}),
			};
			const queued = takeQueued(inbox.items);
			await conversation.submit(tx, this.#threads.draft(message));
			// The selected submission is the new run's message now; the others keep their queued submissions and follow it.
			tx.settleSubmission(target.id, { status: "unanswered", reason: "started" });
			(await tx.doc(InboxDoc, conversationId)).items.unshift(...queued.filter((item) => item.id !== target.id));
			return { message };
		}, BACKGROUND_CONTEXT);
		if (started === undefined) return;
		if (started.commands !== undefined) {
			// A compaction places the messages behind it when its summary lands. A reload starts nothing: a queue that
			// was resumed goes on with the message behind it.
			if (!(await this.#answerAll(threadId, started.commands)) && runId === undefined) await this.startQueued(threadId, undefined, `${requestId}:next`);
			return;
		}
		await this.#threads.submitted(started.message);
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
		const command = await this.#threads.harness.commit(async (tx) => {
			const inbox = await tx.doc(InboxDoc, conversationId);
			const item = inbox.items.find((candidate) => candidate.id === submissionId);
			if (item === undefined || item.mode === "write") throw hostError("unknown_queued_message", `queued message ${runId} is no longer queued`);
			// A queued command sent now is answered now, beside the run, as one typed without queueing is.
			const [input] = readQueuedInputs([item]);
			const queued = input === undefined ? undefined : queuedCommand(input.text);
			if (input === undefined || queued === undefined) {
				item.mode = "steer";
				// The record the projection labels it by (`SentAs`): a steer now, one that was queued first.
				if (item.entry !== undefined) item.entry = { ...item.entry, data: { ...((item.entry.data as Record<string, never> | undefined) ?? {}), whenBusy: "steer", promoted: true } };
				return;
			}
			tx.settleSubmission(item.id, { status: "unanswered", reason: "started" });
			inbox.items.splice(inbox.items.indexOf(item), 1);
			return { ...queued, messageId: input.messageId };
		}, BACKGROUND_CONTEXT);
		if (command !== undefined) await this.#answer(threadId, command);
	}

	/**
	 * Answer the commands at the front of a queue that no run works on, before something makes pi-durable place what
	 * is queued: a message sent to the thread releases a held queue, and a compaction places the next queued message
	 * when its summary lands. A run that ends does this itself (`t3/queued-commands.ts`).
	 */
	async answerLeading(threadId: string): Promise<void> {
		const { conversationId } = await this.#queueTarget(threadId);
		const commands = await this.#threads.harness.commit(async (tx) => {
			if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) return [];
			const inbox = await tx.doc(InboxDoc, conversationId);
			const first = inbox.items.findIndex((item) => item.mode !== "write");
			return first < 0 ? [] : takeCommands(tx, inbox.items, first);
		}, BACKGROUND_CONTEXT);
		await this.#answerAll(threadId, commands);
	}

	/** Answer commands that left the queue together: the reloads, then one compaction for however many were queued in
	 * a row. Whether a compaction was started. */
	async #answerAll(threadId: string, commands: readonly TakenCommand[]): Promise<boolean> {
		for (const command of commands) if (command.command === "reload") await this.#answer(threadId, command);
		const compact = commands.find((command) => command.command === "compact");
		if (compact !== undefined) await this.#answer(threadId, compact);
		return compact !== undefined;
	}

	/** Answer a command that left the queue, as the command sent now is answered. */
	async #answer(threadId: string, command: TakenCommand): Promise<void> {
		if (command.command === "reload") await this.#threads.reload(threadId, command.messageId);
		else await this.#threads.compact(threadId, command.guidance === "" ? undefined : command.guidance, command.messageId);
	}

	/**
	 * Aborts the named conversation; never promotes. The messages queued behind the run stay queued, as T3's Stop and
	 * restart keep them: each was submitted with `onAbort: "keep"`, so pi-durable's abort leaves it in the inbox, with
	 * its queued submission, and nothing starts it until the next message or Resume (T3's held queue).
	 *
	 * `stop`: a Stop someone asked for. A person's steer that was waiting when Stop came and that the stopped run had not
	 * read when it ended is cancelled, as T3 0.1.11 cancels one (`requeueUnreadSteers`): it leaves the queue, its
	 * submission unanswered, and an entry where the run ended shows it cancelled with a notice that it may not have been
	 * delivered. In one commit, once the run has ended, so a host that dies before then keeps the steer queued, held. A
	 * message sent while the run stops is kept, held first, as T3 queues it to run next. Unlike T3, an agent's message
	 * (another thread's, a child's report) is kept too: its sender cannot send it again, and a report's text is nowhere
	 * else. A restart or a provider's limit keeps every steer: it steers the run that follows.
	 */
	async abort(input: { threadId: string; conversationId: number }, stop = false): Promise<void> {
		const conversationId = input.conversationId as ConversationId;
		const conversation = await this.#threads.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		// Only a run the Stop reached has steers to drop: one waiting with no run (a provider's limit) waits for the run
		// to go on.
		const reached = stop && (await this.#threads.harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT))?.run !== undefined;
		const waiting = reached ? readQueuedInputs((await this.#threads.harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT))?.items) : [];
		const dropped = new Set(waiting.filter((item) => item.mode === "steer" && authorOf(item.entry?.data).createdBy === "user").map((item) => item.submissionId));
		await conversation.abort(BACKGROUND_CONTEXT);
		if (dropped.size === 0) return;
		await this.#threads.harness.commit(async (tx) => {
			// A message sent since the run ended started a run with the steers: they were read.
			if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) return;
			const inbox = await tx.doc(InboxDoc, conversationId);
			const steers = readQueuedInputs(inbox.items).filter((item) => item.mode === "steer" && dropped.has(item.submissionId));
			const cancelledAt = Date.now();
			for (const steer of steers) {
				tx.settleSubmission(steer.submissionId as unknown as SubmissionId, { status: "unanswered", reason: "aborted" });
				inbox.items.splice(inbox.items.findIndex((item) => item.id === (steer.submissionId as unknown as SubmissionId)), 1);
				const data = { ...(steer.entry?.data === undefined ? {} : copy(steer.entry.data)), messageId: steer.messageId, text: steer.text, cancelledAt };
				await tx.appendEntry(conversationId, { kind: APP_UNREAD_STEER_ENTRY, data: data as JsonValue });
			}
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * A message that runs now, ahead of the messages queued: they follow it, as T3 puts a restart's message first in its
	 * queue. One commit, as `Threads.continue`: pi-durable starts an idle conversation's next run with what is queued, so
	 * they are out of the inbox while this message is admitted, and back in the same commit, behind its run however soon
	 * it ends.
	 */
	async submitFirst(input: MessageInput): Promise<void> {
		const conversationId = input.conversationId as ConversationId;
		const conversation = await this.#threads.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw hostError("unknown_thread", `no such conversation: ${input.conversationId}`);
		await this.#threads.watermark(input.threadId);
		await this.#threads.harness.commit(async (tx) => {
			const queued = takeQueued((await tx.doc(InboxDoc, conversationId)).items);
			// What it says of the run it replaced is decided here, where that run has ended (`MessageInput.afterStop`).
			await conversation.submit(tx, this.#threads.draft(await this.#threads.admitting(tx, input)));
			(await tx.doc(InboxDoc, conversationId)).items.unshift(...queued);
		}, BACKGROUND_CONTEXT);
		await this.#threads.submitted(input);
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
