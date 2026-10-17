// The model receives the image, and the entry records it. Drives the real Threads layer with the scripted faux model
// and inspects the messages the model actually sees (a faux step captures `context.messages`). Temp roots only.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createScriptedModel } from "./fake-model.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAEA//8DAAAGAAVXv6vUAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const RECORD = { id: "thread-a-00000000-0000-4000-8000-000000000000-png", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength };

it("a prompt with an image sends the model a user message carrying an image content block", async () => {
	const captured: { role: string; content: unknown }[][] = [];
	const step: FauxResponseStep = async (context) => {
		captured.push(context.messages as unknown as { role: string; content: unknown }[]);
		return fauxAssistantMessage("ok");
	};
	const f = await makeThreads({ projects: [{ id: "p" }], responses: Array.from({ length: 4 }, () => step) });
	const create = createNamed(f.threads, f.harness, f.model);
	const thread = await create({ threadId: "a", projectId: "p" });

	await f.threads.submit(
		{ threadId: "a", conversationId: thread.head, requestId: "r1", message: "what is in this picture?", messageId: "m1", blocks: [{ type: "image", data: PNG_B64, mimeType: "image/png" }], attachments: [RECORD] },
		undefined,
	);
	await idle(f.harness, thread.head);

	// The model's request carried the user turn as a content array with an image block (not a bare string).
	const request = captured[0];
	expect(request, "the faux model was called").toBeDefined();
	const user = request!.find((m) => m.role === "user");
	expect(user, "a user message reached the model").toBeDefined();
	expect(Array.isArray(user!.content), "the user content is a block array").toBe(true);
	const blocks = user!.content as Record<string, unknown>[];
	const image = blocks.find((b) => b.type === "image");
	expect(image, "the user message carries an image block").toBeDefined();
	expect(image!.mimeType).toBe("image/png");
	expect(image!.data).toBe(PNG_B64);
	expect(blocks.some((b) => b.type === "text" && b.text === "what is in this picture?")).toBe(true);

	// The entry records the attachment (the projection reads it back after a restart).
	const entries = await conversation(f.harness, thread.head).then((c) => c.context(BACKGROUND_CONTEXT));
	const userEntry = entries.entries.find((entry) => (entry.data as { messageId?: string } | undefined)?.messageId === "m1");
	expect(userEntry, "the user entry carries the client's message id").toBeDefined();
	expect((userEntry!.data as { attachments: unknown[] }).attachments).toEqual([RECORD]);
});

it("a text-only model: submit with no blocks keeps a plain string content (the gate is the Bridge's)", async () => {
	const captured: { role: string; content: unknown }[][] = [];
	const step: FauxResponseStep = async (context) => {
		captured.push(context.messages as unknown as { role: string; content: unknown }[]);
		return fauxAssistantMessage("ok");
	};
	const f = await makeThreads({ projects: [{ id: "p" }], responses: Array.from({ length: 4 }, () => step) });
	const create = createNamed(f.threads, f.harness, f.model);
	const thread = await create({ threadId: "a", projectId: "p" });
	// No `blocks` (the Bridge omitted them for a text-only model): the content stays a string.
	await f.threads.submit({ threadId: "a", conversationId: thread.head, requestId: "r1", message: "hello", messageId: "m1", attachments: [RECORD] }, undefined);
	await idle(f.harness, thread.head);
	const user = captured[0]!.find((m) => m.role === "user");
	expect(typeof user!.content, "text-only content is a plain string").toBe("string");
	expect(user!.content).toBe("hello");
});


