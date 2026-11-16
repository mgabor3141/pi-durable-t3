// `T3Attachment.messageContext`: context for the model about a message (memories recalled for it), asked for by the
// run that answers the message, not while the message is sent, and stored as part of the message by a context edit:
// a hidden block, so the model sees it, the message's text and thread search do not, and every later request carries
// the same bytes, so the prompt cache holds. T3 shows it as the tool row the integrator names, right after the message.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { DISPLAY_ONLY_RULE, messageContextData, type MessageContext, type MessageContextAnswer, type MessageContextRequest } from "../src/t3/message-context.ts";
import { report } from "../src/t3/reports.ts";
import { conversation, createNamed, gated, idle, makeThreads, bridgeConfig } from "./threads-harness.ts";
import { until } from "./wait.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

type Msg = { role: string; content: unknown };
type Block = { type: string; text?: string; hidden?: boolean };
const recalled = (text: string): MessageContextAnswer => ({ text, shownAs: { name: "memory_recall", input: { query: "q" } } });

async function setup(messageContext: MessageContext) {
	const noop = defineTool({ name: "noop", description: "Nothing.", parameters: { type: "object", properties: {} } as never, execute: async () => ({ output: [{ type: "text" as const, text: "done" }] }) });
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [defineExtension({ name: "noop", tools: [noop] })] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-message-context-"));
	const warnings: string[] = [];
	const log: Logger = { info: () => {}, warn: (message) => void warnings.push(message) };
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	f.tools.install(bridge.messageContexts.extension(messageContext));
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const seen: Msg[][] = [];
	const send = async (text: string, extra: { note?: boolean; automatic?: boolean } = {}) => {
		f.model.respond((context: { messages: unknown }) => {
			seen.push(context.messages as Msg[]);
			return fauxAssistantMessage("ok");
		});
		await bridge.sendMessage({ threadId: "t", commandId: `c-${text}`, messageId: `m-${text}`, text, mode: "start", ...extra });
		await idle(f.harness, thread.head);
	};
	const lastUser = () => {
		const users = seen.at(-1)!.filter((message) => message.role === "user");
		const content = users.at(-1)!.content;
		return typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);
	};
	return { bridge, send, lastUser, warnings, thread, harness: f.harness, model: f.model, seen };
}

it("the model gets the context with the message; T3 shows the message, then the context as a tool row", { timeout: 30_000 }, async () => {
	const asked: MessageContextRequest[] = [];
	const { bridge, send, lastUser, thread, harness, seen } = await setup(async (request) => {
		asked.push(request);
		return { text: "<memories>\n- The user prefers short answers.\n</memories>", shownAs: { name: "hindsight_recall", input: { query: request.text }, details: "1  score 0.83" }, data: { ids: ["m1"] } };
	});
	await send("what do I like?");
	expect(asked.map((request) => [request.threadId, request.conversationId, request.text])).toEqual([["t", thread.head, "what do I like?"]]);
	const blocks = lastUser();
	expect(blocks.filter((block) => block.hidden === true)).toEqual([{ type: "text", hidden: true, text: expect.stringContaining("The user prefers short answers."), shownAs: { name: "hindsight_recall", input: { query: "what do I like?" }, details: "1  score 0.83" }, data: { ids: ["m1"] } }]);
	expect(blocks.some((block) => block.type === "text" && block.text === "what do I like?" && block.hidden !== true)).toBe(true);
	const { projection } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["what do I like?"]);
	const items = projection.turnItems.map((item) => item as unknown as { type: string; toolName?: string; input?: unknown; output?: string; status: string });
	expect(items.map((item) => item.type)).toEqual(["user_message", "dynamic_tool", "assistant_message"]);
	expect(items[1]).toMatchObject({ toolName: "hindsight_recall", input: { query: "what do I like?" }, output: `<memories>\n- The user prefers short answers.\n</memories>\n\n${DISPLAY_ONLY_RULE}\n1  score 0.83`, status: "completed" });
	// The integrator reads its data back from the transcript: the context is a context edit of the message's entry.
	const entries = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
	expect(entries.items.flatMap((entry) => messageContextData(entry))).toEqual([{ ids: ["m1"] }]);
	const user = entries.items.find((entry) => entry.model?.[0]?.role === "user")!;
	expect(user.model![0]!.content, "the message's own entry is as it was sent").toBe("what do I like?");
	expect(entries.items.filter((entry) => entry.kind === "app.message-context").map((entry) => entry.edits?.map((edit) => edit.target))).toEqual([[user.id]]);
	// The next turn's request starts with the same message, byte for byte.
	const first = JSON.stringify(seenUser(0));
	await send("and what else?");
	expect(JSON.stringify(seenUser(1)), "the first message, in the second turn's request").toBe(first);
	expect(asked.map((request) => request.text)).toEqual(["what do I like?", "and what else?"]);
	function seenUser(request: number) {
		return seen[request]!.find((message) => message.role === "user");
	}
	// A tool row no tool call made: another thread's report does not count it.
	expect(report(projection).toolCalls).toBe(0);
});

it("a note and an automatic message (a child's report) get no context", { timeout: 30_000 }, async () => {
	const asked: string[] = [];
	const { send } = await setup(async (request) => {
		asked.push(request.text);
		return recalled("context");
	});
	await send("A child finished.", { automatic: true });
	await send("fyi", { note: true });
	await send("a question");
	expect(asked).toEqual(["a question"]);
});

it("a context that fails, comes back empty or never comes: the message goes on without it, and a failure is logged", { timeout: 30_000 }, async () => {
	let mode: "reject" | "empty" | "unnamed" | "hang" = "reject";
	const { send, lastUser, warnings } = await setup(
		(request) =>
			mode === "reject"
				? Promise.reject(new Error("memory is down"))
				: mode === "empty"
					? Promise.resolve(recalled("  "))
					: mode === "unnamed"
						? Promise.resolve({ text: "context", shownAs: { name: "", input: {} } })
						: new Promise((resolve) => request.signal.addEventListener("abort", () => resolve(recalled("too late")), { once: true })),
	);
	await send("first");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	expect(warnings).toEqual(["message context failed; the message goes on without it"]);
	mode = "empty";
	await send("second");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	mode = "unnamed";
	await send("unnamed");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	mode = "hang";
	const started = Date.now();
	await send("third");
	expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	expect(warnings).toHaveLength(3);
});

it("the message is taken at once; the run's request waits for the context, which shows as soon as that request is sent", { timeout: 30_000 }, async () => {
	let answer: ((answer: MessageContextAnswer) => void) | undefined;
	const { bridge, thread, harness, model, seen } = await setup(() => new Promise((resolve) => (answer = resolve)));
	const held = gated("the answer");
	model.respond(((context: { messages: unknown }) => (seen.push(context.messages as Msg[]), fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" }))) as never);
	model.append((async (context: { messages: unknown }) => (seen.push(context.messages as Msg[]), await (held.step as () => Promise<unknown>)())) as never);
	const started = Date.now();
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "what do I like?", mode: "start" });
	expect(Date.now() - started, "sent without waiting for the context").toBeLessThan(1_000);
	// The thread shows the message and works; no request has been sent.
	await until("the run asks for the context", () => answer !== undefined);
	expect((await bridge.projection("t")).projection.runs.map((run) => run.status)).toEqual(["running"]);
	expect(seen).toHaveLength(0);
	const rows = async () => (await bridge.projection("t")).projection.turnItems.map((item) => (item as unknown as { type: string }).type);
	expect(await rows()).toEqual(["user_message"]);

	answer!(recalled("<memories>\n- Short answers.\n</memories>"));
	// The first request carries it, and the row is there while that request is still the only one.
	await until("the second request", () => seen.length === 2);
	expect(await rows()).toEqual(["user_message", "dynamic_tool", "dynamic_tool"]);
	const user = (request: number) => JSON.stringify(seen[request]!.find((message) => message.role === "user"));
	expect(user(0)).toContain("Short answers.");
	// The request after the tool round reads the context from the edit: the same bytes.
	expect(user(1)).toBe(user(0));
	held.release();
	await idle(harness, thread.head);
	const entries = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
	expect(entries.items.filter((entry) => entry.kind === "app.message-context")).toHaveLength(1);
	expect(await rows()).toEqual(["user_message", "dynamic_tool", "dynamic_tool", "assistant_message"]);
});

it("a steer gets its context before the request that includes it", { timeout: 30_000 }, async () => {
	const asked: string[] = [];
	const { bridge, thread, harness, model, seen } = await setup(async (request) => (asked.push(request.text), recalled(`context for ${request.text}`)));
	const first = gated("first answer");
	let toolRound!: () => void;
	const inTools = new Promise<void>((resolve) => (toolRound = resolve));
	model.respond(((context: { messages: unknown }) => (seen.push(context.messages as Msg[]), toolRound(), first.step)) as never);
	model.append(((context: { messages: unknown }) => (seen.push(context.messages as Msg[]), fauxAssistantMessage("done"))) as never);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "start", mode: "start" });
	await inTools;
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "also this", mode: "steer" });
	first.release();
	await idle(harness, thread.head);
	expect(asked).toEqual(["start", "also this"]);
	const users = seen.at(-1)!.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content));
	expect(users).toHaveLength(2);
	expect(users[0]).toContain("context for start");
	expect(users[1]).toContain("context for also this");
	const { projection } = await bridge.projection("t");
	expect(projection.turnItems.filter((item) => (item as unknown as { type: string }).type === "dynamic_tool")).toHaveLength(2);
});

it("a step taken back leaves the message without its context; the run that answers it asks again", { timeout: 30_000 }, async () => {
	let round = 0;
	const { bridge, send, seen } = await setup(async () => recalled(`context ${++round}`));
	await send("what do I like?");
	expect(JSON.stringify(seen.at(-1))).toContain("context 1");
	// The agent's answer is taken back, and with it everything written after the message: the edit too.
	await bridge.sendMessage({ threadId: "t", commandId: "u1", messageId: "mu1", text: "/undo step", mode: "start" });
	const rows = async () => (await bridge.projection("t")).projection.turnItems.filter((item) => (item as unknown as { visibility?: string }).visibility !== "hidden").map((item) => (item as unknown as { type: string; output?: string }).output ?? (item as unknown as { type: string }).type);
	expect((await rows()).filter((row) => row.startsWith("context"))).toEqual([]);
	// (The thread's head is another conversation now: wait for the request, not for the old head.)
	await send("/continue");
	await until("the continued run's request", () => seen.length === 2);
	await until("the run to end", async () => (await bridge.projection("t")).projection.runs.every((run) => run.status !== "running"));
	expect(round).toBe(2);
	const users = seen.at(-1)!.filter((message) => message.role === "user");
	expect(users).toHaveLength(1);
	expect(JSON.stringify(users[0])).toContain("context 2");
	expect(JSON.stringify(users[0])).not.toContain("context 1");
	expect((await rows()).filter((row) => row.startsWith("context"))).toEqual(["context 2"]);
});

it("a compaction keeps the context of the messages it keeps, and the rows of those it summarized", { timeout: 30_000 }, async () => {
	const { bridge, send, seen, model, thread, harness } = await setup(async (request) => recalled(`context for ${request.text}`));
	const long = "x".repeat(60_000);
	for (const text of ["one", "two"]) {
		model.respond(((context: { messages: unknown }) => (seen.push(context.messages as Msg[]), fauxAssistantMessage(text + long))) as never);
		await bridge.sendMessage({ threadId: "t", commandId: `c-${text}`, messageId: `m-${text}`, text, mode: "start" });
		await idle(harness, thread.head);
	}
	const before = JSON.stringify(seen.at(-1)!.findLast((message) => message.role === "user"));
	expect(before).toContain("context for two");
	model.respond(fauxAssistantMessage("## Goal\nsummarized"));
	await bridge.sendMessage({ threadId: "t", commandId: "k", messageId: "mk", text: "/compact", mode: "start" });
	await until("the compaction", async () => (await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT)).items.some((entry) => entry.kind === "pi.compaction"));
	await idle(harness, thread.head);
	await send("three");
	const request = seen.at(-1)!;
	expect(JSON.stringify(request)).toContain("## Goal\\nsummarized");
	// The kept message is in the request as it was, context and all; the summarized one is gone with its context.
	expect(request.filter((message) => message.role === "user").map((message) => JSON.stringify(message))).toContain(before);
	expect(JSON.stringify(request)).not.toContain("context for one");
	expect(JSON.stringify(request)).toContain("context for three");
	const rows = (await bridge.projection("t")).projection.turnItems.flatMap((item) => ((item as unknown as { type: string }).type === "dynamic_tool" ? [(item as unknown as { output: string }).output] : []));
	expect(rows).toEqual(["context for one", "context for two", "context for three"]);
});
