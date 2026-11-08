// A thread row carries a durable sidebar snapshot, so a shell snapshot after a restart still previews and sorts an
// unopened thread instead of falling back to its creation time.
import { expect, it } from "vitest";
import { DateTime } from "effect";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

it("remembers a newer summary and ignores a late older one", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { threads, harness, model } = f;
	await createNamed(threads, harness, model)({ threadId: "t", projectId: "p", title: "Thread" });
	await threads.remember("t", {
		updatedAt: 200,
		latestVisibleMessage: { id: "u1", role: "user", text: "latest prompt", updatedAt: 200 },
		latestUserMessageAt: 200,
		itemCount: 4,
		visibleItemCount: 3,
	});
	const first = await threads.thread("t");
	expect(first?.summary).toEqual({
		updatedAt: 200,
		latestVisibleMessage: { id: "u1", role: "user", text: "latest prompt", updatedAt: 200 },
		latestUserMessageAt: 200,
		latestRun: null,
		itemCount: 4,
		visibleItemCount: 3,
	});

	await threads.remember("t", { updatedAt: 100, latestVisibleMessage: { id: "old", role: "user", text: "old", updatedAt: 100 } });
	expect((await threads.thread("t"))?.summary?.latestVisibleMessage?.id, "a late write does not regress the snapshot").toBe("u1");
}, 30_000);

it("projects a stored summary when the transcript is not loaded", () => {
	const meta: ThreadMeta = {
		threadId: "t",
		projectId: "p",
		title: "Thread",
		cwd: "/tmp/p",
		createdAt: 100,
		updatedAt: 200,
		summary: {
			updatedAt: 200,
			latestVisibleMessage: { id: "u1", role: "assistant", text: "last answer", updatedAt: 200 },
			latestUserMessageAt: 150,
			itemCount: 6,
			visibleItemCount: 5,
		},
		model: null,
		running: false,
	};
	const { shell } = projectThread(meta, undefined, { rolledBack: [] });
	expect(DateTime.toEpochMillis(shell.updatedAt)).toBe(200);
	expect(shell.latestVisibleMessage?.id).toBe("u1");
	expect(shell.latestVisibleMessage?.text).toBe("last answer");
	expect(DateTime.toEpochMillis(shell.latestVisibleMessage!.updatedAt)).toBe(200);
	expect(DateTime.toEpochMillis(shell.latestUserMessageAt!)).toBe(150);
	expect(shell.itemCount).toBe(6);
	expect(shell.visibleItemCount).toBe(5);
});
