// The memory log: how large what the host keeps is, in numbers and never in words.
import { expect, it } from "vitest";
import type { EntryRecord } from "../src/t3/model-types.ts";
import { entryChars, memoryReport } from "../src/t3/memory-report.ts";

it("counts what entries carry, text and image data apart, and reports the largest open threads without their content", () => {
	const entries = [
		{ id: 1, kind: "pi.user", model: [{ role: "user", content: "hello" }] },
		{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "four" }, { type: "toolCall", id: "c", name: "read", arguments: { path: "/a" } }] }] },
		{ id: 3, kind: "pi.tool-result", model: [{ role: "toolResult", content: [{ type: "image", data: "x".repeat(1000), mimeType: "image/png" }, { type: "text", text: "ok" }] }] },
	] as unknown as EntryRecord[];
	const chars = entryChars(entries);
	expect(chars.images).toBe(1000);
	// Every string of the messages but the image's data: what is said, and the words of the structure around it.
	expect(chars.text).toBeGreaterThan("hellofourok".length);
	expect(chars.text).toBeLessThan(200);

	const view = (threadId: string, text: number, images: number, entries: number) => ({ threadId, holds: 1, subscribers: 0, entries, history: 0, rolledBack: 0, logEvents: 0, text, images });
	const report = memoryReport([view("small", 1e6, 0, 10), view("closed", 0, 0, 0), view("big", 2e6, 30e6, 400)], 5e6) as { views: number; open: number; openTextMB: number; openImagesMB: number; searchCacheMB: number; largest: { threadId: string; imagesMB: number }[] };
	expect(report).toMatchObject({ views: 3, open: 2, openTextMB: 3, openImagesMB: 30, searchCacheMB: 5 });
	expect(report.largest.map((each) => [each.threadId, each.imagesMB])).toEqual([["big", 30], ["small", 0]]);
});
