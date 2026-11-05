// Compaction is a context head: the summary replaces the history above the cut, and the entries after the cut are
// kept. pi's split-turn compaction can cut inside a turn, so the kept tail may start with assistant/tool entries that
// no user prompt precedes. These cases pin that the tail stays visible (anchored by the summary) and that the card is
// emitted first, at the cut, instead of after the newest message.
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

const assistant = (id: number, text: string, timestamp: number): EntryRecord =>
	({
		id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp }],
	}) as unknown as EntryRecord;

const user = (id: number, text: string, timestamp: number): EntryRecord =>
	({ id, kind: "app.user", data: { messageId: `message-${id}` }, model: [{ role: "user", content: text, timestamp }] }) as unknown as EntryRecord;

describe("projection: compaction keeps its tail", () => {
	it("projects a live manual compaction as a running card after a reload", () => {
		const entries = [user(1, "before", 10), assistant(2, "answer", 20)];
		const result = projectThread(
			meta,
			view(entries, { "pi.live": { compactions: [{ taskId: 42, reason: "manual", blocking: false, attempt: 1 }] } }),
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
			view(entries, { "pi.live": { compactions: [{ taskId: 42, reason: "manual", blocking: false, attempt: 1 }] } }),
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

	it("shows the compacted history above the card as a real rewind target", () => {
		const past = [user(10, "older question", 10), assistant(11, "older answer", 20)];
		const entries = [compaction(100, 101), assistant(101, "kept reply", 60)];
		const result = projectThread(meta, view(entries), { rolledBack: [], history: past });

		expect(result.projection.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "older question"],
			["assistant", "older answer"],
			["assistant", "kept reply"],
		]);
		expect(result.projection.turnItems.map((item) => item.type)).toEqual([
			"user_message",
			"assistant_message",
			"compaction",
			"assistant_message",
		]);
		// History renders as a run and carries its checkpoint: a rewind into it is a real rewind, not display-only.
		expect(result.projection.runs).toHaveLength(2);
		expect(result.projection.runs[0]!.checkpointId).toBe("cp10");
		expect(result.runs.map((run) => [run.userEntryId, run.lastEntryId])).toEqual([[10, 11]]);
	});

	it("keeps the card as the only item when the compaction kept nothing", () => {
		const entries = [compaction(100, 100)];
		const result = projectThread(meta, view(entries), { rolledBack: [] });
		expect(result.projection.runs).toHaveLength(0);
		expect(result.forkRuns).toHaveLength(0);
		expect(result.projection.turnItems).toHaveLength(1);
		expect(result.projection.turnItems[0]!.type).toBe("compaction");
	});
});
