// The threads layer's `search` over real pi-durable conversations: a prompt committed to a thread's head is searchable
// by its text (the user message and the assistant's answer), word by word, a thread with no match is absent, a deleted
// or archived thread is never named, and the result is T3's shape (best match per thread, user message first). This is
// the layer the RPC answers from; the pure ranking rules are proven in `thread-search.test.ts`.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

	it("matches the query word by word, as T3 does, and leaves an archived thread out", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		model.respond(fauxAssistantMessage("done"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "The sidebar needs a fix" }, undefined);
		await idle(harness, thread.head);

		expect((await threads.search("fix sidebar", 50)).map((hit) => [hit.threadId, hit.snippet])).toEqual([["t", "The sidebar needs a fix"]]);
		expect(await threads.search("fix navbar", 50)).toEqual([]);
		await threads.updateRecord("t", (record) => {
			record.archivedAt = Date.now();
		});
		expect(await threads.search("fix sidebar", 50)).toEqual([]);
	});

	it("an agent's thread_search (forAgent) searches archived threads, subagents, side chats and agents' prompts; T3's search does not", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const send = async (threadId: string, message: string, provenance?: { createdBy: "agent"; creationSource: "mcp" }) => {
			const thread = await create({ threadId, projectId: "p" });
			model.respond(fauxAssistantMessage("ok"));
			await threads.submit({ threadId, conversationId: thread.head, requestId: `r-${threadId}`, message, ...(provenance === undefined ? {} : { provenance }) }, undefined);
			await idle(harness, thread.head);
		};
		await send("archived", "the archived walrus");
		await send("child", "the child walrus");
		await send("side", "the side walrus");
		await send("prompted", "the prompted walrus", { createdBy: "agent", creationSource: "mcp" });
		await send("plain", "the plain walrus");
		await threads.updateRecord("archived", (record) => {
			record.archivedAt = Date.now();
		});
		await threads.updateRecord("child", (record) => {
			record.lineage = { parentThreadId: "plain", relationshipToParent: "subagent", rootThreadId: "plain" };
		});
		await threads.updateRecord("side", (record) => {
			record.lineage = { parentThreadId: "plain", relationshipToParent: "fork", rootThreadId: "plain", sideChat: true };
		});
		const found = async (forAgent: boolean) => (await threads.search("walrus", 50, forAgent)).map((hit) => hit.threadId).toSorted();
		expect(await found(true)).toEqual(["archived", "child", "plain", "prompted", "side"]);
		expect(await found(false)).toEqual(["plain"]);
		// The agent's ranking has no palette part: a thread the user picked for the query does not come first.
		await threads.updateRecord("archived", (record) => {
			record.opens = { openedAt: Date.now(), score: 5, picks: [{ query: "walrus", at: Date.now() }] };
		});
		await threads.updateRecord("plain", (record) => {
			record.opens = { openedAt: Date.now(), score: 5, picks: [{ query: "walrus", at: Date.now() }] };
		});
		expect((await threads.search("walrus", 50, false))[0]?.threadId).toBe("plain");
		const agentOrder = (await threads.search("walrus", 50, true)).map((hit) => hit.threadId);
		await threads.updateRecord("archived", (record) => {
			delete record.opens;
		});
		await threads.updateRecord("plain", (record) => {
			delete record.opens;
		});
		expect((await threads.search("walrus", 50, true)).map((hit) => hit.threadId)).toEqual(agentOrder);
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

	it("finds what a compaction took out of the model's context, and what was written since the last search", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		model.respond(fauxAssistantMessage("about the aardvark"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "first, the platypus" }, undefined);
		await idle(harness, thread.head);
		expect(await threads.search("platypus", 50)).toHaveLength(1);

		const conversation = (await harness.conversation(thread.head as never, BACKGROUND_CONTEXT))!;
		await conversation.submit({ type: "write", entry: { kind: "pi.compaction", head: "self", model: [{ role: "user", content: [{ type: "text", text: "<summary>earlier work</summary>" }], timestamp: Date.now() }] } } as never, BACKGROUND_CONTEXT);
		await idle(harness, thread.head);
		model.respond(fauxAssistantMessage("about the okapi"));
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r2", message: "then, the quokka" }, undefined);
		await idle(harness, thread.head);
		const context = await conversation.context(BACKGROUND_CONTEXT);
		expect(JSON.stringify(context.messages), "out of the model's context").not.toContain("platypus");

		expect((await threads.search("platypus", 50)).map((hit) => hit.source)).toEqual(["user"]);
		expect((await threads.search("aardvark", 50)).map((hit) => hit.source)).toEqual(["assistant"]);
		expect((await threads.search("quokka", 50)).map((hit) => hit.snippet)).toEqual(["then, the quokka"]);
		expect(await threads.search("earlier work", 50), "a summary is not a message").toEqual([]);
	});

	it("searches that overlap read each message once", async () => {
		const { threads, harness, model } = await makeThreads();
		const thread = await createNamed(threads, harness, model)({ threadId: "t", projectId: "p" });
		// More than one page of messages, so that the searches page through the head at the same time.
		await harness.commit(async (tx) => {
			for (let i = 0; i < 1500; i++) await tx.appendEntry(thread.head as never, { kind: "app.user", data: { messageId: `m${i}` }, model: [{ role: "user", content: `message number ${i}`, timestamp: 1000 + i }] } as never);
		}, BACKGROUND_CONTEXT);
		await Promise.all([threads.search("number", 10), threads.search("numbe", 10), threads.search("numb", 10)]);
		const chars = Array.from({ length: 1500 }, (_, i) => `message number ${i}`.length).reduce((sum, length) => sum + length, 0);
		expect(threads.searchChars()).toBe(chars);
	});
});
