// `attachT3`'s `messageContext`: context for the model about a message (memories recalled for it), stored with the
// message as a hidden block, so the model sees it, the message's text and thread search do not, and the prompt cache
// holds. T3 shows it as the tool row the integrator names, right after the message.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { DISPLAY_ONLY_RULE, messageContextData, type MessageContext, type MessageContextAnswer, type MessageContextRequest } from "../src/t3/message-context.ts";
import { report } from "../src/t3/reports.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

type Msg = { role: string; content: unknown };
type Block = { type: string; text?: string; hidden?: boolean };
const recalled = (text: string): MessageContextAnswer => ({ text, shownAs: { name: "memory_recall", input: { query: "q" } } });

async function setup(messageContext: MessageContext) {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-message-context-"));
	const warnings: string[] = [];
	const log: Logger = { info: () => {}, warn: (message) => void warnings.push(message) };
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry, messageContext }, log, f.threads, f.model.models);
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
	return { bridge, send, lastUser, warnings, thread, harness: f.harness };
}

it("the model gets the context with the message; T3 shows the message, then the context as a tool row", { timeout: 30_000 }, async () => {
	const asked: MessageContextRequest[] = [];
	const { bridge, send, lastUser, thread, harness } = await setup(async (request) => {
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
	// The integrator reads its data back from the transcript.
	const entries = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT);
	expect(entries.items.flatMap((entry) => messageContextData(entry))).toEqual([{ ids: ["m1"] }]);
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
