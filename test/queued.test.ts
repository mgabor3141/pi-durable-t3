import { describe, expect, it } from "vitest";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";
import { readQueuedInputs, withQueuedText } from "../src/t3/queued.ts";

const meta: ThreadMeta = {
	threadId: "thread-queue",
	projectId: "project-queue",
	title: "Queue",
	cwd: "/home/agent/project",
	createdAt: 1,
	updatedAt: 2,
	model: { provider: "mgabor", modelId: "default" },
	running: true,
};

describe("queued messages", () => {
	it("projects inbox follow-ups as queued runs", () => {
		const result = projectThread(
			meta,
			{
				conversation: { id: 1 },
				entries: [],
				docs: {
					"pi.inbox": {
						items: [
							{ id: 42, mode: "followUp", content: "queued text", entry: { kind: "app.user", data: { messageId: "m-queue" } } },
						],
					},
				},
			},
			{ rolledBack: [] },
		);
		const run = result.projection.runs.find((candidate) => candidate.id === "q42");
		expect(run).toMatchObject({ status: "queued", queuePosition: 1, userMessageId: "m-queue" });
		expect(result.projection.messages.find((message) => message.id === "m-queue")).toMatchObject({
			role: "user",
			text: "queued text",
			runId: "q42",
		});
	});

	it("projects a steer not yet placed as a queued run too, before the follow-ups, so it can be edited or removed", () => {
		const result = projectThread(
			meta,
			{
				conversation: { id: 1 },
				entries: [],
				docs: {
					"pi.inbox": {
						items: [
							{ id: 42, mode: "followUp", content: "later", entry: { kind: "app.user", data: { messageId: "m-later" } } },
							{ id: 43, mode: "steer", content: "change course", entry: { kind: "app.user", data: { messageId: "m-steer" } } },
						],
					},
				},
			},
			{ rolledBack: [] },
		);
		const queued = result.projection.runs.filter((run) => run.status === "queued");
		expect(queued.map((run) => [run.id, run.queuePosition, run.userMessageId])).toEqual([
			["q43", 1, "m-steer"],
			["q42", 2, "m-later"],
		]);
		expect(result.projection.messages.find((message) => message.id === "m-steer")).toMatchObject({ role: "user", text: "change course", runId: "q43" });
	});

	it("reads a follow-up's text and preserves image blocks when editing", () => {
		const [item] = readQueuedInputs([
			{ id: 7, mode: "followUp", content: "old", entry: { kind: "app.user", data: { messageId: "m-7" } } },
		]);
		expect(item).toMatchObject({ submissionId: 7, messageId: "m-7", text: "old" });
		expect(withQueuedText([{ type: "text", text: "old" }, { type: "image", data: "x", mimeType: "image/png" }], "new")).toEqual([
			{ type: "text", text: "new" },
			{ type: "image", data: "x", mimeType: "image/png" },
		]);
	});
});
