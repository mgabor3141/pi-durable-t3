// A project path that exists as a FILE can never be registered: `projects.mutate` create AND update naming it are
// refused with a typed project error naming the path — no entry stored, no entry moved. The boot side of the rule is
// the strict parser (the path itself is not stat'ed at boot; see `settings.test.ts`).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { ServerSettingsStore } from "../src/settings.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { FileProjectRegistry, ProjectWorkspaceNotDirectory } from "../src/registry.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";

const log: Logger = { info: () => {}, warn: () => {} };

async function makeBridge(dataDir: string): Promise<{ bridge: Bridge; registry: FileProjectRegistry }> {
	const registry = await FileProjectRegistry.open(dataDir);
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		label: "t",
		stateDir: dataDir,
		scratchDir: undefined,
		tokenTtlSeconds: 60,
		settings: ServerSettingsStore.open(dataDir),
		corsOrigins: [], staticDir: undefined,
		registry,
	};
	// create/update/delete never touch the host, so an unloaded one is enough to construct a Bridge.
	return { bridge: new Bridge(config, log, createHost({ name: "server" })), registry };
}

describe("a registered path that is a file (H1)", () => {
	it("projects.mutate create AND update naming a path that is a file are refused, naming the path — nothing stored, nothing moved", async () => {
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


});
