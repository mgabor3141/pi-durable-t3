// The slash commands this host answers itself: `/context`, `/undo`, `/redo`, `/continue` (and T3's Resume, which is
// the last one). `/context`, `/undo` and `/redo` are shown in the thread and kept nowhere (`ShownExchange`).
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HostError } from "../host-errors.ts";
import type { BridgeCore } from "./bridge-core.ts";
import { contextReport, type ContextReportView } from "./context-report.ts";
import { CommandError } from "./errors.ts";
import { modelSlug } from "./model-types.ts";
import type { ShownExchange } from "./projection.ts";
import { isAssistantEntry, isUserEntry, stopReason } from "./runs.ts";
import type { ThreadView } from "./thread-view.ts";

/** How many answered commands a thread shows (`ShownExchange`). */
const MAX_SHOWN = 20;

type Core = Pick<BridgeCore, "config" | "log" | "store" | "thread" | "meta">;

export class ThreadCommands {
	readonly #bridge: Core;

	constructor(bridge: Core) {
		this.#bridge = bridge;
	}

	/**
	 * Answer `text` if it is one of the commands; `false`: it is a message for the model.
	 */
	async run(threadId: string, messageId: string, text: string, state: ThreadView, head: number): Promise<boolean> {
		// T3's slash command: `/compact` (with optional guidance) is a compaction task, not a prompt.
		const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text);
		// `/undo` and `/redo`: the thread's head moves back to before a turn or a step, and forward again.
		const undo = /^\/undo(?:\s+(.*))?$/.exec(text);
		if (compact !== null) await this.#bridge.store.compact(threadId, compact[1]?.trim() || undefined, messageId);
		// `/reload`: the next request renders the system prompt afresh (`Threads.reload`); it starts no turn.
		else if (text === "/reload") await this.#bridge.store.reload(threadId, messageId);
		else if (text === "/context") await this.context(threadId, messageId, state, head);
		else if (undo !== null) await this.undo(threadId, messageId, state, head, undo[1]?.trim() ?? "");
		else if (text === "/redo") await this.redo(threadId, messageId, state, head);
		else if (/^\/redo\s+fork$/.test(text)) await this.redoFork(threadId, messageId, state, head);
		// `/continue`: the agent goes on from the context as it is, with no new message (`Threads.continue`).
		else if (text === "/continue") await this.continue(threadId, `continue:${messageId}`, head, { messageId });
		else return false;
		return true;
	}

	/** What a thread shows of them, for its projection. */
	shown(threadId: string): ShownExchange[] | undefined {
		return this.#shown.get(threadId);
	}

	/** A thread was deleted: forget what it showed. */
	forget(threadId: string): void {
		this.#shown.delete(threadId);
	}

	/** Commands answered on the spot, by thread (`ShownExchange`): in memory, the newest `MAX_SHOWN`. */
	readonly #shown = new Map<string, ShownExchange[]>();

	/**
	 * `/context`: a few rows on what fills the model's context (`context-report.ts`), shown in the thread and kept
	 * nowhere: no entry is written, so the model is never sent it and a restart forgets it. A thread that has not run
	 * has nothing in its context yet, and no run for the command to stand in.
	 */
	async context(threadId: string, messageId: string, state: ThreadView, head: number): Promise<void> {
		const { projection } = await state.projection(30_000);
		const run = projection.runs.findLast((candidate) => candidate.status !== "queued" && candidate.status !== "rolled_back");
		if (run === undefined) throw new CommandError("Nothing is in the context yet: send a message first.");
		const conversation = await this.#bridge.store.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new CommandError(`Unknown thread: ${threadId}`);
		const view = await conversation.context(BACKGROUND_CONTEXT);
		const meta = this.#bridge.meta(threadId, state);
		const answer = contextReport({
			view: view as unknown as ContextReportView,
			...(meta.contextWindow === undefined ? {} : { window: meta.contextWindow }),
			...(meta.model === null ? {} : { model: modelSlug(meta.model) }),
		});
		this.show(threadId, state, { messageId, command: "/context", answer });
	}

	/** Show a command the host answered itself (`ShownExchange`); one sent again replaces its earlier answer. */
	show(threadId: string, state: ThreadView, said: Pick<ShownExchange, "messageId" | "answer"> & { readonly command?: string }): void {
		const exchange: ShownExchange = { ...said, at: Date.now(), after: state.transcript.at(-1)?.id ?? -1 };
		const shown = [...(this.#shown.get(threadId) ?? []).filter((each) => each.messageId !== exchange.messageId), exchange];
		this.#shown.set(threadId, shown.slice(-MAX_SHOWN));
		state.recompute();
	}

	/**
	 * `/undo [n]` takes back the user's last message (or last `n`) with everything the agent did for it; `/undo step
	 * [n]` only the agent's last response (or last `n`) with its tool calls and their results, so the user's message
	 * stands unanswered. Like T3's Revert, it moves the thread's head to a fork that ends before what is taken back
	 * (`Threads.rewind`): the conversation it leaves keeps everything, which is what `/redo` returns to. The model's
	 * context is what changes; files and anything done outside the conversation stay as they are. The command and its
	 * answer are shown only (`ShownExchange`): written to the head, they would be the first thing a redo loses.
	 */
	async undo(threadId: string, messageId: string, state: ThreadView, head: number, argument: string): Promise<void> {
		const parsed = /^(step)?\s*(\d+)?$/.exec(argument);
		const count = parsed?.[2] === undefined ? 1 : Number(parsed[2]);
		if (parsed === null || count < 1) throw new CommandError("Usage: /undo [n] takes back your last n messages; /undo step [n] the agent's last n steps.");
		const steps = parsed[1] !== undefined;
		const { projection, runs } = await state.projection(30_000);
		if (projection.runs.some((run) => run.status === "running")) throw new CommandError("Stop the current turn before undoing.");
		if (projection.runs.some((run) => run.status === "queued")) throw new CommandError("Send or remove the queued messages before undoing.");
		const entries = new Map(state.transcript.map((entry) => [entry.id, entry]));
		// The turns a user's message began: a `/compact` or a note that opened a run is not a turn to take back.
		const turns = runs.filter((run) => {
			const entry = entries.get(run.userEntryId);
			return entry !== undefined && isUserEntry(entry);
		});
		const last = (n: number, word: string) => (n === 1 ? word : `${n} ${word}s`);
		let entryId: number;
		let said: string;
		if (steps) {
			const turn = turns.at(-1);
			if (turn === undefined) throw new CommandError("There is nothing to undo.");
			// A step is a response the model was given back: a request that failed or was cut off is not one.
			const responses = state.transcript.filter((entry) => entry.id > turn.userEntryId && isAssistantEntry(entry) && ["stop", "length", "toolUse"].includes(stopReason(entry) ?? ""));
			const target = responses.at(-count);
			if (target === undefined) {
				throw new CommandError(responses.length === 0 ? "The agent has taken no step in the last turn; /undo takes back your message." : `The last turn has ${responses.length} step${responses.length === 1 ? "" : "s"}; /undo takes back the whole turn.`);
			}
			entryId = target.id;
			said = `Took back the agent's last ${last(count, "step")}. \`/continue\` lets it go on from there, or send a message to steer it.`;
		} else {
			const target = turns.at(-count);
			if (target === undefined) throw new CommandError(turns.length === 0 ? "There is nothing to undo." : `There ${turns.length === 1 ? "is 1 turn" : `are ${turns.length} turns`} to undo.`);
			entryId = target.userEntryId;
			said = `Took back your last ${last(count, "message")} and what the agent did for ${count === 1 ? "it" : "them"}.`;
		}
		try {
			const fork = await this.#bridge.store.rewind({ threadId, expectedHead: head, entryId, requestId: `undo:${messageId}`, ...(steps ? { step: true as const } : {}) });
			// A head that moved meanwhile is left alone, and the fork became a thread of its own (`Threads.rewind`).
			if ((await this.#bridge.store.thread(threadId))?.head !== fork) throw new CommandError("The thread changed while it was being undone; what was asked for is a new thread beside it.");
			await state.shows(fork);
		} catch (error) {
			if (error instanceof HostError && error.code === "not_rewindable") throw new CommandError("That is before a compaction, which cannot be undone past.");
			if (error instanceof HostError && error.code === "turn_running") throw new CommandError("Stop the current turn before undoing.");
			throw error;
		}
		this.#bridge.log.info("undid", { threadId, steps, count });
		this.show(threadId, state, { messageId, command: `/undo${argument === "" ? "" : ` ${argument}`}`, answer: `${said} \`/redo\` brings it back, until something new is written.\n\nFiles and anything done outside the conversation are as they were left. Shown here only: not sent to the model, not saved.` });
	}

	/**
	 * `/continue`: a run on the context as it is (`Threads.continue`): after a stop, a failed run or an undone step the
	 * agent goes on without a message written to say so. The typed command is shown where it was sent and the run it
	 * continues is the same run to T3, running again. `resumed`: T3's Resume, which names the run it continues and is
	 * refused as T3 refuses it when that is no longer the thread's last run, stopped or failed.
	 */
	async continue(threadId: string, requestId: string, head: number, by: { readonly messageId: string } | { readonly resumed: { readonly state: ThreadView; readonly runId: string } }): Promise<void> {
		if ("resumed" in by) {
			const { projection } = await by.resumed.state.projection(30_000);
			const latest = projection.runs.findLast((run) => run.status !== "queued" && run.status !== "rolled_back");
			if (latest?.id !== by.resumed.runId || (latest.status !== "interrupted" && latest.status !== "failed")) throw new CommandError("This thread can no longer be resumed from that run.");
		}
		try {
			await this.#bridge.store.continue({ threadId, conversationId: head, requestId, ...("messageId" in by ? { messageId: by.messageId } : {}) });
		} catch (error) {
			if (error instanceof HostError && error.code === "turn_running") throw new CommandError("The agent is working already.");
			if (error instanceof HostError && error.code === "nothing_to_continue") {
				throw new CommandError(error.message === "nothing was asked yet" ? "There is nothing to continue: send a message first." : "There is nothing to continue: the conversation ends with the agent's answer. Send a message to go on.");
			}
			throw error;
		}
		// Continued by hand: a limit that was waited for is waited for no longer.
		if (this.#bridge.thread(threadId)?.limitRecovery !== undefined) await this.#bridge.store.updateRecord(threadId, (record) => void delete record.limitRecovery);
		this.#bridge.log.info("continued", { threadId });
	}

	/** `/redo`: take the last undo back (`Threads.redo`), T3's Revert included. */
	async redo(threadId: string, messageId: string, state: ThreadView, head: number): Promise<void> {
		const { projection } = await state.projection(30_000);
		if (projection.runs.some((run) => run.status === "running")) throw new CommandError("Stop the current turn before redoing.");
		try {
			await state.shows(await this.#bridge.store.redo({ threadId, expectedHead: head }));
		} catch (error) {
			if (error instanceof HostError && error.code === "nothing_to_redo") throw new CommandError(error.message === "the thread has gone on since the undo" ? "The thread has gone on since the undo, so it cannot be taken back here. /redo fork opens what the undo took as a new thread." : "There is no undo to take back.");
			if (error instanceof HostError && error.code === "turn_running") throw new CommandError("Send or remove the queued messages before redoing.");
			throw error;
		}
		this.#bridge.log.info("redid", { threadId });
		this.show(threadId, state, { messageId, command: "/redo", answer: `Brought back what the last undo took. Shown here only: not sent to the model, not saved.` });
	}

	/**
	 * `/redo fork`: what the last undo took, opened as a new thread (`Threads.forkUndone`). This thread stays as it
	 * is, so it works when the thread has gone on since the undo and `/redo` is refused.
	 */
	async redoFork(threadId: string, messageId: string, state: ThreadView, head: number): Promise<void> {
		let fork: Awaited<ReturnType<Core["store"]["forkUndone"]>>;
		try {
			fork = await this.#bridge.store.forkUndone({ threadId, expectedHead: head, targetThreadId: randomUUID() });
		} catch (error) {
			if (error instanceof HostError && error.code === "nothing_to_redo") throw new CommandError("There is no undo to take back.");
			throw error;
		}
		this.#bridge.log.info("forked what an undo took", { threadId, fork: fork.threadId });
		this.show(threadId, state, { messageId, command: "/redo fork", answer: `Opened what the last undo took as a new thread: "${fork.title}". This thread is as it was. Shown here only: not sent to the model, not saved.` });
	}
}
