// The commands that wait their turn in the queue: `/compact` and `/reload`. Sent as a queued message while the agent
// works, one is an ordinary queued message until it is the next one (T3 shows, edits and removes it as any other);
// then the run that ends does what it says before the messages behind it go on: the context is compacted, or the
// system prompt is rendered again for the next message.
//
// pi-durable places the next queued message in the commit that ends a run, so nothing outside the run can get between
// the two. An `afterRun` hook can: the tasks it asks for are the run's last work, and the queue waits for them. The
// hook asks for `QueuedCommandsTask` when the next queued message is a command. In one commit that task takes the
// command and every command directly behind it out of the queue and writes each where it ran, as the command sent
// now is written; for a `/compact` it also starts pi-durable's compaction as its child, listed as a live compaction
// so the thread shows it. A crash before that commit leaves the messages queued and the hook is asked again; after
// it, the commands are done or under way.
//
// The other commands this host answers (`/context`, `/undo`, `/redo`, `/tree`, `/continue`) are answered when they arrive:
// they say something about the thread as it is, or need it to be at rest.
import type { JsonValue } from "@earendil-works/chord/json";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { CompactionTask, defineExtension, defineTask, GenerationTask, hook, InboxDoc, LiveDoc, runEndTask, type CompactionInput, type ContextView, type ConversationId, type Extension, type InboxItem, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { readQueuedInputs } from "./queued.ts";
import { APP_COMPACT_ENTRY, APP_RELOAD_ENTRY } from "./runs.ts";

/** `/compact`, with optional guidance: T3's own pattern for the command (`COMPACT_COMMAND_PATTERN`), anchored. */
const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

/** A command that can wait in the queue. `guidance`: what follows `/compact` (`""` for nothing). */
type QueuedCommand = { readonly command: "compact"; readonly guidance: string } | { readonly command: "reload" };

/** The queueable command `text` is, or `undefined` for a message. */
export function queuedCommand(text: string): QueuedCommand | undefined {
	const trimmed = text.trim();
	if (trimmed === "/reload") return { command: "reload" };
	const match = COMPACT_COMMAND.exec(trimmed);
	return match === null ? undefined : { command: "compact", guidance: match[1]?.trim() ?? "" };
}

type Input = { readonly submissionId: number };
/** `reloads`: the `/reload`s taken with a compaction, by message id, written once it has ended. */
type Checkpoint = { phase: "start" } | { phase: "wait"; compaction: number; reloads: string[] };

const DONE = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** A command that left the queue, with the id of the message it was. */
export type TakenCommand = QueuedCommand & { readonly messageId: string };

/**
 * Take the queued commands that stand one behind another from `at` out of an inbox's items: up to the first message.
 * All of them, since a run asks its end's hooks once and a compaction places the next queued message when its
 * summary lands: a command left behind another would be the next message placed, as a prompt.
 */
export function takeCommands(tx: Tx, items: InboxItem[], at: number): TakenCommand[] {
	const taken: TakenCommand[] = [];
	while (at >= 0 && at < items.length) {
		const item = items[at]!;
		const [queued] = readQueuedInputs([item]);
		const command = queued === undefined ? undefined : queuedCommand(queued.text);
		if (queued === undefined || command === undefined) break;
		items.splice(at, 1);
		tx.settleSubmission(item.id, { status: "unanswered", reason: "started" });
		taken.push({ ...command, messageId: queued.messageId });
	}
	return taken;
}

/** The sections a `/reload` removes: those the prompt shows, when a request was prepared since the context began.
 * After a compaction that has prepared none there is nothing to remove: that preparation writes the whole prompt. */
export function shownPromptSections(view: ContextView): string[] {
	const head = view.head;
	const prepared = view.entries.some((entry) => entry.kind === "pi.system" && (head === undefined || entry.id > head.id));
	return prepared ? Object.keys(getCurrentSystemMessage(view.messages)?.sections ?? {}) : [];
}

/** A `/reload` where it ran, as `Threads.reload` writes one sent now: the command, and every shown section removed,
 * so the request of the message behind it renders them all afresh. */
async function writeReloads(tx: Tx, conversationId: ConversationId, messageIds: readonly string[], shown: readonly string[]): Promise<void> {
	for (const messageId of messageIds) await tx.appendEntry(conversationId, { kind: APP_RELOAD_ENTRY, data: { messageId, text: "/reload", timestamp: Date.now() } as JsonValue });
	if (messageIds.length > 0 && shown.length > 0) {
		await tx.appendEntry(conversationId, { kind: "pi.system", model: [{ role: "system", content: "", sections: Object.fromEntries(shown.map((key) => [key, null])), timestamp: Date.now() }] });
	}
}

const QueuedCommandsTask = defineTask<Input, Checkpoint, null>({
	name: "t3.queued-commands",
	version: 1,
	initial: () => ({ phase: "start" }),
	phases: {
		start: async (task, runtime, context) => {
			const shown = shownPromptSections(await runtime.context(runtime.conversationId, context));
			await runtime.commit(async (tx) => {
				// The message the hook saw, if it still is a queued command: not removed, edited into a message or sent
				// as a steer since.
				const inbox = await tx.doc(InboxDoc, runtime.conversationId);
				const commands = takeCommands(tx, inbox.items, inbox.items.findIndex((item) => item.id === (task.input.submissionId as SubmissionId) && item.mode === "followUp"));
				const reloads = commands.flatMap((command) => (command.command === "reload" ? [command.messageId] : []));
				// One compaction for however many were queued in a row: a second would summarize the summary.
				const compact = commands.find((command) => command.command === "compact");
				if (compact?.command !== "compact") {
					await writeReloads(tx, runtime.conversationId, reloads, shown);
					return DONE;
				}
				// The command, shown where it ran. No model message: the model never sees `/compact` as a prompt.
				await tx.appendEntry(runtime.conversationId, { kind: APP_COMPACT_ENTRY, data: { messageId: compact.messageId, compact: true, text: "/compact", timestamp: Date.now() } as JsonValue });
				const input: CompactionInput = { reason: "manual", ...(compact.guidance === "" ? {} : { instructions: compact.guidance }) };
				const compaction = await tx.createTask(CompactionTask, input, { ownership: { kind: "task", taskId: runtime.taskId } });
				// As pi-durable lists a compaction it starts itself: the thread shows it, and its task takes it off.
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				(live.compactions ??= []).push({ taskId: compaction, trigger: "manual", blocking: true, attempt: 1 });
				return { status: "waiting", checkpoint: { phase: "wait", compaction: compaction as number, reloads }, on: [compaction], policy: "allSettled" };
			}, context);
		},
		// The compaction ended, with a summary or without: the reloads queued with it are written behind it, and the
		// queue goes on either way.
		wait: async (task, runtime, context) => {
			const reloads = task.state.checkpoint.reloads;
			const shown = reloads.length === 0 ? [] : shownPromptSections(await runtime.context(runtime.conversationId, context));
			await runtime.commit(async (tx) => {
				await writeReloads(tx, runtime.conversationId, reloads, shown);
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
			tasks: [QueuedCommandsTask],
			hooks: [
				hook(GenerationTask, {
					afterRun: async (_run, api, context) => {
						const inbox = await api.snapshot(InboxDoc, api.conversationId, context);
						const queued = readQueuedInputs(inbox?.items);
						// The message a run's end places next: a steer before any follow-up.
						const next = queued.find((item) => item.mode === "steer") ?? queued[0];
						const command = next === undefined || next.mode !== "followUp" ? undefined : queuedCommand(next.text);
						if (next === undefined || command === undefined) return undefined;
						return { tasks: [runEndTask(QueuedCommandsTask, { submissionId: next.submissionId })] };
					},
				}),
			],
		});
	}
}
