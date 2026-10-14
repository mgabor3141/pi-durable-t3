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
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
	// The integrator's `config.toml` (host-owned keys) and the instance file (the project registry the UI edits).
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [{ path: join(root, "projects/alpha"), title: "alpha" }], defaults: {} }), "utf8");
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
		// cannot mint (here: a leading dot) is the fast path to that answer; a deleted thread — and ANY well-formed
		// id the host has never seen — reach the same one (H2: `#state` used to fabricate state for these, answering 200).
		for (const path of ["/api/orchestration/threads/.nope", "/api/orchestration/threads/.nope/bounded",
			"/api/orchestration/threads/zzz-never-created", "/api/orchestration/threads/zzz-never-created/bounded",
			"/api/orchestration/threads/6f2f1c9a-0b1d-4e5f-8a7c-9d0e1f2a3b4c", "/api/orchestration/threads/6f2f1c9a-0b1d-4e5f-8a7c-9d0e1f2a3b4c/bounded"]) {
			const unknown = await getJson(port, path, bearer);
			expect([path, unknown.status]).toEqual([path, 404]);
			expect(unknown.body._tag).toBe("EnvironmentResourceNotFoundError");
			expect(unknown.body.reason).toBe("thread_not_found"); // the contract's required reason field
		}
		// A bogus thread probe must not leak a project: the shell's project list names only the configured folder.
		const shell = await getJson(port, "/api/orchestration/shell", bearer);
		expect(shell.status).toBe(200);
		const roots = ((shell.body.projects ?? []) as { workspaceRoot: string }[]).map((project) => project.workspaceRoot);
		expect(roots).toEqual([join(root, "projects/alpha")]);
		// Unpaired: refused with the auth error, before the thread is looked up.
		const unpaired = await getJson(port, "/api/orchestration/threads/.nope");
		expect(unpaired.status).toBe(401);
		expect(unpaired.body.code).toBe("auth_invalid");
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 40_000);

it("REST /api/projects/mutate adds a project (id from its path), refuses a duplicate path, and removes it (files untouched)", async () => {
	// The reachable project-management surface over the documented HTTP route, sharing one store with `projects.mutate`
	// over `/ws`. A fixed pairing token (env-var-only) makes the exchange repeatable, exactly as the routes test does.
	const port = 4909;
	const root = await writeRoot("projects", port);
	const pairingToken = "test-pairing-code-projects-0123";
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: pairingToken });
	const target = join(root, "projects", "added");
	const marker = join(target, "keep.txt");
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
		const bearer = (paired.json() as Promise<{ access_token: string }>).then((b) => b.access_token);
		const token = await bearer;
		const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

		// Unpaired is refused (the same bearer guard as every route).
		const unpaired = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "project.create", commandId: "c0", projectId: "x", title: "x", workspaceRoot: target }),
			signal: AbortSignal.timeout(5000),
		});
		expect(unpaired.status).toBe(401);

		// Create: a project at a new path, its id derived from the path. It creates the directory (createWorkspaceRootIfMissing).
		const created = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "project.create", commandId: "c1", projectId: "client-minted", title: "Added", workspaceRoot: target, createWorkspaceRootIfMissing: true }),
			signal: AbortSignal.timeout(5000),
		});
		expect(created.status).toBe(200);
		const project = (await created.json()) as { id: string; workspaceRoot: string; title: string; deletedAt: string | null };
		expect(project.workspaceRoot).toBe(target);
		expect(project.title).toBe("Added");
		expect(project.id).toMatch(/^p-[0-9a-f]{16}$/); // derived from the path, not the client-minted id

		// It appears in the project list, and the directory exists (a marker written into it).
		const list1 = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { projects: { id: string }[] };
		expect(list1.projects.some((entry) => entry.id === project.id)).toBe(true);
		await writeFile(marker, "keep me\n", "utf8");

		// A duplicate path is refused (T3 refuses it too): the same folder under a different title.
		const dup = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "project.create", commandId: "c2", projectId: "y", title: "Dup", workspaceRoot: target }),
			signal: AbortSignal.timeout(5000),
		});
		const dupBody = (await dup.json()) as { _tag: string; message: string };
		expect([dup.status, dupBody._tag, dupBody.message]).toEqual([409, "ProjectMutationError", expect.stringMatching(/already belongs to project/)]);

		// Remove (force:true) drops the entry; the files on disk are untouched (T3's dialog promises exactly this).
		const removed = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "project.delete", commandId: "c3", projectId: project.id, force: true }),
			signal: AbortSignal.timeout(5000),
		});
		expect(removed.status).toBe(200);
		const list2 = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { projects: { id: string }[] };
		expect(list2.projects.some((entry) => entry.id === project.id)).toBe(false);
		expect((await readFile(marker, "utf8"))).toBe("keep me\n");

		// (H1a) A create naming a path that exists as a FILE is refused — the typed project error names the path, the
		// mkdir failure is not swallowed, and no entry is stored (a registered file must never brick the next boot).
		const file = join(root, "projects", "afile");
		await writeFile(file, "not a directory\n", "utf8");
		const fileCreate = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "project.create", commandId: "c4", projectId: "z", title: "File", workspaceRoot: file, createWorkspaceRootIfMissing: true }),
			signal: AbortSignal.timeout(5000),
		});
		const fileBody = (await fileCreate.json()) as { _tag: string; message: string };
		expect([fileCreate.status, fileBody._tag]).toEqual([400, "ProjectMutationError"]);
		expect(fileBody.message).toContain(file); // names the path
		const list3 = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { projects: { workspaceRoot: string }[] };
		expect(list3.projects.some((entry) => entry.workspaceRoot === file)).toBe(false); // no entry stored
	} finally {
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 40_000);

it("a settings.json naming a FILE as a project: the host binds, warns naming the path, and the UI can delete the entry (H1b)", async () => {
	// The bricking path (H1): the instance file names a path that is an existing file. The boot mkdir used to throw
	// ENOTDIR before the listener bound — the process died at boot and the UI could not delete the entry that killed
	// it. Now: boot catches per project, warns through onWarn, and continues to the bind.
	const port = 4910;
	const root = join(scratch, "boot-file");
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	const bad = join(root, "abigfile");
	await writeFile(bad, "I am a file\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [{ path: bad, title: "bad" }, { path: join(root, "projects/alpha"), title: "alpha" }] }), "utf8");
	const pairingToken = "test-pairing-code-boot-file-01";
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: pairingToken });
	try {
		// The host BINDS — the defect was dying before this line could ever pass.
		expect(await waitListening(port)).toBe(true);
		// It warns, naming the bricking path.
		const out = host.out();
		expect(out).toContain("warn");
		expect(out).toContain(bad);
		// The UI works: pair, list projects (both entries), and DELETE the entry that would have bricked it.
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
		const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
		const list1 = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { projects: { id: string; workspaceRoot: string }[] };
		const badEntry = list1.projects.find((entry) => entry.workspaceRoot === bad);
		expect(badEntry, "the registered file is listed (the UI can see what to delete)").toBeDefined();
		// Other projects are listed and served (the shell answers over the bound listener).
		expect(list1.projects.some((entry) => entry.workspaceRoot === join(root, "projects/alpha"))).toBe(true);
		const shell = await fetch(`http://127.0.0.1:${port}/api/orchestration/shell`, { headers: auth, signal: AbortSignal.timeout(5000) });
		expect(shell.status).toBe(200);
		// Delete the bricking entry — the operation the defect made impossible.
		const removed = await fetch(`http://127.0.0.1:${port}/api/projects/mutate`, {
			method: "POST",
			headers: auth,
			body: JSON.stringify({ type: "project.delete", commandId: "d1", projectId: badEntry!.id, force: true }),
			signal: AbortSignal.timeout(5000),
		});
		expect(removed.status).toBe(200);
		const list2 = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { projects: { workspaceRoot: string }[] };
		expect(list2.projects.some((entry) => entry.workspaceRoot === bad)).toBe(false);
		// The file on disk is untouched (deletes never touch files).
		expect(await readFile(bad, "utf8")).toBe("I am a file\n");
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
