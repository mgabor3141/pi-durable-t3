// A `/compact` that writes no summary shows how its compaction task ended, as T3 shows a compaction's end: failed
// ("Context compaction failed · <why>"), a provider's limit (T3's usage limit card, with the reset), or stopped.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CompactionTask, type ConversationId, defineExtension, type Extension, hook, LiveDoc } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { bridgeConfig, createNamed, idle, makeThreads } from "./threads-harness.ts";

type Item = { type: string; runId: string | null; status: string; title?: string; summary?: string; failure?: { class: string; message: string; resetAt?: string } };

/** A host's compaction hook that gives a compaction up at a provider's stated wait, as pi-durable-claw's does: it
 * records pi's `compactionFailure` and declines. */
const LIMIT = "Server requested 314936s retry delay (max: 60s). 429 rate_limit_error: This request would exceed your account's rate limit.";
const limited: Extension = defineExtension({
	name: "limited",
	hooks: [
		hook(CompactionTask, {
			beforeCompact: async (compaction, api, context) => {
				const runtime = api as unknown as { taskId: number; conversationId: ConversationId; commit(change: (tx: { doc: (token: typeof LiveDoc, id: ConversationId) => Promise<Record<string, unknown>> }) => Promise<void>, context: unknown): Promise<void> };
				await runtime.commit(async (tx) => void ((await tx.doc(LiveDoc, runtime.conversationId)).compactionFailure = { taskId: runtime.taskId, trigger: compaction.reason, error: LIMIT }), context);
				return { decline: true } as const;
			},
		}),
	],
});

async function setup(extensions: readonly Extension[] = []) {
	const f = await makeThreads({ projects: [{ id: "p" }], extensions });
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

it("shows a /compact whose summary failed as a failed compaction, after a later one succeeds too", { timeout: 60_000 }, async () => {
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
	expect(run.status).toBe("failed");
	expect(await compactions()).toEqual([expect.objectContaining({ runId: run.id, status: "failed", summary: failed })]);

	// The next /compact writes its summary, and pi forgets the failure; the earlier /compact still shows how it ended.
	f.model.append(fauxAssistantMessage("## Goal\nsummarized"));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact2", messageId: "m-compact2", text: "/compact", mode: "start" });
	await expect.poll(async () => (await compactions()).map((item) => `${item.runId}:${item.status}`).sort(), { timeout: 20_000 }).toEqual([`${run.id}:failed`, expect.stringMatching(/:completed$/)]);
	expect((await live())?.compactionFailure).toBeUndefined();
});

it("shows a /compact given up at a provider's stated wait as T3's usage limit, with the time it resets", { timeout: 60_000 }, async () => {
	const { bridge, live } = await setup([limited]);
	const sent = Date.now();
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	await expect.poll(async () => (await live())?.compactionFailure?.error, { timeout: 20_000 }).toBe(LIMIT);
	await expect.poll(async () => (await bridge.projection("t")).projection.runs.at(-1)?.status, { timeout: 20_000 }).toBe("failed");
	const { projection } = await bridge.projection("t");
	const runId = projection.runs.at(-1)!.id;
	const items = (projection.turnItems as unknown as Item[]).filter((item) => item.runId === runId && item.type !== "user_message");
	expect(items).toEqual([expect.objectContaining({ type: "compaction", status: "failed", title: "Context compaction failed" }), expect.objectContaining({ type: "error", status: "failed", failure: expect.objectContaining({ class: "usage_limit", message: LIMIT }) })]);
	expect(items[0]!.summary, "the card says it failed; the usage limit says why").toBeUndefined();
	const resetAt = Date.parse(items[1]!.failure!.resetAt!);
	expect(resetAt).toBeGreaterThanOrEqual(sent + 314_936_000);
	expect(resetAt).toBeLessThan(Date.now() + 314_936_000);
});

it("Stop ends a manual compaction that waits to retry, and the /compact shows it stopped", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, live, compactions } = await setup();
	for (let i = 0; i < 5; i++) f.model.append(fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded_error: Overloaded" }));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	await expect.poll(async () => (await live())?.compactions?.[0]?.retry?.error, { timeout: 20_000 }).toContain("Overloaded");
	expect((await bridge.projection("t")).projection.runs.at(-1)?.status).toBe("running");
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	expect((await live())?.compactions ?? []).toEqual([]);
	await expect.poll(async () => (await bridge.projection("t")).projection.runs.at(-1)?.status, { timeout: 20_000 }).toBe("interrupted");
	expect(await compactions()).toEqual([expect.objectContaining({ status: "interrupted", title: "Context compaction stopped" })]);
});
