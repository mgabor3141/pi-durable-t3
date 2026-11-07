// The exchange report (gmux's): what one activity of a thread did, as text an agent reads. An activity is the runs from
// the one a message started or joined through the thread's latest, while the thread stays busy: follow-ups and steers
// merge into it, and it settles once for everybody. The report lists every message that entered it (the reader's own
// abbreviated), how much tool work it took, and the final answer; the verdict is beside it, never inside the prose.
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** How an activity ended: `active` when it has not (a wait that timed out, or a read of running work). */
export type Verdict = "completed" | "interrupted" | "failed" | "active";

/** The worst first: a set of reports carries the worst verdict among them. */
const VERDICT_RANK: Record<Verdict, number> = { completed: 0, interrupted: 1, active: 2, failed: 3 };
export const worstVerdict = (verdicts: readonly Verdict[]): Verdict => verdicts.reduce<Verdict>((worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst), "completed");

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const TOOL_ITEMS = new Set(["command_execution", "dynamic_tool", "subagent", "secret_request"]);
/** What one report may print of the final answer before it is cut; the rest is read with `thread_read`. */
export const REPORT_BUDGET = 16_000;
const MESSAGE_BUDGET = 2_000;
const OWN_PROMPT_CHARS = 120;

export const isActiveRun = (run: OrchestrationV2Run) => ACTIVE_RUN.has(run.status);
export const byOrdinal = (runs: readonly OrchestrationV2Run[]) => runs.toSorted((left, right) => left.ordinal - right.ordinal);

/** Is the thread doing anything (a live or queued run)? */
export const isBusy = (projection: OrchestrationV2ThreadProjection) => projection.runs.some(isActiveRun);

const verdictOf = (run: OrchestrationV2Run): Verdict =>
	isActiveRun(run) ? "active" : run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "interrupted";

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
}

const clip = (text: string, max: number): { text: string; cut: boolean } => (text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max)}…`, cut: true });

/**
 * The report of the activity that `fromRunId` starts (the thread's latest run when absent). `own`: the message id the
 * reader sent, printed abbreviated. `labels`: how to name a sending thread.
 */
export function report(
	projection: OrchestrationV2ThreadProjection,
	options: { readonly fromRunId?: string | null; readonly own?: string; readonly label?: (threadId: string) => string; readonly budget?: number } = {},
): Report {
	const threadId = projection.thread.id as string;
	const title = projection.thread.title;
	const runs = byOrdinal(projection.runs.filter((run) => run.status !== "rolled_back"));
	const start = options.fromRunId == null ? runs.at(-1) : runs.find((run) => run.id === options.fromRunId);
	if (start === undefined) return { threadId, title, runId: null, verdict: "completed", toolCalls: 0, text: "[No exchanges yet]", truncated: false };
	const activity = runs.filter((run) => run.ordinal >= start.ordinal);
	const ids = new Set(activity.map((run) => run.id as string));
	const last = activity.at(-1)!;
	const lines: string[] = [];
	for (const message of projection.messages) {
		if (message.role !== "user" || message.runId === null || !ids.has(message.runId as string)) continue;
		if (options.own !== undefined && (message.id as string) === options.own) {
			lines.push(`[YOU]: ${clip(message.text.trim(), OWN_PROMPT_CHARS).text}`);
			continue;
		}
		const sender = message.senderThreadId === undefined ? undefined : (message.senderThreadId as string);
		const who = sender !== undefined ? `THREAD ${options.label?.(sender) ?? sender}` : message.createdBy === "user" ? "USER" : "AGENT MESSAGE";
		lines.push(`[${who}]: ${clip(message.text.trim(), MESSAGE_BUDGET).text}`);
	}
	const toolCalls = projection.turnItems.filter((item) => item.runId !== null && ids.has(item.runId as string) && TOOL_ITEMS.has(item.type)).length;
	const verdict = verdictOf(last);
	if (toolCalls > 0) lines.push(verdict === "active" ? `[Agent working: ${toolCalls} tool calls so far]` : `[Agent made ${toolCalls} tool calls]`);
	const answer = projection.messages.filter((message) => message.role === "assistant" && message.runId !== null && ids.has(message.runId as string) && message.text.trim() !== "").at(-1);
	let truncated = false;
	if (answer !== undefined && (verdict !== "active" || answer.runId === last.id)) {
		const cut = clip(answer.text.trim(), options.budget ?? REPORT_BUDGET);
		truncated = cut.cut;
		lines.push(`[${verdict === "active" ? "AGENT, so far" : truncated ? "AGENT, truncated" : "AGENT"}]: ${cut.text}`);
		if (truncated) lines.push("[The answer was cut; read it whole with thread_read]");
	}
	if (verdict === "interrupted") lines.push("[Agent interrupted]");
	if (verdict === "failed") {
		const error = projection.turnItems.filter((item) => item.runId === last.id && item.type === "error").at(-1) as { message?: string } | undefined;
		lines.push(`[Agent failed${error?.message === undefined ? "" : `: ${error.message}`}]`);
	}
	return { threadId, title, runId: start.id as string, verdict, toolCalls, text: lines.join("\n"), truncated };
}

/** The run a message started or joined, once the thread shows it. */
export function runOfMessage(projection: OrchestrationV2ThreadProjection, messageId: string): string | undefined {
	const message = projection.messages.find((candidate) => (candidate.id as string) === messageId);
	return message?.runId == null ? undefined : (message.runId as string);
}

/** The report of the activity a message started, once it settled (`undefined` until then). */
export function settledReport(projection: OrchestrationV2ThreadProjection, messageId: string, options: Parameters<typeof report>[1] = {}): Report | undefined {
	const runId = runOfMessage(projection, messageId);
	if (runId === undefined || isBusy(projection)) return undefined;
	return report(projection, { ...options, fromRunId: runId });
}

/** The last `count` exchanges (runs) before the run with ordinal `before`, oldest first, each as its own report. */
export function exchanges(
	projection: OrchestrationV2ThreadProjection,
	options: { readonly count: number; readonly before?: number; readonly label?: (threadId: string) => string; readonly budget?: number },
): { readonly reports: readonly (Report & { readonly ordinal: number })[]; readonly earlier: number } {
	const runs = byOrdinal(projection.runs.filter((run) => run.status !== "rolled_back" && (options.before === undefined || run.ordinal < options.before)));
	const chosen = runs.slice(Math.max(0, runs.length - options.count));
	const single = (run: OrchestrationV2Run) => {
		// One run alone: the projection narrowed to it, so the report covers this exchange and not those after it.
		const only: OrchestrationV2ThreadProjection = { ...projection, runs: [run] };
		return { ...report(only, { fromRunId: run.id as string, ...(options.label === undefined ? {} : { label: options.label }), ...(options.budget === undefined ? {} : { budget: options.budget }) }), ordinal: run.ordinal };
	};
	return { reports: chosen.map(single), earlier: runs.length - chosen.length };
}
