// Undo: the checkpoint id scheme (`cp-baseline`, `cp<userEntryId>`) owned here, the map from a T3 checkpoint to the pi
// entry to fork at, and the rolled-back overlay. The entry arithmetic belongs to the threads layer, and undo never
// rewrites history — it moves the head to a fork (design.md, Invariants).
import type {
	OrchestrationV2Checkpoint,
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
 * the `rolled_back` status. */
export interface RolledBackRun {
	readonly run: OrchestrationV2Run;
	readonly items: readonly OrchestrationV2TurnItem[];
	readonly messages: readonly OrchestrationV2ConversationMessage[];
	readonly nodes: readonly OrchestrationV2ExecutionNode[];
	readonly attempts: readonly OrchestrationV2RunAttempt[];
	readonly providerTurns: readonly OrchestrationV2ProviderTurn[];
	readonly checkpointScopes: readonly OrchestrationV2CheckpointScope[];
	/** The run's checkpoints, `stale`: T3 keeps a reverted run's checkpoints and marks them so (`CheckpointRollbackService`),
	 * so a rollback reaches a client as record updates, never as a record that went away. */
	readonly checkpoints: readonly OrchestrationV2Checkpoint[];
}

/** A projection's runs, with every row that references them, marked rolled back. */
export function rolledBackRuns(projection: OrchestrationV2ThreadProjection): RolledBackRun[] {
	return projection.runs
		.filter((run) => run.status !== "rolled_back")
		.map((run) => ({
			run: { ...run, status: "rolled_back" as const },
			items: projection.turnItems.filter((item) => item.runId === run.id),
			messages: projection.messages.filter((message) => message.runId === run.id),
			nodes: projection.nodes
				.filter((node) => node.runId === run.id)
				.map((node) => ({ ...node, status: "rolled_back" as const })),
			attempts: projection.attempts.filter((attempt) => attempt.runId === run.id),
			providerTurns: projection.providerTurns.filter((turn) => turn.runAttemptId === run.activeAttemptId),
			checkpointScopes: projection.checkpointScopes.filter((scope) => scope.runId === run.id),
			checkpoints: projection.checkpoints.filter((checkpoint) => checkpoint.runId === run.id).map((checkpoint) => ({ ...checkpoint, status: "stale" as const })),
		}));
}

/**
 * The heads a thread's undos left behind on the way to `head`, newest first: `head` came from one, which came from
 * another, back to the first undo the record still holds. Their runs that `head` no longer has are its rolled-back runs.
 */
export function undoneHeads(undos: readonly { readonly head: number; readonly from: number }[], head: number): number[] {
	const chain: number[] = [];
	for (let current = head; ; ) {
		const undo = undos.findLast((candidate) => candidate.head === current);
		if (undo === undefined || undo.from === head || chain.includes(undo.from)) return chain;
		chain.push(undo.from);
		current = undo.from;
	}
}

/**
 * Map a T3 rollback to the pi rewind target: `entryId` is the **user turn being reverted**. Baseline reverts the first run's user entry; `cp<userEntryId>`
 * (run N) reverts run N+1's user entry, and a checkpoint that already keeps every run has nothing to revert.
 */
export function undoTarget(
	runs: readonly { ordinal: number; userEntryId: number }[],
	checkpointId: string,
): { entryId: number } | { nothing: true } | { unknown: true } {
	if (checkpointId === BASELINE_CHECKPOINT_ID) {
		const first = runs[0];
		if (first === undefined) return { nothing: true };
		return { entryId: first.userEntryId };
	}
	const index = runs.findIndex((run) => `cp${run.userEntryId}` === checkpointId);
	if (index < 0) return { unknown: true };
	const next = runs[index + 1];
	if (next === undefined) return { nothing: true };
	return { entryId: next.userEntryId };
}
