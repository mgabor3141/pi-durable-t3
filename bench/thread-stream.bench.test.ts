// Baseline for the thread stream: what one long thread costs the bridge while a reply streams.
// Run: TMPDIR=<exec-able dir> npx vitest run --config bench/vitest.config.ts
// Not part of `pnpm test`: it measures, it does not assert.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { it } from "vitest";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { compactThreadProjection } from "../src/t3/compact.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, makeThreads } from "../test/threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TURNS = Number(process.env.BENCH_TURNS ?? 200);
const REPLY_WORDS = Number(process.env.BENCH_REPLY_WORDS ?? 3_000);

it(`thread stream baseline: ${TURNS} turns, then one streamed reply`, { timeout: 900_000 }, async () => {
	const prior = Array.from({ length: TURNS }, (_, i) => async () => fauxAssistantMessage(`Reply ${i}: ` + "lorem ipsum dolor sit amet ".repeat(12)));
	const fixture = await makeThreads({ projects: [{ id: "p" }], responses: prior, tokensPerSecond: 1_000 });
	await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p", title: "Bench" });
	const scratch = await mkdtemp(join(tmpdir(), "bench-"));
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry }, log, host);
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

	// Instrument: count emitted snapshots and their wire size while one reply streams.
	let snapshots = 0;
	let bytes = 0;
	let largest = 0;
	const stop = bridge.subscribeThread("t", ({ projection }) => {
		snapshots++;
		const size = JSON.stringify(compactThreadProjection(projection).projection).length;
		bytes += size;
		largest = Math.max(largest, size);
	});
	await sleep(200);
	snapshots = 0; bytes = 0; largest = 0;

	const cpu0 = process.cpuUsage();
	const t0 = performance.now();
	fixture.model.append(async () => fauxAssistantMessage("word ".repeat(REPLY_WORDS)));
	await bridge.sendMessage({ threadId: "t", commandId: "final", messageId: "final", text: "One more.", mode: "start" });
	await idle();
	const wallMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	stop();

	const { projection } = await bridge.projection("t");
	const p0 = performance.now();
	const reps = 20;
	for (let i = 0; i < reps; i++) JSON.stringify(compactThreadProjection(projection).projection);
	const serializeMs = (performance.now() - p0) / reps;

	console.log(JSON.stringify({
		turns: TURNS,
		turnItems: projection.turnItems.length,
		fillSeconds: +(fillMs / 1000).toFixed(1),
		streamedReply: { wallMs: Math.round(wallMs), cpuMs: Math.round((cpu.user + cpu.system) / 1000), snapshots, totalWireBytes: bytes, largestSnapshotBytes: largest, avgSnapshotBytes: snapshots ? Math.round(bytes / snapshots) : 0 },
		compactSerializeMs: +serializeMs.toFixed(2),
		heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1e6),
	}, null, 2));

	await bridge.close();
	await host.close();
	await rm(scratch, { recursive: true, force: true });
});
