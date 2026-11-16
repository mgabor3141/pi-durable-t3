// A steer that finds no place in its run (the answer came with no tool round) is placed when the run ends, and a
// message queued behind it is placed with it: two user messages in a row, answered by one run. They are that one
// run's messages. Shown as a run each, the steer's was a run nothing answered: "interrupted".
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { bridgeConfig, createNamed, gated, makeThreads, quietLog } from "./threads-harness.ts";

it("a steer and a queued message that a run's end places together are one run, answered", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-steer-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	const held = gated("the held answer");
	f.model.respond(held.step, fauxAssistantMessage("to both"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await bridge.waitFor("t", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "a steer", mode: "steer" });
	await bridge.sendMessage({ threadId: "t", commandId: "c3", messageId: "m3", text: "and a follow-up", mode: "queue" });
	held.release();
	const projection = await bridge.waitFor("t", (candidate) => (candidate.messages.some((message) => message.text === "to both") && candidate.runs.every((run) => run.status !== "running" && run.status !== "queued") ? candidate : undefined), 15_000);
	expect(projection, "the thread settled").toBeDefined();
	expect(projection!.runs.map((run) => [String(run.userMessageId), run.status])).toEqual([["m1", "completed"], ["m2", "completed"]]);
	// Both messages are shown, in order, in the run that answers them.
	const second = projection!.runs[1]!.id;
	expect(projection!.messages.filter((message) => message.runId === second).map((message) => `${message.role}:${message.text}`)).toEqual(["user:a steer", "user:and a follow-up", "assistant:to both"]);
});
