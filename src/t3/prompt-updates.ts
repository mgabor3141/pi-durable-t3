// The system prompt's changes while a thread goes on, read from its entries for T3's notice row. Pure: entries in,
// the changes out.
import type { EntryRecord } from "./model-types.ts";

/**
 * The system prompt sections that changed while a thread went on, by the `pi.system` entry that changed them: a
 * section given a text other than the one it had, or taken out. pi-durable writes such an entry where the
 * conversation is when a section's rendering changes (an AGENTS.md that was edited, for a host that lets its prompt
 * follow). Not counted: the prompt's first rendering, a compaction's baseline, and a section taken out and given
 * back the same (pi-durable's way of restoring the sections' order, and `/reload`'s of rendering again).
 */
export function systemPromptUpdates(entries: readonly EntryRecord[]): { id: EntryRecord["id"]; at: number | undefined; sections: string[] }[] {
	const updates: { id: EntryRecord["id"]; at: number | undefined; sections: string[] }[] = [];
	// What each section last said, kept over its removal: given back the same, it has not changed.
	const said = new Map<string, string>();
	const shown = new Set<string>();
	let rendered = false;
	let cleared: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "pi.compaction") {
			rendered = false;
			continue;
		}
		if (entry.kind !== "pi.system") continue;
		const sections = (entry.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections;
		if (sections === undefined) continue;
		const changed: string[] = [];
		const removed: string[] = [];
		for (const [key, text] of Object.entries(sections)) {
			if (text === null) {
				if (shown.delete(key)) removed.push(key);
				continue;
			}
			if (rendered && said.get(key) !== text) changed.push(key);
			said.set(key, text);
			shown.add(key);
		}
		// Every section taken out is a rendering about to be written again: what it leaves out is named when it is.
		// Some taken out are gone.
		const gone = [...cleared.filter((key) => !shown.has(key)), ...(shown.size === 0 ? [] : removed)];
		cleared = shown.size === 0 ? removed : [];
		if (rendered && (changed.length > 0 || gone.length > 0)) {
			updates.push({ id: entry.id, at: (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp, sections: [...changed, ...gone.map((key) => `${key} (removed)`)] });
		}
		if (shown.size > 0) rendered = true;
	}
	return updates;
}
