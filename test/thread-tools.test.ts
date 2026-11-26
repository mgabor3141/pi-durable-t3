// The thread tools as an agent's own tools (`T3Attachment.threadTools`), against a scripted model that answers by
// context: a parent starts a child and waits for its report; follows up on it; starts one without waiting and gets the
// report posted into its own thread as the next turn; adds a note without starting work; and a request to be answered
// that a previous process left on a record is delivered after a restart.
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { GenerationTask } from "@earendil-works/pi-durable";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { USER_WEB } from "../src/threads.ts";
import type { Logger } from "../src/t3/logging.ts";
import { Orchestration } from "../src/t3/orchestration.ts";
import { ScheduledTasks, scheduledTaskDispatch } from "../src/t3/scheduled-tasks.ts";
import { ThreadOps } from "../src/t3/thread-ops.ts";
import { childCardNodeId } from "../src/t3/projection.ts";
import { threadToolsExtension } from "../src/t3/thread-tools.ts";
import { mergeBackContext, sideChatNote } from "../src/t3/side-chats.ts";
import { conversation, createNamed, makeThreads, bridgeConfig } from "./threads-harness.ts";
import { until } from "./wait.ts";

const log: Logger = { info: () => {}, warn: () => {} };

afterEach(() => vi.restoreAllMocks());
type Msg = { role: string; content: unknown };
/** A message's own text: the hidden blocks the host adds for the model (who sent it) are not part of what it says. */
const textOf = (message: Msg | undefined): string =>
	message === undefined ? "" : typeof message.content === "string" ? message.content : (message.content as { type: string; text?: string; hidden?: boolean }[]).map((block) => (block.hidden === true ? "" : (block.text ?? ""))).join("");

/** Named holds: a "Hold on: <name>" message is answered once the test releases <name>. */
const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
const gate = (name: string) => {
	let entry = gates.get(name);
	if (entry === undefined) {
		let release = () => {};
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		entry = { promise, release };
		gates.set(name, entry);
	}
	return entry;
};

/** One generation, chosen by the conversation's latest message. */
const brain: FauxResponseStep = (context, options) => {
	const messages = context.messages as unknown as Msg[];
	const last = messages.at(-1)!;
	const lastText = textOf(last);
	// A child: answers the arithmetic it was last asked.
	const sum = lastText.startsWith("Delegate ") || lastText.startsWith("[Report from thread") ? null : (/What is (\d+)\+(\d+)\?/.exec(lastText) ?? /And (\d+)\+(\d+)\?/.exec(lastText));
	if (last.role === "user" && sum !== null) return fauxAssistantMessage(String(Number(sum[1]) + Number(sum[2])));
	if (last.role === "user" && lastText.startsWith("[Report from thread")) return fauxAssistantMessage(`Got the report: ${lastText.split("\n").at(-1)}`);
	const hold = /^Hold on: (\S+)/.exec(lastText);
	if (last.role === "user" && hold !== null) {
		// A held answer gives way to an interrupt, as a model's stream does.
		const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
		const aborted = new Promise<"aborted">((resolve) => signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
		return Promise.race([gate(hold[1]!).promise, aborted]).then((outcome) =>
			outcome === "aborted" ? fauxAssistantMessage("", { stopReason: "aborted" }) : fauxAssistantMessage(`released ${hold[1]}`),
		);
	}
	// A long answer, once released: "Long: <name>" answers 9,000 characters of the name's first letter.
	const long = /^Long: (\S+)/.exec(lastText);
	if (last.role === "user" && long !== null) return gate(long[1]!).promise.then(() => fauxAssistantMessage(long[1]![0]!.repeat(9_000)));
	if (last.role === "toolResult") return fauxAssistantMessage(`Parent saw: ${lastText}`);
	if (last.role === "user" && lastText.startsWith("Delegate ")) {
		const call = JSON.parse(lastText.slice("Delegate ".length)) as { name: string; args: Record<string, unknown> };
		return fauxAssistantMessage([fauxToolCall(call.name, call.args as never, { id: `call-${messages.length}` })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage("ok");
};

async function setup(options: { readonly webhookOrigin?: () => string } = {}) {
	let bridge: Bridge | undefined;
	const late = new Proxy({} as Bridge, { get: (_target, key) => (bridge as unknown as Record<string | symbol, unknown>)[key] instanceof Function ? (bridge as never as Record<string | symbol, (...args: unknown[]) => unknown>)[key]!.bind(bridge) : (bridge as unknown as Record<string | symbol, unknown>)[key] });
	const orchestration = new Orchestration(late, log);
	let tasks: ScheduledTasks | undefined;
	const lateTasks = new Proxy({} as ScheduledTasks, { get: (_target, key) => { const value = (tasks as unknown as Record<string | symbol, unknown>)[key]; return value instanceof Function ? value.bind(tasks) : value; } });
	const ops = new ThreadOps(late, "env-1", log, lateTasks);
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [threadToolsExtension(late, orchestration, { ops })] });
	f.model.respond(...Array.from({ length: 60 }, () => brain));
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Parent" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-threads-"));
	bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	orchestration.start();
	tasks = new ScheduledTasks({ harness: f.harness, dispatch: scheduledTaskDispatch(bridge), log, ...(options.webhookOrigin === undefined ? {} : { webhookOrigin: options.webhookOrigin }) });
	await tasks.load();
	onTestFinished(async () => {
		for (const entry of gates.values()) entry.release();
		gates.clear();
		orchestration.close();
		await bridge!.close();
		await rm(scratch, { recursive: true, force: true });
	});
	let n = 0;
	const ask = async (threadId: string, call: { name: string; args: Record<string, unknown> }) => {
		n += 1;
		await bridge!.sendMessage({ threadId, commandId: `c-${n}`, messageId: `m-${n}`, text: `Delegate ${JSON.stringify(call)}`, mode: "queue" });
	};
	const settled = (threadId: string, check: (projection: Awaited<ReturnType<Bridge["projection"]>>["projection"]) => boolean = () => true) =>
		bridge!.waitFor(threadId, (projection) => (projection.runs.length > 0 && projection.runs.every((run) => !["queued", "running", "starting", "preparing", "waiting"].includes(run.status)) && check(projection) ? projection : undefined), 20_000);
	const sawAll = async (count: number) => {
		const projection = await settled("a", (candidate) => candidate.messages.filter((message) => message.text.startsWith("Parent saw:")).length >= count);
		return projection!.messages.filter((message) => message.text.startsWith("Parent saw:")).map((message) => JSON.parse(message.text.slice("Parent saw: ".length)));
	};
	return { bridge, orchestration, f, ask, settled, sawAll, ops, create, tasks: () => tasks! };
}

it("a parent starts a child, waits for its report, and follows up on it", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 2+2?" } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const saw = parent!.messages.find((message) => message.text.startsWith("Parent saw:"))!.text;
	const result = JSON.parse(saw.slice("Parent saw: ".length)) as { threadId: string; verdict: string; report: string; notify: boolean };
	expect(result).toMatchObject({ verdict: "completed", notify: false });
	expect(result.report).toContain("[YOU]: What is 2+2?");
	expect(result.report).toContain("[AGENT]: 4");

	// The child is a thread of its own, linked to the run that started it, and shown as a card there.
	const child = bridge.threadRecord(result.threadId)!;
	expect(child.lineage).toEqual({ parentThreadId: "a", relationshipToParent: "subagent", rootThreadId: "a" });
	// An integrator is told whose a conversation is, to treat an agent's thread differently from a person's.
	expect(bridge.threadOf(child.head)).toMatchObject({ threadId: child.threadId, createdBy: "agent", parentThreadId: "a", relationshipToParent: "subagent", sideChat: false });
	expect(bridge.threadOf(bridge.threadRecords().find((thread) => thread.threadId === "a")!.head)).toMatchObject({ threadId: "a", createdBy: "user", parentThreadId: null });
	expect(bridge.threadOf(999_999)).toBeUndefined();
	expect(child.forkedFrom).toEqual({ type: "node", nodeId: childCardNodeId(result.threadId) });
	expect(child.spawn).toMatchObject({ prompt: "What is 2+2?", parentRunId: parent!.runs[0]!.id });
	const card = parent!.subagents.find((subagent) => (subagent.childThreadId as string | null) === result.threadId);
	expect(card).toMatchObject({ origin: "app_owned", status: "completed", result: "4", runId: parent!.runs[0]!.id });
	expect(parent!.turnItems.some((item) => item.type === "subagent" && (item as { childThreadId?: string }).childThreadId === result.threadId)).toBe(true);
	const message = (await bridge.projection(result.threadId)).projection.messages.find((candidate) => candidate.role === "user");
	expect(message).toMatchObject({ text: "What is 2+2?", createdBy: "agent", senderThreadId: "a" });

	// A follow-up to the same child: it answers with its history.
	await ask("a", { name: "thread_prompt", args: { threadId: result.threadId, message: "And 3+3?" } });
	const again = await settled("a", (projection) => projection.messages.filter((candidate) => candidate.text.startsWith("Parent saw:")).length === 2);
	const second = JSON.parse(again!.messages.filter((candidate) => candidate.text.startsWith("Parent saw:")).at(-1)!.text.slice("Parent saw: ".length)) as { threadId: string; report: string };
	expect(second.threadId).toBe(result.threadId);
	expect(second.report).toContain("[AGENT]: 6");
	expect((await bridge.projection(result.threadId)).projection.runs).toHaveLength(2);
});

it("an agent's thread_search finds an archived subagent child by the prompt an agent sent it", { timeout: 60_000 }, async () => {
	const { ask, sawAll, f } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 7+8? Count the zebrafish." } });
	const [started] = (await sawAll(1)) as { threadId: string }[];
	await f.threads.updateRecord(started!.threadId, (record) => {
		record.archivedAt = Date.now();
	});
	// T3's own search (the web app's) leaves an archived subagent and an agent's prompt out; the agent's tool does not.
	expect((await f.threads.search("zebrafish", 50)).map((match) => match.threadId)).not.toContain(started!.threadId);
	await ask("a", { name: "thread_search", args: { query: "zebrafish count" } });
	const [, found] = (await sawAll(2)) as [unknown, { matches: { threadId: string; snippet: string }[] }];
	expect(found.matches.find((match) => match.threadId === started!.threadId)).toMatchObject({ snippet: "What is 7+8? Count the zebrafish." });
});

it("a child started without waiting reports back into its parent, which wakes for it", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 5+5?", wait: false } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report")));
	const saw = JSON.parse(parent!.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length)) as { threadId: string; notify: boolean };
	expect(saw.notify).toBe(true);
	const delivered = parent!.messages.find((message) => message.role === "user" && message.text.startsWith("[Report from thread"));
	expect(delivered).toMatchObject({ createdBy: "agent", creationSource: "server", senderThreadId: saw.threadId });
	expect(delivered!.text).toContain("completed]");
	expect(delivered!.text).toContain("[YOU]: What is 5+5?");
	expect(delivered!.text).toContain("[AGENT]: 10");
	expect(parent!.messages.find((message) => message.text.startsWith("Got the report"))!.text).toBe("Got the report: [AGENT]: 10");
	expect(bridge.threadRecord(saw.threadId)!.notify ?? []).toEqual([]);
	// A person sees T3's notice row, which opens the child's card, not a bubble of the report's text.
	const card = parent!.subagents.find((subagent) => subagent.childThreadId === saw.threadId)!;
	const rows = parent!.turnItems.filter((item) => (item as { messageId?: string }).messageId === delivered!.id || (item.type === "notification" && item.runId === delivered!.runId));
	expect(rows).toEqual([
		expect.objectContaining({ type: "notification", source: { kind: "delegated_task", taskIds: [card.id], childThreadId: saw.threadId }, outcome: "completed", summary: `Delegated task "${card.title}" finished`, detail: delivered!.text }),
	]);
	// What other threads are told of this one still holds the report the model read: a side chat's digest, and what a
	// fork brings back.
	expect(sideChatNote("a", parent!, undefined)).toContain("- User: [Report from thread");
	expect(mergeBackContext({ threadId: "a", title: "Parent", sideChat: false }, parent!, undefined, parent!.runs.at(-1)!.id as string)).toContain("[User]\n[Report from thread");
});

it("a note joins a thread's context without starting work; reads, lists and the restart delivery", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, f } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Child" }, message: "What is 1+1?" } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const childId = (JSON.parse(parent!.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length)) as { threadId: string }).threadId;

	await ask("a", { name: "thread_prompt", args: { threadId: childId, message: "FYI: the answer is used by a report.", mode: "notify" } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 2);
	const child = (await bridge.projection(childId)).projection;
	expect(child.runs, "a note starts no run").toHaveLength(1);
	expect(child.messages.some((message) => message.role === "user" && message.text === "FYI: the answer is used by a report.")).toBe(true);

	// Reads and lists, through the tools.
	await ask("a", { name: "thread_read", args: { threadId: childId } });
	await ask("a", { name: "thread_list", args: { parent: "self" } });
	const read = await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 4);
	const [readResult, listResult] = read!.messages.filter((message) => message.text.startsWith("Parent saw:")).slice(2).map((message) => JSON.parse(message.text.slice("Parent saw: ".length)));
	expect(readResult.text).toContain("=== exchange 1 (completed) ===");
	// The reader's own messages are [YOU], as in thread_prompt's report, and the note, sent after the answer, follows it.
	const order = ["[YOU]: What is 1+1?", "[AGENT]: 2", "[YOU]: FYI: the answer is used by a report."].map((line) => readResult.text.indexOf(line));
	expect(order.every((index: number) => index >= 0), readResult.text).toBe(true);
	expect(order).toEqual(order.toSorted((x: number, y: number) => x - y));
	expect(readResult.text).not.toContain("[THREAD");
	expect(listResult.threads).toEqual([expect.objectContaining({ threadId: childId, title: "Child", parentThreadId: "a" })]);

	// A request to be answered that the last process kept on the record: a new process delivers it.
	await bridge.updateThreadRecord(childId, (record) => {
		record.notify = [{ id: "restart-1", threadId: "a", messageId: child.messages.find((message) => message.role === "user")!.id as string, createdAt: Date.now() }];
	});
	const next = new Orchestration(bridge, log);
	next.start();
	onTestFinished(() => next.close());
	const woke = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("[Report from thread") && message.text.includes("Child")));
	expect(woke).toBeDefined();
	expect(bridge.threadRecord(childId)!.notify ?? []).toEqual([]);
	void f;
});

it("thread_cancel stops a thread and its children, and nobody is woken by the stopped work", { timeout: 60_000 }, async () => {
	const { bridge, f, ask, sawAll, settled } = await setup();
	// The child starts a grandchild that holds, without waiting, then finishes its own turn; it still waits for the
	// grandchild's report, and so does the parent for the child's.
	const grand = { name: "thread_prompt", args: { new: { title: "Grandchild" }, message: "Hold on: g1", wait: false } };
	await ask("a", { name: "thread_prompt", args: { new: { title: "Child" }, message: `Delegate ${JSON.stringify(grand)}`, wait: false } });
	const [first] = await sawAll(1);
	const child = first.threadId as string;
	await settled(child, (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const grandchild = bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === child)!.threadId;
	await bridge.waitFor(grandchild, (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	expect(bridge.threadRecord(grandchild)!.notify).toEqual([expect.objectContaining({ threadId: child })]);

	await ask("a", { name: "thread_cancel", args: { threadId: child } });
	const [, cancelled] = await sawAll(2);
	expect(cancelled).toEqual({ stopped: [grandchild] });
	expect(bridge.threadRecord(grandchild)!.notify ?? [], "the child is not woken by its stopped grandchild").toEqual([]);
	const stopped = await bridge.waitFor(grandchild, (projection) => (projection.runs.every((run) => run.status !== "running") ? projection : undefined), 10_000);
	expect(stopped!.runs.at(-1)!.status).toBe("interrupted");
	expect((await bridge.projection(child)).projection.runs, "the child did not start again").toHaveLength(1);
	expect((await bridge.projection("a")).projection.messages.filter((message) => message.text.startsWith("[Report from thread")), "the parent that stopped it is told nothing").toEqual([]);

	// The stopped agent is told with its next message that an agent stopped it, not the user.
	await bridge.sendMessage({ threadId: grandchild, commandId: "after-cancel", messageId: "after-cancel", text: "What is 1+1?", mode: "queue" });
	await settled(grandchild, (projection) => projection.messages.some((message) => message.text === "2"));
	const head = (await f.threads.thread(grandchild))!.head;
	const asked = (await (await conversation(f.harness, head)).context(BACKGROUND_CONTEXT)).messages.findLast((message) => message.role === "user")!;
	expect(asked.content).toEqual([
		{ type: "text", text: "What is 1+1?" },
		{ type: "text", text: "[Another agent stopped your previous turn before it finished.]", hidden: true },
	]);
});

it("a person's Stop on a parent stops its children too, and no report of theirs wakes it", { timeout: 60_000 }, async () => {
	const { bridge, ask } = await setup();
	// One child the parent waits for, and one it started without waiting, which asked for its report.
	await ask("a", { name: "thread_prompt", args: { new: { title: "Background" }, message: "Hold on: s2", wait: false } });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Waited" }, message: "Hold on: s1" } });
	const child = (title: string) => bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === "a" && thread.title === title)?.threadId;
	await until("both children", () => child("Waited") !== undefined && child("Background") !== undefined);
	for (const title of ["Waited", "Background"]) await bridge.waitFor(child(title)!, (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	// The wait listens for the parent's Stop (a tool's abort is its context's signal), so the parent does not wait for s1.
	const pressed = Date.now();
	await bridge.interrupt("a");
	const parent = await bridge.waitFor("a", (projection) => (projection.runs.every((run) => run.status !== "running") ? projection : undefined), 2_000);
	expect(parent, "the parent ended before its children").toBeDefined();
	expect(Date.now() - pressed).toBeLessThan(2_000);
	for (const title of ["Waited", "Background"]) {
		const stopped = await bridge.waitFor(child(title)!, (projection) => (projection.runs.at(-1)?.status === "interrupted" ? true : undefined), 5_000);
		expect(stopped, `${title} was stopped with its parent`).toBe(true);
	}
	gate("s1").release();
	gate("s2").release();
	await new Promise((resolve) => setTimeout(resolve, 500));
	const after = (await bridge.projection("a")).projection;
	expect(after.messages.filter((message) => message.text.startsWith("[Report from thread")), "no report woke the stopped parent").toEqual([]);
	expect(after.runs.filter((run) => run.status === "running" || run.status === "queued")).toEqual([]);
	for (const title of ["Waited", "Background"]) expect((bridge.threadRecord(child(title)!)?.notify ?? []).length, `${title} owes no report`).toBe(0);
});

it("a child that hands work on without waiting reports once that work is done, not when its own turn ends", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	const inner = JSON.stringify({ name: "thread_prompt", args: { new: { title: "Grandchild" }, message: "Hold on: g1", wait: false } });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Child" }, message: `Delegate ${inner}`, wait: false } });
	const childOf = (parent: string) => bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === parent)?.threadId;
	await until("the child", () => childOf("a") !== undefined);
	const child = childOf("a")!;
	await until("the grandchild", () => childOf(child) !== undefined);
	// The child's turn ends once it has started the grandchild; the grandchild still works.
	await settled(child, (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const waiting = (await bridge.projection("a")).projection;
	expect(waiting.messages.filter((message) => message.text.startsWith("[Report from thread")), "no report before the grandchild's work is done").toEqual([]);
	expect(waiting.subagents.find((subagent) => subagent.childThreadId === child), "its card shows it working, waiting for the grandchild").toMatchObject({ status: "running", result: null });
	gate("g1").release();
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report:")));
	const reports = parent!.messages.filter((message) => message.text.startsWith("[Report from thread"));
	expect(reports).toHaveLength(1);
	expect(reports[0]!.text.split("\n").at(-1), "the child's answer after the grandchild's report").toBe("[AGENT]: Got the report: [AGENT]: released g1");
});

it("a prompt whose queued message a person removes asks for nothing more, and its caller still settles", { timeout: 60_000 }, async () => {
	const { bridge, orchestration, ask, settled, sawAll } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Held" }, message: "Hold on: x", wait: false } });
	const [started] = await sawAll(1);
	const child = started.threadId as string;
	await bridge.waitFor(child, (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await ask("a", { name: "thread_prompt", args: { threadId: child, message: "What is 1+1?", wait: false } });
	await sawAll(2);
	const queued = await bridge.waitFor(child, (projection) => projection.runs.find((run) => run.status === "queued"), 10_000);
	await bridge.cancelQueued(child, queued!.id as string);
	gate("x").release();
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report:")));
	// The parent is not held by a report that will never come: a wait for it ends, completed.
	const waited = await orchestration.wait(undefined, ["a"], 3_000);
	expect(waited.verdict).toBe("completed");
	expect(bridge.threadRecord(child)?.notify ?? []).toEqual([]);
});

it("a prompt the thread refuses asks for nothing, and its caller still settles", { timeout: 60_000 }, async () => {
	const { bridge, orchestration, ask, sawAll } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 1+1?" } });
	const [first] = await sawAll(1);
	const child = first.threadId as string;
	// A steer to a child that is not working is refused.
	await ask("a", { name: "thread_prompt", args: { threadId: child, message: "And 2+2?", mode: "steer", wait: false } });
	await sawAll(2);
	expect(bridge.threadRecord(child)?.notify ?? []).toEqual([]);
	expect((await orchestration.wait(undefined, ["a"], 3_000)).verdict).toBe("completed");
});

it("a person's message to a child that finished is reported to its parent; another thread's is not", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, ops, create } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 2+2?" } });
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const child = bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === "a")!.threadId;
	await dispatchCommand(bridge, { type: "message.dispatch", commandId: "person-1", threadId: child, messageId: "person-m1", text: "And 3+4?", dispatchMode: { type: "queue_after_active" } } as never, USER_WEB, log);
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report:")));
	const report = parent!.messages.find((message) => message.text.startsWith("[Report from thread"))!.text;
	expect(report).toContain("[USER]: And 3+4?");
	expect(report.split("\n").at(-1)).toBe("[AGENT]: 7");
	// Its notice opens the child's card, which shows the newest result. (The first report came back to the parent's wait,
	// so it has no notice.)
	const card = parent!.subagents.find((subagent) => subagent.childThreadId === child)!;
	expect(parent!.turnItems.filter((item) => item.type === "notification")).toEqual([expect.objectContaining({ source: { kind: "delegated_task", taskIds: [card.id], childThreadId: child } })]);
	// Another thread that writes to the child (T3's `t3_thread_send`) asked for its own answer: the parent is not told.
	await create({ threadId: "b", projectId: "p", title: "Other" });
	await ops.send({ threadId: "b" }, { threadId: child, message: "And 1+1?" } as never);
	await settled(child, (projection) => projection.messages.some((message) => message.role === "assistant" && message.text === "2"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect((await bridge.projection("a")).projection.messages.filter((message) => message.text.startsWith("[Report from thread"))).toHaveLength(1);
	// The person writes again: of the two notices, only the newest opens the card (which shows that result); the earlier
	// is its line alone.
	await dispatchCommand(bridge, { type: "message.dispatch", commandId: "person-2", threadId: child, messageId: "person-m2", text: "And 5+5?", dispatchMode: { type: "queue_after_active" } } as never, USER_WEB, log);
	const again = await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Got the report:")).length === 2);
	expect(again!.turnItems.filter((item) => item.type === "notification").map((item) => (item as { source: unknown }).source)).toEqual([
		{ kind: "delegated_task", taskIds: [], childThreadId: child },
		{ kind: "delegated_task", taskIds: [card.id], childThreadId: child },
	]);
});

it("a child shows as working in its parent while a person's message to its own child is answered", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	const inner = JSON.stringify({ name: "thread_prompt", args: { new: { title: "Grandchild" }, message: "What is 1+1?", wait: false } });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Child" }, message: `Delegate ${inner}`, wait: false } });
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report:")));
	const child = bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === "a")!.threadId;
	const grandchild = bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === child)!.threadId;
	expect((await bridge.projection("a")).projection.subagents[0]).toMatchObject({ status: "completed" });
	// A person writes to the grandchild: the child waits for its report now, and its card in the parent says so.
	await dispatchCommand(bridge, { type: "message.dispatch", commandId: "person-g", threadId: grandchild, messageId: "person-g1", text: "Hold on: z", dispatchMode: { type: "queue_after_active" } } as never, USER_WEB, log);
	const working = await bridge.waitFor("a", (projection) => (projection.subagents[0]?.status === "running" ? projection.subagents[0] : undefined), 3_000);
	expect(working, "the child's card shows it working").toMatchObject({ status: "running", result: null });
	gate("z").release();
	const done = await bridge.waitFor("a", (projection) => (projection.subagents[0]?.status === "completed" ? projection.subagents[0] : undefined), 10_000);
	expect(done).toMatchObject({ status: "completed" });
});

it("one message holds at most 16,000 characters of reports; a report past that says where to read it", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "First" }, message: "Long: a1", wait: false } });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Second" }, message: "Long: b1", wait: false } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 2);
	// The parent works while both settle: the first report waits for its turn to take it, and the second joins it.
	await bridge.sendMessage({ threadId: "a", commandId: "busy", messageId: "busy-m", text: "Hold on: p", mode: "queue" });
	await bridge.waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	gate("a1").release();
	await until("the first report waits in the parent's queue", async () => (await bridge.waitingMessages("a")).some((message) => message.messageId.startsWith("n-")));
	gate("b1").release();
	await until("the second report joined it", async () => (await bridge.waitingMessages("a")).some((message) => message.text.includes('[Report from thread "Second"')));
	gate("p").release();
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report:")));
	const text = parent!.messages.find((message) => message.text.startsWith("[Report from thread"))!.text;
	expect(text).toContain(`[AGENT]: ${"a".repeat(9_000)}`);
	expect(text).not.toContain("b".repeat(100));
	const second = bridge.threadRecords().find((thread) => thread.title === "Second")!.threadId;
	expect(text).toContain(`[Not shown: this message holds enough reports already. Read it with thread_read, threadId ${second}]`);
	const row = parent!.turnItems.find((item) => item.type === "notification");
	expect(row).toMatchObject({ outcome: "completed", summary: "2 delegated tasks finished: First, Second", source: { kind: "delegated_task", taskIds: parent!.subagents.map((subagent) => subagent.id) } });
});

it("thread_wait collects several children's reports with the worst verdict", { timeout: 60_000 }, async () => {
	const { ask, sawAll } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 1+2?", wait: false, notify: false } });
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 3+4?", wait: false, notify: false } });
	const started = await sawAll(2);
	await ask("a", { name: "thread_wait", args: { threadIds: started.map((entry) => entry.threadId) } });
	const [, , waited] = await sawAll(3);
	expect(waited.verdict).toBe("completed");
	expect(waited.reports.map((entry: { report: string }) => entry.report.split("\n").at(-1))).toEqual(["[AGENT]: 3", "[AGENT]: 7"]);
});

it("a report the parent collects with thread_wait is not posted into its thread again", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll, settled } = await setup();
	// Started without waiting (so each asks to be answered), held until the parent is waiting for them.
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "Hold on: fan1", wait: false } });
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "Hold on: fan2", wait: false } });
	const started = await sawAll(2);
	expect(started.map((entry) => entry.notify)).toEqual([true, true]);
	// And one whose own wait ran out, which asks to be answered then.
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "Hold on: slow1", timeoutMs: 200 } });
	const [, , ranOut] = await sawAll(3);
	expect(ranOut).toMatchObject({ verdict: "active", notify: true });
	const children = [...started.map((entry) => entry.threadId as string), ranOut.threadId as string];
	await ask("a", { name: "thread_wait", args: { threadIds: children } });
	await new Promise((resolve) => setTimeout(resolve, 200));
	for (const name of ["fan1", "fan2", "slow1"]) gate(name).release();
	const [, , , waited] = await sawAll(4);
	expect(waited.verdict).toBe("completed");
	expect(waited.reports.map((entry: { report: string }) => entry.report.split("\n").at(-1))).toEqual(["[AGENT]: released fan1", "[AGENT]: released fan2", "[AGENT]: released slow1"]);
	// Collected, so answered: no request left, and nothing posted or queued in the parent.
	for (const child of children) expect(bridge.threadRecord(child)!.notify ?? []).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 300));
	const parent = await settled("a");
	expect(parent!.messages.filter((message) => message.text.startsWith("[Report from thread"))).toEqual([]);
	expect(parent!.runs.filter((run) => run.status === "queued")).toEqual([]);
});

it("a busy parent gets its children's reports in its turn, joined into one message while it waits there (T3's delegated completion)", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll, settled } = await setup();
	for (const name of ["b1", "b2", "b3"]) await ask("a", { name: "thread_prompt", args: { new: { title: name }, message: `Hold on: ${name}`, wait: false } });
	const children = (await sawAll(3)).map((entry) => entry.threadId as string);
	// The parent is busy while all three finish: its request waits for an answer.
	await bridge.sendMessage({ threadId: "a", commandId: "busy", messageId: "m-busy", text: "Hold on: parent", mode: "queue" });
	await bridge.waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	for (const name of ["b1", "b2", "b3"]) {
		gate(name).release();
		await settled(children[["b1", "b2", "b3"].indexOf(name)]!);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	// One message, steered at the running turn, which the next two joined; it waits in that turn, to be read at its
	// next boundary, and is never queued.
	// It shows as T3's notice row, waiting with it.
	const during = await bridge.waitFor("a", (projection) => {
		const waiting = projection.turnItems.filter((item) => item.type === "notification" && item.status === "pending") as { detail?: string }[];
		const message = waiting.length === 1 ? projection.messages.find((candidate) => candidate.text === waiting[0]!.detail) : undefined;
		return message !== undefined && message.text.includes("released b3") && !projection.runs.some((run) => run.status === "queued") ? { message, row: waiting[0] } : undefined;
	}, 10_000);
	expect(during, "one pending message holding all three").toBeDefined();
	expect(during!.message.text).toContain("[AGENT]: released b1");
	expect(during!.message.text).toContain("[AGENT]: released b2");
	expect(during!.message.text.indexOf("released b1")).toBeLessThan(during!.message.text.indexOf("released b3"));
	expect(during!.row).toMatchObject({ summary: "3 delegated tasks finished: b1, b2, b3", outcome: "completed" });
	gate("parent").release();
	const after = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report")));
	const posted = after!.messages.filter((message) => message.role === "user" && message.text.includes("[Report from thread"));
	expect(posted, "one message for the three reports").toHaveLength(1);
	expect(after!.messages.filter((message) => message.text.startsWith("Got the report")), "one turn").toHaveLength(1);
	for (const child of children) expect(bridge.threadRecord(child)!.notify ?? []).toEqual([]);
});

it("a report the parent collects while it still waits in its queue is taken out, and a message left empty is cancelled", { timeout: 60_000 }, async () => {
	const { bridge, orchestration, ask, sawAll, settled } = await setup();
	for (const name of ["r1", "r2"]) await ask("a", { name: "thread_prompt", args: { new: { title: name }, message: `Hold on: ${name}`, wait: false } });
	const [first, second] = (await sawAll(2)).map((entry) => entry.threadId as string);
	await bridge.sendMessage({ threadId: "a", commandId: "busy", messageId: "m-busy", text: "Hold on: parent2", mode: "queue" });
	await bridge.waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	gate("r1").release();
	await settled(first!);
	gate("r2").release();
	await settled(second!);
	// The report message waiting in the parent's turn: a steer not read yet.
	const pendingMessage = () => bridge.waitingMessages("a").then((waiting) => waiting.find((message) => message.messageId.startsWith("n-")));
	await bridge.waitFor("a", (projection) => (projection.messages.some((message) => message.text.includes("released r2") && message.text.includes("released r1")) ? true : undefined), 10_000);
	// The parent reads the first child itself: that report leaves the message; the other stays.
	await orchestration.read("a", { threadId: first! });
	const after = await pendingMessage();
	expect(after?.text).not.toContain("released r1");
	expect(after?.text).toContain("[AGENT]: released r2");
	expect(after?.text.startsWith("[Report from thread")).toBe(true);
	// It collects the second with thread_wait: the message is left with none, and cancelled.
	await orchestration.wait("a", [second!], 5_000);
	expect(await pendingMessage()).toBeUndefined();
	gate("parent2").release();
	const done = await settled("a", (projection) => projection.messages.some((message) => message.text === "released parent2"));
	await new Promise((resolve) => setTimeout(resolve, 300));
	const final = (await bridge.projection("a")).projection;
	expect(final.messages.filter((message) => message.role === "user" && message.text.includes("[Report from thread"))).toEqual([]);
	expect(final.messages.filter((message) => message.text.startsWith("Got the report"))).toEqual([]);
	void done;
});

it("a report message splits into its reports by their headers", async () => {
	const { reportBlocks, reportChild } = await import("../src/t3/notices.ts");
	const one = '[Report from thread "A \"quoted\" title" (t-a1), completed]\n[YOU]: go\n\n[AGENT]: done\n\nwith a blank line';
	const two = '[Report from thread "B" (t-b2), failed]\n[AGENT]: [Report from thread "X" (t-x), completed] is quoted, not a header';
	const blocks = reportBlocks(`${one}\n\n${two}`);
	expect(blocks).toEqual([one, two]);
	expect(blocks.map(reportChild)).toEqual(["t-a1", "t-b2"]);
});

it("a report whose delivery fails once is delivered when it is tried again", { timeout: 60_000 }, async () => {
	// The pause before a failed delivery is tried again, shortened.
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 10_000 ? 20 : ms)) as typeof setTimeout);
	const { bridge, ask, settled } = await setup();
	const send = bridge.sendMessage.bind(bridge);
	let failed = 0;
	(bridge as unknown as { sendMessage: typeof send }).sendMessage = async (input) => {
		if (input.commandId.startsWith("notify-") && failed === 0) {
			failed++;
			throw new Error("transient: storage busy");
		}
		return send(input);
	};
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 5+5?", wait: false } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report")));
	expect(failed).toBe(1);
	expect(parent!.messages.filter((message) => message.role === "user" && message.text.startsWith("[Report from thread"))).toHaveLength(1);
	const child = bridge.threadRecords().find((thread) => thread.threadId !== "a")!;
	expect(child.notify ?? []).toEqual([]);
});

it("a batch the last process wrote before it stopped is sent once, as one message", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 2+3?" } });
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 4+5?" } });
	const children = (await sawAll(2)).map((entry) => entry.threadId as string);
	for (const [index, child] of children.entries()) {
		const first = (await bridge.projection(child)).projection.messages.find((message) => message.role === "user")!.id as string;
		await bridge.updateThreadRecord(child, (record) => {
			record.notify = [{ id: `crash-${index}`, threadId: "a", messageId: first, createdAt: index, batch: "crash-batch" }];
		});
	}
	const next = new Orchestration(bridge, log);
	next.start();
	onTestFinished(() => next.close());
	const woke = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report")));
	const posted = woke!.messages.filter((message) => message.role === "user" && message.text.includes("[Report from thread"));
	expect(posted).toHaveLength(1);
	expect(posted[0]!.text).toContain("[AGENT]: 5");
	expect(posted[0]!.text).toContain("[AGENT]: 9");
	for (const child of children) expect(bridge.threadRecord(child)!.notify ?? []).toEqual([]);
});

it("a prompt that waits and also asked to be answered gets the report once", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "What is 8+8?", notify: true } });
	const [answered] = await sawAll(1);
	expect(answered).toMatchObject({ verdict: "completed", notify: false });
	expect(answered.report).toContain("[AGENT]: 16");
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(bridge.threadRecord(answered.threadId)!.notify ?? []).toEqual([]);
	expect((await settled("a"))!.messages.filter((message) => message.text.startsWith("[Report from thread"))).toEqual([]);
});

it("a forked child starts with its parent's history; children nest at most three deep", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll } = await setup();
	await ask("a", { name: "thread_list", args: {} });
	await sawAll(1);
	await ask("a", { name: "thread_prompt", args: { new: { fork: true }, message: "What is 7+7?" } });
	const [, forked] = await sawAll(2);
	expect(forked.report).toContain("[AGENT]: 14");
	const child = (await bridge.projection(forked.threadId)).projection;
	expect(child.messages[0]!.text, "the parent's first exchange came along").toContain("thread_list");
	expect(bridge.threadRecord(forked.threadId)!.lineage).toMatchObject({ parentThreadId: "a", relationshipToParent: "subagent" });

	// a → t1 → t2 → t3 is the limit: t3 cannot start a child.
	const nest = (depth: number): string =>
		depth === 0 ? "What is 0+0?" : `Delegate ${JSON.stringify({ name: "thread_prompt", args: { new: {}, message: nest(depth - 1) } })}`;
	await ask("a", { name: "thread_prompt", args: { new: {}, message: nest(3) } });
	const [, , nested] = await sawAll(3);
	expect(nested.report).toContain("nest at most 3 deep");
});

it("a wait that runs out returns at once; the report is sent when the work settles", { timeout: 60_000 }, async () => {
	const { ask, sawAll, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "Hold on: w1", timeoutMs: 300 } });
	const [ended] = await sawAll(1);
	expect(ended).toMatchObject({ verdict: "active", notify: true });
	gate("w1").release();
	const woke = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("[Report from thread")));
	expect(woke!.messages.find((message) => message.text.startsWith("[Report from thread"))!.text).toContain("[AGENT]: released w1");
});

it("an agent lists, creates, renames, repoints and deletes projects with T3's project tools", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll, f } = await setup();
	const folder = join(f.root, "made-by-agent");
	const elsewhere = join(f.root, "elsewhere");
	await mkdir(elsewhere);
	const steps: { name: string; args: Record<string, unknown> }[] = [
		{ name: "t3_project_list", args: {} },
		{ name: "t3_project_create", args: { title: "Agent's", workspaceRoot: folder, createWorkspaceRootIfMissing: true } },
		{ name: "t3_project_create", args: { title: "From a title" } },
		{ name: "t3_project_create", args: { title: "Again", workspaceRoot: folder } },
	];
	for (const step of steps) await ask("a", step);
	const [listed, created, untitled, twice] = await sawAll(steps.length);
	expect(listed).toMatchObject({ projects: [{ id: "p", workspaceRoot: f.projects[0]!.cwd }], nextCursor: null });
	expect(created).toMatchObject({ title: "Agent's", workspaceRoot: folder, deletedAt: null });
	expect((await stat(folder)).isDirectory(), "the folder was made").toBe(true);
	expect(untitled.error).toContain("needs a workspaceRoot");
	expect(twice.error).toBe("invalid_request: The workspace is already registered to a project.");
	const id = created.id as string;

	const more: { name: string; args: Record<string, unknown> }[] = [
		{ name: "t3_project_update", args: { projectId: id, title: "Renamed" } },
		{ name: "t3_project_update", args: { projectId: id, workspaceRoot: elsewhere } },
		{ name: "t3_project_update", args: { projectId: id, pinned: true } },
		{ name: "t3_project_read", args: { projectId: id } },
		{ name: "t3_project_delete", args: { projectId: "p" } },
		{ name: "t3_project_delete", args: { projectId: id } },
		{ name: "t3_project_read", args: { projectId: id } },
	];
	for (const step of more) await ask("a", step);
	const [, , , , renamed, moved, pinned, read, notEmpty, deleted, gone] = await sawAll(steps.length + more.length);
	expect(renamed).toMatchObject({ id, title: "Renamed", workspaceRoot: folder });
	expect(moved).toMatchObject({ id, title: "Renamed", workspaceRoot: elsewhere });
	expect(pinned.error, "a field this host does not store is refused by name").toContain("pinned is not supported by pi-durable-t3");
	expect(read).toMatchObject({ id, title: "Renamed", workspaceRoot: elsewhere });
	expect(notEmpty.error).toBe("invalid_request: The project is not empty; force=true is required to delete it.");
	expect(deleted).toMatchObject({ id, deletedAt: expect.any(String) });
	expect(gone.error).toBe("invalid_request: The project was not found.");
	expect((await stat(elsewhere)).isDirectory(), "a deleted project's folder stays").toBe(true);
	// The UI's project list followed every change.
	expect(bridge.projects().map((project) => project.id)).toEqual(["p"]);
});

it("an agent renames and organizes threads with T3's tools; settling its own thread waits for its turn", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Helper" }, message: "What is 1+2?" } });
	const [started] = await sawAll(1);
	const child = started.threadId as string;
	const later = new Date(Date.now() + 3_600_000).toISOString();
	const steps: { name: string; args: Record<string, unknown> }[] = [
		{ name: "t3_thread_update", args: { action: "rename", title: "Parent, renamed" } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "pin" } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "snooze" } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "unpin" } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "snooze", snoozedUntil: later } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "mark_unread" } },
		{ name: "t3_thread_organize", args: { threadId: child, action: "archive" } },
		{ name: "t3_thread_organize", args: { threadId: "nope", action: "pin" } },
	];
	for (const step of steps) await ask("a", step);
	const [, renamed, pinned, noTime, , snoozed, unread, archived, unknown] = await sawAll(1 + steps.length);
	expect(renamed, "no threadId: the caller's own thread").toMatchObject({ threadId: "a", title: "Parent, renamed" });
	expect(pinned).toMatchObject({ sequence: expect.any(Number) });
	expect(noTime.error).toBe("invalid_request: snooze requires snoozedUntil.");
	expect(snoozed).toMatchObject({ sequence: expect.any(Number) });
	expect(bridge.threadRecord(child)!.snoozedUntil).toBe(Date.parse(later));
	expect(unread).toMatchObject({ sequence: expect.any(Number) });
	expect(archived).toMatchObject({ sequence: expect.any(Number) });
	expect(bridge.threadRecord(child)).toMatchObject({ archivedAt: expect.any(Number) });
	expect(bridge.threadRecord(child)!.pinnedAt).toBeUndefined();
	expect(unknown.error).toBe("thread_not_found: Thread nope was not found.");

	// Settling its own thread mid-turn waits for the turn, and happens only once it completes.
	await ask("a", { name: "t3_thread_organize", args: { action: "settle" } });
	const [last] = (await sawAll(2 + steps.length)).slice(-1);
	expect(last).toEqual({ settlesWhenTurnEnds: true });
	for (let waited = 0; bridge.threadRecord("a")!.settledOverride !== "settled" && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
	expect(bridge.threadRecord("a")!.settledOverride).toBe("settled");
});

it("an agent reads, edits, cancels and promotes another thread's queued messages", { timeout: 60_000 }, async () => {
	const { bridge, ask, sawAll } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Busy" }, message: "Hold on: q1", wait: false, notify: false } });
	const [started] = await sawAll(1);
	const busy = started.threadId as string;
	await bridge.waitFor(busy, (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await bridge.sendMessage({ threadId: busy, commandId: "q-1", messageId: "qm-1", text: "first follow-up", mode: "queue" });
	await bridge.sendMessage({ threadId: busy, commandId: "q-2", messageId: "qm-2", text: "second follow-up", mode: "queue" });
	const queued = await bridge.waitFor(busy, (projection) => (projection.runs.filter((run) => run.status === "queued").length === 2 ? projection : undefined), 10_000);
	const [firstId, secondId] = queued!.runs.filter((run) => run.status === "queued").map((run) => run.id as string);
	const running = queued!.runs.find((run) => run.status === "running")!.id as string;

	const steps: { name: string; args: Record<string, unknown> }[] = [
		{ name: "t3_queue", args: { threadId: busy, action: "list" } },
		{ name: "t3_queue", args: { threadId: busy, action: "edit", queuedRunId: firstId, text: "first, edited" } },
		{ name: "t3_queue", args: { threadId: busy, action: "read", queuedRunId: firstId } },
		{ name: "t3_queue", args: { threadId: busy, action: "reorder", queuedRunId: secondId, beforeRunId: firstId } },
		{ name: "t3_queue", args: { threadId: busy, action: "promote_to_steer", queuedRunId: firstId, targetRunId: "r-nope" } },
		{ name: "t3_queue", args: { threadId: busy, action: "cancel", queuedRunId: secondId } },
		{ name: "t3_queue", args: { threadId: busy, action: "list" } },
		{ name: "t3_queue", args: { threadId: busy, action: "promote_to_steer", queuedRunId: firstId, targetRunId: running } },
	];
	for (const step of steps) await ask("a", step);
	const [, listed, edited, read, reorder, wrongTarget, cancelled, after, promoted] = await sawAll(1 + steps.length);
	expect(listed).toEqual({ items: [{ queuedRunId: firstId, text: "first follow-up", truncated: false }, { queuedRunId: secondId, text: "second follow-up", truncated: false }], nextCursor: null });
	expect(edited).toMatchObject({ sequence: expect.any(Number) });
	expect(read).toEqual({ queuedRunId: firstId, text: "first, edited", truncated: false });
	expect(reorder.error).toContain("reorder is not supported by pi-durable-t3");
	// T3's own reorder command is refused for the same reason, by name.
	await expect(dispatchCommand(bridge, { type: "queued-run.reorder", commandId: "reorder-1", threadId: busy, runId: secondId, beforeRunId: firstId } as never, USER_WEB, log)).rejects.toThrow("the queue keeps the order messages were sent in");
	expect(wrongTarget.error).toContain("is not the running turn");
	expect(cancelled).toMatchObject({ sequence: expect.any(Number) });
	expect(after.items.map((item: { queuedRunId: string }) => item.queuedRunId)).toEqual([firstId]);
	expect(promoted).toMatchObject({ sequence: expect.any(Number) });
	// Promoted, it leaves the queue, as in T3: it waits in the running turn for its next boundary.
	const waiting = await ask("a", { name: "t3_queue", args: { threadId: busy, action: "list" } }).then(() => sawAll(2 + steps.length)).then((all) => all.at(-1));
	expect(waiting.items).toEqual([]);
	const inTurn = await bridge.waitFor(busy, (projection) => projection.turnItems.find((item) => item.type === "user_message" && item.text === "first, edited"), 10_000);
	expect(inTurn).toMatchObject({ status: "pending", inputIntent: "promoted_queued_to_steer", runId: running });
	gate("q1").release();
	// Placed when the turn reaches a boundary: here the end of the held answer, where pi goes on with it in that turn.
	const steered = await bridge.waitFor(
		busy,
		(projection) =>
			projection.runs.every((run) => run.status !== "queued") && projection.turnItems.some((item) => item.type === "user_message" && item.text === "first, edited" && item.status === "completed") ? projection : undefined,
		10_000,
	);
	expect(steered, "the promoted message left the queue when pi placed it, as edited").toBeDefined();
	expect(steered!.turnItems.find((item) => item.type === "user_message" && item.text === "first, edited")).toMatchObject({ status: "completed", runId: running });
});

it("an agent runs a scheduled task now", { timeout: 60_000 }, async () => {
	const { ask, sawAll, tasks } = await setup();
	await ask("a", { name: "schedule_task", args: { prompt: "Report the build", schedule: { type: "interval", everyMs: 3_600_000 } } });
	const [created] = await sawAll(1);
	await ask("a", { name: "run_scheduled_task_now", args: { taskId: created.scheduledTaskId } });
	await ask("a", { name: "run_scheduled_task_now", args: { taskId: "nope" } });
	const [, ran, missing] = await sawAll(3);
	expect(ran).toMatchObject({ taskId: created.scheduledTaskId, threadId: "a", lastRunStatus: "succeeded", runCount: 1, link: expect.any(String) });
	expect(missing.error).toBe("invalid_request: The scheduled task was not found.");
	expect(tasks().list().tasks[0]!.runCount).toBe(1);
});

it("an agent schedules, lists, changes and deletes a task with T3's tools", { timeout: 60_000 }, async () => {
	const { ask, sawAll, tasks } = await setup();
	await ask("a", { name: "schedule_task", args: { prompt: "Check the build\nand report", schedule: { type: "interval", everyMs: 3_600_000 } } });
	const [created] = await sawAll(1);
	expect(created).toMatchObject({ title: "Check the build", enabled: true, projectId: "p", boundThreadId: "a", freshSession: false, schedule: { type: "interval", everyMs: 3_600_000 }, lastRunStatus: "never" });
	const stored = tasks().list().tasks.find((task) => task.id === created.scheduledTaskId)!;
	expect(stored).toMatchObject({ threadId: "a", threadMode: "continue", runtimeMode: "full-access", createdBy: "agent", creationSource: "mcp", workspaceStrategy: { type: "root" } });

	await ask("a", { name: "schedule_task", args: { scheduledTaskId: created.scheduledTaskId, enabled: false, bindToCurrentThread: false } });
	await ask("a", { name: "list_scheduled_tasks", args: {} });
	await ask("a", { name: "schedule_task", args: { prompt: "Hook", schedule: { type: "webhook" } } });
	await ask("a", { name: "delete_scheduled_task", args: { scheduledTaskId: created.scheduledTaskId } });
	await ask("a", { name: "delete_scheduled_task", args: { scheduledTaskId: created.scheduledTaskId } });
	const [, changed, listed, webhook, deleted, again] = await sawAll(6);
	expect(changed).toMatchObject({ enabled: false, boundThreadId: null, nextRunAt: null });
	expect(listed.tasks).toEqual([expect.objectContaining({ scheduledTaskId: created.scheduledTaskId, enabled: false })]);
	// A webhook task: this bridge was told no address it is reached at, so the agent is given no `webhookUrl`.
	expect(webhook).toMatchObject({ title: "Hook", schedule: { type: "webhook", signature: null }, webhookSignature: "none", nextRunAt: null });
	expect(webhook).not.toHaveProperty("webhookUrl");
	await tasks().delete({ id: webhook.scheduledTaskId as never });
	expect(deleted).toEqual({ scheduledTaskId: created.scheduledTaskId, deleted: true });
	expect(again.error).toBe(`task_not_found: Scheduled task ${created.scheduledTaskId} was not found.`);
	expect(tasks().list().tasks).toEqual([]);

	// T3 0.1.9's thread modes: unbound is a new thread each run; a fresh session each run is refused by name.
	await ask("a", { name: "schedule_task", args: { prompt: "Elsewhere", schedule: { type: "interval", everyMs: 3_600_000 }, bindToCurrentThread: false } });
	await ask("a", { name: "schedule_task", args: { prompt: "Afresh", schedule: { type: "interval", everyMs: 3_600_000 }, freshSession: true } });
	const [unbound, fresh] = (await sawAll(8)).slice(-2);
	expect(tasks().list().tasks.find((task) => task.id === unbound.scheduledTaskId)).toMatchObject({ threadId: null, threadMode: "new_thread" });
	expect(fresh.error).toMatch(/^invalid_request: freshSession: A fresh session each run is not supported/);
});

it("a task title derived from a prompt never ends on half a character (T3 0.1.11)", { timeout: 60_000 }, async () => {
	const { ask, sawAll } = await setup();
	await ask("a", { name: "schedule_task", args: { prompt: `${"x".repeat(79)}😀 and report`, schedule: { type: "interval", everyMs: 3_600_000 } } });
	const [created] = await sawAll(1);
	expect(created.title).toBe("x".repeat(79));
});

it("a child still working holds its parent: waiting on it, its work in the background, and no archive meanwhile (T3 0.1.11)", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, ops } = await setup();
	const refusal = "Thread a has running delegated tasks. Wait for them or cancel them before archiving.";

	// A parent that waits for its child is blocked on it (T3's sidebar: "Waiting", not "Working").
	await ask("a", { name: "thread_prompt", args: { new: { title: "Waited for" }, message: "Hold on: fg" } });
	const blocked = await bridge.waitFor("a", (projection) => (bridge.threadShell("a").blockedOnThreadWait === true && projection.subagents.some((task) => task.status === "running") ? true : undefined), 10_000);
	expect(blocked).toBe(true);
	expect(ops.list({}, { allProjects: true }).threads.find((thread) => thread.threadId === "a")).toMatchObject({ status: "running", blockedOnThreadWait: true });
	await expect(bridge.sidebar.archive("a")).rejects.toThrow(refusal);
	gate("fg").release();
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	expect(bridge.threadShell("a").blockedOnThreadWait).toBe(false);

	// A child started without waiting goes on after the parent's turn: background work that holds the parent.
	await ask("a", { name: "thread_prompt", args: { new: { title: "Background" }, message: "Hold on: bg", wait: false } });
	const parent = await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 2);
	const childId = (JSON.parse(parent!.messages.filter((message) => message.text.startsWith("Parent saw:")).at(-1)!.text.slice("Parent saw: ".length)) as { threadId: string }).threadId;
	expect(bridge.threadShell("a").pendingBackgroundTasks).toEqual([expect.objectContaining({ kind: "subagent", childThreadId: childId, description: "Background" })]);
	const listed = ops.list({}, { allProjects: true }).threads.find((thread) => thread.threadId === "a")!;
	expect(listed).toMatchObject({ status: "waiting", blockedOnThreadWait: false, pendingBackgroundTasks: [{ kind: "subagent", childThreadId: childId, description: "Background" }] });
	await expect(bridge.sidebar.archive("a")).rejects.toThrow(refusal);
	expect(bridge.threadRecord("a")!.archivedAt).toBeUndefined();

	gate("bg").release();
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report")));
	expect(bridge.threadShell("a").pendingBackgroundTasks).toEqual([]);
	await bridge.sidebar.archive("a");
	expect(bridge.threadRecord("a")!.archivedAt).toEqual(expect.any(Number));
});

it("a child whose outcome was not written reads as its summary's ended run after a restart, and does not hold its parent", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, f } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 2+2?" } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const childId = (JSON.parse(parent!.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length)) as { threadId: string }).threadId;
	// The host stopped before it wrote the child's outcome.
	await bridge.updateThreadRecord(childId, (record) => {
		delete record.spawn!.outcome;
	});
	await bridge.close();
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-threads-restart-"));
	const again = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	again.start();
	await again.loaded();
	onTestFinished(async () => {
		await again.close();
		await rm(scratch, { recursive: true, force: true });
	});
	expect(again.threadShell("a").pendingBackgroundTasks).toEqual([]);
	await again.sidebar.archive("a");
	expect(again.threadRecord("a")!.archivedAt).toEqual(expect.any(Number));
	expect((await again.projection("a")).projection.subagents.find((task) => (task.childThreadId as string | null) === childId)).toMatchObject({ status: "completed", result: "4" });
});

it("a closed parent keeps its children's background work, and shows when it ends", { timeout: 60_000 }, async () => {
	// The idle release of an unwatched thread, shortened.
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 30_000 ? 20 : ms)) as typeof setTimeout);
	const { bridge, ask, settled, ops } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Background" }, message: "Hold on: bg2", wait: false, notify: false } });
	const parent = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const childId = (JSON.parse(parent!.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length)) as { threadId: string }).threadId;
	await new Promise((resolve) => realSetTimeout(resolve, 500));
	expect(bridge.threadShell("a").pendingBackgroundTasks).toEqual([expect.objectContaining({ kind: "subagent", childThreadId: childId })]);
	expect(ops.list({}, { allProjects: true }).threads.find((thread) => thread.threadId === "a")!.status).toBe("waiting");
	gate("bg2").release();
	await until("the parent's shell without the finished child", () => bridge.threadShell("a").pendingBackgroundTasks?.length === 0);
	expect(ops.list({}, { allProjects: true }).threads.find((thread) => thread.threadId === "a")!.status).toBe("completed");
});

it("archiving a thread leaves a side chat whose child still works active, and archives the others", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	await ask("a", { name: "thread_read", args: { threadId: "a" } });
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	await bridge.forkThread({ sourceThreadId: "a", targetThreadId: "busy-side", sideChat: true });
	await bridge.forkThread({ sourceThreadId: "a", targetThreadId: "idle-side", sideChat: true });
	for (const side of ["busy-side", "idle-side"]) {
		await bridge.sendMessage({ threadId: side, commandId: `hello-${side}`, messageId: `hello-${side}`, text: "hello", mode: "queue" });
		await settled(side);
	}
	await ask("busy-side", { name: "thread_prompt", args: { new: { title: "Side work" }, message: "Hold on: side", wait: false } });
	await settled("busy-side", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	await bridge.sidebar.archive("a");
	expect(bridge.threadRecord("a")!.archivedAt).toEqual(expect.any(Number));
	expect(bridge.threadRecord("idle-side")!.archivedAt).toEqual(expect.any(Number));
	expect(bridge.threadRecord("busy-side")!.archivedAt).toBeUndefined();
	gate("side").release();
});

it("a webhook task's URL is returned by its creation only, and a task is listed by its id (T3 0.1.11)", { timeout: 60_000 }, async () => {
	const { ask, sawAll } = await setup({ webhookOrigin: () => "https://claw.example" });
	await ask("a", { name: "schedule_task", args: { prompt: "Hook", schedule: { type: "webhook" } } });
	await ask("a", { name: "schedule_task", args: { prompt: "Other", schedule: { type: "interval", everyMs: 3_600_000 } } });
	const [webhook, other] = await sawAll(2);
	expect(webhook.webhookUrl).toMatch(new RegExp(`^https://claw\\.example/api/hooks/${encodeURIComponent(webhook.scheduledTaskId)}/`));
	await ask("a", { name: "list_scheduled_tasks", args: { scheduledTaskId: webhook.scheduledTaskId } });
	await ask("a", { name: "schedule_task", args: { scheduledTaskId: webhook.scheduledTaskId, title: "Hook renamed" } });
	const [, , listed, updated] = await sawAll(4);
	expect(listed.tasks.map((task: { scheduledTaskId: string }) => task.scheduledTaskId)).toEqual([webhook.scheduledTaskId]);
	expect(listed.tasks[0]).not.toHaveProperty("webhookUrl");
	expect(updated).toMatchObject({ title: "Hook renamed", webhookSignature: "none" });
	expect(updated).not.toHaveProperty("webhookUrl");
	expect(other).not.toHaveProperty("webhookUrl");
});

it("a child runs at its parent's priority until it has one of its own (`priority.ts`)", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Adder" }, message: "What is 2+2?" } });
	await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:")));
	const child = bridge.threadRecords().find((thread) => thread.lineage.parentThreadId === "a")!;
	const handler = bridge.requestPriority().hooks!.find((installed) => installed.task === GenerationTask.definition.name)!.handlers as {
		beforeProviderRequest: (request: { model: unknown; payload: unknown }, api: { conversationId: number }) => { payload: { priority: number } } | undefined;
	};
	const sent = (threadId: string) => handler.beforeProviderRequest({ model: {}, payload: { priority: 3 } }, { conversationId: bridge.threadRecord(threadId)!.head })?.payload.priority;
	expect(sent(child.threadId), "nothing chosen: models.json's value stands").toBeUndefined();
	await bridge.applySelection("a", { options: [{ id: "priority", value: "low" }] });
	expect(sent("a")).toBe(5);
	expect(sent(child.threadId)).toBe(5);
	await bridge.applySelection(child.threadId, { options: [{ id: "priority", value: "high" }] });
	expect(sent(child.threadId)).toBe(-5);
	expect(bridge.threadRecord(child.threadId)!.priority).toBe("high");
	// A refused selection keeps none of its choices.
	await expect(bridge.applySelection(child.threadId, { model: "ghost/none", options: [{ id: "priority", value: "low" }] })).rejects.toThrow("Not in the catalog: ghost/none");
	expect(sent(child.threadId)).toBe(-5);
	await bridge.applySelection(child.threadId, { options: [{ id: "priority", value: "inherit" }] });
	expect(sent(child.threadId)).toBe(5);
	await expect(bridge.applySelection("a", { options: [{ id: "priority", value: "urgent" }] })).rejects.toThrow("Unknown priority: urgent");
});
