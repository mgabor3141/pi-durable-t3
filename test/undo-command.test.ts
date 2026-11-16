// `/undo` and `/redo`: the thread's head moves back to before a turn (the user's message and what the agent did for it)
// or before one of the agent's steps (a response with its tool calls and results), and forward again. Nothing is
// deleted: an undo moves the head to a fork that ends earlier, and a redo returns to the conversation it left, while
// nothing was written since. The command and its answer are shown only; the model's context is what changes.
import { applyOrchestrationV2ProjectionEvent } from "../src/t3/t3-server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { object } from "../src/t3/schema.ts";
import type { UndoHooks } from "../src/t3/undo-hooks.ts";
import { conversation, createNamed, idle, makeThreads, bridgeConfig, quietLog } from "./threads-harness.ts";

type Item = { id: string; type: string; runId: string | null; text?: string };

async function setup(undo?: UndoHooks) {
	const echo = defineTool({ name: "echo", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "tool output" }] }) });
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [defineExtension({ name: "echo", tools: [echo] })] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-undo-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, ...(undo === undefined ? {} : { undo }) }), quietLog, f.threads, f.model.models);
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
	await expect(send("/redo")).rejects.toThrow("The thread has gone on since the undo, so it cannot be taken back here.");
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

// What the integrator keeps of turns outside the conversation (memories) follows: it is told of every undo that was
// applied, by the command or by T3's Revert, with the thread's own conversations and the entry everything was taken
// back from; what it hands back is kept with the undo and given to it when a redo returns the turns. Its note is shown.
it("the integrator's undo hooks are told of an undo and of its redo, and their notes are shown", { timeout: 60_000 }, async () => {
	const told: string[] = [];
	const hooks: UndoHooks = {
		undone: async (event) => {
			told.push(`undone ${event.conversations.join(",")} from ${event.entryId}`);
			return { note: "Memory: the notes of that turn were removed.", kept: { turns: [event.entryId] } };
		},
		redone: async (event) => {
			told.push(`redone ${JSON.stringify(event.kept)}`);
			return { note: "Memory: the notes are being written again." };
		},
	};
	const { f, bridge, send, say, head, shown } = await setup(hooks);
	f.model.respond(fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two"));
	await say("one");
	await say("two");
	const first = await head();
	const [one, two] = (await bridge.projection("t")).runs;

	const undo = await send("/undo");
	expect(told).toEqual([`undone ${first} from ${two!.userEntryId}`]);
	const left = await head();
	const note = (await shown(["completed", "rolled_back"])).items.find((item) => item.id === `ti-shown-a${undo}`)!.text!;
	expect(note).toContain("Took back your last message");
	expect(note).toContain("Memory: the notes of that turn were removed.");
	// The same command arriving again is not told twice.
	await bridge.sendMessage({ threadId: "t", commandId: "again", messageId: undo, text: "/undo", mode: "start" });
	expect(told).toHaveLength(1);

	const redo = await send("/redo");
	expect(told[1]).toBe(`redone {"turns":[${two!.userEntryId}]}`);
	expect((await shown(["completed", "completed"])).items.find((item) => item.id === `ti-shown-a${redo}`)!.text).toContain("Memory: the notes are being written again.");

	// T3's own Revert sends no message to answer: the note is a reply of no run. The thread's own conversations are the
	// head it leaves and every one it had before, the fork the redo left included: a turn may have run in any of them.
	const fork = (await f.threads.thread("t"))!.head;
	expect(fork).toBe(first);
	await send("/undo");
	const second = await head();
	told.length = 0;
	await bridge.rollback({ threadId: "t", commandId: "revert-1", checkpointId: "cp-baseline", restoreFiles: false });
	expect(told).toEqual([`undone ${second},${first},${left} from ${one!.userEntryId}`]);
	const after = await shown(["rolled_back", "rolled_back"]);
	expect(after.items.find((item) => item.id === "ti-shown-arevert-revert-1")).toMatchObject({ type: "assistant_message", runId: null, text: expect.stringContaining("Memory: the notes of that turn were removed.") });
	expect(after.items.some((item) => item.id === "ti-shown-urevert-revert-1")).toBe(false);
});

it("an undo hook that fails does not undo the undo: the user is told what did not follow", { timeout: 60_000 }, async () => {
	const { f, send, say, context, shown } = await setup({
		undone: async () => {
			throw new Error("memory is unreachable");
		},
		redone: async () => undefined,
	});
	f.model.respond(fauxAssistantMessage("answer one"));
	await say("one");
	const undo = await send("/undo");
	expect(await context()).toEqual([]);
	expect((await shown(["rolled_back"])).items.find((item) => item.id === `ti-shown-a${undo}`)!.text).toContain("What this host keeps of these turns outside the conversation did not follow the undo: memory is unreachable");
	// A redo with nothing kept still tells the integrator, with nothing.
	await send("/redo");
	expect(await context()).toEqual(["user:one", "assistant:answer one"]);
});

// T3's client keeps only the newest rows of a long thread, and takes a new row whose ordinal is not above the highest
// it has seen for history it has not loaded: it drops it (`shouldDropMissingPartialTurnItem`). An undo takes rows away,
// so numbering the rows that are left by their place would hand the next new row an ordinal the client has seen: the
// answer to a `/context` after an `/undo` did not appear until the thread was opened again. Rows keep their ordinal,
// and a new one is always above every ordinal a client of this view was sent.
it("a row that is new after an undo is numbered above every row a client has seen, so T3's windowed client shows it", { timeout: 60_000 }, async () => {
	const { f, bridge, send, say } = await setup();
	f.model.respond(fauxAssistantMessage("answer one"), fauxAssistantMessage("answer two"), fauxAssistantMessage("answer three"));
	await say("one");
	await say("two");
	// A client as T3's: the projection it opened with, then every event applied with T3's own reducer, as a client
	// that holds a window of a longer thread applies them (the highest ordinal it has seen is its watermark).
	let client = (await bridge.projection("t")).projection;
	let watermark = Math.max(...client.turnItems.map((item) => item.ordinal));
	const stop = bridge.subscribeThread("t", bridge.currentStream("t")?.sequence, (update) => {
		if (update.kind === "snapshot") {
			client = update.projection;
			watermark = Math.max(...client.visibleTurnItems.map((row) => row.item.ordinal));
			return;
		}
		for (const item of update.items) {
			if (item.kind !== "event") continue;
			client = applyOrchestrationV2ProjectionEvent(client, item.event as never, { partialTimeline: true, latestLocalTurnOrdinal: watermark })!;
			const event = item.event as { type: string; payload: { ordinal?: number } };
			if (event.type === "turn-item.updated" && event.payload.ordinal !== undefined) watermark = Math.max(watermark, event.payload.ordinal);
		}
	});
	onTestFinished(stop);
	const rows = () => client.visibleTurnItems.map((row) => String(row.item.id));
	const settled = async (holds: (ids: string[]) => boolean, what: string) => {
		for (let i = 0; i < 200 && !holds(rows()); i++) await new Promise((resolve) => setTimeout(resolve, 25));
		expect(holds(rows()), `${what}: ${rows().join(", ")}`).toBe(true);
	};
	await say("three");
	await settled((ids) => ids.some((id) => id.startsWith("ti-a")) && client.messages.some((message) => message.text === "answer three"), "the client saw the third turn");
	const undo = await send("/undo");
	await settled((ids) => ids.includes(`ti-shown-a${undo}`), "the answer to /undo is shown");
	const asked = await send("/context");
	await settled((ids) => ids.includes(`ti-shown-a${asked}`), "the answer to /context is shown");
	// And in the order the thread has them.
	expect(rows().slice(-4)).toEqual([`ti-shown-u${undo}`, `ti-shown-a${undo}`, `ti-shown-u${asked}`, `ti-shown-a${asked}`]);
});

it("/redo fork opens what the undo took as a new thread, when the thread has gone on and when it has not", { timeout: 60_000 }, async () => {
	const told: { threadId: string; kept: unknown }[] = [];
	const { f, send, say, head, context, shown } = await setup({
		undone: async () => ({ kept: { turns: 1 } }),
		redone: async (event) => (told.push({ threadId: event.threadId, kept: event.kept }), { note: "Memory: the notes are written again." }),
	});
	f.model.respond(fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"), fauxAssistantMessage("another answer"));
	await say("one");
	await say("two");
	await expect(send("/redo fork")).rejects.toThrow("There is no undo to take back.");
	await send("/undo");
	await say("something else");
	const here = ["user:one", "assistant:first answer", "user:something else", "assistant:another answer"];
	expect(await context()).toEqual(here);

	// The thread has gone on: a redo is refused, and says what works.
	await expect(send("/redo")).rejects.toThrow("The thread has gone on since the undo, so it cannot be taken back here. `/redo fork` opens what the undo took as a new thread.");
	const command = await send("/redo fork");
	expect(await context(), "this thread is as it was").toEqual(here);
	const threads = await f.threads.list();
	const fork = threads.find((thread) => thread.threadId !== "t")!;
	expect(threads).toHaveLength(2);
	expect(fork).toMatchObject({ title: "Before undo", lineage: { parentThreadId: "t", relationshipToParent: "fork" } });
	const forked = (await (await conversation(f.harness, fork.head)).context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role !== "system").map((message) => `${message.role}:${typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("")}`);
	expect(forked, "what the undo took, whole").toEqual(["user:one", "assistant:first answer", "user:two", "assistant:second answer"]);
	// What the integrator keeps of the undone turns comes back for the new thread.
	expect(told).toEqual([{ threadId: fork.threadId, kept: { turns: 1 } }]);
	const answer = (await shown(["completed", "completed", "rolled_back"])).items.find((item) => item.id === `ti-shown-a${command}`)!.text;
	expect(answer).toContain('Opened what the last undo took as a new thread: "Before undo". This thread is as it was.');
	expect(answer).toContain("Memory: the notes are written again.");
	// The fork is a thread like any other.
	f.model.respond(fauxAssistantMessage("third answer"));
	await f.threads.submit({ threadId: fork.threadId, conversationId: fork.head, requestId: "rf", message: "three" }, undefined);
	await idle(f.harness, fork.head);
	expect(await head(), "and this thread's head did not move").toBe((await f.threads.thread("t"))!.head);
});
