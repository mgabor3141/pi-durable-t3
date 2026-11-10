import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { InboxDoc } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

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
		await fixture.threads.startQueued("t", `q${queued.id}`, "start");
		await idle(fixture.harness, thread.head);
		expect((await readInbox()).items).toEqual([]);
		const entries = await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT);
		expect(JSON.stringify(entries.entries)).toContain("queued");
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
		await fixture.threads.editQueued("t", `q${steer.id}`, "go right");
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
		await fixture.threads.cancelQueued("t", `q${dropped.id}`);
		second.open();
		await idle(fixture.harness, thread.head);
		expect(JSON.stringify((await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT)).messages)).not.toContain("never mind");
	});
});
