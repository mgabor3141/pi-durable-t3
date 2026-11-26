// The messages the host posts into a thread about the threads it started: a child's report (`orchestration.ts`) and a
// child's question (`child-questions.ts`). The model reads them as text; a person sees T3's notice instead, as T3 shows
// a delegated task's completion and question (`notificationTurnItem`, `DelegatedTaskQuestionReactor.ts`): one row,
// "Delegated task "<title>" finished", that opens the child's card (`SubagentNotificationLink`), not a bubble of the
// text written for the model.
import type { OrchestrationV2Subagent, OrchestrationV2TurnItem } from "@t3tools/contracts";

/** One report in a report message: its header names the thread it is from, and the reports are separated by a blank
 * line before the next header. */
export const reportHeader = (title: string, child: string, verdict: string) => `[Report from thread "${title}" (${child}), ${verdict}]`;
const REPORT_HEADER = /^\[Report from thread "(.*)" \(([^()\s]+)\), (completed|failed|interrupted|active)\]$/m;
const REPORT_SPLIT = /\n\n(?=\[Report from thread ".*" \([^()\s]+\), (?:completed|failed|interrupted|active)\]\n)/;
/** A report message's reports, each from its header on. */
export const reportBlocks = (text: string): string[] => text.split(REPORT_SPLIT);
/** What a report's header says: the thread it is from, its title then, and how its work ended. */
const headerOf = (block: string): { readonly title: string; readonly child: string; readonly verdict: string } | undefined => {
	const match = REPORT_HEADER.exec(block.split("\n", 1)[0] ?? "");
	return match === null ? undefined : { title: match[1]!, child: match[2]!, verdict: match[3]! };
};
/** The thread a report is from, read from its header. */
export const reportChild = (block: string): string | undefined => headerOf(block)?.child;

/** The ids of the messages the host posts: reports (`orchestration.ts`) and questions (`child-questions.ts`). */
const REPORT_MESSAGE = /^n-/;
const QUESTION_MESSAGE = /^q-/;
/** A question message's opening: `Thread "<title>" (<child>) is blocked on a question …`. */
const QUESTION_TEXT = /^Thread (?:"(.*)" \(([^()\s]+)\)|(\S+)) is blocked on a question/;

type Outcome = "completed" | "failed" | "cancelled" | "updated" | "unknown";
const OUTCOME: Record<string, Outcome> = { completed: "completed", failed: "failed", interrupted: "cancelled", active: "unknown" };

/** T3's `reportLabel`: the first line, at most 80 characters, not cut inside a character. */
function label(text: string | null | undefined): string | undefined {
	const first = text?.trim().split("\n")[0]?.trim();
	if (first === undefined || first.length === 0) return undefined;
	if (first.length <= 80) return first;
	let end = 79;
	const previous = first.charCodeAt(end - 1);
	const next = first.charCodeAt(end);
	if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
	return `${first.slice(0, end)}…`;
}

/** T3's `combinedOutcome`: a failure first, then a stop; all completed is completed. */
function combined(outcomes: readonly Outcome[]): Outcome {
	if (outcomes.includes("failed")) return "failed";
	if (outcomes.includes("cancelled")) return "cancelled";
	if (outcomes.length > 0 && outcomes.every((outcome) => outcome === "completed")) return "completed";
	return outcomes.includes("updated") ? "updated" : "unknown";
}

/**
 * The thread's items as a person sees them (`noticeItem`). The child's card shows its newest result, so only the newest
 * notice of each child opens the card; an earlier one (a child prompted again since) is the notice's line alone, which
 * still names the child's thread, as T3 shows a notice whose task it no longer has (T3 has a task per follow-up).
 */
export function noticeItems(items: OrchestrationV2TurnItem[], subagents: readonly OrchestrationV2Subagent[]): void {
	const later = new Set<string>();
	for (let index = items.length - 1; index >= 0; index--) {
		const item = noticeItem(items[index]!, subagents);
		if (item.type === "notification" && item.source.kind === "delegated_task") {
			const source = item.source as { taskIds: readonly string[] };
			const kept = source.taskIds.filter((taskId) => !later.has(taskId));
			for (const taskId of source.taskIds) later.add(taskId);
			if (kept.length !== source.taskIds.length) (item as { source: unknown }).source = { ...item.source, taskIds: kept };
		}
		items[index] = item;
	}
}

/**
 * `item` as a person sees it: a report or question message the host posted becomes T3's notice row (T3's
 * `delegatedCompletionNotification` words), naming the child's card when the thread shows one (`subagents`), so the row
 * opens it. Any other item is itself.
 */
export function noticeItem(item: OrchestrationV2TurnItem, subagents: readonly OrchestrationV2Subagent[]): OrchestrationV2TurnItem {
	if (item.type !== "user_message") return item;
	const messageId = item.messageId as string;
	const card = (child: string) => subagents.find((subagent) => (subagent.childThreadId as string | null) === child);
	let notice: { source: { kind: "delegated_task"; taskIds: string[]; childThreadId?: string }; outcome: Outcome; summary: string } | undefined;
	if (REPORT_MESSAGE.test(messageId)) {
		const reports = reportBlocks(item.text).flatMap((block) => headerOf(block) ?? []);
		if (reports.length === 0) return item;
		const outcomes = reports.map((report) => OUTCOME[report.verdict] ?? "unknown");
		const outcome = combined(outcomes);
		const verb = outcome === "failed" ? "failed" : outcome === "cancelled" ? "stopped" : "finished";
		const taskIds = reports.flatMap((report) => (card(report.child)?.id as string | undefined) ?? []);
		const named = (report: (typeof reports)[number]) => label(card(report.child)?.title ?? report.title);
		if (reports.length === 1) {
			const name = named(reports[0]!);
			notice = { source: { kind: "delegated_task", taskIds, childThreadId: reports[0]!.child }, outcome, summary: `Delegated task${name === undefined ? "" : ` "${name}"`} ${verb}` };
		} else {
			const names = reports.flatMap((report) => named(report) ?? []);
			notice = { source: { kind: "delegated_task", taskIds }, outcome, summary: `${reports.length} delegated tasks ${verb}${names.length === 0 ? "" : `: ${names.join(", ")}`}` };
		}
	} else if (QUESTION_MESSAGE.test(messageId)) {
		const match = QUESTION_TEXT.exec(item.text);
		if (match === null) return item;
		const child = match[2] ?? match[3]!;
		const name = label(card(child)?.title ?? match[1]);
		const taskId = card(child)?.id as string | undefined;
		notice = { source: { kind: "delegated_task", taskIds: taskId === undefined ? [] : [taskId], childThreadId: child }, outcome: "updated", summary: `Delegated task${name === undefined ? "" : ` "${name}"`} has a question` };
	}
	if (notice === undefined) return item;
	// T3 keeps the row's own fields and drops the message's (`notificationTurnItem`).
	const { type: _type, messageId: _messageId, inputIntent: _intent, text: _text, attachments: _attachments, createdBy: _createdBy, creationSource: _creationSource, ...base } = item as typeof item & Record<string, unknown>;
	const { senderThreadId: _sender, scheduledTaskId: _scheduled, context: _context, modelSwitch: _switch, ...rest } = base as Record<string, unknown>;
	// The text the model read stays readable as the notice's detail (T3's item inspector, `t3_thread_read`).
	return { ...rest, type: "notification", ...notice, detail: item.text } as unknown as OrchestrationV2TurnItem;
}
