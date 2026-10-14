// Opt-in live-model smoke over the real model path (ModelRuntime + the exact main.ts wiring). It is skipped unless
// PI_DURABLE_T3_LIVE_MODEL=<provider>/<model> is set; when set, it reads that model's credentials from your pi config
// in ~/.pi/agent and runs one short turn end to end. The automated suite (`pnpm test`) never hits the network.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { parseConfigToml } from "../src/config.ts";
import { openHostRuntime } from "../src/host-runtime.ts";
import { testRegistry } from "../src/testing/test-registry.ts";
import { conversation, idle } from "./threads-harness.ts";
import { tempRoot } from "./temp-root.ts";

const live = process.env["PI_DURABLE_T3_LIVE_MODEL"];
const slash = live === undefined ? -1 : live.indexOf("/");
const ref = live !== undefined && slash >= 0 ? { provider: live.slice(0, slash), modelId: live.slice(slash + 1) } : undefined;

describe.skipIf(ref === undefined)("live model (PI_DURABLE_T3_LIVE_MODEL)", () => {
	it("answers one short turn", async () => {
		const target = ref!;
		const root = await tempRoot();
		const config = parseConfigToml(`listen = "127.0.0.1:1"\n`, root);
		const registry = testRegistry([{ id: "live", cwd: join(root, "p") }]);

		const runtime = await ModelRuntime.create({ modelsStorePath: join(root, "models-store.json") });
		const available = await runtime.getAvailable();
		expect(available.some((model) => model.provider === target.provider && model.id === target.modelId)).toBe(true);

		const host = await openHostRuntime(config, registry, runtime, target);
		try {
			const thread = await host.threads.create({ threadId: "t", projectId: "live" });
			await host.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "Reply with exactly: ok" }, undefined);
			await idle(host.harness, thread.head);

			const entries = (await conversation(host.harness, thread.head).then((c) => c.context(BACKGROUND_CONTEXT))).entries;
			const assistants = entries.filter((entry) => entry.kind === "pi.assistant");
			expect(assistants.length).toBeGreaterThanOrEqual(1);
			expect(entries.at(-1)?.kind).toBe("pi.assistant"); // the turn ended on a reply, not a tool call or prompt
		} finally {
			await host.close();
		}
	}, 120_000);
});
