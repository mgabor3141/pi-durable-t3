// A `/compact` that waits its turn in the queue. Sent as a queued message while the agent works, it is an ordinary
// queued message until it is the next one (T3 shows, edits and removes it as any other); then the run that ends
// compacts before the messages behind it go on.
//
// pi-durable places the next queued message in the commit that ends a run, so nothing outside the run can get between
// the two. An `afterRun` hook can: the tasks it asks for are the run's last work, and the queue waits for them. The
// hook asks for `QueuedCompactionTask` when the next queued message is a `/compact`, and that task, in one commit,
// takes the message out of the queue, writes the command where it ran (as a `/compact` sent now is written), and
// starts pi-durable's compaction as its child, listed as a live compaction so the thread shows it. A crash before
// that commit leaves the message queued and the hook is asked again; after it, the compaction is under way.
import type { JsonValue } from "@earendil-works/chord/json";
import { CompactionTask, defineExtension, defineTask, GenerationTask, hook, InboxDoc, LiveDoc, runEndTask, type CompactionInput, type Extension, type SubmissionId } from "@earendil-works/pi-durable";
import { readQueuedInputs } from "./queued.ts";
import { APP_COMPACT_ENTRY } from "./runs.ts";

/** `/compact`, with optional guidance: T3's own pattern for the command (`COMPACT_COMMAND_PATTERN`), anchored. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

/** The guidance of a `/compact` (`""` for none), or `undefined` when `text` is not the command. */
export function compactCommand(text: string): string | undefined {
	const match = COMPACT_COMMAND.exec(text.trim());
	return match === null ? undefined : (match[1]?.trim() ?? "");
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
				const inbox = await tx.doc(InboxDoc, runtime.conversationId);
				const at = inbox.items.findIndex((item) => item.id === (task.input.submissionId as SubmissionId));
				// Removed, edited into a message or sent as a steer since the hook looked: nothing to do.
				if (at < 0 || inbox.items[at]!.mode !== "followUp" || compactCommand(readQueuedInputs([inbox.items[at]])[0]?.text ?? "") === undefined) return DONE;
				inbox.items.splice(at, 1);
				tx.settleSubmission(task.input.submissionId as SubmissionId, { status: "unanswered", reason: "started" });
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

export class QueuedCompaction {
	#installed = false;

	/** Whether the host installed the extension: a `/compact` is queued only then, and compacts at once otherwise. */
	get active(): boolean {
		return this.#installed;
	}

	/** `T3Attachment.queuedCompaction`: the hook and its task. */
	extension(): Extension {
		this.#installed = true;
		return defineExtension({
			name: "t3-queued-compaction",
			tasks: [QueuedCompactionTask],
			hooks: [
				hook(GenerationTask, {
					afterRun: async (_run, api, context) => {
						const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
						const queued = readQueuedInputs(inbox?.items);
						// The message a run's end places next: a steer before any follow-up.
						const next = queued.find((item) => item.mode === "steer") ?? queued[0];
						const guidance = next === undefined || next.mode !== "followUp" ? undefined : compactCommand(next.text);
						if (next === undefined || guidance === undefined) return undefined;
						return { tasks: [runEndTask(QueuedCompactionTask, { submissionId: next.submissionId, messageId: next.messageId, guidance })] };
					},
				}),
			],
		});
	}
}
