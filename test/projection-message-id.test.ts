// The projection reads the client's message id from the user entry it is already reading — the id now rides in the
// entry's `data` (placed by `Threads.submit`), so there is no side store to consult. These cases pin the mapping:
//   - an `app.user` entry that carries a `messageId` projects that exact id (the new placement);
//   - an entry with no usable id (no `data`, a `data` without a string `messageId`) falls back to `m<entryId>`;
//   - a `pi.user` entry from a thread created before the change is a run and projects (with the `m<entryId>` fallback).
// `projectThread` is pure: it maps a view + meta + memory, so this exercises the mapping with no host, storage, or model.
import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = {
	threadId: "t1",
	projectId: "p",
	title: "t",
	cwd: "/",
	createdAt: 0,
	updatedAt: 0,
	model: null,
	running: false,
};

const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

const userText = (content: string) => [{ role: "user" as const, content, timestamp: 1 }];
const assistant = (id: number, text: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 2 }] }) as unknown as EntryRecord;

const userItemMessageId = (projection: ReturnType<typeof projectThread>["projection"]): string | undefined =>
	(projection.turnItems.find((item) => item.type === "user_message") as { messageId?: string } | undefined)?.messageId;
const userMessageId = (projection: ReturnType<typeof projectThread>["projection"]): string | undefined =>
	(projection.messages.find((message) => message.role === "user") as { id?: string } | undefined)?.id;

describe("projection: the client's message id rides in the entry", () => {
	it("an app.user entry with a messageId projects exactly that id", () => {
		const entries: EntryRecord[] = [
			{ id: 10, kind: "app.user", data: { messageId: "uuid-abc" }, model: userText("hello") } as unknown as EntryRecord,
			assistant(11, "hi"),
		];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]!.userEntryId).toBe(10);
		expect(result.projection.runs[0]!.userMessageId).toBe("uuid-abc");
		expect(userItemMessageId(result.projection)).toBe("uuid-abc");
		expect(userMessageId(result.projection)).toBe("uuid-abc");
	});

	it("a pi.user entry from an older thread is a run and projects, with the m<entryId> fallback", () => {
		const entries: EntryRecord[] = [
			{ id: 3, kind: "pi.user", model: userText("legacy") } as unknown as EntryRecord,
			assistant(4, "old reply"),
		];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		// Grouped into a run at all (isUserEntry accepts pi.user), and the id is the deterministic fallback.
		expect(result.runs).toHaveLength(1);
		expect(result.runs[0]!.userEntryId).toBe(3);
		expect(result.projection.runs[0]!.userMessageId).toBe("m3");
		expect(userItemMessageId(result.projection)).toBe("m3");
	});
});
