// T3's sidebar settlement is durable on the thread row: settle hides a thread, un-settle wakes it, and both survive a
// restart because the threads document is the source of truth.
import { describe, expect, it } from "vitest";
import { makeThreads, restart } from "./threads-harness.ts";

describe("thread settlement", () => {
	it("settles and un-settles durably, keeping the first stamp", async () => {
		const fixture = await makeThreads();
		await fixture.threads.create({ threadId: "t", projectId: "p" });

		await fixture.threads.settle("t");
		const settled = (await fixture.threads.list()).find((thread) => thread.threadId === "t")!;
		expect(settled.settledOverride).toBe("settled");
		expect(settled.settledAt).toBeTypeOf("number");
		const stamp = settled.settledAt;
		await fixture.threads.settle("t");
		expect((await fixture.threads.list()).find((thread) => thread.threadId === "t")?.settledAt).toBe(stamp);

		const reopened = await restart(fixture);
		expect((await reopened.threads.list()).find((thread) => thread.threadId === "t")).toMatchObject({ settledOverride: "settled", settledAt: stamp });

		await reopened.threads.wake("t");
		const woke = (await reopened.threads.list()).find((thread) => thread.threadId === "t")!;
		expect(woke.settledOverride).toBeUndefined();
		expect(woke.settledAt).toBeUndefined();
		expect(woke.unsettledAt).toBeTypeOf("number");

		await reopened.threads.settle("t");
		await reopened.threads.unsettle("t");
		const awake = (await reopened.threads.list()).find((thread) => thread.threadId === "t")!;
		expect(awake.settledOverride).toBe("active");
		expect(awake.settledAt).toBeUndefined();
		expect(awake.unsettledAt).toBeTypeOf("number");
	});
});
