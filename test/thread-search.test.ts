// The pure replication of T3's thread-search semantics (`src/t3/thread-search.ts`, from
// `apps/server/src/orchestration-v2/ThreadSearch.ts`): the ASCII-case-insensitive substring match, the per-thread
// best-message ranking (user first, then newest, then lowest id), the global order (a thread whose best is a user
// message first, then most-recently-updated, then thread id), the snippet, and the limit. A test over candidates drives
// the rules directly, without a Harness.
import { describe, expect, it } from "vitest";
import { buildSearchSnippet, searchThreads, type SearchCandidate } from "../src/t3/thread-search.ts";

let seq = 0;
const c = (over: Partial<SearchCandidate> & Pick<SearchCandidate, "threadId" | "text">): SearchCandidate => ({
	projectId: "p",
	source: "user",
	messageCreatedAt: 1000,
	messageId: ++seq,
	...over,
});

const map = (entries: readonly (readonly [string, number])[]): ReadonlyMap<string, number> => new Map(entries);

describe("matching (ASCII-case-insensitive substring, SQLite LIKE)", () => {
	it("matches across case, and treats the query as a literal substring", () => {
		const hits = searchThreads([c({ threadId: "a", text: "Hello WORLD" })], map([]), "world", 50);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.threadId).toBe("a");
	});
	it("does not match a non-substring; the match is an exact substring (LIKE), no whitespace folding", () => {
		const candidates = [c({ threadId: "a", text: "one  two" }), c({ threadId: "b", text: "abc" })];
		// SQLite LIKE matches the (escaped) query as a literal substring; the query's own spacing is not collapsed, so a
		// single-space query does NOT match the double-space text. Only an exact substring matches.
		expect(searchThreads(candidates, map([]), "one two", 50)).toEqual([]);
		expect(searchThreads(candidates, map([]), "one  two", 50).map((m) => m.threadId)).toEqual(["a"]);
		expect(searchThreads(candidates, map([]), "xyz", 50)).toEqual([]);
	});
	it("folds ASCII letters only: a non-ASCII letter is a literal", () => {
		// "É" is not folded to "é" (foldAsciiCase leaves it); so an accented query matches only the accented text.
		const candidates = [c({ threadId: "a", text: "café" }), c({ threadId: "b", text: "cafe" })];
		expect(searchThreads(candidates, map([]), "café", 50).map((m) => m.threadId)).toEqual(["a"]);
	});
});

describe("per-thread best match (user first, then newest, then lowest id)", () => {
	it("prefers a user message over a later assistant message in the same thread", () => {
		const candidates = [
			c({ threadId: "a", source: "assistant", text: "needle", messageCreatedAt: 5000, messageId: 10 }),
			c({ threadId: "a", source: "user", text: "needle", messageCreatedAt: 1000, messageId: 11 }),
		];
		const [hit] = searchThreads(candidates, map([["a", 5000]]), "needle", 50);
		expect(hit?.source).toBe("user");
		expect(hit?.messageCreatedAt).toBe(1000);
	});
	it("among same-source messages, takes the newest, then the lowest id", () => {
		const candidates = [
			c({ threadId: "a", source: "user", text: "needle", messageCreatedAt: 2000, messageId: 5 }),
			c({ threadId: "a", source: "user", text: "needle", messageCreatedAt: 9000, messageId: 9 }),
		];
		const [hit] = searchThreads(candidates, map([["a", 9000]]), "needle", 50);
		expect(hit?.messageCreatedAt).toBe(9000);
	});
	it("one match per thread, never two rows for the same thread", () => {
		const candidates = [c({ threadId: "a", text: "x" }), c({ threadId: "a", source: "assistant", text: "x" })];
		expect(searchThreads(candidates, map([]), "x", 50)).toHaveLength(1);
	});
});

describe("global order (user-first thread, then recency, then thread id) and limit", () => {
	it("threads whose best is a user message come before threads whose best is an assistant message", () => {
		const candidates = [
			c({ threadId: "assistant-thread", source: "assistant", text: "needle", messageCreatedAt: 99999 }),
			c({ threadId: "user-thread", source: "user", text: "needle", messageCreatedAt: 1 }),
		];
		const order = searchThreads(candidates, map([["assistant-thread", 99999], ["user-thread", 1]]), "needle", 50);
		expect(order.map((m) => m.threadId)).toEqual(["user-thread", "assistant-thread"]);
	});
	it("within the same source rank, most-recently-updated thread first, then thread id", () => {
		const candidates = [
			c({ threadId: "a", text: "needle", messageCreatedAt: 10 }),
			c({ threadId: "b", text: "needle", messageCreatedAt: 10 }),
			c({ threadId: "c", text: "needle", messageCreatedAt: 10 }),
		];
		const order = searchThreads(candidates, map([["a", 100], ["b", 300], ["c", 200]]), "needle", 50);
		expect(order.map((m) => m.threadId)).toEqual(["b", "c", "a"]);
	});
	it("ties on recency break by thread id ascending", () => {
		const candidates = [c({ threadId: "z", text: "needle" }), c({ threadId: "y", text: "needle" })];
		expect(searchThreads(candidates, map([["z", 5], ["y", 5]]), "needle", 50).map((m) => m.threadId)).toEqual(["y", "z"]);
	});
	it("caps results at the limit, in order", () => {
		const candidates = Array.from({ length: 60 }, (_, i) => c({ threadId: `t${String(i).padStart(2, "0")}`, text: "needle" }));
		const hits = searchThreads(candidates, map(candidates.map((x) => [x.threadId, 0])), "needle", 50);
		expect(hits).toHaveLength(50);
	});
});

describe("snippet (T3's buildSearchSnippet)", () => {
	it("collapses whitespace and returns the whole text when short", () => {
		expect(buildSearchSnippet("  hello\n  world\t", "world")).toBe("hello world");
	});
	it("windows a long text around the match, under the 240-char cap, with ellipses", () => {
		const text = `${"a".repeat(200)} NEEDLE ${"b".repeat(200)}`;
		const snippet = buildSearchSnippet(text, "needle");
		expect(snippet.length).toBeLessThanOrEqual(240);
		expect(snippet).toContain("NEEDLE");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
	});
	it("no leading ellipsis when the match sits at the start of a long text", () => {
		const text = `NEEDLE ${"c".repeat(400)}`;
		const snippet = buildSearchSnippet(text, "needle");
		expect(snippet.startsWith("NEEDLE")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
	});
});
