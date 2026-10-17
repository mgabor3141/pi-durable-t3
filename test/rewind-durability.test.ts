// The rewind's two durable promises, pinned at the threads layer over a real restart:
//
// (1) THE OVERLAY STAYS ROLLED BACK. A rewind forks the head and moves the thread's head to the fork, so the reverted
//     run leaves the thread's ACTIVE context — the parent conversation keeps every entry (nothing is deleted), and the
//     thread shows runs 1..N. Nothing in the state stores "reverted": what a client sees is the head pointer, so if the
//     head came back from the state as the pre-rewind conversation, the reverted turn would silently return on restart.
//
// (2) THE LINEAGE SURVIVES. When the head has already moved on, the fork is added as a CHILD thread row carrying
//     `parent: { threadId }` — the only record of where the fork came from, and what T3's projection reports as
//     `parentThreadId` with `relationshipToParent: "fork"`. A row whose parent is dropped in a write is a thread with
//     no visible origin.
//
// Proven by breaking the mechanisms: moving the head back to the parent (or dropping `parent` in the child-row push)
// fails the matching assertion.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { conversation, createNamed, firstUserEntry, idle, makeThreads, restart } from "./threads-harness.ts";

async function userEntryIds(harness: Awaited<ReturnType<typeof makeThreads>>["harness"], id: number): Promise<number[]> {
	const entries = (await conversation(harness, id)).context(BACKGROUND_CONTEXT).then((c) => c.entries);
	return (await entries).filter((entry) => entry.kind === UserEntry.kind).map((entry) => entry.id);
}

describe("a rewind is durable", () => {
	it("(1) the rolled-back overlay survives a restart: the reverted run does not come back", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);
		const t = await create({ threadId: "t", projectId: "p" });
		const originalHead = t.head;

		for (const turn of [1, 2]) {
			model.respond(fauxAssistantMessage(`reply ${turn}`));
			await threads.submit({ threadId: "t", conversationId: originalHead, requestId: `s${turn}`, message: `turn ${turn}` }, undefined);
			await idle(harness, originalHead);
		}
		const before = await userEntryIds(harness, originalHead);
		expect(before, "two settled user turns").toHaveLength(2);

		// Revert run 2: fork before its user entry, move the thread's head to the fork.
		await threads.rewind({ threadId: "t", expectedHead: originalHead, entryId: before[1]!, requestId: "w1" });
		const after = await threads.thread("t");
		expect(after?.head, "the thread's head is the fork").not.toBe(originalHead);
		expect(await userEntryIds(harness, after!.head), "the active context is run 1 only").toHaveLength(1);

		// The restart: the head pointer is the whole mechanism, so this is the assertion that matters.
		const up = await restart(f);
		const reopened = await up.threads.thread("t");
		expect(reopened?.head, "the thread comes back at the rolled-back head").toBe(after?.head);
		expect(await userEntryIds(up.harness, reopened!.head), "the reverted turn stays out of the active context").toHaveLength(1);
		// The parent conversation is untouched (an overlay deletes nothing): both runs are still in it.
		expect(await userEntryIds(up.harness, originalHead), "nothing was deleted — the pre-rewind history is intact").toHaveLength(2);
		await up.harness.close(BACKGROUND_CONTEXT);
	}, 60_000);

	it("(2) a fork added while the head moved on keeps its parent across a restart", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);
		const t = await create({ threadId: "t", projectId: "p" });
		const head = t.head;
		for (const turn of [1, 2]) {
			model.respond(fauxAssistantMessage(`reply ${turn}`));
			await threads.submit({ threadId: "t", conversationId: head, requestId: `s${turn}`, message: `turn ${turn}` }, undefined);
			await idle(harness, head);
		}
		const entry = await firstUserEntry(harness, head);
		const second = (await userEntryIds(harness, head))[1]!;

		// Two rewinds racing on the SAME expectedHead: the first moves the head; the second finds the head moved on
		// and adds its fork as a child thread — the row that must carry the lineage.
		const results = await Promise.allSettled([
			threads.rewind({ threadId: "t", expectedHead: head, entryId: second, requestId: "w-a" }),
			threads.rewind({ threadId: "t", expectedHead: head, entryId: second, requestId: "w-b" }),
		]);
		expect(results.filter((r) => r.status === "fulfilled"), "both rewinds answer").toHaveLength(2);
		const rows = await threads.list();
		const children = rows.filter((row) => row.parent?.threadId === "t");
		expect(children.length, `exactly one child row, parented to the thread: ${JSON.stringify(rows.map((r) => [r.threadId, r.head, r.parent]))}`).toBe(1);
		expect(children[0]!.head, "the child IS the fork, not the parent's conversation").not.toBe(head);
		void entry;

		const up = await restart(f);
		const afterRestart = await up.threads.list();
		const lineage = afterRestart.filter((row) => row.parent?.threadId === "t");
		expect(lineage.length, "the lineage is in the state, not in memory").toBe(1);
		expect(lineage[0]!.head, "the same fork").toBe(children[0]!.head);
		await up.harness.close(BACKGROUND_CONTEXT);
	}, 60_000);
});
