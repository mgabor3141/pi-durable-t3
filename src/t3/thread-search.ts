// T3's thread search, replicated from `apps/server/src/orchestration-v2/ThreadSearch.ts` at the pin — the matching,
// per-thread best-match ranking, global ordering, and snippet builder, and no more. T3 answers `orchestration.searchThreads`
// from a SQLite scan of every message; this host answers it from the same rules over the threads layer's conversations
// (design.md, replication rule): a pure function over the candidate messages, so a test drives the semantics directly.
//
// What T3 does, in one pass:
//   candidate  — every user/assistant message whose text matches the query (case-insensitive ASCII substring; SQLite
//                LIKE with `!` escape). No streaming message is a candidate.
//   ranked     — per thread, the ONE best message: user before assistant, then newest, then lowest message id.
//   global     — threads whose best is a user message first, then most-recently-updated thread, then thread id; limit.
//   snippet    — the matched message's text, whitespace-collapsed and, when long, windowed around the match (T3's
//                `buildSearchSnippet`, byte-for-byte).

import type { ContentBlock, DurableMessage, EntryRecord } from "./model-types.ts";
import { firstMessage, isAssistantEntry, isUserEntry } from "./runs.ts";

export type ThreadSearchSource = "user" | "assistant";

/** One user/assistant message, as a candidate for search. `text` is the message's text; `messageId` breaks ties. */
export interface SearchCandidate {
	readonly threadId: string;
	readonly projectId: string;
	readonly source: ThreadSearchSource;
	readonly text: string;
	/** The message's creation time in ms, or null when it carries none (T3's `message_created_at` is nullable). */
	readonly messageCreatedAt: number | null;
	/** The message's id (pi's entry id), the ROW_NUMBER's final tiebreaker. */
	readonly messageId: number;
}

/** One search result: the thread's best match, in T3's `OrchestrationThreadSearchMatch` shape (ms, not ISO). */
export interface ThreadSearchMatch {
	readonly threadId: string;
	readonly projectId: string;
	readonly source: ThreadSearchSource;
	readonly snippet: string;
	readonly messageCreatedAt: number | null;
}

/** The text of message content, as T3 stores a message's `$.text`: concatenated text blocks (a string content, as a
 * user message may carry, passes through). Shared with the projection, so a run's shown text and its searchable text agree. */
export const textOf = (content: string | ContentBlock[] | undefined): string =>
	typeof content === "string"
		? content
		: (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");

/** A searchable candidate from an entry, or `undefined` when the entry is not a user/assistant message (T3 searches only
 * `role IN ('user','assistant')`, and never a streaming message — the committed entries a scan reads carry no live partial). */
export function searchCandidate(entry: EntryRecord, threadId: string, projectId: string): SearchCandidate | undefined {
	const message = firstMessage(entry);
	if (message === undefined) return undefined;
	if (isUserEntry(entry)) {
		return message.role === "user" ? { threadId, projectId, source: "user", text: textOf(message.content), messageCreatedAt: message.timestamp ?? null, messageId: entry.id } : undefined;
	}
	if (isAssistantEntry(entry)) {
		return message.role === "assistant" ? { threadId, projectId, source: "assistant", text: textOf(message.content), messageCreatedAt: message.timestamp ?? null, messageId: entry.id } : undefined;
	}
	return undefined;
}

/** T3's `foldAsciiCase`: lower-case ASCII letters only, leaving every other code point as it is. */
export function foldAsciiCase(value: string): string {
	return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** T3's `buildSearchSnippet`, verbatim: collapse whitespace; if short, the whole text; else a 236-char window centred
 * on the match, with the ellipses T3 adds. */
export function buildSearchSnippet(text: string, query: string): string {
	const normalizedText = text.replace(/\s+/g, " ").trim();
	if (normalizedText.length <= 240) {
		return normalizedText;
	}
	const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
	const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
	const bodyLength = 236;
	const idealStart = Math.max(0, matchIndex - 72);
	const start = Math.min(idealStart, normalizedText.length - bodyLength);
	const end = Math.min(normalizedText.length, start + bodyLength);
	return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${end < normalizedText.length ? "…" : ""}`;
}

/** Whether a message text matches the query: an ASCII-case-insensitive substring, matching SQLite's `LIKE %…% ESCAPE '!'`
 * (which folds ASCII letters only, and treats `%`/`_` in the query as literals). */
function matches(text: string, foldedQuery: string): boolean {
	return foldAsciiCase(text).includes(foldedQuery);
}

/** The per-thread best message wins on (source: user first, then newest, then lowest id), mirroring the ROW_NUMBER's
 * ORDER BY. A null `messageCreatedAt` sorts as the oldest (SQLite DESC puts NULL last). */
function beats(candidate: SearchCandidate, current: SearchCandidate): boolean {
	const rank = (source: ThreadSearchSource) => (source === "user" ? 0 : 1);
	const cr = rank(candidate.source);
	const cur = rank(current.source);
	if (cr !== cur) return cr < cur;
	const at = (message: SearchCandidate) => (message.messageCreatedAt === null ? -Infinity : message.messageCreatedAt);
	const ca = at(candidate);
	const ua = at(current);
	if (ca !== ua) return ca > ua;
	return candidate.messageId < current.messageId;
}

/**
 * Search `candidates` for `query` and return at most `limit` matches in T3's order. `threadUpdatedAt` is each thread's
 * last-activity time (ms) — T3's `threads.updated_at` — used for the global order's recency; a missing entry is 0.
 */
export function searchThreads(
	candidates: readonly SearchCandidate[],
	threadUpdatedAt: ReadonlyMap<string, number>,
	query: string,
	limit: number,
): ThreadSearchMatch[] {
	// T3's LIKE pattern uses the query verbatim (only its `%`/`_`/`!` escaped), matched case-insensitively for ASCII — no
	// whitespace folding. The snippet folds the query's whitespace to LOCATE the match; the match itself is a raw substring.
	const foldedQuery = foldAsciiCase(query);
	// Per thread, keep the one best matching message (T3's `thread_match_rank = 1`).
	const best = new Map<string, SearchCandidate>();
	for (const candidate of candidates) {
		if (!matches(candidate.text, foldedQuery)) continue;
		const current = best.get(candidate.threadId);
		if (current === undefined || beats(candidate, current)) best.set(candidate.threadId, candidate);
	}
	// Global order: a thread whose best is a user message first, then most-recently-updated, then thread id (T3's ORDER BY).
	const rank = (source: ThreadSearchSource) => (source === "user" ? 0 : 1);
	const ordered = [...best.values()].sort((a, b) => {
		const bySource = rank(a.source) - rank(b.source);
		if (bySource !== 0) return bySource;
		const byUpdated = (threadUpdatedAt.get(b.threadId) ?? 0) - (threadUpdatedAt.get(a.threadId) ?? 0);
		if (byUpdated !== 0) return byUpdated;
		return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0;
	});
	return ordered.slice(0, limit).map((match) => ({
		threadId: match.threadId,
		projectId: match.projectId,
		source: match.source,
		snippet: buildSearchSnippet(match.text, query),
		messageCreatedAt: match.messageCreatedAt,
	}));
}
