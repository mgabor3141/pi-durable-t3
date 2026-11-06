// Undo, as T3 shows it: the reverted runs stay in the projection marked rolled back, and the thread carries the last
// rollback's outcome. Both are read from what is stored — the undo record names the head it left, whose runs are the
// rolled-back ones — so they survive a restart and a chain of undos.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import type { ProjectRegistry } from "../src/registry.ts";
import type { Threads } from "../src/threads.ts";
import { createNamed, makeThreads, restart } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(threads: Threads, registry: ProjectRegistry, models: Models): Promise<Bridge> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-rollback-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry }, log, threads, models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return bridge;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
	for (let i = 0; i < 300; i++) {
		const value = await read();
		if (done(value)) return value;
		await sleep(20);
	}
	throw new Error("timed out");
}

const statuses = async (bridge: Bridge) => {
	const { projection } = await bridge.projection("t");
	return Object.fromEntries(projection.runs.map((run) => [run.id, run.status]));
};

it("undone runs stay rolled back across a second undo and a restart, and the outcome is kept on the thread", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Undo" });
	const bridge = await boot(f.threads, f.registry, f.model.models);
	const idle = (b: Bridge) => until(() => b.projection("t"), ({ projection }) => projection.runs.length > 0 && projection.runs.every((run) => run.status !== "running"));
	const send = async (n: number) => {
		f.model.respond(fauxAssistantMessage(`answer ${n}`));
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text: `question ${n}`, mode: "start" });
		await idle(bridge);
	};
	await send(1);
	await send(2);
	const [first, second] = (await bridge.projection("t")).projection.runs;

	// Revert the second turn: it stays, rolled back.
	await bridge.rollback({ threadId: "t", commandId: "undo-1", checkpointId: first!.checkpointId!, restoreFiles: false });
	let runs = await until(() => statuses(bridge), (value) => value[second!.id] === "rolled_back");
	expect(runs[first!.id]).toBe("completed");
	expect((await bridge.projection("t")).projection.thread).toMatchObject({ rollbackRequestId: "undo-1", rollbackFailure: null });

	// A new turn, then revert everything: the first undo's run is still there, and both later runs join it.
	await send(3);
	const third = (await bridge.projection("t")).projection.runs.find((run) => run.status === "completed" && run.id !== first!.id)!;
	await bridge.rollback({ threadId: "t", commandId: "undo-2", checkpointId: "cp-baseline", restoreFiles: false });
	runs = await until(() => statuses(bridge), (value) => value[first!.id] === "rolled_back");
	expect(runs).toEqual({ [first!.id]: "rolled_back", [second!.id]: "rolled_back", [third.id]: "rolled_back" });

	// A refused rollback is kept on the thread with its reason.
	await bridge.rollback({ threadId: "t", commandId: "undo-3", checkpointId: "cp-baseline", restoreFiles: true });
	await until(() => bridge.projection("t"), ({ projection }) => projection.thread.rollbackRequestId === "undo-3");

	// A restart reads all of it back.
	await bridge.close();
	const reopened = await restart(f);
	onTestFinished(async () => void (await reopened.harness.close(BACKGROUND_CONTEXT).catch(() => {})));
	const again = await boot(reopened.threads, reopened.registry, f.model.models);
	expect(await until(() => statuses(again), (value) => Object.keys(value).length === 3)).toEqual(runs);
	expect((await again.projection("t")).projection.thread).toMatchObject({ rollbackRequestId: "undo-3", rollbackFailure: { requestId: "undo-3", message: expect.stringContaining("does not restore files") } });
});
