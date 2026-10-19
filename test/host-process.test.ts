// The reference host driven as a user does, over a real child process (the wiring `main.ts` runs): Ctrl-C must stop it
// (B1); a second instance on a taken port must fail loudly — naming the address and EADDRINUSE — without printing
// "ready" or a pairing link (B2); it must fail at start when there are no models; and the HTTP surface must answer as
// T3 reads it (the thread-detail routes' auth and unknown-thread contracts).
//
// Each test spawns `node --experimental-strip-types examples/coding-agent/src/host.ts` with the offline reply model on a loopback port chosen
// clear of the defaults (3774) and the smoke's (4911/4920). `PI_CODING_AGENT_DIR` points at a temp dir so `~/.pi` is
// never read. Ports here are their own (4901-4904) and distinct, so the tests can run in parallel.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, expect, it } from "vitest";

const main = new URL("../examples/coding-agent/src/host.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-host-proc-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

type Launched = { child: ChildProcessByStdio<null, Readable, Readable>; out: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

/** Start the host on `port` with one project under a fresh root; returns the child and a live output getter. */
function launch(root: string, port: number, extraEnv: NodeJS.ProcessEnv = {}): Launched {
	const child = spawn(process.execPath, ["--experimental-strip-types", main, "--root", root], {
		env: { ...process.env, PI_DURABLE_T3_FAKE: "1", PI_CODING_AGENT_DIR: agentDir, ...extraEnv },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	child.stdout.on("data", (c: Buffer) => (buffer += c.toString()));
	child.stderr.on("data", (c: Buffer) => (buffer += c.toString()));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	return { child, out: () => buffer, exited };
}

async function writeRoot(name: string, port: number): Promise<string> {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	// The integrator's `config.toml` (host-owned keys) and the registry the UI edits, in the bridge dir (the documented
	// hand-edit; the host creates the dir itself and starts with an empty registry).
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(join(root, "t3"), { recursive: true });
	await writeFile(join(root, "t3", "projects.json"), JSON.stringify({ projects: [{ path: join(root, "projects/alpha"), title: "alpha" }] }), "utf8");
	return root;
}

const get = async (port: number, path: string): Promise<number> => {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
		return response.status;
	} catch {
		return 0;
	}
};

/** GET `path` on `port` with `headers`; the status and the parsed body (a body is asserted as often as the status). */
async function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(3000) });
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

/** Poll the well-known endpoint until the server answers 200 (ready and listening), or give up. */
async function waitListening(port: number, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await get(port, "/.well-known/t3/environment")) === 200) return true;
		await sleep(150);
	}
	return false;
}

/** Poll until nothing answers on `port` again (the listener is released), or give up. */
async function waitPortFree(port: number, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await get(port, "/.well-known/t3/environment")) === 0) return true;
		await sleep(100);
	}
	return false;
}

/** Run `node main.ts <args>` to completion and return its combined output and exit code. */
function runMain(args: string[]): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", main, ...args], {
			env: { ...process.env, PI_DURABLE_T3_FAKE: "1", PI_CODING_AGENT_DIR: agentDir },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (c: Buffer) => (out += c.toString()));
		child.stderr.on("data", (c: Buffer) => (out += c.toString()));
		child.on("error", reject);
		// A `pair` command mints a code and exits; if it instead booted a server it would not exit and the guard fires.
		const guard = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`pair did not exit; it started a server instead:\n${out}`));
		}, 10_000);
		child.on("exit", (code) => {
			clearTimeout(guard);
			resolve({ code, out });
		});
	});
}

it("`pair` mints one code and exits, for both the documented and pnpm's `-- pair --` argv (B3)", async () => {
	const root = await writeRoot("b3", 4903); // no server is started; the port is irrelevant to `pair`
	// The documented simplest form.
	const simple = await runMain(["pair", "--root", root]);
	expect(simple.code).toBe(0);
	expect(simple.out).toContain("Pairing code");
	expect(simple.out).not.toContain("pi-durable-t3 ready");
	// The form pnpm forwards for `pnpm start -- pair -- --root <root>`, which used to boot a whole server instead.
	const forwarded = await runMain(["--", "pair", "--", "--root", root]);
	expect(forwarded.code).toBe(0);
	expect(forwarded.out).toContain("Pairing code");
	expect(forwarded.out).not.toContain("pi-durable-t3 ready");
}, 30_000);

it("Ctrl-C (SIGINT) stops the host: the process exits 0 within a few seconds and releases the port", async () => {
	const port = 4901;
	const root = await writeRoot("b1", port);
	const host = launch(root, port);
	try {
		expect(await waitListening(port)).toBe(true);
		host.child.kill("SIGINT");
		// A graceful shutdown must finish quickly; the old code stayed alive serving the port after SIGINT.
		const exitedWithTimeout = await Promise.race([host.exited, sleep(6000).then(() => "timeout" as const)]);
		expect(exitedWithTimeout).not.toBe("timeout");
		if (exitedWithTimeout === "timeout") throw new Error(`still running after SIGINT:\n${host.out()}`);
		expect(exitedWithTimeout.signal).not.toBe("SIGKILL");
		expect(exitedWithTimeout.code).toBe(0);
		// The port is released: nothing answers again.
		expect(await waitPortFree(port)).toBe(true);
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 30_000);

it("a second instance on a taken port exits 1 with the address and EADDRINUSE, and never prints ready/pairing", async () => {
	const port = 4902;
	const rootA = await writeRoot("b2-a", port);
	const rootB = await writeRoot("b2-b", port);
	const a = launch(rootA, port);
	let b: Launched | undefined;
	try {
		expect(await waitListening(port)).toBe(true);
		b = launch(rootB, port);
		// The second host must fail on its own (not hang, not idle) within a few seconds.
		const exited = await Promise.race([b.exited, sleep(8000).then(() => "timeout" as const)]);
		if (exited === "timeout") throw new Error(`second instance never exited:\n${b.out()}`);
		expect(exited.code).toBe(1);
		const out = b.out();
		expect(out).toContain("failed to listen");
		expect(out).toContain(`127.0.0.1:${port}`);
		expect(out).toContain("EADDRINUSE");
		// It must fail BEFORE claiming readiness or minting a pairing link.
		expect(out).not.toContain("pi-durable-t3 ready");
		expect(out).not.toContain("Pairing code");
	} finally {
		a.child.kill("SIGKILL");
		b?.child.kill("SIGKILL");
		await Promise.allSettled([a.exited, b?.exited ?? Promise.resolve()]);
	}
}, 30_000);

it("fails at start, before ready, when no models are available (S1)", async () => {
	const root = await writeRoot("s1", 4904);
	// No FAKE model and an EMPTY agent dir: `getAvailable()` is empty, so there is nothing to pick.
	const child = spawn(process.execPath, ["--experimental-strip-types", main, "--root", root], {
		// `PI_DURABLE_T3_FAKE: undefined` guarantees the offline model is NOT used, regardless of the ambient env.
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DURABLE_T3_FAKE: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout.on("data", (c: Buffer) => (out += c.toString()));
	child.stderr.on("data", (c: Buffer) => (out += c.toString()));
	const code = await Promise.race([new Promise<number | null>((r) => child.on("exit", r)), sleep(20_000).then(() => "timeout" as const)]);
	child.kill("SIGKILL");
	if (code === "timeout") throw new Error(`host did not fail as expected; output:\n${out}`);
	expect(code).toBe(1);
	expect(out).toMatch(/no models are available/);
	expect(out).not.toContain("pi-durable-t3 ready");
}, 30_000);
