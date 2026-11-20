// Steers and queued messages, as T3 shows them. A steer is shown in the run it steers from the moment it is sent:
// waiting to be read (a `pending` user item, T3's "Steer · waiting to be read") until pi places it, at the run's next
// tool round or at the end of its answer, then read, the same row. It is never a queued run while a run takes it. A
// queued message is a queued run until it is placed, as a run of its own. Labels follow how a message was sent, not
// where it landed: a steer placed at the end of an answer is still the run's steer, and the message queued behind it
// is still a run of its own.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { bridgeConfig, conversation, createNamed, gated, makeThreads, quietLog } from "./threads-harness.ts";

type Projection = OrchestrationV2ThreadProjection;

async function setup(coding = false) {
	const f = await makeThreads({ projects: [{ id: "p" }], coding });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-steer-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	const send = (messageId: string, text: string, mode: "start" | "steer" | "queue") => bridge.sendMessage({ threadId: "t", commandId: `c-${messageId}`, messageId, text, mode });
	const until = <T>(test: (projection: Projection) => T | undefined) => bridge.waitFor("t", test, 15_000) as Promise<T>;
	return { f, bridge, send, until };
}

/** A user message's row: its item id, status and label, and the run it is shown in, by its message id. */
const row = (projection: Projection, messageId: string) => {
	const item = projection.turnItems.find((candidate) => candidate.type === "user_message" && candidate.messageId === messageId) as { id: string; status: string; inputIntent: string; runId: string } | undefined;
	return item === undefined ? undefined : { id: item.id, status: item.status, intent: item.inputIntent, run: projection.runs.find((run) => run.id === item.runId)?.userMessageId };
};
const queuedRuns = (projection: Projection) => projection.runs.filter((run) => run.status === "queued").map((run) => String(run.userMessageId));
const settled = (projection: Projection) => projection.runs.every((run) => run.status !== "running" && run.status !== "queued");

it("a steer sent during an answer waits in that run, and stays its steer once the answer's end places it; the message queued behind it is a run of its own", { timeout: 60_000 }, async () => {
	const { f, send, until } = await setup();
	const held = gated("the first answer");
	f.model.respond(held.step, fauxAssistantMessage("to both"));
	await send("m1", "go", "start");
	await until((projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined));
	await send("m2", "a steer", "steer");
	await send("m3", "and a follow-up", "queue");

	// Waiting: the steer in the running run, not in the queue; the follow-up queued.
	const waiting = await until((projection) => (row(projection, "m2") !== undefined && queuedRuns(projection).includes("m3") ? projection : undefined));
	expect(row(waiting, "m2")).toEqual({ id: "ti-mm2", status: "pending", intent: "steer", run: "m1" });
	expect(queuedRuns(waiting)).toEqual(["m3"]);
	expect(waiting.messages.find((message) => message.id === "m2")?.runId, "its message belongs to the run it steers").toBe(waiting.runs.find((run) => run.userMessageId === "m1")?.id);

	held.release();
	const done = await until((projection) => (projection.messages.some((message) => message.text === "to both") && settled(projection) ? projection : undefined));
	expect(row(done, "m2"), "the same row, read, still in the run it steered").toEqual({ id: "ti-mm2", status: "completed", intent: "steer", run: "m1" });
	expect(row(done, "m3")).toMatchObject({ intent: "turn_start", run: "m3" });
	expect(done.runs.map((run) => [String(run.userMessageId), run.status])).toEqual([["m1", "completed"], ["m3", "completed"]]);
	const textsOf = (userMessageId: string) => {
		const runId = done.runs.find((run) => run.userMessageId === userMessageId)!.id;
		return done.messages.filter((message) => message.runId === runId).map((message) => `${message.role}:${message.text}`);
	};
	expect(textsOf("m1")).toEqual(["user:go", "assistant:the first answer", "user:a steer"]);
	expect(textsOf("m3")).toEqual(["user:and a follow-up", "assistant:to both"]);
});

it("a steer sent while a tool runs waits in the run and is read at the tool round, where it lands among the run's rows", { timeout: 60_000 }, async () => {
	const { f, send, until } = await setup(true);
	let releaseTool = (): void => {};
	const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
	f.model.respond(
		async () => {
			await toolGate;
			return fauxAssistantMessage([fauxToolCall("bash", { command: "true" }, { id: "call-1" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("done"),
	);
	await send("m1", "go", "start");
	await until((projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined));
	await send("m2", "and then this", "steer");
	const waiting = await until((projection) => (row(projection, "m2") !== undefined ? projection : undefined));
	expect(row(waiting, "m2")).toEqual({ id: "ti-mm2", status: "pending", intent: "steer", run: "m1" });
	expect(queuedRuns(waiting)).toEqual([]);
	releaseTool();
	const done = await until((projection) => (projection.messages.some((message) => message.text === "done") && settled(projection) ? projection : undefined));
	expect(row(done, "m2")).toEqual({ id: "ti-mm2", status: "completed", intent: "steer", run: "m1" });
	// Placed after the tool round, before the answer to it.
	const order = done.turnItems.toSorted((left, right) => left.ordinal - right.ordinal).map((item) => `${item.type}:${(item as { text?: string }).text ?? ""}`);
	expect(order.filter((item) => !item.startsWith("reasoning"))).toEqual(["user_message:go", "command_execution:", "user_message:and then this", "assistant_message:done"]);
});

it("a queued message promoted to a steer leaves the queue and waits in the run, labelled as one that was queued first", { timeout: 60_000 }, async () => {
	const { f, bridge, send, until } = await setup();
	const held = gated("the first answer");
	f.model.respond(held.step, fauxAssistantMessage("and the promoted one"));
	await send("m1", "go", "start");
	await until((projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined));
	await send("m2", "queued, then promoted", "queue");
	const queued = await until((projection) => projection.runs.find((run) => run.status === "queued" && run.userMessageId === "m2"));
	await bridge.promoteQueued("t", String(queued.id));
	const waiting = await until((projection) => (row(projection, "m2")?.status === "pending" ? projection : undefined));
	expect(row(waiting, "m2")).toEqual({ id: "ti-mm2", status: "pending", intent: "promoted_queued_to_steer", run: "m1" });
	expect(queuedRuns(waiting)).toEqual([]);
	held.release();
	const done = await until((projection) => (projection.messages.some((message) => message.text === "and the promoted one") && settled(projection) ? projection : undefined));
	expect(row(done, "m2")).toEqual({ id: "ti-mm2", status: "completed", intent: "promoted_queued_to_steer", run: "m1" });
});

it("a steer waiting when the run is stopped is cancelled where it waited, with T3's notice that it may not have been delivered", { timeout: 60_000 }, async () => {
	const { f, bridge, send, until } = await setup();
	const held = gated("never finished");
	f.model.respond(held.step, fauxAssistantMessage("to the queued one"), fauxAssistantMessage("to the next one"));
	await send("m1", "go", "start");
	await until((projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined));
	await send("m2", "a steer", "steer");
	await send("m3", "queued", "queue");
	await until((projection) => (row(projection, "m2")?.status === "pending" ? true : undefined));
	await bridge.interrupt("t");
	held.release();
	const stopped = await until((projection) => (row(projection, "m2")?.status === "cancelled" && !projection.runs.some((run) => run.status === "running") ? projection : undefined));
	expect(row(stopped, "m2"), "the same row, in the stopped run").toEqual({ id: "ti-mm2", status: "cancelled", intent: "steer", run: "m1" });
	const notices = stopped.turnItems.filter((item) => item.type === "system_notice");
	expect(notices).toEqual([
		expect.objectContaining({
			status: "completed",
			runId: stopped.runs.find((run) => run.userMessageId === "m1")!.id,
			title: "Steer delivery not confirmed",
			message: 'The agent did not confirm reading your steer before Stop. It may not have been delivered. Resend it if needed: "a steer"',
		}),
	]);
	expect(queuedRuns(stopped), "not queued; the queued message stays queued, held").toEqual(["m3"]);
	expect(stopped.runs.find((run) => run.userMessageId === "m3")).toMatchObject({ queueHeld: true });

	// The next message goes on with the queue; the dropped steer never reaches the model.
	await send("m4", "next", "start");
	const done = await until((projection) => (projection.runs.length === 3 && settled(projection) ? projection : undefined));
	expect(done.runs.map((run) => [String(run.userMessageId), run.status])).toEqual([["m1", "interrupted"], ["m3", "completed"], ["m4", "completed"]]);
	const head = (await f.threads.thread("t"))!.head;
	const context = await (await conversation(f.harness, head)).context(BACKGROUND_CONTEXT);
	expect(JSON.stringify(context.messages)).not.toContain("a steer");
	expect(row(done, "m2")?.status).toBe("cancelled");
});

// Unlike T3, which cancels it too: an agent's message steered into a stopped turn (here a child's report) is kept, held
// first, since its sender cannot send it again and the report's text is nowhere else; the next message takes it in.
it("an agent's steer waiting when the run is stopped is kept, held, and reaches the model with the next message", { timeout: 60_000 }, async () => {
	const { f, bridge, send, until } = await setup();
	const held = gated("never finished");
	f.model.respond(held.step, fauxAssistantMessage("to the report and the next one"));
	await send("m1", "go", "start");
	await until((projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined));
	await bridge.sendMessage({ threadId: "t", commandId: "notify-n-x", messageId: "n-x", text: "[Report from thread c]\nTHE REPORT", mode: "steer", provenance: { createdBy: "agent", creationSource: "server", senderThreadId: "c" }, automatic: true });
	await until((projection) => (row(projection, "n-x")?.status === "pending" ? true : undefined));
	await bridge.interrupt("t");
	held.release();
	const stopped = await until((projection) => (queuedRuns(projection).includes("n-x") && !projection.runs.some((run) => run.status === "running") ? projection : undefined));
	expect(stopped.turnItems.some((item) => item.type === "system_notice"), "no unread-steer notice").toBe(false);
	expect(stopped.runs.find((run) => run.userMessageId === "n-x")).toMatchObject({ status: "queued", queueHeld: true });

	await send("m2", "next", "start");
	await until((projection) => (projection.messages.some((message) => message.text === "to the report and the next one") && settled(projection) ? true : undefined));
	const head = (await f.threads.thread("t"))!.head;
	const context = await (await conversation(f.harness, head)).context(BACKGROUND_CONTEXT);
	expect(JSON.stringify(context.messages)).toContain("THE REPORT");
});
