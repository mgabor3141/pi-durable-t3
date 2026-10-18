// Tailscale Serve over the real host, with a fake `tailscale` on PATH: the mapping the host arms at startup and
// releases on shutdown, the host-header rule Serve needs (Serve forwards to loopback carrying the MagicDNS `Host`,
// verified against a live Serve: `Host`/`X-Forwarded-Host` are `name.ts.net[:port]`), and the `pair` link. Nothing
// here touches a real tailnet: the binary is a shell script that records its argv.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { type Launched, launch, pairCode, t3Dir } from "./host-process-harness.ts";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-tail-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const main = new URL("../examples/coding-agent/src/host.ts", import.meta.url).pathname;
const launched: Launched[] = [];

/** The MagicDNS name the fake CLI reports; `.ts.net` is what classifies a Host as tailnet. */
const TS_HOST = "machine.example-tail.ts.net";
const TS_ORIGIN = `https://${TS_HOST}:8443`;

afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

/** A `tailscale` on PATH that records every call and answers `status --json` with the MagicDNS name. */
async function fakeTailscale(logPath: string): Promise<string> {
	const bin = await mkdtemp(join(scratch, "bin-"));
	await writeFile(
		join(bin, "tailscale"),
		`#!/bin/sh\necho "$@" >> ${logPath}\nif [ "$1" = "status" ]; then echo '{"Self":{"DNSName":"${TS_HOST}."}}'; fi\nexit 0\n`,
		{ mode: 0o755 },
	);
	return bin;
}

/** Start the example host on `port`, with the fake CLI first on PATH. `serve` writes the two Serve keys. */
async function start(name: string, port: number, serve: { port: number } | undefined): Promise<Launched> {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	const calls = join(scratch, `calls-${name}.log`);
	const bin = await fakeTailscale(calls);
	await writeFile(
		join(root, "config.toml"),
		[
			`listen = "127.0.0.1:${String(port)}"`,
			...(serve === undefined ? [] : [`tailscale_serve = true`, `tailscale_serve_port = ${String(serve.port)}`]),
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }), "utf8");
	const host = launch(
		root,
		port,
		{ PATH: `${bin}:${process.env["PATH"]}`, TAILSCALE_CALLS: calls },
		agentDir,
	);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind ${String(port)}: ${host.out()}`);
	return host;
}

const callsOf = (name: string) => readFile(join(scratch, `calls-${name}.log`), "utf8").catch(() => "");

/**
 * Poll until `read()` satisfies `check`. Needed because `waitListening` resolves on the FIRST successful poll and
 * Serve is armed after the listener is up: the ready line and the CLI's call entry land a moment later, and an
 * assertion written at that instant is a flake. A check that never holds fails at the deadline, with what was seen.
 */
async function until(what: string, read: () => Promise<string>, check: (seen: string) => boolean): Promise<string> {
	const deadline = Date.now() + 8_000;
	for (;;) {
		const seen = await read();
		if (check(seen)) return seen;
		if (Date.now() > deadline) throw new Error(`${what}: not seen within 8s; saw: ${seen.slice(-800)}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

/** One request with a hand-written `Host` — the header a proxy sets and `fetch` will not let a test set. */
function getWithHost(port: number, path: string, host: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string; setCookie: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{ host: "127.0.0.1", port, path, method: "GET", headers: { host, ...extraHeaders }, timeout: 8000 },
			(res) => {
				let body = "";
				res.on("data", (chunk: Buffer) => (body += chunk.toString()));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body, setCookie: String(res.headers["set-cookie"] ?? "") }),
				);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** A POST with a hand-written `Host` and `Origin` — the shape a browser sends through Serve. */
function postWithHost(port: number, path: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string; setCookie: string }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers },
				timeout: 8000,
			},
			(res) => {
				let text = "";
				res.on("data", (chunk: Buffer) => (text += chunk.toString()));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: text, setCookie: String(res.headers["set-cookie"] ?? "") }),
				);
			},
		);
		req.on("error", reject);
		req.write(payload);
		req.end();
	});
}

it("arms Serve once the listener is up, widens the host rule to the tailnet name, and releases it on shutdown", async () => {
	const PORT = 4961;
	const host = await start("serve-on", PORT, { port: 8443 });

	// The startup mapping: T3's argv, aimed at the port the listener really got, and logged as T3 logs it. Both are
	// polled: they appear just after the listener answers, not before.
	await until("the log's Serve line", () => Promise.resolve(host.out()), (seen) => seen.includes("Tailscale Serve configured"));
	await until("the serve call", () => callsOf("serve-on"), (seen) => seen.includes(`serve --bg --https=8443 http://127.0.0.1:${String(PORT)}`));

	// A loopback Host is served, as always.
	expect((await getWithHost(PORT, "/.well-known/t3/environment", `127.0.0.1:${PORT}`)).status).toBe(200);
	// The tailnet `Host` Serve forwards is served too — only because Serve is configured.
	const served = await getWithHost(PORT, "/.well-known/t3/environment", `${TS_HOST}:8443`, {
		"x-forwarded-host": `${TS_HOST}:8443`,
		"x-forwarded-proto": "https",
	});
	expect(served.status).toBe(200);
	expect(JSON.parse(served.body).label).toBe("pi");
	// Anything else stays refused on a loopback listener: the guard opens for the tailnet name, no wider.
	expect((await getWithHost(PORT, "/.well-known/t3/environment", "evil.example.com")).status).toBe(421);
	expect((await getWithHost(PORT, "/.well-known/t3/environment", "evil-tailnet.example.com")).status).toBe(421);

	// The pairing exchange a browser makes through Serve: same-origin by the forwarded Host, so the session cookie
	// authenticates it. This is the flow `pair` prints an HTTPS link for.
	const code = pairCode(join(scratch, "serve-on"));
	const exchanged = await postWithHost(PORT, "/api/auth/browser-session", { credential: code }, {
		host: `${TS_HOST}:8443`,
		origin: TS_ORIGIN,
		"sec-fetch-site": "same-origin",
	});
	expect(exchanged.status).toBe(200);
	expect(exchanged.setCookie).toContain("pi_durable_t3_session=");

	// The config a client reads carries the routes it may learn: on a loopback bind with a name that does not answer
	// (the fake CLI reports a name; nothing serves it), that is the empty list — the field is there, and the client's
	// route learner reads it.
	const token = await pair(PORT, pairCode(join(scratch, "serve-on")));
	const ws = await connectWs(PORT, token);
	const config = exitValue(await ws.call("server.getConfig", {}, 12_000), "server.getConfig") as {
		directEndpoints?: unknown;
	};
	const directEndpoints = config.directEndpoints;
	expect(Array.isArray(directEndpoints)).toBe(true);
	expect(directEndpoints).toEqual([]);
	ws.close();

	// A graceful shutdown releases the mapping it armed — and only its own port.
	host.child.kill("SIGTERM");
	const exited = await Promise.race([
		host.exited,
		new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`host did not exit: ${host.out()}`)), 15_000)),
	]);
	expect(exited.code).toBe(0);
	const calls = await callsOf("serve-on");
	expect(calls).toContain("serve --https=8443 off");
	expect(calls).not.toContain("--https=443");
});

it("runs no tailscale command, advertises no tailnet name and accepts no tailnet Host when Serve is off", async () => {
	const PORT = 4962;
	const host = await start("serve-off", PORT, undefined);

	// Give a hypothetical `tailscale` call time to show up, then assert the absence: with the keys unset the host runs
	// no CLI, logs nothing about Serve, and advertises nothing.
	await new Promise((resolve) => setTimeout(resolve, 500));
	expect(host.out()).not.toContain("Tailscale Serve");
	expect(await callsOf("serve-off")).toBe("");
	expect((await getWithHost(PORT, "/.well-known/t3/environment", `127.0.0.1:${PORT}`)).status).toBe(200);
	// The default host is off: the guard does not open for a `.ts.net` Host it never armed.
	expect((await getWithHost(PORT, "/.well-known/t3/environment", `${TS_HOST}:8443`)).status).toBe(421);
});

it("pair prints the HTTPS link, built from the MagicDNS name", async () => {
	const PORT = 4963;
	const root = join(scratch, "serve-pair");
	await mkdir(t3Dir(root), { recursive: true });
	const bin = await fakeTailscale(join(scratch, "calls-pair.log"));
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${String(PORT)}"\ntailscale_serve = true\ntailscale_serve_port = 8443\n`, "utf8");

	const runPair = () =>
		new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", main, "pair", "--root", root], {
				env: { ...process.env, PATH: `${bin}:${process.env["PATH"]}`, PI_DURABLE_T3_FAKE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let out = "";
			child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
			child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
		});

	const out = await runPair();
	const code = /Pairing code \(single use\): (\S+)/.exec(out)?.[1];
	expect(code).toBeTruthy();
	// The loopback link stays (it works from the machine), and the tailnet link is the one to open elsewhere.
	expect(out).toContain(`http://127.0.0.1:${String(PORT)}/pair#token=${code}`);
	expect(out).toContain(`https://${TS_HOST}:8443/pair#token=${code}`);
	expect(await callsOf("pair")).toContain("status --json");
});
