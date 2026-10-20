// The example's `titleThread`: one completion on the thread's own model over the context at `at`, with no tools, and
// the model's reply (trimmed, unquoted) as the title. Faux model; temp roots only.
import { expect, it } from "vitest";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { titleThread } from "../src/title.ts";
import { createNamed, firstUserEntry, idle, makeThreads } from "../../../test/threads-harness.ts";

it("titles from the context at the first user entry, on the thread's model, with no tools", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }], coding: true });
	const seen: Context[] = [];
	f.model.respond(fauxAssistantMessage("pong"), async (context) => {
		seen.push(context);
		return fauxAssistantMessage('"Fixing the login bug"');
	});
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	await f.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "the login is broken" }, undefined);
	await idle(f.harness, thread.head);
	const at = (await firstUserEntry(f.harness, thread.head)) as EntryId;

	const title = await titleThread(f.harness, f.model.models)({
		threadId: "t", conversationId: thread.head as ConversationId, at, reason: "first-message", signal: new AbortController().signal,
	});
	expect(title).toBe("Fixing the login bug");
	expect(seen).toHaveLength(1);
	expect(seen[0]!.tools ?? []).toHaveLength(0);
	// The context ends at `at`: the first message, then the title instruction — not the reply.
	const texts = seen[0]!.messages.map((m) => JSON.stringify(m.content));
	expect(texts.some((t) => t.includes("the login is broken"))).toBe(true);
	expect(texts.some((t) => t.includes("pong"))).toBe(false);
}, 30_000);
