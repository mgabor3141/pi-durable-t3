// Compaction is a context head: the summary replaces the history above the cut, and the entries after the cut are
// kept. The card shows where the summary landed (where it was written, after the entries it keeps), as T3 shows a
// provider's compaction at the moment it happened; a background compaction lands while the agent works and its run goes
// on. A transcript that starts with a compaction (an undone head's active context) has no history before the cut: there
// pi's split-turn compaction can leave a kept tail that starts with assistant/tool entries no user prompt precedes, and
// these cases pin that the tail stays visible (anchored by the summary) with the card first.
import { splitTranscript } from "../src/t3/thread-view.ts";
import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = {
	threadId: "t1",
	projectId: "p",
	title: "t",
	cwd: "/",
	createdAt: 0,
	updatedAt: 0,
	model: null,
	running: false,
};

const view = (entries: EntryRecord[], docs: Record<string, unknown> = {}): ConversationView =>
	({ conversation: { id: 1 }, entries, docs }) as unknown as ConversationView;

const compaction = (id: number, head: number, summary = "Prior work."): EntryRecord =>
	({
		id,
		kind: "pi.compaction",
		data: { reason: "threshold" },
		model: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
					},
				],
				timestamp: 50,
			},
		],
	}) as unknown as EntryRecord;

const assistant = (id: number, text: string, timestamp: number, context?: { input: number; output: number }): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				stopReason: "stop",
				timestamp,
				...(context === undefined ? {} : { usage: { input: context.input, output: context.output, cacheRead: 0, cacheWrite: 0 } }),
			},
		],
	}) as unknown as EntryRecord;

const user = (id: number, text: string, timestamp: number): EntryRecord =>
	({ id, kind: "app.user", data: { messageId: `message-${id}` }, model: [{ role: "user", content: text, timestamp }] }) as unknown as EntryRecord;

describe("projection: compaction keeps its tail", () => {
	it("projects a live manual compaction as a running card after a reload", () => {
		const entries = [user(1, "before", 10), assistant(2, "answer", 20)];
		const result = projectThread(
			meta,
			view(entries, { "pi.live": { compactions: [{ taskId: 42, trigger: "manual", blocking: false, attempt: 1 }] } }),
			{ rolledBack: [] },
		);

		const live = result.projection.turnItems.find((item) => item.type === "compaction");
		expect(live).toMatchObject({
			runId: null,
			status: "running",
			title: "Compacting context",
		});
	});

	it("attaches a live compaction to its persisted /compact run", () => {
		const entries = [
			({ id: 3, kind: "app.compact", data: { messageId: "compact-command", compact: true, text: "/compact", timestamp: 10 } }) as unknown as EntryRecord,
		];
		const result = projectThread(
			meta,
			view(entries, { "pi.live": { compactions: [{ taskId: 42, trigger: "manual", blocking: false, attempt: 1 }] } }),
			{ rolledBack: [] },
		);
		expect(result.projection.turnItems.find((item) => item.type === "compaction")).toMatchObject({ runId: "r3", status: "running" });
	});

	it("gives the completed compaction card the same run as its /compact command", () => {
		const entries = [
			({ id: 3, kind: "app.compact", data: { messageId: "compact-command", compact: true, text: "/compact", timestamp: 10 } }) as unknown as EntryRecord,
			compaction(4, 4),
		];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.turnItems.find((item) => item.type === "compaction")).toMatchObject({ runId: "r3", status: "completed" });
	});

	it("anchors a tail that starts inside a turn, so the kept entries stay visible", () => {
		const entries = [compaction(100, 101), assistant(101, "kept reply", 60)];
		const result = projectThread(meta, view(entries), { rolledBack: [] });

		// The kept assistant entry is still projected, under a run anchored by the compaction summary.
		expect(result.projection.runs).toHaveLength(1);
		expect(result.projection.runs[0]!.status).toBe("completed");
		expect(result.projection.messages.map((m) => [m.role, m.text])).toEqual([["assistant", "kept reply"]]);

		// The card is first, at the cut, and runless: attached to the run, its fold would sit above the card.
		const card = result.projection.turnItems[0]!;
		expect(card.type).toBe("compaction");
		expect(card.runId).toBe(null);
		expect((card as { summary?: string }).summary).toContain("Prior work.");
		// No synthetic prompt: the card stands in for it, so clients have nothing to hide and no stray bubble.
		expect(result.projection.turnItems.some((item) => item.type === "user_message")).toBe(false);

		// No user turn was cut into, so the synthetic run is not a rewind checkpoint.
		expect(result.projection.runs[0]!.checkpointId).toBe(null);
		expect(result.runs).toHaveLength(0);
		// It is still forkable at its last kept entry: the card is a run anchor, not a user turn.
		expect(result.forkRuns).toHaveLength(1);
		expect(result.forkRuns[0]).toMatchObject({
			runId: "r100",
			ordinal: 1,
			userEntryId: 100,
			lastEntryId: 101,
			status: "completed",
		});
	});

	it("keeps a later user turn as its own run after a split-turn tail", () => {
		const entries = [
			compaction(100, 101),
			assistant(101, "kept reply", 60),
			user(102, "next question", 70),
			assistant(103, "next answer", 80),
		];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.runs).toHaveLength(2);
		expect(result.projection.runs[0]!.userMessageId).toBe("m100");
		expect(result.projection.runs[1]!.userMessageId).toBe("message-102");
		expect(result.runs.map((run) => run.userEntryId)).toEqual([102]);
		// The synthetic tail and the later user turn are both fork targets, in order.
		expect(result.forkRuns.map((run) => [run.runId, run.lastEntryId])).toEqual([
			["r100", 101],
			["r102", 103],
		]);
	});

	it("shows the card at the cut when the kept tail starts with a user turn", () => {
		const entries = [compaction(100, 102), user(102, "kept question", 70), assistant(103, "kept answer", 80)];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.turnItems[0]!.type).toBe("compaction");
		expect(result.projection.turnItems[0]!.runId).toBe(null);
		expect(result.projection.runs).toHaveLength(1);
		expect(result.projection.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "kept question"],
			["assistant", "kept answer"],
		]);
	});

	it("shows the compacted history as a real rewind target, and the kept reply in its own turn", () => {
		// As the view lists it: the summary (13) written after the entry it keeps (12), which the cut fell before.
		const { active, history } = splitTranscript([user(10, "older question", 10), assistant(11, "older answer", 20), assistant(12, "kept reply", 60), compaction(13, 12)]);
		const result = projectThread(meta, view(active), { rolledBack: [], history });

		expect(result.projection.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "older question"],
			["assistant", "older answer"],
			["assistant", "kept reply"],
		]);
		expect(result.projection.turnItems.map((item) => item.type)).toEqual(["user_message", "assistant_message", "assistant_message", "compaction"]);
		// History renders as a run and carries its checkpoint: a rewind into it is a real rewind, not display-only. The
		// card is not the run's last entry: it is not a place to fork at.
		expect(result.projection.runs).toHaveLength(1);
		expect(result.projection.runs[0]!.checkpointId).toBe("cp10");
		expect(result.runs.map((run) => [run.userEntryId, run.lastEntryId])).toEqual([[10, 12]]);
	});

	it("keeps the card as the only item when the compaction kept nothing", () => {
		const entries = [compaction(100, 100)];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.runs).toHaveLength(0);
		expect(result.forkRuns).toHaveLength(0);
		expect(result.projection.turnItems).toHaveLength(1);
		expect(result.projection.turnItems[0]!.type).toBe("compaction");
	});

	it("shows a background compaction where it landed, inside the agent's turn, with the context size before and after", () => {
		const { active, history } = splitTranscript([
			user(1, "do the work", 10),
			assistant(2, "step one", 20, { input: 150_000, output: 2_000 }),
			assistant(3, "step two", 30, { input: 170_000, output: 3_000 }),
			compaction(4, 3),
			assistant(5, "step three", 40, { input: 41_000, output: 1_000 }),
		]);
		const result = projectThread(meta, view(active), { rolledBack: [], history });
		expect(result.projection.runs).toHaveLength(1);
		const items = result.projection.turnItems as unknown as { type: string; runId: string | null; beforeTokenCount?: number; afterTokenCount?: number }[];
		expect(items.map((item) => item.type)).toEqual(["user_message", "assistant_message", "assistant_message", "compaction", "assistant_message"]);
		expect(items[3]).toMatchObject({ runId: "r1", beforeTokenCount: 173_000, afterTokenCount: 41_000 });
	});

	it("shows every compaction a thread had, each where it landed", () => {
		const { active, history } = splitTranscript([
			user(1, "first", 10),
			assistant(2, "a", 20),
			compaction(3, 2, "First summary."),
			user(4, "second", 30),
			assistant(5, "b", 40),
			compaction(6, 5, "Second summary."),
			user(7, "third", 50),
		]);
		const result = projectThread(meta, view(active), { rolledBack: [], history });
		const cards = result.projection.turnItems.filter((item) => item.type === "compaction") as unknown as { summary: string; runId: string }[];
		expect(cards.map((card) => [card.runId, card.summary.includes("First") ? "first" : "second"])).toEqual([
			["r1", "first"],
			["r4", "second"],
		]);
	});

	it("shows no row while a background compaction runs: the agent keeps working", () => {
		const entries = [user(1, "do the work", 10), assistant(2, "step one", 20)];
		const result = projectThread(meta, view(entries, { "pi.live": { run: { taskId: 7 }, compactions: [{ taskId: 42, trigger: "threshold", blocking: false, attempt: 1 }] } }), { rolledBack: [] });
		expect(result.projection.turnItems.some((item) => item.type === "compaction")).toBe(false);
		expect(result.projection.runs[0]!.status).toBe("running");
	});

	it("shows a blocking compaction in the agent's turn, the moment it paused, the same at every projection", () => {
		const entries = [user(1, "do the work", 10), assistant(2, "step one", 20)];
		const docs = { "pi.live": { run: { taskId: 7 }, compactions: [{ taskId: 42, trigger: "threshold", blocking: true, attempt: 1 }] } };
		const first = projectThread(meta, view(entries, docs), { rolledBack: [] });
		const live = first.projection.turnItems.find((item) => item.type === "compaction");
		expect(live).toMatchObject({ runId: "r1", status: "running", title: "Compacting context" });
		expect(String(live!.startedAt)).toContain(new Date(20).toISOString());
		const second = projectThread(meta, view(entries, docs), { rolledBack: [] });
		expect(second.projection.turnItems.find((item) => item.type === "compaction")!.startedAt).toEqual(live!.startedAt);
	});

	it("a compaction now is not the run of a /compact long done: no row, and the thread is not busy", () => {
		const entries = [
			({ id: 3, kind: "app.compact", data: { messageId: "compact-command", compact: true, text: "/compact", timestamp: 10 } }) as unknown as EntryRecord,
			compaction(4, 4),
			user(5, "later", 20),
			assistant(6, "answer", 30),
		];
		const result = projectThread(meta, view(entries, { "pi.live": { compactions: [{ taskId: 42, trigger: "threshold", blocking: false, attempt: 1 }] } }), { rolledBack: [] });
		expect(result.projection.turnItems.filter((item) => item.type === "compaction").map((item) => item.status)).toEqual(["completed"]);
		expect(result.projection.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
	});
});
