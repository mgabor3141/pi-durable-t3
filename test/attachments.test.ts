// Two pure pieces of the attachment path, unit-tested: the model image gate (`selectImageBlocks`) and the projection
// reporting an entry's images. No host, storage, model, or network.
import { describe, expect, it } from "vitest";
import { selectImageBlocks } from "../src/t3/bridge.ts";
import type { AttachmentRecord } from "../src/t3/attachment-store.ts";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const IMAGE = { type: "image" as const, id: "a-00000000-0000-4000-8000-000000000000-png", name: "p.png", mimeType: "image/png", sizeBytes: 75 };
const read = (id: string): { data: string; mimeType: string } | null => (id === IMAGE.id ? { data: "AAAA", mimeType: "image/png" } : null);
const visionCatalog = [{ provider: "pi", modelId: "vision", input: ["text", "image"] }];
const textCatalog = [{ provider: "pi", modelId: "text", input: ["text"] }];

describe("selectImageBlocks (the model image gate)", () => {
	it("an image-input model receives the image blocks", () => {
		const blocks = selectImageBlocks(visionCatalog, { provider: "pi", modelId: "vision" }, [IMAGE], read);
		expect(blocks).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	});

	it("a text-only model, a null model, and a model absent from the catalog all get no blocks", () => {
		expect(selectImageBlocks(textCatalog, { provider: "pi", modelId: "text" }, [IMAGE], read)).toBeUndefined();
		expect(selectImageBlocks(visionCatalog, null, [IMAGE], read)).toBeUndefined();
		expect(selectImageBlocks(visionCatalog, { provider: "pi", modelId: "unknown" }, [IMAGE], read)).toBeUndefined();
	});

	it("no attachments, and an attachment whose bytes are missing, yield no blocks", () => {
		expect(selectImageBlocks(visionCatalog, { provider: "pi", modelId: "vision" }, [], read)).toBeUndefined();
		expect(selectImageBlocks(visionCatalog, { provider: "pi", modelId: "vision" }, undefined, read)).toBeUndefined();
		const ghost: AttachmentRecord = { ...IMAGE, id: "gone-00000000-0000-4000-8000-000000000000-png" };
		expect(selectImageBlocks(visionCatalog, { provider: "pi", modelId: "vision" }, [ghost], read)).toBeUndefined();
	});
});

describe("projection: the user message carries its entry's attachments", () => {
	const meta: ThreadMeta = { threadId: "t", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
	const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;
	const assistant = (id: number): EntryRecord => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 2 }] }) as unknown as EntryRecord;

	it("an app.user entry with attachment data projects them on the message and the turn item", () => {
		const entries = [
			{ id: 10, kind: "app.user", data: { messageId: "m1", attachments: [IMAGE] }, model: [{ role: "user", content: "look", timestamp: 1 }] } as unknown as EntryRecord,
			assistant(11),
		];
		const { projection } = projectThread(meta, view(entries), { rolledBack: [] });
		const message = projection.messages.find((m) => m.role === "user")!;
		expect(message.attachments).toEqual([IMAGE]);
		const item = projection.turnItems.find((i) => i.type === "user_message") as { attachments?: unknown };
		expect(item.attachments).toEqual([IMAGE]);
	});

	it("an entry with no attachments projects an empty list (unchanged shape for text-only turns)", () => {
		const entries = [
			{ id: 10, kind: "app.user", data: { messageId: "m1" }, model: [{ role: "user", content: "hi", timestamp: 1 }] } as unknown as EntryRecord,
			assistant(11),
		];
		const { projection } = projectThread(meta, view(entries), { rolledBack: [] });
		expect(projection.messages.find((m) => m.role === "user")!.attachments).toEqual([]);
	});
});
