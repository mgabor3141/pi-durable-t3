// Subagents through the bridge: a tool call whose details name a conversation its own task owns is projected as T3's
// provider-native subagent — a card in the parent, an entry in `subagents[]`, and a read-only child thread linked to the
// parent — using the example agent's `subagent` tool (faux model). The child is derived from the conversation (nothing is
// stored), is never a thread of the threads document, takes no writes, and survives a restart.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Subagent } from "../examples/coding-agent/src/subagent.ts";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import type { Threads } from "../src/threads.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { PI_CAPABILITIES } from "../src/t3/capabilities.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, makeThreads, restart, type ThreadsFixture } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;
const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// biome-ignore lint/suspicious/noExplicitAny: wire shapes are branded strings
type Any = any;

const delegate = (): FauxResponseStep => async () =>
	fauxAssistantMessage([fauxToolCall("subagent", { prompt: "Name a prime.", description: "primes" }, { id: "call-1" })], { stopReason: "toolUse" });

async function boot(fixture: ThreadsFixture, threads: Threads = fixture.threads): Promise<Bridge> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-subagents-"));
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry },
		log,
		host,
	);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await host.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return bridge;
}

async function until(what: string, test: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (await test()) return;
		await sleep(30);
	}
	throw new Error(`timed out: ${what}`);
}

const subagentItem = (projection: Any) => projection.turnItems.find((item: Any) => item.type === "subagent");

/** A child answer that streams slowly enough to observe (and interrupt) a running subagent. */
const slowAnswer = (): FauxResponseStep => async () => fauxAssistantMessage("word ".repeat(400));

async function delegated(steps: FauxResponseStep[], options: { slow?: boolean } = {}) {
	const fixture = await makeThreads({ projects: [{ id: "p" }], extensions: [Subagent], responses: steps, ...(options.slow === true ? { tokensPerSecond: 40 } : {}) });
	await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p", title: "Parent" });
	const bridge = await boot(fixture);
	return { fixture, bridge };
}

it("a subagent call is a provider-native card with a read-only child thread linked to the parent", async () => {
	const { fixture, bridge } = await delegated([delegate(), async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("The subagent said 7.")]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the parent's answer", async () => (await bridge.projection("t")).projection.messages.some((m: Any) => m.text === "The subagent said 7."));
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");

	const { projection } = await bridge.projection("t");
	const card = subagentItem(projection);
	// The card replaces the plain tool item.
	expect(projection.turnItems.some((item: Any) => item.type === "dynamic_tool")).toBe(false);
	expect(projection.subagents).toHaveLength(1);
	const subagent = projection.subagents[0] as Any;
	const childThreadId = subagent.childThreadId as string;
	expect(childThreadId).toMatch(/^t\.sub\.\d+$/);
	expect(subagent).toMatchObject({ origin: "provider_native", createdBy: "agent", driver: "pi", status: "completed", prompt: "Name a prime.", title: "primes", result: "7", threadId: "t" });
	expect(card).toMatchObject({ type: "subagent", subagentId: subagent.id, childThreadId, prompt: "Name a prime.", result: "7", status: "completed", origin: "provider_native" });
	expect(projection.nodes.find((n: Any) => n.id === subagent.id)).toMatchObject({ kind: "subagent", status: "completed", parentNodeId: card.nodeId === subagent.id ? projection.runs[0]!.rootNodeId : undefined });

	// The shell carries the child: lineage and creation source make the web app read-only and hide it from the sidebar.
	const shells = bridge.shellSnapshot().threads as Any[];
	const childShell = shells.find((s) => s.id === childThreadId);
	expect(childShell).toMatchObject({ lineage: { parentThreadId: "t", relationshipToParent: "subagent", rootThreadId: "t" }, creationSource: "provider", createdBy: "agent", title: "primes", projectId: "p" });

	// The child's own projection: its conversation, authored by the parent's agent.
	expect(bridge.hasThread(childThreadId)).toBe(true);
	const child = (await bridge.projection(childThreadId)).projection;
	expect(child.thread).toMatchObject({ creationSource: "provider", lineage: { parentThreadId: "t", relationshipToParent: "subagent" } });
	expect(child.messages.map((m: Any) => [m.role, m.text])).toEqual([["user", "Name a prime."], ["assistant", "7"]]);
	expect(child.messages[0]).toMatchObject({ createdBy: "agent", senderThreadId: "t" });

	// Never a thread of the threads document.
	expect((await fixture.threads.list()).map((t) => t.threadId)).toEqual(["t"]);

	// The capabilities say so.
	expect(PI_CAPABILITIES.subagents).toMatchObject({ supportsSubagents: true, exposesSubagentThreadIds: true, emitsSubagentLifecycle: true, canWaitForSubagents: false, canCloseSubagents: false, canForkSubagentThread: false });
}, 30_000);

it("every command that writes to a subagent's thread is refused, and changes nothing", async () => {
	const { fixture, bridge } = await delegated([delegate(), async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("done")]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	const childThreadId = subagentItem((await bridge.projection("t")).projection).childThreadId as string;
	const before = (await bridge.projection(childThreadId)).projection.messages.length;

	const refused = /subagent's thread/;
	await expect(bridge.sendMessage({ threadId: childThreadId, commandId: "c2", messageId: "m2", text: "hi", mode: "start" })).rejects.toThrow(refused);
	await expect(bridge.interrupt(childThreadId)).rejects.toThrow(refused);
	await expect(bridge.rollback({ threadId: childThreadId, commandId: "c3", checkpointId: "cp-baseline", restoreFiles: false })).rejects.toThrow(refused);
	await expect(bridge.renameThread(childThreadId, "x")).rejects.toThrow(refused);
	await expect(bridge.deleteThread(childThreadId)).rejects.toThrow(refused);
	await expect(bridge.applySelection(childThreadId, { model: "faux/faux-1" })).rejects.toThrow(refused);
	await expect(bridge.updateThreadMetadata({ commandId: "c4", threadId: childThreadId, title: "x" })).rejects.toThrow(refused);
	await expect(bridge.createThread({ threadId: childThreadId, projectId: "p" })).rejects.toThrow(refused);
	await sleep(100);
	expect((await bridge.projection(childThreadId)).projection.messages.length).toBe(before);
	expect((await fixture.threads.list()).map((t) => t.threadId)).toEqual(["t"]);
}, 30_000);

it("a running subagent keeps the parent busy; stopping the parent stops the child", async () => {
	const { bridge } = await delegated([delegate(), slowAnswer()], { slow: true });
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the running card", async () => subagentItem((await bridge.projection("t")).projection)?.status === "running");
	const parent = await bridge.projection("t");
	const card = subagentItem(parent.projection);
	expect(parent.projection.subagents[0]).toMatchObject({ status: "running", result: null, completedAt: null });
	expect(parent.projection.runs.at(-1)!.status).toBe("running");
	await until("the child is running", async () => (bridge.shellSnapshot().threads as Any[]).some((s) => s.id === card.childThreadId));
	await until("the child's run", async () => (await bridge.projection(card.childThreadId)).projection.runs.at(-1)?.status === "running");

	await bridge.interrupt("t");
	await until("the parent stops", async () => (await bridge.projection("t")).projection.runs.at(-1)!.status !== "running");
	await until("the child stops", async () => {
		const run = (await bridge.projection(card.childThreadId)).projection.runs.at(-1);
		return run !== undefined && run.status !== "running";
	});
	await until("the card ends", async () => ["cancelled", "interrupted", "failed"].includes(subagentItem((await bridge.projection("t")).projection)?.status));
}, 30_000);

it("a restart mid-subagent reattaches to the same child", async () => {
	const { fixture, bridge } = await delegated([delegate(), slowAnswer()], { slow: true });
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the running card", async () => subagentItem((await bridge.projection("t")).projection)?.status === "running");
	const childThreadId = subagentItem((await bridge.projection("t")).projection).childThreadId as string;
	const owned = async (harness: Harness) => harness.commit(async (tx) => (await tx.scanConversations({}, 50)).items.filter((c) => c.owner !== undefined).length, ctx);
	expect(await owned(fixture.harness)).toBe(1);
	await bridge.close();

	// The crash: the Harness reopens over the same storage; the safe tool replays and finds its child.
	const up = await restart(fixture);
	fixture.model.respond(async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("The subagent said 7."));
	const again = await boot(fixture, up.threads);
	// A cold client opening the child's URL: the shell already has it, and its thread opens.
	expect(again.hasThread(childThreadId)).toBe(true);
	up.harness.resume();
	await until("the replayed call settles", async () => subagentItem((await again.projection("t")).projection)?.status === "completed");
	const settled = (await again.projection("t")).projection;
	expect(subagentItem(settled).childThreadId).toBe(childThreadId);
	expect(await owned(up.harness)).toBe(1);
	expect(settled.subagents[0]!.result).toBe("7");
	await up.harness.close(ctx);
}, 60_000);

it("undo past the call hides the card; the child thread stays, read-only", async () => {
	const { bridge } = await delegated([delegate(), async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("done")]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	const childThreadId = subagentItem((await bridge.projection("t")).projection).childThreadId as string;

	await bridge.rollback({ threadId: "t", commandId: "c2", checkpointId: "cp-baseline", restoreFiles: false });
	await until("the run is rolled back", async () => (await bridge.projection("t")).projection.runs.every((run) => run.status === "rolled_back"));
	const { projection } = await bridge.projection("t");
	expect(projection.visibleTurnItems.some((entry) => entry.item.type === "subagent")).toBe(false);
	expect(projection.subagents).toEqual([]);
	// The child outlives the undo, as T3's children do, and is still the parent's and still read-only.
	await until("the child is still known", async () => bridge.hasThread(childThreadId));
	expect(bridge.isSubagentThread(childThreadId)).toBe(true);
	await expect(bridge.sendMessage({ threadId: childThreadId, commandId: "c3", messageId: "m3", text: "hi", mode: "start" })).rejects.toThrow(/subagent's thread/);
}, 30_000);
