// The instance file (`settings.json`) — the tier a UI edits — and the live registry over it. Parsing: JSON → defaults →
// one schema (`Value.Default`, `additionalProperties: false`, semantic checks after, a `ConfigError` printed without a
// stack). A project's id is derived from its normalized path (the title is a label); a duplicate path is refused. A
// missing file is VALID — an empty registry. The registry (open/list/add/remove/update/defaults) is tested against the
// real file it writes. Temp roots only; `~/.pi` is never touched.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileProjectRegistry, ProjectConflict, ProjectNotFound } from "../src/registry.ts";
import { loadInstanceFile, parseSettingsJson, writeInstanceFile, THINKING_LEVELS } from "../src/settings.ts";
import { projectIdForPath } from "../src/project-ids.ts";
import { tempRoot } from "./temp-root.ts";

const root = "/srv/data";

describe("parseSettingsJson", () => {
	it("an empty object is valid: an empty registry, defaults", () => {
		const parsed = parseSettingsJson("{}", root);
		expect(parsed.projects).toEqual([]);
		expect(parsed.model).toBeUndefined();
		expect(parsed.thinkingLevel).toBe("off");
	});

	it("an empty file is valid (defaults)", () => {
		expect(parseSettingsJson("", root).projects).toEqual([]);
	});

	it("a project id is derived from its path; the title defaults to the basename", () => {
		const parsed = parseSettingsJson(`{"projects":[{"path":"${root}/repos/alpha"}]}`, root);
		expect(parsed.projects[0]).toEqual({ id: projectIdForPath(`${root}/repos/alpha`), title: "alpha", cwd: `${root}/repos/alpha` });
	});

	it("a title is a free label (does not change the id)", () => {
		const parsed = parseSettingsJson(`{"projects":[{"path":"${root}/a","title":"My App"}]}`, root);
		expect(parsed.projects[0]!.title).toBe("My App");
		expect(parsed.projects[0]!.id).toBe(projectIdForPath(`${root}/a`));
	});

	it("a relative path resolves under the data dir", () => {
		const parsed = parseSettingsJson(`{"projects":[{"path":"work/one"}]}`, root);
		expect(parsed.projects[0]!.cwd).toBe(join(root, "work/one"));
	});

	it("a duplicate normalized path is refused, naming it a path with a label title", () => {
		expect(() => parseSettingsJson(`{"projects":[{"path":"${root}/a","title":"one"},{"path":"a","title":"two"}]}`, root)).toThrow(/duplicate project path/i);
	});

	it("defaults.model must be provider/model", () => {
		expect(() => parseSettingsJson(`{"defaults":{"model":"noslash"}}`, root)).toThrow(/defaults\.model .* must be provider\/model/);
		expect(parseSettingsJson(`{"defaults":{"model":"anthropic/claude-sonnet-4-5"}}`, root).model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("defaults.thinkingLevel must be a known level", () => {
		expect(() => parseSettingsJson(`{"defaults":{"thinkingLevel":"turbo"}}`, root)).toThrow(/defaults\.thinkingLevel "turbo" must be one of/);
		expect(parseSettingsJson(`{"defaults":{"thinkingLevel":"high"}}`, root).thinkingLevel).toBe("high");
	});

	it("unknown keys are rejected (naming the file and key path)", () => {
		expect(() => parseSettingsJson(`{"projects":[],"theme":"dark"}`, root)).toThrow(/unknown key "theme"/);
		expect(() => parseSettingsJson(`{"projects":[{"path":"a","label":"x"}]}`, root)).toThrow(/projects\[0\]\.unknown key "label"/);
		expect(() => parseSettingsJson(`{"defaults":{"colour":"red"}}`, root)).toThrow(/defaults\.unknown key "colour"/);
	});

	it("a project path must be non-empty", () => {
		expect(() => parseSettingsJson(`{"projects":[{"path":""}]}`, root)).toThrow(/projects\[0\]\.path/);
	});

	it("a missing file loads as an empty registry (not an error)", async () => {
		const dir = await tempRoot();
		const loaded = await loadInstanceFile(dir);
		expect(loaded.projects).toEqual([]);
		expect(loaded.thinkingLevel).toBe("off");
	});

	it("a file on disk parses", async () => {
		const dir = await tempRoot();
		await writeFile(join(dir, "settings.json"), JSON.stringify({ projects: [{ path: join(dir, "a") }] }));
		const loaded = await loadInstanceFile(dir);
		expect(loaded.projects[0]!.cwd).toBe(join(dir, "a"));
	});
});

describe("FileProjectRegistry", () => {
	it("opens empty from a missing file, and reads its own path", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		expect(registry.list()).toEqual([]);
		expect(registry.defaults()).toEqual({ model: undefined, thinkingLevel: "off" });
		expect(registry.path).toBe(join(dir, "settings.json"));
	});

	it("add registers a project (path-derived id) and writes the file", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const project = registry.add("Alpha", join(dir, "a"));
		expect(project.id).toBe(projectIdForPath(join(dir, "a")));
		expect(registry.list()).toEqual([{ id: project.id, name: "Alpha", cwd: join(dir, "a") }]);
		// The file is the source of truth: reopen and the project is there with the same (derived) id.
		const reopened = await FileProjectRegistry.open(dir);
		expect(reopened.list()).toEqual([{ id: project.id, name: "Alpha", cwd: join(dir, "a") }]);
	});

	it("add refuses a duplicate path (T3 refuses it too)", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const first = registry.add("one", join(dir, "a"));
		expect(() => registry.add("two", join(dir, "a"))).toThrow(ProjectConflict);
		expect(() => registry.add("two", join(dir, "a"))).toThrow(/already belongs to project/);
		// The path spelled differently (relative under the data dir) is the same path, and refused.
		expect(() => registry.add("three", "a")).toThrow(ProjectConflict);
		// A distinct path is accepted.
		expect(registry.add("three", join(dir, "b")).id).not.toBe(first.id);
	});

	it("(c) the uniqueness key is the NORMALIZED path: …/alpha and …/alpha/ are one project, refused as a duplicate", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const alpha = join(dir, "alpha");
		const first = registry.add("alpha", alpha);
		// A trailing slash is the same folder — the old unnormalized string compare made them "two projects, one id",
		// and deleting one resurrected the other (M8).
		expect(() => registry.add("alpha again", `${alpha}/`)).toThrow(ProjectConflict);
		// A redundant segment is the same folder too.
		expect(() => registry.add("alpha again", join(dir, "alpha", "."))).toThrow(ProjectConflict);
		expect(registry.list()).toHaveLength(1);
		// Re-registering the SAME project under its own trailing-slash spelling is its own id (a move onto oneself is no move).
		const same = registry.update(first.id, { path: `${alpha}/` });
		expect(same.id).toBe(first.id);
		expect(registry.list()).toHaveLength(1);
		// A hand-written file with the two spellings is one path, refused at parse.
		expect(() => parseSettingsJson(JSON.stringify({ projects: [{ path: alpha }, { path: `${alpha}/` }] }), dir)).toThrow(/duplicate project path/);
	});

	it("add honors a client-minted id (the UUID T3's UI sends); it is stored, and a reopen answers the same id", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const clientId = "550e8400-e29b-41d4-a716-446655440000";
		const project = registry.add("Picked", join(dir, "a"), { clientId });
		expect(project.id).toBe(clientId);
		expect(registry.list()).toEqual([{ id: clientId, name: "Picked", cwd: join(dir, "a") }]);
		// The id is stored in the instance file (the client navigates by it; nothing may re-mint it on restart).
		const stored = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { projects: Record<string, unknown>[] };
		expect(stored.projects[0]).toMatchObject({ id: clientId, path: join(dir, "a") });
		// A reopen answers the same id; the path stays the uniqueness key.
		const reopened = await FileProjectRegistry.open(dir);
		expect(reopened.list()[0]?.id).toBe(clientId);
		expect(() => reopened.add("dupe", join(dir, "a"))).toThrow(ProjectConflict);
		// A title rename is free (keeps the id); a move keeps the id too (the project's threads follow — see F4).
		expect(reopened.update(clientId, { title: "Renamed" }).id).toBe(clientId);
		expect(reopened.update(clientId, { path: join(dir, "b") })).toMatchObject({ id: clientId, cwd: join(dir, "b") });
		// Any id the contract's `ProjectId` accepts is a mint: a branded TRIMMED NON-EMPTY STRING
		// (`vendor/contracts/src/baseSchemas.ts`), and T3's server commits the client's id verbatim
		// (`apps/server/src/project/ProjectService.ts`). The host stores what the client minted — the old
		// UUID-shape gate silently re-derived everything else (review wire NEW-2).
		const placeholder = registry.add("P2", join(dir, "c"), { clientId: "client-minted" });
		expect(placeholder.id).toBe("client-minted");
	});

	it("remove drops the entry and persists", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const project = registry.add("A", join(dir, "a"));
		expect(registry.remove(project.id)).toEqual(project);
		expect(registry.list()).toEqual([]);
		expect(registry.remove(project.id)).toBeUndefined();
		const reopened = await FileProjectRegistry.open(dir);
		expect(reopened.list()).toEqual([]);
	});

	it("update renames (title is a label; id unchanged) and refuses a move onto another path", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		const a = registry.add("A", join(dir, "a"));
		const b = registry.add("B", join(dir, "b"));
		const renamed = registry.update(a.id, { title: "Renamed" });
		expect(renamed).toEqual({ id: a.id, name: "Renamed", cwd: join(dir, "a") });
		// A move onto b's path collides.
		expect(() => registry.update(a.id, { path: join(dir, "b") })).toThrow(ProjectConflict);
		expect(() => registry.update("nope", { title: "x" })).toThrow(ProjectNotFound);
	});

	it("setModel / setThinkingLevel update the defaults and persist", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		registry.setModel({ provider: "anthropic", modelId: "sonnet" });
		registry.setThinkingLevel("high");
		expect(registry.defaults()).toEqual({ model: { provider: "anthropic", modelId: "sonnet" }, thinkingLevel: "high" });
		const reopened = await FileProjectRegistry.open(dir);
		expect(reopened.defaults()).toEqual({ model: { provider: "anthropic", modelId: "sonnet" }, thinkingLevel: "high" });
		// null clears the model default (→ first available).
		registry.setModel(null);
		expect(registry.defaults().model).toBeUndefined();
		// An unknown thinking level is ignored (the value stays).
		registry.setThinkingLevel("nope");
		expect(registry.defaults().thinkingLevel).toBe("high");
	});

	it("subscribe fires on a mutation, and unsubscribe stops it", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		let count = 0;
		const stop = registry.subscribe(() => count++);
		registry.add("A", join(dir, "a"));
		expect(count).toBe(1);
		stop();
		registry.add("B", join(dir, "b"));
		expect(count).toBe(1);
	});

	it("the written file stores paths and titles (never ids)", async () => {
		const dir = await tempRoot();
		const registry = await FileProjectRegistry.open(dir);
		registry.add("Alpha", join(dir, "a"));
		const text = await readFile(join(dir, "settings.json"), "utf8");
		const stored = JSON.parse(text) as { projects: { path: string; title?: string }[]; defaults: Record<string, unknown> };
		expect(stored.projects).toEqual([{ path: join(dir, "a"), title: "Alpha" }]);
		expect(stored.projects[0]).not.toHaveProperty("id");
	});

	it("writeInstanceFile round-trips the raw shape", async () => {
		const dir = await tempRoot();
		await writeInstanceFile(dir, { projects: [{ path: join(dir, "a"), title: "A" }], defaults: { model: "p/m", thinkingLevel: "low" } });
		const loaded = await loadInstanceFile(dir);
		expect(loaded.projects[0]).toEqual({ id: projectIdForPath(join(dir, "a")), title: "A", cwd: join(dir, "a") });
		expect(loaded.model).toEqual({ provider: "p", modelId: "m" });
		expect(loaded.thinkingLevel).toBe("low");
	});

	it("THINKING_LEVELS is the pi-ai set", () => {
		expect(THINKING_LEVELS).toContain("off");
		expect(THINKING_LEVELS).toContain("xhigh");
	});
});
