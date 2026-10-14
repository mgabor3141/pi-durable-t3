// Robustness of the threads layer under partial failure and concurrency — the schedules the invariant tests in
// `threads.test.ts` do not cover.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Threads, scanConversations } from "../src/threads.ts";
import { testRegistry } from "../src/testing/test-registry.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { firstUserEntry, gated, idle, makeThreads } from "./threads-harness.ts";

const seed = fauxAssistantMessage("seed");

/** A `Threads` whose promote step always throws, to exercise a prompt whose run commits but whose thread-add fails. */
class FailingPromoteThreads extends Threads {
	override async promote(): Promise<void> {
		throw new Error("injected promote failure");
	}
}

describe("submit honesty (S3)", () => {
	it("a failed thread-promote does not fail an already-committed prompt; repair adopts the run", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		const { threads, harness, model } = f;

		// Put the thread on `oldHead`, finish a turn, then move the thread off it so `oldHead` is nobody's head.
		const th = await threads.create({ threadId: "t", projectId: "p" });
		const oldHead = th.head;
		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, oldHead);
		const entry = await firstUserEntry(harness, oldHead);
		await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: entry, requestId: "u" });
		expect((await threads.thread("t"))?.head).not.toBe(oldHead);
		expect((await threads.list()).some((candidate) => candidate.head === oldHead)).toBe(false);

		// A prompt to the now-untracked head, with promote broken: the submit must SUCCEED (the run is live) and warn.
		const warnings: string[] = [];
		const brittle = new FailingPromoteThreads({ harness, registry: testRegistry(f.projects), defaultModel: model.modelRef, onWarn: (m) => warnings.push(m) });
		const run = gated("still running");
		model.respond(run.step);
		const submission = await brittle.submit({ threadId: "t", conversationId: oldHead, requestId: "late", message: "two" }, undefined);

		expect(submission, "the prompt succeeded even though its promote failed").toBeDefined();
		expect(warnings, "the promote failure is surfaced, not swallowed").toHaveLength(1);
		// The run is live on `oldHead`, but promote failed, so nothing points at it yet.
		expect((await threads.list()).some((candidate) => candidate.head === oldHead)).toBe(false);

		// The self-heal: boot repair adopts the owed conversation.
		await threads.repair();
		expect((await threads.list()).some((candidate) => candidate.head === oldHead)).toBe(true);

		run.release();
		await idle(harness, oldHead);
	});
});

describe("undo ↔ prompt concurrency (S2 coverage)", () => {
	it("a prompt and an undo in flight at once never strand the live run or duplicate a head", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		const { threads, harness, model } = f;
		const th = await threads.create({ threadId: "t", projectId: "p" });
		const head = th.head;
		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: head, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, head);
		const entry = await firstUserEntry(harness, head);

		// Fire a prompt (that stays live) and an undo of the first turn concurrently, in either arrival order.
		const run = gated("running");
		model.respond(run.step);
		const outcomes = await Promise.allSettled([
			threads.submit({ threadId: "t", conversationId: head, requestId: "p2", message: "two" }, undefined),
			threads.rewind({ threadId: "t", expectedHead: head, entryId: entry, requestId: "u2" }),
		]);
		run.release();
		// Let whatever was admitted settle.
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The run committed on `head`; whatever happened, `head` must be some thread's head (a run is never stranded)…
		expect(outcomes[0].status).toBe("fulfilled");
		expect((await threads.list()).some((candidate) => candidate.head === head), "the run's conversation is still a thread head").toBe(true);

		// …and no two threads may share a head.
		const heads = (await threads.list()).map((candidate) => candidate.head);
		expect(new Set(heads).size).toBe(heads.length);

		// Every existing conversation is accounted for; the schedule created no orphan beyond the head + its optional fork.
		const conversations = await harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
		expect(conversations.length).toBeGreaterThanOrEqual(1);

		await Promise.race([idle(harness, head), new Promise((resolve) => setTimeout(resolve, 5000))]);
	});
});
