// T3's thread search (`orchestration.searchThreads`), replicated from `apps/server/src/orchestration-v2/ThreadSearch.ts`
// (`search`) and `messageSearchIndex.ts` at v0.1.11, with T3's own matcher and ranking (`@t3tools/shared/paletteSearch`,
// vendored). T3 answers from a SQLite trigram index of every message; this host answers from the same rules over the
// threads layer's conversations (design.md, replication rule): a pure function over the candidate messages, so a test
// drives the semantics directly.
//
// What T3 does:
//   searched  — every committed user/assistant message of a thread the sidebar lists (not archived, not a subagent, not
//               a side chat), but not a user-role message an agent wrote (a `thread_prompt`, a child's report) and not
//               the web app's attachment-only placeholder. The text as it reads: an assistant quote as its words, a file
//               mention's escaped label unescaped, a link as its label.
//   matched   — word by word (`messageMatcher`): every word of the query must be in the message, ignoring case and
//               accents, and one shorter than four characters must start a word ("fts" is not in "drafts"). A query
//               with no word of three characters (two for CJK) matches nothing. Graded 1 for whole words, 0.8 when a
//               word only starts one, 0.3 when one is inside a word, plus 0.25 when the words are written together as
//               typed, else 0.1 when they are near. Only the newest 2000 matches count.
//   best      — per thread, the best-graded message, then a user's, then the newest; `hits` counts the thread's matches
//               at that grade.
//   ranked    — as T3's clients rank message matches (`rankMessageMatches`): whole-word and word-start matches first,
//               then a palette pick of the thread for this query, the grade, the hits weighed with the thread's recent
//               use, the newest message.
//   snippet   — up to 240 characters from a few words before the match (`buildSearchSnippet`, T3's).

import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import { foldSearchQuery, messageMatcher, messageSearchTokens, rankMessageMatches } from "@t3tools/shared/paletteSearch";
import type { ThreadOpens } from "../thread-records.ts";
import type { ContentBlock, EntryRecord } from "./model-types.ts";
import { authorOf, firstMessage, isAssistantEntry, isUserEntry, messageIdOf } from "./runs.ts";

type ThreadSearchSource = "user" | "assistant";

/** One user/assistant message, as a candidate for search. */
export interface SearchCandidate {
	readonly threadId: string;
	readonly projectId: string;
	readonly source: ThreadSearchSource;
	/** The message as it reads (`searchText`). */
	readonly text: string;
	/** The message's creation time in ms, or null when it carries none (T3's `message_created_at` is nullable). */
	readonly messageCreatedAt: number | null;
	/** pi's entry id: with the time, the order messages were written in (T3 reads hits by row id, newest first). */
	readonly entryId: number;
	/** The id the thread's projection gives the message, where it is the entry's own: a user's message. An answer's
	 * id depends on its run (`m<user entry>.<n>`), which a candidate does not know, and the contract lets it be absent. */
	readonly messageId?: string;
}

/** What T3's ranking knows of a thread besides its matches: when a person last wrote in it, and how it was opened. */
export interface SearchSubject {
	readonly activityAt: number | null;
	readonly opens: ThreadOpens | null;
}

/** One search result, in T3's `OrchestrationThreadSearchMatch` shape (times in ms, not ISO). */
export interface ThreadSearchMatch {
	readonly threadId: string;
	readonly projectId: string;
	readonly source: ThreadSearchSource;
	readonly snippet: string;
	readonly messageCreatedAt: number | null;
	readonly quality: number;
	readonly hits: number;
	readonly messageId?: string;
}

/** The text of message content, as T3 stores a message's `$.text`: concatenated text blocks (a string content, as a
 * user message may carry, passes through). Shared with the projection, so a run's shown text and its searchable text agree. */
export const textOf = (content: string | ContentBlock[] | undefined): string =>
	typeof content === "string"
		? content
		: (content ?? []).flatMap((block) => (block.type === "text" && block.hidden !== true ? [block.text] : [])).join("");

// T3's `readableSearchText` (messageSearchIndex.ts): a file mention stores `__init__.py` as `[\_\_init\_\_.py](...)`,
// and search finds the name as typed.
const LINK_LABEL = /(!?\[)([^\]\n]*)(\]\([^)\s]*\))/g;
// T3's `MARKDOWN_LINK` (ThreadSearch.ts): a thread shows a link as its text, so a match in the address is not one.
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;

/** A message's text as search reads it: an assistant quote as its words, a link as its unescaped label. */
const searchText = (text: string): string =>
	assistantCitationsToPlainText(text)
		.replace(LINK_LABEL, (_link, open: string, label: string, close: string) => open + label.replace(/\\([*_])/g, "$1") + close)
		.replace(MARKDOWN_LINK, "$1");

/** A searchable candidate from an entry, or `undefined` when T3 would not index it: not a user/assistant message, a
 * user-role message an agent wrote, or the attachment-only placeholder. The committed entries a scan reads carry no
 * streaming partial. */
export function searchCandidate(entry: EntryRecord, threadId: string, projectId: string): SearchCandidate | undefined {
	const message = firstMessage(entry);
	if (message === undefined) return undefined;
	const candidate = (source: ThreadSearchSource, content: string | ContentBlock[] | undefined, messageId?: string): SearchCandidate | undefined => {
		const text = textOf(content);
		if (isAttachmentOnlyBootstrapPrompt(text)) return undefined;
		return { threadId, projectId, source, text: searchText(text), messageCreatedAt: message.timestamp ?? null, entryId: entry.id, ...(messageId === undefined ? {} : { messageId }) };
	};
	if (isUserEntry(entry) && message.role === "user") {
		return authorOf(entry.data).createdBy === "user" ? candidate("user", message.content, messageIdOf(entry) ?? `m${entry.id}`) : undefined;
	}
	if (isAssistantEntry(entry) && message.role === "assistant") return candidate("assistant", message.content);
	return undefined;
}

// T3's `MESSAGE_HIT_LIMIT`: the newest hits read per query.
const MESSAGE_HIT_LIMIT = 2000;
const SNIPPET_LENGTH = 240;
// Result rows show one line, so the match must sit near the start to be seen.
const SNIPPET_LEAD = 24;

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** T3's `buildSearchSnippet`, as it is: up to 240 characters starting a few words before the match at `matchStart`,
 * whitespace collapsed, emphasis and code marks dropped, with ellipses where the text was cut. */
export function buildSearchSnippet(text: string, matchStart: number): string {
	let start = Math.max(0, matchStart - SNIPPET_LEAD);
	const wordStart = text.slice(start, matchStart).search(/\s/);
	if (start > 0 && wordStart !== -1) start += wordStart + 1;
	// Cut between characters, not inside an emoji's surrogate pair.
	if (isLowSurrogate(text.charCodeAt(start))) start++;
	// Collapsing whitespace shortens the text, so read more of it.
	const rawEnd = Math.min(text.length, start + SNIPPET_LENGTH * 2);
	const shown = text
		.slice(start, rawEnd)
		.replace(/\*\*|`+/g, "")
		.replace(/\s+/g, " ")
		.trim();
	let end = Math.min(shown.length, SNIPPET_LENGTH - 2);
	if (isLowSurrogate(shown.charCodeAt(end))) end--;
	const cut = end < shown.length || rawEnd < text.length;
	return `${start > 0 ? "…" : ""}${shown.slice(0, end)}${cut ? "…" : ""}`;
}

/** ISO time, as T3 compares message times (a missing one sorts oldest). */
const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());

/**
 * Search `candidates` for `query` and return at most `limit` matches in T3's order. `subjects` holds each thread's
 * recent use for the ranking (a thread missing from it ranks as one never used); `now` is the clock T3 ranks by.
 */
export function searchThreads(candidates: readonly SearchCandidate[], subjects: ReadonlyMap<string, SearchSubject>, query: string, limit: number, now: number): ThreadSearchMatch[] {
	if (messageSearchTokens(query).long.length === 0) return [];
	type Hit = { readonly row: SearchCandidate; readonly quality: number; readonly offset: number };
	const matchMessage = messageMatcher(query);
	// The newest hits, newest first, as T3 reads them from its index.
	const rows = candidates
		.flatMap((row): Hit[] => {
			const match = matchMessage(row.text);
			return match === null ? [] : [{ row, ...match }];
		})
		.sort((left, right) => (right.row.messageCreatedAt ?? -Infinity) - (left.row.messageCreatedAt ?? -Infinity) || right.row.entryId - left.row.entryId)
		.slice(0, MESSAGE_HIT_LIMIT);
	// One message per thread: the best word match, then what the user wrote, then the newest.
	const newer = (left: Hit, right: Hit) => (iso(right.row.messageCreatedAt) ?? "").localeCompare(iso(left.row.messageCreatedAt) ?? "");
	const compareHits = (left: Hit, right: Hit) => right.quality - left.quality || Number(left.row.source !== "user") - Number(right.row.source !== "user") || newer(left, right);
	const best = new Map<string, Hit>();
	// Matching messages per thread at its best quality: a thread that keeps using the word ranks above a passing mention.
	const hitCounts = new Map<string, number>();
	const hitCount = (threadId: string) => hitCounts.get(threadId) ?? 1;
	for (const hit of rows) {
		const threadId = hit.row.threadId;
		const current = best.get(threadId);
		if (current === undefined || hit.quality > current.quality) hitCounts.set(threadId, 1);
		else if (hit.quality === current.quality) hitCounts.set(threadId, hitCount(threadId) + 1);
		if (current === undefined || compareHits(hit, current) < 0) best.set(threadId, hit);
	}
	const ranked = rankMessageMatches(
		[...best.values()].map((hit) => ({ ...hit, hits: hitCount(hit.row.threadId), messageCreatedAt: iso(hit.row.messageCreatedAt) })),
		(hit) => {
			const subject = subjects.get(hit.row.threadId);
			return { title: "", activityAt: subject?.activityAt ?? null, opens: subject?.opens ?? null };
		},
		foldSearchQuery(query),
		now,
		{ picks: true },
	);
	return ranked.slice(0, limit).map(({ row, quality, offset, hits }) => ({
		threadId: row.threadId,
		projectId: row.projectId,
		source: row.source,
		snippet: buildSearchSnippet(row.text, offset),
		messageCreatedAt: row.messageCreatedAt,
		quality,
		hits,
		...(row.messageId === undefined ? {} : { messageId: row.messageId }),
	}));
}
