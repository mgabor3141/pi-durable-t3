// One snapshot shape, resolved, everywhere (review conc N16). `FileProjectRegistry.open()` stored the RESOLVED document
// (every project path expanded, resolved under the data dir, and normalized), while `#commit` — every mutation: a
// defaults write, an add, a remove, a move — replaced it with the RAW document on disk. `list()` derives a path id from
// the stored path string (`projectIdForPath` calls `resolve`), so for an entry whose `settings.json` path is RELATIVE
// (the documented "a relative path resolves under the data dir" form) the id recomputed from the un-resolved string
// after the first mutation is a DIFFERENT id:
//
//   - every existing thread row (its FK is the boot id) becomes a row whose `projectId` is not registered;
//   - the shell re-publishes the project under the new id, orphaning every thread (the sidebar splits);
//   - `thread.create` with the id the client navigated with (the boot id) is refused — `Unknown project`.
//
// The id is a function of the RESOLVED path at every read; storing the resolved document after every write is the whole
// fix, so the first mutation cannot re-mint an id from a string whose spelling changes under it. Disk text is untouched
// (a relative path stays relative); only the in-memory snapshot resolves.
//
// Probes, each watched failing against the pre-fix code:
//   (a) boot a registry on a hand-written RELATIVE-path entry; a defaults write / add / remove must not flip its id.
//   (b) a thread row's FK stays registered across a defaults write, and a create with the boot id succeeds.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { Threads } from "../src/threads.ts";
import { FileProjectRegistry, readInstanceFileText } from "../src/registry.ts";
import { parseSettingsJson } from "../src/settings.ts";
import { projectIdForPath } from "../src/project-ids.ts";
import { makeThreads } from "./threads-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-snapshot-"));
afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

it("(a) a defaults write / add / remove must not flip a relative-path entry's derived id (conc N16)", async () => {
	const dir = join(scratch, "defaults-write");
	await mkdir(join(dir, "rel-project"), { recursive: true });
	// The documented relative-path form: a path that resolves under the data dir at read.
	await writeFile(join(dir, "settings.json"), JSON.stringify({ projects: [{ path: "rel-project", title: "rel" }], defaults: {} }), "utf8");

	const registry = await FileProjectRegistry.open(dir);
	const [boot] = registry.list();
	// At boot the id derives from the RESOLVED path, not the raw "rel-project" string.
	expect(boot!.id, "the boot id derives from the resolved absolute path").toBe(projectIdForPath(join(dir, "rel-project")));
	expect(boot!.cwd).toBe(join(dir, "rel-project"));

	registry.setThinkingLevel("high");
	const [after] = registry.list();
	expect(after!.id, `the id is stable across a defaults write (pre-fix it re-derived from the raw relative string): ${boot!.id} -> ${after!.id}`).toBe(boot!.id);

	// An add and a remove flip it too, pre-fix.
	registry.add("abs", join(dir, "abs"));
	expect(registry.list().find((p) => p.name === "rel")!.id, "the derived id survives an add").toBe(boot!.id);
	registry.remove(registry.list().find((p) => p.name === "abs")!.id);
	expect(registry.list().find((p) => p.name === "rel")!.id, "the derived id survives a remove").toBe(boot!.id);

	// The snapshot is a RESOLVED document, and the file on disk stays exactly as written (a relative path stays relative).
	expect(boot!.cwd, "the in-memory snapshot carries the resolved path").toBe(join(dir, "rel-project"));
	expect(JSON.parse(await readInstanceFileText(dir)).projects[0].path, "the disk text is untouched").toBe("rel-project");
});

it("(b) a defaults write keeps every thread row's projectId registered; a create with the boot id succeeds (conc N16)", async () => {
	const dir = join(scratch, "row-fk");
	const projectDir = join(dir, "proj");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(dir, "settings.json"), JSON.stringify({ projects: [{ path: "proj", title: "proj" }], defaults: {} }), "utf8");
	const registry = await FileProjectRegistry.open(dir);
	const bootId = registry.list()[0]!.id;

	// The threads layer reads the SAME file-backed registry, so a row's FK resolves through the real snapshot.
	const f = await makeThreads({ projects: [] });
	const threads = new Threads({ harness: f.harness, registry, defaultModel: f.model.modelRef });

	// A thread launched in the boot project. Its row's FK is the boot id.
	await threads.create({ threadId: "d15-thread", projectId: bootId });
	const rows = await threads.list();
	expect(rows.find((row) => row.threadId === "d15-thread")!.projectId).toBe(bootId);

	// A defaults write (the settings pane) — pre-fix this flips every derived id in the snapshot.
	registry.setThinkingLevel("high");

	const registered = new Set(registry.list().map((p) => p.id));
	const after = await threads.list();
	const unknown = after.filter((row) => !registered.has(row.projectId));
	expect(unknown, `no thread row names an unregistered project: ${JSON.stringify(unknown)}`).toEqual([]);

	// The client creates a thread with the id the shell carries (the boot id): pre-fix `Unknown project`.
	await expect(threads.create({ threadId: "d15-second", projectId: bootId })).resolves.toMatchObject({ threadId: "d15-second", projectId: bootId });

	const finalText = await readInstanceFileText(dir);
	expect(() => parseSettingsJson(finalText, dir), "the file the host wrote parses at boot").not.toThrow();
}, 30_000);
