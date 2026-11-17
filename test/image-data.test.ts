// An open thread keeps its transcript in memory without image data (`image-data.ts`): a long thread of screenshots held
// hundreds of megabytes while open. Its rows still show every image, read from the store when a client asks for it,
// and the transcript is whole however long the thread, though pi-durable's live window holds only its newest entries.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import { imageDataOf, withoutImageData } from "../src/t3/image-data.ts";
import type { EntryRecord } from "../src/t3/model-types.ts";
import { object } from "../src/t3/schema.ts";
import { bridgeConfig, createNamed, idle, makeThreads, quietLog } from "./threads-harness.ts";

/** A one-pixel PNG, made distinct per call, and large, by what follows it. */
const shot = (n: number) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), Buffer.from(`shot ${n} ${"x".repeat(200_000)}`)]).toString("base64");

it("an entry's image blocks are left in the store, each saying where its data is; the entry without one is itself", () => {
	const plain = { id: 4, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] } as unknown as EntryRecord;
	expect(withoutImageData(plain)).toBe(plain);
	const stored = { id: 7, kind: "pi.tool-result", model: [{ role: "toolResult", content: [{ type: "text", text: "shot taken" }, { type: "image", data: "QUJD", mimeType: "image/png" }] }] } as unknown as EntryRecord;
	const kept = withoutImageData(stored);
	expect((kept.model as unknown as { content: unknown[] }[])[0]!.content).toEqual([{ type: "text", text: "shot taken" }, { type: "image", mimeType: "image/png", omitted: { entryId: 7, message: 0, block: 1, length: 4 } }]);
	expect(imageDataOf(stored, { entryId: 7, message: 0, block: 1, length: 4 })).toBe("QUJD");
	expect(JSON.stringify(stored), "the stored entry is not changed").toContain("QUJD");
});

it("an open thread holds no image data, shows every image from the store, and keeps its whole transcript past the live window", { timeout: 120_000 }, async () => {
	let taken = 0;
	const shots = defineExtension({
		name: "shots",
		tools: [defineTool({ name: "shot", description: "a screenshot", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "shot taken" }, { type: "image" as const, data: shot(++taken), mimeType: "image/png" }] }) })],
	});
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [shots] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-image-data-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	await bridge.loaded();
	const release = bridge.acquire("t");
	onTestFinished(release);

	// Three screenshots, then more turns than the live window holds (40 entries).
	f.model.respond(...[1, 2, 3].map((n) => fauxAssistantMessage([fauxToolCall("shot", {}, { id: `call-${n}` })], { stopReason: "toolUse" })), fauxAssistantMessage("saw three"));
	await bridge.sendMessage({ threadId: "t", commandId: "c0", messageId: "m0", text: "take three", mode: "start" });
	await idle(f.harness, thread.head);
	for (let n = 1; n <= 25; n++) {
		f.model.respond(fauxAssistantMessage(`answer ${n}`));
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text: `question ${n}`, mode: "start" });
		await idle(f.harness, thread.head);
	}

	const { projection, toolImages } = await bridge.projection("t");
	expect(projection.messages.filter((message) => message.role === "user")).toHaveLength(26);
	expect(projection.messages.some((message) => message.text === "take three"), "the first turn is still shown").toBe(true);
	const rows = [...toolImages.keys()];
	expect(rows).toHaveLength(3);
	for (const [index, row] of rows.entries()) expect(await bridge.toolOutputImage("t", row, 0)).toEqual({ data: shot(index + 1), mimeType: "image/png" });
	expect(await bridge.toolOutputImage("t", rows[0]!, 1)).toBeNull();

	const report = bridge.memory() as { openImagesMB: number; largest: { threadId: string; imagesMB: number; entries: number }[] };
	expect(report.openImagesMB).toBe(0);
	expect(report.largest[0]!.entries).toBeGreaterThan(40);
});
