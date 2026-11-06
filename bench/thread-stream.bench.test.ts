// What one long thread costs on the wire while a reply streams, measured the way T3's web app reads a thread: the
// bounded HTTP snapshot, then a subscription that resumes after it, with every flag the web app sends. Bytes are the
// contract's own encoding of each stream item (`OrchestrationV2ThreadStreamItem`, compact ids included).
// Run: TMPDIR=<exec-able dir> npx vitest run --config bench/vitest.config.ts
// Not part of `pnpm test`: it measures, it does not assert.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { OrchestrationV2ThreadBoundedSnapshot, OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { it } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { boundedSnapshot, snapshotItem, subscriberFilter, type ThreadStreamItem, type ThreadStreamOptions } from "../src/t3/thread-stream.ts";
import { createNamed, makeThreads } from "../test/threads-harness.ts";

const reasons: string[] = [];
const log: Logger = { info: (message, fields) => void (message === "thread stream sent a snapshot" && reasons.push(String(fields?.["reason"]))), warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TURNS = Number(process.env.BENCH_TURNS ?? 200);
const REPLY_WORDS = Number(process.env.BENCH_REPLY_WORDS ?? 3_000);
const encodeItem = Schema.encodeSync(OrchestrationV2ThreadStreamItem);
const encodeBounded = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);
const WEB: ThreadStreamOptions = { bounded: true, deferWork: true, compactTurnItems: true, dedupeBodies: true, compactIds: true };

it(`thread stream: ${TURNS} turns, then one streamed reply`, { timeout: 900_000 }, async () => {
	const prior = Array.from({ length: TURNS }, (_, i) => async () => fauxAssistantMessage(`Reply ${i}: ` + "lorem ipsum dolor sit amet ".repeat(12)));
	const fixture = await makeThreads({ projects: [{ id: "p" }], responses: prior, tokensPerSecond: 1_000 });
	await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p", title: "Bench" });
	const scratch = await mkdtemp(join(tmpdir(), "bench-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry }, log, fixture.threads, fixture.model.models);
	bridge.start();
	await bridge.loaded();

	const idle = async () => {
		for (let i = 0; i < 2_000; i++) {
			const { projection } = await bridge.projection("t");
			if (!projection.runs.some((run: { status: string }) => run.status === "running" || run.status === "queued" || run.status === "preparing")) return;
			await sleep(20);
		}
		throw new Error("thread never went idle");
	};
	const fill0 = performance.now();
	for (let i = 0; i < TURNS; i++) {
		await bridge.sendMessage({ threadId: "t", commandId: `c${i}`, messageId: `m${i}`, text: `Question ${i}: ` + "please explain ".repeat(20), mode: "start" });
		await idle();
	}
	const fillMs = performance.now() - fill0;

	// The web app's open: the bounded snapshot over HTTP, then a subscription resuming after it.
	const open = await bridge.streamSnapshot("t");
	const first = encodeBounded(boundedSnapshot(open.sequence, open.projection, WEB) as never);
	const firstBytes = JSON.stringify(first).length;
	const fullBytes = JSON.stringify(encodeItem(snapshotItem(open.sequence, open.projection, { ...WEB, bounded: false, compactIds: false }) as never)).length;
	const filter = subscriberFilter(WEB);
	let items = 0;
	let snapshots = 0;
	let bytes = 0;
	let largest = 0;
	const stop = bridge.subscribeThread("t", open.sequence, (update) => {
		const batch: ThreadStreamItem[] = update.kind === "snapshot" ? [snapshotItem(update.sequence, update.projection, WEB)] : [...update.items];
		for (const item of batch) {
			const size = JSON.stringify(encodeItem(filter(item) as never)).length;
			items++;
			if (item.kind === "snapshot") snapshots++;
			bytes += size;
			largest = Math.max(largest, size);
		}
	});
	await sleep(200);
	items = 0; snapshots = 0; bytes = 0; largest = 0;

	const cpu0 = process.cpuUsage();
	const t0 = performance.now();
	fixture.model.append(async () => fauxAssistantMessage("word ".repeat(REPLY_WORDS)));
	await bridge.sendMessage({ threadId: "t", commandId: "final", messageId: "final", text: "One more.", mode: "start" });
	await idle();
	await sleep(200);
	const wallMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	stop();

	const { projection } = await bridge.projection("t");
	console.log(JSON.stringify({
		turns: TURNS,
		turnItems: projection.turnItems.length,
		fillSeconds: +(fillMs / 1000).toFixed(1),
		open: { boundedSnapshotBytes: firstBytes, fullSnapshotBytes: fullBytes },
		streamedReply: { wallMs: Math.round(wallMs), cpuMs: Math.round((cpu.user + cpu.system) / 1000), items, snapshots, totalWireBytes: bytes, largestItemBytes: largest },
		snapshotReasons: reasons,
		heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e6),
	}, null, 2));

	await bridge.close();
	await rm(scratch, { recursive: true, force: true });
});
