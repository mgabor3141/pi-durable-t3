// The threads layer's `search` over real pi-durable conversations: a prompt committed to a thread's head is searchable
// by its text (the user message and the assistant's answer), a thread with no match is absent, a deleted thread is
// never named, and the result is T3's shape (best match per thread, user message first). This is the layer the RPC
// answers from; the pure ranking rules are proven in `thread-search.test.ts`.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

describe("Threads.search", () => {
	it("finds a thread by the text of its user message, and by the assistant's answer", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });

		model.respond(fauxAssistantMessage("the answer mentions zebra"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "tell me about zebras" }, undefined);
		await idle(harness, thread.head);

		// A user-message match: source is "user", and the snippet is the user's text.
		const byUser = await threads.search("zebras", 50);
		expect(byUser).toHaveLength(1);
		expect(byUser[0]!.threadId).toBe("t");
		expect(byUser[0]!.projectId).toBe("p");
		expect(byUser[0]!.source).toBe("user");
		expect(byUser[0]!.snippet).toContain("zebras");

		// A term found only in the assistant's answer (not in the user text): source is "assistant".
		const byAssistant = await threads.search("mentions", 50);
		expect(byAssistant[0]!.source).toBe("assistant");
		expect(byAssistant[0]!.snippet).toContain("mentions");
	});

	it("prefers the user message over the assistant answer within one thread", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		model.respond(fauxAssistantMessage("yes, the keyword is here too"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "keyword please" }, undefined);
		await idle(harness, thread.head);

		const [hit] = await threads.search("keyword", 50);
		expect(hit?.source).toBe("user");
	});

	it("a thread with no matching text is absent; a match in the right project is kept", async () => {
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "one" }, { id: "two" }] });
		const create = createNamed(threads, harness, model);
		const a = await create({ threadId: "a", projectId: "one" });
		const b = await create({ threadId: "b", projectId: "two" });
		model.respond(fauxAssistantMessage("ok"));
		await threads.submit({ threadId: "a", conversationId: a.head, requestId: "r1", message: "alpha needle" }, undefined);
		await idle(harness, a.head);
		model.respond(fauxAssistantMessage("ok"));
		await threads.submit({ threadId: "b", conversationId: b.head, requestId: "r2", message: "beta nothing" }, undefined);
		await idle(harness, b.head);

		const hits = await threads.search("needle", 50);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.threadId).toBe("a");
		expect(hits[0]!.projectId).toBe("one");
	});

	it("a deleted thread is never returned", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		model.respond(fauxAssistantMessage("ok"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "findme" }, undefined);
		await idle(harness, thread.head);
		expect((await threads.search("findme", 50)).map((m) => m.threadId)).toEqual(["t"]);

		await threads.remove("t");
		expect(await threads.search("findme", 50)).toEqual([]);
	});

	it("an empty thread (no turns) matches nothing", async () => {
		const { threads } = await makeThreads();
		await threads.create({ threadId: "t", projectId: "p" });
		expect(await threads.search("anything", 50)).toEqual([]);
	});
});
