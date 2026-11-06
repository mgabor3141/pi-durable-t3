// Command receipts (T3's `CommandReceiptStore`, one store for the host): a dispatched command the host accepted answers a
// retry with the same sequence — after a lost ack, and after a restart — instead of running again; a refused command
// keeps no receipt; a duplicate in flight joins the first.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { clientProvenance, type DispatchCommand, dispatchCommand } from "../src/t3/dispatch.ts";
import type { Logger } from "../src/t3/logging.ts";
import type { ProjectRegistry } from "../src/registry.ts";
import type { Threads } from "../src/threads.ts";
import type { Models } from "@earendil-works/pi-ai";
import { makeThreads, restart } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const USER = { createdBy: "user", creationSource: "web" } as const;

async function boot(threads: Threads, registry: ProjectRegistry, models: Models): Promise<Bridge> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-receipts-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry }, log, threads, models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return bridge;
}

const command = (value: Record<string, unknown>) => value as unknown as DispatchCommand;

it("a retried command answers its first sequence, across a restart, and runs once", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const bridge = await boot(f.threads, f.registry, f.model.models);
	await dispatchCommand(bridge, command({ type: "thread.create", commandId: "c-create", threadId: "t", projectId: "p", title: "T", modelSelection: { instanceId: "pi", model: "faux/faux-1" }, createdAt: new Date().toISOString() }), USER, log);
	const first = await dispatchCommand(bridge, command({ type: "thread.delete", commandId: "c-delete", threadId: "t" }), USER, log);
	expect(await dispatchCommand(bridge, command({ type: "thread.delete", commandId: "c-delete", threadId: "t" }), USER, log), "a retry is answered, not run again").toBe(first);
	await expect(dispatchCommand(bridge, command({ type: "thread.delete", commandId: "c-other", threadId: "t" }), USER, log), "a new command does run").rejects.toThrow();

	await bridge.close();
	const reopened = await restart(f);
	onTestFinished(async () => void (await reopened.harness.close(BACKGROUND_CONTEXT).catch(() => {})));
	const again = await boot(reopened.threads, reopened.registry, f.model.models);
	expect(await dispatchCommand(again, command({ type: "thread.delete", commandId: "c-delete", threadId: "t" }), USER, log), "the receipt survives a restart").toBe(first);
}, 30_000);

it("a refused command keeps no receipt, and duplicates in flight run once", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const bridge = await boot(f.threads, f.registry, f.model.models);
	await expect(dispatchCommand(bridge, command({ type: "thread.settle", commandId: "c-settle", threadId: "missing" }), USER, log)).rejects.toThrow();
	await dispatchCommand(bridge, command({ type: "thread.create", commandId: "c-create", threadId: "missing", projectId: "p", title: "T", modelSelection: { instanceId: "pi", model: "faux/faux-1" }, createdAt: new Date().toISOString() }), USER, log);
	const retried = await dispatchCommand(bridge, command({ type: "thread.settle", commandId: "c-settle", threadId: "missing" }), USER, log);
	expect(typeof retried, "the refused command ran again once its thread existed").toBe("number");
	expect((await f.threads.list()).find((thread) => thread.threadId === "missing")?.settledOverride).toBe("settled");

	const [a, b] = await Promise.all([
		dispatchCommand(bridge, command({ type: "thread.unsettle", commandId: "c-twice", threadId: "missing" }), USER, log),
		dispatchCommand(bridge, command({ type: "thread.unsettle", commandId: "c-twice", threadId: "missing" }), USER, log),
	]);
	expect(a, "the duplicate joined the first").toBe(b);
	expect(await f.threads.receipt("c-twice"), "one receipt, with the answer both got").toBe(a);
}, 30_000);

// T3's "stamps authoritative provenance on commands that create threads or messages" (ThreadManagementService.test.ts),
// through the /ws path: a client names its surface but is always the user, and cannot claim a linked environment's
// origin or a parent there — only the server stamps those.
it("a client's thread.create is the user's, and cannot claim a link origin or a delegating parent", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const bridge = await boot(f.threads, f.registry, f.model.models);
	const forged = command({
		type: "thread.create",
		commandId: "c-forged",
		threadId: "t-forged",
		projectId: "p",
		title: "T",
		modelSelection: { instanceId: "pi", model: "faux/faux-1" },
		createdBy: "agent",
		creationSource: "mcp",
		linkOrigin: { sessionId: "forged", label: "Somewhere else" },
		delegatedFrom: { environmentId: "environment:elsewhere", threadId: "thread:elsewhere", title: "Somewhere else" },
		createdAt: new Date().toISOString(),
	});
	await dispatchCommand(bridge, forged, clientProvenance(forged), log);
	const record = (await f.threads.list()).find((thread) => thread.threadId === "t-forged")!;
	expect({ createdBy: record.createdBy, creationSource: record.creationSource }).toEqual({ createdBy: "user", creationSource: "mcp" });
	expect(record.linkOrigin).toBeUndefined();
	expect(record.delegatedFrom).toBeUndefined();
}, 30_000);
