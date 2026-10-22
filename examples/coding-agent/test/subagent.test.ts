// The example's `subagent` tool: the call creates a child conversation its task OWNS, the child runs the prompt on a copy
// of the parent's agent WITHOUT the tool (no recursion), and the child's answer is the call's output. The call's
// details name the child on its result entry.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { type ConversationId } from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { createScriptedModel } from "../../../test/fake-model.ts";
import { idle } from "../../../test/threads-harness.ts";
import { openCodingHarness } from "../src/host-runtime.ts";
import { Subagent } from "../src/subagent.ts";

const ctx = BACKGROUND_CONTEXT;

it("a subagent call creates an owned child, runs the prompt there without the tool, and returns the answer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-subagent-"));
	const steps: FauxResponseStep[] = [
		async () => fauxAssistantMessage([fauxToolCall("subagent", { prompt: "Name a prime.", description: "primes" }, { id: "call-1" })], { stopReason: "toolUse" }),
		async () => fauxAssistantMessage("7"),
		async () => fauxAssistantMessage("The subagent said 7."),
	];
	const model = createScriptedModel(steps);
	const runtime = await openCodingHarness({ dataDir: root }, model.models, { extensions: [Subagent] });
	try {
		const parent = await runtime.harness.root(ctx, { agent: { model: model.modelRef } });
		await (await parent.submit({ type: "input", content: "delegate" }, ctx)).wait(ctx);
		await idle(runtime.harness, parent.id);

		const children = await runtime.harness.commit(async (tx) => (await tx.scanConversations({ ownerConversationId: parent.id }, 10)).items, ctx);
		expect(children).toHaveLength(1);
		const child = children[0]!;
		expect(child.owner?.conversationId).toBe(parent.id);
		// No recursion: the child's resolved agent has the coding tools but not the subagent extension; the parent has both.
		const toolNames = async (id: ConversationId) => (await (await runtime.harness.conversation(id, ctx))!.agent(ctx)).tools?.map((tool) => tool.name) ?? [];
		expect(await toolNames(parent.id)).toContain("subagent");
		const childTools = await toolNames(child.id as ConversationId);
		expect(childTools).toContain("bash");
		expect(childTools).not.toContain("subagent");

		// The call's result entry: the child's answer as output, the child named in details, and the task that owns the child.
		const view = await (await runtime.harness.conversation(parent.id, ctx))!.context(ctx);
		const result = view.entries.find((entry) => entry.model?.[0]?.role === "toolResult")!;
		const message = result.model![0] as unknown as { content: { text: string }[]; details: unknown };
		expect(message.content[0]!.text).toBe("7");
		expect(message.details).toEqual({ conversationId: child.id });
		expect(result.byTaskId).toBe(child.owner?.taskId);

		// The child's transcript holds the prompt and the answer.
		const childView = await (await runtime.harness.conversation(child.id as ConversationId, ctx))!.context(ctx);
		expect(childView.entries.some((entry) => JSON.stringify(entry.model).includes("Name a prime."))).toBe(true);
	} finally {
		await runtime.close();
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
