// The client's message id, on both ends of the seam that writes it (review tests F1).
//
// `Threads.submit` places the id in the user entry it creates (`entry: {kind: "app.user", data: {messageId}}`), and the
// projection reads it back from the entry it is already reading — that is the design: no side store, so an id cannot
// exist in one place and be read from another. The projection half was tested (hand-built entries in
// `projection-message-id.test.ts`); the writing half was tested only in the browser smoke, so deleting the writer line
// passed `pnpm test` and every message id silently fell back to `m<entryId>` — a stable-looking id that is not the
// client's, which is the class of bug the placement exists to kill.
//
// So the producer and the consumer are pinned in one test: submit places, the entries on disk carry, the projection
// reads the SAME id, with no `m<entryId>` fallback in sight.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

const seed = fauxAssistantMessage("seed reply");

const meta: ThreadMeta = { threadId: "t", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
const viewOf = (entries: readonly unknown[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

const userEntries = (entries: readonly EntryRecord[]): EntryRecord[] => entries.filter((entry) => entry.kind === "app.user");

describe("the message id the host writes", () => {
	it("submit places the client's id in the user entry, and the projection reads that same id (F1)", async () => {
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }], responses: [seed] });
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		const clientMessageId = "6f0f9c1e-2b3d-4c5a-9e7f-8a1b2c3d4e5f"; // what the web app generates for its optimistic message
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "hello there", messageId: clientMessageId }, undefined);
		await idle(harness, thread.head);

		const entries = (await (await conversation(harness, thread.head)).context(BACKGROUND_CONTEXT)).entries as unknown as EntryRecord[];
		const placed = userEntries(entries);
		expect(placed.length, "submit wrote an application user entry").toBe(1);
		expect((placed[0]!.data as { messageId: string }).messageId, "the entry carries the client's id").toBe(clientMessageId);
		// The entry is a user turn the projection recognizes (kind alone is not enough: it must carry a user message).
		expect((placed[0]!.model as readonly { role: string }[])[0]!.role).toBe("user");

		// The consumer, on the entries the producer wrote: the projected id is the client's, not the fallback.
		const result = projectThread(meta, viewOf(entries), { rolledBack: [] });
		expect(result.runs).toHaveLength(1);
		expect(result.projection.runs[0]!.userMessageId, "the projection read the id off the entry submit created").toBe(clientMessageId);
		expect(result.projection.runs[0]!.userMessageId).not.toMatch(/^m\d+$/);
	}, 60_000);

	it("a submit with no client id writes no data-carrying entry, and the projection falls back", async () => {
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }], responses: [seed] });
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "no id here" }, undefined);
		await idle(harness, thread.head);
		const entries = (await (await conversation(harness, thread.head)).context(BACKGROUND_CONTEXT)).entries as unknown as EntryRecord[];
		// No `app.user` entry was invented for a client that sent no id: the id is absent, not guessed.
		expect(userEntries(entries), "no application user entry is placed without a client id").toHaveLength(0);
		const result = projectThread(meta, viewOf(entries), { rolledBack: [] });
		expect(result.projection.runs).toHaveLength(1);
		expect(result.projection.runs[0]!.userMessageId).toMatch(/^m\d+$/);
	}, 60_000);

});
