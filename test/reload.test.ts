// `/reload` (`Threads.reload`): the next request renders the system prompt afresh. A host that keeps its prompt fixed for a
// thread (a section that answers what is already shown, as claw's do) renders it again only then. The typed command is
// display-only: shown where it was sent, never in the model's context.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import type { TranscriptContext } from "@earendil-works/pi-ai/utils/transcript";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;

type Harness = Awaited<ReturnType<typeof makeThreads>>["harness"];
const entriesOf = async (harness: Harness, head: Parameters<typeof conversation>[1], kind?: string) =>
	(await (await conversation(harness, head)).entries({}, 500, undefined, ctx)).items.filter((entry) => kind === undefined || entry.kind === kind);

/** A section whose source changes, kept as first shown until the prompt is reloaded. */
function fixedSection() {
	const source = { value: "one" };
	const extension = defineExtension({
		name: "fixed",
		sections: [section("fixed", (input) => input.shown.fixed ?? `value: ${source.value}`, { tag: false })],
	});
	return { source, extension };
}

const promptText = (context: TranscriptContext) =>
	context.messages
		.filter((message) => message.role === "system")
		.map((message) => [typeof message.content === "string" ? message.content : "", ...Object.values((message as { sections?: Record<string, string | null> }).sections ?? {})].join("\n"))
		.join("\n");

describe("/reload", () => {
	it("renders a fixed prompt again at the next request, and the command never reaches the model", async () => {
		const { source, extension } = fixedSection();
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		const seen: string[] = [];
		const answer = (text: string) => (context: TranscriptContext): AssistantMessage => {
			seen.push(promptText(context) + "\n" + JSON.stringify(context.messages.filter((message) => message.role === "user")));
			return fauxAssistantMessage(text);
		};
		const turn = async (requestId: string, message: string) => {
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId, message }, undefined);
			await idle(harness, thread.head);
		};
		const systemEntries = async () => (await entriesOf(harness, thread.head, "pi.system")).length;

		model.respond(answer("first"));
		await turn("r1", "hello");
		expect(seen[0]).toContain("value: one");
		const baseline = await systemEntries();

		source.value = "two";
		model.respond(answer("second"));
		await turn("r2", "again");
		expect(seen[1]).toContain("value: one");
		expect(seen[1]).not.toContain("value: two");
		expect(await systemEntries()).toBe(baseline);

		await threads.reload("t", "reload-1");
		model.respond(answer("third"));
		await turn("r3", "and again");
		expect(seen[2]).toContain("value: two");
		expect(seen[2]).not.toContain("/reload");

		const command = (await entriesOf(harness, thread.head, "app.reload"))[0];
		expect(command).toMatchObject({ data: { messageId: "reload-1", text: "/reload" } });
		expect(command?.model).toBeUndefined();
	});

	it("writes nothing to the context after a compaction that has not prepared a request", async () => {
		const { extension } = fixedSection();
		// A section that changes between turns leaves a `pi.system` patch in the kept tail, still shown after the cut.
		const live = { value: "a" };
		const changing = defineExtension({ name: "changing", sections: [section("changing", () => `changing: ${live.value}`, { tag: false })] });
		const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }], extensions: [extension, changing] });
		const create = createNamed(threads, harness, model);
		const thread = await create({ threadId: "t", projectId: "p" });
		const long = "x".repeat(120_000);
		for (const [index, text] of ["one", "two", "three"].entries()) {
			live.value = text;
			model.respond(fauxAssistantMessage(text === "three" ? text : text + long));
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "p" + String(index), message: text }, undefined);
			await idle(harness, thread.head);
		}
		model.respond(fauxAssistantMessage("summary"));
		await threads.compact("t", undefined, "compact-command");
		await idle(harness, thread.head);
		const view = await (await conversation(harness, thread.head)).context(ctx);
		expect(view.messages.some((message) => message.role === "system")).toBe(true);
		const before = (await entriesOf(harness, thread.head, "pi.system")).length;
		await threads.reload("t");
		const after = (await entriesOf(harness, thread.head, "pi.system")).length;
		expect(before).toBeGreaterThan(0);
		expect(after).toBe(before);
	});
});
