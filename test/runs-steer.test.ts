// The steer boundary (review tests F3).
//
// A run is one user turn. A user entry that lands inside a run that is still going is a STEER of that run; one that
// lands after the run has ended starts a NEW run. `groupRuns` decides which, from the entries alone, and its rule is
// narrow on purpose: a steer is only allowed at a COMPLETED tool round — every call of the last assistant entry has a
// result, and none of those results is an aborted one. Get that boundary wrong in the permissive direction and two
// turns merge into one run: the run count, the run statuses, the checkpoint per turn and the undo map all move
// together, and the client shows one turn where the user sent two. Get it wrong in the strict direction and a steer
// the model was told to fold in becomes a second run that races the first.
//
// This leaf is pure, so the whole boundary is testable with entry shapes and no host, storage, or model. Forcing
// `endsWithCompletedToolRound` to `true` — the mutation this file exists to catch — collapses case 1 into a single run.
import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";
import { groupRuns } from "../src/t3/runs.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
const viewOf = (entries: readonly EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

const user = (id: number, text: string): EntryRecord =>
	({ id, kind: "app.user", data: { messageId: `u${id}` }, model: [{ role: "user", content: text, timestamp: id }] }) as unknown as EntryRecord;
const answered = (id: number, text: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: id }] }) as unknown as EntryRecord;
const failed = (id: number, message: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: message }], stopReason: "error", errorMessage: message, timestamp: id }] }) as unknown as EntryRecord;
const partial = (id: number, text: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "aborted", timestamp: id }] }) as unknown as EntryRecord;
const toolAsk = (id: number, callId: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command: "true" } }], stopReason: "toolUse", timestamp: id }] }) as unknown as EntryRecord;
const toolAnswer = (id: number, callId: string): EntryRecord =>
	({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: id }] }) as unknown as EntryRecord;
const toolAborted = (id: number, callId: string): EntryRecord =>
	({ id, kind: "pi.tool-result", data: { diagnostics: [{ code: "aborted" }] }, model: [{ role: "toolResult", toolCallId: callId, toolName: "bash", content: [], isError: true, timestamp: id }] }) as unknown as EntryRecord;

const shape = (entries: readonly EntryRecord[]) => groupRuns(entries).map((run) => ({ user: run.userEntry.id, steps: run.steps.map((step) => step.id) }));
const intents = (entries: readonly EntryRecord[]) =>
	projectThread(meta, viewOf(entries), { rolledBack: [] }).projection.turnItems
		.filter((item) => item.type === "user_message")
		.map((item) => (item as { text?: string; inputIntent?: string }).inputIntent);
const statuses = (entries: readonly EntryRecord[]) => projectThread(meta, viewOf(entries), { rolledBack: [] }).projection.runs.map((run) => run.status);

describe("groupRuns: where a run ends and a steer begins (F3)", () => {
	it("an answered turn ends the run, so the next user entry is a new run — not a steer", () => {
		const entries = [user(1, "first"), answered(2, "reply one"), user(3, "second")];
		// Two runs, each with its own user entry. Forcing the steer rule collapses this into one run of three steps,
		// and the projection then reports one turn, one checkpoint, one undo target for two user turns.
		expect(shape(entries)).toEqual([
			{ user: 1, steps: [2] },
			{ user: 3, steps: [] },
		]);
		expect(intents(entries)).toEqual(["turn_start", "turn_start"]);
	});

	it("a completed tool round is the boundary a steer lands at", () => {
		const entries = [user(1, "do it"), toolAsk(2, "call-1"), toolAnswer(3, "call-1"), user(4, "and then")];
		const runs = shape(entries);
		expect(runs).toEqual([{ user: 1, steps: [2, 3, 4] }]); // one run; entry 4 is a steer inside it
		expect(intents(entries)).toEqual(["turn_start", "steer"]);
	});

	it("an interrupted tool round ends the run: aborted results and unanswered calls both close it", () => {
		// The abort is the reason the run is over: a steer applied after it would be folded into a run whose tool
		// call never completed, and the model would be asked to continue a turn the user already interrupted.
		expect(shape([user(1, "go"), toolAsk(2, "call-1"), toolAborted(3, "call-1"), user(4, "stop that, do this")])).toEqual([
			{ user: 1, steps: [2, 3] },
			{ user: 4, steps: [] },
		]);
		// A call with no result at all: the round is not completed, so it is not a steer boundary either.
		expect(shape([user(1, "go"), toolAsk(2, "call-1"), user(3, "hmm")])).toEqual([
			{ user: 1, steps: [2] },
			{ user: 3, steps: [] },
		]);
		// One of several calls answered, one aborted: still interrupted — every call must be answered and none aborted.
		expect(
			shape([user(1, "go"), toolAsk(2, "a"), toolAsk(2, "b"), toolAnswer(3, "a"), toolAborted(4, "b"), user(5, "next")]),
		).toEqual([
			{ user: 1, steps: [2, 2, 3, 4] },
			{ user: 5, steps: [] },
		]);
	});

	it("a steer lands in the run's steps, so the projection gives it the run it steers", () => {
		const entries = [user(1, "go"), toolAsk(2, "call-1"), toolAnswer(3, "call-1"), user(4, "steer"), answered(5, "done")];
		const projection = projectThread(meta, viewOf(entries), { rolledBack: [] }).projection;
		expect(projection.runs).toHaveLength(1);
		// Both user messages belong to the one run: the steer's message carries its run's id.
		const messages = projection.messages.filter((message) => message.role === "user") as { runId: string; text: string }[];
		expect(messages.map((message) => message.text)).toEqual(["go", "steer"]);
		expect(new Set(messages.map((message) => message.runId)).size, "one run owns both user messages").toBe(1);
	});

	it("run status follows the last stop reason: answered, failed, interrupted", () => {
		expect(statuses([user(1, "a"), answered(2, "ok")])).toEqual(["completed"]);
		expect(statuses([user(1, "a"), failed(2, "boom")])).toEqual(["failed"]);
		expect(statuses([user(1, "a"), partial(2, "half a reply")])).toEqual(["interrupted"]);
		// A run whose last entry is the user entry (no reply yet, nothing running) is interrupted, not completed: the
		// host is not in a state the client should render as a finished turn.
		expect(statuses([user(1, "a"), answered(2, "ok"), user(3, "and?")])).toEqual(["completed", "interrupted"]);
	});

	it("an interrupted partial is superseded by the resumed answer, once", () => {
		const entries = [user(1, "go"), partial(2, "half"), answered(3, "resumed")];
		const projection = projectThread(meta, viewOf(entries), { rolledBack: [] }).projection;
		expect(projection.runs).toHaveLength(1);
		expect(projection.runs[0]!.status, "the resumed answer decides the status").toBe("completed");
		const assistantTexts = projection.messages.filter((message) => message.role === "assistant") as { text: string }[];
		expect(assistantTexts.map((message) => message.text), "the partial is not shown beside the answer that replaced it").toEqual(["resumed"]);
		// A trailing partial has nothing to supersede it, so it is the run's answer.
		const trailing = projectThread(meta, viewOf([user(1, "go"), answered(2, "one"), user(3, "two"), partial(4, "half")]), { rolledBack: [] }).projection;
		expect(trailing.runs.map((run) => run.status)).toEqual(["completed", "interrupted"]);
	});
});
