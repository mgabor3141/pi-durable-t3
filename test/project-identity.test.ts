// A project's id is minted by whoever registers it; the path is the uniqueness key (review M7 + the wire reviewer's
// Finding 1, closing F4). T3's UI mints a project UUID (`CommandPalette.tsx` `newProjectId()`) and NAVIGATES to it
// (`handleNewThread(scopeProjectRef(env, projectId))`); answering with a path-derived id made the client's project
// lookup miss and the composer render `contenteditable="false"` — the user could not type until a reload. The host
// honors the client's id exactly as it honors client-minted thread ids; the id is derived from the normalized path
// only when none is supplied (integrator-written entries, and the registry's own `add` without a client id).
// Consequences carried here: a root MOVE keeps the id — and therefore the project's threads (no split, no `(other)`
// ghost, F4); a rename is free.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
import { createScriptedModel } from "../src/testing/fake-model.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

describe("a project id is minted by whoever registers it", () => {
	it("(a) projects.mutate create with a client UUID returns that id, and the shell carries it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-id-a-"));
		try {
			const root = join(dir, "proj");
			await mkdir(root, { recursive: true });
			const registry = await FileProjectRegistry.open(dir);
			const config: BridgeConfig = { host: "127.0.0.1", port: 0, label: "t", stateDir: join(dir, "state"), pairingToken: undefined, tokenTtlSeconds: 60, corsOrigins: [], registry };
			const bridge = new Bridge(config, log, createHost({ name: "server" }));

			const clientProjectId = randomUUID(); // exactly what `newProjectId()` mints in the web app.
			const created = await bridge.mutateProject({ type: "project.create", projectId: clientProjectId, title: "picked", workspaceRoot: root, createWorkspaceRootIfMissing: true });
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

			// A mutation WITHOUT a client-minted id (not the UUID shape the T3 UI mints) derives from the path.
			const root2 = join(dir, "proj2");
			await mkdir(root2, { recursive: true });
			const derived = await bridge.mutateProject({ type: "project.create", projectId: "placeholder-not-a-uuid", title: "other", workspaceRoot: root2, createWorkspaceRootIfMissing: true });
			expect(derived.id).toMatch(/^p-[0-9a-f]{16}$/);
		}
		finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("(d) project.update moving a root keeps the id — and therefore the project's threads: no split, no `(other)` ghost (F4)", async () => {
		const fixture = await makeThreads({ projects: [] });
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-id-d-"));
		try {
			const from = join(dir, "from");
			const to = join(dir, "to");
			// The move targets a real folder: T3's `project.update` normalizes the new root WITHOUT creating it
			// (`createIfMissing` is a create-only flag), and the user moves the folder on disk in the real flow.
			await mkdir(from, { recursive: true });
			await mkdir(to, { recursive: true });
			const clientProjectId = randomUUID();
			// The fixture registry is the threads layer's; register the client-minted project on it (the real flow adds
			// through the bridge, which lands the same `{ clientId }` on `registry.add`).
			fixture.registry.add("moving", from, { clientId: clientProjectId });
			const host = createHost({ name: "server" });
			await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
			await host.ready();
			const bridge = new Bridge(
				{ host: "127.0.0.1", port: 0, label: "t", stateDir: join(dir, "state"), pairingToken: undefined, tokenTtlSeconds: 60, corsOrigins: [], registry: fixture.registry },
				log,
				host,
			);
			bridge.start();

			const created = await bridge.createThread({ threadId: "keep-me", projectId: clientProjectId });
			expect(created).toBe("keep-me");
			expect((await fixture.threads.list()).map((thread) => thread.projectId)).toEqual([clientProjectId]);

			// Move the root through the UI mutation (the T3 project-edit dialog sends title+workspaceRoot).
			const moved = await bridge.mutateProject({ type: "project.update", projectId: clientProjectId, title: "moving", workspaceRoot: to });
			expect(moved.id).toBe(clientProjectId); // the id is opaque and stable: a move does NOT re-mint it.

			// The same threads, the same project: one registry entry (the moved one), rows carry the SAME id.
			expect((await fixture.threads.list()).map((thread) => thread.projectId)).toEqual([clientProjectId]);
			expect(fixture.registry.list().map((project) => ({ id: project.id, cwd: project.cwd }))).toEqual([{ id: clientProjectId, cwd: to }]);

			// The shell shows ONE project (the moved root) and no `(other)` ghost at the old path.
			const shell = bridge.shellSnapshot();
			expect((shell.projects as unknown as { id: string; workspaceRoot: string }[]).map((project) => project.workspaceRoot)).toEqual([to]);
			expect((shell.threads as unknown as { projectId: string }[]).map((thread) => thread.projectId)).toEqual([clientProjectId]);
			await bridge.close();
			await host.close();
		}
		finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
