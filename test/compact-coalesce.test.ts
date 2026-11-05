// A manual /compact is one summary: a second click while the first summary runs joins it instead of
// starting another compaction of the same cut, and the caller waits until the summary is durable.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { conversation, createNamed, gated, idle, makeThreads } from "./threads-harness.ts";

describe("manual compact", () => {
	it("joins a running compaction instead of starting a second one", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		// Exceed the default 20k-token keep window so there is a prefix to compact.
		const long = "x".repeat(120_000);
		for (const [index, text] of ["one", "two"].entries()) {
			model.respond(fauxAssistantMessage(text + long));
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "p" + String(index), message: text }, undefined);
			await idle(harness, thread.head);
		}
		model.respond(fauxAssistantMessage("summary"));
		await Promise.all([threads.compact("t", undefined, "compact-command"), threads.compact("t", undefined, "compact-command")]);
		const all = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 200, undefined, BACKGROUND_CONTEXT);
		const compactions = all.items.filter((entry) => entry.kind === "pi.compaction");
		expect(compactions).toHaveLength(1);
		expect(all.items.some((entry) => entry.kind === "app.user" && JSON.stringify(entry.model ?? "").includes("/compact"))).toBe(true);
	});

	it("queues a prompt sent while a manual compaction is running", async () => {
		const { threads, harness, model } = await makeThreads();
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		const long = "x".repeat(120_000);
		for (const [index, text] of ["one", "two"].entries()) {
			model.respond(fauxAssistantMessage(text + long));
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "p" + String(index), message: text }, undefined);
			await idle(harness, thread.head);
		}
		const summary = gated("summary");
		model.respond(summary.step);
		const compacting = threads.compact("t", undefined);
		// Wait until the compaction task is live before sending the next prompt.
		for (let tries = 0; tries < 100; tries++) {
			const view = await (await conversation(harness, thread.head)).viewState(BACKGROUND_CONTEXT);
			const live = view.value.docs["pi.live"] as { compactions?: readonly unknown[] } | undefined;
			if ((live?.compactions?.length ?? 0) > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		model.respond(fauxAssistantMessage("queued reply"));
		const queued = await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "queued", message: "queued while compacting" }, "followUp");
		expect(queued).toMatchObject({ status: "queued" });
		summary.release();
		await compacting;
		await idle(harness, thread.head);
		const all = await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT);
		expect(all.items.some((entry) => entry.kind === "pi.user" && JSON.stringify(entry.model ?? "").includes("queued while compacting"))).toBe(true);
		expect(all.items.some((entry) => entry.kind === "pi.assistant" && JSON.stringify(entry.model ?? "").includes("queued reply"))).toBe(true);
	});
});
