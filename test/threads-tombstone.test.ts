// A removed thread stays removed across a restart (the concurrency reviewer's F1). The window: a prompt admits its
// run (one commit), then `project.delete`/`thread.delete` drops the threads, and the prompt's promote commit lands
// AFTER the removal — resurrecting the conversation as a fresh thread row. This makes that promise durable: the
// threads document keeps one id per removal (the removed thread's head conversation), and the promote path and the
// undo fork skip tombstoned conversations — the only automatic adoptions that exist.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId } from "@earendil-works/pi-durable";
import { Threads } from "../src/threads.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a removal is durable (F1)", () => {
	it("(a) a prompt in flight racing a removal: the thread does not resurrect — not now, not after a restart", async () => {
		const f = await makeThreads({ projects: [{ id: "p0" }] });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);

		// The bridge's race is the removal's commit landing BETWEEN the submit's commit and its promote — the
		// prompt's write arriving a beat after the delete starts (the bridge's `#awaitHead` produces that beat).
		// Sweeping the beat across rounds covers the window deterministically enough for a durable probe.
		// The survivor `p0` is rooted so that it COVERS the deleted project's folder: the late prompt's promote finds
		// the conversation's cwd covered by the survivor — indistinguishable from a legitimate adoption, which is
		// exactly why a removal must be durable (one id per removal), not merely an abort.
		const beats = [2, 4, 6, 8, 10, 13, 16, 20, 25, 32, 42, 60];
		const removedHeads: number[] = [];
		for (let round = 1; round <= beats.length; round++) {
			// A fresh project nested inside `p0`'s root (the one the delete removes), and a thread in it.
			const project = `r${round}`;
			f.registry.add(project, join(f.root, "p0", project));
			const t = await create({ threadId: `t${round}`, projectId: project });
			model.append(fauxAssistantMessage("ok"));
			const removing = (async () => {
				await threads.remove(`t${round}`);
				f.registry.remove(project);
			})();
			await sleep(beats[round - 1]!);
			const submitting = threads.submit({ threadId: `t${round}`, conversationId: t.head, requestId: `r${round}`, message: "go" }, undefined);
			await Promise.allSettled([submitting, removing]);
			await Promise.allSettled([idle(harness, t.head), sleep(400)]);

			const rows = await threads.list();
			expect(rows.some((row) => row.head === t.head), `round ${round}: the removed conversation is not a thread`).toBe(false);
			expect(rows.some((row) => row.projectId === "p0"), `round ${round}: nothing resurrected under the covering survivor`).toBe(false);
			removedHeads.push(t.head);
		}
		expect(await threads.list(), "the document is empty after 12 racing removals").toEqual([]);

		// The restart: a fresh threads layer over the same storage. A promote of every removed head — the only
		// automatic adoption — is skipped by each tombstone: nothing comes back under any project.
		const reopened = new Threads({ harness, registry: f.registry });
		for (const head of removedHeads) await reopened.promote("probe", head);
		expect(await reopened.list(), "promotes of tombstoned heads resurrect nothing").toEqual([]);
	}, 60_000);

	it("(b) a promote naming a TOMBSTONED, owed conversation adds nothing", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }], tokensPerSecond: 40 });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);
		const t = await create({ threadId: "t", projectId: "p" });

		// The thread is removed (tombstoned) while a turn is in flight.
		model.respond(fauxAssistantMessage("token ".repeat(2000)), fauxAssistantMessage("token ".repeat(2000)));
		const submitting = threads.submit({ threadId: "t", conversationId: t.head, requestId: "go", message: "go" }, undefined);
		await threads.remove("t");
		await Promise.allSettled([submitting, idle(harness, t.head)]);

		// The crash shape, made explicit: the conversation OWES work (a run admitted after the removal raced in — a
		// promote would normally adopt exactly this). The tombstone outranks it: the promote adds nothing.
		await harness.conversation(t.head as ConversationId, BACKGROUND_CONTEXT).then((c) => c!.submit({ type: "input", requestId: "owed", content: "late" }, BACKGROUND_CONTEXT));
		const reopened = new Threads({ harness, registry: f.registry });
		await reopened.promote("t", t.head);

		const rows = await reopened.list();
		expect(rows.some((row) => row.head === t.head), "the tombstoned, owed conversation stays unthreaded").toBe(false);
		expect(rows, "the promote added nothing").toEqual([]);

		// Leave no live run behind (the late prompt's stream): abort it, as any owner of a conversation may.
		const late = await harness.conversation(t.head as ConversationId, BACKGROUND_CONTEXT);
		await late!.abort(BACKGROUND_CONTEXT);
		await Promise.allSettled([idle(harness, t.head), sleep(5000)]);
	}, 60_000);
});
