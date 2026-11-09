// `attachT3`'s `messageContext`: context for the model about a message (memories recalled for it), stored with the
// message as a hidden block, so the model sees it, T3's display and thread search do not, and the prompt cache holds.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import type { MessageContext, MessageContextRequest } from "../src/t3/message-context.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

type Msg = { role: string; content: unknown };
type Block = { type: string; text?: string; hidden?: boolean };

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
	return { bridge, send, lastUser, warnings, thread };
}

it("the model gets the context with the message; T3 shows only the message", { timeout: 30_000 }, async () => {
	const asked: MessageContextRequest[] = [];
	const { bridge, send, lastUser, thread } = await setup(async (request) => {
		asked.push(request);
		return "<memories>\n- The user prefers short answers.\n</memories>";
	});
	await send("what do I like?");
	expect(asked.map((request) => [request.threadId, request.conversationId, request.text])).toEqual([["t", thread.head, "what do I like?"]]);
	const blocks = lastUser();
	expect(blocks.filter((block) => block.hidden === true)).toEqual([{ type: "text", hidden: true, text: expect.stringContaining("The user prefers short answers.") }]);
	expect(blocks.some((block) => block.type === "text" && block.text === "what do I like?" && block.hidden !== true)).toBe(true);
	const { projection } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["what do I like?"]);
});

it("a note and an automatic message (a child's report) get no context", { timeout: 30_000 }, async () => {
	const asked: string[] = [];
	const { send } = await setup(async (request) => {
		asked.push(request.text);
		return "context";
	});
	await send("A child finished.", { automatic: true });
	await send("fyi", { note: true });
	await send("a question");
	expect(asked).toEqual(["a question"]);
});

it("a context that fails, comes back empty or never comes: the message goes on without it, and a failure is logged", { timeout: 30_000 }, async () => {
	let mode: "reject" | "empty" | "hang" = "reject";
	const { send, lastUser, warnings } = await setup(
		(request) =>
			mode === "reject"
				? Promise.reject(new Error("memory is down"))
				: mode === "empty"
					? Promise.resolve("  ")
					: new Promise((resolve) => request.signal.addEventListener("abort", () => resolve("too late"), { once: true })),
	);
	await send("first");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	expect(warnings).toEqual(["message context failed; the message goes on without it"]);
	mode = "empty";
	await send("second");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	mode = "hang";
	const started = Date.now();
	await send("third");
	expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
	expect(warnings).toHaveLength(2);
});
