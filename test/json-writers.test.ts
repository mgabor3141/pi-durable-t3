// One writer for the instance file, unique temp names for both JSON stores (review store F1, conc F3).
//
// The instance file had TWO writers and no merge: `FileProjectRegistry.#setFile` rewrote the WHOLE file from the
// snapshot it loaded at `open()`, and `writeInstanceFile` (settings.ts, used by the fixtures and any second process on
// a shared data dir) wrote it again. Both used the FIXED temp name `<file>.tmp`. Three observable losses:
//
//   - a peer process's edit vanishes: a thinking level written by one host is gone after another host's project add;
//   - the fixed temp name: a crash leaves `<file>.tmp` litter, and a pre-existing temp keeps ITS mode, because
//     `open(2)` applies `mode` only when it CREATES — so the secret file can land 0644;
//   - concurrent writers: the last writer wins, and the losers' mutations are gone without a trace.
//
// The fix: one writer per file, a real read-modify-write under a cross-process lock, unique temp names, chmod before
// the rename, and the parts a writer does not own preserved. The probes below drive the loss from SEPARATE processes,
// because that is where the finding lives.
import { execFile } from "node:child_process";

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileProjectRegistry } from "../src/registry.ts";
import { INSTANCE_FILE } from "../src/settings.ts";
import { writeJsonAtomic } from "../src/t3/json-store.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A child process that opens the registry in ITS OWN address space and runs one mutation — a peer on the same data dir. */
async function peerMutation(root: string, code: string): Promise<{ stdout: string; stderr: string }> {
	// A real child process: its own module registry, its own snapshot of the file, its own writer. Top-level await
	// needs a real ESM file, so the script goes on disk next to the data dir it operates on.
	const script = join(root, `peer-${process.pid}-${Math.random().toString(36).slice(2)}.ts`);
	await writeFile(
		script,
		`import { FileProjectRegistry } from ${JSON.stringify(`${process.cwd()}/src/registry.ts`)};
const registry = await FileProjectRegistry.open(${JSON.stringify(root)});
${code}
`,
		"utf8",
	);
	return new Promise((resolve, reject) => {
		execFile(process.execPath, ["--experimental-strip-types", script], { cwd: process.cwd(), timeout: 60_000 }, (error, stdout, stderr) => {
			void rm(script, { force: true });
			error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr });
		});
	});
}

const readDoc = async (root: string): Promise<{ projects: { id?: string; path: string; title?: string }[]; defaults: Record<string, string> }> =>
	JSON.parse(await readFile(join(root, INSTANCE_FILE), "utf8")) as { projects: { id?: string; path: string; title?: string }[]; defaults: Record<string, string> };

it("a peer process's defaults survive this process's project mutation (store F1)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-onewriter-"));
	await mkdir(join(root, "a"), { recursive: true });
	await mkdir(join(root, "b"), { recursive: true });
	await writeFile(join(root, INSTANCE_FILE), JSON.stringify({ projects: [{ path: join(root, "a"), title: "A" }], defaults: { thinkingLevel: "off" } }), "utf8");

	// Two hosts on one data dir (the dev path: run.sh + live-smoke): each opened the file at its own start.
	const mine = await FileProjectRegistry.open(root);
	// The peer sets a thinking level and a default model.
	await peerMutation(root, `registry.setThinkingLevel("high"); registry.setModel({ provider: "pi", modelId: "probe-model" });`);

	// This process now registers a project. Pre-fix, its write carried the snapshot from open(): the peer's thinking
	// level and model are gone from the file, silently.
	mine.add("B", join(root, "b"));

	const doc = await readDoc(root);
	expect(doc.defaults.thinkingLevel, "the peer's thinking level survived this host's write").toBe("high");
	expect(doc.defaults.model, "the peer's default model survived this host's write").toBe("pi/probe-model");
	// Both projects: the merge keeps the peer's entries, and this host's add lands.
	expect(doc.projects.map((project) => project.title).sort()).toEqual(["A", "B"]);
}, 90_000);

it("a pre-existing temp file cannot set the mode of the file that is renamed into place (conc F3)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-tmp-"));
	const file = join(root, INSTANCE_FILE);
	await writeFile(file, JSON.stringify({ projects: [], defaults: {} }), "utf8");
	// A crashed writer left `<file>.tmp` behind, group-readable. `writeFileSync(..., {mode})` does NOT change the mode
	// of a file that already exists, so the rename published a 0644 instance file. A writer that uses the SAME name
	// also inherits it; a writer with its own unique name cannot touch it.
	const tmp = `${file}.tmp`;
	await writeFile(tmp, `{ "projects": [], "defaults": {} }\n`, { mode: 0o644 });
	const litterBefore = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp")).sort();
	const registry = await FileProjectRegistry.open(root);
	registry.setThinkingLevel("low");
	expect((await stat(file)).mode & 0o777, "the instance file is owner-only").toBe(0o600);
	expect(JSON.parse(await readFile(file, "utf8")).defaults.thinkingLevel, "the write landed").toBe("low");
	// The writer left no litter of its own. The legacy temp file is not its to delete: it is a file this writer never
	// created, and a writer that unlinked files it does not own would be deleting a peer's in-flight work.
	const litterAfter = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")).sort();
	expect(litterAfter, "the write created no temp or lock files").toEqual(litterBefore);
}, 30_000);

it("auth.json's mode is owner-only even when its temp file was not (conc F3)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-auth-"));
	const file = join(root, "auth.json");
	await writeJsonAtomic(file, { environmentId: "e1", pairings: [], tokens: [] });
	expect((await stat(file)).mode & 0o777, "a fresh secret file is owner-only").toBe(0o600);
	const tmp = `${file}.tmp`;
	await writeFile(tmp, "{}\n", { mode: 0o644 });
	await chmod(file, 0o644); // a pre-fix write that inherited the temp file's mode
	const litterBefore = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp")).sort();
	await writeJsonAtomic(file, { environmentId: "e1", pairings: [], tokens: [{ hash: "h", label: "l", createdAt: 0, expiresAt: 1e12 }] });
	expect((await stat(file)).mode & 0o777, "the secret file is owner-only after a write").toBe(0o600);
	const litterAfter = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")).sort();
	expect(litterAfter, "the write created no temp or lock files").toEqual(litterBefore);
}, 30_000);

it("concurrent writers on one instance file: every mutation lands, the file parses, no litter (store F1, conc F3)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-race-"));
	await writeFile(join(root, INSTANCE_FILE), JSON.stringify({ projects: [], defaults: {} }), "utf8");
	const writers = Array.from({ length: 8 }, (_, i) => peerMutation(root, `registry.add("p${i}", ${JSON.stringify(`${root}/p${i}`)});`));
	const settled = await Promise.allSettled(writers);
	expect(settled.filter((result) => result.status === "fulfilled").length, `all 8 writers succeeded: ${JSON.stringify(settled.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason))))}`).toBe(8);
	const doc = await readDoc(root);
	expect(doc.projects.map((project) => project.title).sort(), "every writer's project is in the file").toEqual(Array.from({ length: 8 }, (_, i) => `p${i}`).sort());
	const litter = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
	expect(litter, "no temp or lock files are left behind").toEqual([]);
}, 120_000);

it("two processes issuing pairing codes on one state dir: both codes work (conc F3)", async () => {
	const stateDir = await mkdtemp(join(tmpdir(), "pi-durable-t3-pair-"));
	// Each process issues a code through the real store, then exchanges BOTH codes. Pre-fix the second write carried the
	// document its own reader had taken before the peer's write landed, so the peer's code was gone from the file: the
	// exchange answered "Invalid pairing code" for a code that had been issued a moment ago.
	const script = join(stateDir, "pair.ts");
	await writeFile(
		script,
		`import { AuthStore } from ${JSON.stringify(`${process.cwd()}/src/t3/auth.ts`)};
const store = new AuthStore(${JSON.stringify(stateDir)}, { tokenTtlSeconds: 3600 });
const code = store.createPairingCode();
// The barrier that makes this a race and not a coincidence: every peer's write has landed before this process reads
// the file again. With a whole-document writer the last write wins, and the codes the earlier writers issued are gone.
await new Promise((r) => setTimeout(r, 800));
const outcome = store.exchange(code, "peer-" + process.pid);
console.log(JSON.stringify({ code, exchanged: outcome !== undefined }));
`,
		"utf8",
	);
	const runs = Array.from({ length: 4 }, () =>
		new Promise<string>((resolve, reject) =>
			execFile(process.execPath, ["--experimental-strip-types", script], { cwd: process.cwd(), timeout: 60_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))),
		),
	);
	const results = (await Promise.all(runs)).map((line) => JSON.parse(line.trim().split("\n").at(-1)!) as { code: string; exchanged: boolean });
	expect(results.every((result) => result.exchanged), `every process exchanged the code it issued: ${JSON.stringify(results)}`).toBe(true);
	// Every issued code was consumed: a code that survived a failed exchange is state the store lost track of.
	const file = JSON.parse(await readFile(join(stateDir, "auth.json"), "utf8")) as { pairings: unknown[]; tokens: { hash: string }[] };
	expect(file.pairings, "no pairing code is left behind").toEqual([]);
	expect(file.tokens.length, "one token per issued code").toBe(4);
}, 120_000);

it("concurrent writers on auth.json: every token is in the file, and it parses (conc F3)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-authrace-"));
	const file = join(root, "auth.json");
	await writeJsonAtomic(file, { environmentId: "e1", pairings: [], tokens: [] });
	const script = join(root, "auth-writer.ts");
	await writeFile(
		script,
		// Exactly the store's shape of work: read the document, add one entry, write it back. Serialized, all 48 entries
		// are in the file; racing a fixed temp name, writers crash on a rename whose temp file a peer took, and entries
		// written between a reader's read and its write disappear.
		`import { updateJsonAtomic } from ${JSON.stringify(`${process.cwd()}/src/t3/json-store.ts`)};
const file = ${JSON.stringify(file)};
type Doc = { environmentId: string; pairings: unknown[]; tokens: { hash: string }[] };
for (let i = 0; i < 12; i++) {
	updateJsonAtomic<Doc>(file, { environmentId: "e1", pairings: [], tokens: [] }, (doc) => ({ ...doc, tokens: [...doc.tokens, { hash: process.pid + "-" + i }] }));
	await new Promise((r) => setTimeout(r, 2));
}
`,
		"utf8",
	);
	const writers = Array.from({ length: 4 }, () =>
		new Promise<void>((resolve, reject) =>
			execFile(process.execPath, ["--experimental-strip-types", script], { cwd: process.cwd(), timeout: 60_000 }, (error) => (error ? reject(error) : resolve())),
		),
	);
	const settled = await Promise.allSettled(writers);
	expect(settled.filter((result) => result.status === "fulfilled").length).toBe(4);
	const doc = JSON.parse(await readFile(file, "utf8")) as { tokens: { hash: string }[] };
	// Without a lock, the read-modify-write loops clobber each other and tokens vanish. With one, all 48 are present.
	expect(doc.tokens.length, "every concurrent token write is in the file").toBe(4 * 12);
	const litter = (await import("node:fs")).readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
	expect(litter, "no temp or lock files are left behind").toEqual([]);
}, 120_000);
