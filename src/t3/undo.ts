// Undo: the checkpoint id scheme, the map from a T3 checkpoint to the pi entry to fork at, and the overlay that lets a
// client confirm the revert it asked for.
//
// A checkpoint is `cp-baseline` (keeps nothing, exists for every thread) or `cp<userEntryId>` (keeps the run that user
// entry started and every run before it). The projection writes those ids and `undoTarget` reads them back, so the
// scheme is owned here. The entry arithmetic belongs to the threads layer: a pi-durable fork is inclusive of its fork
// entry, so a rewind forks at the entry just before the reverted user turn, dropping that message with its reply.
// Undo never rewrites history — it moves the head to a fork.
import type {
	OrchestrationV2CheckpointScope,
	OrchestrationV2ConversationMessage,
	OrchestrationV2ExecutionNode,
	OrchestrationV2ProviderTurn,
	OrchestrationV2Run,
	OrchestrationV2RunAttempt,
	OrchestrationV2ThreadProjection,
	OrchestrationV2TurnItem,
} from "@t3tools/contracts";

/** The checkpoint that keeps nothing. Every thread has one, before its first turn. */
export const BASELINE_CHECKPOINT_ID = "cp-baseline";

/** A run removed by a rewind, with every row that references it: T3 reads a reverted run by its rows, so they all carry
 * the `rolled_back` status, not just the run. */
export interface RolledBackRun {
	readonly run: OrchestrationV2Run;
	readonly items: readonly OrchestrationV2TurnItem[];
	readonly messages: readonly OrchestrationV2ConversationMessage[];
	readonly nodes: readonly OrchestrationV2ExecutionNode[];
	readonly attempts: readonly OrchestrationV2RunAttempt[];
	readonly providerTurns: readonly OrchestrationV2ProviderTurn[];
	readonly checkpointScopes: readonly OrchestrationV2CheckpointScope[];
}

/** Snapshot the runs after `keepOrdinal` as rolled back, for the rewind confirmation. */
export function rolledBackRuns(projection: OrchestrationV2ThreadProjection, keepOrdinal: number): RolledBackRun[] {
	return projection.runs
		.filter((run) => run.status !== "rolled_back" && run.ordinal > keepOrdinal)
		.map((run) => ({
			run: { ...run, status: "rolled_back" as const, checkpointId: null },
			items: projection.turnItems.filter((item) => item.runId === run.id),
			messages: projection.messages.filter((message) => message.runId === run.id),
			nodes: projection.nodes
				.filter((node) => node.runId === run.id)
				.map((node) => ({ ...node, status: "rolled_back" as const })),
			attempts: projection.attempts.filter((attempt) => attempt.runId === run.id),
			providerTurns: projection.providerTurns.filter((turn) => turn.runAttemptId === run.activeAttemptId),
			checkpointScopes: projection.checkpointScopes.filter((scope) => scope.runId === run.id),
		}));
}

/** At most this many rolled-back runs are kept per thread (oldest dropped). */
export const MAX_ROLLED_BACK_RUNS = 200;

/**
 * Map a T3 rollback to the pi rewind target. `entryId` is the **user turn being reverted** — the entry whose whole run
 * (message and reply) disappears. `keepOrdinal` is the number of runs the checkpoint retains (for the rolled-back
 * overlay). `Threads.rewind` does the entry arithmetic: because a pi-durable fork is inclusive of its fork entry, it
 * forks at the entry just before `entryId` (dropping the reverted user message too), or — when `entryId` is the very
 * first entry and nothing precedes it — creates a fresh conversation carrying the head's agent config.
 * - Baseline keeps nothing: revert the first run's user entry → an empty conversation.
 * - `cp<userEntryId>` (run N) keeps runs 1..N: revert run N+1's user entry; if run N+1 does not exist, the checkpoint
 *   already keeps every run, so there is nothing to revert.
 */
export function undoTarget(
	runs: readonly { ordinal: number; userEntryId: number }[],
	checkpointId: string,
): { entryId: number; keepOrdinal: number } | { nothing: true } | { unknown: true } {
	if (checkpointId === BASELINE_CHECKPOINT_ID) {
		const first = runs[0];
		if (first === undefined) return { nothing: true };
		return { entryId: first.userEntryId, keepOrdinal: 0 };
	}
	const index = runs.findIndex((run) => `cp${run.userEntryId}` === checkpointId);
	if (index < 0) return { unknown: true };
	const next = runs[index + 1];
	if (next === undefined) return { nothing: true };
	return { entryId: next.userEntryId, keepOrdinal: runs[index]!.ordinal };
}
