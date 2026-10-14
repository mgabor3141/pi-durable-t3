// Proves the wiring `main.ts` actually installs (`openHostRuntime`): a fresh execution env per call at the
// conversation's `cwd`, with the coding tools available. A thread in project `alpha` runs `bash pwd` and the result is
// alpha's directory — not the process cwd, not another project.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { parseConfigToml } from "../src/config.ts";
import { openHostRuntime } from "../src/host-runtime.ts";
import { createScriptedModel } from "../src/testing/fake-model.ts";
import { idle } from "./threads-harness.ts";

describe("host runtime (main.ts wiring)", () => {
	it("a thread runs `pwd` in its project's directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-runtime-"));
		await mkdir(join(root, "projects/alpha"), { recursive: true });
		await mkdir(join(root, "projects/beta"), { recursive: true });
		const config = parseConfigToml(`listen = "127.0.0.1:1"\n\n[[projects]]\nname = "alpha"\npath = "projects/alpha"\n\n[[projects]]\nname = "beta"\npath = "projects/beta"\n`, root);

		// The model answers the turn with a `bash pwd > pwd.txt`, then finishes — exercising a real tool in the env cwd.
		const steps: FauxResponseStep[] = [
			async () => fauxAssistantMessage([fauxToolCall("bash", { command: "pwd > pwd.txt" })], { stopReason: "toolUse" }),
			async () => fauxAssistantMessage("done"),
		];
		const model = createScriptedModel(steps);
		const runtime = await openHostRuntime(config, model.models, model.modelRef);
		try {
			const thread = await runtime.threads.create({ threadId: "a", projectId: "alpha" });
			await runtime.threads.submit({ threadId: "a", conversationId: thread.head, requestId: "r1", message: "where am I" }, undefined);
			await idle(runtime.harness, thread.head);

			const printed = (await readFile(join(root, "projects/alpha/pwd.txt"), "utf8")).trim();
			expect(printed).toBe(await realpath(join(root, "projects/alpha")));
		} finally {
			await runtime.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
