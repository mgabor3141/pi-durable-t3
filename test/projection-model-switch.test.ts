// T3's model switch divider (`modelSwitch` on a user message, v0.1.7): a run that used another model or thinking level
// than the latest run shown before it says so. Answers from before pi recorded the thinking level compare by model only.
import { expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

let id = 0;
const turn = (messageId: string, model: string, thinkingLevel?: string): EntryRecord[] => [
	{ id: ++id, kind: "app.user", data: { messageId }, model: [{ role: "user", content: messageId, timestamp: id }] },
	{
		id: ++id,
		kind: "pi.assistant",
		model: [{ role: "assistant", content: [{ type: "text", text: "ok" }], provider: "p", model, ...(thinkingLevel === undefined ? {} : { thinkingLevel }), stopReason: "stop", timestamp: id }],
	},
] as unknown as EntryRecord[];
const compact = (): EntryRecord[] => [{ id: ++id, kind: "app.compact", data: { messageId: "compact", text: "/compact" } }] as unknown as EntryRecord[];

it("marks a change of model or thinking level on the message that brought it, and nothing else", () => {
	const entries = [
		...turn("m1", "a", "low"),
		...turn("m2", "a", "low"),
		...turn("m3", "a", "high"),
		...compact(),
		...turn("m4", "b"),
		// An answer without a recorded level (older pi) is not a switch of level.
		...turn("m5", "b", "high"),
	];
	const { projection } = projectThread(meta, view(entries), { rolledBack: [] });
	const switches = Object.fromEntries(
		(projection.turnItems as unknown as { type: string; messageId?: string; modelSwitch?: { from: { model: string; options?: unknown }; to: { model: string; options?: unknown } } }[])
			.filter((item) => item.type === "user_message")
			.map((item) => [item.messageId, item.modelSwitch === undefined ? null : [item.modelSwitch.from.model, item.modelSwitch.from.options ?? null, item.modelSwitch.to.model, item.modelSwitch.to.options ?? null]]),
	);
	const level = (value: string) => [{ id: "thinking", value }];
	expect(switches).toEqual({
		m1: null,
		m2: null,
		m3: ["p/a", level("low"), "p/a", level("high")],
		compact: null,
		m4: ["p/a", level("high"), "p/b", null],
		m5: null,
	});
});
