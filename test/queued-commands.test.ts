// A `/compact` sent as a queued message while the agent works waits its turn (`queued-commands.ts`): it is a queued
// message like any other until it is the next one, then the run that ends compacts before the messages behind it go
// on. With no run to wait behind it compacts at once, as one sent any other way does; and it is never a prompt.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { bridgeConfig, conversation, createNamed, gated, idle, makeThreads, quietLog } from "./threads-harness.ts";
import { until } from "./wait.ts";

type Msg = { role: string; content: unknown };
const long = "x".repeat(60_000);

async function setup(install = true, extensions: readonly Extension[] = []) {
	const f = await makeThreads({ projects: [{ id: "p" }], extensions });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-queued-commands-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	if (install) f.tools.install(bridge.queuedCommands.extension());
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	let sent = 0;
	const send = (text: string, mode: "start" | "queue" | "steer" = "start") => bridge.sendMessage({ threadId: "t", commandId: `c${++sent}`, messageId: `m${sent}`, text, mode });
	/** The requests the model gets, as the roles and texts of their messages; a summary request is told apart. */
	const requests: string[][] = [];
	const raw: string[] = [];
	const answer = (text: string | (() => Promise<unknown>)) => (async (context: { messages: Msg[] }) => {
		const flat = context.messages.filter((message) => message.role !== "system").map((message) => `${message.role}:${(typeof message.content === "string" ? message.content : (message.content as { text?: string }[]).map((block) => block.text ?? "").join("")).slice(0, 40)}`);
		requests.push(flat);
		raw.push(JSON.stringify(context.messages));
		return typeof text === "string" ? fauxAssistantMessage(text) : await text();
	}) as never;
	const kinds = async () => (await (await conversation(f.harness, thread.head)).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)).items.map((entry) => entry.kind).filter((kind) => kind !== "pi.system");
	const queued = async () => (await bridge.projection("t")).projection.runs.filter((run) => run.status === "queued").map((run) => (run as unknown as { userMessageId: string }).userMessageId);
	return { f, bridge, thread, send, answer, requests, raw, kinds, queued };
}

it("waits behind the run and the messages queued before it, compacts, and then the messages behind it go on", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, send, answer, requests, raw, kinds, queued } = await setup();
	f.model.respond(answer("one" + long));
	await send("one");
	await idle(f.harness, thread.head);

	const working = gated("two" + long);
	f.model.respond(answer(working.step as never), answer("three"), answer("## Goal\nsummarized"), answer("four"));
	await send("two");
	await until("the run", () => requests.length === 2);
	await send("three", "queue");
	await send("/compact keep the names", "queue");
	await send("four", "queue");
	// Queued like any message: shown in the queue, in order, and no compaction has started.
	expect(await queued()).toEqual(["m3", "m4", "m5"]);
	expect(await kinds()).not.toContain("app.compact");

	working.release();
	await idle(f.harness, thread.head);
	await until("the thread to settle", async () => (await queued()).length === 0 && (await bridge.projection("t")).projection.runs.every((run) => run.status !== "running"));
	// The run for "three" ended, then the compaction, then "four": the command where it ran, never a prompt.
	expect(await kinds()).toEqual(["app.user", "pi.assistant", "app.user", "pi.assistant", "app.user", "pi.assistant", "app.compact", "pi.compaction", "app.user", "pi.assistant"]);
	expect(requests.flat().some((line) => line.startsWith("user:/compact")), "the model never saw /compact as a message").toBe(false);
	// The summary was asked for with the guidance, and "four" was answered on the compacted context.
	const last = requests.at(-1)!;
	expect(last[0]).toMatch(/^user:The conversation history before/);
	expect(last.at(-1)).toBe("user:four");
	expect(raw.some((request) => request.includes("keep the names")), "the guidance reached the summary's request").toBe(true);
	// T3 shows the command as the compaction's own run, with its card.
	const { projection } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["one", "two", "three", "/compact", "four"]);
	expect(projection.turnItems.filter((item) => (item as unknown as { type: string }).type === "compaction")).toHaveLength(1);
});

it("compacts at once with no run to wait behind, when it is sent as a steer, and when the host has not installed it", { timeout: 60_000 }, async () => {
	const idleThread = await setup();
	idleThread.f.model.respond(idleThread.answer("one" + long), idleThread.answer("two" + long), idleThread.answer("## Goal\nsummarized"));
	await idleThread.send("one");
	await idle(idleThread.f.harness, idleThread.thread.head);
	await idleThread.send("two");
	await idle(idleThread.f.harness, idleThread.thread.head);
	await idleThread.send("/compact", "queue");
	await until("the compaction", async () => (await idleThread.kinds()).includes("pi.compaction"));
	expect(await idleThread.queued()).toEqual([]);

	const bare = await setup(false);
	const working = gated("two" + long);
	bare.f.model.respond(bare.answer("one" + long));
	await bare.send("one");
	await idle(bare.f.harness, bare.thread.head);
	bare.f.model.respond(bare.answer(working.step as never), bare.answer("## Goal\nsummarized"));
	await bare.send("two");
	await until("the run", () => bare.requests.length === 2);
	await bare.send("/compact", "queue");
	expect(await bare.queued(), "not queued: the command is written and the compaction under way").toEqual([]);
	expect(await bare.kinds()).toContain("app.compact");
	working.release();
	await idle(bare.f.harness, bare.thread.head);
});

it("a queued /compact that is removed does nothing; one sent now compacts beside the run", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, send, answer, requests, kinds, queued } = await setup();
	// Two long answers, so a compaction has something to cut (it keeps the last 20k tokens).
	f.model.respond(answer("zero" + long), answer("one" + long));
	await send("zero");
	await idle(f.harness, thread.head);
	await send("one");
	await idle(f.harness, thread.head);
	const working = gated("two" + long);
	f.model.respond(answer(working.step as never), answer("## Goal\nsummarized"));
	await send("two");
	await until("the run", () => requests.length === 3);
	await send("/compact", "queue");
	await send("/compact", "queue");
	const [first, second] = (await bridge.projection("t")).projection.runs.filter((run) => run.status === "queued").map((run) => run.id as string);
	// Removed: gone from the queue, nothing compacts for it.
	await bridge.cancelQueued("t", first!);
	expect(await queued()).toEqual(["m5"]);
	// T3's "steer now" on the other: it compacts now, while the run still works.
	await bridge.promoteQueued("t", second!);
	expect(await queued()).toEqual([]);
	expect(await kinds()).toContain("app.compact");
	working.release();
	await until("the compaction", async () => (await kinds()).includes("pi.compaction"));
	await idle(f.harness, thread.head);
	expect((await kinds()).filter((kind) => kind === "pi.compaction")).toHaveLength(1);
	expect(requests.flat().some((line) => line.startsWith("user:/compact"))).toBe(false);
});

it("a queued /compact left behind a stopped run compacts when the queue is resumed, and the rest follow it", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, send, answer, requests, kinds, queued } = await setup();
	f.model.respond(answer("zero" + long), answer("one" + long));
	await send("zero");
	await idle(f.harness, thread.head);
	await send("one");
	await idle(f.harness, thread.head);
	const working = gated("two");
	f.model.respond(answer(working.step as never), answer("## Goal\nsummarized"), answer("three"));
	await send("two");
	await until("the run", () => requests.length === 3);
	await send("/compact", "queue");
	await send("/reload", "queue");
	await send("three", "queue");
	// Stop: the run ends without an answer, so nothing asks its end for a compaction; the queue is held.
	const stopped = f.threads.queue.abort({ threadId: "t", conversationId: thread.head });
	working.release();
	await stopped;
	expect(await queued()).toEqual(["m4", "m5", "m6"]);
	expect(await kinds()).not.toContain("app.compact");
	// T3's Resume starts the first queued message: the command, which compacts instead of being sent.
	await bridge.startQueued("t", undefined, "resume-1");
	await until("the compaction and the message behind it", async () => (await kinds()).includes("pi.compaction") && (await queued()).length === 0);
	await idle(f.harness, thread.head);
	const all = await kinds();
	expect(all.indexOf("pi.compaction")).toBeLessThan(all.lastIndexOf("app.user"));
	expect(requests.flat().some((line) => /^user:\/(compact|reload)/.test(line)), "the reload behind the compaction was no prompt either").toBe(false);
	expect(requests.at(-1)!.at(-1)).toBe("user:three");
	expect(all).toContain("app.reload");
});

it("a queued /reload renders the system prompt again for the message behind it, and not before", { timeout: 60_000 }, async () => {
	let rule = "Rule one.";
	// A section that keeps what the thread shows, as a host with a fixed prompt has them: only a reload renders it again.
	const prompted = defineExtension({ name: "rules", sections: [section("rules", (input) => input.shown["rules"] ?? rule, { tag: false })] });
	const { f, bridge, thread, send, answer, requests, raw, kinds, queued } = await setup(true, [prompted]);
	const working = gated("one");
	f.model.respond(answer(working.step as never), answer("two"), answer("three"));
	await send("one");
	await until("the run", () => requests.length === 1);
	rule = "Rule two.";
	await send("two", "queue");
	await send("/reload", "queue");
	await send("three", "queue");
	expect(await queued()).toEqual(["m2", "m3", "m4"]);
	working.release();
	await until("the queue to empty", async () => (await queued()).length === 0 && requests.length === 3);
	await idle(f.harness, thread.head);
	// "two" was answered on the prompt as it was; the reload ran at its turn, so "three" got the prompt rendered again.
	const prompt = (request: number) => JSON.stringify(getCurrentSystemMessage(JSON.parse(raw[request]!) as never));
	expect(prompt(1)).toContain("Rule one.");
	expect(prompt(2)).toContain("Rule two.");
	expect(prompt(2)).not.toContain("Rule one.");
	expect(await kinds()).toEqual(["app.user", "pi.assistant", "app.user", "pi.assistant", "app.reload", "app.user", "pi.assistant"]);
	expect(requests.flat().some((line) => line.startsWith("user:/reload")), "never a prompt").toBe(false);
	const { projection } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["one", "two", "/reload", "three"]);
});

it("commands queued one behind another are answered together: none is left to be placed as a prompt", { timeout: 60_000 }, async () => {
	let rule = "Rule one.";
	const prompted = defineExtension({ name: "rules", sections: [section("rules", (input) => input.shown["rules"] ?? rule, { tag: false })] });
	const { f, bridge, thread, send, answer, requests, kinds, queued } = await setup(true, [prompted]);
	f.model.respond(answer("zero" + long), answer("one" + long));
	await send("zero");
	await idle(f.harness, thread.head);
	await send("one");
	await idle(f.harness, thread.head);
	const working = gated("two");
	f.model.respond(answer(working.step as never), answer("## Goal\nsummarized"), answer("three"));
	await send("two");
	await until("the run", () => requests.length === 3);
	rule = "Rule two.";
	// A run asks its end's hooks once, so everything at the front of the queue is taken then.
	await send("/compact", "queue");
	await send("/reload", "queue");
	await send("/compact again", "queue");
	await send("three", "queue");
	expect(await queued()).toEqual(["m4", "m5", "m6", "m7"]);
	working.release();
	await until("the queue to empty", async () => (await queued()).length === 0 && requests.at(-1)?.at(-1) === "user:three");
	await idle(f.harness, thread.head);
	// One compaction for the two that were queued, the reload behind it, then the message.
	expect((await kinds()).slice(-6)).toEqual(["pi.assistant", "app.compact", "pi.compaction", "app.reload", "app.user", "pi.assistant"]);
	expect(requests.flat().some((line) => /^user:\/(compact|reload)/.test(line)), "none was a prompt").toBe(false);
	const { projection } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text).slice(-3)).toEqual(["/compact", "/reload", "three"]);
});

it("a message sent to a thread whose held queue starts with a command: the command is answered, not placed", { timeout: 60_000 }, async () => {
	const { f, thread, send, answer, requests, kinds, queued } = await setup();
	f.model.respond(answer("zero" + long), answer("one" + long));
	await send("zero");
	await idle(f.harness, thread.head);
	await send("one");
	await idle(f.harness, thread.head);
	const working = gated("two");
	f.model.respond(answer(working.step as never), answer("## Goal\nsummarized"), answer("new"), answer("three"));
	await send("two");
	await until("the run", () => requests.length === 3);
	await send("/compact", "queue");
	await send("three", "queue");
	const stopped = f.threads.queue.abort({ threadId: "t", conversationId: thread.head });
	working.release();
	await stopped;
	expect(await queued()).toEqual(["m4", "m5"]);
	// Not Resume: a new message, which releases a held queue.
	await send("new");
	await until("everything answered", async () => (await queued()).length === 0 && requests.some((request) => request.at(-1) === "user:three") && requests.some((request) => request.at(-1) === "user:new"));
	await idle(f.harness, thread.head);
	expect(await kinds()).toContain("pi.compaction");
	expect(requests.flat().some((line) => line.startsWith("user:/compact"))).toBe(false);
});
