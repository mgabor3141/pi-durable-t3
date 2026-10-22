// Opt-in live-model smoke over the real model path (ModelRuntime + the example's wiring). It is skipped unless
// PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> is set; when set, it reads that model's credentials from your pi config
// in ~/.pi/agent and runs one short turn end to end. The automated suite (`pnpm test`) never hits the network.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId } from "@earendil-works/pi-durable";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Threads } from "../../../src/threads.ts";
import { openCodingHarness } from "../src/host-runtime.ts";
import { Subagent } from "../src/subagent.ts";
import { testRegistry } from "../../../test/test-registry.ts";
import { conversation, idle } from "../../../test/threads-harness.ts";
import { tempRoot } from "../../../test/temp-root.ts";

const live = process.env["PI_DURABLE_T3_LIVE_MODEL"];
const slash = live === undefined ? -1 : live.indexOf("/");
const ref = live !== undefined && slash >= 0 ? { provider: live.slice(0, slash), modelId: live.slice(slash + 1) } : undefined;

describe.skipIf(ref === undefined)("live model (PI_DURABLE_T3_LIVE_MODEL)", () => {
	it("answers one short turn", async () => {
		const target = ref!;
		const root = await tempRoot();
		const registry = testRegistry([{ id: "live", cwd: join(root, "p") }]);
		await mkdir(join(root, "p"), { recursive: true });

		const runtime = await ModelRuntime.create({ modelsStorePath: join(root, "models-store.json") });
		const available = await runtime.getAvailable();
		expect(available.some((model) => model.provider === target.provider && model.id === target.modelId)).toBe(true);

		const host = await openCodingHarness({ dataDir: root }, runtime);
		const threads = new Threads({ harness: host.harness, registry });
		try {
			const thread = await threads.create({ threadId: "t", projectId: "live" });
			await (await host.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: target }, BACKGROUND_CONTEXT); // the client names the model.
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "Reply with exactly: ok" }, undefined);
			await idle(host.harness, thread.head);

			const entries = (await conversation(host.harness, thread.head).then((c) => c.context(BACKGROUND_CONTEXT))).entries;
			const assistants = entries.filter((entry) => entry.kind === "pi.assistant");
			expect(assistants.length).toBeGreaterThanOrEqual(1);
			expect(entries.at(-1)?.kind).toBe("pi.assistant"); // the turn ended on a reply, not a tool call or prompt
		} finally {
			await host.close();
		}
	}, 120_000);

	it("delegates to the subagent tool: the call owns a child that answered", async () => {
		const target = ref!;
		const root = await tempRoot();
		const registry = testRegistry([{ id: "live", cwd: join(root, "p") }]);
		await mkdir(join(root, "p"), { recursive: true });
		const runtime = await ModelRuntime.create({ modelsStorePath: join(root, "models-store.json") });
		const host = await openCodingHarness({ dataDir: root }, runtime, { extensions: [Subagent] });
		const threads = new Threads({ harness: host.harness, registry });
		try {
			const thread = await threads.create({ threadId: "t", projectId: "live" });
			await (await host.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: target }, BACKGROUND_CONTEXT);
			await threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "Use the subagent tool, with the prompt \"Reply with exactly: ok\", then tell me what it answered." }, undefined);
			await idle(host.harness, thread.head);
			const owned = await threads.subagents();
			expect(owned.length).toBeGreaterThanOrEqual(1);
			expect(owned[0]!.parentThreadId).toBe("t");
		} finally {
			await host.close();
		}
	}, 180_000);
});
