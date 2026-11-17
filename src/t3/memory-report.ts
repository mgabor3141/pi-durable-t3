// What the host holds in memory, in numbers, for the log: how many threads are open and how large what each keeps
// is. Sizes only, never what anything says. Counted by walking strings' lengths, which reads nothing and costs little.
import type { EntryRecord } from "./model-types.ts";

/** The characters of what entries carry for the model: text (messages, thinking, tool calls and results) and image data. */
export function entryChars(entries: readonly EntryRecord[]): { text: number; images: number } {
	let text = 0;
	let images = 0;
	const count = (value: unknown, depth: number): void => {
		if (typeof value === "string") text += value.length;
		else if (Array.isArray(value)) for (const each of value) count(each, depth + 1);
		else if (typeof value === "object" && value !== null && depth < 8) {
			const block = value as { type?: unknown; data?: unknown };
			if (block.type === "image" && typeof block.data === "string") images += block.data.length;
			else for (const each of Object.values(value)) count(each, depth + 1);
		}
	};
	for (const entry of entries) count(entry.model, 0);
	return { text, images };
}

const MB = (chars: number): number => Math.round(chars / 1e5) / 10;

/** A thread view's part of the report (`ThreadView.memory`). */
export type ViewMemory = { threadId: string; holds: number; subscribers: number; entries: number; history: number; rolledBack: number; logEvents: number; text: number; images: number };

/** The report: the process's own numbers, and the largest open threads. */
export function memoryReport(views: readonly ViewMemory[], searchChars: number): Record<string, unknown> {
	const memory = process.memoryUsage();
	const open = views.filter((view) => view.entries + view.history > 0).sort((a, b) => b.text + b.images - (a.text + a.images));
	return {
		heapUsedMB: MB(memory.heapUsed),
		rssMB: MB(memory.rss),
		externalMB: MB(memory.external),
		views: views.length,
		open: open.length,
		openTextMB: MB(open.reduce((sum, view) => sum + view.text, 0)),
		openImagesMB: MB(open.reduce((sum, view) => sum + view.images, 0)),
		searchCacheMB: MB(searchChars),
		largest: open.slice(0, 8).map((view) => ({ ...view, text: undefined, images: undefined, textMB: MB(view.text), imagesMB: MB(view.images) })),
	};
}
