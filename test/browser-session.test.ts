// The browser-session flow the same-origin web app depends on: exchange a one-time credential for a session cookie,
// then authenticate every guarded call with that cookie (session, Connections list, pairing mint, the WS ticket), with
// T3's same-origin guard rejecting a cross-origin cookie. One flow per host.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AuthAccessWriteScope,
	AuthBrowserSessionResult,
	AuthSessionState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, expect, it } from "vitest";
import {
	type Launched,
	launch,
	pairCode,
	t3Dir,
} from "./host-process-harness.ts";
import { waitListening } from "./ws-rpc.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-bs-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
const PORT = 4965;
const base = `http://127.0.0.1:${PORT}`;
const ORIGIN = { origin: base }; // same-origin (host === Origin host) satisfies T3's cookie origin guard.

afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

async function start() {
	const root = join(scratch, "bs-host");
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile( join(root, "config.toml"),
		`listen = "127.0.0.1:${PORT}"\n`,
		"utf8",
	);
	await writeFile( join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }), "utf8", );
	const host = launch(root, PORT, {}, agentDir);
	launched.push(host);
	if (!(await waitListening(PORT)))
		throw new Error(`host did not bind ${PORT}: ${host.out()}`);
	return root;
}

// biome-ignore lint/suspicious/noExplicitAny: a schema of any shape, fed to the JSON codec
const decodes = (schema: any, body: unknown): boolean => {
	try {
		Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never)(body);
		return true;
	} catch {
		return false;
	}
};

/** The session cookie (name=value) the browser-session exchange returns. */
function sessionCookie(setCookie: string | null): string {
	const cookie = (setCookie ?? "").split(";")[0]!;
	expect(cookie.startsWith("pi_durable_t3_session=")).toBe(true);
	return cookie;
}

it("browser-session: exchange a credential, then ride the cookie across the guarded routes", async () => {
	const root = await start();
	const code = pairCode(root);

	// Exchange the credential: the contract's result, decodable, and a session cookie set.
	const exchange = await fetch(`${base}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", ...ORIGIN }, body: JSON.stringify({ credential: code }), signal: AbortSignal.timeout(8000), });
	expect(exchange.status).toBe(200);
	const result = (await exchange.json()) as Record<string, unknown>;
	expect(decodes(AuthBrowserSessionResult, result)).toBe(true);
	expect(result.authenticated).toBe(true);
	expect(result.sessionMethod).toBe("browser-session-cookie");
	expect(result.permissions).toContain(AuthAccessWriteScope);
	const cookie = sessionCookie(exchange.headers.get("set-cookie"));
	expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");
	expect(exchange.headers.get("set-cookie")).toContain("SameSite=Lax");

	// The session endpoint, authenticated BY THE COOKIE, reports the browser-session method (what T3's web app reads).
	const session = await fetch(`${base}/api/auth/session`, { headers: { cookie, ...ORIGIN }, });
	expect(session.status).toBe(200);
	const state = (await session.json()) as Record<string, unknown>;
	expect(decodes(AuthSessionState, state)).toBe(true);
	expect(state.authenticated).toBe(true);
	expect(state.sessionMethod).toBe("browser-session-cookie");

	// Connections reads (the web app's Settings → Connections) authorize on the cookie: list clients, then mint a link.
	const clients = await fetch(`${base}/api/auth/clients`, { headers: { cookie, ...ORIGIN }, });
	expect(clients.status).toBe(200);
	const mint = await fetch(`${base}/api/auth/pairing-token`, { method: "POST", headers: { "content-type": "application/json", cookie, ...ORIGIN }, body: JSON.stringify({ label: "from the web app" }), });
	expect(mint.status).toBe(200);
	expect( String(((await mint.json()) as { credential: string }).credential).length, ).toBeGreaterThan(0);

	// The WS ticket endpoint rides the cookie too (it is bearer-guarded, now cookie-aware). The ticket it mints is what
	// `/ws` consumes — the bearer path already proves `/ws` accepts a ticket, so this closes the cookie → ticket loop.
	const ticketRes = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { cookie, ...ORIGIN }, });
	expect(ticketRes.status).toBe(200);
	expect( String(((await ticketRes.json()) as { ticket: string }).ticket).length, ).toBeGreaterThan(0);
}, 30000);

it("the cookie is refused for a foreign origin (T3's CSRF guard), and a spent code is refused", async () => {
	const root = join(scratch, "bs-host2");
	// A second host on its own port, so this guard test's cookie is independent of the first host's.
	const PORT2 = 4952;
	const base2 = `http://127.0.0.1:${PORT2}`;
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile( join(root, "config.toml"),
		`listen = "127.0.0.1:${PORT2}"\n`,
		"utf8",
	);
	await writeFile( join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }), "utf8", );
	const host = launch(root, PORT2, {}, agentDir);
	launched.push(host);
	if (!(await waitListening(PORT2)))
		throw new Error(`host did not bind ${PORT2}: ${host.out()}`);
	const cookie = sessionCookie( ( await fetch(`${base2}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", origin: base2 }, body: JSON.stringify({ credential: pairCode(root) }), }) ).headers.get("set-cookie"), );

	// A cookie presented from a foreign Origin (no Sec-Fetch-Site: same-origin) is refused: cookies must not ride cross-site.
	const foreign = await fetch(`${base2}/api/auth/session`, { headers: { cookie, origin: "http://evil.example.com" }, });
	expect( ((await foreign.json()) as { authenticated: boolean }).authenticated, ).toBe(false);
	const foreignClients = await fetch(`${base2}/api/auth/clients`, { headers: { cookie, origin: "http://evil.example.com" }, });
	expect(foreignClients.status).toBe(401);

	// A spent credential cannot be exchanged again.
	const reuse = await fetch(`${base2}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json", origin: base2 }, body: JSON.stringify({ credential: "not-a-real-code" }), });
	expect(reuse.status).toBe(401);
	const reason = (await reuse.json()) as Record<string, unknown>;
	expect(reason._tag).toBe("EnvironmentAuthInvalidError");
	expect(reason.reason).toBe("invalid_credential");
}, 30000);
