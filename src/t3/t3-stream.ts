// T3's own thread-stream code (vendor/t3-stream, from the pin by `pnpm setup:t3`), re-exported for the bridge.
export { buildBoundedThreadStreamSnapshot, boundedSnapshotResponseFields, decideThreadResume, THREAD_RESUME_MAX_REPLAY_EVENTS } from "@t3tools/t3-stream/ThreadStream";
export {
	buildBoundedThreadProjection,
	decodeThreadHistoryCursor,
	deferWorkHistoryRows,
	InvalidThreadHistoryCursorError,
	isConversationHistoryItem,
	isThreadHistoryUserTurn,
	missingInterruptRequests,
	olderHistoryPagePolicy,
	selectDeferredWorkPage,
	selectHistoryPageFromCursor,
	selectRecentTimelineWindow,
	THREAD_HISTORY_MAX_RAW_TURNS,
	THREAD_HISTORY_PAGE_POLICY,
	THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
	THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "@t3tools/t3-stream/threadHistoryPaging";
export { makeLiveBodyDeduper, projectDomainEventForWire, projectThreadProjectionForWire, projectTurnItemForWire } from "@t3tools/t3-stream/WireProjection";
export { applyOrchestrationV2ProjectionEvent } from "@t3tools/t3-stream/orchestrationV2Projection";
export { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
