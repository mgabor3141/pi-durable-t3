import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/**
 * T3's bounded-snapshot compaction: local visible rows lead the full item list, so a client that opted in can rebuild
 * them from `visibleTurnItems`. The check is by object identity, which the bridge's projection preserves because
 * `visibleTurnItems[].item` references the same object as `turnItems[]`. A JSON-decoded projection cannot be compacted
 * this way, so only server-side projections go through here.
 */
export function compactThreadProjection(
	projection: OrchestrationV2ThreadProjection,
): { projection: OrchestrationV2ThreadProjection; turnItemsOmitLocalVisible?: true } {
	let omitted = 0;
	for (const row of projection.visibleTurnItems) {
		const local = row.visibility === "local" || row.sourceThreadId === projection.thread.id;
		if (!local) continue;
		if (projection.turnItems[omitted] !== row.item) return { projection };
		omitted += 1;
	}
	if (omitted === 0) return { projection };
	return {
		projection: { ...projection, turnItems: projection.turnItems.slice(omitted) },
		turnItemsOmitLocalVisible: true,
	};
}
