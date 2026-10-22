// The built T3 web app served by the facet at `/`: static bytes, T3's caching/validator headers, the SPA fallback
// to index.html, and the API/`/ws`/`/.well-known`/`/api` routes winning over the catch-all. The host hardcodes
// the web app to the web package (`packages/web/app`, from `pnpm setup:t3`), so a launched host serves the real built app. One flow per host.

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type Launched, launch, t3Dir } from "./host-process-harness.ts";
import { waitListening } from "./ws-rpc.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-web-"));
const launched: Launched[] = [];
const PORT = 4950;
const base = `http://127.0.0.1:${PORT}`;
let started = false;

afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

async function start() {
	if (started) return;
	const root = join(scratch, "web-host");
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile( join(root, "config.toml"),
		`listen = "127.0.0.1:${PORT}"\n`,
		"utf8",
	);
	await writeFile( join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }), "utf8", );
	const host = launch(root, PORT);
	launched.push(host);
	if (!(await waitListening(PORT)))
		throw new Error(`host did not bind ${PORT}: ${host.out()}`);
	started = true;
}

/** A real build asset the app shell loads (its module script), as `/assets/<name>.js`. */
function anAsset(): string {
	const html = readFileSync(new URL("../packages/web/app/index.html", import.meta.url), "utf8");
	const match = /src="(\/assets\/[^"]+\.js)"/.exec(html);
	if (match === null) throw new Error("no module script in packages/web/app/index.html");
	return match[1]!;
}

it("serves the web app at /, with the SPA fallback and T3's cache headers", async () => {
	await start();
	// The app shell: index.html, served as HTML, no immutable cache (HTML carries no validator, per T3).
	const home = await fetch(`${base}/`);
	expect(home.status).toBe(200);
	expect(home.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(home.headers.get("cache-control")).toBe("no-cache");
	expect(home.headers.get("etag")).toBeNull();
	const html = await home.text();
	expect(html).toContain('<div id="root">'); // the built React shell (a route the SPA renders client-side)

	// A client-side app route (no file on disk) falls back to index.html — same bytes, same 200.
	const route = await fetch(`${base}/settings/connections`);
	expect(route.status).toBe(200);
	expect(route.headers.get("content-type")).toBe("text/html; charset=utf-8");
	expect(await route.text()).toBe(html);
}, 30000);

it("serves a build asset no-cache, with a W/ ETag and 304 revalidation (as T3 serves its released client)", async () => {
	await start();
	const path = anAsset();
	const first = await fetch(`${base}${path}`);
	expect(first.status).toBe(200);
	expect(first.headers.get("cache-control")).toBe("no-cache");
	const etag = first.headers.get("etag");
	expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
	await first.body?.cancel();
	// A conditional GET with the ETag revalidates to a bare 304 (no body), carrying the Vary.
	const again = await fetch(`${base}${path}`, { headers: { "if-none-match": etag! }, });
	expect(again.status).toBe(304);
	expect(again.headers.get("vary")).toContain("Accept-Encoding");
	await again.body?.cancel();
}, 30000);

it("the API, /ws and /.well-known routes win over the SPA catch-all; /pair is the SPA's", async () => {
	await start();
	// The discovery descriptor is JSON, not the index shell — the specific route wins over `GET *`.
	const wellKnown = await fetch(`${base}/.well-known/t3/environment`);
	expect(wellKnown.status).toBe(200);
	expect(wellKnown.headers.get("content-type")).toContain("application/json");
	expect(((await wellKnown.json()) as { label: string }).label).toBe("pi");

	// The unauthenticated session endpoint answers its JSON contract shape, not the shell.
	const session = await fetch(`${base}/api/auth/session`);
	expect(session.status).toBe(200);
	expect( ((await session.json()) as { authenticated: boolean }).authenticated, ).toBe(false);

	// `/pair` is T3's own SPA route: the shell, which pairs from the link and opens the app.
	const pair = await fetch(`${base}/pair#token=x`);
	expect(pair.status).toBe(200);
	expect(await pair.text()).toContain("<div id=\"root\">");

	// `/ws` without a ticket is a typed auth refusal (401 JSON), not the shell.
	const ws = await fetch(`${base}/ws?orchestrationProtocol=2`);
	expect(ws.status).toBe(401);
}, 30000);

it("refuses a path that tries to climb out of the web app directory", async () => {
	await start();
	// Encoded traversal past the static root (the slashes encoded so the client does not collapse the `..` first) is the
	// 400 T3 answers, never a file outside the directory.
	const climb = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
	expect(climb.status).toBe(400);
}, 30000);
