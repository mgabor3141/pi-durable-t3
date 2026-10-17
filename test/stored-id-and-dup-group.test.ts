// store N6 (LOW): a read-path faithfulness bug a hand-edited `projects.json` reaches. The WRITE path trims a minted
// id, and the contract's `ProjectId` trims on encode, so a padded stored id is SHOWN trimmed; a READ path that
// compared the padded bytes published the trimmed id, then refused to edit/delete that project (`Project … was not
// found`). The read trims, so the id the client is shown is the key that names the project.
// (Former M11 — the duplicate-path group delete — left with the tolerant boot: a duplicate-path file is now a
// strict-parser refusal, so the group cannot boot; the group-wide `remove` stays as the faithful delete.)
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileProjectRegistry, PROJECTS_FILE } from "../src/registry.js";
import { readFile } from "node:fs/promises";

let scratch: string;
beforeAll(async () => { scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-n6m11-")); }, 30_000);
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); }, 30_000);

const write = async (dir: string, doc: unknown) => { await mkdir(dir, { recursive: true }); await writeFile(join(dir, PROJECTS_FILE), JSON.stringify(doc), "utf8"); };

describe("store N6 — a padded stored id is normalized on read", () => {
	it("a hand-edited padded id is published trimmed and names the project for a delete", async () => {
		const dir = join(scratch, "n6");
		await write(dir, { projects: [{ id: "   abc-123-def   ", path: join(dir, "a"), title: "P" }] });
		const reg = FileProjectRegistry.open(dir);
		const listed = reg.list();
		expect(listed.length).toBe(1);
		expect(listed[0]!.id, "the id is published trimmed (the write path and the ProjectId brand trim)").toBe("abc-123-def");
		// The trimmed id the client was given names the project (pre-fix: "Project abc-123-def was not found").
		const removed = reg.remove("abc-123-def");
		expect(removed?.id).toBe("abc-123-def");
		expect(reg.list()).toEqual([]);
	});
});

