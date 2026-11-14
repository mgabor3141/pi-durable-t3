// Stop takes effect at once, whatever the run is doing. pi-durable ends a run when each of its tool calls has returned,
// and tells a call to stop through its context; Stop marks the tasks and answers, and the thread shows T3's
// "Interrupt requested" item (its "Stopping" banner) until the run ends, flagged not responding past the wait. A tool
// wrapped `abortable` returns the moment it is aborted. A run whose tasks ended outside pi-durable (task records changed
// in the database, `pi.live` left saying a run and a tool call are in flight) showed running forever and queued every
// message behind it; Stop ends it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, type Extension, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { abortable } from "../src/t3/abortable.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { object } from "../src/t3/schema.ts";
import type { Threads } from "../src/threads.ts";
import { conversation, createNamed, idle, makeThreads, restart } from "./threads-harness.ts";

const warnings: string[] = [];
const log: Logger = { info: () => {}, warn: (message: string) => void warnings.push(message) };
afterEach(() => {
	warnings.length = 0;
	Bridge.stopConfirmMs = 10_000;
});

/** Calls under way: each tool below adds its name when its `execute` starts. */
const started = new Set<string>();
afterEach(() => started.clear());

/** A tool that does not listen for its abort: it returns after `ms`, however the run is stopped meanwhile. */
const deaf = (name: string, ms: number) =>
	defineTool({
		name,
		description: "works for a while, deaf to Stop",
		parameters: object({}),
		execute: () => {
			started.add(name);
			return new Promise<{ output: { type: "text"; text: string }[] }>((resolve) => setTimeout(() => resolve({ output: [{ type: "text", text: "finished" }] }), ms));
		},
	});

async function setup(extensions: readonly Extension[]) {
	const f = await makeThreads({ projects: [{ id: "p" }], extensions });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-stop-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const open = (threads: Threads) => {
		const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, threads, f.model.models);
		bridge.start();
		onTestFinished(() => bridge.close());
		return bridge;
	};
	const bridge = open(f.threads);
	await bridge.loaded();
	return { f, thread, bridge, open };
}

type Item = { type: string; toolName?: string; status: string; unresponsiveAt?: unknown; message?: string };
const itemsOf = async (bridge: Bridge) => (await bridge.projection("t")).projection.turnItems as unknown as Item[];
const lastRun = async (bridge: Bridge) => (await bridge.projection("t")).projection.runs.at(-1)!;
const toolRunning = async (name: string) => {
	for (let waited = 0; !started.has(name); waited += 20) {
		if (waited > 10_000) throw new Error(`${name} never started`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
};
const runEnded = (bridge: Bridge, timeoutMs: number) => bridge.waitFor("t", (projection) => (projection.runs.length > 0 && projection.runs.every((run) => run.status !== "running") ? projection : undefined), timeoutMs);

it("Stop shows at once and answers at once; a run held by a deaf tool shows not responding, and ends when the tool returns", { timeout: 60_000 }, async () => {
	// Stop answers after waiting up to a second for the abort; the run is flagged not responding later.
	Bridge.stopConfirmMs = 1_500;
	const { f, bridge } = await setup([defineExtension({ name: "deaf", tools: [deaf("slow", 3_000)] })]);
	f.model.respond(fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("after"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await toolRunning("slow");

	const pressed = Date.now();
	await bridge.interrupt("t");
	expect(Date.now() - pressed, "Stop answers without waiting for the tool").toBeLessThan(1_400);
	expect((await lastRun(bridge)).status).toBe("running");
	const request = (await itemsOf(bridge)).find((item) => item.type === "run_interrupt_request");
	expect(request, "T3's Stopping banner").toMatchObject({ status: "completed", message: "Stopped by user" });
	expect(request!.unresponsiveAt).toBeUndefined();

	// Past the wait the run is flagged not responding.
	const flagged = await bridge.waitFor("t", (projection) => ((projection.turnItems as unknown as Item[]).find((item) => item.type === "run_interrupt_request")?.unresponsiveAt !== undefined ? true : undefined), 5_000);
	expect(flagged).toBe(true);
	expect(warnings).toContain("stop: the run has not ended");

	// The tool returns; the run ends interrupted, and the banner goes with it.
	const ended = await runEnded(bridge, 10_000);
	expect(ended!.runs.at(-1)!.status).toBe("interrupted");
	expect((ended!.turnItems as unknown as Item[]).some((item) => item.type === "run_interrupt_request")).toBe(false);
});

it("an abortable tool returns the moment it is stopped, though its work goes on", { timeout: 60_000 }, async () => {
	const { f, bridge } = await setup([defineExtension({ name: "deaf", tools: [abortable(deaf("slow", 30_000))] })]);
	f.model.respond(fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("after"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await toolRunning("slow");
	const pressed = Date.now();
	await bridge.interrupt("t");
	const ended = await runEnded(bridge, 2_000);
	expect(Date.now() - pressed).toBeLessThan(500);
	expect(ended!.runs.at(-1)!.status).toBe("interrupted");
});

it("Stop ends a run whose tasks ended outside pi-durable, and the thread takes messages again", { timeout: 60_000 }, async () => {
	const tools = defineExtension({ name: "quick", tools: [defineTool({ name: "quick", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "done" }] }) })] });
	const { f, thread, bridge } = await setup([tools]);
	f.model.respond(fauxAssistantMessage([fauxToolCall("quick", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("first answer"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "first", mode: "start" });
	await idle(f.harness, thread.head);
	await bridge.close();

	// The wedge: the run's tasks are terminal (as a hand-edited database left them), and pi.live still names the run,
	// its tool call running, and a nested call's output.
	const head = await conversation(f.harness, thread.head);
	await head.commit(async (tx) => {
		const tasks = (await tx.scanTasks({ conversationId: thread.head as ConversationId }, 50)).items;
		const generation = tasks.find((task) => task.kind === "pi.generation")!;
		const tool = tasks.find((task) => task.kind === "pi.tool")!;
		expect([generation.state.status, tool.state.status]).toEqual(["terminal", "terminal"]);
		const live = (await tx.doc(LiveDoc, thread.head as ConversationId)) as Record<string, unknown>;
		live.run = { taskId: generation.id, inputs: [], turns: 1 };
		live.tools = [{ callId: "call-9", name: "quick", taskId: tool.id, status: "running" }];
		live.nestedTools = [{ callId: "n-1", name: "bash", parentCallId: "call-9", parentTaskId: tool.id, taskId: tool.id, status: "running", arguments: {}, output: "pid1=1456259\n" }];
	}, BACKGROUND_CONTEXT);

	// A restart does not heal it: the thread loads running.
	const again = await restart(f);
	const reopened = (await (async () => {
		const { open } = { open: (threads: Threads) => new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: (bridge as unknown as { config: { stateDir: string } }).config.stateDir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open((bridge as unknown as { config: { stateDir: string } }).config.stateDir), corsOrigins: [], staticDir: undefined, registry: again.registry }, log, threads, f.model.models) };
		const made = open(again.threads);
		made.start();
		onTestFinished(() => made.close());
		await made.loaded();
		return made;
	})());
	expect((await reopened.projection("t")).projection.runs.at(-1)!.status).toBe("running");

	const pressed = Date.now();
	await reopened.interrupt("t");
	expect(Date.now() - pressed).toBeLessThan(1_000);
	const ended = await reopened.waitFor("t", (projection) => (projection.runs.every((run) => run.status !== "running") ? projection : undefined), 2_000);
	expect(ended, "Stop ended the dead run").toBeDefined();
	expect(warnings.some((message) => message.startsWith("stop: ended work whose tasks had already ended"))).toBe(true);

	// The thread runs again: the next message starts, and the call left without a result does not break the model's context.
	f.model.respond(fauxAssistantMessage("second answer"));
	await reopened.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "second", mode: "start" });
	const answered = await reopened.waitFor("t", (projection) => (projection.messages.some((message) => message.text === "second answer") && projection.runs.every((run) => run.status !== "running") ? projection : undefined), 10_000);
	expect(answered!.runs.at(-1)!.status).toBe("completed");
});

// pi-durable's abort withdraws every queued input. T3 keeps the queue across a Stop and a restart: after a Stop the
// queued messages are held (nothing starts them) and Resume (`queue.resume`) starts the first; a restart's message
// runs now and the queued ones follow it.
type QueueRun = { id: string; status: string; userMessageId: string; queueHeld?: boolean };
const runsOf = async (bridge: Bridge) => (await bridge.projection("t")).projection.runs as unknown as QueueRun[];

it("Stop keeps the messages queued behind the run, held until Resume", { timeout: 60_000 }, async () => {
	const { f, thread, bridge } = await setup([defineExtension({ name: "deaf", tools: [abortable(deaf("slow", 30_000))] })]);
	f.model.respond(fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("to the queued one"), fauxAssistantMessage("to the last"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await toolRunning("slow");
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "then this", mode: "queue" });
	await bridge.sendMessage({ threadId: "t", commandId: "c3", messageId: "m3", text: "and this", mode: "queue" });
	expect((await runsOf(bridge)).map((run) => [run.userMessageId, run.status, run.queueHeld])).toEqual([["m1", "running", undefined], ["m2", "queued", undefined], ["m3", "queued", undefined]]);

	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	const stopped = await bridge.waitFor("t", (projection) => (projection.runs[0]!.status === "interrupted" ? (projection.runs as unknown as QueueRun[]) : undefined), 5_000);
	expect(stopped!.map((run) => [run.userMessageId, run.status, run.queueHeld]), "both still queued, in order, and held").toEqual([["m1", "interrupted", undefined], ["m2", "queued", true], ["m3", "queued", true]]);

	// Resume starts the first; the other follows it as a queued message does.
	await bridge.startQueued("t", undefined, "resume-1");
	await idle(f.harness, thread.head);
	const resumed = await bridge.waitFor("t", (projection) => (projection.runs.length === 3 && projection.runs.every((run) => run.status !== "queued" && run.status !== "running") ? (projection.runs as unknown as QueueRun[]) : undefined), 5_000);
	expect(resumed!.map((run) => [run.userMessageId, run.status])).toEqual([["m1", "interrupted"], ["m2", "completed"], ["m3", "completed"]]);
	const answers = (await bridge.projection("t")).projection.messages.filter((message) => message.role === "assistant").map((message) => message.text);
	expect(answers).toEqual(["to the queued one", "to the last"]);
});

it("a restart keeps the queue: its message runs now and the queued one follows", { timeout: 60_000 }, async () => {
	const { f, thread, bridge } = await setup([defineExtension({ name: "deaf", tools: [abortable(deaf("slow", 30_000))] })]);
	f.model.respond(fauxAssistantMessage([fauxToolCall("slow", {}, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("to the restart"), fauxAssistantMessage("to the queued one"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await toolRunning("slow");
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "queued", mode: "queue" });
	await bridge.sendMessage({ threadId: "t", commandId: "c3", messageId: "m3", text: "no, do this", mode: "restart" });
	await idle(f.harness, thread.head);
	const ended = await bridge.waitFor("t", (projection) => (projection.runs.length === 3 && projection.runs.every((run) => run.status !== "queued" && run.status !== "running") ? (projection.runs as unknown as QueueRun[]) : undefined), 5_000);
	expect(ended!.map((run) => [run.userMessageId, run.status])).toEqual([["m1", "interrupted"], ["m3", "completed"], ["m2", "completed"]]);
});
