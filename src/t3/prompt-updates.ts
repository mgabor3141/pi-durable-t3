// The system prompt's changes while a thread goes on, read from its entries for a row in the thread. Pure: entries
// in, the changes out.
import type { EntryRecord } from "./model-types.ts";

/** A section that is not what the model was last given: its text before and after (`undefined`: it was not there). */
export type SectionChange = { readonly key: string; readonly before: string | undefined; readonly after: string | undefined };
export type PromptUpdate = { readonly id: EntryRecord["id"]; readonly at: number | undefined; readonly sections: SectionChange[] };

/** Lines of a change shown, at most. */
const MAX_LINES = 40;

/**
 * The system prompt's changes while a thread went on, by the `pi.system` entry that completed each: the sections
 * whose text is not what the model had before. pi-durable writes such entries where the conversation is: a patch of
 * the sections that changed, every section taken out and written again when their order would differ, and the whole
 * prompt after a compaction; `/reload` takes every section out, and the next request writes them again. So a change
 * is read as the difference between one prompt in effect and the next, however it was written: a prompt rendered
 * again the same is none, and its first rendering is none.
 */
export function systemPromptUpdates(entries: readonly EntryRecord[]): PromptUpdate[] {
	const updates: PromptUpdate[] = [];
	const shown = new Map<string, string>();
	// The last prompt the model was given: no section shown is a prompt being written again, not one.
	let effective: Map<string, string> | undefined;
	for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
		// A compaction's first request writes the whole prompt, in place of every entry before.
		if (entry.kind === "pi.compaction") shown.clear();
		if (entry.kind !== "pi.system") continue;
		const sections = (entry.model?.[0] as { sections?: Record<string, string | null> } | undefined)?.sections;
		if (sections === undefined) continue;
		for (const [key, text] of Object.entries(sections)) {
			if (text === null) shown.delete(key);
			else shown.set(key, text);
		}
		if (shown.size === 0) continue;
		if (effective !== undefined) {
			const changes = [...new Set([...shown.keys(), ...effective.keys()])].flatMap((key): SectionChange[] => (shown.get(key) === effective!.get(key) ? [] : [{ key, before: effective!.get(key), after: shown.get(key) }]));
			if (changes.length > 0) updates.push({ id: entry.id, at: (entry.model?.[0] as { timestamp?: number } | undefined)?.timestamp, sections: changes });
		}
		effective = new Map(shown);
	}
	return updates;
}

/** An update in a line, for a host that has no words of its own for it: "System prompt updated: skills (removed)". */
export function updateTitle(update: PromptUpdate): string {
	return `System prompt updated: ${update.sections.map(({ key, before, after }) => `${key}${after === undefined ? " (removed)" : before === undefined ? " (added)" : ""}`).join(", ")}`;
}

/** What an update changed, for the row opened: each section's lines that are new (`+`) and gone (`-`). */
export function updateDetails(update: PromptUpdate): string {
	const lines = (text: string | undefined): string[] => (text ?? "").split("\n").filter((line) => line.trim() !== "");
	return update.sections
		.map(({ key, before, after }) => {
			const was = new Set(lines(before));
			const is = new Set(lines(after));
			const differ = [...lines(before).filter((line) => !is.has(line)).map((line) => `- ${line}`), ...lines(after).filter((line) => !was.has(line)).map((line) => `+ ${line}`)];
			const more = differ.length - MAX_LINES;
			return [`${key}:`, ...(differ.length === 0 ? ["  (only blank lines or the order of lines changed)"] : differ.slice(0, MAX_LINES)), ...(more > 0 ? [`  … ${more} more line${more === 1 ? "" : "s"}`] : [])].join("\n");
		})
		.join("\n\n");
}
