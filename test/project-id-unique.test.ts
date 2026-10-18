// A minted project id is unique AT MUTATION TIME, and boot tolerates an instance file it cannot honor
// (review store N1 + wire NEW-1). The identity cluster made ids client-mintable and moved the uniqueness
// key to the normalized path; the parser kept the id check, the write path did not. The host must never
// write a file its own boot parser refuses — the same boot-brick class the registry work closed for
// paths, one field over — and a boot damaged by a HAND-WRITTEN file (the documented integrator edit the
// UI cannot pre-validate) must degrade the way a bad path degrades: warn naming the file, skip the
// offending entry, bind. A host that dies before its listener binds cannot be told to fix the entry.
//
// (a) mutation time: `add` honoring a minted id that is already taken is refused with the typed project
//     error naming the id (the facet maps it to the contract's `ProjectMutationError`, REST parity 409),
//     and nothing is written.
// (a2) the SHAPE of a minted id: the contract's `ProjectId` is a branded TRIMMED NON-EMPTY STRING, and T3's
//     server commits the client's id verbatim — so any such id is honored (pre-fix only UUIDs were, and the
//     rest were silently re-derived; review wire NEW-2). A blank id is not a mint; an id the instance file
//     cannot store is refused with the typed `ProjectIdInvalid`.
// (b) the invariant: after every mutation the file on disk parses with the boot parser — what the host
//     writes, the host can read.
// (c) boot time: a hand-written `projects.json` with a duplicate project id: the host opens, warns
//     naming the file, skips the offending entry, and binds (pre-fix: a ConfigError before the bind).
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { ServerSettingsStore } from "../src/settings.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { FileProjectRegistry, parseProjectsJson, PROJECTS_FILE, ProjectIdConflict, ProjectIdInvalid } from "../src/registry.ts";
import { makeThreads } from "./threads-harness.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { getJson, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-idunique-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

async function makeRegistry(dataDir: string): Promise<FileProjectRegistry> {
	return FileProjectRegistry.open(dataDir);
}

it("(a) add honoring an id that is already registered is refused with the typed project error, and nothing is written", async () => {
	const dir = join(scratch, "a");
	await mkdir(dir, { recursive: true });
	const registry = await makeRegistry(dir);
	const one = join(dir, "one");
	const two = join(dir, "two");
	await mkdir(one, { recursive: true });
	await mkdir(two, { recursive: true });

	const U = "99999999-9999-9999-9999-999999999999";
	const first = registry.add("One", one, { clientId: U });
	expect(first.id).toBe(U);

	// The minted id is a key, not data: a second registration naming it is refused — with the TYPED
	// project error (the parser's ConfigError names the file; a client refusal names the id and the
	// project that owns it), symmetric with the duplicate-path refusal.
	const refusal = (path: string) => {
		try {
			registry.add("Two", path, { clientId: U });
			return undefined;
		} catch (error) {
			return error as Error;
		}
	};
	const failure = refusal(two);
	expect(failure, "the duplicate id is refused").toBeInstanceOf(Error);
	expect(failure, `the refusal is the typed project error, not the parser's ConfigError: ${failure?.name}: ${failure?.message}`).toBeInstanceOf(ProjectIdConflict);
	expect(failure!.message, "the refusal names the id").toContain(U);
	expect(failure!.message, "the refusal names the project that owns the id").toContain(one);

	// Nothing was written: the registry and the file carry ONE entry under the minted id.
	expect(registry.list().map((p) => p.id)).toEqual([U]);
	const stored = JSON.parse(await readFile(join(dir, PROJECTS_FILE), "utf8")) as { projects: { id?: string; path: string }[] };
	expect(stored.projects).toHaveLength(1);
	// A repeated attempt is refused the same way (the refusal is stateless, not a one-shot).
	expect(refusal(join(dir, "three")), "the second add is refused the same way").toBeInstanceOf(ProjectIdConflict);

	// Over the wire shape the facet maps to: the mutation rejects, naming the id (the facet turns the
	// rejection into the contract's `ProjectMutationError`; the REST route answers 409 for the same class).
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(dir), corsOrigins: [], staticDir: undefined, registry }, log, createHost({ name: "server" }));
	const wireFailure = await bridge.mutateProject({ type: "project.create", projectId: U, commandId: "cmd-id-dupe", title: "Four", workspaceRoot: join(dir, "four"), createWorkspaceRootIfMissing: true }).then(() => undefined, (error: unknown) => error as Error);
	expect(wireFailure, "the wire mutation is refused with the typed error").toBeInstanceOf(ProjectIdConflict);
	expect(registry.list().map((p) => p.id), "and the registry still holds one entry under the id").toEqual([U]);
});

it("(b) the host never writes a projects file its own boot parser refuses", async () => {
	const dir = join(scratch, "b");
	await mkdir(dir, { recursive: true });
	const registry = await makeRegistry(dir);
	const U = "88888888-8888-8888-8888-888888888888";

	// A sequence that includes the refusals: every accepted mutation must leave a file the boot parser reads.
	const rounds: Array<readonly [string, () => unknown]> = [
		["add with a minted id", () => registry.add("one", join(dir, "one"), { clientId: U })],
		["add with the SAME minted id (refused)", () => registry.add("dupe-id", join(dir, "two"), { clientId: U })],
		["add with a derived id", () => registry.add("two", join(dir, "two"))],
		["add with a non-UUID client id", () => registry.add("three", join(dir, "three"), { clientId: "not-a-uuid-placeholder" })],
		["move a project", () => registry.update(registry.list()[1]!.id, { path: join(dir, "two-moved") })],
		["remove a project", () => registry.remove(registry.list()[0]!.id)],
	];
	for (const [what, round] of rounds) {
		await Promise.resolve()
			.then(round)
			.catch(() => undefined); // refusals are part of this sequence; the file check is the invariant
		const text = await readFile(join(dir, PROJECTS_FILE), "utf8");
		expect(() => parseProjectsJson(text, dir), `${what}: the file the host wrote must parse at boot:\n${text}`).not.toThrow();
	}
});

it("(a2) any id valid under the contract's ProjectId schema is honored — the host navigates-with the client (wire NEW-2)", async () => {
	// T3's own server stores the client's id VERBATIM (`apps/server/src/project/ProjectService.ts`:
	// `create` commits `projectId: input.projectId`), and the contract's `ProjectId` is a branded TRIMMED
	// NON-EMPTY STRING (`baseSchemas.ts: makeEntityId`) — NOT a UUID. Pre-fix this host honored only
	// UUID-shaped ids and silently derived the rest: a client that minted "sso:project-7" sent X,
	// navigated to X, and found a shell answering p-<sha> — the Finding-1 composer-deadness, one shape wider.
	const dir = join(scratch, "a2");
	await mkdir(dir, { recursive: true });
	const registry = await makeRegistry(dir);
	const plain = registry.add("plain", join(dir, "plain"), { clientId: "not-a-uuid-placeholder" });
	expect(plain.id, "a non-UUID client id is honored, not silently re-derived").toBe("not-a-uuid-placeholder");
	const spaced = registry.add("spaced", join(dir, "spaced"), { clientId: "  trimmed-id  " });
	expect(spaced.id, "the contract trims; the stored id is the id the client is given (store N6)").toBe("trimmed-id");
	const blank = registry.add("blank", join(dir, "blank"), { clientId: "   " });
	expect(blank.id, "a blank id is not a mint (the contract would refuse it): it derives from the path").toMatch(/^p-[0-9a-f]{16}$/);
	expect(() => registry.add("long", join(dir, "long"), { clientId: "x".repeat(200) }), "an id the registry file cannot store is refused with the typed error, not a parser ConfigError").toThrow(ProjectIdInvalid);

	// The wire shape: the mutation answers the client's id and the shell carries it — this is what
	// `useProject` / `handleNewThread` look the project up by.
	const f = await makeThreads({ projects: [] });
	const host = createHost({ name: "server" });
	await host.load([createServerFacet(f.threads, f.model.models)]);
	await host.ready();
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(dir), corsOrigins: [], staticDir: undefined, registry }, log, host);
	bridge.start();
	const created = await bridge.mutateProject({ type: "project.create", projectId: "sso:project-7", commandId: "cmd-plain-id", title: "plain", workspaceRoot: join(dir, "sso"), createWorkspaceRootIfMissing: true });
	expect(created.id, "the mutation answers the id the client navigated to").toBe("sso:project-7");
	expect(bridge.projects().map((project) => project.id as string), "the shell carries it").toContain("sso:project-7");
	await bridge.close();
	await host.close();
}, 30_000);

it("(c) a projects.json with a hand-written duplicate project id: the host REFUSES to start, naming the file (strict boot)", async () => {
	const root = join(scratch, "c-root");
	const port = 4944;
	await mkdir(join(root, "projects", "good"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	const U = "77777777-7777-7777-7777-777777777777";
	// The shape the write path cannot produce, written by hand (the documented integrator edit).
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
await writeFile(
		join(t3Dir(root), PROJECTS_FILE),
		JSON.stringify({ projects: [{ id: U, path: join(root, "projects", "first"), title: "first" }, { id: U, path: join(root, "projects", "second"), title: "second" }] }),
		"utf8",
	);

	const host = launch(root, port, {}, agentDir);
	launched.push(host);

	// The host dies with the refusal; it never binds. (Pre-split this was the tolerant boot: warn, skip, bind —
	// deleted with the tolerant read: one rule, the file is refused by name.)
	const exited = await host.exited;
	expect(exited.code, "a refused boot exits non-zero").not.toBe(0);
	const out = host.out();
	expect(out, `the refusal names the damage: ${out}`).toMatch(/duplicate project id/i);
	expect(out, "the refusal names the file").toContain(PROJECTS_FILE);
	const listening = await waitListening(port, 500);
	expect(listening, "the listener never binds").toBe(false);
}, 60_000);
