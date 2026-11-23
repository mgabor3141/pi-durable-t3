// T3's thread tools on this host (`thread-ops.ts`), as `/mcp` calls them: for an MCP client outside any thread. Every
// answer encodes with the contract's result schema, and the behaviour is T3's: a project or thread must be named, a retry
// is answered with the same ids, and `create_threads` is refused (it acts as the calling thread).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	OrchestratorMcpFailure,
	OrchestratorMcpThreadInterruptResult,
	OrchestratorMcpThreadListResult,
	OrchestratorMcpThreadReadResult,
	OrchestratorMcpThreadSendResult,
	OrchestratorMcpThreadWaitResult,
	ThreadId,
	ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { ScheduledTasks, scheduledTaskDispatch } from "../src/t3/scheduled-tasks.ts";
import { ThreadOps } from "../src/t3/thread-ops.ts";
import { createNamed, gated, makeThreads, bridgeConfig } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
// biome-ignore lint/suspicious/noExplicitAny: a schema of any shape
const encodes = (schema: any, value: unknown) => Schema.encodeUnknownSync(schema)(value);
const tid = (value: string) => ThreadId.make(value);

async function setup(options: { tokensPerSecond?: number; scratchDir?: string } = {}) {
	const f = await makeThreads({ projects: [{ id: "p" }, { id: "q" }], ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Caller" });
	await create({ threadId: "b", projectId: "p", title: "Worker" });
	await create({ threadId: "c", projectId: "q", title: "Elsewhere" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-ops-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, ...(options.scratchDir === undefined ? {} : { scratchDir: options.scratchDir }) }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return { f, bridge, ops: new ThreadOps(bridge, "env-1", log) };
}

const failureOf = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		if (error instanceof OrchestratorMcpFailure) return error.code;
		throw error;
	}
	throw new Error("expected a failure");
};

const client = { client: { sessionId: "s1", access: "full-access" as const } };

it("lists a named project, refuses without one, and reads a thread a client wrote to", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup();
	const caller = client;
	const listed = ops.list(caller, { projectId: "p" as never });
	encodes(OrchestratorMcpThreadListResult, listed);
	expect(listed.projectId).toBe("p");
	expect(listed.currentThreadId).toBeNull();
	expect(listed.threads.map((thread) => thread.threadId).sort()).toEqual(["a", "b"]);
	// T3's own link format (`formatThreadLink`), so an agent can name the thread verbatim.
	expect(listed.threads[0]?.link).toBe(`<t3-thread://v2/env-1/${listed.threads[0]?.threadId}>`);
	expect(ops.list({}, { allProjects: true }).total).toBe(3);
	expect(await failureOf(() => ops.list({}, {}))).toBe("target_required");

	f.model.respond(fauxAssistantMessage("hello from b"));
	const sent = await ops.send(caller, { threadId: tid("b"), message: "hi b", clientRequestId: "req-1" });
	encodes(OrchestratorMcpThreadSendResult, sent);
	expect(sent.delivery).toBe("started");
	const waited = await ops.wait(caller, { threadId: tid("b") });
	encodes(OrchestratorMcpThreadWaitResult, waited);
	expect(waited).toMatchObject({ runId: sent.runId, status: "completed", timedOut: false });

	const read = await ops.read(caller, { threadId: tid("b") });
	encodes(OrchestratorMcpThreadReadResult, read);
	expect(read.items.map((item) => [item.type, item.text])).toEqual([
		["user_message", "hi b"],
		["assistant_message", "hello from b"],
	]);
	expect(read.items[0]).toMatchObject({ createdBy: "agent", creationSource: "mcp", messageId: sent.messageId });
	expect(read.items[0]).not.toHaveProperty("senderThreadId");
	expect(read.thread).toMatchObject({ threadId: "b", status: "completed", runCount: 1 });

	// A long item is cut, and continues from its offset.
	const short = await ops.read(caller, { threadId: tid("b"), maxCharsPerItem: 5 });
	expect(short.items[1]).toMatchObject({ text: "hello", textTruncated: true, nextTextOffset: 5 });
	const rest = await ops.read(caller, { threadId: tid("b"), itemId: short.items[1]!.itemId, textOffset: 5, maxCharsPerItem: 50 });
	expect(rest.items).toHaveLength(1);
	expect(rest.items[0]?.text).toBe(" from b");

	// A retry of the same request is the same message, sent once.
	const again = await ops.send(caller, { threadId: tid("b"), message: "hi b", clientRequestId: "req-1" });
	expect(again.messageId).toBe(sent.messageId);
	expect((await ops.read(caller, { threadId: tid("b") })).items.filter((item) => item.type === "user_message")).toHaveLength(1);

	expect(await failureOf(() => ops.read(caller, { threadId: tid("nope") }))).toBe("thread_not_found");

	// Rename: the thread must be named, outside a thread.
	const renamed = await ops.update(caller, { threadId: tid("b"), action: "rename", title: "Worker renamed" });
	encodes(ThreadMetadataMcpUpdateResult, renamed);
	expect(renamed.title).toBe("Worker renamed");
	expect(await failureOf(() => ops.update(caller, { action: "rename", title: "Me" }))).toBe("target_required");
});

// T3's `sendToThread` names the calling thread as the sender, and `withMessageSenderNote` tells the model who sent a
// message (the thread's agent, or T3's tools for a client outside a thread); T3 shows the message as it was sent.
it("tells the model who sent a message: the calling thread's agent, or T3's tools for a client", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup();
	const read: unknown[] = [];
	const step = async (context: { messages: readonly { content: unknown }[] }) => {
		read.push(context.messages.at(-1)!.content);
		return fauxAssistantMessage("ok");
	};
	f.model.respond(step);
	const fromThread = await ops.send({ threadId: "a" }, { threadId: tid("b"), message: "hi from a" });
	await ops.wait(client, { threadId: tid("b"), timeoutMs: 10_000 });
	expect(read[0]).toEqual([
		{ type: "text", text: "hi from a" },
		{ type: "text", text: '[T3 Code: the agent in T3 thread "a" sent this message, not the user.]', hidden: true },
	]);
	const item = (await ops.read(client, { threadId: tid("b") })).items.find((candidate) => candidate.messageId === fromThread.messageId);
	expect(item).toMatchObject({ text: "hi from a", createdBy: "agent", creationSource: "mcp", senderThreadId: "a" });

	f.model.respond(step);
	await ops.send(client, { threadId: tid("b"), message: "hi from outside" });
	await ops.wait(client, { threadId: tid("b"), timeoutMs: 10_000 });
	expect(read[1]).toEqual([
		{ type: "text", text: "hi from outside" },
		{ type: "text", text: "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]", hidden: true },
	]);
});

it("waits with a timeout, interrupts a running turn, and refuses to steer an idle one", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup({ tokensPerSecond: 20 });
	const caller = client;
	expect(await failureOf(() => ops.send(caller, { threadId: tid("b"), message: "x", mode: "steer" }))).toBe("thread_not_sendable");
	// T3 0.1.11 says how to start a turn instead.
	await expect(ops.send(caller, { threadId: tid("b"), message: "x", mode: "restart" })).rejects.toThrow(
		'Thread b has no running turn that can be restarted. Send with mode: "auto" or "queue" to start a new turn there.',
	);
	f.model.respond(fauxAssistantMessage("slow ".repeat(200)));
	const sent = await ops.send(caller, { threadId: tid("b"), message: "long task" });
	const early = await ops.wait(caller, { threadId: tid("b"), timeoutMs: 200 });
	expect(early).toMatchObject({ runId: sent.runId, timedOut: true });
	const interrupted = await ops.interrupt(caller, { threadId: tid("b"), reason: "the plan changed" });
	encodes(OrchestratorMcpThreadInterruptResult, interrupted);
	expect(interrupted).toMatchObject({ runId: sent.runId, status: "interrupt_requested" });
	const ended = await ops.wait(caller, { threadId: tid("b"), timeoutMs: 10_000 });
	expect(ended).toMatchObject({ timedOut: false, status: "interrupted" });
	expect(await ops.interrupt(caller, { threadId: tid("b") })).toMatchObject({ status: "no_active_run", runId: null });

	// The stopped agent is told with its next message that an agent stopped it, and why (T3's `agentStopReason`).
	const read: unknown[] = [];
	f.model.respond(async (context: { messages: readonly { content: unknown }[] }) => {
		read.push(context.messages.at(-1)!.content);
		return fauxAssistantMessage("ok");
	});
	await ops.send(caller, { threadId: tid("b"), message: "go on" });
	await ops.wait(caller, { threadId: tid("b"), timeoutMs: 10_000 });
	expect(read[0]).toEqual([
		{ type: "text", text: "go on" },
		{ type: "text", text: "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]", hidden: true },
		{ type: "text", text: "[Another agent stopped your previous turn before it finished, saying: the plan changed.]", hidden: true },
	]);
});

// T3 0.1.11: a retried send is answered from its receipt, so a steer whose turn has ended since is not refused; and an
// agent's `auto` send queues instead of steering while another agent message waits in the queue.
it("answers a retried steer whose turn has ended, and queues an auto send behind an agent's queued message", { timeout: 60_000 }, async () => {
	const { f, ops, bridge } = await setup();
	const caller = client;
	const first = gated("first answer");
	f.model.respond(first.step, fauxAssistantMessage("to the steers"), fauxAssistantMessage("to the person"), fauxAssistantMessage("to the queued one"), fauxAssistantMessage("to the auto one"));
	const started = await ops.send(caller, { threadId: tid("b"), message: "long task" });
	const steered = await ops.send(caller, { threadId: tid("b"), message: "and this", mode: "steer", clientRequestId: "k1" });
	expect(steered).toMatchObject({ runId: started.runId, delivery: "steered" });
	// A person's queued message lets an agent's auto send steer; an agent's makes it queue.
	await bridge.sendMessage({ threadId: "b", commandId: "person-1", messageId: "person-1", text: "a person's", mode: "queue" });
	expect(await ops.send(caller, { threadId: tid("b"), message: "steer on", clientRequestId: "k2" })).toMatchObject({ runId: started.runId, delivery: "steered" });
	const queued = await ops.send(caller, { threadId: tid("b"), message: "after this", mode: "queue", clientRequestId: "k3" });
	expect(queued).toMatchObject({ delivery: "queued" });
	const auto = await ops.send(caller, { threadId: tid("b"), message: "then this", clientRequestId: "k4" });
	expect(auto, "behind the agent's queued message, not into the turn").toMatchObject({ delivery: "queued" });
	expect(auto.runId).not.toBe(started.runId);
	first.release();
	const ended = await bridge.waitFor("b", (projection) => (projection.runs.length === 4 && projection.runs.every((run) => run.status === "completed") ? projection : undefined), 10_000);
	expect(ended?.runs.map((run) => String(run.userMessageId))).toEqual([started.messageId, "person-1", queued.messageId, auto.messageId]);

	expect(await ops.send(caller, { threadId: tid("b"), message: "and this", mode: "steer", clientRequestId: "k1" }), "the retry, after its turn ended").toMatchObject({ messageId: steered.messageId, runId: started.runId });
	expect(await failureOf(() => ops.send(caller, { threadId: tid("b"), message: "and this", mode: "steer", clientRequestId: "k5" })), "a new steer").toBe("thread_not_sendable");
	const messages = (await bridge.projection("b")).projection.messages.filter((message) => message.text === "and this");
	expect(messages, "sent once").toHaveLength(1);
});

it("a retried restart answers restarted while its own run still runs", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup();
	const first = gated("first");
	const second = gated("second");
	f.model.respond(first.step, second.step);
	await ops.send(client, { threadId: tid("b"), message: "long" });
	const restarted = await ops.send(client, { threadId: tid("b"), message: "instead", mode: "restart", clientRequestId: "r1" });
	expect(restarted).toMatchObject({ delivery: "restarted", status: "running" });
	const retry = await ops.send(client, { threadId: tid("b"), message: "instead", mode: "restart", clientRequestId: "r1" });
	expect(retry).toMatchObject({ delivery: "restarted", runId: restarted.runId, messageId: restarted.messageId });
	first.release();
	second.release();
});

it("refuses create_threads: it acts as the calling thread, and a client has none", async () => {
	const { ops } = await setup();
	expect(await failureOf(() => ops.create(client, { threads: [{ prompt: "x" }] }))).toBe("thread_credential_required");
});

it("pages a thread as T3 0.1.11 reads it: forward for a client, back with beforePosition, cut to fit the result", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup();
	for (const n of [1, 2, 3]) {
		f.model.respond(fauxAssistantMessage(`reply ${n}`));
		await ops.send(client, { threadId: tid("b"), message: `message ${n}` });
		await ops.wait(client, { threadId: tid("b") });
	}
	const texts = (read: { items: readonly { text: string | null }[] }) => read.items.map((item) => item.text);
	// A client's cursorless read goes forward from the start; `earlierPosition` is null at the start.
	const first = await ops.read(client, { threadId: tid("b"), limit: 2 });
	encodes(OrchestratorMcpThreadReadResult, first);
	expect(texts(first)).toEqual(["message 1", "reply 1"]);
	expect(first).toMatchObject({ hasMore: true, earlierPosition: null });
	// Back from the end: the newest page before the position, in order, and where to page back from.
	const end = await ops.read(client, { threadId: tid("b"), beforePosition: 100, limit: 2 });
	expect(texts(end)).toEqual(["message 3", "reply 3"]);
	expect(end.earlierPosition).toBe(end.items[0]!.position);
	const older = await ops.read(client, { threadId: tid("b"), beforePosition: end.earlierPosition!, limit: 2 });
	expect(texts(older)).toEqual(["message 2", "reply 2"]);
	const oldest = await ops.read(client, { threadId: tid("b"), beforePosition: older.earlierPosition!, limit: 2 });
	expect(texts(oldest)).toEqual(["message 1", "reply 1"]);
	expect(oldest.earlierPosition).toBeNull();
	// From the start with `afterPosition: -1`, then on from `nextPosition`.
	const next = await ops.read(client, { threadId: tid("b"), afterPosition: first.nextPosition!, limit: 2 });
	expect(texts(next)).toEqual(["message 2", "reply 2"]);
	expect(next.earlierPosition).toBe(next.items[0]!.position);
	// T3's defaults: ten items, 500 characters each.
	f.model.respond(fauxAssistantMessage("x".repeat(2_000)));
	await ops.send(client, { threadId: tid("b"), message: "long" });
	await ops.wait(client, { threadId: tid("b") });
	const long = (await ops.read(client, { threadId: tid("b"), beforePosition: 100, limit: 1 })).items[0]!;
	expect(long).toMatchObject({ textTruncated: true, nextTextOffset: 500 });
	expect(long.text).toHaveLength(500);
	f.model.respond(fauxAssistantMessage("y".repeat(40_000)));
	await ops.send(client, { threadId: tid("b"), message: "longer" });
	await ops.wait(client, { threadId: tid("b") });
	f.model.respond(fauxAssistantMessage("z".repeat(40_000)));
	await ops.send(client, { threadId: tid("b"), message: "longest" });
	await ops.wait(client, { threadId: tid("b") });
	// Two items of 20,000 characters do not fit in 30,000 bytes: the newest is kept, the older waits for the next page.
	const cut = await ops.read(client, { threadId: tid("b"), beforePosition: 100, limit: 3, maxCharsPerItem: 20_000 });
	expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(30_000);
	expect(texts(cut).map((text) => text?.slice(0, 7))).toEqual(["longest", "z".repeat(7)]);
	expect(cut.items.at(-1)).toMatchObject({ textTruncated: true, nextTextOffset: 20_000 });
	expect(cut.earlierPosition).toBe(cut.items[0]!.position);
	// One item over the budget on its own is cut to fit.
	const alone = await ops.read(client, { threadId: tid("b"), beforePosition: 100, limit: 1, maxCharsPerItem: 50_000 });
	expect(Buffer.byteLength(JSON.stringify(alone))).toBeLessThanOrEqual(30_000);
	expect(alone.items[0]).toMatchObject({ textTruncated: true });
	expect(alone.items[0]!.text!.length).toBeGreaterThan(10_000);
});

it("names a project that does not exist", async () => {
	const { ops } = await setup();
	await expect(Promise.resolve().then(() => ops.list(client, { projectId: "nope" as never }))).rejects.toThrow("Project nope was not found.");
});

it("refuses to delete the built-in scratch project, as T3 0.1.11 does over MCP", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-durable-t3-ops-scratch-"));
	onTestFinished(() => rm(home, { recursive: true, force: true }));
	const { bridge, ops } = await setup({ scratchDir: join(home, "scratch") });
	const { projectId } = await bridge.ensureScratch();
	await expect(ops.projectDelete(client, { projectId, force: true })).rejects.toThrow('"No project" is the built-in scratch project and cannot be deleted through MCP. The user can remove it in Settings.');
	expect(bridge.isScratchProject(projectId), "still there").toBe(true);
	expect(await failureOf(() => ops.projectDelete(client, { projectId }))).toBe("invalid_request");
});

it("reports a project's default model from the settings' override for it, and schedules a client's task on it (T3 0.1.11)", async () => {
	const { f, bridge } = await setup();
	const tasks = new ScheduledTasks({ harness: f.harness, dispatch: scheduledTaskDispatch(bridge), log });
	await tasks.load();
	const ops = new ThreadOps(bridge, "env-1", log, tasks);
	const schedule = { type: "interval", everyMs: 3_600_000 } as never;
	const selection = { instanceId: "pi", model: "faux/override" };
	// Nothing saved: no project reports a default, and a client outside a thread cannot pick a model for a task.
	expect(ops.projectRead(client, { projectId: "p" }).defaultModelSelection).toBeNull();
	await expect(ops.scheduleTask(client, { projectId: "p", prompt: "x", schedule } as never)).rejects.toThrow("Project p has no default model, so this caller cannot pick one for it.");
	// The environment's default model is new threads' everywhere, so a task is scheduled on it; no project reports it as its own.
	bridge.config.settings.update({ defaultModelSelection: { instanceId: "pi", model: "faux/everywhere" } } as never);
	expect(ops.projectRead(client, { projectId: "p" }).defaultModelSelection).toBeNull();
	await ops.scheduleTask(client, { projectId: "q", prompt: "on the environment's", schedule } as never);
	// A project's own override is what the project tools report, and what its tasks run on.
	bridge.config.settings.update({ projectSettingsOverrides: { p: { defaultModelSelection: selection } } } as never);
	expect(ops.projectRead(client, { projectId: "p" }).defaultModelSelection).toMatchObject(selection);
	expect(ops.projectList(client, {}).projects.map((project) => project.defaultModelSelection?.model ?? null)).toEqual(["faux/override", null]);
	expect((await ops.projectUpdate(client, { projectId: "p", title: "Renamed" })).defaultModelSelection).toMatchObject(selection);
	await ops.scheduleTask(client, { projectId: "p", prompt: "on the project's", schedule } as never);
	expect(tasks.list().tasks.map((task) => [task.prompt, task.modelSelection.model]).sort()).toEqual([
		["on the environment's", "faux/everywhere"],
		["on the project's", "faux/override"],
	]);
});

it("lists and reads a thread's pin and snooze as they are; an agent's pin lands at the top of Pinned (T3 0.1.11)", { timeout: 60_000 }, async () => {
	const { bridge, ops } = await setup();
	const listed = () => ops.list(client, { allProjects: true }).threads;
	const row = (threadId: string) => listed().find((thread) => thread.threadId === threadId)!;
	expect(row("a")).toMatchObject({ pinned: false, snoozed: false, snoozedUntil: null, blockedOnThreadWait: false, pendingBackgroundTasks: [] });

	// Each pin gets T3's order key, before every pin there is, as a client's pin does.
	await ops.organize(client, { threadId: "a", action: "pin" });
	await ops.organize(client, { threadId: "b", action: "pin" });
	const keyOf = (threadId: string) => bridge.threadRecord(threadId)!.pinOrderKey;
	expect(keyOf("a")).toEqual(expect.any(String));
	expect(keyOf("b")! < keyOf("a")!, "the newer pin sorts first").toBe(true);
	expect(row("a").pinned).toBe(true);

	const until = new Date(Date.now() + 3_600_000).toISOString();
	await ops.organize(client, { threadId: "c", action: "snooze", snoozedUntil: until });
	const result = ops.list(client, { allProjects: true });
	encodes(OrchestratorMcpThreadListResult, result);
	expect(result.threads.find((thread) => thread.threadId === "c")).toMatchObject({ snoozed: true, snoozedUntil: until, pinned: false });
	expect(ops.list(client, { allProjects: true, snoozed: true }).threads.map((thread) => thread.threadId)).toEqual(["c"]);
	expect(ops.list(client, { allProjects: true, snoozed: false }).threads.map((thread) => thread.threadId).sort()).toEqual(["a", "b"]);
	const read = await ops.read(client, { threadId: tid("c") });
	encodes(OrchestratorMcpThreadReadResult, read);
	expect(read.thread).toMatchObject({ snoozed: true, snoozedUntil: until, pinned: false, blockedOnThreadWait: false, pendingBackgroundTasks: [], lastTitleRegeneration: null });
	expect((await ops.read(client, { threadId: tid("a") })).thread).toMatchObject({ pinned: true, snoozed: false });
});

it("answers a thread link passed as a thread id with the id to pass (T3 0.1.11)", async () => {
	const { ops } = await setup();
	const link = ops.list(client, { projectId: "p" as never }).threads.find((thread) => thread.threadId === "a")!.link!;
	await expect(ops.read(client, { threadId: tid(link) })).rejects.toThrow(`\`${link}\` is a thread link, not a thread id. Pass \`a\` instead.`);
	// The web app's link this host gives a client that signed in from a browser, too.
	await expect(ops.organize({ ...client, webOrigin: "https://claw.example" }, { threadId: "https://claw.example/env-1/b", action: "pin" })).rejects.toThrow("Pass `b` instead.");
	// A link to a thread that is not here, or to another environment, is not found.
	await expect(ops.read(client, { threadId: tid("t3-thread://v2/env-2/a") })).rejects.toThrow("Thread t3-thread://v2/env-2/a was not found.");
	await expect(ops.read(client, { threadId: tid("nope") })).rejects.toThrow("Thread nope was not found.");
});
