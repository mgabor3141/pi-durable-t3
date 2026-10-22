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
	// The web app reads the child's status bar from a root node with no run (as Claude's children have).
	expect(child.nodes.find((n: Any) => n.kind === "root_turn" && n.runId === null)).toMatchObject({ status: "completed" });

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
	await expect(bridge.createThread({ threadId: childThreadId, projectId: "p" })).rejects.toThrow(/reserved for subagents/);
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

it("the card, the turn item and the child's root node time the call by its task, not by the parent's message", async () => {
	const { bridge, fixture } = await delegated([delegate(), async () => fauxAssistantMessage("word ".repeat(80)), async () => fauxAssistantMessage("done")], { slow: true });
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	await until("the end is read", async () => (await bridge.projection("t")).projection.subagents[0]!.completedAt !== null);
	const { projection } = await bridge.projection("t");
	const card = subagentItem(projection);
	const subagent = projection.subagents[0] as Any;
	const node = projection.nodes.find((n: Any) => n.id === subagent.id) as Any;
	const ms = (t: Any) => t.epochMilliseconds as number;
	const span = ms(subagent.completedAt) - ms(subagent.startedAt);
	// The child streamed for seconds: the span is the task's, not the 0 ms between a message's stamps.
	expect(span).toBeGreaterThan(1000);
	for (const timed of [node, card]) {
		expect([ms(timed.startedAt), ms(timed.completedAt)]).toEqual([ms(subagent.startedAt), ms(subagent.completedAt)]);
	}
	// The child's thread is created when the task started, and its root node spans the same pair.
	// The task's end can land a moment after its result is visible: the bridge reads it again.
	await until("the end is read", async () => ms(((await bridge.projection(card.childThreadId)).projection.nodes.find((n: Any) => n.kind === "root_turn" && n.runId === null) as Any).completedAt) - ms(subagent.startedAt) > 1000);
	const child = (await bridge.projection(card.childThreadId)).projection;
	expect(ms(child.thread.createdAt)).toBe(ms(subagent.startedAt));
	const root = child.nodes.find((n: Any) => n.kind === "root_turn" && n.runId === null) as Any;
	expect([ms(root.startedAt), ms(root.completedAt)]).toEqual([ms(subagent.startedAt), ms(subagent.completedAt)]);
}, 60_000);

it("a stopped subagent's card has no result, a failed one's has the error without pi's harness wrapper", async () => {
	const stopped = await delegated([delegate(), slowAnswer()], { slow: true });
	await stopped.bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the running card", async () => subagentItem((await stopped.bridge.projection("t")).projection)?.status === "running");
	await until("the child runs", async () => (await stopped.bridge.projection(subagentItem((await stopped.bridge.projection("t")).projection).childThreadId)).projection.runs.at(-1)?.status === "running");
	await stopped.bridge.interrupt("t");
	await until("the card stops", async () => ["cancelled", "interrupted"].includes(subagentItem((await stopped.bridge.projection("t")).projection)?.status));
	const card = subagentItem((await stopped.bridge.projection("t")).projection);
	expect(card.result).toBeNull();
	expect((await stopped.bridge.projection("t")).projection.subagents[0]!.result).toBeNull();

	const failed = await delegated([delegate(), async () => fauxAssistantMessage("x", { stopReason: "error", errorMessage: "boom" }), async () => fauxAssistantMessage("done")]);
	await failed.bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card fails", async () => subagentItem((await failed.bridge.projection("t")).projection)?.status === "failed");
	const result = subagentItem((await failed.bridge.projection("t")).projection).result as string;
	expect(result).toContain("The subagent did not finish");
	expect(result).not.toContain("<harness>");
}, 60_000);

it("a subagent's thread has no provider session or thread, so 'Disconnect agent session' is not offered", async () => {
	const { bridge } = await delegated([delegate(), async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("done")]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	const childThreadId = subagentItem((await bridge.projection("t")).projection).childThreadId as string;
	const child = (await bridge.projection(childThreadId)).projection;
	expect(child.providerSessions).toEqual([]);
	expect(child.providerThreads).toEqual([]);
	expect(child.thread.activeProviderThreadId).toBeNull();
	const shell = (bridge.shellSnapshot().threads as Any[]).find((s) => s.id === childThreadId);
	expect(shell.activeProviderThreadId).toBeNull();
	expect(child.messages.length).toBeGreaterThan(0);
});

it("a client cannot create a thread whose id is a derived subagent id, even one no child has", async () => {
	const { fixture, bridge } = await delegated([]);
	await expect(bridge.createThread({ threadId: "x.sub.3", projectId: "p" })).rejects.toThrow(/reserved for subagents/);
	await expect(bridge.launchThread({ threadId: "x.sub.3", projectId: "p", text: "hi" } as Any)).rejects.toThrow(/reserved for subagents/);
	expect((await fixture.threads.list()).map((t) => t.threadId)).toEqual(["t"]);
});

it("discovery scans everything once at boot, then only a thread whose view names an unseen child; a deleted parent takes its children", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }], extensions: [Subagent], responses: [delegate(), async () => fauxAssistantMessage("7"), async () => fauxAssistantMessage("done")] });
	await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p", title: "Parent" });
	const scans: (string | undefined)[] = [];
	const original = fixture.threads.subagents.bind(fixture.threads);
	fixture.threads.subagents = async (only?: string) => {
		scans.push(only);
		return original(only);
	};
	const bridge = await boot(fixture);
	expect(scans).toEqual([undefined]);
	await bridge.createThread({ threadId: "u1", projectId: "p" });
	await bridge.createThread({ threadId: "u2", projectId: "p" });
	await bridge.renameThread("u1", "renamed");
	await sleep(200);
	// Directory changes (create, rename) cost no scan.
	expect(scans).toEqual([undefined]);

	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	const childThreadId = subagentItem((await bridge.projection("t")).projection).childThreadId as string;
	await sleep(200);
	// Only the parent was scanned, for the new child (and once more for its end).
	expect(scans.slice(1).every((only) => only === "t")).toBe(true);
	expect(scans.length).toBeLessThanOrEqual(4);
	const settledScans = scans.length;
	await bridge.projection("t");
	await sleep(200);
	expect(scans.length).toBe(settledScans);

	await bridge.deleteThread("t");
	// At once: no waiting for a publish.
	expect(bridge.hasThread(childThreadId)).toBe(false);
	expect((bridge.shellSnapshot().threads as Any[]).some((s) => s.id === childThreadId)).toBe(false);
}, 30_000);

it("an empty child answer gives the tool a non-empty output", async () => {
	const { bridge } = await delegated([delegate(), async () => fauxAssistantMessage(""), async () => fauxAssistantMessage("done")]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "delegate", mode: "start" });
	await until("the card settles", async () => subagentItem((await bridge.projection("t")).projection)?.status === "completed");
	expect(subagentItem((await bridge.projection("t")).projection).result).toBe("(the subagent returned no text)");
}, 30_000);
