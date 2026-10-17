// The boot side of "the registry can never keep the host from binding" (H1): a hand-written registry entry naming an
// existing FILE must not kill the boot. The example's wiring mkdirs every registered cwd; the throw used to precede
// the listener bind, so the UI could not delete the entry that bricked it. Now: the harness warns naming the path,
// the other projects work, and a thread in the bad one fails with the typed `unknown_project` (the threads layer's
// commit-time check), not a crash.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { HostError } from "../../src/host-errors.ts";
import { Threads } from "../../src/threads.ts";
import { openCodingHarness } from "./host-runtime.ts";
import { createScriptedModel } from "../../test/fake-model.ts";
import { testRegistry } from "../../test/test-registry.ts";
import { idle } from "../../test/threads-harness.ts";

describe("a registered path that is a file, at boot (H1)", () => {
	it("the harness warns naming the path, the good project works, a thread in the bad one fails typed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-ws-b-"));
		try {
			const good = join(root, "projects", "good");
			await mkdir(good, { recursive: true });
			const bad = join(root, "bad"); // an existing FILE where a project folder is registered.
			await writeFile(bad, "I am a file, not a folder\n", "utf8");

			const registry = testRegistry([{ id: "good", cwd: good }, { id: "bad", cwd: bad }]);
			const warnings: string[] = [];
			// The boot mkdir used to throw ENOTDIR here, killing the process before the listener could bind.
			const steps: FauxResponseStep[] = [
				async () => fauxAssistantMessage([fauxToolCall("bash", { command: "pwd > pwd.txt" })], { stopReason: "toolUse" }),
				async () => fauxAssistantMessage("done"),
			];
			const model = createScriptedModel(steps);
			const runtime = await openCodingHarness({ dataDir: root }, registry, model.models, { onWarn: (message) => warnings.push(message) });
			const threads = new Threads({ harness: runtime.harness, registry });
			try {
				// The boot warns, naming the bad path (the log is the user's only pointer to the bricking entry).
				expect(warnings.some((w) => w.includes(bad)), `a warning names ${bad}: ${JSON.stringify(warnings)}`).toBe(true);

				// The good project works: a thread there runs `pwd` in its directory.
				const thread = await threads.create({ threadId: "g", projectId: "good" });
				await (await runtime.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
				await threads.submit({ threadId: "g", conversationId: thread.head, requestId: "r1", message: "where" }, undefined);
				await idle(runtime.harness, thread.head);
				expect(await readFile(join(good, "pwd.txt"), "utf8")).toContain("good");

				// The bad project is not silently usable: a thread there fails with the typed project error, naming the path.
				const failure = await threads.create({ threadId: "b", projectId: "bad" }).then(() => undefined, (error: unknown) => error);
				expect(failure, "a thread in the bad project is refused").toBeInstanceOf(HostError);
				expect((failure as HostError).code).toBe("unknown_project");
				expect((failure as HostError).message).toContain(bad);
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
