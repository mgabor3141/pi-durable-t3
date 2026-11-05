// A manual /compact is one summary: a second click while the first summary runs joins it instead of
// starting another compaction of the same cut, and the caller waits until the summary is durable.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

describe("manual compact", () => {
	it("joins a running compaction instead of starting a second one", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		// Exceed the default 20k-token keep window so there is a prefix to compact.
		const long = "x".repeat(120_000);
		for (const [index, text] of ["one", "two"].entries()) {
			model.respond(fauxAssistantMessage(text + long));
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "p" + String(index), message: text }, undefined);
			await idle(harness, thread.head);
		}
		model.respond(fauxAssistantMessage("summary"));
		await Promise.all([threads.compact("t", undefined), threads.compact("t", undefined)]);
		const all = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
		const compactions = all.items.filter((entry) => entry.kind === "pi.compaction");
		expect(compactions).toHaveLength(1);
	});
});
