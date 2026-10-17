// Proves the wiring the example host installs (`openCodingHarness`): a fresh execution env per call at the
// conversation's `cwd`, with the coding tools available. A thread in project `alpha` runs `bash pwd` and the result is
// alpha's directory — not the process cwd, not another project.
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Threads } from "../../../src/threads.ts";
import { openCodingHarness } from "../src/host-runtime.ts";
import { createScriptedModel } from "../../../test/fake-model.ts";
import { testRegistry } from "../../../test/test-registry.ts";
import { idle } from "../../../test/threads-harness.ts";

describe("host runtime (example wiring)", () => {
	it("a thread runs `pwd` in its project's directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-runtime-"));
		await mkdir(join(root, "projects/alpha"), { recursive: true });
		await mkdir(join(root, "projects/beta"), { recursive: true });
		const registry = testRegistry([{ id: "alpha", cwd: join(root, "projects/alpha") }, { id: "beta", cwd: join(root, "projects/beta") }]);

		// The model answers the turn with a `bash pwd > pwd.txt`, then finishes — exercising a real tool in the env cwd.
		const steps: FauxResponseStep[] = [
			async () => fauxAssistantMessage([fauxToolCall("bash", { command: "pwd > pwd.txt" })], { stopReason: "toolUse" }),
			async () => fauxAssistantMessage("done"),
		];
		const model = createScriptedModel(steps);
		const runtime = await openCodingHarness({ dataDir: root }, model.models);
		const threads = new Threads({ harness: runtime.harness, registry });
		try {
			const thread = await threads.create({ threadId: "a", projectId: "alpha" });
			const head = await runtime.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
			await head?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT); // the client names the model.
			await threads.submit({ threadId: "a", conversationId: thread.head, requestId: "r1", message: "where am I" }, undefined);
			await idle(runtime.harness, thread.head);

			const printed = (await readFile(join(root, "projects/alpha/pwd.txt"), "utf8")).trim();
			expect(printed).toBe(await realpath(join(root, "projects/alpha")));
		} finally {
			await runtime.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
