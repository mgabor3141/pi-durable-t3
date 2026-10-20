// The example's `titleThread`: one completion on the thread's own model over the context at `at`, with no tools, and
// the model's reply (trimmed, unquoted) as the title. Faux model; temp roots only.
import { expect, it } from "vitest";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import { titleContext, titleThread } from "../src/title.ts";
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
	// No tools: pi-ai declares them as `toolsAdded` on system messages, and the title request is one user message of
	// plain text — no tool calls or results to replay either.
	expect(seen[0]!.messages.some((m) => ((m as { toolsAdded?: unknown[] }).toolsAdded?.length ?? 0) > 0)).toBe(false);
	const users = seen[0]!.messages.filter((m) => m.role === "user");
	expect(users).toHaveLength(1);
	expect(typeof users[0]!.content).toBe("string");
	// The context ends at `at`: the first message, then the title instruction — not the reply.
	expect(users[0]!.content).toContain("the login is broken");
	expect(users[0]!.content).not.toContain("pong");
}, 30_000);

it("the title context keeps text only, within T3's budget: the first user message, then the newest", () => {
	const long = (tag: string) => `${tag} ${"x".repeat(3_000)}`;
	const messages = [
		{ role: "user", content: "first question" },
		{ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", id: "1", name: "bash", arguments: {} }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: long(`m${i}`) }] })),
	];
	const text = titleContext(messages);
	expect(text.length).toBeLessThanOrEqual(8_000 + 100);
	expect(text).toContain("USER:\nfirst question");
	expect(text).toContain("m5 ");
	expect(text).not.toContain("m0 ");
	expect(text).not.toContain("private");
	expect(text).not.toContain("tool output");
	expect(text.startsWith("[Earlier content left out]")).toBe(true);
});
