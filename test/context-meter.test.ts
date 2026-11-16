// T3's context meter shows the newest usage report among a thread's provider turns. Two cases where the newest report
// was not the context's size: after a compaction (no request has measured what is left, so the report from before
// stayed), and after a request that failed (its usage is zeros). The first gets an estimate until a request answers.
import { expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { sizeAfterCompaction } from "../src/t3/context-size.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false, contextWindow: 200_000 };
const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;
const WORDS = (count: number) => "word ".repeat(count);

const user = (id: number, text: string, timestamp: number): EntryRecord => ({ id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }], timestamp }] }) as unknown as EntryRecord;
const assistant = (id: number, text: string, timestamp: number, sent: number, more: object = {}): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }], provider: "faux", model: "m", stopReason: "stop", usage: { input: sent === 0 ? 0 : 10, cacheRead: Math.max(0, sent - 10), cacheWrite: 0, output: sent === 0 ? 0 : 500, totalTokens: sent === 0 ? 0 : sent + 500 }, timestamp, ...more }],
	}) as unknown as EntryRecord;
const compaction = (id: number, head: number, timestamp: number): EntryRecord =>
	({ id, kind: "pi.compaction", head, data: { reason: "manual" }, model: [{ role: "user", content: [{ type: "text", text: `<summary>\n${WORDS(400)}\n</summary>` }], timestamp }] }) as unknown as EntryRecord;

/** What T3's meter shows: the newest report by its time (`latestProviderTurnTokenUsage`). */
const shown = (entries: EntryRecord[]) => {
	const turns = projectThread(meta, view(entries), { rolledBack: [] }).projection.providerTurns;
	return turns.reduce<{ usedTokens: number; updatedAt: string } | undefined>((latest, turn) => (turn.tokenUsage !== undefined && (latest === undefined || Date.parse(turn.tokenUsage.updatedAt) >= Date.parse(latest.updatedAt)) ? turn.tokenUsage : latest), undefined);
};

// A thread whose every request carries 12,000 tokens of system prompt and tools; the first sent 12,010.
const history: EntryRecord[] = [
	user(1, "Hello.", 1_000),
	assistant(2, "Hi.", 2_000, 12_010),
	user(3, WORDS(40_000), 3_000),
	assistant(4, WORDS(2_000), 4_000, 60_000),
	user(5, "And this?", 5_000),
	assistant(6, WORDS(1_000), 6_000, 63_000),
];

it("after a compaction the meter shows an estimate of what is left, until a request measures it", () => {
	expect(shown(history)?.usedTokens).toBe(63_500);
	expect(sizeAfterCompaction(history), "nothing was compacted").toBeUndefined();

	// A compaction that keeps the last exchange: the fixed part, the summary, and entries 5 and 6.
	const compacted = [...history, compaction(7, 5, 7_000)];
	const size = sizeAfterCompaction(compacted)!;
	expect(size).toBeGreaterThan(12_000);
	expect(size).toBeLessThan(20_000);
	expect(shown(compacted)).toEqual({ usedTokens: size, maxTokens: 200_000, updatedAt: new Date(7_000).toISOString() });

	// A message since, not answered yet, counts; a request that failed measures nothing.
	const waiting = [...compacted, user(8, WORDS(4_000), 8_000), assistant(9, "", 9_000, 0, { stopReason: "error", errorMessage: "overloaded" })];
	expect(sizeAfterCompaction(waiting)!).toBeGreaterThan(size + 3_000);
	expect(shown(waiting)?.usedTokens).toBe(sizeAfterCompaction(waiting));

	// The next answer is the size again.
	const answered = [...compacted, user(8, "Go on.", 8_000), assistant(9, "Done.", 9_000, 15_200)];
	expect(sizeAfterCompaction(answered)).toBeUndefined();
	expect(shown(answered)?.usedTokens).toBe(15_700);
});

it("a request that failed does not empty the meter", () => {
	const failed = [...history, user(7, "More.", 7_000), assistant(8, "", 8_000, 0, { stopReason: "error", errorMessage: "overloaded" })];
	expect(shown(failed)?.usedTokens, "the last request that was counted").toBe(63_500);
	// Within a run too: a counted step, then one that failed.
	const within = [...history, user(7, "More.", 7_000), assistant(8, WORDS(100), 8_000, 64_000), assistant(9, "", 9_000, 0, { stopReason: "error", errorMessage: "overloaded" })];
	expect(shown(within)?.usedTokens).toBe(64_500);
});
