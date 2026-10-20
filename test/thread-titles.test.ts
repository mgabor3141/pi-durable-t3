// Thread titles (T3's Orchestrator `titleSeed` / `thread.metadata.update` / `thread.title.regeneration.complete` and
// ThreadTitleRegenerationService), driven on a real in-process `Bridge` over the chord objects with a scripted
// `titleThread` hook: the seed on the first message only, the hook's request, renames (cancelling an in-flight
// request), regenerate with and without the hook, "New thread" ignored, a restart, and launch titles.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { createHost, type Host } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import type { Threads } from "../src/threads.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { TitleThread, TitleThreadRequest } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { scheduledTaskDispatch } from "../src/t3/scheduled-tasks.ts";
import { USER_ENTRY_KINDS } from "../src/t3/runs.ts";
import { conversation, makeThreads, restart, type ThreadsFixture } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const warnings: string[] = [];
const log: Logger = { info: () => {}, warn: (message) => void warnings.push(message) };

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await test())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(20);
	}
}

/** A hook whose calls the test answers by hand. */
function manualHook() {
	const calls: { request: TitleThreadRequest; resolve: (title: string | undefined) => void; reject: (error: Error) => void }[] = [];
	const hook: TitleThread = (request) =>
		new Promise((resolve, reject) => {
			calls.push({ request, resolve, reject });
		});
	return { hook, calls };
}

async function start(fixture: ThreadsFixture, threads: Threads, titleThread?: TitleThread): Promise<{ bridge: Bridge; host: Host }> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-titles-"));
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{
			host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60,
			settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry,
			...(titleThread === undefined ? {} : { titleThread }),
		},
		log,
		host,
	);
	bridge.start();
	await bridge.loaded().catch(() => {});
	onTestFinished(async () => {
		await bridge.close();
		await host.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return { bridge, host };
}

const MODEL = { model: "faux/faux-1" };
const shell = (bridge: Bridge, threadId: string) => bridge.shellSnapshot().threads.find((t) => (t.id as string) === threadId) as unknown as { title: string; titleRegeneration: unknown };
const send = (bridge: Bridge, threadId: string, n: number, titleSeed?: string) =>
	bridge.sendMessage({ threadId, commandId: `c${n}`, messageId: `m${n}`, text: `hello ${n}`, mode: "queue", ...(titleSeed === undefined ? {} : { titleSeed }) });

async function newThread(bridge: Bridge, threadId = "t1"): Promise<string> {
	await bridge.createThread({ threadId, projectId: "p" });
	await bridge.applySelection(threadId, MODEL);
	return threadId;
}

it("seeds the title on the first message only, asks the hook at the first user entry, and applies its answer", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(...Array.from({ length: 4 }, () => fauxAssistantMessage("pong")));
	const { hook, calls } = manualHook();
	const { bridge } = await start(fixture, fixture.threads, hook);
	const threadId = await newThread(bridge);
	expect(shell(bridge, threadId).title).toBe("New thread");

	await send(bridge, threadId, 1, "Seed title");
	expect(shell(bridge, threadId).title).toBe("Seed title");
	expect(shell(bridge, threadId).titleRegeneration).toMatchObject({ requestId: "c1" });
	await until("the hook call", () => calls.length === 1);
	const request = calls[0]!.request;
	expect(request).toMatchObject({ threadId, reason: "first-message" });
	expect(request.previousTitle).toBeUndefined();
	const head = (await fixture.threads.thread(threadId))!.head;
	expect(request.conversationId).toBe(head);
	const entries = (await (await conversation(fixture.harness, head)).context(ctx)).entries;
	const firstUser = entries.find((entry) => USER_ENTRY_KINDS.has(entry.kind))!;
	expect(request.at).toBe(firstUser.id);

	calls[0]!.resolve("  Generated title ");
	await until("the generated title", () => shell(bridge, threadId).title === "Generated title");
	expect(shell(bridge, threadId).titleRegeneration).toBeNull();
	expect((await fixture.threads.thread(threadId))!.title).toBe("Generated title");

	// A later message's seed changes nothing and asks nothing.
	await until("the first reply", async () => (await bridge.projection(threadId)).projection.messages.length >= 2);
	await send(bridge, threadId, 2, "Another seed");
	await sleep(200);
	expect(shell(bridge, threadId).title).toBe("Generated title");
	expect(calls).toHaveLength(1);
}, 30_000);

it("a rename is durable and cancels an in-flight generation (abort fires, the late result is ignored)", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(fauxAssistantMessage("pong"));
	const { hook, calls } = manualHook();
	const { bridge } = await start(fixture, fixture.threads, hook);
	const threadId = await newThread(bridge);
	await send(bridge, threadId, 1, "Seed");
	await until("the hook call", () => calls.length === 1);
	const { signal } = calls[0]!.request;
	expect(signal.aborted).toBe(false);

	await bridge.updateThreadMetadata({ commandId: "r1", threadId, title: "  My name " });
	expect(signal.aborted).toBe(true);
	expect(shell(bridge, threadId)).toMatchObject({ title: "My name", titleRegeneration: null });
	calls[0]!.resolve("Too late");
	await sleep(100);
	expect(shell(bridge, threadId).title).toBe("My name");
	expect((await fixture.threads.thread(threadId))!.title).toBe("My name");
	await expect(bridge.updateThreadMetadata({ commandId: "r2", threadId, title: "  " })).rejects.toThrow(/empty/);
	await expect(bridge.updateThreadMetadata({ commandId: "r3", threadId, linkedPullRequest: { number: 1 } })).rejects.toThrow(/pull requests/);
	await expect(bridge.updateThreadMetadata({ commandId: "r4", threadId, branch: "main" })).rejects.toThrow(/not supported/);
}, 30_000);

it("regenerate asks with the latest entry and the previous title; 'New thread', the same title, and a failure change nothing", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(fauxAssistantMessage("pong"));
	const { hook, calls } = manualHook();
	const { bridge } = await start(fixture, fixture.threads, hook);
	const threadId = await newThread(bridge);
	await send(bridge, threadId, 1, "Seed");
	await until("the hook call", () => calls.length === 1);
	calls[0]!.resolve("New thread");
	await until("the request completes", () => shell(bridge, threadId).titleRegeneration === null);
	expect(shell(bridge, threadId).title).toBe("Seed");
	await until("the reply", async () => (await bridge.projection(threadId)).projection.messages.length >= 2);

	await bridge.updateThreadMetadata({ commandId: "g1", threadId, regenerateTitle: true });
	expect(shell(bridge, threadId).titleRegeneration).toMatchObject({ requestId: "g1" });
	await until("the regenerate call", () => calls.length === 2);
	const head = (await fixture.threads.thread(threadId))!.head;
	const entries = (await (await conversation(fixture.harness, head)).context(ctx)).entries;
	expect(calls[1]!.request).toMatchObject({ reason: "regenerate", previousTitle: "Seed", at: entries.at(-1)!.id, conversationId: head });
	calls[1]!.resolve("Seed");
	await until("the same title completes", () => shell(bridge, threadId).titleRegeneration === null);
	expect(shell(bridge, threadId).title).toBe("Seed");

	await bridge.updateThreadMetadata({ commandId: "g2", threadId, regenerateTitle: true });
	await until("the second regenerate call", () => calls.length === 3);
	calls[2]!.reject(new Error("model down"));
	await until("the failure completes", () => shell(bridge, threadId).titleRegeneration === null);
	expect(shell(bridge, threadId).title).toBe("Seed");
	expect(warnings).toContain("Thread title generation failed");

	// A newer request supersedes an older one; `regenerateTitle: false` clears it.
	await bridge.updateThreadMetadata({ commandId: "g3", threadId, regenerateTitle: true });
	await until("the g3 call", () => calls.length === 4);
	await bridge.updateThreadMetadata({ commandId: "g4", threadId, regenerateTitle: true });
	await until("the g4 call", () => calls.length === 5);
	expect(calls[3]!.request.signal.aborted).toBe(true);
	calls[3]!.resolve("Stale");
	calls[4]!.resolve("Fresh title");
	await until("the fresh title", () => shell(bridge, threadId).title === "Fresh title");
	await bridge.updateThreadMetadata({ commandId: "g5", threadId, regenerateTitle: true });
	await until("the call", () => calls.length === 6);
	await bridge.updateThreadMetadata({ commandId: "g6", threadId, regenerateTitle: false });
	expect(calls[5]!.request.signal.aborted).toBe(true);
	expect(shell(bridge, threadId).titleRegeneration).toBeNull();
}, 30_000);

it("without a hook: the seed and renames work, regenerate is refused, nothing is pending", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(fauxAssistantMessage("pong"));
	const { bridge } = await start(fixture, fixture.threads);
	const threadId = await newThread(bridge);
	await send(bridge, threadId, 1, "Seed only");
	expect(shell(bridge, threadId)).toMatchObject({ title: "Seed only", titleRegeneration: null });
	await expect(bridge.updateThreadMetadata({ commandId: "g1", threadId, regenerateTitle: true })).rejects.toThrow(/no title generator/);
	await bridge.renameThread(threadId, "Renamed");
	expect(shell(bridge, threadId).title).toBe("Renamed");
}, 30_000);

it("a restart keeps the title and shows no generation in progress", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(fauxAssistantMessage("pong"));
	const { hook, calls } = manualHook();
	const first = await start(fixture, fixture.threads, hook);
	const threadId = await newThread(first.bridge);
	await send(first.bridge, threadId, 1, "Before restart");
	await until("the hook call", () => calls.length === 1);
	expect(shell(first.bridge, threadId).titleRegeneration).not.toBeNull();
	await first.bridge.close();
	await first.host.close();

	const reopened = await restart(fixture);
	onTestFinished(async () => void (await reopened.harness.close(ctx).catch(() => {})));
	const second = await start(fixture, reopened.threads, hook);
	await until("the directory", () => second.bridge.hasThread(threadId));
	expect(shell(second.bridge, threadId)).toMatchObject({ title: "Before restart", titleRegeneration: null });
}, 30_000);

it("a launch stores its title; generateTitle seeds a generation; a scheduled task's launch keeps its title", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	fixture.model.respond(...Array.from({ length: 4 }, () => fauxAssistantMessage("pong")));
	const { hook, calls } = manualHook();
	const { bridge } = await start(fixture, fixture.threads, hook);

	const plain = await bridge.launchThread({ commandId: "l1", threadId: "launched", projectId: "p", title: "Launch title", modelSelection: MODEL });
	expect(shell(bridge, plain)).toMatchObject({ title: "Launch title", titleRegeneration: null });

	const seeded = await bridge.launchThread({
		commandId: "l2", threadId: "seeded", projectId: "p", title: "Draft title", generateTitle: true, modelSelection: MODEL,
		initialMessage: { messageId: "lm2", text: "do the thing" },
	});
	expect(shell(bridge, seeded)).toMatchObject({ title: "Draft title", titleRegeneration: { requestId: "l2" } });
	await until("the hook call", () => calls.length === 1);
	expect(calls[0]!.request).toMatchObject({ threadId: "seeded", reason: "first-message" });
	calls[0]!.resolve("Thing doing");
	await until("the generated title", () => shell(bridge, seeded).title === "Thing doing");

	await scheduledTaskDispatch(bridge).launch({ commandId: "s1", messageId: "sm1", projectId: "p", title: "Nightly report", text: "report", modelSelection: MODEL as never });
	const scheduled = bridge.shellSnapshot().threads.find((t) => (t as unknown as { title: string }).title === "Nightly report");
	expect(scheduled).toBeDefined();
	await sleep(100);
	expect(calls).toHaveLength(1);
}, 30_000);
