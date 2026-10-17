// A project's id is minted by whoever registers it; the path is the uniqueness key (review M7 + the wire reviewer's
// Finding 1, closing F4). T3's UI mints a project UUID (`CommandPalette.tsx` `newProjectId()`) and NAVIGATES to it
// (`handleNewThread(scopeProjectRef(env, projectId))`); answering with a path-derived id made the client's project
// lookup miss and the composer render `contenteditable="false"` — the user could not type until a reload. The host
// honors the client's id exactly as it honors client-minted thread ids; the id is derived from the normalized path
// only when none is supplied (integrator-written entries, and the registry's own `add` without a client id).
// Consequences carried here: a root MOVE keeps the id — and therefore the project's threads (no split, no `(other)`
// ghost, F4); a rename is free.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { ServerSettingsStore } from "../src/settings.ts";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { FileProjectRegistry } from "../src/registry.ts";
import { createScriptedModel } from "./fake-model.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

describe("a project id is minted by whoever registers it", () => {
	it("(a) projects.mutate create with a client UUID returns that id, and the shell carries it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-id-a-"));
		try {
			const root = join(dir, "proj");
			await mkdir(root, { recursive: true });
			const registry = await FileProjectRegistry.open(dir);
			const config: BridgeConfig = { host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(join(dir, "settings-store")), corsOrigins: [], registry };
			const bridge = new Bridge(config, log, createHost({ name: "server" }));

			const clientProjectId = randomUUID(); // exactly what `newProjectId()` mints in the web app.
			const created = await bridge.mutateProject({ type: "project.create", projectId: clientProjectId, commandId: "cmd-create-picked", title: "picked", workspaceRoot: root, createWorkspaceRootIfMissing: true });
			expect(created.id).toBe(clientProjectId); // honored, not replaced by a path-derived id

			// The shell carries it: this is what `useProject`/`handleNewThread` look the project up by.
			const shells = bridge.projects();
			expect(shells.map((project) => project.id as string)).toContain(clientProjectId);
			expect(shells.find((project) => project.id === clientProjectId)?.workspaceRoot).toBe(root);
			expect((bridge.shellSnapshot().projects as unknown as { id: string }[]).some((project) => project.id === clientProjectId)).toBe(true);

			// The id is durable: a reopen (the next boot) answers the SAME id for the same folder.
			const reopened = await FileProjectRegistry.open(dir);
			expect(reopened.list().map((project) => project.id)).toContain(clientProjectId);
			expect(reopened.list()[0]?.cwd).toBe(root);

			// A mutation whose id is NOT the UUID shape the T3 UI happens to mint is still a valid mint: the
			// contract's ProjectId is a branded trimmed non-empty string and T3's server commits it verbatim,
			// so the host answers with the id the client sent (review wire NEW-2; pre-fix: silently re-derived).
			const root2 = join(dir, "proj2");
			await mkdir(root2, { recursive: true });
			const derived = await bridge.mutateProject({ type: "project.create", projectId: "placeholder-not-a-uuid", commandId: "cmd-create-other", title: "other", workspaceRoot: root2, createWorkspaceRootIfMissing: true });
			expect(derived.id).toBe("placeholder-not-a-uuid");
		}
		finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

});
