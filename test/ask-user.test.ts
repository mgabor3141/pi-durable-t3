// `ask_user` on this host: the agent's call is T3's question card in the thread (a `user_input_request` item and a
// pending runtime request), T3's answer (`runtime-request.respond`) is what the call returns, and the agent goes on
// with it. A card that is dismissed, or whose run is stopped, tells the agent so.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, type Extension, type Harness, LiveDoc, type ToolRegistration } from "@earendil-works/pi-durable";
import { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { snapshotItem } from "../src/t3/thread-stream.ts";
import { bridgeConfig, conversation, createNamed, idle, makeThreads, quietLog, restart, type ThreadsFixture } from "./threads-harness.ts";

type Request = { id: string; kind: string; status: string; responseCapability: { type: string }; answers?: Record<string, unknown> };
type Card = { id: string; type: string; status: string; requestId: string; questions: { id: string; header: string; question: string; options: { label: string; description: string }[]; multiSelect?: boolean; allowCustomAnswer?: boolean }[]; questionAnswer?: { answers: Record<string, unknown>; questionTextById: Record<string, string> } };

/** The tool's runs: how often its code ran. */
let runs = 0;
/** The `ask_user` extension, counting its runs. Its code needs nothing of the bridge that made it. */
const counted = (extension: Extension): Extension => {
	const tool = extension.tools![0] as ToolRegistration;
	return { ...extension, tools: [{ ...tool, execute: (args, api, context) => (runs++, tool.execute(args, api, context)) }] } as Extension;
};

/** Does the Harness come to need no running process (`wake().active`), once the call's last step ended? */
async function idleProcess(harness: Harness): Promise<boolean> {
	for (let tries = 0; tries < 200; tries++) {
		if (!harness.wake().active) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

/** The status of call `callId`'s slot in the conversation's live state once it is not about to start: `sleeping` while
 * it is parked. */
const slot = async (harness: Harness, head: number, callId: string) => {
	for (let tries = 0; ; tries++) {
		const status = (await harness.snapshot(LiveDoc, head as ConversationId, BACKGROUND_CONTEXT))?.tools?.find((each) => each.callId === callId)?.status;
		if ((status !== "pending" && status !== "running") || tries === 200) return status;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

async function open(f: Pick<ThreadsFixture, "threads" | "registry" | "model">, scratch: string) {
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	return bridge;
}

async function setup() {
	runs = 0;
	const asking = { current: undefined as Extension | undefined };
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-ask-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = await open(f, scratch);
	asking.current = counted(bridge.userInput.extension());
	f.tools.install(asking.current);
	let sent = 0;
	const command = (fields: Record<string, unknown>) => dispatchCommand(bridge, { commandId: `cmd-${++sent}`, threadId: "t", ...fields } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	const card = (status: string) =>
		bridge.waitFor("t", (projection) => {
			const request = (projection.runtimeRequests as unknown as Request[]).find((candidate) => candidate.status === status);
			const item = (projection.turnItems as unknown as Card[]).find((candidate) => candidate.type === "user_input_request" && candidate.requestId === request?.id);
			return request === undefined || item === undefined ? undefined : { request, item, projection };
		}, 10_000);
	/** What the model was given back for a call. */
	const result = async (callId: string) => {
		const entries = (await (await conversation(f.harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
		const message = entries.flatMap((entry) => entry.model ?? []).find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === callId);
		return message?.role === "toolResult" ? JSON.parse(message.content.map((block) => (block.type === "text" ? block.text : "")).join("")) : undefined;
	};
	return { f, bridge, thread, command, card, result, scratch, extension: asking.current };
}

const ask = (callId: string, questions: unknown[]) => fauxAssistantMessage([fauxToolCall("ask_user", { questions: questions as never }, { id: callId })], { stopReason: "toolUse" });

it("asks with T3's card, and the answer is what the call returns", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result } = await setup();
	f.model.respond(
		ask("call-1", [
			{ header: "Database", question: "Which database should it use?", options: [{ label: "SQLite", description: "One file, no server." }, { label: "Postgres", description: "A server you run." }] },
			{ id: "regions", header: "Regions", question: "Which regions?", multiSelect: true, allowCustomAnswer: false, options: [{ label: "EU", description: "Frankfurt" }, { label: "US", description: "Virginia" }] },
			{ header: "Name", question: "What should it be called?" },
		]),
		fauxAssistantMessage("SQLite it is."),
	);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Set up storage.", mode: "start" });

	const waiting = await card("pending");
	expect(waiting, "the card is shown").toBeDefined();
	expect(waiting!.request).toMatchObject({ id: "uq-call-1", kind: "user_input", responseCapability: { type: "live" } });
	// The call is parked: it holds no process while the card waits (T3's item waits too), and it ran once.
	expect(await slot(f.harness, thread.head, "call-1")).toBe("sleeping");
	expect(await idleProcess(f.harness), "nothing needs a process").toBe(true);
	expect(waiting!.item.status).toBe("waiting");
	expect(runs).toBe(1);
	// The questions as T3's card takes them: an id each, and an open question takes the user's own words.
	expect(waiting!.item.questions).toEqual([
		{ id: "q1", header: "Database", question: "Which database should it use?", options: [{ label: "SQLite", description: "One file, no server." }, { label: "Postgres", description: "A server you run." }], allowCustomAnswer: true },
		{ id: "regions", header: "Regions", question: "Which regions?", options: [{ label: "EU", description: "Frankfurt" }, { label: "US", description: "Virginia" }], multiSelect: true, allowCustomAnswer: false },
		{ id: "q3", header: "Name", question: "What should it be called?", options: [], allowCustomAnswer: true },
	]);
	// What the web app is sent encodes with T3's own schema.
	const stream = await bridge.streamSnapshot("t");
	Schema.encodeSync(OrchestrationV2ThreadStreamItem)(snapshotItem(stream.sequence, stream.projection, { bounded: false, deferWork: false, compactTurnItems: false, dedupeBodies: false, compactIds: false }) as never);
	expect(bridge.threadShell("t").status, "the agent waits").toBe("running");

	// An answer from another thread, with a decision instead of answers, or with files, is refused.
	await expect(command({ type: "runtime-request.respond", threadId: "other", requestId: "uq-call-1", answers: { q1: "SQLite" } })).rejects.toThrow(/no longer pending|Unknown thread/);
	await expect(command({ type: "runtime-request.respond", requestId: "uq-call-1", decision: "accept" })).rejects.toThrow("A question is answered, not approved");
	// A card this host does not hold (any more) is refused as no longer pending.
	await expect(command({ type: "runtime-request.respond", requestId: "rr-gone", answers: { q1: "SQLite" } })).rejects.toThrow("Runtime request rr-gone is no longer pending.");
	await expect(command({ type: "runtime-request.respond", requestId: "uq-call-1", answers: { q1: "SQLite" }, attachmentsByQuestionId: { q1: [{ type: "image", id: "a", name: "a.png", mimeType: "image/png", sizeBytes: 1 }] } })).rejects.toThrow(/attachmentsByQuestionId is not supported/);

	await command({ type: "runtime-request.respond", requestId: "uq-call-1", answers: { q1: "SQLite", regions: ["EU", "US"], q3: "ledger", stray: "not asked" } });
	await idle(f.harness, thread.head);
	expect(await result("call-1")).toEqual({ status: "answered", answers: { q1: "SQLite", regions: ["EU", "US"], q3: "ledger" } });
	const answered = await card("resolved");
	expect(answered!.request.answers).toEqual({ q1: "SQLite", regions: ["EU", "US"], q3: "ledger" });
	expect(answered!.item).toMatchObject({ status: "completed", questionAnswer: { answers: { q1: "SQLite", regions: ["EU", "US"], q3: "ledger" }, questionTextById: { q1: "Which database should it use?", regions: "Which regions?", q3: "What should it be called?" } } });
	expect(answered!.projection.messages.at(-1)!.text).toBe("SQLite it is.");
	// The card is answered once.
	await expect(command({ type: "runtime-request.respond", requestId: "uq-call-1", answers: { q1: "Postgres" } })).rejects.toThrow("Runtime request uq-call-1 is no longer pending.");
});

it("a card that is dismissed, or whose run is stopped, ends without an answer and says so", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result } = await setup();
	f.model.respond(ask("call-1", [{ header: "Go on?", question: "Should I go on?" }]), fauxAssistantMessage("Going on with my best guess."), ask("call-2", [{ header: "Again", question: "And now?" }]));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Do it.", mode: "start" });
	expect(await card("pending")).toBeDefined();
	expect(await slot(f.harness, thread.head, "call-1")).toBe("sleeping");
	await command({ type: "thread.user-input.dismiss", requestId: "uq-call-1" });
	await idle(f.harness, thread.head);
	expect(await result("call-1")).toMatchObject({ status: "dismissed", note: expect.stringContaining("best judgement") });
	expect((await card("cancelled"))!.request.id).toBe("uq-call-1");

	// Stop while a card waits: the call is cancelled with its run, and the card is no longer pending.
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "Again.", mode: "start" });
	await bridge.waitFor("t", (projection) => ((projection.runtimeRequests as unknown as Request[]).some((request) => request.id === "uq-call-2" && request.status === "pending") ? true : undefined), 10_000);
	expect(await slot(f.harness, thread.head, "call-2"), "Stop finds the call parked").toBe("sleeping");
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	const stopped = await bridge.waitFor("t", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.id === "uq-call-2" && request.status !== "pending"), 10_000);
	expect(stopped?.status).toBe("cancelled");
	await expect(command({ type: "runtime-request.respond", requestId: "uq-call-2", answers: { q1: "late" } })).rejects.toThrow("no longer pending");
});

it("a card that waits through a restart is the same request, runs no tool code meanwhile, and its answer wakes the call", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, card, scratch, extension } = await setup();
	f.model.respond(ask("call-1", [{ header: "Name", question: "What should it be called?" }]), fauxAssistantMessage("Ledger it is."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Name it.", mode: "start" });
	const before = await card("pending");
	expect(await slot(f.harness, thread.head, "call-1")).toBe("sleeping");
	await bridge.close();

	const up = await restart({ ...f, extensions: [extension!] });
	const again = await open({ ...up, model: f.model }, scratch);
	// However long the card has waited, the settlement sweep at startup leaves the thread alone: its run goes on.
	await again.sidebar.sweep(Date.now() + 30 * 24 * 60 * 60 * 1000);
	expect(again.threadShell("t").settledOverride).toBeNull();
	// The thread opens with its run, and shows the card the call is: the same request, asked at the same time.
	const after = await again.waitFor("t", (projection) => (projection.runtimeRequests as unknown as (Request & { createdAt: unknown })[]).find((request) => request.status === "pending"), 10_000);
	expect(after).toMatchObject({ id: "uq-call-1", createdAt: (before!.request as Request & { createdAt: unknown }).createdAt });
	expect(again.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: "uq-call-1", kind: "user_input" });
	expect(runs, "no tool code ran at the restart").toBe(1);

	await dispatchCommand(again, { commandId: "cmd-after", threadId: "t", type: "runtime-request.respond", requestId: "uq-call-1", answers: { q1: "ledger" } } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	await idle(up.harness, thread.head);
	const entries = (await (await conversation(up.harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
	const message = entries.flatMap((entry) => entry.model ?? []).find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === "call-1");
	expect(message?.role === "toolResult" ? JSON.parse(message.content.map((block) => (block.type === "text" ? block.text : "")).join("")) : undefined).toEqual({ status: "answered", answers: { q1: "ledger" } });
	expect(runs, "woken once, by the answer").toBe(2);
	expect(again.threadShell("t").pendingRuntimeRequest).toBeNull();
});
