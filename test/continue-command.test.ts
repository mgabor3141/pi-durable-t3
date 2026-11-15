// `/continue`: the agent goes on from the context as it is, with no new message. After a stop, a failed run or an
// undone step the context ends in the user's message or in tool results, which the model still owes an answer; a
// message written only to say "go on" would stay in the context for good. The typed command is shown where it was
// sent and never reaches the model; the run it continues is the same run, running again.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { abortable } from "../src/t3/abortable.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { object } from "../src/t3/schema.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

type Item = { id: string; type: string; runId: string | null; text?: string; inputIntent?: string };
type Run = { id: string; status: string; userMessageId: string; queueHeld?: boolean };

async function setup() {
	const echo = defineTool({ name: "echo", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "tool output" }] }) });
	// Works until it is stopped: its wrapper returns the moment the run is aborted.
	const slow = abortable(defineTool({ name: "slow", description: "works for a while", parameters: object({}), execute: () => new Promise<{ output: { type: "text"; text: string }[] }>((resolve) => setTimeout(() => resolve({ output: [{ type: "text", text: "finished" }] }), 30_000)) }));
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [defineExtension({ name: "tools", tools: [echo, slow] })] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-continue-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, { info: () => {}, warn: () => {} }, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const send = async (text: string, mode: "start" | "queue" = "start") => {
		const n = ++sent;
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode });
		return `m${n}`;
	};
	const head = async () => (await f.threads.thread("t"))!.head;
	const settled = async () => idle(f.harness, await head());
	/** What the model would be sent next: the roles and texts of the head's context, system messages left out. */
	const context = async () =>
		(await (await conversation(f.harness, await head())).context(BACKGROUND_CONTEXT)).messages
			.filter((message) => message.role !== "system")
			.map((message) => `${message.role}:${typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `call ${block.name}` : block.type)).join(" ")}`);
	const runs = async (wanted: readonly string[]) => {
		const projection = await bridge.waitFor("t", (candidate) => (JSON.stringify(candidate.runs.map((run) => run.status)) === JSON.stringify(wanted) ? candidate : undefined), 10_000);
		if (projection === undefined) throw new Error(`the thread never showed ${wanted.join(", ")}: ${JSON.stringify((await bridge.projection("t")).projection.runs.map((run) => run.status))}`);
		return { runs: projection.runs as unknown as Run[], items: projection.turnItems as unknown as Item[] };
	};
	return { f, bridge, send, head, settled, context, runs };
}

it("/continue goes on from an undone step with no new message: the model is sent the context as it is", { timeout: 60_000 }, async () => {
	const { f, bridge, send, settled, context, runs } = await setup();
	const seen: string[] = [];
	f.model.respond(fauxAssistantMessage([fauxToolCall("echo", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("done"), (request) => {
		seen.push(JSON.stringify(request.messages));
		return fauxAssistantMessage("done again");
	});
	// Nothing was asked yet.
	await expect(send("/continue")).rejects.toThrow("There is nothing to continue: send a message first.");
	await send("go");
	await settled();
	// The conversation ends with the agent's answer: there is nothing the model owes.
	await expect(send("/continue")).rejects.toThrow("There is nothing to continue: the conversation ends with the agent's answer.");
	expect(await context()).toEqual(["user:go", "assistant:call echo", "toolResult:tool output", "assistant:done"]);

	const undo = await send("/undo step");
	expect((await runs(["interrupted"])).items.find((item) => item.id === `ti-shown-a${undo}`)!.text).toContain("`/continue` lets it go on from there, or send a message to steer it.");
	const before = (await runs(["interrupted"])).runs[0]!.id;
	const typed = await send("/continue");
	await settled();
	// One request, of what was there: the message, the call and its result. Nothing says "continue".
	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain("tool output");
	expect(seen[0]).not.toContain("continue");
	expect(await context()).toEqual(["user:go", "assistant:call echo", "toolResult:tool output", "assistant:done again"]);
	// To T3 it is the same run, completed now, with the typed command where it was sent and the answer after it.
	const after = await runs(["completed"]);
	expect(after.runs[0]!.id).toBe(before);
	const command = after.items.findIndex((item) => item.type === "user_message" && item.text === "/continue");
	expect(after.items[command]).toMatchObject({ runId: before, inputIntent: "steer" });
	expect(after.items.slice(command + 1).map((item) => [item.type, item.text])).toEqual([["assistant_message", "done again"]]);
	// What was shown only before it (the undo and its answer) stays before it, though the run got more items since.
	expect(after.items.findIndex((item) => item.id === `ti-shown-a${undo}`)).toBe(command - 1);
	const { projection } = await bridge.projection("t");
	expect(projection.messages.some((message) => message.id === typed && message.text === "/continue"), "T3 is shown the message it sent").toBe(true);
	// The same command arriving again (a retry) starts nothing more.
	await bridge.sendMessage({ threadId: "t", commandId: "again", messageId: typed, text: "/continue", mode: "start" });
	await settled();
	expect(seen).toHaveLength(1);
	// Something new was written, so the undo cannot be taken back any more.
	await expect(send("/redo")).rejects.toThrow("The thread has gone on since the undo");
});

it("/continue after Stop goes on in the stopped run, and the queued message follows as its own turn", { timeout: 60_000 }, async () => {
	const { f, bridge, send, settled, runs } = await setup();
	const seen: string[] = [];
	f.model.respond(
		fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		(request) => {
			seen.push(JSON.stringify(request.messages));
			return fauxAssistantMessage("went on");
		},
		fauxAssistantMessage("to the queued one"),
	);
	await send("go");
	await bridge.waitFor("t", (projection) => ((projection.turnItems as unknown as Item[]).some((item) => item.type === "dynamic_tool") ? true : undefined), 10_000);
	// A turn that runs is not continued.
	await expect(send("/continue")).rejects.toThrow("The agent is working already.");
	await send("then this", "queue");
	await bridge.interrupt("t");
	const stopped = await runs(["interrupted", "queued"]);
	expect(stopped.runs[1]!.queueHeld).toBe(true);

	await send("/continue");
	await settled();
	const ended = await runs(["completed", "completed"]);
	expect(ended.runs.map((run) => run.userMessageId)).toEqual(["m1", "m3"]);
	// The continued request had the stopped call's result and not the queued message: that ran after, as its own turn.
	expect(seen).toHaveLength(1);
	expect(seen[0]).not.toContain("then this");
	const texts = ended.items.filter((item) => item.type === "assistant_message").map((item) => [item.runId === ended.runs[0]!.id, item.text]);
	expect(texts).toEqual([[true, "went on"], [false, "to the queued one"]]);
});

it("/continue after a failed run sends the request again, in the same run", { timeout: 60_000 }, async () => {
	const { f, send, settled, context, runs } = await setup();
	const seen: string[] = [];
	f.model.respond(fauxAssistantMessage("half an ans", { stopReason: "error", errorMessage: "boom" }), (request) => {
		seen.push(JSON.stringify(request.messages));
		return fauxAssistantMessage("the answer");
	});
	await send("go");
	await settled();
	const failed = await runs(["failed"]);
	await send("/continue");
	await settled();
	// The failed request left nothing in the context: the model is sent the message alone, once more.
	expect(seen).toHaveLength(1);
	expect(seen[0]).not.toContain("half an ans");
	expect(await context()).toEqual(["user:go", "assistant:the answer"]);
	const after = await runs(["completed"]);
	expect(after.runs[0]!.id).toBe(failed.runs[0]!.id);
	expect(after.items.map((item) => [item.type, item.text ?? null])).toEqual([["user_message", "go"], ["error", null], ["user_message", "/continue"], ["assistant_message", "the answer"]]);
});

// T3's Resume sends a turn that names the run it continues, with the text "Continue where you left off.". The run goes
// on as after `/continue`: that text is not written, the model is not sent it, and no bubble is shown. The message
// queued behind the stopped run follows, and the `queue.resume` T3 sends right after finds a run and does nothing.
it("T3's Resume continues the stopped run without its message: nothing is written for the model, nothing is shown", { timeout: 60_000 }, async () => {
	const { f, bridge, send, settled, context, runs } = await setup();
	const seen: string[] = [];
	f.model.respond(
		fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		(request) => {
			seen.push(JSON.stringify(request.messages));
			return fauxAssistantMessage("went on");
		},
		fauxAssistantMessage("to the queued one"),
	);
	await send("go");
	await bridge.waitFor("t", (projection) => ((projection.turnItems as unknown as Item[]).some((item) => item.type === "dynamic_tool") ? true : undefined), 10_000);
	await send("then this", "queue");
	await bridge.interrupt("t");
	const stopped = await runs(["interrupted", "queued"]);
	const user = { createdBy: "user", creationSource: "web" } as const;
	const log = { info: () => {}, warn: () => {} };
	const resume = (commandId: string, runId: string) =>
		dispatchCommand(bridge, { type: "message.dispatch", commandId, threadId: "t", messageId: `resume-${commandId}`, text: "Continue where you left off.", attachments: [], manualContinuationOfRunId: runId, dispatchMode: { type: "start_immediately" } } as never, user, log);
	// A run that is not the thread's last is refused, as T3 refuses it.
	await expect(resume("r0", "r-other")).rejects.toThrow("This thread can no longer be resumed from that run.");
	await resume("r1", stopped.runs[0]!.id);
	await dispatchCommand(bridge, { type: "queue.resume", commandId: "r2", threadId: "t" } as never, user, log);
	await settled();
	const ended = await runs(["completed", "completed"]);
	expect(ended.runs.map((run) => run.id === stopped.runs[0]!.id)).toEqual([true, false]);
	expect(seen).toHaveLength(1);
	expect(seen[0]).not.toContain("Continue where you left off");
	expect(seen[0]).not.toContain("then this");
	expect((await context()).join("\n")).not.toContain("Continue where you left off");
	expect(ended.items.filter((item) => item.type === "user_message").map((item) => item.text)).toEqual(["go", "then this"]);
	expect(ended.items.filter((item) => item.type === "assistant_message").map((item) => item.text)).toEqual(["went on", "to the queued one"]);
});
