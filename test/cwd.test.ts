// Two threads in different projects run a `bash` command concurrently, each in its own project directory. This proves
// the per-conversation environment carries each thread's project `cwd` and that independent threads do not interfere.
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { idle, makeThreads, markerSteps } from "./threads-harness.ts";

describe("cwd isolation", () => {
	it("two threads in different projects run in their own directories", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-cwd-"));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const one = join(root, "one");
		const two = join(root, "two");
		const { threads, harness } = await makeThreads({
			projects: [{ id: "one", cwd: one }, { id: "two", cwd: two }],
			responses: markerSteps(10),
			coding: true,
		});

		const a = await threads.create({ threadId: "a", projectId: "one" });
		const b = await threads.create({ threadId: "b", projectId: "two" });

		// Each turn's model writes the turn's text into `marker.txt` via `bash`, run in that conversation's env cwd.
		await Promise.all([
			threads.submit({ threadId: "a", conversationId: a.head, requestId: "a1", message: "alpha" }, undefined),
			threads.submit({ threadId: "b", conversationId: b.head, requestId: "b1", message: "beta" }, undefined),
		]);
		await Promise.all([idle(harness, a.head), idle(harness, b.head)]);

		expect(readFileSync(join(one, "marker.txt"), "utf8").trim()).toBe("alpha");
		expect(readFileSync(join(two, "marker.txt"), "utf8").trim()).toBe("beta");
	}, 30_000);
});
