// The integrator's own HTTP routes on the host's listener: web-standard handlers, reached without a credential, and a
// handler that throws answers 500 instead of taking the server down. They live under /host/, which T3 never uses.
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { attachT3 } from "../src/bridge.ts";
import { waitListening } from "./ws-rpc.ts";
import { makeThreads } from "./threads-harness.ts";

const PORT = 4971;

it("serves the integrator's routes beside T3's", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const seen: string[] = [];
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir: join(f.root, "t3-state"),
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		routes: [
			{
				method: "GET",
				path: "/host/oauth/callback",
				handle: async (request) => {
					seen.push(new URL(request.url).search);
					return new Response("<p>Signed in.</p>", { headers: { "content-type": "text/html" } });
				},
			},
			{ method: "POST", path: "/host/hook", handle: async (request) => Response.json({ echo: await request.json() }) },
			{ method: "GET", path: "/host/boom", handle: async () => { throw new Error("boom"); } },
		],
	});
	try {
		expect(await waitListening(PORT)).toBe(true);
		const base = `http://127.0.0.1:${PORT}`;
		const callback = await fetch(`${base}/host/oauth/callback?code=abc&state=xyz`);
		expect(callback.status).toBe(200);
		expect(await callback.text()).toBe("<p>Signed in.</p>");
		expect(seen).toEqual(["?code=abc&state=xyz"]);
		const hook = await fetch(`${base}/host/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
		expect(await hook.json()).toEqual({ echo: { a: 1 } });
		expect((await fetch(`${base}/host/boom`)).status).toBe(500);
	} finally {
		await t3.close();
	}
}, 60_000);

it("refuses a route outside /host/", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await expect(
		attachT3(f.harness, {
			models: f.model.models,
			stateDir: join(f.root, "t3-state"),
			env: new NodeExecutionEnv({ cwd: f.root }),
			listen: { host: "127.0.0.1", port: PORT + 1 },
			routes: [{ method: "GET", path: "/api/auth/session" as never, handle: async () => new Response("mine") }],
		}),
	).rejects.toThrow("under /host/");
});
