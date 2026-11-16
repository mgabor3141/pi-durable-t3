// The context's size while no request has measured it: after a compaction, until the next request answers. T3's meter
// shows the newest usage report, and a compaction makes none (the summary's own request read the old context), so
// without this the meter keeps the size from before. An estimate: what stays in the context (the summary, the kept
// entries, whatever came since), counted from its length as pi counts, plus the part every request carries (the
// system prompt and the tools), taken from the request whose messages were smallest. Pure: entries in, a number out.
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "./model-types.ts";

/** What a request sent, as its provider counted it: 0 for one that failed before it was counted. */
export function sentTokens(usage: { input?: number; cacheRead?: number; cacheWrite?: number } | undefined): number {
	return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

const answered = (entry: EntryRecord) => (entry.model ?? []).findLast((message) => message.role === "assistant" && sentTokens((message as { usage?: object }).usage) > 0);

/**
 * The context's estimated size when the newest compaction has had no request after it; `undefined` when a request
 * has (its usage is the size) or nothing was compacted.
 */
export function sizeAfterCompaction(entries: readonly EntryRecord[]): number | undefined {
	const compacted = entries.findLastIndex((entry) => entry.kind === "pi.compaction");
	if (compacted < 0 || entries.slice(compacted + 1).some((entry) => answered(entry) !== undefined)) return undefined;
	// The entries in the context as the walk goes, with each one's estimate, and the request that had the least in
	// front of it: there the estimate is the smallest share of what was sent, so the rest is nearest the fixed part.
	let active: { id: EntryRecord["id"]; tokens: number }[] = [];
	let least: { messages: number; sent: number } | undefined;
	for (const entry of entries) {
		const tokens = (entry.model ?? []).reduce((sum, message) => sum + estimateMessageTokens(message as Message), 0);
		if (entry.kind === "pi.compaction") {
			const kept = entry.head === undefined ? -1 : active.findIndex((each) => each.id === entry.head);
			active = kept < 0 ? [] : active.slice(kept);
		} else {
			const request = answered(entry);
			if (request !== undefined) {
				const messages = active.reduce((sum, each) => sum + each.tokens, 0);
				if (least === undefined || messages < least.messages) least = { messages, sent: sentTokens((request as { usage?: object }).usage) };
			}
		}
		active.push({ id: entry.id, tokens });
	}
	const fixed = least === undefined ? 0 : Math.max(0, least.sent - least.messages);
	return Math.round(fixed + active.reduce((sum, each) => sum + each.tokens, 0));
}
