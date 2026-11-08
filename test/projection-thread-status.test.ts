// T3's sidebar reads "Waiting" from a thread whose status is "idle" while it has an active provider thread. T3's server
// gives a thread a provider thread with its first run and reports the latest run's status, "idle" only if it never ran.
import { DateTime } from "effect";
import { describe, expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;

describe("projection: thread status like T3's", () => {
	it("a thread that never ran has no provider thread and is idle", () => {
		const { projection, shell } = projectThread(meta, view([]), { rolledBack: [] });
		expect(projection.thread.activeProviderThreadId).toBeNull();
		expect(projection.providerThreads).toEqual([]);
		expect(shell.activeProviderThreadId).toBeNull();
		expect(shell.status).toBe("idle");
	});

	it("a thread whose run finished reports the run's status, not idle", () => {
		const entries = [
			{ id: 1, kind: "app.user", data: { messageId: "u" }, model: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "yo" }], stopReason: "stop", timestamp: 2 }] },
		] as unknown as EntryRecord[];
		const { projection, shell } = projectThread(meta, view(entries), { rolledBack: [] });
		expect(projection.thread.activeProviderThreadId).not.toBeNull();
		expect(shell.status).toBe("completed");
	});

	it("latestUserAuthoredMessageAt is the latest message a person wrote, not an agent's prompt (T3's field)", () => {
		const entries = [
			{ id: 1, kind: "app.user", data: { messageId: "u" }, model: [{ role: "user", content: "hi", timestamp: 1000 }] },
			{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "yo" }], stopReason: "stop", timestamp: 2000 }] },
			{ id: 3, kind: "app.user", data: { messageId: "a", createdBy: "agent", creationSource: "mcp" }, model: [{ role: "user", content: "do it", timestamp: 3000 }] },
			{ id: 4, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 4000 }] },
		] as unknown as EntryRecord[];
		const { shell } = projectThread(meta, view(entries), { rolledBack: [] });
		expect(DateTime.toEpochMillis(shell.latestUserMessageAt!)).toBe(3000);
		expect(DateTime.toEpochMillis(shell.latestUserAuthoredMessageAt!)).toBe(1000);
	});
});
