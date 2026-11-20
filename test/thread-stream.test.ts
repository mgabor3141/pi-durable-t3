// The thread stream (`thread-stream.ts` + the bridge's flush): a session of prompts, a tool call, a queued follow-up,
// an undo and a manual compaction, watched the way T3's web app watches it — every update is checked against T3's own
// client reducer and the contract's encoding. Live changes go out as events; a snapshot only for what no event can say.
import { sleep } from "./wait.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { OrchestrationV2ThreadBoundedSnapshot, OrchestrationV2ThreadHistoryPage, OrchestrationV2ThreadStreamItem, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, onTestFinished } from "vitest";
import { Bridge, type StreamUpdate } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { applyOrchestrationV2ProjectionEvent } from "../src/t3/t3-server.ts";
import { boundedSnapshot, historyPage, snapshotItem, subscriberFilter, type ThreadStreamItem, type ThreadStreamOptions } from "../src/t3/thread-stream.ts";
import { createNamed, makeThreads, bridgeConfig } from "./threads-harness.ts";

const WEB: ThreadStreamOptions = { bounded: true, deferWork: true, compactTurnItems: true, dedupeBodies: true, compactIds: true };
const encodeItem = Schema.encodeSync(OrchestrationV2ThreadStreamItem);
const visibleKeys = (projection: OrchestrationV2ThreadProjection) => projection.visibleTurnItems.map((row) => `${row.sourceItemId}@${row.position}`);

async function open(options: { turns?: number; tokensPerSecond?: number } = {}) {
	const reasons: string[] = [];
	const log: Logger = { info: (message, fields) => void (message === "thread stream sent a snapshot" && reasons.push(String(fields?.["reason"]))), warn: () => {} };
	const f = await makeThreads({ projects: [{ id: "p" }], coding: true, ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Stream" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-stream-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const idle = async () => {
		for (let i = 0; i < 500; i++) {
			const { projection } = await bridge.projection("t");
			if (!projection.runs.some((run) => ["running", "queued", "preparing", "starting"].includes(run.status))) return;
			await sleep(20);
		}
		throw new Error("the thread never went idle");
	};
	const send = async (n: number, text: string, mode: "start" | "queue" = "start") =>
		bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode });
	return { f, bridge, reasons, idle, send };
}

/** A client of the stream: it starts from what the bridge sends first and applies every update with T3's reducer. */
function client(bridge: Bridge, afterSequence?: number, initial?: OrchestrationV2ThreadProjection) {
	let projection: OrchestrationV2ThreadProjection | null = initial ?? null;
	const updates: StreamUpdate[] = [];
	const filter = subscriberFilter(WEB);
	const stop = bridge.subscribeThread("t", afterSequence, (update) => {
		updates.push(update);
		const items: ThreadStreamItem[] = update.kind === "snapshot" ? [snapshotItem(update.sequence, update.projection, WEB)] : [...update.items];
		// Every item is a valid wire item.
		for (const item of items) encodeItem(filter(item) as never);
		if (update.kind === "snapshot") projection = update.projection;
		else for (const item of update.items) if (item.kind === "event") projection = applyOrchestrationV2ProjectionEvent(projection, item.event);
	});
	onTestFinished(stop);
	return { stop, updates, current: () => projection };
}

it("a session goes out as events, and a client applying them holds the projection the host has", { timeout: 60_000 }, async () => {
	const { f, bridge, reasons, idle, send } = await open();
	const watcher = client(bridge);
	f.model.respond(fauxAssistantMessage("first answer"));
	await send(1, "hello");
	await idle();
	// A tool call, its result, then the answer.
	f.model.respond(fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi" })], { stopReason: "toolUse" }), fauxAssistantMessage("it said hi"));
	await send(2, "run something");
	await idle();
	await sleep(150);
	const { projection } = await bridge.projection("t");
	expect(watcher.updates.filter((update) => update.kind === "snapshot"), "one snapshot: the first").toHaveLength(1);
	expect(reasons, "no fallback").toEqual([]);
	expect(visibleKeys(watcher.current()!)).toEqual(visibleKeys(projection));
	expect(JSON.stringify(watcher.current()!.messages)).toEqual(JSON.stringify(projection.messages));
	expect(JSON.stringify(watcher.current()!.runs)).toEqual(JSON.stringify(projection.runs));
});

it("a streaming reply keeps one item from its first token to its commit, and items are numbered in order", { timeout: 60_000 }, async () => {
	const { f, bridge, reasons, idle, send } = await open({ tokensPerSecond: 200 });
	const watcher = client(bridge);
	f.model.respond(fauxAssistantMessage("word ".repeat(200)));
	await send(1, "talk");
	await idle();
	await sleep(150);
	const { projection } = await bridge.projection("t");
	const events = watcher.updates.flatMap((update) => (update.kind === "events" ? update.items : []));
	const assistantIds = new Set(events.flatMap((item) => (item.kind === "event" && item.event.type === "turn-item.updated" && item.event.payload.type === "assistant_message" ? [item.event.payload.id] : [])));
	expect(events.length, "the reply streamed in several updates").toBeGreaterThan(3);
	expect([...assistantIds], "one assistant item throughout").toHaveLength(1);
	expect(reasons).toEqual([]);
	expect(projection.turnItems.map((item) => item.ordinal)).toEqual(projection.turnItems.map((_, index) => index + 1));
});

it("a resume after the last sequence gets only what follows; an unknown one gets a snapshot", { timeout: 60_000 }, async () => {
	const { f, bridge, idle, send } = await open();
	f.model.respond(fauxAssistantMessage("one"));
	await send(1, "first");
	await idle();
	const opened = await bridge.streamSnapshot("t");
	// The web app's open: the HTTP snapshot, then a subscription resuming after it.
	const resumed = client(bridge, opened.sequence, opened.projection);
	const stale = client(bridge, 1);
	await sleep(100);
	expect(resumed.updates, "nothing to replay, no snapshot").toEqual([{ kind: "events", items: [] }]);
	expect(stale.updates.map((update) => update.kind)).toEqual(["snapshot"]);
	f.model.respond(fauxAssistantMessage("two"));
	await send(2, "second");
	await idle();
	await sleep(150);
	const { projection } = await bridge.projection("t");
	expect(resumed.updates.every((update) => update.kind === "events")).toBe(true);
	expect(visibleKeys(resumed.current()!)).toEqual(visibleKeys(projection));
	// A subscription resuming from inside the log is replayed what it missed.
	const lateFrom = (resumed.updates[1] as { items: readonly { sequence?: number }[] }).items[0]!.sequence! - 1;
	const late = client(bridge, lateFrom, undefined);
	await sleep(100);
	expect(late.updates[0]?.kind).toBe("events");
});

it("a queued message that is removed stays in the stream as a cancelled run, as T3's server keeps it", { timeout: 60_000 }, async () => {
	const { f, bridge, reasons, idle, send } = await open({ tokensPerSecond: 20 });
	const watcher = client(bridge);
	f.model.respond(fauxAssistantMessage("slow ".repeat(40)));
	await send(1, "long");
	await sleep(300);
	await send(2, "later", "queue");
	await sleep(200);
	const queued = (await bridge.projection("t")).projection.runs.find((run) => run.status === "queued");
	expect(queued, "the follow-up is queued").toBeDefined();
	await bridge.cancelQueued("t", queued!.id as string);
	await sleep(200);
	// No event of T3's takes a run away, and none is needed: the client is told the run is cancelled, which its queue
	// leaves out. The thread is not sent again.
	expect(reasons, "removing a queued message needs no snapshot").toEqual([]);
	// Out of the queue and ended, as T3 cancels a queued run: the client's latest-run pick (`latestUnheldRun`, 0.1.11)
	// passes over a run that never started and ended before the one it was waiting behind.
	expect(watcher.current()!.runs.find((run) => run.id === queued!.id)).toMatchObject({ status: "cancelled", queuePosition: null, startedAt: null, completedAt: expect.anything() });
	expect((await bridge.projection("t")).projection.runs.some((run) => run.id === queued!.id), "the bridge's own readers do not see it").toBe(false);
	await bridge.interrupt("t");
	await idle();
	await sleep(150);
	const { projection } = await bridge.projection("t");
	// The client still matches the thread: the same rows, and the same runs beside the cancelled one (which a later
	// snapshot, when one is needed, leaves out).
	expect(visibleKeys(watcher.current()!)).toEqual(visibleKeys(projection));
	expect(watcher.current()!.runs.filter((run) => run.id !== queued!.id).map((run) => run.id)).toEqual(projection.runs.map((run) => run.id));
});

it("the bounded snapshot stays small on a long thread, and its history pages walk back to the start", { timeout: 120_000 }, async () => {
	const { f, bridge, idle, send } = await open();
	for (let n = 1; n <= 30; n++) {
		f.model.respond(fauxAssistantMessage(`answer ${n} ` + "text ".repeat(50)));
		await send(n, `question ${n}`);
		await idle();
	}
	const stream = await bridge.streamSnapshot("t");
	const bounded = boundedSnapshot(stream.sequence, stream.projection, { deferWork: true, compactTurnItems: false, dedupeBodies: false, compactIds: false });
	Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot)(bounded as never);
	expect(bounded.hasMoreHistory).toBe(true);
	expect(bounded.projection.runs.length, "the window's runs, not all 30").toBeLessThan(stream.projection.runs.length);
	const seen = bounded.projection.visibleTurnItems.map((row) => row.sourceItemId as string);
	let cursor = bounded.historyCursor;
	for (let pages = 0; cursor !== null && pages < 20; pages++) {
		const page = historyPage({ projection: stream.projection, snapshotSequence: stream.sequence, cursor, deferWork: true });
		Schema.encodeSync(OrchestrationV2ThreadHistoryPage)(page as never);
		seen.unshift(...page.items.map((row) => row.sourceItemId as string));
		cursor = page.hasMoreHistory ? page.nextCursor : null;
	}
	expect(seen, "the pages and the window are the whole timeline, once each, in order").toEqual(stream.projection.visibleTurnItems.map((row) => row.sourceItemId as string));
});

// T3's web app restores the reverted prompt once its own projection shows what T3's server streams on a rollback:
// the reverted run `rolled_back` and the provider thread's `lastRunOrdinal` at the kept turn
// (`waitForRevertedMessage`). Its first-load snapshot is a bounded window that leaves rolled-back runs out, so the
// rollback must arrive as events — a snapshot would drop the very run it waits for, and the composer would hang.
it("a rollback streams as events, and leaves the client where the web app's revert waits for it", { timeout: 60_000 }, async () => {
	const { f, bridge, reasons, idle, send } = await open();
	const watcher = client(bridge);
	f.model.respond(fauxAssistantMessage("one"));
	await send(1, "first");
	await idle();
	f.model.respond(fauxAssistantMessage("two"));
	await send(2, "second");
	await idle();
	await sleep(150);
	const [first, second] = (await bridge.projection("t")).projection.runs;
	const before = watcher.updates.length;
	await bridge.rollback({ threadId: "t", commandId: "undo", checkpointId: first!.checkpointId!, restoreFiles: false });
	await sleep(300);
	expect(reasons, "no snapshot").toEqual([]);
	expect(watcher.updates.slice(before).every((update) => update.kind === "events")).toBe(true);
	const seen = watcher.current()!;
	expect(seen.runs.find((run) => run.id === second!.id)?.status).toBe("rolled_back");
	expect(seen.providerThreads.find((thread) => thread.id === seen.thread.activeProviderThreadId)?.lastRunOrdinal).toBe(first!.ordinal);
	expect(seen.checkpoints.filter((checkpoint) => checkpoint.runId === second!.id).every((checkpoint) => checkpoint.status === "stale")).toBe(true);
	expect(seen.thread.rollbackRequestId).toBe("undo");

	// A new turn after the undo, then an undo of it: still events, with the first undo's run in place.
	f.model.respond(fauxAssistantMessage("three"));
	await send(3, "third");
	await idle();
	await sleep(150);
	const third = (await bridge.projection("t")).projection.runs.find((run) => run.status === "completed" && run.id !== first!.id)!;
	await bridge.rollback({ threadId: "t", commandId: "undo-2", checkpointId: first!.checkpointId!, restoreFiles: false });
	await sleep(300);
	expect(reasons, "no snapshot").toEqual([]);
	const again = watcher.current()!;
	expect(Object.fromEntries(again.runs.map((run) => [run.id, run.status]))).toEqual({ [first!.id]: "completed", [second!.id]: "rolled_back", [third.id]: "rolled_back" });
});

it("one projection that throws does not freeze an open thread: the next value of its head is shown", { timeout: 60_000 }, async () => {
	const { f, bridge, idle, send } = await open();
	const watcher = client(bridge);
	f.model.respond(fauxAssistantMessage("first"));
	await send(1, "hello");
	await idle();
	// One throw while a view of the head is projected (here: the approvals read the metadata makes).
	const shown = bridge.approvals.shown.bind(bridge.approvals);
	let armed = true;
	(bridge.approvals as unknown as { shown: typeof shown }).shown = (threadId: string) => {
		if (!armed) return shown(threadId);
		armed = false;
		throw new Error("transient");
	};
	f.model.respond(fauxAssistantMessage("second"));
	await send(2, "again");
	await idle();
	await sleep(150);
	expect(armed, "the projection threw once").toBe(false);
	const { projection } = await bridge.projection("t");
	expect(projection.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
	expect(projection.messages.some((message) => message.text === "second")).toBe(true);
	expect(watcher.current()!.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
});
