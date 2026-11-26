// The exchange report (gmux's): what one activity of a thread did, as text an agent reads. An activity is the runs from
// the one a message started or joined through the thread's latest, while the thread stays busy: follow-ups and steers
// merge into it, and it settles once for everybody. The report lists every message that entered it (the reader's own as
// [YOU]), how much tool work it took, and the final answer, in the order they happened: a note placed after the answer
// is listed after it. The verdict is beside the report, never inside the prose.
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { isMessageContextItem } from "./projection.ts";

/** How an activity ended: `active` when it has not (a wait that timed out, or a read of running work). */
export type Verdict = "completed" | "interrupted" | "failed" | "active";

/** The worst first: a set of reports carries the worst verdict among them. */
const VERDICT_RANK: Record<Verdict, number> = { completed: 0, interrupted: 1, active: 2, failed: 3 };
export const worstVerdict = (verdicts: readonly Verdict[]): Verdict => verdicts.reduce<Verdict>((worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst), "completed");

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const TOOL_ITEMS = new Set(["command_execution", "dynamic_tool", "subagent", "secret_request"]);
/** What one report may print of the final answer before it is cut; the rest is read with `thread_read`. */
const REPORT_BUDGET = 16_000;
const MESSAGE_BUDGET = 2_000;
const OWN_PROMPT_CHARS = 120;

export const isActiveRun = (run: OrchestrationV2Run) => ACTIVE_RUN.has(run.status);
/**
 * Does `threadId` wait for the report of a child it started? A child's report wakes it and its work goes on, so until
 * then it has not settled. Only its own children count: a thread may ask any other for a report, and two that asked each
 * other would each wait for the other.
 */
export const awaitsChildren = (threads: readonly { readonly threadId: string; readonly spawn?: unknown; readonly lineage: { readonly parentThreadId?: string | null }; readonly notify?: readonly { readonly threadId: string }[] }[], threadId: string): boolean =>
	threads.some((thread) => thread.spawn !== undefined && thread.lineage.parentThreadId === threadId && (thread.notify ?? []).some((request) => request.threadId === threadId));
/** Whether a shell's thread is working: it has an active or queued run, or activity of its own. */
export const isActiveShell = (shell: OrchestrationV2ThreadShell) => shell.activityRunStatus != null || ACTIVE_RUN.has(shell.status);
/**
 * Is `run` still the thread's work? A run that a provider's limit ended and that the host continues when the limit
 * resets (T3's limit recovery with `autoResume`) is: whoever waits for the thread waits for that, and is not told it
 * failed.
 */
export const isActiveIn = (projection: Pick<OrchestrationV2ThreadProjection, "thread">) => {
	const recovery = (projection.thread as { limitRecovery?: { runId: string; autoResume: boolean } | null }).limitRecovery;
	return (run: OrchestrationV2Run): boolean => isActiveRun(run) || (run.status === "failed" && recovery?.autoResume === true && recovery.runId === (run.id as string));
};
/** @internal */
const byOrdinal = (runs: readonly OrchestrationV2Run[]) => runs.toSorted((left, right) => left.ordinal - right.ordinal);

/** Is the thread doing anything (a live or queued run)? */
export const isBusy = (projection: OrchestrationV2ThreadProjection) => projection.runs.some(isActiveIn(projection));
/** Does the thread have a running turn that a message of the host's own is steered into? T3 steers a notice into the
 * turn that works (pi steers without interrupting tools), and never into a compaction. */
export function takesSteer(projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">): boolean {
	const active = projection.runs.find((run) => run.status === "running");
	return active !== undefined && !(projection.messages.find((message) => message.id === active.userMessageId)?.text ?? "").startsWith("/compact");
}

const verdictOf = (run: OrchestrationV2Run, projection: OrchestrationV2ThreadProjection): Verdict =>
	isActiveIn(projection)(run) ? "active" : run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "interrupted";

export interface Report {
	readonly threadId: string;
	readonly title: string;
	/** The run the activity started with, or `null` when the thread has none. */
	readonly runId: string | null;
	readonly verdict: Verdict;
	readonly toolCalls: number;
	readonly text: string;
	/** The final answer was cut at the budget; `thread_read` has all of it. */
	readonly truncated: boolean;
	/** The questions the thread waits on that are the reader's to answer, which ended its wait (`child-questions.ts`). */
	readonly pendingRequestIds?: readonly string[];
}

const clip = (text: string, max: number): { text: string; cut: boolean } => (text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max)}…`, cut: true });

/**
 * The report of the activity that `fromRunId` starts (the thread's latest run when absent). `reader`: the thread reading
 * it, whose messages are its own ([YOU]). `own`: the message the reader just sent, printed abbreviated. `label`: how to
 * name another sending thread.
 */
export function report(
	projection: OrchestrationV2ThreadProjection,
	options: { readonly fromRunId?: string | null; readonly reader?: string; readonly own?: string; readonly label?: (threadId: string) => string; readonly budget?: number; readonly awaitsChildren?: boolean } = {},
): Report {
	const threadId = projection.thread.id as string;
	const title = projection.thread.title;
	const runs = byOrdinal(projection.runs.filter((run) => run.status !== "rolled_back"));
	const start = options.fromRunId == null ? runs.at(-1) : runs.find((run) => run.id === options.fromRunId);
	if (start === undefined) return { threadId, title, runId: null, verdict: "completed", toolCalls: 0, text: "[No exchanges yet]", truncated: false };
	const activity = runs.filter((run) => run.ordinal >= start.ordinal);
	const ids = new Set(activity.map((run) => run.id as string));
	const last = activity.at(-1)!;
	// A thread that waits for reports of children it started has not finished: they wake it, and it goes on (T3's
	// `waiting_for_children`).
	const verdict = options.awaitsChildren === true ? "active" : verdictOf(last, projection);
	const inActivity = (message: (typeof projection.messages)[number]) => message.runId !== null && ids.has(message.runId as string);
	const answer = projection.messages.filter((message) => message.role === "assistant" && inActivity(message) && message.text.trim() !== "").at(-1);
	// The projection lists messages in the order they happened: one after the answer (a note) is listed after it.
	const answerIndex = answer === undefined ? -1 : projection.messages.indexOf(answer);
	const lines: string[] = [];
	const late: string[] = [];
	for (const [index, message] of projection.messages.entries()) {
		if (message.role !== "user" || !inActivity(message)) continue;
		const sender = message.senderThreadId === undefined ? undefined : (message.senderThreadId as string);
		// The message the reader sent, abbreviated: not one a person sent the thread, which the reader is told of whole.
		const just = options.own !== undefined && (message.id as string) === options.own && (options.reader === undefined || sender === options.reader);
		const who = just || (sender !== undefined && sender === options.reader) ? "YOU" : sender !== undefined ? `THREAD ${options.label?.(sender) ?? sender}` : message.createdBy === "user" ? "USER" : "AGENT MESSAGE";
		(answerIndex >= 0 && index > answerIndex ? late : lines).push(`[${who}]: ${clip(message.text.trim(), just ? OWN_PROMPT_CHARS : MESSAGE_BUDGET).text}`);
	}
	const toolCalls = projection.turnItems.filter((item) => item.runId !== null && ids.has(item.runId as string) && TOOL_ITEMS.has(item.type) && !isMessageContextItem(item)).length;
	if (toolCalls > 0) lines.push(verdict === "active" ? `[Agent working: ${toolCalls} tool calls so far]` : `[Agent made ${toolCalls} tool calls]`);
	let truncated = false;
	if (answer !== undefined && (verdict !== "active" || answer.runId === last.id)) {
		const cut = clip(answer.text.trim(), options.budget ?? REPORT_BUDGET);
		truncated = cut.cut;
		lines.push(`[${verdict === "active" ? "AGENT, so far" : truncated ? "AGENT, truncated" : "AGENT"}]: ${cut.text}`);
		if (truncated) lines.push("[The answer was cut; read it whole with thread_read]");
	}
	if (verdict === "interrupted") lines.push("[Agent interrupted]");
	if (verdict === "failed") {
		const error = projection.turnItems.filter((item) => item.runId === last.id && item.type === "error").at(-1) as { failure?: { message?: string } } | undefined;
		lines.push(`[Agent failed${error?.failure?.message === undefined ? "" : `: ${error.failure.message}`}]`);
	}
	lines.push(...late);
	return { threadId, title, runId: start.id as string, verdict, toolCalls, text: lines.join("\n"), truncated };
}

/** The run a message started or joined, once the thread shows it. */
function runOfMessage(projection: OrchestrationV2ThreadProjection, messageId: string): string | undefined {
	const message = projection.messages.find((candidate) => (candidate.id as string) === messageId);
	return message?.runId == null ? undefined : (message.runId as string);
}

/** The report of the activity a message started, once it settled (`undefined` until then): the thread is idle and waits
 * for no report of a child it started (`awaitsChildren`). */
export function settledReport(projection: OrchestrationV2ThreadProjection, messageId: string, options: Parameters<typeof report>[1] = {}): Report | undefined {
	const runId = runOfMessage(projection, messageId);
	if (runId === undefined || isBusy(projection) || options.awaitsChildren === true) return undefined;
	return report(projection, { ...options, fromRunId: runId });
}

/** The last `count` exchanges (runs) before the run with ordinal `before`, oldest first, each as its own report. */
export function exchanges(
	projection: OrchestrationV2ThreadProjection,
	options: { readonly count: number; readonly before?: number; readonly reader?: string; readonly label?: (threadId: string) => string; readonly budget?: number },
): { readonly reports: readonly (Report & { readonly ordinal: number })[]; readonly earlier: number } {
	const runs = byOrdinal(projection.runs.filter((run) => run.status !== "rolled_back" && (options.before === undefined || run.ordinal < options.before)));
	const chosen = runs.slice(Math.max(0, runs.length - options.count));
	const single = (run: OrchestrationV2Run) => {
		// One run alone: the projection narrowed to it, so the report covers this exchange and not those after it.
		const only: OrchestrationV2ThreadProjection = { ...projection, runs: [run] };
		const { count: _count, before: _before, ...rest } = options;
		return { ...report(only, { fromRunId: run.id as string, ...rest }), ordinal: run.ordinal };
	};
	return { reports: chosen.map(single), earlier: runs.length - chosen.length };
}
