// T3's idle compaction, "Before the cache expires" (IdleCompaction.ts, IdleCompactionService.ts): a thread left alone
// with a large context is compacted shortly before the provider drops its prompt cache, while the summary can still
// read the conversation from it. After that the same summary pays for every token, and so does the next message.
import { isListedThreadLineage, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** T3's floor (Claude Code's default): below it a cold re-read is cheap, and compacting mostly loses context. */
export const IDLE_COMPACTION_MIN_TOKENS = 200_000;
/** Start this long before the cache expires: time for the summary request to arrive while the cache is warm. */
export const IDLE_COMPACTION_LEAD_MS = 2 * 60_000;

/** What decides it besides the projection: the thread's record, and what the bridge knows is still coming to it. */
type IdleThread = {
	/** A fork's conversation waits to be brought back with the next message (T3's pending merge-back). */
	readonly mergeBackPending: boolean;
	/** Children that still work report into the thread's next turn; a compaction would swallow their place. */
	readonly childrenWorking: boolean;
};

/** Why a thread is not compacted, for the log and the tests; `undefined` means it is. */
export type IdleCompactionWindow = { readonly runId: string; readonly startMs: number; readonly endMs: number } | { readonly skip: string };

/**
 * When an idle thread should be compacted, or why not (T3's `idleCompactionWindow`, for any provider that says how
 * long its prompt cache lives). The window ends when the cache of the run's last request expires.
 */
export function idleCompactionWindow(
	projection: OrchestrationV2ThreadProjection,
	thread: IdleThread,
	nowMs: number,
	limits: { readonly minTokens: number; readonly leadMs: number } = { minTokens: IDLE_COMPACTION_MIN_TOKENS, leadMs: IDLE_COMPACTION_LEAD_MS },
): IdleCompactionWindow {
	const shown = projection.thread;
	if (shown.deletedAt !== null || shown.archivedAt !== null) return { skip: "the thread is archived or deleted" };
	if (shown.settledAt !== null || shown.settledOverride === "settled") return { skip: "the thread is settled" };
	if (shown.snoozedUntil != null && DateTime.toEpochMillis(shown.snoozedUntil) > nowMs) return { skip: "the thread is snoozed" };
	if (!isListedThreadLineage(shown.lineage)) return { skip: "a side chat" };
	if (projection.runs.some((run) => run.status === "queued")) return { skip: "messages are queued" };
	// A removed or steered queued message leaves a cancelled run that never started.
	const latest = projection.runs.filter((run) => run.status !== "cancelled" || run.startedAt !== null).reduce<(typeof projection.runs)[number] | undefined>((newest, run) => (newest === undefined || run.ordinal > newest.ordinal ? run : newest), undefined);
	if (latest?.status !== "completed" || latest.completedAt === null) return { skip: "the latest run did not complete" };
	const message = projection.messages.find((candidate) => candidate.id === latest.userMessageId);
	// Never compact a compaction, so one idle spell compacts at most once.
	if (message === undefined || message.text.trim().toLowerCase().startsWith("/compact")) return { skip: "the latest run is a compaction" };
	if (projection.runtimeRequests.some((request) => request.status === "pending")) return { skip: "a request waits for an answer" };
	if (thread.mergeBackPending) return { skip: "a fork waits to be brought back" };
	if (thread.childrenWorking) return { skip: "child threads still work" };
	const usage = projection.providerTurns.findLast((turn) => turn.runAttemptId === latest.activeAttemptId)?.tokenUsage;
	if ((usage?.usedTokens ?? 0) < limits.minTokens) return { skip: `the context is under ${limits.minTokens} tokens` };
	// A request served wholly from the cache writes no entry and reports no lifetime: unknown, so left alone.
	const endMs = usage?.promptCacheExpiresAt === undefined ? Number.NaN : Date.parse(usage.promptCacheExpiresAt);
	if (!Number.isFinite(endMs)) return { skip: "the provider reported no cache lifetime" };
	if (nowMs >= endMs) return { skip: "the cache has expired" };
	return { runId: latest.id as string, startMs: endMs - limits.leadMs, endMs };
}
