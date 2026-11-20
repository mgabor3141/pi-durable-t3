// The pure replication of T3 0.1.11's thread search (`src/t3/thread-search.ts`, from
// `apps/server/src/orchestration-v2/ThreadSearch.ts` and `@t3tools/shared/paletteSearch`): which messages are searched,
// the word-by-word match with its grades, the per-thread best message and hit count, the clients' ranking, the snippet,
// and the limit. A test over candidates drives the rules directly, without a Harness.
import { describe, expect, it } from "vitest";
import type { EntryRecord } from "../src/t3/model-types.ts";
import { buildSearchSnippet, searchCandidate, searchThreads, type SearchCandidate, type SearchSubject } from "../src/t3/thread-search.ts";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const c = (over: Partial<SearchCandidate> & Pick<SearchCandidate, "threadId" | "text">): SearchCandidate => ({
	projectId: "p",
	source: "user",
	messageCreatedAt: NOW - DAY,
	entryId: ++seq,
	...over,
});
const none = new Map<string, SearchSubject>();
const search = (candidates: readonly SearchCandidate[], query: string, subjects: ReadonlyMap<string, SearchSubject> = none, limit = 50) => searchThreads(candidates, subjects, query, limit, NOW);
const ids = (candidates: readonly SearchCandidate[], query: string) => search(candidates, query).map((match) => match.threadId);

describe("matching, word by word as T3 matches", () => {
	it("finds every word of the query anywhere in the message, in any order and case", () => {
		const candidates = [c({ threadId: "a", text: "The Sidebar needs a fix" }), c({ threadId: "b", text: "fix the navbar" })];
		expect(ids(candidates, "fix sidebar")).toEqual(["a"]);
		expect(ids(candidates, "SIDEBAR   fix")).toEqual(["a"]);
		expect(ids(candidates, "fix")).toEqual(expect.arrayContaining(["a", "b"]));
	});

	it("ignores accents either way", () => {
		const candidates = [c({ threadId: "a", text: "Le café est fermé" })];
		expect(ids(candidates, "cafe ferme")).toEqual(["a"]);
		expect(ids([c({ threadId: "b", text: "meet at the cafe" })], "Café")).toEqual(["b"]);
	});

	it("a word shorter than four characters must start a word, and a query of only short words matches nothing", () => {
		expect(ids([c({ threadId: "a", text: "the drafts folder" })], "fts")).toEqual([]);
		expect(ids([c({ threadId: "a", text: "the fts index" })], "fts")).toEqual(["a"]);
		expect(ids([c({ threadId: "a", text: "it is a test" })], "is a")).toEqual([]);
	});

	it("reads a link as its text, and a file mention's label as typed", () => {
		const link = searchCandidate(entry({ text: "see [the docs](https://example.com/zebra)" }), "a", "p")!;
		expect(ids([link], "zebra")).toEqual([]);
		expect(ids([link], "docs")).toEqual(["a"]);
		const mention = searchCandidate(entry({ text: "open [\\_\\_init\\_\\_.py](/repo/pkg/__init__.py)" }), "a", "p")!;
		expect(mention.text).toBe("open __init__.py");
		expect(ids([mention], "__init__.py")).toEqual(["a"]);
	});
});

let entryId = 100;
function entry(input: { text: string; role?: "user" | "assistant"; data?: unknown }): EntryRecord {
	const role = input.role ?? "user";
	const message = role === "user" ? { role, content: [{ type: "text", text: input.text }], timestamp: NOW } : { role, content: [{ type: "text", text: input.text }], timestamp: NOW, stopReason: "stop" };
	return { id: ++entryId, kind: role === "user" ? "app.user" : "pi.assistant", data: input.data, model: [message] } as unknown as EntryRecord;
}

describe("which messages are searched", () => {
	it("a person's messages and the agent's answers, a user-role message an agent wrote marked as such, not the attachment-only placeholder", () => {
		expect(searchCandidate(entry({ text: "hello", data: { messageId: "msg-1" } }), "t", "p")).toMatchObject({ source: "user", messageId: "msg-1" });
		expect(searchCandidate(entry({ text: "hello", role: "assistant" }), "t", "p")).toMatchObject({ source: "assistant" });
		expect(searchCandidate(entry({ text: "hello", role: "assistant" }), "t", "p")?.messageId).toBeUndefined();
		expect(searchCandidate(entry({ text: "a report", data: { createdBy: "agent", creationSource: "mcp" } }), "t", "p")).toMatchObject({ source: "user", byAgent: true });
		expect(searchCandidate(entry({ text: "hello" }), "t", "p")?.byAgent).toBeUndefined();
		expect(searchCandidate(entry({ text: "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]" }), "t", "p")).toBeUndefined();
	});
});

describe("the best message per thread, and its hits", () => {
	it("a whole word beats a word start beats a match inside a word, before user-first and recency", () => {
		const candidates = [
			c({ threadId: "a", text: "trusty crate", messageCreatedAt: NOW - 1000 }),
			c({ threadId: "a", text: "rusty nail", source: "assistant", messageCreatedAt: NOW - 2000 }),
			c({ threadId: "a", text: "rust is great", source: "assistant", messageCreatedAt: NOW - 3 * DAY }),
		];
		const [hit] = search(candidates, "rust");
		expect(hit).toMatchObject({ snippet: "rust is great", source: "assistant", quality: 1, hits: 1 });
	});

	it("at one grade, a user's message, then the newest; hits counts the thread's matches at that grade", () => {
		const candidates = [
			c({ threadId: "a", text: "needle one", source: "assistant", messageCreatedAt: NOW - 1000 }),
			c({ threadId: "a", text: "needle two", messageCreatedAt: NOW - 3000, messageId: "u-old" }),
			c({ threadId: "a", text: "needle three", messageCreatedAt: NOW - 2000, messageId: "u-new" }),
			c({ threadId: "a", text: "needles", messageCreatedAt: NOW - 500 }),
		];
		expect(search(candidates, "needle")).toEqual([
			{ threadId: "a", projectId: "p", source: "user", snippet: "needle three", messageCreatedAt: NOW - 2000, quality: 1, hits: 3, messageId: "u-new" },
		]);
	});

	it("words written together as typed grade above the same words apart", () => {
		const together = search([c({ threadId: "a", text: "run vp dev now" })], "vp dev")[0]!;
		const apart = search([c({ threadId: "b", text: `dev ${"x ".repeat(60)} vp` })], "vp dev")[0]!;
		expect(together.quality).toBeGreaterThan(apart.quality);
	});
});

describe("ranking across threads, as T3's clients rank message matches", () => {
	it("a word match before a match inside a word, however recent", () => {
		const candidates = [c({ threadId: "inside", text: "a trustworthy plan", messageCreatedAt: NOW }), c({ threadId: "word", text: "the trust fall", messageCreatedAt: NOW - 30 * DAY })];
		expect(ids(candidates, "trust")).toEqual(["word", "inside"]);
	});

	it("a thread the palette picked for this query first, then more hits and recent use", () => {
		const candidates = [
			c({ threadId: "busy", text: "deploy notes" }),
			c({ threadId: "busy", text: "deploy again" }),
			c({ threadId: "quiet", text: "deploy once" }),
			c({ threadId: "picked", text: "deploy here" }),
		];
		expect(ids(candidates, "deploy")[0]).toBe("busy");
		const subjects = new Map<string, SearchSubject>([["picked", { activityAt: null, opens: { openedAt: NOW - DAY, score: 1, picks: [{ query: "deploy", at: NOW - DAY }] } }]]);
		expect(search(candidates, "deploy", subjects).map((match) => match.threadId)[0]).toBe("picked");
		const recent = new Map<string, SearchSubject>([["quiet", { activityAt: NOW - 1000, opens: null }]]);
		expect(search(candidates.filter((x) => x.threadId !== "busy"), "deploy", recent).map((match) => match.threadId)).toEqual(["quiet", "picked"]);
	});

	it("caps results at the limit", () => {
		const candidates = Array.from({ length: 60 }, (_, i) => c({ threadId: `t${String(i).padStart(2, "0")}`, text: "needle" }));
		expect(search(candidates, "needle", none, 50)).toHaveLength(50);
	});
});

describe("snippet (T3's buildSearchSnippet)", () => {
	it("the whole text when short, whitespace collapsed and emphasis and code marks dropped", () => {
		expect(buildSearchSnippet("  hello\n  **world** `x`\t", 10)).toBe("hello world x");
	});

	it("starts a few words before the match, cut at 240 characters with ellipses", () => {
		const text = `${"word ".repeat(60)}NEEDLE ${"tail ".repeat(60)}`;
		const snippet = search([c({ threadId: "a", text })], "needle")[0]!.snippet;
		expect(snippet.startsWith("…word word word word NEEDLE")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet.length).toBeLessThanOrEqual(240);
	});
});
