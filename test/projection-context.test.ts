// T3's composer records make the inline image/file references in a user message resolvable. Entries sent before
// the bridge stored them only kept the attachment list, so the projection rebuilds the image/file records from the
// text references; without this the mobile client labels them "(unavailable)".
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

const user = (id: number, text: string, data: Record<string, unknown>): EntryRecord =>
	({ id, kind: "app.user", data, model: [{ role: "user", content: text, timestamp: 10 }] }) as unknown as EntryRecord;

const attachment = { type: "image" as const, id: "thread-1-message-1-a4e93def-png", name: "pasted-image.png", mimeType: "image/png", sizeBytes: 12 };

describe("projection: composer context", () => {
	it("returns the stored image context with the message", () => {
		const context = {
			version: 1 as const,
			records: [{ version: 1 as const, contextId: "a4e93def", kind: "image" as const, label: "pasted-image.png", attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes }],
		};
		const entries = [user(1, "![pasted-image.png](t3-context://v1/image/a4e93def) look", { messageId: "m1", attachments: [attachment], context })];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.messages[0]!.context).toEqual(context);
		expect((result.projection.turnItems[0] as { context?: unknown }).context).toEqual(context);
	});

	it("rebuilds image and file context for entries that only stored attachments", () => {
		const file = { type: "file" as const, id: "thread-1-message-2-spec-pdf", name: "spec.pdf", mimeType: "application/pdf", sizeBytes: 99 };
		const entries = [user(1, "![pasted-image.png](t3-context://v1/image/a4e93def) and [spec.pdf](t3-context://v1/file/7c2b1a9d)", { messageId: "m2", attachments: [attachment, file] })];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.messages[0]!.context?.records).toEqual([
			{ version: 1, contextId: "a4e93def", kind: "image", label: "pasted-image.png", attachmentId: attachment.id, name: attachment.name, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes },
			{ version: 1, contextId: "7c2b1a9d", kind: "file", label: "spec.pdf", attachmentId: file.id, name: file.name, mimeType: file.mimeType, sizeBytes: file.sizeBytes },
		]);
	});

	it("leaves a plain message without context", () => {
		const entries = [user(1, "hello", { messageId: "m3" })];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.messages[0]!.context).toBeUndefined();
	});
});
