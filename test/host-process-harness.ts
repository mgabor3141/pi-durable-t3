// The reference host as a child process, for tests that drive it the way a user does. One shared launcher: a fresh
// root, the offline reply model (`PI_DURABLE_T3_FAKE=1`), an isolated `PI_CODING_AGENT_DIR` so `~/.pi` is never read,
// and a live getter for the child's combined output. Every test kills only the PID it started.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mintPairingCode } from "../src/bridge.ts";
import { ProjectRegistry } from "../src/registry.ts";

const main = new URL("../examples/coding-agent/src/host.ts", import.meta.url).pathname;

export type Launched = {
	readonly child: ChildProcessByStdio<null, Readable, Readable>;
	/** The child's combined stdout+stderr, as of now. */
	out: () => string;
	readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

/** Start `examples/coding-agent/src/host.ts --root <root>` on `port` (the root's `config.toml` decides the address; `env` adds the token). */
export function launch(root: string, port: number, env: NodeJS.ProcessEnv = {}, agentDir?: string): Launched {
	const child = spawn(process.execPath, ["--experimental-strip-types", main, "--root", root], {
		env: { ...process.env, PI_DURABLE_T3_FAKE: "1", ...(agentDir === undefined ? {} : { PI_CODING_AGENT_DIR: agentDir }), ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	// `port` is asserted by the root's own config.toml; name it in the returned object so a caller can log it.
	return { child, out: () => buffer, exited };
}

/** The bridge dir of a `--root <root>` instance: `attachT3`'s `stateDir` (the host creates it). */
export function t3Dir(root: string): string {
	return join(root, "t3");
}

/** Mint a single-use pairing code against a running host's bridge dir — the way a user adds a device (the `pair`
 * command's own path); exchange it with `pair(port, code)` from `ws-rpc.ts`. */
export function pairCode(root: string): string {
	return mintPairingCode(t3Dir(root)).code;
}

/** Register projects in a root's storage before its host starts: the host reads the registry at attach, as it reads
 * the projects the UI added. Never while a host runs on the root. */
export async function seedProjects(root: string, projects: readonly { readonly id?: string; readonly title?: string; readonly path: string }[]): Promise<void> {
	const harness = await Harness.open(await openNodeSqliteStorage(join(root, "durable.db")), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	try {
		const registry = new ProjectRegistry(harness, { baseDir: root });
		await registry.load();
		for (const project of projects) await registry.add(project.title, project.path, project.id === undefined ? undefined : { clientId: project.id });
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** The projects a root's storage holds, read straight from the database (a running host's included). */
export function storedProjects(root: string): { id: string; title: string; path: string }[] {
	const db = new DatabaseSync(join(root, "durable.db"), { readOnly: true });
	try {
		for (const row of db.prepare("SELECT id, kind FROM documents").all() as { id: number; kind: string }[]) {
			if (JSON.parse(row.kind) !== "pi-durable-t3.projects") continue;
			const base = db.prepare("SELECT content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(row.id) as { content: string } | undefined;
			return base === undefined ? [] : (JSON.parse(base.content) as { projects: { id: string; title: string; path: string }[] }).projects;
		}
		return [];
	} finally {
		db.close();
	}
}
