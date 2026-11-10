// Side chats and "Bring back": T3's hidden `lineage.sideChat` forks and `thread.merge_back`. What each carries to the
// model is built here, from projections, when the message that carries it is sent (`ThreadRecord.pendingContext`):
// - a side chat's first message gets T3's note (`makeSideChatContext`, ContextHandoffService.ts): it is a side chat,
//   not to continue the main thread's task, and the main thread's activity since the side chat's starting point;
// - the main thread's next message after "Bring back" gets the fork's own conversation, as T3's merge-back handoff
//   (`prepareForkDelta` with `selectHistory`, handoffBudget.ts): the last user and assistant messages and the first
//   user message first, then newest to oldest, within a cap.
// Both are stored with the message as a hidden block, shown as a row (`shownAs`), as an integrator's message context is.
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { MESSAGE_CONTEXT_ITEM } from "./projection.ts";

/** T3's `SIDE_CHAT_CONTEXT_MAX_CHARS`: the whole note, framing included. */
export const SIDE_CHAT_CONTEXT_MAX_CHARS = 8_000;
/** The merge-back context's cap, in characters (T3's `DEFAULT_HANDOFF_TOKEN_CAP`, which it measures in bytes). */
export const MERGE_BACK_MAX_CHARS = 16_000;

/** The rows that name what a hidden context block holds. */
export const SIDE_CHAT_ROW = "side_chat";
export const MERGE_BACK_ROW = "merge_back";

/** T3's `compactText`: whitespace folded, cut at `max` with an ellipsis. */
function compactText(text: string, max = 240): string {
	const compacted = text.replace(/\s+/g, " ").trim();
	if (compacted.length <= max) return compacted;
	const end = max - 3;
	const last = compacted.charCodeAt(end - 1);
	return `${compacted.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}...`;
}

/** T3's `summarizeDeltaItem`, plus a line for a tool row (here, mostly codemode scripts, which T3 has as commands). A
 * message's context row (`shownAs`) is what was injected, not activity. */
function digestLine(item: OrchestrationV2TurnItem): string | null {
	const any = item as OrchestrationV2TurnItem & { text?: string; input?: unknown; title?: string };
	switch (item.type) {
		case "user_message":
			return `- User: ${compactText(any.text ?? "")}`;
		case "assistant_message":
			return `- Assistant: ${compactText(any.text ?? "")}`;
		case "command_execution":
			return `- Command: ${compactText(typeof any.input === "string" ? any.input : "")}`;
		case "dynamic_tool":
			return (item.id as string).startsWith(MESSAGE_CONTEXT_ITEM) ? null : `- Tool: ${compactText(any.title ?? "")}`;
		default:
			return null;
	}
}

/** A fork's own runs: those after the run it forked from (T3: a fork's runs are its own). A side chat's projection
 * already shows only its own; a run that is not found leaves all of them. */
export function ownRuns(projection: Pick<OrchestrationV2ThreadProjection, "runs">, forkedFromRunId: string | undefined): readonly OrchestrationV2Run[] {
	const index = forkedFromRunId === undefined ? -1 : projection.runs.findIndex((run) => (run.id as string) === forkedFromRunId);
	return projection.runs.slice(index + 1);
}

/** Items of the runs named, in order. */
function itemsOf(projection: Pick<OrchestrationV2ThreadProjection, "turnItems">, runs: readonly OrchestrationV2Run[]): OrchestrationV2TurnItem[] {
	const ids = new Set(runs.map((run) => run.id as string));
	return projection.turnItems.filter((item) => item.runId !== null && ids.has(item.runId as string));
}

/**
 * T3's `makeSideChatContext`: what a side chat's first message tells the model. `parent` is the main thread's
 * projection now; `forkedFromRunId` the run the side chat forked at (none: the main thread had no finished turn, and the
 * digest is all of it). Queued messages have not reached the main thread, so they are left out. Oldest first; when the
 * cap is reached the oldest lines go.
 */
export function sideChatNote(parentThreadId: string, parent: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">, forkedFromRunId: string | undefined): string {
	const runs = ownRuns(parent, forkedFromRunId).filter((run) => run.status !== "queued");
	const digest = itemsOf(parent, runs);
	const framing =
		"You are in a side chat beside the main thread. The main thread may still be running in the same workspace. Answer the user's questions; do not continue or redo the main thread's task.";
	const header = "Main thread activity since this side chat's starting point:";
	const truncated = "- Earlier items truncated.";
	const footer = `Use thread_read on thread ${parentThreadId} to see the main thread's live state.`;
	const kept: string[] = [];
	let omitted = false;
	let remaining = SIDE_CHAT_CONTEXT_MAX_CHARS - [framing, "", header, truncated, "", footer].join("\n").length;
	for (let index = digest.length - 1; index >= 0; index--) {
		const line = digestLine(digest[index]!);
		if (line === null) continue;
		if (line.length + 1 > remaining) {
			omitted = true;
			break;
		}
		kept.unshift(line);
		remaining -= line.length + 1;
	}
	return [framing, ...(kept.length === 0 ? [] : ["", header, ...(omitted ? [truncated] : []), ...kept]), "", footer].join("\n");
}

/**
 * T3's merge-back handoff: the fork's own conversation through `runId`, its user and assistant messages, for the main
 * thread's next message. Selected as T3's `selectHistory` does (the last user message, the last assistant message and
 * the first user message, then newest to oldest while they fit), shown in order; one that does not fit whole is cut
 * rather than left out, so the answer that was brought back always arrives.
 */
export function mergeBackContext(
	source: { readonly threadId: string; readonly title: string; readonly sideChat: boolean },
	projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
	forkedFromRunId: string | undefined,
	runId: string,
): string {
	const runs = ownRuns(projection, forkedFromRunId);
	const through = runs.findIndex((run) => (run.id as string) === runId);
	const messages = itemsOf(projection, runs.slice(0, through + 1)).flatMap((item) => {
		const text = (item as { text?: string }).text ?? "";
		return (item.type === "user_message" || item.type === "assistant_message") && text.trim() !== "" ? [{ role: item.type === "user_message" ? "User" : "Assistant", text }] : [];
	});
	const kind = source.sideChat ? "side chat" : "fork";
	const header = `Context brought back from the ${kind} "${source.title}" (${source.threadId}) of this thread: its conversation since it started from here. It is context, not a new request.`;
	const omittedNote = (count: number) => `[${count} earlier message${count === 1 ? "" : "s"} left out; read them with thread_read on thread ${source.threadId}.]`;
	const render = (message: { role: string; text: string }) => `[${message.role}]\n${message.text}`;
	const selected = new Map<number, string>();
	let remaining = MERGE_BACK_MAX_CHARS - header.length - omittedNote(messages.length).length - 4;
	const take = (index: number) => {
		const message = messages[index];
		if (message === undefined || selected.has(index) || remaining <= 0) return;
		let rendered = render(message);
		if (rendered.length + 2 > remaining) {
			if (selected.size > 0 && index !== messages.length - 1) return;
			const cut = "\n[…cut]";
			rendered = rendered.slice(0, Math.max(0, remaining - 2 - cut.length)) + cut;
		}
		selected.set(index, rendered);
		remaining -= rendered.length + 2;
	};
	take(messages.findLastIndex((message) => message.role === "User"));
	take(messages.findLastIndex((message) => message.role === "Assistant"));
	take(messages.findIndex((message) => message.role === "User"));
	for (let index = messages.length - 1; index >= 0; index--) take(index);
	const omitted = messages.length - selected.size;
	const body = [...selected.entries()].toSorted(([left], [right]) => left - right).map(([, text]) => text);
	return [header, ...(omitted > 0 ? [omittedNote(omitted)] : []), ...(body.length === 0 ? ["[No messages yet.]"] : body)].join("\n\n");
}
