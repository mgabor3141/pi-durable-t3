// Messages sent while a `/compact` runs keep the mode they were sent with: the steers wait in the `/compact`'s run, as
// T3 shows a steer the agent has not read, and start the run the summary begins, together (`steeringMode: "all"`); a
// queued message stays in the queue until then, and the first one is placed with the steers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { bridgeConfig, createNamed, gated, idle, makeThreads, quietLog } from "./threads-harness.ts";

type Item = { type: string; runId: string; status: string; text?: string; inputIntent?: string };

async function setup() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-compaction-steers-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let n = 0;
	const send = (text: string, mode: "start" | "steer" | "queue") => bridge.sendMessage({ threadId: "t", commandId: `c${++n}`, messageId: `m${n}`, text, mode });
	// Long enough that a compaction has something to cut (it keeps the last 20k tokens).
	const long = "x".repeat(120_000);
	for (const text of ["one", "two"]) {
		f.model.respond(fauxAssistantMessage(text + long));
		await send(text, "start");
		await idle(f.harness, thread.head);
	}
	const told: string[][] = [];
	const answer = (text: string) => (request: { messages: readonly { role: string; content: unknown }[] }) => {
		told.push(request.messages.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))));
		return fauxAssistantMessage(text);
	};
	return { f, thread, bridge, send, told, answer };
}

it("steers sent while a /compact runs wait in its run and reach the model together; a queued one waits in the queue", { timeout: 60_000 }, async () => {
	const { f, thread, bridge, send, told, answer } = await setup();
	const summary = gated("## Goal\nsummarized");
	f.model.respond(summary.step, answer("all read"), answer("d read"));
	await send("/compact", "start");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await send("steer a", "steer");
	await send("steer b", "steer");
	await send("queued c", "queue");
	await send("queued d", "queue");

	const { projection } = await bridge.projection("t");
	const compactRun = projection.runs.find((run) => projection.messages.find((message) => message.id === run.userMessageId)?.text === "/compact")!;
	const items = projection.turnItems as unknown as Item[];
	expect(items.filter((item) => item.runId === compactRun.id && item.type === "user_message" && item.inputIntent === "steer").map((item) => [item.text, item.status])).toEqual([
		["steer a", "pending"],
		["steer b", "pending"],
	]);
	expect(projection.runs.filter((run) => run.status === "queued").map((run) => projection.messages.find((message) => message.id === run.userMessageId)?.text)).toEqual(["queued c", "queued d"]);

	summary.release();
	await idle(f.harness, thread.head);
	await bridge.waitFor("t", (shown) => (shown.runs.some((run) => run.status === "queued") ? undefined : true), 15_000);
	// The first request after the summary has both steers, and not the queued message, which is the next run's.
	// One request after the summary: both steers, and the first queued message, which pi places with them as it places
	// what waits at the end of any run; they are one run on the timeline, which the answer completes. The next queued
	// message is a run of its own.
	expect(told).toHaveLength(2);
	expect(told[0]!.slice(-3)).toEqual(["steer a", "steer b", "queued c"]);
	expect(told[1]!.at(-1)).toBe("queued d");
	const after = (await bridge.projection("t")).projection;
	const runs = after.runs.slice(after.runs.indexOf(after.runs.find((run) => run.id === compactRun.id)!) + 1);
	expect(runs.map((run) => [after.messages.find((message) => message.id === run.userMessageId)?.text, run.status])).toEqual([
		["steer a", "completed"],
		["queued d", "completed"],
	]);
	const rows = (after.turnItems as unknown as Item[]).filter((item) => item.runId === runs[0]!.id).map((item) => [item.type, item.text ?? "", item.inputIntent ?? null]);
	expect(rows).toEqual([
		["user_message", "steer a", "turn_start"],
		["user_message", "steer b", "steer"],
		["user_message", "queued c", "queued_turn"],
		["assistant_message", "all read", null],
	]);
});

it("a Stop of a /compact holds what waits behind it, steers as queued messages, for the user to take up again", { timeout: 60_000 }, async () => {
	const { f, thread, bridge, send, told, answer } = await setup();
	// A compaction that waits to retry, which Stop ends.
	for (let i = 0; i < 5; i++) f.model.append(fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }));
	await send("/compact", "start");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await send("steer a", "steer");
	await send("queued b", "queue");
	await send("steer c", "steer");
	// A queued message promoted to a steer meanwhile is a queued message again.
	await send("queued d", "queue");
	const promoted = (await bridge.projection("t")).projection;
	const d = promoted.runs.find((run) => promoted.messages.find((message) => message.id === run.userMessageId)?.text === "queued d")!;
	await dispatchCommand(bridge, { type: "queued-message.promote-to-steer", commandId: "promote", threadId: "t", queuedRunId: d.id } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	await new Promise((resolve) => setTimeout(resolve, 500));
	const inbox = (await f.harness.snapshot(InboxDoc, thread.head as ConversationId, BACKGROUND_CONTEXT))!.items;
	expect(inbox.map((item) => [item.mode, (item.entry?.data as { whenBusy?: string; promoted?: boolean }).whenBusy, (item.entry?.data as { promoted?: boolean }).promoted])).toEqual([
		["followUp", "followUp", undefined],
		["followUp", "followUp", undefined],
		["followUp", "followUp", undefined],
		["followUp", "followUp", undefined],
	]);
	expect(told, "nothing reached the model").toEqual([]);
	const { projection } = await bridge.projection("t");
	const queued = projection.runs.filter((run) => run.status === "queued");
	expect(queued.map((run) => [projection.messages.find((message) => message.id === run.userMessageId)?.text, (run as { queueHeld?: boolean }).queueHeld])).toEqual([
		["steer a", true],
		["queued b", true],
		["steer c", true],
		["queued d", true],
	]);
	expect((projection.turnItems as unknown as Item[]).filter((item) => item.type === "user_message" && item.status === "pending"), "no steer waits in a run").toEqual([]);

	// Resume starts the first, as it starts a held queue; the others follow it one by one.
	f.model.respond(answer("a read"), answer("b read"), answer("c read"), answer("d read"));
	await dispatchCommand(bridge, { type: "queue.resume", commandId: "resume", threadId: "t" } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	await expect.poll(() => told.length, { timeout: 20_000 }).toBe(4);
	await idle(f.harness, thread.head);
	expect(told.map((said) => said.at(-1))).toEqual(["steer a", "queued b", "steer c", "queued d"]);
});

it("the next message after a Stop of a /compact starts the first held message with it, in one run", { timeout: 60_000 }, async () => {
	const { f, thread, bridge, send, told, answer } = await setup();
	for (let i = 0; i < 5; i++) f.model.append(fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }));
	await send("/compact", "start");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await send("steer a", "steer");
	await send("queued b", "queue");
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	f.model.respond(answer("a and new read"), answer("b read"));
	// T3's default send while nothing runs: pi places the first held message and this one in one request.
	await send("new one", "steer");
	await expect.poll(() => told.length, { timeout: 20_000 }).toBe(2);
	await idle(f.harness, thread.head);
	expect(told.map((said) => said.slice(-2))).toEqual([
		["steer a", "new one"],
		["new one", "queued b"],
	]);
	const after = (await bridge.projection("t")).projection;
	const text = (run: (typeof after.runs)[number]) => after.messages.find((message) => message.id === run.userMessageId)?.text;
	const runs = after.runs.slice(after.runs.findIndex((run) => text(run) === "/compact") + 1);
	expect(runs.map((run) => [text(run), run.status])).toEqual([
		["steer a", "completed"],
		["queued b", "completed"],
	]);
	expect((after.turnItems as unknown as Item[]).filter((item) => item.runId === runs[0]!.id).map((item) => [item.type, item.text ?? ""])).toEqual([
		["user_message", "steer a"],
		["user_message", "new one"],
		["assistant_message", "a and new read"],
	]);
});
