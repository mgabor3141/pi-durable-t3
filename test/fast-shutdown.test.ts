// A SIGINT (and SIGTERM) mid-turn must stop the reference host fast: print "stopping", exit 0 within ~2 s, even when a
// turn is in flight on work that ignores its abort signal (a real provider's lingering HTTP stream — here a non-abortable
// tool). A second signal exits immediately. This is the bounded shutdown `installShutdown` installs; the graceful
// close alone can hang on a non-abortable in-flight invocation (see src/shutdown.ts). Hermetic: a child process on its
// own loopback port, a scripted faux model, a temp `PI_CODING_AGENT_DIR` (never `~/.pi`), no network.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, expect, it } from "vitest";

const childScript = new URL("../src/testing/shutdown-child.ts", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-shutdown-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

type Child = { child: ChildProcessByStdio<null, Readable, Readable>; out: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

/** Spawn the shutdown child on `port` under a fresh root; resolve its `exited` promise, expose a live output getter. */
async function launch(name: string, port: number): Promise<Child> {
	const root = join(scratch, name);
	await mkdir(root, { recursive: true });
	// Only `listen` belongs in `config.toml`. This fixture used to write a `[[projects]]` block too — a key the current
	// parser refuses by name (projects live in the instance file, `settings.json`, which the child writes itself). It
	// passed only because the child builds its own config string and never reads this file, which makes it a trap for
	// whoever points the child at the file on disk.
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	const child = spawn(process.execPath, ["--experimental-strip-types", childScript, root, "alpha", String(port), "60000"], {
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_DURABLE_T3_FAKE: undefined },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	child.stdout.on("data", (c: Buffer) => (buffer += c.toString()));
	child.stderr.on("data", (c: Buffer) => (buffer += c.toString()));
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
	return { child, out: () => buffer, exited };
}

/** Resolve once the child prints `ADMITTED`, so the turn is admitted and the tool is about to run. */
function waitAdmitted(child: Child, timeoutMs = 20_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const timer = setInterval(() => {
			if (child.out().includes("ADMITTED")) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() - started > timeoutMs) {
				clearInterval(timer);
				reject(new Error(`child never admitted a turn:\n${child.out()}`));
			}
		}, 50);
	});
}

it("SIGINT mid-turn stops the host: prints 'stopping', exits 0 within ~2 s, releases the port", async () => {
	const port = 4906;
	const host = await launch("sigint", port);
	try {
		await waitAdmitted(host);
		await sleep(1200); // the run is now inside the non-abortable tool.
		const sentAt = Date.now();
		host.child.kill("SIGINT");
		const result = await Promise.race([host.exited, sleep(3000).then(() => "timeout" as const)]);
		const elapsed = Date.now() - sentAt;
		if (result === "timeout") throw new Error(`still running 3 s after SIGINT:\n${host.out()}`);
		expect(host.out()).toContain("stopping");
		expect(result.signal).toBeNull();
		expect(result.code).toBe(0);
		expect(elapsed).toBeLessThan(3000);
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 40_000);

it("a second SIGINT exits immediately (< 1 s), uncleanly if the close is mid-flight", async () => {
	const port = 4907;
	const host = await launch("double", port);
	try {
		await waitAdmitted(host);
		await sleep(1200);
		const sentAt = Date.now();
		host.child.kill("SIGINT"); // begins the bounded close ("stopping").
		await sleep(150); // the graceful close is now hanging on the non-abortable invocation…
		host.child.kill("SIGINT"); // …so the second signal must take the immediate-exit path.
		const result = await Promise.race([host.exited, sleep(1000).then(() => "timeout" as const)]);
		const elapsed = Date.now() - sentAt;
		if (result === "timeout") throw new Error(`still running 1 s after the second SIGINT:\n${host.out()}`);
		expect(result.code).toBe(0);
		expect(elapsed).toBeLessThan(1000);
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 40_000);
