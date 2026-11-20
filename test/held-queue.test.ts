// Stop takes the queued messages out of the conversation's inbox for the length of one commit
// (pi-durable's abort withdraws whatever is queued) and puts them back after it. A host that dies between the two
// must not lose them: they are kept in a document meanwhile, and a start puts them back.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { HeldQueueDoc } from "../src/threads.ts";
import { createNamed, gated, makeThreads, restart } from "./threads-harness.ts";

it("a host that died while a queue was held aside puts it back when it starts", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const head = thread.head as ConversationId;
	const held = gated("the first answer");
	f.model.respond(held.step, fauxAssistantMessage("to the queued one"));
	await f.threads.submit({ threadId: "t", conversationId: head, requestId: "c1", message: "go", messageId: "m1" }, undefined);
	await f.threads.submit({ threadId: "t", conversationId: head, requestId: "c2", message: "then this", messageId: "m2" }, "followUp");
	const queued = (await f.harness.snapshot(InboxDoc, head, BACKGROUND_CONTEXT))!.items.filter((item) => item.mode !== "write");
	expect(queued).toHaveLength(1);

	// The first half of a Stop's abort, and then the host is gone.
	await f.harness.commit(async (tx) => {
		const inbox = await tx.doc(InboxDoc, head);
		const out = inbox.items.filter((item) => item.mode !== "write").map((item) => JSON.parse(JSON.stringify(item)));
		for (let index = inbox.items.length - 1; index >= 0; index--) if (inbox.items[index]?.mode !== "write") inbox.items.splice(index, 1);
		(await tx.doc(HeldQueueDoc)).held[String(head)] = out;
	}, BACKGROUND_CONTEXT);
	// The run that is taken up again after the start waits too, so the queue is looked at before anything takes from it.
	const again = gated("the first answer, again");
	f.model.respond(again.step, fauxAssistantMessage("to the queued one"));
	held.release();
	const up = await restart(f);
	await up.threads.load();

	const back = (await up.harness.snapshot(InboxDoc, head, BACKGROUND_CONTEXT))!.items.filter((item) => item.mode !== "write");
	expect(JSON.parse(JSON.stringify(back))).toEqual(JSON.parse(JSON.stringify(queued)));
	expect((await up.harness.snapshot(HeldQueueDoc, BACKGROUND_CONTEXT))?.held).toEqual({});
	again.release();
	await up.harness.close(BACKGROUND_CONTEXT);
});
