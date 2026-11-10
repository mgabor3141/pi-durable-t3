// Editing the message right after a compaction (T3's rewind of the turn before it), here in a fork made from the
// response after the compaction, the way to reach that point from T3. The rewound head keeps the compaction: its
// context still starts with the summary, and the card stays. The client sees the rewind as events applied by T3's own
// reducer, and T3's wait for it (`waitForRevertedMessage`) is met: the edited run rolled back with the id and ordinal
// it had, and the provider thread's last run is the turn rewound to. Before the fix the fork point cut the summary off,
// the card's removal forced a snapshot without the rolled-back run, and T3 timed out ("Timed out waiting for the
// thread to rewind").
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { applyOrchestrationV2ProjectionEvent } from "../src/t3/t3-server.ts";
import { windowedProjection } from "../src/t3/thread-stream.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const FORK = "00000000-0000-4000-8000-0000000000f1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("editing the message after a compaction keeps the compaction, and T3 sees the rewind", { timeout: 60_000 }, async () => {
	const snapshots: string[] = [];
	const log: Logger = { info: (message, fields) => void (message === "thread stream sent a snapshot" && snapshots.push(String(fields?.["reason"]))), warn: () => {} };
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-rollback-compaction-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const long = "x".repeat(40_000);
	for (const n of [1, 2, 3, 4]) {
		f.model.respond(fauxAssistantMessage(`answer ${n} ${long}`));
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text: `question ${n}`, mode: "start" });
		await idle(f.harness, thread.head);
	}
	f.model.respond(fauxAssistantMessage("SUMMARY"));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	await idle(f.harness, thread.head);
	for (let i = 0; i < 100 && !(await bridge.projection("t")).projection.turnItems.some((item) => item.type === "compaction"); i++) await sleep(30);
	f.model.respond(fauxAssistantMessage("answer 5"));
	await bridge.sendMessage({ threadId: "t", commandId: "c5", messageId: "m5", text: "question 5", mode: "start" });
	await idle(f.harness, thread.head);

	// Fork from the response after the compaction, as T3's "Fork from this response" does.
	const source = (await bridge.projection("t")).projection;
	await bridge.forkThread({ sourceThreadId: "t", targetThreadId: FORK, runId: String(source.runs.at(-1)!.id) });
	for (let i = 0; i < 100 && (await bridge.projection(FORK)).projection.runs.length < 6; i++) await sleep(30);
	const fork = (await bridge.projection(FORK)).projection;
	const runs = [...fork.runs].sort((a, b) => a.ordinal - b.ordinal);
	const edited = runs.at(-1)!;
	const before = runs.at(-2)!;
	expect(before.ordinal).toBe(5);

	// A client of the fork's stream, as T3's web app is: a snapshot is the window a bounded snapshot carries, and every
	// event is applied with T3's reducer.
	let client: OrchestrationV2ThreadProjection | null = null;
	const stop = bridge.subscribeThread(FORK, undefined, (update) => {
		if (update.kind === "snapshot") client = windowedProjection(update.projection);
		else for (const item of update.items) if (item.kind === "event") client = applyOrchestrationV2ProjectionEvent(client, item.event);
	});
	onTestFinished(stop);
	await sleep(300);
	snapshots.length = 0;

	// Edit "question 5": T3 rewinds to the checkpoint of the turn before it and waits.
	await bridge.rollback({ threadId: FORK, commandId: "edit-1", checkpointId: before.checkpointId!, restoreFiles: false });
	const providerThreadId = fork.thread.activeProviderThreadId;
	const met = (projection: OrchestrationV2ThreadProjection | null) =>
		projection !== null &&
		projection.thread.rollbackFailure === null &&
		projection.providerThreads.some((candidate) => candidate.id === providerThreadId && candidate.lastRunOrdinal === before.ordinal) &&
		projection.runs.some((run) => run.id === edited.id && run.status === "rolled_back");
	for (let i = 0; i < 100 && !met(client); i++) await sleep(30);
	expect(met(client), "T3's wait for the rewind is met").toBe(true);
	expect(snapshots, "the rewind reaches the client as events").toEqual([]);

	// Only the edited run is rolled back, with the id and ordinal it had; the compaction card stays.
	const after = (await bridge.projection(FORK)).projection;
	expect(after.runs.filter((run) => run.status === "rolled_back").map((run) => [run.id, run.ordinal])).toEqual([[edited.id, edited.ordinal]]);
	expect(after.turnItems.filter((item) => item.type === "compaction").map((item) => item.runId)).toEqual([before.id]);

	// The rewound head still starts from the summary, not from the history it compacted.
	const head = (await f.threads.thread(FORK))!.head;
	const context = await (await f.harness.conversation(head as ConversationId, ctx))!.context(ctx);
	expect(context.entries[0]!.kind).toBe("pi.compaction");
	expect(JSON.stringify(context.messages)).not.toContain("question 1");
});
