// The reference host driven as a user does, over a real child process (the wiring `main.ts` runs): Ctrl-C must stop it
// (B1); a second instance on a taken port must fail loudly — naming the address and EADDRINUSE — without printing
// "ready" or a pairing link (B2); it must fail at start when there are no models; and the HTTP surface must answer as
// T3 reads it (the Host guard, the thread-detail routes' auth and unknown-thread contracts).
//
// Each test spawns `node --experimental-strip-types src/main.ts` with the offline reply model on a loopback port chosen
// clear of the defaults (3774) and the smoke's (4911/4920). `PI_CODING_AGENT_DIR` points at a temp dir so `~/.pi` is
// never read. Ports here are their own (4901-4905, 4908) and distinct, so the tests can run in parallel.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterAll, expect, it } from "vitest";

const main = new URL("../src/main.ts", import.meta.url).pathname;
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
	await writeFile(join(root, "host.toml"), `listen = "127.0.0.1:${port}"\n\n[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`, "utf8");
	return root;
}

/** GET `/.well-known/t3/environment` connecting to loopback `port` but sending an explicit `Host` header. */
function requestWithHost(port: number, hostHeader: string): Promise<number> {
	return new Promise((resolve) => {
		const req = request({ host: "127.0.0.1", port, path: "/.well-known/t3/environment", headers: { host: hostHeader }, timeout: 2000 }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", () => resolve(0));
		req.on("timeout", () => {
			req.destroy();
			resolve(0);
		});
		req.end();
	});
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

it("the thread-detail routes answer pairing state and an unknown thread as T3 reads them", async () => {
	// Both `/api/orchestration/threads/:threadId*` routes share one preamble, and its two contracts are only visible
	// over HTTP: an unpaired request is refused before any projection is read, and a thread this host does not know
	// is the resource-not-found T3 renders as a missing thread. A fixed pairing token (env-var-only, for tests) makes
	// the token exchange repeatable.
	const port = 4908;
	const root = await writeRoot("routes", port);
	const pairingToken = "test-pairing-code-0123456789";
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: pairingToken });
	try {
		expect(await waitListening(port)).toBe(true);
		const paired = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
				subject_token: pairingToken,
				subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
				requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
			}).toString(),
			signal: AbortSignal.timeout(5000),
		});
		expect(paired.status).toBe(200);
		const token = (await paired.json() as { access_token: string }).access_token;
		expect(token.length).toBeGreaterThan(20);
		const bearer = { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" };
		// A thread this host cannot have: 404 with the error tag T3 renders, on both routes. A thread id the host
		// cannot mint (here: a leading dot) is the fast path to that answer; a deleted thread reaches the same one.
		for (const path of ["/api/orchestration/threads/.nope", "/api/orchestration/threads/.nope/bounded"]) {
			const unknown = await getJson(port, path, bearer);
			expect([path, unknown.status]).toEqual([path, 404]);
			expect(unknown.body._tag).toBe("EnvironmentResourceNotFoundError");
		}
		// Unpaired: refused with the auth error, before the thread is looked up.
		const unpaired = await getJson(port, "/api/orchestration/threads/.nope");
		expect(unpaired.status).toBe(401);
		expect(unpaired.body.code).toBe("auth_invalid");
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 40_000);

it("on loopback, rejects a non-loopback Host header — DNS-rebinding guard (S4)", async () => {
	const port = 4905;
	const root = await writeRoot("s4", port);
	const host = launch(root, port);
	try {
		expect(await waitListening(port)).toBe(true);
		// Loopback Host names are served; a rebinding (evil hostname resolving to 127.0.0.1) is refused with 421.
		expect(await requestWithHost(port, `127.0.0.1:${port}`)).toBe(200);
		expect(await requestWithHost(port, `localhost:${port}`)).toBe(200);
		expect(await requestWithHost(port, "evil.example")).toBe(421);
		expect(await requestWithHost(port, "evil.example:80")).toBe(421);
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 30_000);
