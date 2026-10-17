// The removal's promises at the threads layer (review conc N4; the tombstone pins ride with
// `threads-tombstone.test.ts`).
//
// The abort-before-commit window: `remove` interrupts the head, THEN commits the row-drop + tombstone. A
//     prompt admitted in that window — the row still exists, so admission succeeds — keeps streaming after the
//     tombstone lands. The tombstone keeps it from resurrecting the thread; the removal must also win the run:
//     a thread the document has removed has no live turn. Probe: start a long streaming run, begin the removal
//     (its abort lands), admit a second long run in the window, await the removal → the conversation must
//     settle on its own (both runs interrupted), not stream for the ~200 s their tokens would take.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Threads } from "../src/threads.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the removal wins the run", () => {
	it("(b) a prompt admitted in the abort→commit window is interrupted by the removal (conc N4)", async () => {
		// A slow token stream keeps runs in flight and stays INTERRUPTIBLE between tokens (a model step that
		// awaits a test gate is not — an abort would wait on it). 400 tokens at 2/s outlives the whole test.
		const f = await makeThreads({ projects: [{ id: "p" }], tokensPerSecond: 2 });
		const { model } = f;
		// The seam that WIDENS the window, deterministically: the removal's abort is slowed, so a prompt admitted
		// after it is admitted for a fact — the interleaving conc's widened probe proved, at the threads layer.
		// Everything else delegates to the real harness; the runs live on the real conversations.
		const widened = new Proxy(f.harness, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (key === "conversation") {
					return async (...args: Parameters<typeof target.conversation>) => {
						const head = await target.conversation(...args);
						if (head === undefined) return head;
						return new Proxy(head as object, {
							get(h, k) {
								const v = Reflect.get(h, k, h);
								if (k === "abort") return async (ctx: Parameters<typeof head.abort>[0]) => { await head.abort(ctx); await sleep(400); };
								return typeof v === "function" ? (v as (...a: never[]) => unknown).bind(h) : v;
							},
						});
					}
				}
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const threads = new Threads({ harness: widened, registry: f.registry });
		const create = createNamed(threads, f.harness, model);
		const t = await create({ threadId: "doomed", projectId: "p" });
		// Run one is quick to interrupt; run two is a 200 s stream that only an abort can end.
		model.respond(fauxAssistantMessage("ack"), fauxAssistantMessage("y".repeat(400)));

		// Run one is in flight when the removal starts; its (slowed) abort lands, the row-drop commits behind it.
		const running = threads.submit({ threadId: "doomed", conversationId: t.head, requestId: "r1", message: "one" }, undefined);
		await sleep(150);
		const removing = threads.remove("doomed");
		await sleep(650); // run one's turn is done being interrupted; the commit has not landed (the seam holds the abort's await)
		const admitted = await threads.submit({ threadId: "doomed", conversationId: t.head, requestId: "r2", message: "two" }, undefined).then(() => true, () => false);
		await removing;
		await running;
		expect(admitted, "the seam worked: the second prompt was admitted in the abort→commit window").toBe(true);

		// The removal won: the conversation settles on its own. Pre-fix, the admitted run streams for ~200s on a
		// thread the document no longer has — the race below times out first, which is the defect: the tombstone
		// refuses the row, and the run keeps living.
		const settled = await Promise.race([idle(f.harness, t.head).then(() => true), sleep(5000).then(() => false)]);
		expect(settled, "a removed thread has no live turn: the removal interrupts the run admitted in its window").toBe(true);
	}, 30_000);
});
