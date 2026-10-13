// Undo mapping: a T3 checkpoint names the run to keep; `undoTarget` returns the USER turn being reverted (run N+1's,
// or run 1's for baseline). The threads layer forks at the entry just before it (a fork is inclusive), so the reverted
// user message is dropped too; baseline creates a fresh conversation. Pure checks on `undoTarget`, then the head view.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { undoTarget } from "../src/t3/projection.ts";
import { conversation, idle, makeThreads } from "./threads-harness.ts";

// Three settled runs. Checkpoints are `cp<userEntryId>`; the baseline keeps nothing.
const RUNS = [
	{ ordinal: 1, userEntryId: 10 },
	{ ordinal: 2, userEntryId: 20 },
	{ ordinal: 3, userEntryId: 30 },
];

describe("undoTarget", () => {
	it("cp1 keeps run 1 → fork at run 2's user entry", () => {
		expect(undoTarget(RUNS, "cp10")).toEqual({ entryId: 20, keepOrdinal: 1 });
	});
	it("cp2 keeps runs 1–2 → fork at run 3's user entry", () => {
		expect(undoTarget(RUNS, "cp20")).toEqual({ entryId: 30, keepOrdinal: 2 });
	});
	it("baseline keeps nothing → fork at the first run's user entry", () => {
		expect(undoTarget(RUNS, "cp-baseline")).toEqual({ entryId: 10, keepOrdinal: 0 });
	});
	it("the last checkpoint already keeps every run → nothing to revert", () => {
		expect(undoTarget(RUNS, "cp30")).toEqual({ nothing: true });
	});
	it("an empty thread has nothing to revert at baseline", () => {
		expect(undoTarget([], "cp-baseline")).toEqual({ nothing: true });
	});
	it("an unknown checkpoint is unknown", () => {
		expect(undoTarget(RUNS, "cp999")).toEqual({ unknown: true });
	});
});

describe("rewind keeps exactly the mapped turns", () => {
	// Drive three turns, then rewind at the user entry `undoTarget` names as being reverted. A pi-durable fork is
	// INCLUSIVE of its fork entry, so the threads layer forks at the entry just BEFORE that user turn — which drops
	// the reverted user message too. Undo to baseline (nothing before the first turn) creates a fresh conversation.
	async function threeTurns() {
		const { threads, harness, model, projects } = await makeThreads({ projects: [{ id: "p" }] });
		const t = await threads.create({ threadId: "t", projectId: "p" });
		for (let i = 1; i <= 3; i++) {
			model.respond(fauxAssistantMessage(`reply ${i}`));
			await threads.submit({ threadId: "t", conversationId: t.head, requestId: `s${i}`, message: `turn ${i}` }, undefined);
			await idle(harness, t.head);
		}
		const entries = (await conversation(harness, t.head).then((c) => c.context(BACKGROUND_CONTEXT))).entries;
		const userEntryIds = entries.filter((e) => e.kind === UserEntry.kind).map((e) => e.id);
		const runs = userEntryIds.map((userEntryId, index) => ({ ordinal: index + 1, userEntryId }));
		const view = async (id: number) => (await conversation(harness, id).then((c) => c.context(BACKGROUND_CONTEXT))).entries;
		const counts = async (id: number) => {
			const e = await view(id);
			return {
				users: e.filter((x) => x.kind === UserEntry.kind).map((x) => x.id),
				assistants: e.filter((x) => x.kind === "pi.assistant").length,
				total: e.length,
			};
		};
		return { threads, harness, model, projects, head: t.head, runs, view, counts };
	}
	const view2 = async (harness: import("@earendil-works/pi-durable").Harness, id: number) =>
		(await conversation(harness, id).then((c) => c.context(BACKGROUND_CONTEXT))).entries;

	it("undo to cp2 keeps runs 1–2 (replies and messages) and drops run 3 entirely", async () => {
		const { threads, head, runs, counts } = await threeTurns();
		expect(runs.map((r) => r.ordinal)).toEqual([1, 2, 3]);
		const target = undoTarget(runs, `cp${runs[1]!.userEntryId}`);
		if ("entryId" in target === false) throw new Error("expected a fork target");
		expect(target.entryId).toBe(runs[2]!.userEntryId); // the reverted turn is run 3's user message
		const next = await threads.rewind({ threadId: "t", expectedHead: head, entryId: target.entryId, requestId: "u" });
		const c = await counts(next);
		expect(c.users).toEqual([runs[0]!.userEntryId, runs[1]!.userEntryId]); // run 3's user message is gone
		expect(c.assistants).toBe(2);
	});

	it("undo to cp1 leaves exactly turn 1 — user and reply, nothing else", async () => {
		const { threads, head, runs, counts } = await threeTurns();
		const target = undoTarget(runs, `cp${runs[0]!.userEntryId}`);
		if ("entryId" in target === false) throw new Error("expected a fork target");
		const next = await threads.rewind({ threadId: "t", expectedHead: head, entryId: target.entryId, requestId: "u" });
		const c = await counts(next);
		expect(c.users).toEqual([runs[0]!.userEntryId]); // only turn 1's user message survives
		expect(c.assistants).toBe(1); // and its reply
		expect(c.total).toBe(2); // nothing else
	});

	it("baseline undo leaves an empty conversation in the same dir with the same model", async () => {
		const { threads, harness, model, projects, head, runs } = await threeTurns();
		const target = undoTarget(runs, "cp-baseline");
		if ("entryId" in target === false) throw new Error("expected a fork target");
		const next = await threads.rewind({ threadId: "t", expectedHead: head, entryId: target.entryId, requestId: "u" });
		const c = await conversation(harness, next).then((x) => x.context(BACKGROUND_CONTEXT));
		expect(c.entries).toHaveLength(0); // no messages, no replies
		const agent = await conversation(harness, next).then((x) => x.agent(BACKGROUND_CONTEXT));
		expect(agent.cwd).toBe(projects[0]!.cwd); // same project dir
		expect(agent.model?.modelId).toBe(model.modelRef.modelId); // same model
	});

	it("the next prompt after an undo gets a normal reply", async () => {
		const { threads, harness, model, head, runs, counts, view } = await threeTurns();
		const target = undoTarget(runs, `cp${runs[0]!.userEntryId}`);
		if ("entryId" in target === false) throw new Error("expected a fork target");
		const next = await threads.rewind({ threadId: "t", expectedHead: head, entryId: target.entryId, requestId: "u" });
		model.respond(fauxAssistantMessage("after undo"));
		await threads.submit({ threadId: "t", conversationId: next, requestId: "s4", message: "turn 4" }, undefined);
		await idle(harness, next);
		const c = await counts(next);
		expect(c.users.length).toBe(2); // turn 1's message plus the new one
		expect(c.assistants).toBe(2); // turn 1's reply plus the new reply after undo
		const last = (await view(next)).at(-1);
		expect(last?.kind).toBe("pi.assistant"); // the new turn received a reply
	});
});
