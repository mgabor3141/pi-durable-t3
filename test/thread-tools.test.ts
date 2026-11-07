// The thread tools as an agent's own tools (`T3Attachment.threadTools`), against a scripted model that answers by
// context: a parent starts a child and waits for its report; follows up on it; starts one without waiting and gets the
// report posted into its own thread as the next turn; adds a note without starting work; and a request to be answered
// that a previous process left on a record is delivered after a restart.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { Orchestration } from "../src/t3/orchestration.ts";
import { childCardNodeId } from "../src/t3/projection.ts";
import { threadToolsExtension } from "../src/t3/thread-tools.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
type Msg = { role: string; content: unknown };
const textOf = (message: Msg | undefined): string =>
	message === undefined ? "" : typeof message.content === "string" ? message.content : (message.content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

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
	if (last.role === "toolResult") return fauxAssistantMessage(`Parent saw: ${lastText}`);
	if (last.role === "user" && lastText.startsWith("Delegate ")) {
		const call = JSON.parse(lastText.slice("Delegate ".length)) as { name: string; args: Record<string, unknown> };
		return fauxAssistantMessage([fauxToolCall(call.name, call.args as never, { id: `call-${messages.length}` })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage("ok");
};

async function setup(options: { readonly waitSignal?: () => AbortSignal | undefined } = {}) {
	let bridge: Bridge | undefined;
	const late = new Proxy({} as Bridge, { get: (_target, key) => (bridge as unknown as Record<string | symbol, unknown>)[key] instanceof Function ? (bridge as never as Record<string | symbol, (...args: unknown[]) => unknown>)[key]!.bind(bridge) : (bridge as unknown as Record<string | symbol, unknown>)[key] });
	const orchestration = new Orchestration(late, log, options);
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [threadToolsExtension(late, orchestration)] });
	f.model.respond(...Array.from({ length: 60 }, () => brain));
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Parent" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-threads-"));
	bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	orchestration.start();
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
	return { bridge, orchestration, f, ask, settled, sawAll };
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
	expect(readResult.text).toContain("[AGENT]: 2");
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
	const { bridge, ask, sawAll } = await setup();
	// The child starts a grandchild that holds, without waiting, then finishes its own turn.
	const grand = { name: "thread_prompt", args: { new: { title: "Grandchild" }, message: "Hold on: g1", wait: false } };
	await ask("a", { name: "thread_prompt", args: { new: { title: "Child" }, message: `Delegate ${JSON.stringify(grand)}` } });
	const [first] = await sawAll(1);
	expect(first.report).toContain("[AGENT]: Parent saw:");
	const child = first.threadId as string;
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

it("a restart's signal ends a wait; the report is sent when the work settles", { timeout: 60_000 }, async () => {
	const drain = new AbortController();
	const { ask, sawAll, settled } = await setup({ waitSignal: () => drain.signal });
	await ask("a", { name: "thread_prompt", args: { new: {}, message: "Hold on: w1" } });
	await new Promise((resolve) => setTimeout(resolve, 300));
	drain.abort();
	const [ended] = await sawAll(1);
	expect(ended).toMatchObject({ verdict: "active", notify: true });
	gate("w1").release();
	const woke = await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("[Report from thread")));
	expect(woke!.messages.find((message) => message.text.startsWith("[Report from thread"))!.text).toContain("[AGENT]: released w1");
});
