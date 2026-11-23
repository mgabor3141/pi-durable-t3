// A manual compaction that ends without a summary because it failed is shown as failed on its `/compact` (T3's
// "Context compaction failed · <why>"), from the failure pi keeps; one that waits to retry ends at Stop.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { bridgeConfig, createNamed, idle, makeThreads } from "./threads-harness.ts";

type Item = { type: string; runId: string | null; status: string; summary?: string };

async function setup() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-compaction-failure-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, settings: ServerSettingsStore.open(scratch) }), { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	// Long enough that a compaction has something to cut (it keeps the last 20k tokens).
	const long = "x".repeat(120_000);
	for (const [index, text] of ["one", "two"].entries()) {
		f.model.append(fauxAssistantMessage(text + long));
		await bridge.sendMessage({ threadId: "t", commandId: `c${index}`, messageId: `m${index}`, text, mode: "start" });
		await idle(f.harness, thread.head);
	}
	const live = () => f.harness.snapshot(LiveDoc, thread.head as ConversationId, BACKGROUND_CONTEXT);
	const compactions = async () => ((await bridge.projection("t")).projection.turnItems as unknown as Item[]).filter((item) => item.type === "compaction");
	return { f, bridge, thread, live, compactions };
}

it("shows a /compact whose summary failed as a failed compaction, until a compaction succeeds", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, live, compactions } = await setup();
	const refused = "400 invalid_request_error: the request is not valid";
	f.model.append(fauxAssistantMessage("", { stopReason: "error", errorMessage: refused }));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	// pi's words for it.
	const failed = `Summarization failed: ${refused}`;
	await expect.poll(async () => (await live())?.compactionFailure?.error, { timeout: 20_000 }).toBe(failed);
	await idle(f.harness, thread.head);
	const { projection } = await bridge.projection("t");
	const run = projection.runs.at(-1)!;
	expect(projection.messages.find((message) => message.id === run.userMessageId)?.text).toBe("/compact");
	expect(await compactions()).toEqual([expect.objectContaining({ runId: run.id, status: "failed", summary: failed })]);

	// The next /compact writes its summary: the failure is gone, and the earlier /compact shows nothing.
	f.model.append(fauxAssistantMessage("## Goal\nsummarized"));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact2", messageId: "m-compact2", text: "/compact", mode: "start" });
	await expect.poll(async () => (await compactions()).map((item) => item.status), { timeout: 20_000 }).toEqual(["completed"]);
});

it("Stop ends a manual compaction that waits to retry", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, live, compactions } = await setup();
	for (let i = 0; i < 5; i++) f.model.append(fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	await expect.poll(async () => (await live())?.compactions?.[0]?.retry?.error, { timeout: 20_000 }).toContain("Overloaded");
	expect((await bridge.projection("t")).projection.runs.at(-1)?.status).toBe("running");
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	expect((await live())?.compactions ?? []).toEqual([]);
	const { projection } = await bridge.projection("t");
	expect(projection.runs.some((run) => run.status === "running")).toBe(false);
	expect(await compactions()).toEqual([]);
});
