// The thread stream, as T3's server sends it (apps/server/src/ws.ts `subscribeOrchestrationV2Thread`): a snapshot — bounded
// when the client accepts one — then the records that changed, as domain events with a sequence, and a resume that
// replays the events a client missed or, when that is not possible, sends a snapshot instead.
//
// T3 derives its events from the commands it applies. Here the conversation is the truth, so the events are derived
// from two projections: the one the subscribers were last brought to, and the new one. Every record that changed is
// one `*.updated` event, in an order where a record precedes what refers to it. Changes an event cannot express (a
// record that went away, a scope that changed) make a snapshot. Every derived batch is checked by running T3's own
// client reducer over it (`applyOrchestrationV2ProjectionEvent`): a batch that would not bring a client to the new
// projection is replaced by a snapshot, so a client never drifts.
import { DateTime } from "effect";
import { EventId, ThreadId, type OrchestrationV2DomainEvent, type OrchestrationV2ProjectedTurnItem, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
	applyOrchestrationV2ProjectionEvent,
	boundedSnapshotResponseFields,
	buildBoundedThreadProjection,
	buildBoundedThreadStreamSnapshot,
	dedupeSnapshotBodies,
	deferWorkHistoryRows,
	isConversationHistoryItem,
	isThreadHistoryUserTurn,
	makeLiveBodyDeduper,
	missingInterruptRequests,
	olderHistoryPagePolicy,
	projectDomainEventForWire,
	projectThreadProjectionForWire,
	projectTurnItemForWire,
	selectDeferredWorkPage,
	selectHistoryPageFromCursor,
	selectRecentTimelineWindow,
	THREAD_HISTORY_MAX_RAW_TURNS,
	THREAD_HISTORY_PAGE_POLICY,
	THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
	THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./t3-stream.ts";
import type { WsItem } from "./ws-types.ts";

export type ThreadStreamItem = WsItem<"orchestration.subscribeThread">;
type Projection = OrchestrationV2ThreadProjection;
type DomainEvent = OrchestrationV2DomainEvent;

/** What a subscriber accepts (`orchestration.subscribeThread`'s flags, and the bounded HTTP route's query). */
export type ThreadStreamOptions = {
	readonly bounded: boolean;
	readonly deferWork: boolean;
	readonly compactTurnItems: boolean;
	readonly dedupeBodies: boolean;
	readonly compactIds: boolean;
};

/** One event before its sequence is assigned. */
export type UnsequencedEvent = Omit<DomainEvent, "id">;

/** The entity arrays an event can upsert, each with its event types, in the order a batch carries them: a run before
 * its attempts and items, a message before the turn item that repeats its body (the live deduper relies on it). */
const UPSERTS = [
	["runs", "run.created", "run.updated"],
	["attempts", "run-attempt.created", "run-attempt.updated"],
	["nodes", "node.updated", "node.updated"],
	["providerSessions", "provider-session.attached", "provider-session.updated"],
	["providerThreads", "provider-thread.updated", "provider-thread.updated"],
	["providerTurns", "provider-turn.updated", "provider-turn.updated"],
	["runtimeRequests", "runtime-request.updated", "runtime-request.updated"],
	["plans", "plan.updated", "plan.updated"],
	["contextHandoffs", "context-handoff.updated", "context-handoff.updated"],
	["contextTransfers", "context-transfer.created", "context-transfer.updated"],
	["messages", "message.updated", "message.updated"],
	["subagents", "subagent.updated", "subagent.updated"],
	["turnItems", "turn-item.updated", "turn-item.updated"],
	["checkpoints", "checkpoint.captured", "checkpoint.captured"],
] as const satisfies readonly (readonly [keyof Projection, DomainEvent["type"], DomainEvent["type"]])[];

/** Arrays an event can only add to, never change (a change to one of these is a snapshot). */
const CREATE_ONLY = new Set<string>(["checkpointScopes"]);

/**
 * Whether two records encode alike: JSON's equality (keys holding \`undefined\` are absent, a date is its instant),
 * without encoding them. Every flush compares the whole projection, so this is the stream's hot path.
 */
export function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (DateTime.isDateTime(a) || DateTime.isDateTime(b)) return DateTime.isDateTime(a) && DateTime.isDateTime(b) && a.epochMilliseconds === b.epochMilliseconds;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let index = 0; index < a.length; index++) if (!same(a[index], b[index])) return false;
		return true;
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	let count = 0;
	for (const key in left) {
		if (left[key] === undefined) continue;
		count++;
		if (!same(left[key], right[key])) return false;
	}
	for (const key in right) if (right[key] !== undefined) count--;
	return count === 0;
}

/**
 * The events that bring a client holding `previous` to `next`, or `"snapshot"` when no batch can. Events carry the new
 * projection's `updatedAt` as their time (the client stamps the projection with it).
 */
export function diffProjection(previous: Projection, next: Projection): { readonly events: UnsequencedEvent[] } | { readonly snapshot: string } {
	if (previous.thread.id !== next.thread.id) return { snapshot: "another thread" };
	const threadId = next.thread.id;
	const occurredAt = next.updatedAt;
	const events: UnsequencedEvent[] = [];
	const push = (type: DomainEvent["type"], payload: unknown, runId?: unknown): void => {
		events.push({ type, threadId, occurredAt, payload, ...(typeof runId === "string" ? { runId } : {}) } as unknown as UnsequencedEvent);
	};
	if (!same(previous.thread, next.thread)) push("thread.metadata-updated", next.thread);
	for (const [key, created, updated] of UPSERTS) {
		const before = previous[key] as readonly { readonly id: unknown; readonly runId?: unknown }[];
		const after = next[key] as readonly { readonly id: unknown; readonly runId?: unknown }[];
		const old = new Map(before.map((entity) => [entity.id, entity]));
		const kept = new Set(after.map((entity) => entity.id));
		// A record that went away has no event: only a snapshot can remove it.
		for (const entity of before) if (!kept.has(entity.id)) return { snapshot: `a ${key} record went away` };
		for (const entity of after) {
			const was = old.get(entity.id);
			if (was === undefined) push(created, entity, entity.runId);
			else if (was !== entity && !same(was, entity)) push(updated, entity, entity.runId);
		}
	}
	for (const key of CREATE_ONLY) {
		const before = previous[key as keyof Projection] as readonly { readonly id: unknown }[];
		const after = next[key as keyof Projection] as readonly { readonly id: unknown }[];
		if (after.length < before.length) return { snapshot: `a ${key} record went away` };
		for (let index = 0; index < before.length; index++) if (!same(before[index], after[index])) return { snapshot: `a ${key} record changed` };
		for (const entity of after.slice(before.length)) push("checkpoint-scope.created", entity);
	}
	// The visible timeline is derived: the check below decides whether the events reproduce it.
	if (events.length === 0 && !same(previous.visibleTurnItems.map(rowKey), next.visibleTurnItems.map(rowKey))) return { snapshot: "the visible rows moved" };
	if (events.length === 0 && !same(previous.updatedAt, next.updatedAt)) push("thread.metadata-updated", next.thread);
	const mismatch = reproduces(previous, events, next);
	return mismatch === undefined ? { events } : { snapshot: mismatch };
}

const rowKey = (row: OrchestrationV2ProjectedTurnItem) => [row.sourceThreadId, row.sourceItemId, row.visibility, row.position];

/** Whether T3's client reducer, applying `events` to `previous`, arrives at `next`: every entity array in the same order
 * with the same records, the same visible rows, the same thread. */
function reproduces(previous: Projection, events: readonly UnsequencedEvent[], next: Projection): string | undefined {
	let projection: Projection | null = previous;
	for (const event of events) projection = applyOrchestrationV2ProjectionEvent(projection, { ...event, id: EventId.make("check") } as DomainEvent);
	if (projection === null) return "the reducer dropped the thread";
	if (!same(projection.thread, next.thread)) return "the thread differs";
	for (const [key] of [...UPSERTS, ["checkpointScopes"]] as const) {
		const got = projection[key] as readonly unknown[];
		const want = next[key] as readonly unknown[];
		if (got.length !== want.length) return `${key}: ${got.length} records, not ${want.length}`;
		for (let index = 0; index < got.length; index++) if (got[index] !== want[index] && !same(got[index], want[index])) return `${key}[${index}] differs (order)`;
	}
	if (projection.visibleTurnItems.length !== next.visibleTurnItems.length) return `visibleTurnItems: ${projection.visibleTurnItems.length} rows, not ${next.visibleTurnItems.length}`;
	for (let index = 0; index < next.visibleTurnItems.length; index++) {
		const got = projection.visibleTurnItems[index]!;
		const want = next.visibleTurnItems[index]!;
		if (!same(rowKey(got), rowKey(want))) return `visibleTurnItems[${index}] is another row`;
		if (got.item !== want.item && !same(got.item, want.item)) return `visibleTurnItems[${index}] holds another item`;
	}
	return undefined;
}

const ACTIVE_RUN = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const ACTIVE_WORK = new Set(["pending", "starting", "running", "waiting"]);

/**
 * The projection T3's windowed read returns (`ProjectionStore.readCanonicalProjection` with a window): the window's turn
 * items, and of every other record only the ones they refer to (their "cohort") or that are still live. The bounded
 * snapshot is built over it, so its size follows the window, not the thread.
 */
export function windowedProjection(projection: Projection): Projection {
	// T3's SQL compares stored status strings, some of which the typed records never take: compare them as strings too.
	const is = (status: unknown, value: string): boolean => status === value;
	// The retained rows, and the thread's own turn items behind them: the window the bounded snapshot is chosen from.
	const rows = windowRows(projection.visibleTurnItems);
	const local = new Set(rows.filter((row) => row.sourceThreadId === projection.thread.id).map((row) => row.sourceItemId as string));
	const window = { visibleTurnItems: rows, turnItems: projection.turnItems.filter((item) => local.has(item.id as string)) };
	const field = (name: string) => new Set(window.turnItems.flatMap((item) => {
		const value = (item as unknown as Record<string, unknown>)[name];
		return typeof value === "string" ? [value] : [];
	}));
	const runIds = field("runId");
	const providerThreadIds = field("providerThreadId");
	const providerTurnIds = field("providerTurnId");
	const messageIds = field("messageId");
	const planIds = field("planId");
	const checkpointIds = field("checkpointId");
	const handoffIds = field("contextHandoffId");
	const nodeIds = field("nodeId");
	for (const node of projection.nodes) if (ACTIVE_WORK.has(node.status)) nodeIds.add(node.id);
	for (const attempt of projection.attempts) {
		if (ACTIVE_WORK.has(attempt.status) || runIds.has(attempt.runId)) if (attempt.rootNodeId !== null) nodeIds.add(attempt.rootNodeId);
	}
	for (const run of projection.runs) if ((ACTIVE_RUN.has(run.status) || runIds.has(run.id)) && run.rootNodeId !== null) nodeIds.add(run.rootNodeId);
	for (const request of projection.runtimeRequests) if ((is(request.status, "pending") || is(request.status, "waiting")) && request.nodeId !== null) nodeIds.add(request.nodeId);
	for (const subagent of projection.subagents) if (ACTIVE_WORK.has(subagent.status)) nodeIds.add(subagent.parentNodeId);
	for (const turn of projection.providerTurns) if ((is(turn.status, "starting") || is(turn.status, "running") || is(turn.status, "waiting")) && turn.nodeId !== null) nodeIds.add(turn.nodeId);
	// The parents of retained nodes, transitively.
	const parentOf = new Map(projection.nodes.map((node) => [node.id as string, node.parentNodeId as string | null]));
	for (const nodeId of [...nodeIds]) {
		for (let parent = parentOf.get(nodeId) ?? null; parent !== null && !nodeIds.has(parent); parent = parentOf.get(parent) ?? null) nodeIds.add(parent);
	}
	const has = (set: Set<string>, value: unknown) => typeof value === "string" && set.has(value);
	const providerThreads = projection.providerThreads.filter((thread) => is(thread.status, "active") || has(providerThreadIds, thread.id) || has(nodeIds, thread.ownerNodeId));
	const keptProviderThreads = new Set(providerThreads.map((thread) => thread.id as string));
	return {
		...projection,
		runs: projection.runs.filter((run) => ACTIVE_RUN.has(run.status) || has(runIds, run.id)),
		attempts: projection.attempts.filter((attempt) => ACTIVE_WORK.has(attempt.status) || has(runIds, attempt.runId)),
		nodes: projection.nodes.filter((node) => has(nodeIds, node.id)),
		subagents: projection.subagents.filter((subagent) => ACTIVE_WORK.has(subagent.status) || has(runIds, subagent.runId) || has(nodeIds, subagent.parentNodeId)),
		providerSessions: projection.providerSessions.filter(
			(session) => is(session.status, "starting") || is(session.status, "running") || is(session.status, "waiting") || projection.providerThreads.some((thread) => thread.providerSessionId === session.id && keptProviderThreads.has(thread.id)),
		),
		providerThreads,
		providerTurns: projection.providerTurns.filter((turn) => is(turn.status, "starting") || is(turn.status, "running") || is(turn.status, "waiting") || has(providerTurnIds, turn.id) || has(nodeIds, turn.nodeId)),
		runtimeRequests: projection.runtimeRequests.filter((request) => is(request.status, "pending") || is(request.status, "waiting") || has(nodeIds, request.nodeId) || has(providerTurnIds, request.providerTurnId)),
		messages: projection.messages.filter((message) => has(messageIds, message.id) || projection.runs.some((run) => run.id === message.runId && ACTIVE_RUN.has(run.status))),
		plans: projection.plans.filter((plan) => is(plan.status, "active") || has(planIds, plan.id)),
		turnItems: window.turnItems,
		visibleTurnItems: window.visibleTurnItems,
		checkpointScopes: projection.checkpointScopes.filter((scope) => has(runIds, scope.runId) || has(nodeIds, scope.nodeId)),
		checkpoints: projection.checkpoints.filter(
			(checkpoint) =>
				is(checkpoint.status, "pending") ||
				is(checkpoint.status, "capturing") ||
				(checkpoint.runId === null && checkpoint.ordinalWithinScope === 0 && is(checkpoint.status, "ready")) ||
				has(checkpointIds, checkpoint.id) ||
				has(runIds, checkpoint.runId) ||
				has(nodeIds, checkpoint.nodeId),
		),
		contextHandoffs: projection.contextHandoffs.filter((handoff) => is(handoff.status, "pending") || is(handoff.status, "ready") || has(handoffIds, handoff.id)),
		contextTransfers: projection.contextTransfers.filter(
			(transfer) => is(transfer.status, "pending") || is(transfer.status, "running") || is(transfer.status, "waiting") || has(runIds, transfer.targetRunId) || has(handoffIds, (transfer as unknown as { contextHandoffId?: unknown }).contextHandoffId),
		),
	};
}

/**
 * The rows T3's windowed read keeps (`ProjectionStore.retainedWindowRows`): from the twelfth-newest user turn on (two more
 * than the window shows, so the window can tell there is more history), at most 77 rows — or 502 while the newest user
 * turn fits in 500 — plus the interrupt requests their results need and the newest row.
 */
function windowRows(rows: Projection["visibleTurnItems"]): Projection["visibleTurnItems"] {
	const starts: number[] = [];
	let rawStarts = 0;
	rows.forEach((row, index) => {
		const item = row.item as { type: string; inputIntent?: string; createdBy?: string };
		const turnStart = item.type === "user_message" && (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn");
		if (turnStart) rawStarts += 1;
		if (turnStart && item.createdBy === "user") starts.push(index);
	});
	const turns = THREAD_HISTORY_PAGE_POLICY.maxUserTurns + 2;
	let boundary = 0;
	if (starts.length >= turns) boundary = starts[starts.length - turns]!;
	else if (rawStarts >= THREAD_HISTORY_MAX_RAW_TURNS + 2) {
		const raw = rows.flatMap((row, index) => {
			const item = row.item as { type: string; inputIntent?: string };
			return item.type === "user_message" && (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn") ? [index] : [];
		});
		boundary = raw[raw.length - (THREAD_HISTORY_MAX_RAW_TURNS + 2)]!;
	}
	const latest = starts.at(-1);
	const latestTurnRows = latest === undefined ? 0 : rows.length - latest;
	const limit = latestTurnRows >= 1 && latestTurnRows <= THREAD_HISTORY_PAGE_POLICY.maxTurnItems ? THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT : THREAD_HISTORY_SNAPSHOT_ROW_LIMIT;
	const selected = rows.slice(boundary).slice(-limit);
	const kept = new Set(selected.map((row) => row.sourceItemId as string));
	const resultRuns = new Set(selected.flatMap((row) => (row.item.type === "run_interrupt_result" && row.item.runId !== null ? [row.item.runId as string] : [])));
	const retained = rows.filter(
		(row) => kept.has(row.sourceItemId as string) || (row.item.type === "run_interrupt_request" && row.item.runId !== null && resultRuns.has(row.item.runId as string)) || row === rows.at(-1),
	);
	return retained.map((row, position) => ({ ...row, position }));
}

/** A snapshot item for one subscriber: bounded (T3's window, with its history cursor) when it accepts one, else the
 * whole projection, as T3's `snapshotThenLive` builds them. */
export function snapshotItem(sequence: number, projection: Projection, options: ThreadStreamOptions): ThreadStreamItem {
	if (options.bounded) {
		return buildBoundedThreadStreamSnapshot({
			snapshotSequence: sequence,
			projection: windowedProjection(options.deferWork ? deferProjectionWork(projection) : projection),
			compactTurnItems: options.compactTurnItems,
			dedupeBodies: options.dedupeBodies,
			compactIds: options.compactIds,
		}) as ThreadStreamItem;
	}
	const wire = projectThreadProjectionForWire(projection);
	return { kind: "snapshot", snapshotSequence: sequence, projection: options.dedupeBodies ? dedupeSnapshotBodies(wire) : wire } as ThreadStreamItem;
}

/** T3's bounded HTTP snapshot (`/api/orchestration/threads/:threadId/bounded`). */
export function boundedSnapshot(sequence: number, projection: Projection, options: Omit<ThreadStreamOptions, "bounded">) {
	const bounded = buildBoundedThreadProjection({
		snapshotSequence: sequence,
		projection: projectThreadProjectionForWire(windowedProjection(options.deferWork ? deferProjectionWork(projection) : projection)),
	});
	return { snapshotSequence: sequence, ...boundedSnapshotResponseFields({ bounded, compactTurnItems: options.compactTurnItems, dedupeBodies: options.dedupeBodies, compactIds: options.compactIds }) };
}

/** A projection whose long runs of completed work rows are folded behind one deferred row each, as T3's window
 * folds them when the client accepts deferred work. */
function deferProjectionWork(projection: Projection): Projection {
	const rows = deferWorkHistoryRows(projection.visibleTurnItems.map((row, position) => ({ ...row, position })));
	return { ...projection, visibleTurnItems: rows.map((row, position) => ({ ...row, position })) };
}

/** An event with its sequence and id, shaped for the wire (T3's `projectDomainEventForWire`). */
export function eventItem(sequence: number, event: UnsequencedEvent): ThreadStreamItem {
	return { kind: "event", sequence, event: projectDomainEventForWire({ ...event, id: EventId.make(`pi-${sequence}-${event.type}`) } as DomainEvent) } as ThreadStreamItem;
}

/** One subscriber's view of the items: T3's live body deduper when the client accepts deduped bodies. */
export function subscriberFilter(options: Pick<ThreadStreamOptions, "dedupeBodies">): (item: ThreadStreamItem) => ThreadStreamItem {
	if (!options.dedupeBodies) return (item) => item;
	const dedupe = makeLiveBodyDeduper();
	return (item) => dedupe(item) as ThreadStreamItem;
}

/**
 * T3's history page (`ProjectionStore.getThreadHistoryPage`) over the whole projection: the page before `cursor` (or
 * the work rows a deferred row stands for, with `view: "work"`), bounded by T3's page policy, with the interrupt
 * requests its rows need. Throws T3's `InvalidThreadHistoryCursorError` for a cursor it did not make.
 */
export function historyPage(input: {
	readonly projection: Projection;
	readonly snapshotSequence: number;
	readonly cursor: string;
	readonly throughEntryId?: string | undefined;
	readonly view?: "conversation" | "activity" | "work" | undefined;
	readonly deferWork: boolean;
}) {
	const workMode = input.view === "work" ? "work" : input.deferWork ? "deferred" : undefined;
	const conversationOnly = input.view === "conversation";
	const visible = input.projection.visibleTurnItems;
	const indexed = visible.map((row, position) => ({ ...row, position, canonicalPosition: position }));
	const historyItems = workMode === "deferred" ? deferWorkHistoryRows(indexed) : indexed;
	const policy = olderHistoryPagePolicy({ items: indexed, cursor: input.cursor, throughEntryId: input.throughEntryId });
	const page =
		workMode === "work"
			? selectDeferredWorkPage({ items: indexed, cursor: input.cursor, throughEntryId: input.throughEntryId, snapshotSequence: input.snapshotSequence, rowEncodedBytes: () => 0 })
			: selectHistoryPageFromCursor({ items: historyItems, cursor: input.cursor, snapshotSequence: input.snapshotSequence, rowEncodedBytes: () => 0, policy });
	const pagePolicy = workMode === "work" ? THREAD_HISTORY_PAGE_POLICY : policy;
	const end = (page.items.at(-1)?.canonicalPosition ?? -1) + 1;
	const hasUserTurns = visible.slice(0, end).some((row) => isThreadHistoryUserTurn(row.item));
	const materialize = (rows: readonly (typeof indexed)[number][]) =>
		rows.map((row) => ({
			position: row.canonicalPosition,
			visibility: row.visibility,
			sourceThreadId: row.sourceThreadId,
			sourceItemId: row.sourceItemId,
			item: projectTurnItemForWire(row.item.deferredWork === undefined ? visible[row.canonicalPosition]!.item : { ...visible[row.canonicalPosition]!.item, deferredWork: row.item.deferredWork }),
		}));
	const items = materialize(conversationOnly && hasUserTurns ? page.items.filter((row) => isConversationHistoryItem(row.item)) : page.items);
	const bounded = selectRecentTimelineWindow({ items, snapshotSequence: input.snapshotSequence, policy: pagePolicy });
	const requests = workMode === "work" ? [] : materialize(missingInterruptRequests(indexed, bounded.items));
	const pageItems = [...requests, ...bounded.items].map((row, position) => ({ ...row, position }));
	return {
		snapshotSequence: input.snapshotSequence,
		items: conversationOnly ? pageItems.filter((row) => isConversationHistoryItem(row.item)) : pageItems,
		nextCursor: bounded.hasMoreHistory ? bounded.nextCursor : page.nextCursor,
		hasMoreHistory: bounded.hasMoreHistory || page.hasMoreHistory,
	};
}

