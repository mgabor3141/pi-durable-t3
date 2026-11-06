// The project registry (`registry.ts`), stored in the Harness: the normalized path is the uniqueness key, an id is
// assigned once — the client's when it mints one (T3 stores the client's id verbatim), else derived from the path —
// and never re-derived, so a move keeps the project's threads. A refused mutation changes nothing and notifies nobody.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { ProjectConflict, ProjectIdConflict, ProjectIdInvalid, ProjectNotFound } from "../src/registry.ts";
import { projectIdForPath } from "../src/project-ids.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { tempRoot } from "./temp-root.ts";
import { storedRegistry } from "./test-registry.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

describe("ProjectRegistry", () => {
	it("add notifies, honors a minted id, derives one from the normalized path otherwise, and refuses a taken path or id", async () => {
		const dir = await tempRoot();
		const { registry, close } = await storedRegistry(dir);
		try {
			let notified = 0;
			registry.subscribe(() => notified++);
			expect(await registry.add("alpha", `${dir}/a`, { clientId: "uuid-a" })).toEqual({ id: "uuid-a", name: "alpha", cwd: `${dir}/a` });
			expect(notified).toBe(1);
			await expect(registry.add("second", `${dir}/a/`), "the same folder, spelled differently").rejects.toThrow(ProjectConflict);
			const clash = await registry.add("clash", `${dir}/b`, { clientId: "uuid-a" }).catch((error: unknown) => error as Error);
			expect(clash).toBeInstanceOf(ProjectIdConflict);
			expect((clash as Error).message, "the refusal names the id and the project that owns it").toContain(`${dir}/a`);
			await expect(registry.add("bad-id", `${dir}/c`, { clientId: "x".repeat(200) })).rejects.toThrow(ProjectIdInvalid);
			expect(notified, "a refused mutation notifies nobody").toBe(1);
			const derived = await registry.add(undefined, `${dir}/d/`);
			expect(derived, "a derived id and a basename title").toEqual({ id: projectIdForPath(`${dir}/d`), name: "d", cwd: `${dir}/d` });
		} finally {
			await close();
		}
	});

	it("any id the contract's ProjectId accepts is honored verbatim (trimmed); a blank one is not a mint", async () => {
		const dir = await tempRoot();
		const { registry, close } = await storedRegistry(dir);
		try {
			expect((await registry.add("plain", join(dir, "plain"), { clientId: "not-a-uuid-placeholder" })).id).toBe("not-a-uuid-placeholder");
			expect((await registry.add("spaced", join(dir, "spaced"), { clientId: "  trimmed-id  " })).id).toBe("trimmed-id");
			expect((await registry.add("blank", join(dir, "blank"), { clientId: "   " })).id).toMatch(/^p-[0-9a-f]{16}$/);
		} finally {
			await close();
		}
	});

	it("update renames freely, moves keeping the id, and refuses a colliding move or an unknown id", async () => {
		const dir = await tempRoot();
		const { registry, close } = await storedRegistry(dir);
		try {
			const p = await registry.add(undefined, `${dir}/a`);
			await registry.update(p.id, { title: "renamed" });
			expect(registry.list()[0]).toEqual({ id: p.id, name: "renamed", cwd: `${dir}/a` });
			await registry.add("other", `${dir}/b`);
			await expect(registry.update(p.id, { path: `${dir}/b` })).rejects.toThrow(ProjectConflict);
			await registry.update(p.id, { path: `${dir}/moved` });
			expect(registry.list().find((project) => project.id === p.id), "a move keeps the id").toEqual({ id: p.id, name: "renamed", cwd: `${dir}/moved` });
			await expect(registry.update("nope", { title: "x" })).rejects.toThrow(ProjectNotFound);
		} finally {
			await close();
		}
	});

	it("remove drops the entry and returns it; an unknown id is undefined and notifies nobody", async () => {
		const dir = await tempRoot();
		const { registry, close } = await storedRegistry(dir);
		try {
			const p = await registry.add("a", `${dir}/a`);
			let notified = 0;
			registry.subscribe(() => notified++);
			expect(await registry.remove(p.id)).toEqual({ id: p.id, name: "a", cwd: `${dir}/a` });
			expect(registry.list()).toEqual([]);
			expect(await registry.remove(p.id)).toBeUndefined();
			expect(notified).toBe(1);
		} finally {
			await close();
		}
	});

	it("is durable: the next boot reads the same ids, titles and paths", async () => {
		const dir = await tempRoot();
		const first = await storedRegistry(dir);
		const a = await first.registry.add("alpha", `${dir}/a`, { clientId: "uuid-a" });
		const b = await first.registry.add(undefined, `${dir}/b`);
		await first.registry.update(b.id, { path: `${dir}/b-moved` });
		await first.close();
		const second = await storedRegistry(dir);
		try {
			expect(second.registry.list()).toEqual([a, { id: b.id, name: "b", cwd: `${dir}/b-moved` }]);
		} finally {
			await second.close();
		}
	});
});

describe("projects.mutate over the registry", () => {
	it("answers the id the client minted (the shell carries it), and refuses a taken id with the typed error", async () => {
		const dir = await tempRoot();
		const f = await makeThreads({ projects: [] });
		const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(dir), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
		bridge.start();
		try {
			await mkdir(join(dir, "sso"), { recursive: true });
			const created = await bridge.mutateProject({ type: "project.create", projectId: "sso:project-7", commandId: "cmd-1", title: "plain", workspaceRoot: join(dir, "sso"), createWorkspaceRootIfMissing: true });
			expect(created.id, "the mutation answers the id the client navigated to").toBe("sso:project-7");
			expect(bridge.projects().map((project) => project.id as string), "the shell carries it").toContain("sso:project-7");
			const refused = await bridge
				.mutateProject({ type: "project.create", projectId: "sso:project-7", commandId: "cmd-2", title: "again", workspaceRoot: join(dir, "other"), createWorkspaceRootIfMissing: true })
				.then(() => undefined, (error: unknown) => error);
			expect(refused).toBeInstanceOf(ProjectIdConflict);
			expect(f.registry.list().map((project) => project.id)).toEqual(["sso:project-7"]);
		} finally {
			await bridge.close();
		}
	}, 30_000);
});
