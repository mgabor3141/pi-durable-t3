// Threads-layer invariants from the design. Each asserts a specific durable outcome; several are proven load-bearing
// by reverting the corresponding rule in `src/threads.ts`.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { HostError } from "../src/host-errors.ts";
import { scanConversations } from "../src/threads.ts";
import { conversation, errored, firstUserEntry, gated, idle, makeThreads } from "./threads-harness.ts";

const code = (error: unknown): string => (error instanceof HostError ? error.code : `not-a-HostError: ${String(error)}`);
const rejectCode = async (promise: Promise<unknown>): Promise<string> => promise.then(() => "resolved", code);

const seed = fauxAssistantMessage("seed");

describe("create", () => {
	it("a retried create adds one thread and one conversation", async () => {
		const { threads, harness } = await makeThreads();
		const first = await threads.create({ threadId: "t", projectId: "p" });
		const second = await threads.create({ threadId: "t", projectId: "p" });
		expect(second.threadId).toBe("t");
		expect(second.head).toBe(first.head);
		expect(await threads.list()).toHaveLength(1);
		const conversations = await harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
		expect(conversations.filter((record) => record.id === first.head)).toHaveLength(1);
		// The retried create created no second conversation (`scanConversations` does not list the reserved root).
		expect(conversations).toHaveLength(1);
	});

	it("an unknown project is refused before any write", async () => {
		const { threads, harness } = await makeThreads();
		expect(await rejectCode(threads.create({ threadId: "t", projectId: "nope" }))).toBe("unknown_project");
		const conversations = await harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
		expect(conversations).toHaveLength(0); // no conversation created (the reserved root is not scanned).
	});
});

describe("prompt racing undo — both orders", () => {
	it("undo first: a later prompt to the old head spawns a child thread, not a lost turn", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		const oldHead = thread.head;

		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, oldHead);
		const entry = await firstUserEntry(harness, oldHead);

		await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: entry, requestId: "undo" });
		expect((await threads.thread("t"))?.head).not.toBe(oldHead);

		// The client still shows the old head; a prompt to it must become its own thread.
		model.respond(fauxAssistantMessage("after"));
		await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "late", message: "still here" }, undefined);
		await idle(harness, oldHead);

		const child = (await threads.list()).find((candidate) => candidate.head === oldHead);
		expect(child, "a thread now points at the old head").toBeDefined();
		expect(child?.parent).toEqual({ threadId: "t", entryId: null });
	});

	it("prompt first: a rewind while that run is live is refused, leaving the head and the live run", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		const head = thread.head;

		const run = gated("running");
		model.respond(run.step);
		await threads.submit({ threadId: "t", conversationId: head, requestId: "work", message: "long" }, undefined);
		const entry = await firstUserEntry(harness, head);

		expect(await rejectCode(threads.rewind({ threadId: "t", expectedHead: head, entryId: entry, requestId: "undo" }))).toBe("turn_running");
		expect((await threads.thread("t"))?.head).toBe(head);

		run.release();
		await idle(harness, head);
	});
});

describe("undo", () => {
	it("a retried undo returns the same fork and does not fork again", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		const oldHead = thread.head;
		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, oldHead);
		const entry = await firstUserEntry(harness, oldHead);

		const first = await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: entry, requestId: "same" });
		const again = await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: entry, requestId: "same" });

		expect(again).toBe(first);
		expect((await threads.list()).filter((candidate) => candidate.head === first)).toHaveLength(1);
		// Only the old head and its one fork exist — the retry created no extra conversation.
		const conversations = await harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
		expect(conversations).toHaveLength(2);
	});

	it("undo refusals: a non-user entry is not rewindable; a failed run with a queued follow-up stays owed", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		const head = thread.head;
		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: head, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, head);
		const entries = (await conversation(harness, head).then((c) => c.context(BACKGROUND_CONTEXT))).entries;
		const assistant = entries.find((entry) => entry.kind !== "pi.user");
		expect(assistant, "there is an assistant entry to reject").toBeDefined();
		expect(await rejectCode(threads.rewind({ threadId: "t", expectedHead: head, entryId: assistant!.id, requestId: "x" }))).toBe("not_rewindable");

		// A run that fails only after a follow-up was queued behind it: the follow-up is owed, so the thread is busy —
		// undo is refused, the owed turn cannot be forked away.
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		model.respond(async () => {
			await gate;
			return errored("boom") as never;
		});
		await threads.submit({ threadId: "t", conversationId: head, requestId: "one", message: "one" }, undefined);
		await threads.submit({ threadId: "t", conversationId: head, requestId: "two", message: "two" }, "followUp");
		release();
		await idle(harness, head);
		const entry = await firstUserEntry(harness, head);
		expect(await rejectCode(threads.rewind({ threadId: "t", expectedHead: head, entryId: entry, requestId: "undo" }))).toBe("turn_running");
		expect((await threads.thread("t"))?.head).toBe(head);
	});
});

describe("promotion", () => {
	it("concurrent promotions of one conversation add exactly one thread", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		const oldHead = thread.head;
		model.respond(seed);
		await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "seed", message: "hi" }, undefined);
		await idle(harness, oldHead);
		const entry = await firstUserEntry(harness, oldHead);
		// Move the thread off `oldHead` so it is no longer anyone's head, then promote it twice at once.
		await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: entry, requestId: "undo" });

		await Promise.all([threads.promote("t", oldHead), threads.promote("t", oldHead)]);
		expect((await threads.list()).filter((candidate) => candidate.head === oldHead)).toHaveLength(1);
	});
});

describe("remove", () => {
	it("drops the pointer but keeps the conversation", async () => {
		const { threads, harness } = await makeThreads();
		const thread = await threads.create({ threadId: "t", projectId: "p" });
		await threads.remove("t");
		expect(await threads.thread("t")).toBeUndefined();
		expect(await conversation(harness, thread.head).catch(() => undefined)).toBeDefined();
	});
});
