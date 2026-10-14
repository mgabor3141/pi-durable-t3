// The registry can never keep the host from binding (H1). A registered project path that is an existing FILE used to
// kill the boot: `openHostRuntime` mkdirs every registered cwd with no catch, and the throw precedes the listener bind,
// so the UI could not delete the entry that bricked it. Two probes:
//   (a) mutation time — `projects.mutate` create/update naming a path that exists as a FILE is refused with a typed
//       project error naming the path, and no entry is stored (a bricked-at-boot entry can never be registered);
//   (b) boot time — a hand-written `settings.json` naming a file: the host opens, warns (naming the path), and the
//       other projects work; a thread in the bad project fails with a typed error (`unknown_project`), not a crash.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { HostError } from "../src/host-errors.ts";
import { parseConfigToml } from "../src/config.ts";
import { openHostRuntime } from "../src/host-runtime.ts";
import { FileProjectRegistry, ProjectWorkspaceNotDirectory } from "../src/registry.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createScriptedModel } from "../src/testing/fake-model.ts";
import { testRegistry } from "../src/testing/test-registry.ts";
import { idle } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

async function makeBridge(dataDir: string): Promise<{ bridge: Bridge; registry: FileProjectRegistry }> {
	const registry = await FileProjectRegistry.open(dataDir);
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		label: "t",
		stateDir: join(dataDir, "state"),
		pairingToken: undefined,
		tokenTtlSeconds: 60,
		corsOrigins: [],
		registry,
	};
	// create/update/delete never touch the host, so an unloaded one is enough to construct a Bridge.
	return { bridge: new Bridge(config, log, createHost({ name: "server" })), registry };
}

describe("a registered path that is a file (H1)", () => {
	it("(a) projects.mutate create with a path naming an existing file is refused, and no entry is stored", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-ws-a-"));
		try {
			const file = join(dir, "afile");
			await writeFile(file, "not a directory\n", "utf8");
			const { bridge, registry } = await makeBridge(dir);

			// The Web UI's add-project sends createWorkspaceRootIfMissing: true — the mkdir must not be swallowed.
			const failure = await bridge.mutateProject({ type: "project.create", projectId: "u1", commandId: "cmd-ws-create-u1", title: "bad", workspaceRoot: file, createWorkspaceRootIfMissing: true }).then(() => undefined, (error: unknown) => error);
			expect(failure, "the create is refused, not answered with success").toBeInstanceOf(Error);
			expect(failure).toBeInstanceOf(ProjectWorkspaceNotDirectory);
			expect((failure as Error).message).toContain(file); // the refusal names the path
			// No entry is stored: the host can never boot into a state it cannot bind with.
			expect(registry.list().some((project) => project.cwd === file)).toBe(false);
			expect(registry.list()).toHaveLength(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("(a) projects.mutate update moving a project onto a file is refused, and the entry keeps its old root", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-ws-a2-"));
		try {
			const good = join(dir, "good");
			await mkdir(good, { recursive: true });
			const file = join(dir, "afile");
			await writeFile(file, "not a directory\n", "utf8");
			const { bridge, registry } = await makeBridge(dir);
			const created = await bridge.mutateProject({ type: "project.create", projectId: "u0", commandId: "cmd-ws-create-u0", title: "good", workspaceRoot: good, createWorkspaceRootIfMissing: true });
			expect(created.workspaceRoot).toBe(good);

			const failure = await bridge.mutateProject({ type: "project.update", projectId: created.id as string, commandId: "cmd-ws-move-onto-file", workspaceRoot: file }).then(() => undefined, (error: unknown) => error);
			expect(failure, "the move is refused, not applied").toBeInstanceOf(ProjectWorkspaceNotDirectory);
			expect((failure as Error).message).toContain(file);
			// The registry is unchanged: the entry still names its good root.
			expect(registry.list().map((project) => project.cwd)).toEqual([good]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("(b) a settings registry naming a file: the host opens, warns, the other projects work, a thread in the bad one fails typed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-ws-b-"));
		try {
			const good = join(root, "projects", "good");
			await mkdir(good, { recursive: true });
			const bad = join(root, "bad"); // an existing FILE where a project folder is registered.
			await writeFile(bad, "I am a file, not a folder\n", "utf8");

			const config = parseConfigToml(`listen = "127.0.0.1:1"\n`, root);
			const registry = testRegistry([{ id: "good", cwd: good }, { id: "bad", cwd: bad }]);
			const warnings: string[] = [];
			// The boot mkdir used to throw ENOTDIR here, killing the process before the listener could bind.
			const steps: FauxResponseStep[] = [
				async () => fauxAssistantMessage([fauxToolCall("bash", { command: "pwd > pwd.txt" })], { stopReason: "toolUse" }),
				async () => fauxAssistantMessage("done"),
			];
			const model = createScriptedModel(steps);
			const runtime = await openHostRuntime(config, registry, model.models, model.modelRef, { onWarn: (message) => warnings.push(message) });
			try {
				// The boot warns, naming the bad path (the log is the user's only pointer to the bricking entry).
				expect(warnings.some((w) => w.includes(bad)), `a warning names ${bad}: ${JSON.stringify(warnings)}`).toBe(true);

				// The good project works: a thread there runs `pwd` in its directory.
				const thread = await runtime.threads.create({ threadId: "g", projectId: "good" });
				await runtime.threads.submit({ threadId: "g", conversationId: thread.head, requestId: "r1", message: "where" }, undefined);
				await idle(runtime.harness, thread.head);
				expect(await readFile(join(good, "pwd.txt"), "utf8")).toContain("good");

				// The bad project is not silently usable: a thread there fails with the typed project error, naming the path.
				const failure = await runtime.threads.create({ threadId: "b", projectId: "bad" }).then(() => undefined, (error: unknown) => error);
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
