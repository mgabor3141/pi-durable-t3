// T3's queue drag sends `queued-run.reorder` with the run to move and the run to put it before. The inbox array is the
// queue order pi places at the next boundary, so a reorder is one move in that array, not a new submission.
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { createNamed, gated, idle, makeThreads } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("queued reorder", () => {
	it("moves a queued follow-up before another, or to the end", async () => {
		const gate = gated("done");
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [gate.step] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		try {
			await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "p1", message: "go" }, undefined);
			for (let attempt = 0; attempt < 100; attempt++) {
				if ((await fixture.harness.snapshot(LiveDoc, thread.head as never, ctx))?.run !== undefined) break;
				await sleep(10);
			}
			const a = await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "q1", message: "A" }, "followUp");
			const b = await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "q2", message: "B" }, "followUp");
			const ids = async () => (await fixture.harness.snapshot(InboxDoc, thread.head as never, ctx))?.items.map((item) => item.id);
			expect(await ids()).toEqual([a.id, b.id]);

			await fixture.threads.reorderQueued("t", `q${b.id}`, `q${a.id}`);
			expect(await ids()).toEqual([b.id, a.id]);

			await fixture.threads.reorderQueued("t", `q${b.id}`, null);
			expect(await ids()).toEqual([a.id, b.id]);
		} finally {
			gate.release();
			await idle(fixture.harness, thread.head);
		}
	});
});
