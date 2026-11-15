// `/undo` and `/redo`: the thread's head moves back to before a turn (the user's message and what the agent did for it)
// or before one of the agent's steps (a response with its tool calls and results), and forward again. Nothing is
// deleted: an undo moves the head to a fork that ends earlier, and a redo returns to the conversation it left, while
// nothing was written since. The command and its answer are shown only; the model's context is what changes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { object } from "../src/t3/schema.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

type Item = { id: string; type: string; runId: string | null; text?: string };

async function setup() {
	const echo = defineTool({ name: "echo", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "tool output" }] }) });
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [defineExtension({ name: "echo", tools: [echo] })] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-undo-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, { info: () => {}, warn: () => {} }, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const send = async (text: string) => {
		const n = ++sent;
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode: "start" });
		return `m${n}`;
	};
	const head = async () => (await f.threads.thread("t"))!.head;
	const say = async (text: string) => {
		await send(text);
		await idle(f.harness, await head());
	};
	/** What the model would be sent next: the roles and texts of the head's context, system messages left out. */
	const context = async () =>
		(await (await conversation(f.harness, await head())).context(BACKGROUND_CONTEXT)).messages
			.filter((message) => message.role !== "system")
			.map((message) => `${message.role}:${typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `call ${block.name}` : block.type)).join("+")}`);
	/** The thread as T3 is shown it, once it shows `runs` in these states. */
	const shown = async (runs: readonly string[]) => {
		const projection = await bridge.waitFor("t", (candidate) => (JSON.stringify(candidate.runs.map((run) => run.status)) === JSON.stringify(runs) ? candidate : undefined), 10_000);
		if (projection === undefined) throw new Error(`the thread never showed ${runs.join(", ")}: ${JSON.stringify((await bridge.projection("t")).projection.runs.map((run) => run.status))}`);
		return { items: projection.turnItems as unknown as Item[], messages: projection.messages.map((message) => `${message.role}:${message.text}`) };
	};
	return { f, bridge, send, say, head, context, shown };
}

it("/undo takes back the last turn, or the last n; /redo brings them back, until something new is written", { timeout: 60_000 }, async () => {
	const { f, bridge, send, say, head, context, shown } = await setup();
	f.model.respond(fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two"), fauxAssistantMessage("answer three"));
	await say("one");
	await say("two");
	const before = await head();
	expect(await context()).toEqual(["user:one", "assistant:answer one", "user:two", "assistant:answer two"]);

	const undo = await send("/undo");
	expect(await head(), "the head moved to a fork").not.toBe(before);
	expect(await context(), "the model's context ends before the turn").toEqual(["user:one", "assistant:answer one"]);
	// T3 keeps the reverted run as rolled back, as after its own Revert; the command stands in the run that is left.
	const after = await shown(["completed", "rolled_back"]);
	const rows = after.items.filter((item) => item.id.startsWith("ti-shown-"));
	expect(rows.map((item) => [item.id, item.type, item.runId === null])).toEqual([[`ti-shown-u${undo}`, "user_message", false], [`ti-shown-a${undo}`, "assistant_message", true]]);
	expect(rows[1]!.text).toContain("Took back your last message and what the agent did for it. `/redo` brings it back");
	// The same command arriving again (a retry) forks nothing more.
	const forked = await head();
	await bridge.sendMessage({ threadId: "t", commandId: "c3", messageId: undo, text: "/undo", mode: "start" });
	expect(await head()).toBe(forked);

	const redo = await send("/redo");
	expect(await head(), "back on the conversation the undo left").toBe(before);
	expect(await context()).toEqual(["user:one", "assistant:answer one", "user:two", "assistant:answer two"]);
	const again = await shown(["completed", "completed"]);
	expect(again.items.find((item) => item.id === `ti-shown-a${redo}`)!.text).toContain("Brought back what the last undo took.");
	await expect(send("/redo")).rejects.toThrow("There is no undo to take back.");

	// Both turns at once: the thread is empty, with no run for the command to stand in, so only the answer shows.
	await expect(send("/undo 3")).rejects.toThrow("There are 2 turns to undo.");
	const both = await send("/undo 2");
	expect(await context()).toEqual([]);
	const emptied = await shown(["rolled_back", "rolled_back"]);
	expect(emptied.items.filter((item) => item.id.endsWith(both)).map((item) => item.type)).toEqual(["assistant_message"]);
	expect(emptied.items.find((item) => item.id === `ti-shown-a${both}`)!.text).toContain("Took back your last 2 messages and what the agent did for them.");
	await send("/redo");
	expect(await context()).toHaveLength(4);

	// One turn back, then something new: the undo cannot be taken back any more.
	await send("/undo");
	await say("three");
	expect(await context()).toEqual(["user:one", "assistant:answer one", "user:three", "assistant:answer three"]);
	await expect(send("/redo")).rejects.toThrow("The thread has gone on since the undo, so it cannot be taken back.");
	await expect(send("/undo sideways")).rejects.toThrow("Usage: /undo [n]");
});

it("/undo step takes back the agent's last response and what followed it; the user's message stays", { timeout: 60_000 }, async () => {
	const { f, send, say, head, context, shown } = await setup();
	const seen: string[] = [];
	f.model.respond(
		fauxAssistantMessage([fauxToolCall("echo", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("echo", {}, { id: "call-2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
		(request) => {
			seen.push(JSON.stringify(request.messages));
			return fauxAssistantMessage("done differently");
		},
	);
	await say("go");
	const whole = ["user:go", "assistant:call echo", "toolResult:tool output", "assistant:call echo", "toolResult:tool output", "assistant:done"];
	expect(await context()).toEqual(whole);
	const before = await head();

	// The last step is the final answer; the one before it is a tool call and its result.
	const one = await send("/undo step");
	expect(await context()).toEqual(whole.slice(0, 5));
	expect((await shown(["interrupted"])).items.find((item) => item.id === `ti-shown-a${one}`)!.text).toContain("Took back the agent's last step.");
	await send("/undo step");
	expect(await context()).toEqual(whole.slice(0, 3));
	// Each undo is taken back by its own redo, newest first.
	await send("/redo");
	expect(await context()).toEqual(whole.slice(0, 5));
	await send("/redo");
	expect(await head()).toBe(before);
	expect(await context()).toEqual(whole);

	// Several at once, down to the message alone; then there is no step left, and more than there are is refused.
	await expect(send("/undo step 4")).rejects.toThrow("The last turn has 3 steps; /undo takes back the whole turn.");
	await send("/undo step 3");
	expect(await context()).toEqual(["user:go"]);
	await expect(send("/undo step")).rejects.toThrow("The agent has taken no step in the last turn; /undo takes back your message.");

	// The thread goes on from there: the next request has the message and the new one, and none of the steps.
	await say("do it differently");
	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain("do it differently");
	expect(seen[0]).not.toContain("tool output");
	expect(seen[0]).not.toContain("/undo");
	expect(await context()).toEqual(["user:go", "user:do it differently", "assistant:done differently"]);
});

it("refuses while a turn runs", { timeout: 60_000 }, async () => {
	const { f, send, head } = await setup();
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.model.respond(fauxAssistantMessage("first"), async () => {
		await gate;
		return fauxAssistantMessage("second");
	});
	await send("one");
	await idle(f.harness, await head());
	await send("two");
	await expect(send("/undo")).rejects.toThrow("Stop the current turn before undoing.");
	await expect(send("/redo")).rejects.toThrow("Stop the current turn before redoing.");
	release();
	await idle(f.harness, await head());
});

it("/redo also takes back T3's own Revert", { timeout: 60_000 }, async () => {
	const { f, bridge, send, say, head, context, shown } = await setup();
	f.model.respond(fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two"));
	await say("one");
	await say("two");
	const before = await head();
	const first = (await bridge.projection("t")).runs[0]!;
	// T3's Revert to the checkpoint after the first turn: the second turn goes.
	await bridge.rollback({ threadId: "t", commandId: "revert-1", checkpointId: `cp${first.userEntryId}`, restoreFiles: false });
	await shown(["completed", "rolled_back"]);
	expect(await context()).toEqual(["user:one", "assistant:answer one"]);
	await send("/redo");
	expect(await head()).toBe(before);
	expect(await context()).toEqual(["user:one", "assistant:answer one", "user:two", "assistant:answer two"]);
});
