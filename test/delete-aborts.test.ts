// Deleting a thread must stop its running turn. Before the fix, `remove` only spliced the pointer: the model turn kept
// running (spending, touching files), and at the next start `repair()` — which promotes every owed, headless conversation —
// re-added the "deleted" thread as a fresh one (S3). Here a thread's turn is in flight, the thread is deleted, and we
// assert the run is no longer owed and `repair()` does not bring the thread back.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { createNamed, makeThreads } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("delete aborts the running turn (S3)", () => {
	it("deleting a thread mid-run aborts it and repair() does not resurrect the thread", async () => {
		// A turn that streams for ~100 s: unmistakably live when we delete.
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }], responses: [fauxAssistantMessage("token ".repeat(4000))], tokensPerSecond: 40 });
		const create = createNamed(threads, harness, model);
		const t = await create({ threadId: "t", projectId: "p" });
		await threads.submit({ threadId: "t", conversationId: t.head, requestId: "r1", message: "go" }, undefined);

		const isLive = async (): Promise<boolean> => (await harness.snapshot(LiveDoc, t.head as ConversationId, ctx))?.run !== undefined;
		const liveBy = Date.now() + 10_000;
		while (!(await isLive())) {
			if (Date.now() > liveBy) throw new Error("the run never became live");
			await sleep(50);
		}

		await threads.remove("t"); // must abort the head before dropping the pointer

		// The run is no longer owed (abort interrupted it and waited for idle)…
		expect(await isLive()).toBe(false);
		// …so boot repair has nothing to promote: no thread — old or new — points at the deleted head.
		await threads.repair();
		expect((await threads.list()).some((thread) => thread.head === t.head)).toBe(false);
	}, 30_000);
});
