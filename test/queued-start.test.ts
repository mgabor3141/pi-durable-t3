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
		const inboxBefore = await fixture.harness.snapshot(InboxDoc, thread.head);
		expect(inboxBefore?.items).toMatchObject([{ id: queued.id, mode: "followUp", content: "queued" }]);
		await fixture.threads.startQueued("t", `q${queued.id}`, "start");
		await idle(fixture.harness, thread.head);
		expect((await fixture.harness.snapshot(InboxDoc, thread.head))?.items).toEqual([]);
		const entries = await (await conversation(fixture.harness, thread.head)).context(BACKGROUND_CONTEXT);
		expect(JSON.stringify(entries.entries)).toContain("queued");
	});
});
