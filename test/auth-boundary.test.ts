// Like T3, the host checks no `Host` header: auth is the boundary. A page that rebinds a hostname to this port has no
// credentials, so this pins that every non-public route refuses a request without one, that the public routes say
// nothing more than their public answer, and that the session cookie does not count with a foreign `Origin`.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { launch, pairCode, t3Dir, type Launched } from "./host-process-harness.ts";
import { waitListening } from "./ws-rpc.ts";

const PORT = 4971;
const base = `http://127.0.0.1:${PORT}`;
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-boundary-"));
let host: Launched | undefined;

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await host?.exited;
	await rm(scratch, { recursive: true, force: true });
});

const PROTECTED: Array<[string, string]> = [
	["POST", "/api/auth/websocket-ticket"],
	["POST", "/api/auth/pairing-token"],
	["GET", "/api/auth/pairing-links"],
	["POST", "/api/auth/pairing-links/revoke"],
	["GET", "/api/auth/clients"],
	["POST", "/api/auth/clients/revoke"],
	["POST", "/api/auth/clients/revoke-others"],
	["GET", "/api/orchestration/shell"],
	["GET", "/api/orchestration/threads/t"],
	["GET", "/api/orchestration/threads/t/bounded"],
	["GET", "/api/projects"],
	["POST", "/api/projects/mutate"],
];

/** The `/ws` upgrade's status: anything but 101 is a refusal. */
const upgradeStatus = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const req = request(`${base}/ws?orchestrationProtocol=2`, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
		req.on("upgrade", (_res, socket) => (socket.destroy(), resolve(101)));
		req.on("response", (res) => (res.resume(), resolve(res.statusCode ?? 0)));
		req.on("error", reject);
		req.end();
	});

it("every non-public route needs a credential, and the cookie does not count with a foreign Origin", async () => {
	const root = join(scratch, "host");
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`);
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }));
	host = launch(root, PORT, {}, join(scratch, "agent"));
	if (!(await waitListening(PORT))) throw new Error(`host did not bind ${PORT}: ${host.out()}`);

	for (const [method, path] of PROTECTED) {
		const res = await fetch(base + path, { method, ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}) });
		expect([401, 403], `${method} ${path}`).toContain(res.status);
	}
	expect(await upgradeStatus()).toBe(401);

	// The public routes: the descriptor, "not signed in", and a refused bad pairing code.
	expect((await fetch(`${base}/.well-known/t3/environment`)).status).toBe(200);
	expect(await (await fetch(`${base}/api/auth/session`)).json()).toMatchObject({ authenticated: false });
	const bad = await fetch(`${base}/api/auth/browser-session`, { method: "POST", body: JSON.stringify({ credential: "nope" }), headers: { "content-type": "application/json" } });
	expect(bad.status).toBe(401);
	expect(bad.headers.get("set-cookie")).toBeNull();

	// A real session cookie authenticates a same-origin request, and not one from a foreign Origin.
	const paired = await fetch(`${base}/api/auth/browser-session`, { method: "POST", body: JSON.stringify({ credential: pairCode(root) }), headers: { "content-type": "application/json", origin: base } });
	expect(paired.status).toBe(200);
	const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
	expect((await fetch(`${base}/api/projects`, { headers: { cookie, origin: base } })).status).toBe(200);
	expect((await fetch(`${base}/api/projects`, { headers: { cookie, origin: "https://evil.example" } })).status).toBe(401);
}, 60_000);
