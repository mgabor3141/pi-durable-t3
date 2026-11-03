// A fork is a new thread whose head is a fork of the source at a run's last entry, carrying its parent. The target id
// is the client's, so a retried command returns the same thread instead of a second fork.
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

it("forks a run into a new thread with a parent link, idempotently", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { threads, harness, model } = f;
	const create = createNamed(threads, harness, model);
	const source = await create({ threadId: "source", projectId: "p", title: "Source" });
	model.respond(fauxAssistantMessage("answer"));
	await threads.submit({ threadId: "source", conversationId: source.head, requestId: "s1", message: "question" }, undefined);
	await idle(harness, source.head);
	const entries = (await (await conversation(harness, source.head)).context(BACKGROUND_CONTEXT)).entries;
	const answer = entries.at(-1)!;
	expect(entries.some((entry) => entry.kind === UserEntry.kind), "the source has its user turn").toBe(true);

	const forked = await threads.fork({ sourceThreadId: "source", targetThreadId: "fork", entryId: answer.id, title: "Source fork" });
	expect(forked.threadId).toBe("fork");
	expect(forked.parent?.threadId).toBe("source");
	expect(forked.head, "the fork has its own head conversation").not.toBe(source.head);
	expect((await threads.thread("source"))?.head, "the source is unchanged").toBe(source.head);

	const forkEntries = (await (await conversation(harness, forked.head)).context(BACKGROUND_CONTEXT)).entries;
	expect(forkEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));

	const again = await threads.fork({ sourceThreadId: "source", targetThreadId: "fork", entryId: answer.id, title: "Source fork" });
	expect(again.head, "a retried fork returns the first one").toBe(forked.head);
	expect((await threads.list()).filter((thread) => thread.threadId === "fork"), "one row").toHaveLength(1);
}, 30_000);
