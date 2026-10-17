// A removed thread stays removed across a restart (the concurrency reviewer's F1). The window: a prompt admits its
// run (one commit), then `project.delete`/`thread.delete` drops the threads, and the prompt's promote commit lands
// AFTER the removal — resurrecting the conversation as a fresh thread row. design.md promises "a delete aborts first
// — so boot repair sees nothing owed"; this makes that promise durable: the threads document keeps one id per removal
// (the removed thread's head conversation), and the promote path and boot repair skip tombstoned conversations.
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
		}
		expect(await threads.list(), "the document is empty after 12 racing removals").toEqual([]);

		// The restart: a fresh threads layer over the same storage runs boot repair. A deleted thread is not owed
		// (its run was aborted) AND its conversation is tombstoned — nothing brings it back under any project.
		const reopened = new Threads({ harness, registry: f.registry });
		await reopened.repair();
		expect(await reopened.list(), "boot repair resurrects nothing").toEqual([]);
	}, 60_000);

	it("(b) boot repair with a TOMBSTONED conversation promotes nothing", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }], tokensPerSecond: 40 });
		const { threads, harness, model } = f;
		const create = createNamed(threads, harness, model);
		const t = await create({ threadId: "t", projectId: "p" });

		// The thread is removed (tombstoned) while a turn is in flight.
		model.respond(fauxAssistantMessage("token ".repeat(2000)), fauxAssistantMessage("token ".repeat(2000)));
		const submitting = threads.submit({ threadId: "t", conversationId: t.head, requestId: "go", message: "go" }, undefined);
		await threads.remove("t");
		await Promise.allSettled([submitting, idle(harness, t.head)]);

		// The crash shape, made explicit: the conversation OWES work (a run admitted after the removal raced in —
		// boot repair would normally adopt exactly this). The tombstone outranks it: repair promotes nothing.
		await harness.conversation(t.head as ConversationId, BACKGROUND_CONTEXT).then((c) => c!.submit({ type: "input", requestId: "owed", content: "late" }, BACKGROUND_CONTEXT));
		const warnings: string[] = [];
		const reopened = new Threads({ harness, registry: f.registry, onWarn: (m) => warnings.push(m) });
		await reopened.repair();

		const rows = await reopened.list();
		expect(rows.some((row) => row.head === t.head), "the tombstoned, owed conversation stays unthreaded").toBe(false);
		expect(rows, "repair promoted nothing").toEqual([]);
		expect(warnings.join("\n"), `the log says so: ${JSON.stringify(warnings)}`).toContain(String(t.head));

		// Leave no live run behind (the late prompt's stream): abort it, as any owner of a conversation may.
		const late = await harness.conversation(t.head as ConversationId, BACKGROUND_CONTEXT);
		await late!.abort(BACKGROUND_CONTEXT);
		await Promise.allSettled([idle(harness, t.head), sleep(5000)]);
	}, 60_000);
});
