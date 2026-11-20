import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { InboxDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { conversation, createNamed, gated, idle, makeThreads } from "./threads-harness.ts";

/** A first run that fails once released, leaving what was queued behind it in the inbox. */
const failsWhenReleased = (): { readonly step: FauxResponseStep; readonly release: () => void } => {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { step: async () => (await gate, fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })), release };
};

describe("starting a queued message", () => {
	it("starts the selected queued follow-up and clears it from the inbox", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const failing: FauxResponseStep = async () => {
			await gate;
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
		};
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [failing, fauxAssistantMessage("ok")] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "first", message: "first" }, undefined);
		const queued = await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "queued", message: "queued" }, "followUp");
		release();
		await idle(fixture.harness, thread.head);
		const readInbox = async () => await fixture.harness.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(InboxDoc, thread.head as never))), BACKGROUND_CONTEXT);
		const inboxBefore = await readInbox();
		expect(inboxBefore?.items).toMatchObject([{ id: queued.id, mode: "followUp", content: "queued" }]);
		await fixture.threads.queue.startQueued("t", `q${queued.id}`, "start");
		await idle(fixture.harness, thread.head);
		expect((await readInbox()).items).toEqual([]);
		const entries = await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT);
		expect(JSON.stringify(entries.entries)).toContain("queued");
	});

	it("starts a queued message with its attachments as it was sent, and the others follow it", async () => {
		const first = failsWhenReleased();
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [first.step, fauxAssistantMessage("read"), fauxAssistantMessage("next")] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		const head = thread.head;
		await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "first", message: "first" }, undefined);
		const listed = { type: "text" as const, text: "Attachments:\n- /att/report.pdf", hidden: true };
		const file = { type: "file" as const, id: "f1", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 3 };
		const queued = await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "a", message: "read this", messageId: "m-a", blocks: [listed], attachments: [file] }, "followUp");
		await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "b", message: "then this", messageId: "m-b" }, "followUp");
		first.release();
		await idle(fixture.harness, head);
		// The queue shows the message's own text, without the hidden list, and its file.
		expect(await fixture.threads.queue.waiting("t")).toMatchObject([{ messageId: "m-a", text: "read this" }, { messageId: "m-b" }]);

		await fixture.threads.queue.startQueued("t", `q${queued.id}`, "start");
		await idle(fixture.harness, head);
		expect((await fixture.harness.snapshot(InboxDoc, head as never, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
		const entries = (await (await conversation(fixture.harness, head)).context(BACKGROUND_CONTEXT)).entries;
		const sent = entries.find((entry) => (entry.data as { messageId?: string } | undefined)?.messageId === "m-a");
		expect(sent?.data).toMatchObject({ attachments: [file] });
		expect((sent?.model?.[0] as { content?: unknown } | undefined)?.content).toEqual([{ type: "text", text: "read this" }, listed]);
		expect(entries.some((entry) => (entry.data as { messageId?: string } | undefined)?.messageId === "m-b")).toBe(true);
	});

	it("the messages behind one sent now follow it however soon its run ends", async () => {
		const first = failsWhenReleased();
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [first.step, fauxAssistantMessage("a"), fauxAssistantMessage("b"), fauxAssistantMessage("c")] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		const head = thread.head;
		await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "first", message: "first" }, undefined);
		const a = await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "a", message: "A", messageId: "m-a" }, "followUp");
		for (const name of ["B", "C"]) await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: name, message: name, messageId: `m-${name}` }, "followUp");
		first.release();
		await idle(fixture.harness, head);
		// The run started now ends before anything after its admission is done.
		const remember = fixture.threads.remember.bind(fixture.threads);
		fixture.threads.remember = async (...args) => {
			await idle(fixture.harness, head);
			return remember(...args);
		};

		await fixture.threads.queue.startQueued("t", `q${a.id}`, "start");
		await idle(fixture.harness, head);
		expect((await fixture.harness.snapshot(InboxDoc, head as never, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
		const sent = (await (await conversation(fixture.harness, head)).context(BACKGROUND_CONTEXT)).entries.map((entry) => (entry.data as { messageId?: string } | undefined)?.messageId).filter((id) => id !== undefined);
		expect(sent).toEqual(["m-a", "m-B", "m-C"]);
	});

	it("the messages queued behind a restart's message follow it however soon its run ends", async () => {
		const first = gated("never");
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [first.step, fauxAssistantMessage("now"), fauxAssistantMessage("b")] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		const head = thread.head;
		await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "first", message: "first", messageId: "m-first" }, undefined);
		await fixture.threads.submit({ threadId: "t", conversationId: head, requestId: "B", message: "B", messageId: "m-B" }, "followUp");
		const remember = fixture.threads.remember.bind(fixture.threads);
		fixture.threads.remember = async (...args) => {
			await idle(fixture.harness, head);
			return remember(...args);
		};

		const stopped = fixture.threads.queue.abort({ threadId: "t", conversationId: head });
		first.release();
		await stopped;
		await fixture.threads.queue.submitFirst({ threadId: "t", conversationId: head, requestId: "now", message: "now", messageId: "m-now" });
		await idle(fixture.harness, head);
		expect((await fixture.harness.snapshot(InboxDoc, head as never, BACKGROUND_CONTEXT))?.items ?? []).toEqual([]);
		const sent = (await (await conversation(fixture.harness, head)).context(BACKGROUND_CONTEXT)).entries.map((entry) => (entry.data as { messageId?: string } | undefined)?.messageId).filter((id) => id !== undefined);
		expect(sent).toEqual(["m-first", "m-now", "m-B"]);
	});

	it("a steer waiting for the turn's next boundary can be edited, and enters the turn as edited; a removed one never does", async () => {
		const seen: string[] = [];
		const answer = (text: string) => (context: { messages: readonly unknown[] }) => {
			seen.push(JSON.stringify(context.messages));
			return fauxAssistantMessage(text);
		};
		// A turn whose model request waits for its gate, as a turn running a long script does.
		const gated = () => {
			let open = (): void => {};
			const gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			const step: FauxResponseStep = async (context) => {
				await gate;
				return answer("answer")(context);
			};
			return { step, open };
		};
		const first = gated();
		const second = gated();
		const fixture = await makeThreads({ projects: [{ id: "p" }], responses: [first.step, answer("steered"), second.step, answer("unsteered")] });
		const thread = await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
		await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "first", message: "first" }, undefined);
		const steer = await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "steer", message: "go left" }, "steer");
		await fixture.threads.queue.editQueued("t", `q${steer.id}`, "go right");
		first.open();
		await idle(fixture.harness, thread.head);
		const context = await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT);
		const text = JSON.stringify(context.messages);
		expect(text).toContain("go right");
		expect(text).not.toContain("go left");
		expect(seen.at(-1)).toContain("go right");

		// Removed before the boundary: the turn ends without it.
		await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "second", message: "second" }, undefined);
		const dropped = await fixture.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "steer-2", message: "never mind" }, "steer");
		await fixture.threads.queue.cancelQueued("t", `q${dropped.id}`);
		second.open();
		await idle(fixture.harness, thread.head);
		expect(JSON.stringify((await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT)).messages)).not.toContain("never mind");
	});
});
