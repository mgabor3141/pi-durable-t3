// A child's question is its parent's to answer (`child-questions.ts`): a parent that waits for the child gets the
// question as its wait's answer and answers it with T3's `t3_pending_request`; one that does not wait is told by a
// message, once, which is taken back when the question is answered first; and a turn that ends with the question open
// is told after it, unless it was stopped. Against a scripted model that answers by context.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, hook, ToolTask } from "@earendil-works/pi-durable";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { ChildQuestions } from "../src/t3/child-questions.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import type { Logger } from "../src/t3/logging.ts";
import { Orchestration } from "../src/t3/orchestration.ts";
import { ThreadOps } from "../src/t3/thread-ops.ts";
import { object } from "../src/t3/schema.ts";
import { threadToolsExtension } from "../src/t3/thread-tools.ts";
import { bridgeConfig, createNamed, makeThreads } from "./threads-harness.ts";
import { sleep, until } from "./wait.ts";

type Msg = { role: string; content: unknown };
type Projection = Awaited<ReturnType<Bridge["projection"]>>["projection"];
type Request = { id: string; kind: string; status: string; answers?: Record<string, unknown> };
/** A message's own text: the hidden blocks the host adds for the model are not part of what it says. */
const textOf = (message: Msg | undefined): string =>
	message === undefined ? "" : typeof message.content === "string" ? message.content : (message.content as { type: string; text?: string; hidden?: boolean }[]).map((block) => (block.hidden === true ? "" : (block.text ?? ""))).join("");

/** What the scripted parent does when it learns of a question (in a wait's answer, or in a message): answer it, say so
 * and end its turn, hold its turn open until the test releases it, or once fail, or once wait again, and say so the
 * next time. */
let onQuestion: "answer" | "ignore" | "hold" | "fail" | "again" = "answer";
/** The threads the scripted parent waits for once more (`again`), before it says that it did not answer. */
let again: string[] = [];
/** Every tool result the scripted agents were given, parsed. */
let results: Record<string, unknown>[] = [];
/** The messages about a question as the model was given them. */
let noticed: unknown[] = [];
afterEach(() => vi.restoreAllMocks());
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
const NOTICE = /is blocked on a question and cannot continue until it is answered\. Read it with t3_pending_request action read, threadId (\S+), and requestId (\S+)\. Answer it with action respond/;
const respond = (threadId: string, requestId: string, id: string) =>
	fauxAssistantMessage([fauxToolCall("t3_pending_request", { action: "respond", threadId, requestId, answers: { q1: "Postgres" } } as never, { id })], { stopReason: "toolUse" });

/** One generation, chosen by the conversation's latest message. */
const brain: FauxResponseStep = (context, options) => {
	const messages = context.messages as unknown as Msg[];
	const last = messages.at(-1)!;
	const text = textOf(last);
	const held = (name: string) => {
		const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
		const aborted = new Promise<"aborted">((resolve) => signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
		return Promise.race([gate(name).promise, aborted]).then((outcome) => (outcome === "aborted" ? fauxAssistantMessage("", { stopReason: "aborted" }) : fauxAssistantMessage(`released ${name}`)));
	};
	// What a parent does about a question it was told of.
	const about = (threadId: string, requestId: string) => {
		if (onQuestion === "answer") return respond(threadId, requestId, `call-${messages.length}`);
		if (onQuestion === "hold") return held("question");
		if (onQuestion === "ignore") return fauxAssistantMessage("Noted, not answered.");
		const once = onQuestion;
		onQuestion = "ignore";
		if (once === "again") return fauxAssistantMessage([fauxToolCall("thread_wait", { threadIds: again } as never, { id: `call-${messages.length}` })], { stopReason: "toolUse" });
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
	};
	if (last.role === "toolResult") {
		const result = JSON.parse(text) as Record<string, unknown>;
		results.push(result);
		// A child: its question was answered (each card's answer, when it asked with several).
		if (result["status"] !== undefined) return fauxAssistantMessage(`Child got: ${messages.filter((message) => message.role === "toolResult").map(textOf).join(" ")}`);
		const asked = [result, ...((result["reports"] as Record<string, unknown>[] | undefined) ?? [])].find((entry) => entry["pendingRequestIds"] !== undefined);
		if (asked !== undefined) return about(asked["threadId"] as string, (asked["pendingRequestIds"] as string[])[0]!);
		return fauxAssistantMessage(`Parent saw: ${text}`);
	}
	const notice = NOTICE.exec(text);
	if (notice !== null) {
		noticed.push(last.content);
		return about(notice[1]!, notice[2]!);
	}
	if (text.startsWith("[Report from thread")) return fauxAssistantMessage(`Got the report: ${text.split("\n").at(-1)}`);
	// A child asks: one card a question ("Ask: A? | B?" is two cards at once).
	const asks = (questions: string) =>
		fauxAssistantMessage(questions.split(" | ").map((question, index) => fauxToolCall("ask_user", { questions: [{ header: "Choice", question }] } as never, { id: `call-${messages.length}-${index}` })), { stopReason: "toolUse" });
	if (text.startsWith("Ask: ")) return asks(text.slice("Ask: ".length));
	// It works first, and asks once the test says so.
	const later = /^When (\S+): (.*)$/.exec(text);
	if (later !== null) return gate(later[1]!).promise.then(() => asks(later[2]!));
	const hold = /^Hold on: (\S+)/.exec(text);
	if (hold !== null) return held(hold[1]!);
	// A child calls a tool the host asks the user to approve.
	if (text === "Guard") return fauxAssistantMessage([fauxToolCall("guarded", {} as never, { id: `call-${messages.length}` })], { stopReason: "toolUse" });
	if (text.startsWith("Delegate ")) {
		const call = JSON.parse(text.slice("Delegate ".length)) as { name: string; args: Record<string, unknown> };
		return fauxAssistantMessage([fauxToolCall(call.name, call.args as never, { id: `call-${messages.length}` })], { stopReason: "toolUse" });
	}
	return fauxAssistantMessage("ok");
};

/** What the host warned of. */
let warned: string[] = [];
const log: Logger = { info: () => {}, warn: (message) => void warned.push(message) };

async function setup() {
	onQuestion = "answer";
	again = [];
	results = [];
	noticed = [];
	warned = [];
	let bridge: Bridge | undefined;
	let orchestration: Orchestration | undefined;
	const late = <T extends object>(read: () => T | undefined) =>
		new Proxy({} as T, {
			get: (_target, key) => {
				const value = (read() as unknown as Record<string | symbol, unknown>)[key];
				return value instanceof Function ? value.bind(read()) : value;
			},
		});
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [threadToolsExtension(late(() => bridge), late(() => orchestration), { ops: new ThreadOps(late(() => bridge), "env-1", log) })] });
	f.model.respond(...Array.from({ length: 80 }, () => brain));
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Parent" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-questions-"));
	/** A bridge and its orchestration over the same threads: the first process, or the next after a restart. */
	const open = async (options: { readonly orchestrated?: boolean } = {}) => {
		bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
		orchestration = new Orchestration(bridge, log);
		bridge.start();
		// As `attachT3` starts it: before the bridge has shown a thread.
		if (options.orchestrated !== false) orchestration.start();
		await bridge.loaded();
		return bridge;
	};
	const close = async () => {
		orchestration?.close();
		await bridge?.close();
	};
	await open();
	f.tools.install(bridge!.userInput.extension());
	// A tool whose call the host's gate stops for the user's approval (`approvals.ts`).
	f.tools.install(
		defineExtension({
			name: "test-guarded",
			tools: [defineTool({ name: "guarded", description: "Asks first.", parameters: object({}), execute: async () => ({ output: [{ type: "text", text: JSON.stringify({ ran: true }) }] }) })],
			hooks: [
				hook(ToolTask, {
					beforeTool: async (call, api, context) => {
						if (call.name !== "guarded") return undefined;
						const answer = await bridge!.approvals.ask(api, { key: "nas", prompt: "ssh nas", options: [{ decision: "decline", label: "Deny" }, { decision: "accept", label: "Allow" }] }, context);
						return "sleep" in answer ? { sleep: answer.sleep } : undefined;
					},
				}),
			],
		}),
	);
	onTestFinished(async () => {
		for (const entry of gates.values()) entry.release();
		gates.clear();
		await close();
		await rm(scratch, { recursive: true, force: true });
	});
	let sent = 0;
	const send = async (threadId: string, text: string) => {
		sent += 1;
		await bridge!.sendMessage({ threadId, commandId: `c-${sent}`, messageId: `m-${sent}`, text, mode: "queue" });
	};
	const ask = (threadId: string, call: { name: string; args: Record<string, unknown> }) => send(threadId, `Delegate ${JSON.stringify(call)}`);
	const settled = (threadId: string, check: (projection: Projection) => boolean = () => true) =>
		bridge!.waitFor(threadId, (projection) => (projection.runs.length > 0 && projection.runs.every((run) => !["queued", "running", "starting", "preparing", "waiting"].includes(run.status)) && check(projection) ? projection : undefined), 20_000);
	/** The one child of thread "a", once it is there. */
	const child = async () => {
		await until("the child", () => bridge!.threadRecords().some((thread) => thread.lineage.parentThreadId === "a"));
		return bridge!.threadRecords().find((thread) => thread.lineage.parentThreadId === "a")!.threadId;
	};
	/** A thread's question that waits, once it does. */
	const pending = async (threadId: string) => (await bridge!.waitFor(threadId, (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.kind === "user_input" && request.status === "pending"), 10_000))!.id;
	const requests = async (threadId: string) => (await bridge!.projection(threadId)).projection.runtimeRequests as unknown as Request[];
	/** The messages that told a thread of a child's question. */
	const notices = (projection: Projection) => projection.messages.filter((message) => message.role === "user" && NOTICE.test(message.text));
	const command = (fields: Record<string, unknown>) => dispatchCommand(bridge!, { commandId: `cmd-${++sent}`, ...fields } as never, { createdBy: "user", creationSource: "web" }, log);
	return { f, bridge: () => bridge!, orchestration: () => orchestration!, ops: () => new ThreadOps(bridge!, "env-1", log), open, close, create, send, ask, settled, child, pending, requests, notices, command };
}

it("a parent that waits for its child gets the child's question as the wait's answer, and answers it in the same turn", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, requests, notices } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?" } });
	const parent = (await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report"))))!;
	const kid = await child();
	const [request] = await requests(kid);
	// The wait ended with the question: the work goes on, so the verdict is active, and its report is still owed.
	const waited = results.find((result) => result["pendingRequestIds"] !== undefined)!;
	expect(waited).toMatchObject({ threadId: kid, verdict: "active", notify: true, pendingRequestIds: [request!.id] });
	expect(waited["report"]).toContain(`[Agent is blocked on a question and cannot continue until it is answered. Read it with t3_pending_request action read, threadId ${kid}, and requestId ${request!.id}. Answer it with action respond when the answer follows from the task or from what the user asked for; otherwise ask the user, then answer it.]`);
	// The parent's answer is the card's answer, and the child went on with it.
	expect(request).toMatchObject({ kind: "user_input", status: "resolved", answers: { q1: "Postgres" } });
	expect(results.find((result) => result["status"] === "answered")).toEqual({ status: "answered", answers: { q1: "Postgres" } });
	// The question was in the parent's hands: it was told by no message. The work's report came once it settled.
	expect(notices(parent)).toEqual([]);
	expect(parent.messages.find((message) => message.text.startsWith("Got the report"))!.text).toBe(`Got the report: [AGENT]: Child got: ${JSON.stringify({ status: "answered", answers: { q1: "Postgres" } })}`);
	expect(parent.messages.filter((message) => message.text.startsWith("[Report from thread"))).toHaveLength(1);
	expect(bridge().threadRecord(kid)!.notify ?? []).toEqual([]);
	// Answered, the question is forgotten: what the parent does next has nothing to do with the child.
	const read = vi.spyOn(bridge(), "projection");
	await send("a", "Hello");
	await settled("a", (projection) => projection.runs.length === parent.runs.length + 1);
	await send(kid, "What now?");
	await settled(kid, (projection) => projection.runs.length === 2);
	expect(read.mock.calls.filter(([threadId]) => threadId === kid)).toEqual([]);
});

it("a parent that does not wait is told by a message that names the request, once, and its answer lets the child finish", { timeout: 60_000 }, async () => {
	const { ask, settled, child, requests, notices } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?", wait: false } });
	const parent = (await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report"))))!;
	const kid = await child();
	const [request] = await requests(kid);
	const told = notices(parent);
	expect(told).toHaveLength(1);
	// T3's words to a delegated task's parent, as a message of the host's own from the child.
	expect(told[0]).toMatchObject({ createdBy: "agent", creationSource: "server", senderThreadId: kid });
	expect(told[0]!.text).toBe(
		`Thread "Kid" (${kid}) is blocked on a question and cannot continue until it is answered. Read it with t3_pending_request action read, threadId ${kid}, and requestId ${request!.id}. Answer it with action respond when the answer follows from the task or from what the user asked for; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`,
	);
	// The model reads it as it is: a message of the host's own carries no note of who sent it, as T3's notices carry none.
	expect(noticed).toEqual([told[0]!.text]);
	// A person sees T3's notice row for it; the child's report after it is the one that opens the card (`noticeItems`).
	const card = parent.subagents.find((subagent) => subagent.childThreadId === kid)!;
	expect(parent.turnItems.filter((item) => item.type === "notification")).toEqual([
		expect.objectContaining({ source: { kind: "delegated_task", taskIds: [], childThreadId: kid }, outcome: "updated", summary: 'Delegated task "Kid" has a question', detail: told[0]!.text }),
		expect.objectContaining({ source: { kind: "delegated_task", taskIds: [card.id], childThreadId: kid }, outcome: "completed", summary: 'Delegated task "Kid" finished' }),
	]);
	expect(parent.turnItems.some((item) => item.type === "user_message" && item.messageId === told[0]!.id)).toBe(false);
	expect(request).toMatchObject({ status: "resolved", answers: { q1: "Postgres" } });
	expect(parent.messages.find((message) => message.text.startsWith("Got the report"))!.text).toContain("Child got:");
});

it("a turn that ends with the question open is told of it after, once; the user's answer in the card ends it", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, pending, requests, notices, command } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?" } });
	// The wait's answer was the question; the turn ended without an answer, so a message tells the parent, which starts a turn.
	const parent = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.filter((message) => message.text === "Noted, not answered.").length === 2))!;
	const kid = await child();
	const requestId = await pending(kid);
	expect(notices(parent)).toHaveLength(1);
	expect(parent.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
	// Waiting again answers with the same question at once, and tells of it no second time.
	await ask("a", { name: "thread_wait", args: { threadIds: [kid] } });
	const again = (await settled("a", (projection) => projection.messages.filter((message) => message.text === "Noted, not answered.").length === 3))!;
	expect(results.at(-1)).toMatchObject({ verdict: "active", reports: [{ threadId: kid, verdict: "active", pendingRequestIds: [requestId] }] });
	await sleep(300);
	expect(notices((await bridge().projection("a")).projection)).toHaveLength(1);
	expect(again.runs).toHaveLength(3);
	// Told once, the question is not in the hands of the turn that waited again: nothing looks at the child for it.
	const read = vi.spyOn(bridge(), "projection");
	await send("a", "Hello");
	await settled("a", (projection) => projection.runs.length === 4);
	expect(read.mock.calls.filter(([threadId]) => threadId === kid)).toEqual([]);
	read.mockRestore();
	// The card is still the user's to answer.
	await command({ type: "runtime-request.respond", threadId: kid, requestId, answers: { q1: "SQLite" } });
	await settled(kid);
	expect((await requests(kid))[0]).toMatchObject({ status: "resolved", answers: { q1: "SQLite" } });
});

it("a turn that fails with the question in hand is told of it after, as one that completes is", { timeout: 60_000 }, async () => {
	const { ask, settled, notices } = await setup();
	onQuestion = "fail";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?" } });
	const parent = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.some((message) => message.text === "Noted, not answered.")))!;
	expect(parent.runs.map((run) => run.status)).toEqual(["failed", "completed"]);
	expect(notices(parent)).toHaveLength(1);
	expect(notices(parent)[0]!.runId).toBe(parent.runs[1]!.id);
});

it("a turn that was stopped with the question in hand is not told of it", { timeout: 60_000 }, async () => {
	const { bridge, orchestration, ask, child, pending, notices } = await setup();
	onQuestion = "hold";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?" } });
	const kid = await child();
	const requestId = await pending(kid);
	// The wait has answered with the question, and the parent's turn is still at work.
	await until("the wait's answer", () => results.some((result) => result["pendingRequestIds"] !== undefined));
	// Another agent's stop, which leaves the child at work (a person's would stop the child too, its question with it).
	await bridge().interrupt("a", { by: "agent" });
	const parent = (await bridge().waitFor("a", (projection) => (projection.runs.every((run) => run.status === "interrupted") ? projection : undefined), 10_000))!;
	await sleep(400);
	expect(notices((await bridge().projection("a")).projection)).toEqual([]);
	expect(parent.runs).toHaveLength(1);
	expect(await pending(kid)).toBe(requestId);
	// Nor at a later look at the child: another thread's wait for it ends.
	await orchestration().wait("elsewhere", [kid], 50);
	await sleep(300);
	expect(notices((await bridge().projection("a")).projection)).toEqual([]);
});

it("a parent at work is told in its turn, and a message it has not read is taken back when the user answers first", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, pending, notices, command } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	// The parent works on something else; the user writes to the child, which asks.
	await send("a", "Hold on: busy");
	await bridge().waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await send(kid, "Ask: Which database?");
	const requestId = await pending(kid);
	const waiting = async () => (await bridge().waitingMessages("a")).filter((message) => message.messageId.startsWith("q-"));
	await until("the message in the parent's turn", async () => (await waiting()).length === 1);
	expect((await waiting())[0]).toMatchObject({ mode: "steer" });
	await command({ type: "runtime-request.respond", threadId: kid, requestId, answers: { q1: "SQLite" } });
	await until("the message taken back", async () => (await waiting()).length === 0);
	gate("busy").release();
	const parent = (await settled("a", (projection) => projection.messages.some((message) => message.text === "released busy")))!;
	expect(notices(parent)).toEqual([]);
	expect(parent.runs).toHaveLength(2);
});

it("another thread's wait for the child goes on: the question is its parent's", { timeout: 60_000 }, async () => {
	const { ask, create, settled, child, requests, notices } = await setup();
	await create({ threadId: "b", projectId: "p", title: "Other" });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await ask("b", { name: "thread_prompt", args: { threadId: kid, message: "Ask: Which database?" } });
	// The parent is told and answers; the other thread's wait ends with the work, never with the question.
	const other = (await settled("b", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:"))))!;
	const saw = JSON.parse(other.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length)) as Record<string, unknown>;
	expect(saw).toMatchObject({ threadId: kid, verdict: "completed", notify: false });
	expect(saw["pendingRequestIds"]).toBeUndefined();
	expect(notices(other)).toEqual([]);
	const parent = (await settled("a", (projection) => notices(projection).length > 0))!;
	expect(notices(parent)).toHaveLength(1);
	expect((await requests(kid))[0]).toMatchObject({ status: "resolved", answers: { q1: "Postgres" } });
});

it("a child that asks with two cards is answered card by card: the one left open is what the parent is told of after its turn", { timeout: 60_000 }, async () => {
	const { ask, settled, child, requests, notices } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database? | Which region?" } });
	const parent = (await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Got the report"))))!;
	const kid = await child();
	const cards = await requests(kid);
	expect(cards.map((card) => card.status)).toEqual(["resolved", "resolved"]);
	// The wait named both; the turn answered the first and ended, so one message told of the other, which the next turn answered.
	const waited = results.find((result) => result["pendingRequestIds"] !== undefined)!;
	expect(waited["pendingRequestIds"]).toEqual(cards.map((card) => card.id));
	expect((waited["report"] as string).match(/\[Agent is blocked on a question/g)).toHaveLength(2);
	const told = notices(parent);
	expect(told).toHaveLength(1);
	expect(told[0]!.text).toContain(`requestId ${cards[1]!.id}.`);
	expect(parent.runs.map((run) => run.status)).toEqual(["completed", "completed", "completed"]);
});

it("an archived parent is told of nothing", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, pending, notices } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await bridge().updateThreadRecord("a", (record) => {
		record.archivedAt = Date.now();
	});
	await send(kid, "Ask: Which database?");
	await pending(kid);
	await sleep(400);
	const parent = (await bridge().projection("a")).projection;
	expect(notices(parent)).toEqual([]);
	expect(parent.runs).toHaveLength(1);
});

it("a parent that is gone is told of nothing, and its child's question ends as any other", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, pending, requests, command } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await bridge().deleteThread("a");
	await send(kid, "Ask: Which database?");
	const requestId = await pending(kid);
	await sleep(300);
	await command({ type: "runtime-request.respond", threadId: kid, requestId, answers: { q1: "SQLite" } });
	await settled(kid, (projection) => projection.runs.length === 2);
	expect((await requests(kid))[0]).toMatchObject({ status: "resolved" });
	await sleep(200);
	expect(warned).toEqual([]);
});

it("one child's question ends a wait for several, with the others as far as they are", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, requests, notices } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Slow" }, message: "Hold on: slow", wait: false, notify: false } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 1);
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "When ready: Which database?", wait: false, notify: false } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 2);
	const [slow, kid] = bridge().threadRecords().filter((thread) => thread.lineage.parentThreadId === "a").map((thread) => thread.threadId) as [string, string];
	// The parent waits for both, and then the second asks.
	await ask("a", { name: "thread_wait", args: { threadIds: [slow, kid] } });
	await bridge().waitFor("a", (projection) => (projection.turnItems.some((item) => item.type === "dynamic_tool" && (item as { toolName?: string }).toolName === "thread_wait" && item.status === "running") ? true : undefined), 10_000);
	await sleep(200);
	gate("ready").release();
	await until("the wait's answer", () => results.some((result) => result["reports"] !== undefined));
	const [request] = await requests(kid);
	const waited = results.find((result) => result["reports"] !== undefined)!;
	expect(waited).toMatchObject({ verdict: "active", reports: [{ threadId: slow, verdict: "active" }, { threadId: kid, verdict: "active", pendingRequestIds: [request!.id] }] });
	expect((waited["reports"] as Record<string, unknown>[])[0]!["pendingRequestIds"]).toBeUndefined();
	// The question was in that turn's hands: the message about it came once the turn had ended with it open, as the next.
	const parent = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.filter((message) => message.text === "Noted, not answered.").length === 2 && gate("slow").release() === undefined))!;
	expect(notices(parent)).toHaveLength(1);
	expect(parent.runs.map((run) => run.status)).toEqual(["completed", "completed", "completed", "completed"]);
	expect(notices(parent)[0]!.runId).toBe(parent.runs[3]!.id);
});

it("a wait for two children that both ask names each one's question", { timeout: 60_000 }, async () => {
	const { bridge, orchestration, ask, send, settled, pending, notices } = await setup();
	onQuestion = "ignore";
	for (const title of ["One", "Two"]) {
		await ask("a", { name: "thread_prompt", args: { new: { title }, message: "What now?" } });
		await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === (title === "One" ? 1 : 2));
	}
	const kids = bridge().threadRecords().filter((thread) => thread.lineage.parentThreadId === "a").map((thread) => thread.threadId);
	expect(kids).toHaveLength(2);
	for (const kid of kids) await send(kid, "Ask: Which database?");
	const asked = [await pending(kids[0]!), await pending(kids[1]!)];
	// The parent did not wait: it was told of each by a message of its own.
	const parent = (await settled("a", (projection) => notices(projection).length === 2))!;
	expect(notices(parent).map((message) => message.senderThreadId).toSorted()).toEqual(kids.toSorted());
	const { reports, verdict } = await orchestration().wait("a", kids, undefined);
	expect(verdict).toBe("active");
	expect(reports.map((entry) => entry.pendingRequestIds)).toEqual([[asked[0]], [asked[1]]]);
	expect(reports.map((entry) => entry.text.includes(`threadId ${entry.threadId}, and requestId ${entry.pendingRequestIds![0]}.`))).toEqual([true, true]);
	// A wait that ends another way (it ran out, it was stopped) says where each thread stands, its question included,
	// and a stopped one does so at once.
	const started = Date.now();
	const stopped = await orchestration().wait("a", kids, undefined, AbortSignal.abort());
	expect(Date.now() - started).toBeLessThan(500);
	expect(stopped.reports.map((entry) => entry.pendingRequestIds)).toEqual([[asked[0]], [asked[1]]]);
});

it("a fork is not a child: what it asks is the user's, whether or not the thread it was forked from waits for it", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, pending, notices, command } = await setup();
	await send("a", "Hello");
	await settled("a");
	await bridge().forkThread({ sourceThreadId: "a", targetThreadId: "f", title: "Fork" });
	expect(bridge().threadRecord("f")!.lineage).toMatchObject({ parentThreadId: "a", relationshipToParent: "fork" });
	await send("f", "Ask: Which database?");
	const first = await pending("f");
	await sleep(400);
	expect(notices((await bridge().projection("a")).projection)).toEqual([]);
	await command({ type: "runtime-request.respond", threadId: "f", requestId: first, answers: { q1: "SQLite" } });
	await settled("f");
	await ask("a", { name: "thread_prompt", args: { threadId: "f", message: "Ask: Which region?" } });
	const second = await bridge().waitFor("f", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.status === "pending" && request.id !== first), 10_000);
	await sleep(400);
	expect(results.some((result) => result["pendingRequestIds"] !== undefined), "the wait goes on").toBe(false);
	await command({ type: "runtime-request.respond", threadId: "f", requestId: second!.id, answers: { q1: "EU" } });
	const parent = (await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:"))))!;
	expect(JSON.parse(parent.messages.find((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length))).toMatchObject({ threadId: "f", verdict: "completed", notify: false });
	expect(notices(parent)).toEqual([]);
});

it("a message the parent has not read is taken back when the child is deleted", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, child, pending } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await send("a", "Hold on: busy");
	await bridge().waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await send(kid, "Ask: Which database?");
	await pending(kid);
	const waiting = async () => (await bridge().waitingMessages("a")).filter((message) => message.messageId.startsWith("q-"));
	await until("the message in the parent's turn", async () => (await waiting()).length === 1);
	await bridge().deleteThread(kid);
	await until("the message taken back", async () => (await waiting()).length === 0);
	gate("busy").release();
});

it("a child that is gone before the end of its question showed leaves no message behind", { timeout: 60_000 }, async () => {
	const { bridge, open, close, ask, send, settled, child, pending } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await close();
	await open({ orchestrated: false });
	// The questions alone, with what they hear of the threads in the test's hands.
	let hear: Parameters<Bridge["onShell"]>[0] = () => {};
	const listen = bridge().onShell.bind(bridge());
	vi.spyOn(bridge(), "onShell").mockImplementation((listener) => listen((hear = listener)));
	const questions = new ChildQuestions(bridge(), log, () => false);
	questions.start();
	onTestFinished(() => questions.close());
	await send("a", "Hold on: busy");
	await bridge().waitFor("a", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await send(kid, "Ask: Which database?");
	await pending(kid);
	const waiting = async () => (await bridge().waitingMessages("a")).filter((message) => message.messageId.startsWith("q-"));
	await until("the message in the parent's turn", async () => (await waiting()).length === 1);
	// A deletion removes the thread's record as it stops its run: the removal can be all that shows of it.
	const record = bridge().threadRecord.bind(bridge());
	vi.spyOn(bridge(), "threadRecord").mockImplementation((threadId) => (threadId === kid ? undefined : record(threadId)));
	hear({ kind: "thread.removed", sequence: 0, location: "active", threadId: kid } as never);
	await until("the message taken back", async () => (await waiting()).length === 0);
	gate("busy").release();
});

it("a wait that ends without the question, as the child asks, leaves it to a message", { timeout: 60_000 }, async () => {
	const { bridge, open, close, ask, send, settled, child, pending, notices } = await setup();
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	onQuestion = "ignore";
	// The questions alone, told that the parent waits for the child: its wait is to answer with the question.
	await close();
	await open({ orchestrated: false });
	let waits = true;
	const questions = new ChildQuestions(bridge(), log, (parent, asking) => waits && parent === "a" && asking === kid);
	questions.start();
	onTestFinished(() => questions.close());
	await send(kid, "Ask: Which database?");
	await pending(kid);
	await sleep(300);
	expect(notices((await bridge().projection("a")).projection)).toEqual([]);
	// The wait ran out as the child asked: nothing answered with the question.
	waits = false;
	questions.waitEnded(kid);
	const parent = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.some((message) => message.text === "Noted, not answered.")))!;
	expect(notices(parent)).toHaveLength(1);
});

it("a wait right after an answer is after it: it does not answer with the question that was answered", { timeout: 60_000 }, async () => {
	const { orchestration, ops, ask, settled, child, pending } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?", wait: false, notify: false } });
	const kid = await child();
	const requestId = await pending(kid);
	await settled("a", (projection) => projection.messages.some((message) => message.text === "Noted, not answered."));
	expect((await orchestration().wait("a", [kid], undefined)).reports[0]!.pendingRequestIds).toEqual([requestId]);
	// An answer the parent took its time over (it asked the user first, say): the next wait is not held off.
	await sleep(1_100);
	await ops().pendingRequest({}, { action: "respond", threadId: kid, requestId, answers: { q1: "Postgres" } });
	expect(await ops().pendingRequest({}, { action: "list", threadId: kid })).toEqual({ requestIds: [] });
	const after = await orchestration().wait("a", [kid], 5_000);
	expect(after.reports[0]).toMatchObject({ verdict: "completed" });
	expect(after.reports[0]!.pendingRequestIds).toBeUndefined();
});

it("an approval a child needs is the user's: it is no question, ends no wait, and nobody is told of it here", { timeout: 60_000 }, async () => {
	const { bridge, ops, ask, settled, child, notices, command } = await setup();
	const failure = async (work: Promise<unknown>) => work.then(() => undefined, (error: { code?: string; message: string }) => `${error.code}: ${error.message}`);
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Guard" } });
	const kid = await child();
	const approval = (await bridge().waitFor(kid, (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.kind === "permission" && request.status === "pending"), 10_000))!;
	await sleep(400);
	// The parent's wait goes on, and its thread has no message about it.
	const parent = (await bridge().projection("a")).projection;
	expect(parent.runs.map((run) => run.status)).toEqual(["running"]);
	expect(results).toEqual([]);
	expect(notices(parent)).toEqual([]);
	// T3's tool lists no approval, and answers none.
	expect(await ops().pendingRequest({}, { action: "list", threadId: kid })).toEqual({ requestIds: [] });
	expect(await failure(ops().pendingRequest({}, { action: "read", threadId: kid, requestId: approval.id }))).toBe("invalid_request: The pending user-input request was not found.");
	expect(await failure(ops().pendingRequest({}, { action: "respond", threadId: kid, requestId: approval.id, answers: { q1: "yes" } }))).toBe("invalid_request: The pending user-input request was not found.");
	await command({ type: "runtime-request.respond", threadId: kid, requestId: approval.id, decision: "accept" });
	const done = (await settled("a", (projection) => projection.messages.some((message) => message.text.startsWith("Parent saw:"))))!;
	expect(JSON.parse(done.messages.findLast((message) => message.text.startsWith("Parent saw:"))!.text.slice("Parent saw: ".length))).toMatchObject({ threadId: kid, verdict: "completed" });
	expect(notices(done)).toEqual([]);
});

it("a wait that no turn made leaves the question to a message", { timeout: 60_000 }, async () => {
	const { orchestration, ask, settled, child, notices } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "When ready: Which database?", wait: false, notify: false } });
	const kid = await child();
	await settled("a");
	// Nothing of the parent's runs: the question the wait answers with is in no turn's hands.
	const waiting = orchestration().wait("a", [kid], undefined);
	await sleep(200);
	gate("ready").release();
	expect((await waiting).reports[0]!.pendingRequestIds).toHaveLength(1);
	const parent = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.some((message) => message.text === "Noted, not answered.")))!;
	expect(notices(parent)).toHaveLength(1);
});

it("a child that asks while its parent's next wait holds off is that wait's to answer with", { timeout: 60_000 }, async () => {
	const { bridge, ask, send, settled, pending, notices } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "One" }, message: "What now?" } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 1);
	await ask("a", { name: "thread_prompt", args: { new: { title: "Two" }, message: "When ready: Which region?", wait: false, notify: false } });
	await settled("a", (projection) => projection.messages.filter((message) => message.text.startsWith("Parent saw:")).length === 2);
	const kids = bridge().threadRecords().filter((thread) => thread.lineage.parentThreadId === "a").map((thread) => thread.threadId) as [string, string];
	// The first asks, and the parent is told by a message.
	await send(kids[0], "Ask: Which database?");
	const first = await pending(kids[0]);
	await settled("a", (projection) => notices(projection).length === 1 && projection.messages.some((message) => message.text === "Noted, not answered."));
	// The parent waits for both, gets the first one's question, and waits again at once: that wait holds off for a
	// second, in which the other asks.
	onQuestion = "again";
	again = kids;
	await ask("a", { name: "thread_wait", args: { threadIds: kids } });
	await until("the first wait's answer", () => results.some((result) => result["reports"] !== undefined));
	await sleep(200);
	gate("ready").release();
	const second = await pending(kids[1]);
	const parent = (await settled("a", (projection) => notices(projection).length === 2 && projection.messages.filter((message) => message.text === "Noted, not answered.").length === 3))!;
	const waits = results.filter((result) => result["reports"] !== undefined) as { reports: { pendingRequestIds?: string[] }[] }[];
	expect(waits.map((wait) => wait.reports.map((entry) => entry.pendingRequestIds))).toEqual([[[first], undefined], [[first], [second]]]);
	// It was in the waiting turn's hands: the message about it came after that turn, not into it.
	const told = notices(parent).find((message) => message.senderThreadId === kids[1])!;
	expect(parent.runs).toHaveLength(5);
	expect(told.runId).toBe(parent.runs[4]!.id);
});

it("a wait that a question ended is ended by it again, but not sooner than a second later: a loop of waits does not spin", { timeout: 60_000 }, async () => {
	const { orchestration, ask, settled, child, pending } = await setup();
	onQuestion = "ignore";
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "Ask: Which database?", wait: false, notify: false } });
	const kid = await child();
	const requestId = await pending(kid);
	await settled("a", (projection) => projection.messages.some((message) => message.text === "Noted, not answered."));
	const timed = async () => {
		const started = Date.now();
		const { reports } = await orchestration().wait("a", [kid], undefined);
		expect(reports[0]).toMatchObject({ verdict: "active", pendingRequestIds: [requestId] });
		return Date.now() - started;
	};
	expect(await timed(), "the first wait").toBeLessThan(500);
	const second = await timed();
	expect(second, "the next, at once after it").toBeGreaterThanOrEqual(900);
	expect(second).toBeLessThan(2_000);
	await sleep(1_050);
	expect(await timed(), "one that comes a second later").toBeLessThan(500);
	// Another caller's wait for the child is not the parent's: it is not ended by the question, and not held up either.
	const ended = vi.spyOn(ChildQuestions.prototype, "waitEnded");
	const started = Date.now();
	const other = await orchestration().wait("elsewhere", [kid], 50);
	expect(Date.now() - started).toBeLessThan(500);
	expect(other.reports[0]).toMatchObject({ verdict: "active" });
	expect(other.reports[0]!.pendingRequestIds).toBeUndefined();
	// Whoever's it was, the wait's end is when a question it did not answer with is looked at again.
	expect(ended.mock.calls).toEqual([[kid]]);
});

it("a question that waited through a restart is told to its parent then if it was not, and not again if it was", { timeout: 60_000 }, async () => {
	const { bridge, ask, settled, child, pending, notices, open, close } = await setup();
	onQuestion = "ignore";
	// A process that told nobody: its child asks while the parent is idle.
	await close();
	await open({ orchestrated: false });
	await ask("a", { name: "thread_prompt", args: { new: { title: "Kid" }, message: "What now?", wait: false, notify: false } });
	const kid = await child();
	await settled(kid);
	await settled("a");
	await bridge().sendMessage({ threadId: kid, commandId: "c-ask", messageId: "m-ask", text: "Ask: Which database?", mode: "queue" });
	const requestId = await pending(kid);
	await sleep(200);
	expect(notices((await bridge().projection("a")).projection)).toEqual([]);
	// The next process finds the question waiting, and tells the parent.
	await close();
	await open();
	const told = (await settled("a", (projection) => notices(projection).length > 0 && projection.messages.some((message) => message.text === "Noted, not answered.")))!;
	expect(notices(told)).toHaveLength(1);
	expect(notices(told)[0]!.text).toContain(`requestId ${requestId}.`);
	// And the one after it finds the message in the parent's thread: it sends nothing, so a parent settled since stays so.
	await bridge().sidebar.settle("a");
	expect(bridge().threadRecord("a")!.settledOverride).toBe("settled");
	await close();
	await open();
	expect(await pending(kid)).toBe(requestId);
	await sleep(400);
	expect(notices((await bridge().projection("a")).projection)).toHaveLength(1);
	expect((await bridge().projection("a")).projection.runs).toHaveLength(told.runs.length);
	expect(bridge().threadRecord("a")!.settledOverride).toBe("settled");
});

it("t3_pending_request lists, reads and answers a thread's questions, with T3's refusals", { timeout: 60_000 }, async () => {
	const { ops, create, ask, send, settled, pending, requests } = await setup();
	const failure = async (work: Promise<unknown>) => work.then(() => undefined, (error: { code?: string; message: string }) => `${error.code}: ${error.message}`);
	expect(await ops().pendingRequest({}, { action: "list", threadId: "a" })).toEqual({ requestIds: [] });
	expect(await failure(ops().pendingRequest({}, { action: "list" }))).toBe("target_required: Name a threadId outside a thread.");
	await send("a", "Ask: Which database?");
	const requestId = await pending("a");
	// A thread's own, without a threadId.
	expect(await ops().pendingRequest({ threadId: "a" }, { action: "list" })).toEqual({ requestIds: [requestId] });
	expect(await ops().pendingRequest({}, { action: "read", threadId: "a", requestId })).toEqual({ requestId, questions: [{ id: "q1", header: "Choice", question: "Which database?", options: [], allowCustomAnswer: true }] });
	expect(await failure(ops().pendingRequest({}, { action: "read", threadId: "a" }))).toBe("invalid_request: This action needs `requestId`.");
	// As an agent's own tool, with T3's results and its refusals as the tool's error.
	await create({ threadId: "b", projectId: "p", title: "Other" });
	for (const args of [{ action: "list", threadId: "a" }, { action: "read", threadId: "a", requestId }, { action: "respond", threadId: "a", requestId, answers: { other: "x" } }]) await ask("b", { name: "t3_pending_request", args });
	await settled("b", (projection) => projection.runs.length === 3);
	expect(results.slice(-3)).toEqual([
		{ requestIds: [requestId] },
		{ requestId, questions: [{ id: "q1", header: "Choice", question: "Which database?", options: [], allowCustomAnswer: true }] },
		{ error: "invalid_request: Answer each question before sending: `answers` takes text, or a list of texts, under each question's id (q1)." },
	]);
	expect(await failure(ops().pendingRequest({}, { action: "read", threadId: "a", requestId: "uq-none" }))).toBe("invalid_request: The pending user-input request was not found.");
	expect(await failure(ops().pendingRequest({}, { action: "respond", threadId: "a", requestId }))).toBe("invalid_request: This action needs `answers`.");
	// An answer names each question by its id, in words.
	for (const answers of [{}, { answer: "Postgres" }, { q1: "  " }, { q1: [] }, { q1: ["Postgres", " "] }, { q1: ["Postgres", 7] }, { q1: 7 }, { q1: { label: "Postgres" } }]) {
		expect(await failure(ops().pendingRequest({}, { action: "respond", threadId: "a", requestId, answers })), JSON.stringify(answers)).toBe(
			"invalid_request: Answer each question before sending: `answers` takes text, or a list of texts, under each question's id (q1).",
		);
	}
	// A client the user approved for reading reads, and does not answer.
	const reader = { client: { sessionId: "s", access: "read-only" as const } };
	expect(await ops().pendingRequest(reader, { action: "list", threadId: "a" })).toEqual({ requestIds: [requestId] });
	expect(await failure(ops().pendingRequest(reader, { action: "respond", threadId: "a", requestId, answers: { q1: "Postgres" } }))).toBe(
		"capability_denied: This tool changes the environment, and this MCP client was approved for read-only access.",
	);
	expect((await requests("a"))[0]).toMatchObject({ status: "pending" });
	expect(await ops().pendingRequest({}, { action: "respond", threadId: "a", requestId, answers: { q1: ["Postgres", "SQLite"] } })).toEqual({ sequence: expect.any(Number) });
	await settled("a");
	expect((await requests("a"))[0]).toMatchObject({ status: "resolved", answers: { q1: ["Postgres", "SQLite"] } });
	expect(await failure(ops().pendingRequest({}, { action: "respond", threadId: "a", requestId, answers: { q1: "Postgres" } }))).toBe("invalid_request: The user-input request was already answered.");
	expect(await ops().pendingRequest({}, { action: "list", threadId: "a" })).toEqual({ requestIds: [] });
});
