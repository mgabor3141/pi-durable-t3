// The commands that wait their turn in the queue: `/compact` and `/reload`. Sent as a queued message while the agent
// works, one is an ordinary queued message until it is the next one (T3 shows, edits and removes it as any other);
// then the run that ends does what it says before the messages behind it go on: the context is compacted, or the
// system prompt is rendered again for the next message.
//
// pi-durable places the next queued message in the commit that ends a run, so nothing outside the run can get between
// the two. An `afterRun` hook can: the tasks it asks for are the run's last work, and the queue waits for them. The
// hook asks for a task of the command's when the next queued message is one. In one commit that task takes the
// message out of the queue and writes the command where it ran, as the command sent now is written; a compaction's
// also starts pi-durable's compaction as its child, listed as a live compaction so the thread shows it. A crash
// before that commit leaves the message queued and the hook is asked again; after it, the command is done or under
// way.
//
// The other commands this host answers (`/context`, `/undo`, `/redo`, `/continue`) are answered when they arrive:
// they say something about the thread as it is, or need it to be at rest.
import type { JsonValue } from "@earendil-works/chord/json";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { CompactionTask, defineExtension, defineTask, GenerationTask, hook, InboxDoc, LiveDoc, runEndTask, type CompactionInput, type ConversationId, type Extension, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { readQueuedInputs } from "./queued.ts";
import { APP_COMPACT_ENTRY, APP_RELOAD_ENTRY } from "./runs.ts";

/** `/compact`, with optional guidance: T3's own pattern for the command (`COMPACT_COMMAND_PATTERN`), anchored. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

/** A command that can wait in the queue. `guidance`: what follows `/compact` (`""` for nothing). */
export type QueuedCommand = { readonly command: "compact"; readonly guidance: string } | { readonly command: "reload" };

/** The queueable command `text` is, or `undefined` for a message. */
export function queuedCommand(text: string): QueuedCommand | undefined {
	const trimmed = text.trim();
	if (trimmed === "/reload") return { command: "reload" };
	const match = COMPACT_COMMAND.exec(trimmed);
	return match === null ? undefined : { command: "compact", guidance: match[1]?.trim() ?? "" };
}

/**
 * Take the queued message `submissionId` out of the queue, if it still is the command `command`: not removed, edited
 * into something else or sent as a steer since the hook looked.
 */
async function takeQueued(tx: Tx, conversationId: ConversationId, submissionId: number, command: QueuedCommand["command"]): Promise<boolean> {
	const inbox = await tx.doc(InboxDoc, conversationId);
	const at = inbox.items.findIndex((item) => item.id === (submissionId as SubmissionId));
	if (at < 0 || inbox.items[at]!.mode !== "followUp" || queuedCommand(readQueuedInputs([inbox.items[at]])[0]?.text ?? "")?.command !== command) return false;
	inbox.items.splice(at, 1);
	tx.settleSubmission(submissionId as SubmissionId, { status: "unanswered", reason: "started" });
	return true;
}

type Input = { readonly submissionId: number; readonly messageId: string; readonly guidance: string };
type Checkpoint = { phase: "start" } | { phase: "wait"; compaction: number };

const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const;

const QueuedCompactionTask = defineTask<Input, Checkpoint, null>({
	name: "t3.queued-compaction",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			await runtime.commit(async (tx) => {
				if (!(await takeQueued(tx, runtime.conversationId, task.input.submissionId, "compact"))) return DONE;
				// The command, shown where it ran. No model message: the model never sees `/compact` as a prompt.
				await tx.appendEntry(runtime.conversationId, { kind: APP_COMPACT_ENTRY, data: { messageId: task.input.messageId, compact: true, text: "/compact", timestamp: Date.now() } as JsonValue });
				const input: CompactionInput = { reason: "manual", ...(task.input.guidance === "" ? {} : { instructions: task.input.guidance }) };
				const compaction = await tx.createTask(CompactionTask, input, { ownership: { kind: "task", taskId: runtime.taskId } });
				// As pi-durable lists a compaction it starts itself: the thread shows it, and its task takes it off.
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				(live.compactions ??= []).push({ taskId: compaction, trigger: "manual", blocking: true, attempt: 1 });
				return { status: "waiting", checkpoint: { phase: "wait", compaction: compaction as number }, on: [compaction], policy: "allSettled" };
			}, context);
		},
		// The compaction ended, with a summary or without: the queue goes on either way.
		wait: async (_task, runtime, context) => {
			await runtime.commit(() => DONE, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }) as never, context);
	},
});

/**
 * A queued `/reload`: the command where it ran, and every shown section of the system prompt removed, so the request
 * of the message behind it renders them all afresh. What `Threads.reload` writes for a `/reload` sent now.
 */
const QueuedReloadTask = defineTask<{ readonly submissionId: number; readonly messageId: string }, { phase: "start" }, null>({
	name: "t3.queued-reload",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			const view = await runtime.context(runtime.conversationId, context);
			const head = view.head;
			// After a compaction that has prepared no request yet there is nothing to remove: that preparation writes
			// the whole prompt anyway.
			const prepared = view.entries.some((entry) => entry.kind === "pi.system" && (head === undefined || entry.id > head.id));
			const shown = prepared ? Object.keys(getCurrentSystemMessage(view.messages)?.sections ?? {}) : [];
			await runtime.commit(async (tx) => {
				if (!(await takeQueued(tx, runtime.conversationId, task.input.submissionId, "reload"))) return DONE;
				await tx.appendEntry(runtime.conversationId, { kind: APP_RELOAD_ENTRY, data: { messageId: task.input.messageId, text: "/reload", timestamp: Date.now() } as JsonValue });
				if (shown.length > 0) {
					await tx.appendEntry(runtime.conversationId, { kind: "pi.system", model: [{ role: "system", content: "", sections: Object.fromEntries(shown.map((key) => [key, null])), timestamp: Date.now() }] });
				}
				return DONE;
			}, context);
		},
	},
	abort: async (_task, runtime, context) => {
		await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted", reason: "aborted" } }) as never, context);
	},
});

export class QueuedCommands {
	#installed = false;

	/** Whether the host installed the extension: a command is queued only then, and answered at once otherwise. */
	get active(): boolean {
		return this.#installed;
	}

	/** `T3Attachment.queuedCommands`: the hook and its tasks. */
	extension(): Extension {
		this.#installed = true;
		return defineExtension({
			name: "t3-queued-commands",
			tasks: [QueuedCompactionTask, QueuedReloadTask],
			hooks: [
				hook(GenerationTask, {
					afterRun: async (_run, api, context) => {
						const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
						const queued = readQueuedInputs(inbox?.items);
						// The message a run's end places next: a steer before any follow-up.
						const next = queued.find((item) => item.mode === "steer") ?? queued[0];
						const command = next === undefined || next.mode !== "followUp" ? undefined : queuedCommand(next.text);
						if (next === undefined || command === undefined) return undefined;
						const named = { submissionId: next.submissionId, messageId: next.messageId };
						return { tasks: [command.command === "reload" ? runEndTask(QueuedReloadTask, named) : runEndTask(QueuedCompactionTask, { ...named, guidance: command.guidance })] };
					},
				}),
			],
		});
	}
}
