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

	it("(e) a MOVE of a path-derived project keeps its id too — ids never re-derive after first assignment (conc N3, store N5, wire NEW-3)", async () => {
		// The rule: an id is assigned once, stored in the entry on the first mutation that needs it, and kept.
		// A project registered WITHOUT a client id (an integrator entry, a hand-written one, an `add` with no
		// clientId) derives its id from the path — and pre-fix `update` stored an id only when the entry
		// already carried one, so moving such a project minted a NEW id from the NEW path while every thread
		// row kept the OLD one: one project, two sidebar entries, the old one unreachable (a `project.delete`
		// on the ghost id answers not-found — it is not registered).
		const fixture = await makeThreads({ projects: [] });
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-id-e-"));
		try {
			const from = join(dir, "from");
			const to = join(dir, "to");
			await mkdir(from, { recursive: true });
			await mkdir(to, { recursive: true });
			// The REAL file registry (the re-derivation lives in FileProjectRegistry.update): registered with
			// NO client id, so the id derives from the normalized path (the integrator shape).
			const registry = await FileProjectRegistry.open(dir);
			const derived = registry.add("derived", from);
			expect(derived.id, "a client-less registration derives its id from the path").toMatch(/^p-[0-9a-f]{16}$/);
			const { Threads } = await import("../src/threads.ts");
			const threads = new Threads({ harness: fixture.harness, registry, defaultModel: fixture.model.modelRef });
			const host = createHost({ name: "server" });
			await host.load([createServerFacet(threads, fixture.model.models)]);
			await host.ready();
			const bridge = new Bridge(
				{ host: "127.0.0.1", port: 0, label: "t", stateDir: join(dir, "state"), pairingToken: undefined, tokenTtlSeconds: 60, corsOrigins: [], registry },
				log,
				host,
			);
			bridge.start();

			await bridge.createThread({ threadId: "keep-rows", projectId: derived.id });
			expect((await threads.list()).map((thread) => thread.projectId)).toEqual([derived.id]);

			// Move the root through the UI mutation.
			const moved = await bridge.mutateProject({ type: "project.update", projectId: derived.id, commandId: "cmd-move-derived", title: "derived", workspaceRoot: to });
			expect(moved.id, "a move does NOT re-mint the id — even for a path-derived one").toBe(derived.id);

			// The threads resolve: every row's projectId is the registry's project id — no split, no ghost.
			const rows = (await threads.list()).map((thread) => thread.projectId);
			expect(rows, "the rows keep an id the registry answers").toEqual([derived.id]);
			expect(registry.list().map((project) => ({ id: project.id, cwd: project.cwd })), "one entry, at the moved root, under the SAME id").toEqual([{ id: derived.id, cwd: to }]);
			const shell = bridge.shellSnapshot();
			expect((shell.projects as unknown as { id: string; workspaceRoot: string }[]).map((project) => [project.id, project.workspaceRoot]), "the shell shows ONE project: the moved root").toEqual([[derived.id, to]]);
			expect((shell.threads as unknown as { projectId: string }[]).map((thread) => thread.projectId), "the thread sits under the moved project").toEqual([derived.id]);

			// The id is durable: the entry now STORES it, so a reopen (the next boot) answers the same id for
			// the moved folder — nothing re-derives from the new path.
			const reopened = await FileProjectRegistry.open(dir);
			expect(reopened.list().map((project) => ({ id: project.id, cwd: project.cwd })), "the moved entry keeps its id across a restart").toEqual([{ id: derived.id, cwd: to }]);
			await bridge.close();
			await host.close();
		} finally {
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
			const moved = await bridge.mutateProject({ type: "project.update", projectId: clientProjectId, commandId: "cmd-move", title: "moving", workspaceRoot: to });
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
