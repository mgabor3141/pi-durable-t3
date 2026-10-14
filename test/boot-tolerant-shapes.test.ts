// store M3 (MEDIUM): the tolerant boot read stopped at the schema. `Value.Errors` ran on the WHOLE document
// before the entry loop, so every per-entry shape violation (a deleted `path`, an `id` typed as a number, a stray
// key on one entry) was a document-level refusal — the boot threw and exited 1 before the listener bound, the
// exact shape the tolerant read of the semantic checks (duplicate path/id, unusable path) exists to prevent. The
// rule extended: anything about a project ENTRY that is wrong is warned and skipped (there is an entry to skip);
// a document-level shape (no top-level object, `projects` not an array, `defaults` malformed) stays fatal (there
// is nothing to skip); and a file that is not JSON at all is served as an EMPTY registry with a warning, binding
// anyway — and READ-ONLY: every mutation re-reads it with the strict reader and is refused, so the empty registry
// is never written over the entries the broken file holds. The reviewer's 26 hand-edit shapes are the table.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileProjectRegistry } from "../src/registry.js";
import { parseSettingsJson, type ResolvedInstance } from "../src/settings.js";
import { launch, type Launched } from "./host-process-harness.js";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.js";

let scratch: string;
const launched: Launched[] = [];

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "pi-durable-m3-"));
}, 30_000);

afterAll(async () => {
	for (const host of launched) {
		try { host.child.kill("SIGKILL"); } catch { /* exited */ }
	}
	await rm(scratch, { recursive: true, force: true });
}, 30_000);

const TOKEN = "777777";

// The reviewer's hand-edit shapes, grouped by what the tolerant boot must do with each.
type Outcome = "skip" | "empty" | "fatal";

// Per-entry shape slips: the entry cannot be honored, so it is skipped with a warning and the rest of the file
// still boots. (Each shape is paired with a valid entry, so the table proves the valid one SURVIVES the skip.)
const PER_ENTRY: readonly (readonly [string, unknown])[] = [
	["entry: {} (no path)", [{ title: "x" }, { path: "good" }]],
	["entry: path is a number", [{ path: 5 }, { path: "good" }]],
	["entry: extra key", [{ path: "a", label: "x" }, { path: "good" }]],
	["entry: id is a number", [{ path: "a", id: 5 }, { path: "good" }]],
	["entry: id is the empty string", [{ path: "a", id: "" }, { path: "good" }]],
	["entry: id is 129 chars", [{ path: "a", id: "x".repeat(129) }, { path: "good" }]],
	["entry: title is the empty string", [{ path: "a", title: "" }, { path: "good" }]],
];

// Document-level shapes: there is no entry to skip, so these stay fatal in BOTH modes.
const DOCUMENT_LEVEL: readonly (readonly [string, unknown])[] = [
	["unknown top-level key", { projects: [], theme: "dark" }],
	["projects is null", { projects: null }],
	["projects is an object", { projects: {} }],
	["top level is an array", []],
	["top level is a string", "nope"],
	["defaults is null", { defaults: null }],
	["defaults is a string", { defaults: "x" }],
	["defaults.model is the empty string", { defaults: { model: "" } }],
	["defaults has an unknown key", { defaults: { colour: "red" } }],
];

// Shapes the pre-existing tolerant semantic path already handled — the table keeps them so the extension does not
// regress them (and the malformed-slug default is dropped, not fatal).
const ALREADY_TOLERANT: readonly (readonly [string, unknown, string])[] = [
	["defaults.model without a slash", { defaults: { model: "no-slug" } }, "provider/model"],
	["defaults.thinkingLevel bogus", { defaults: { thinkingLevel: "turbo" } }, "thinkingLevel"],
	["two entries, same path", { projects: [{ path: "dup", title: "a" }, { path: "dup", title: "b" }] }, "duplicate project path"],
	["two entries, same stored id", { projects: [{ path: "p1", id: "same" }, { path: "p2", id: "same" }] }, "duplicate project id"],
	["entry: path with a NUL", { projects: [{ path: "a\u0000b" }, { path: "good" }] }, "not a usable path"],
];

const slugOf = (cwd: string) => cwd.split("/").pop();

describe("store M3 — the tolerant boot read covers every hand-edit shape", () => {
	it("a per-entry shape slip is skipped with a warning (tolerant); the same shape is fatal for the write path (strict)", () => {
		for (const [name, projects] of PER_ENTRY) {
			const text = JSON.stringify({ projects });
			const warns: string[] = [];
			let resolved: ResolvedInstance;
			expect(() => { resolved = parseSettingsJson(text, scratch, "settings.json", { onWarn: (m) => warns.push(m) }); }, `${name}: tolerant mode must not throw`).not.toThrow();
			expect(warns.length, `${name}: the entry was warned: ${JSON.stringify(warns)}`).toBeGreaterThanOrEqual(1);
			// The valid entry survives the skip; the broken one is gone (nothing derived from a number/empty id leaks in).
			expect(resolved!.projects.map((p) => slugOf(p.cwd)), `${name}: only the valid entry survives`).toEqual(["good"]);
			expect(() => parseSettingsJson(text, scratch, "settings.json"), `${name}: the write path (strict) stays fatal`).toThrow();
		}
	});

	it("a document-level shape is fatal in tolerant mode too (there is no entry to skip)", () => {
		for (const [name, doc] of DOCUMENT_LEVEL) {
			const text = JSON.stringify(doc);
			expect(() => parseSettingsJson(text, scratch, "settings.json", { onWarn: () => {} }), `${name}: a document-level shape is fatal even in tolerant mode`).toThrow();
			expect(() => parseSettingsJson(text, scratch, "settings.json"), `${name}: fatal for the write path too`).toThrow();
		}
	});

	it("a file that is not JSON at all is served as an EMPTY registry with a warning (tolerant); fatal for the write path", () => {
		const warns: string[] = [];
		const resolved = parseSettingsJson("{ this is not json ,,,", scratch, "settings.json", { onWarn: (m) => warns.push(m) });
		expect(resolved.projects).toEqual([]);
		expect(resolved.model).toBeUndefined();
		expect(warns.length, `the boot warned: ${JSON.stringify(warns)}`).toBe(1);
		expect(warns[0], "the warning says it is served empty and mutations are refused").toMatch(/empty registry|not readable|not valid JSON|mutations .*refused/i);
		expect(() => parseSettingsJson("{ not json", scratch, "settings.json"), "the write path (strict) refuses a non-JSON file").toThrow();
	});

	it("the pre-existing tolerant semantic shapes still warn+skip (the extension did not regress them)", () => {
		for (const [name, doc, needle] of ALREADY_TOLERANT) {
			const warns: string[] = [];
			let resolved: ResolvedInstance;
			expect(() => { resolved = parseSettingsJson(JSON.stringify(doc), scratch, "settings.json", { onWarn: (m) => warns.push(m) }); }, `${name}: tolerant mode must not throw`).not.toThrow();
			expect(warns.join("\n"), `${name}: warned about ${needle}`).toContain(needle);
		}
	});

	it("a non-JSON instance file is served as an empty registry that is READ-ONLY until fixed (mutations refused, file untouched)", async () => {
		const dir = join(scratch, "readonly");
		await mkdir(dir, { recursive: true });
		const file = join(dir, "settings.json");
		const original = "{ not json at all";
		await writeFile(file, original, "utf8");
		const warns: string[] = [];
		const registry = await FileProjectRegistry.open(dir, (m) => warns.push(m));
		expect(warns.length, `the boot warned: ${JSON.stringify(warns)}`).toBeGreaterThanOrEqual(1);
		expect(registry.list(), "the registry serves empty over the unreadable file").toEqual([]);
		// READ-ONLY: every mutation is refused naming the file (the strict reader re-reads it), and the file is untouched.
		expect(() => registry.add("A", join(dir, "a")), "add is refused over the unreadable file").toThrow(/settings\.json/);
		expect(() => registry.setThinkingLevel("high"), "a defaults write is refused over the unreadable file").toThrow(/settings\.json/);
		expect(() => registry.setModel({ provider: "p", modelId: "m" }), "a model-default write is refused over the unreadable file").toThrow(/settings\.json/);
		expect(await readFile(file, "utf8"), "the file is left untouched").toBe(original);
	});
});

// The boot outcome a table shape must produce in a real host: does the listener bind? (a per-entry slip and a
// non-JSON file bind + warn; a document-level shape exits before the bind.)
describe("store M3 — the boot outcome in a real host", () => {
	let port = 4971;
	const boot = async (settingsContent: string): Promise<{ host: Launched; listening: boolean }> => {
		const root = join(scratch, `h${port}`);
		const proj = join(root, "projects", "p");
		await mkdir(proj, { recursive: true });
		await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
		await writeFile(join(root, "settings.json"), settingsContent, "utf8");
		const agentDir = join(scratch, "agent");
		await mkdir(agentDir, { recursive: true });
		const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
		launched.push(host);
		const listening = await waitListening(port);
		port += 1;
		return { host, listening };
	};

	it("a per-entry slip boots: the host binds and warns, and the good entry is served", async () => {
		const { host, listening } = await boot(JSON.stringify({ projects: [{ id: 5, path: "broken" }, { path: "projects/good", title: "Good" }] }));
		expect(listening, `the host bound over the bad entry: ${host.out()}`).toBe(true);
		expect(host.out(), "the boot warned about the bad entry").toMatch(/skipped|bad|not a valid project entry/i);
		const ws = await connectWs(port - 1, await pair(port - 1, TOKEN));
		const shell = exitValue(await ws.call("orchestration.getArchivedShellSnapshot", {}), "shell") as { projects: { title: string }[] };
		ws.close();
		expect(shell.projects.map((p) => p.title), "only the good entry survives").toEqual(["Good"]);
	}, 30_000);

	it("a non-JSON file boots: the host binds, warns, serves an empty registry, and refuses a mutation", async () => {
		const { host, listening } = await boot("{ this is not json ,,,");
		expect(listening, `the host bound over the unreadable file: ${host.out()}`).toBe(true);
		expect(host.out(), "the boot warned the file is served empty / mutations refused").toMatch(/empty registry|not readable|not valid JSON|refused/i);
		const p = port - 1;
		const ws = await connectWs(p, await pair(p, TOKEN));
		const shell = exitValue(await ws.call("orchestration.getArchivedShellSnapshot", {}), "shell") as { projects: unknown[] };
		expect(shell.projects, "the registry serves empty").toEqual([]);
		// READ-ONLY over the wire: a project add into an EXISTING directory (so the workspace-root checks pass) is refused
		// naming the file — the strict write-reader re-reads the unparseable settings.json and refuses, leaving it untouched.
		const addFrame = await ws.call("projects.mutate", { commandId: "m3-add", type: "project.create", projectId: "m3-new", title: "New", workspaceRoot: join(scratch, `h${p}`, "projects", "p") });
		expect(JSON.stringify(addFrame), "the add is refused naming the file").toMatch(/settings\.json/);
		ws.close();
		expect(await readFile(join(scratch, `h${p}`, "settings.json"), "utf8"), "the file is untouched").toBe("{ this is not json ,,,");
	}, 30_000);

	it("a document-level shape exits before the bind (the tolerant read does not swallow it)", async () => {
		const { host, listening } = await boot(JSON.stringify({ projects: [], theme: "dark" }));
		expect(listening, `a document-level shape must NOT bind: ${host.out()}`).toBe(false);
	}, 30_000);
});
