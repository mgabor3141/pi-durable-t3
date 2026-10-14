// A `settings.json` that breaks while the host is running must never be rewritten from the empty fallback
// (review store M1, HIGH). The instance file is user-owned, hand-edited — the tolerant boot read exists precisely
// because people edit it. The write path (`FileProjectRegistry.#commit` → `updateJsonAtomic`) read its delta base
// with `readJson`, which returns the caller's fallback (`EMPTY_INSTANCE`) for an UNPARSEABLE file. So a file that
// becomes unparseable after the bind is treated as an empty registry by the write path, and the next mutation
// writes "empty + its own delta" — a perfectly valid document, so the write validator passes and the answer is
// `ok`, and every project the file held is destroyed.
//
// This is the same principle as the boot read: a host must never act on a document it could not read. The docs say
// it plainly (state.md: "A document that the boot parser would refuse is never written over a good one"; settings.ts
// names the exact harm as the reason the boot read is strict). The boot refuses, so the host is not running — but a
// typo that lands AFTER the bind was refused by nothing, and the write path is what rewrites the registry away.
//
// The fix: the instance file's delta base is read with the STRICT boot parser, not the tolerant one. A document on
// disk the host could not boot on refuses the mutation with a typed error naming the file, and the file is left
// byte-identical. `auth.json` keeps the tolerant base (starting a credential store over is documented).
//
// Probe (real host, real `/ws`), watched failing pre-fix with store M1's exact symptom:
//   - a healthy registry: create a project (ok), launch a thread (ok).
//   - hand-corrupt settings.json WHILE THE HOST RUNS.
//   - `projects.mutate` create over the broken file: pre-fix `ok` and every project is GONE from the file; the file
//     now holds only the new project. Post-fix: a typed refusal naming the file, and the file bytes are unchanged.
//   - `server.updateSettings` over the broken file: a typed `ServerSettingsError` (write-file), file unchanged.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-unreadable-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-unreadable-0123456789";

it("a settings.json that breaks while the host runs refuses the next mutation and is left untouched (M1)", async () => {
	const port = 4946;
	const root = join(scratch, "m1");
	const file = join(root, "settings.json");
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	const healthy = { projects: [{ path: join(root, "projects/alpha"), title: "alpha" }], defaults: {} };
	await writeFile(file, JSON.stringify(healthy), "utf8");

	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connectWs>> | undefined;
	try {
		expect(await waitListening(port), `host bound: ${host.out()}`).toBe(true);
		ws = await connectWs(port, await pair(port, TOKEN));

		// Healthy: create a project over the wire (the host writes the file).
		const added = exitValue(
			await ws.call("projects.mutate", { type: "project.create", projectId: "m1-uuid-1", commandId: "m1-c1", title: "Beta", workspaceRoot: join(root, "projects/beta"), createWorkspaceRootIfMissing: true }),
			"create Beta",
		) as { id: string; title: string };
		expect(added.title).toBe("Beta");
		const afterAdd = JSON.parse(await readFile(file, "utf8")) as { projects: { title?: string }[] };
		expect(afterAdd.projects.map((p) => p.title).sort(), "the healthy write carried both projects").toEqual(["Beta", "alpha"]);

		// Hand-corrupt the file WHILE THE HOST RUNS — the file the UI owns, the one the boot warning tells people to edit.
		const corrupt = "{ this is not json";
		await writeFile(file, corrupt, "utf8");

		// A create over the unparseable file. Pre-fix: `ok`, and every project the file held is destroyed.
		const createAnswer = await ws.call("projects.mutate", { type: "project.create", projectId: "m1-uuid-2", commandId: "m1-c2", title: "Epsilon", workspaceRoot: join(root, "projects/epsilon"), createWorkspaceRootIfMissing: true });
		// A typed refusal (not a Defect — `exitError` throws on a Defect).
		const createError = exitError(createAnswer, "create over an unparseable file");
		expect(createError._tag, JSON.stringify(createError)).toBe("ProjectMutationError");
		expect(JSON.stringify(createError), "the refusal names the file it cannot read").toContain("settings.json");

		// The file is byte-identical to the corruption: the host read it, refused, and touched nothing.
		expect(await readFile(file, "utf8"), "the unparseable file is left untouched").toBe(corrupt);

		// A defaults write over the same broken file: the contract's typed ServerSettingsError, file unchanged.
		const settings = await ws.call("server.updateSettings", { patch: { defaultModelSelection: { instanceId: "pi", model: "pi/whatever" } } });
		const settingsError = exitError(settings, "updateSettings over an unparseable file");
		expect(settingsError._tag, JSON.stringify(settingsError)).toBe("ServerSettingsError");
		expect(JSON.stringify(settingsError), "the refusal names the file").toContain("settings.json");
		expect(await readFile(file, "utf8"), "the unparseable file is still untouched").toBe(corrupt);
	} finally {
		ws?.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("the registry add path refuses over an unparseable file and leaves it untouched (M1, unit)", async () => {
	const dir = join(scratch, "m1-unit");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "settings.json");
	const { FileProjectRegistry } = await import("../src/registry.ts");
	await writeFile(file, JSON.stringify({ projects: [{ path: join(dir, "a"), title: "A" }], defaults: {} }), "utf8");
	const registry = await FileProjectRegistry.open(dir);
	expect(registry.list().map((p) => p.name)).toEqual(["A"]);

	// The file breaks while the host runs.
	const corrupt = "{ not json";
	await writeFile(file, corrupt, "utf8");

	expect(() => registry.add("B", join(dir, "b")), "add is refused over an unparseable file").toThrow(/settings\.json/);
	expect(() => registry.setThinkingLevel("high"), "a defaults write is refused over an unparseable file").toThrow(/settings\.json/);
	expect(await readFile(file, "utf8"), "the file is byte-identical to the corruption").toBe(corrupt);
	// The in-memory registry is unchanged: it is not replaced by the empty document the reader would have fallen back to.
	expect(registry.list().map((p) => p.name), "the registry keeps the entries it had read").toEqual(["A"]);
});
