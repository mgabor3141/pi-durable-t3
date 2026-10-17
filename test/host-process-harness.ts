// The reference host as a child process, for tests that drive it the way a user does. One shared launcher: a fresh
// root, the offline reply model (`PI_DURABLE_T3_FAKE=1`), an isolated `PI_CODING_AGENT_DIR` so `~/.pi` is never read,
// and a live getter for the child's combined output. Every test kills only the PID it started.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { mintPairingCode } from "../src/bridge.ts";

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

/** The bridge dir of a `--root <root>` instance: `attachT3`'s `dir` (the host creates it; a test writes its
 * `projects.json` there BEFORE the first start — a documented hand-edit). */
export function t3Dir(root: string): string {
	return join(root, "t3");
}

/** Mint a single-use pairing code against a running host's bridge dir — the way a user adds a device (the `pair`
 * command's own path); exchange it with `pair(port, code)` from `ws-rpc.ts`. */
export function pairCode(root: string): string {
	return mintPairingCode(t3Dir(root)).code;
}
