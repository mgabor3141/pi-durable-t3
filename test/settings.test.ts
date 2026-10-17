// The project registry's file (`projects.json`, in the data dir) and the live registry over it. Parsing: JSON →
// defaults → one schema (`Value.Default`, `additionalProperties: false`, semantic checks after, a `ConfigError`
// printed without a stack). STRICT: the parser is the definition of writable — every rule it enforces is enforced at
// mutation time too, and a file the host cannot read is a refusal naming it (the host does not boot over damage).
// A project's id is derived from its normalized path (the title is a label); duplicate paths and duplicate ids are
// refused. A missing file is VALID — an empty registry. The registry (open/list/add/remove/update) is tested against
// the real file it writes. Temp roots only; `~/.pi` is never touched.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileProjectRegistry, ProjectConflict, ProjectIdConflict, ProjectIdInvalid, ProjectNotFound } from "../src/registry.ts";
import { parseProjectsJson, PROJECTS_FILE } from "../src/registry.ts";
import { ConfigError } from "../src/config.ts";
import { projectIdForPath } from "../src/project-ids.ts";
import { tempRoot } from "./temp-root.ts";

const root = "/srv/data";
const file = (projects: unknown) => JSON.stringify({ projects });

describe("parseProjectsJson", () => {
	it("parses the positive shapes: empty documents, derived ids, basename titles, free labels, minted ids (trimmed), expansion, resolution, normalization", () => {
		expect(parseProjectsJson("{}", root)).toEqual([]);
		expect(parseProjectsJson("", root)).toEqual([]);
		const parsed = parseProjectsJson(file([{ path: `${root}/repos/alpha` }, { path: `${root}/a`, title: "My App" }, { id: "  abc-123  ", path: `${root}/b` }, { id: "   ", path: `${root}/c` }, { path: "work/one" }]), root);
		expect(parsed[0]).toEqual({ id: projectIdForPath(`${root}/repos/alpha`), name: "alpha", cwd: `${root}/repos/alpha` });
		expect(parsed[1]!.name).toBe("My App");
		expect(parsed[2]!.id, "a stored id is honored and trimmed (the contract's ProjectId trims on encode)").toBe("abc-123");
		expect(parsed[3]!.id, "a blank stored id is not a mint: the id derives from the path").toBe(projectIdForPath(`${root}/c`));
		expect(parsed[4]!.cwd, "relative paths resolve under the data dir").toBe(join(root, "work/one"));
	});

	it("STRICT: damage is refused by name, fatal, naming the file — duplicate paths and ids, bad shapes, NUL, unparseable JSON", () => {
		// One rule each: the parser is the definition of writable (mutations enforce the same rules at write time).
		expect(() => parseProjectsJson(file([{ path: `${root}/alpha` }, { path: `${root}/alpha/` }]), root), "`…/alpha` and `…/alpha/` are one project").toThrow(/duplicate project path/);
		expect(() => parseProjectsJson(file([{ id: "x", path: `${root}/a` }, { id: "x", path: `${root}/b` }]), root)).toThrow(/duplicate project id/);
		expect(() => parseProjectsJson(`{"projects":[],"extra":1}`, root)).toThrow(/unknown key "extra"/);
		expect(() => parseProjectsJson(file([{ title: "no path" }]), root)).toThrow(/projects\[0\].*path/);
		expect(() => parseProjectsJson(file([{ path: 1 }]), root)).toThrow(/projects\[0\]\.path/);
		expect(() => parseProjectsJson(file([{ path: "a\u0000b" }]), root)).toThrow(/NUL/);
		expect(() => parseProjectsJson("{ this is not json ,,,", root, "p.json")).toThrow(ConfigError);
		expect(() => parseProjectsJson("{ this is not json ,,,", root, "p.json")).toThrow(/p\.json/);
	});

});

describe("FileProjectRegistry (the real file)", () => {
	it("boot: a missing file is a valid empty registry; an unparseable file refuses to open, naming it", async () => {
		const dir = await tempRoot();
		const registry = FileProjectRegistry.open(dir);
		expect(registry.list()).toEqual([]);
		expect(registry.path).toBe(join(dir, PROJECTS_FILE));
		await writeFile(join(dir, PROJECTS_FILE), "{ nope");
		expect(() => FileProjectRegistry.open(dir)).toThrow(new RegExp(PROJECTS_FILE));
	});

	it("add writes the file, notifies, honors a minted id, and refuses a path that belongs to another project", async () => {
		const dir = await tempRoot();
		const registry = FileProjectRegistry.open(dir);
		let notified = 0;
		registry.subscribe(() => notified++);
		const a = registry.add("alpha", `${dir}/a`, { clientId: "uuid-a" });
		expect(a).toEqual({ id: "uuid-a", name: "alpha", cwd: `${dir}/a` });
		expect(notified).toBe(1);
		expect(JSON.parse(await readFileText(join(dir, PROJECTS_FILE))).projects).toEqual([{ id: "uuid-a", path: `${dir}/a`, title: "alpha" }]);
		expect(() => registry.add("second", `${dir}/a/`)).toThrow(ProjectConflict); // the same folder, spelled differently.
		expect(() => registry.add("clash", `${dir}/b`, { clientId: "uuid-a" })).toThrow(ProjectIdConflict);
		expect(() => registry.add("bad-id", `${dir}/c`, { clientId: "x".repeat(200) })).toThrow(ProjectIdInvalid);
		expect(notified, "a refused mutation notifies nobody").toBe(1);
	});

	it("update renames freely, moves keeping the id (a derived id gets stored on the first update), and refuses a colliding move", async () => {
		const dir = await tempRoot();
		const registry = FileProjectRegistry.open(dir);
		const p = registry.add(undefined, `${dir}/a`); // derived id
		registry.update(p.id, { title: "renamed" });
		expect(registry.list()[0]).toEqual({ id: p.id, name: "renamed", cwd: `${dir}/a` });
		registry.add("other", `${dir}/b`);
		expect(() => registry.update(p.id, { path: `${dir}/b` })).toThrow(ProjectConflict);
		registry.update(p.id, { path: `${dir}/moved` });
		const moved = registry.list().find((project) => project.id === p.id);
		expect(moved, "a move keeps the id — rows that reference it keep resolving").toEqual({ id: p.id, name: "renamed", cwd: `${dir}/moved` });
		// The first update stored the derived id: it is now data, not a re-derivation.
		expect(JSON.parse(await readFileText(join(dir, PROJECTS_FILE))).projects.find((e: { path: string }) => e.path.endsWith("moved")).id).toBe(p.id);
		expect(() => registry.update("nope", { title: "x" })).toThrow(ProjectNotFound);
	});

	it("remove drops the entry and returns it; removing an unknown id is undefined and writes nothing", async () => {
		const dir = await tempRoot();
		const registry = FileProjectRegistry.open(dir);
		const p = registry.add("a", `${dir}/a`);
		expect(registry.remove(p.id)).toEqual({ id: p.id, name: "a", cwd: `${dir}/a` });
		expect(registry.list()).toEqual([]);
		expect(registry.remove(p.id)).toBeUndefined();
	});

	it("the file the host writes always parses: a mutation that would produce a boot-refused document is refused", async () => {
		const dir = await tempRoot();
		const registry = FileProjectRegistry.open(dir);
		registry.add("a", `${dir}/a`, { clientId: "dup" });
		// A peer writes a second entry under the minted id directly to the file; the next mutation reads the file as
		// its base — a document the parser refuses — and the mutation is refused naming the file, leaving it untouched.
		await writeFile(join(dir, PROJECTS_FILE), JSON.stringify({ projects: [{ id: "dup", path: `${dir}/a` }, { id: "dup", path: `${dir}/b` }] }));
		expect(() => registry.add("c", `${dir}/c`)).toThrow(ConfigError);
	});
});

async function readFileText(path: string): Promise<string> {
	const { readFile } = await import("node:fs/promises");
	return readFile(path, "utf8");
}
