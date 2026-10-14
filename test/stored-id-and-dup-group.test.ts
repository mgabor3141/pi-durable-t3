// store N6 + M11 (LOW): two read-path faithfulness bugs a hand-edited `settings.json` reaches.
//
// N6 — the WRITE path trims a minted id, and the contract's `ProjectId` trims on encode, so a padded stored id is SHOWN
// trimmed; the READ path compared the padded bytes, published the trimmed id, then refused to edit/delete that project
// (`Project … was not found`). The read now trims, so the id the client is shown is the key that names the project.
//
// M11 — a hand-written file can carry two entries under ONE derived id (the same normalized path spelled two ways:
// `…/a` and `…/a/`). The tolerant boot read shows ONE project; `remove(id)` dropped only the FIRST, the second surfaced
// under the same id, the client was told "deleted" while the path stayed registered, and the folder could not be
// re-added. The delete now removes the whole group it names.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileProjectRegistry, readInstanceFileText } from "../src/registry.js";

let scratch: string;
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-n6m11-")); }, 30_000);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); }, 30_000);

const write = async (dir: string, doc: unknown) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, "settings.json"), JSON.stringify(doc), "utf8"); };

describe("store N6 — a padded stored id is normalized on read", () => {
	it("a hand-edited padded id is published trimmed and names the project for a delete", async () => {
		const dir = join(scratch, "n6");
		await write(dir, { projects: [{ id: "   abc-123-def   ", path: join(dir, "a"), title: "P" }], defaults: {} });
		const reg = await FileProjectRegistry.open(dir, () => {});
		const listed = reg.list();
		expect(listed.length).toBe(1);
		expect(listed[0]!.id, "the id is published trimmed (the write path and the ProjectId brand trim)").toBe("abc-123-def");
		// The trimmed id the client was given names the project (pre-fix: "Project abc-123-def was not found").
		const removed = reg.remove("abc-123-def");
		expect(removed?.id).toBe("abc-123-def");
		expect(reg.list()).toEqual([]);
	});
});

describe("store M11 — deleting a boot-loaded duplicate-path group removes the whole group", () => {
	it("the same folder written two ways → one shown project; delete removes both entries and the folder is re-addable", async () => {
		const dir = join(scratch, "m11");
		const a = join(dir, "a");
		await write(dir, { projects: [{ path: a, title: "a" }, { path: `${a}/`, title: "b" }], defaults: {} });
		const warns: string[] = [];
		const reg = await FileProjectRegistry.open(dir, (m) => warns.push(m));
		expect(warns.join("\n"), "the tolerant boot warned about the duplicate path").toMatch(/duplicate project path/);
		const listed = reg.list();
		expect(listed.length, "the duplicate group shows as one project").toBe(1);
		const id = listed[0]!.id;
		// Deleting the shown project removes BOTH raw entries (the whole group under one derived id).
		const removed = reg.remove(id);
		expect(removed?.id).toBe(id);
		expect(reg.list(), "the group is gone, not just the first entry").toEqual([]);
		expect(JSON.parse(await readInstanceFileText(dir)).projects, "the file is clean (no twin left under the id)").toEqual([]);
		// The folder re-adds cleanly — the phantom twin no longer owns the path.
		reg.add("A", a);
		expect(reg.list().map((p) => p.name)).toEqual(["A"]);
	});
});
