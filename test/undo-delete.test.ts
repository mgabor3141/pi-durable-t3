// The tombstone gates the UNDO path's commit too (review conc N2). "A removed thread stays removed" was
// enforced in the promote path and in boot repair; the undo's head-moved branch was the third door. A
// rewind admitted before a `remove` lands AFTER it: the named thread's row is gone, the fork of its head
// is a FRESH conversation no tombstone names, and the branch "head moved on → add the fork as a child
// thread" wrote a row parented to the deleted thread — with the deleted thread's runs inside the fork,
// surviving boot repair. The bridge's per-thread lock seals the T3 web wire; the raw chord surface
// (`PiThreads.remove` ∥ `PiTranscript.rewind`) shares no lock, and the threads layer owns the rule.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Threads } from "../src/threads.ts";
import { createNamed, firstUserEntry, idle, makeThreads } from "./threads-harness.ts";

describe("the tombstone gates the undo fork", () => {
	it("a rewind that lands after its thread was removed adds no row — not now, not after a restart", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);

		// A thread with one completed turn — the turn its undo would fork before.
		const t = await create({ threadId: "ghost", projectId: "p" });
		model.append(fauxAssistantMessage("ok"));
		await threads.submit({ threadId: "ghost", conversationId: t.head, requestId: "r1", message: "go" }, undefined);
		await idle(harness, t.head);
		const entry = await firstUserEntry(harness, t.head);

		// The delete lands FIRST (the landing order conc's widened probe proved), and the rewind admitted
		// before it commits after it. Pre-fix the head-moved branch found no row, called the fork's cwd
		// covered by `p`, and wrote a child row of the deleted thread.
		await threads.remove("ghost");
		const fork = await threads.rewind({ threadId: "ghost", expectedHead: t.head, entryId: entry, requestId: "u1" });

		const rows = await threads.list();
		expect(rows.filter((row) => row.parent?.threadId === "ghost"), `the undo of a deleted thread adds no row: ${JSON.stringify(rows)}`).toHaveLength(0);
		expect(rows.filter((row) => row.head === fork), `the fork is not a thread row: ${JSON.stringify(rows)}`).toHaveLength(0);
		expect(rows, "the document stays empty").toHaveLength(0);

		// The deletion is durable: boot repair over the same storage adopts nothing (the fork owes no run,
		// the removed head is tombstoned).
		const reopened = new Threads({ harness, registry: f.registry });
		await reopened.repair();
		expect(await reopened.list(), "boot repair resurrects nothing").toHaveLength(0);
	}, 30_000);

});
