// `attachT3`'s `remoteAccess`: a route the integrator runs (its own tailnet node, an SSH relay) is advertised to T3,
// as T3's server advertises what it discovers: the HTTPS URL as a `directEndpoints` entry, the SSH host editors open
// paths on as a `remoteOpenTargets` entry. A change reaches connected clients as a fresh snapshot.
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as Schema from "effect/Schema";
import { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import { expect, it } from "vitest";
import { attachT3, mintPairingCode, type RemoteAccessState } from "../src/bridge.ts";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { makeThreads } from "./threads-harness.ts";

const PORT = 4971;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("advertises the integrator's URL and SSH host, and pushes a snapshot when they change", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const stateDir = join(f.root, "t3-state");
	let state: RemoteAccessState = {};
	const listeners = new Set<() => void>();
	const change = (next: RemoteAccessState) => {
		state = next;
		for (const listener of listeners) listener();
	};
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir,
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		remoteAccess: { current: () => state, subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) },
	});
	try {
		expect(await waitListening(PORT)).toBe(true);
		const ws = await connectWs(PORT, await pair(PORT, mintPairingCode(stateDir).code));
		try {
			type Config = { directEndpoints?: unknown; remoteOpenTargets?: unknown };
			const before = exitValue(await ws.call("server.getConfig", {}), "server.getConfig") as Config;
			expect(before.directEndpoints).toEqual([]);
			expect(before.remoteOpenTargets).toBeUndefined();

			const stream = await ws.open("subscribeServerConfig", {});
			const snapshots = () => ws.chunks(stream).flatMap((frame) => (frame.values ?? []) as { type: string; config?: Config }[]).filter((event) => event.type === "snapshot");
			for (let i = 0; i < 60 && snapshots().length === 0; i++) await sleep(50);
			expect(snapshots()).toHaveLength(1);
			expect(listeners.size).toBe(1);

			change({ httpBaseUrl: "https://claw.tail1234.ts.net/", ssh: { host: "claw.tail1234.ts.net", username: "agent" } });
			for (let i = 0; i < 60 && snapshots().length < 2; i++) await sleep(50);
			const pushed = snapshots()[1]!.config!;
			expect(pushed.directEndpoints).toEqual([{ kind: "tailnet", httpBaseUrl: "https://claw.tail1234.ts.net" }]);
			expect(pushed.remoteOpenTargets).toEqual([{ kind: "tailscale", host: "claw.tail1234.ts.net", username: "agent" }]);
			for (const frame of ws.chunks(stream)) for (const event of frame.values ?? []) expect(() => Schema.decodeUnknownSync(ServerConfigStreamEvent)(event)).not.toThrow();

			const after = exitValue(await ws.call("server.getConfig", {}), "server.getConfig");
			expect(() => Schema.decodeUnknownSync(ServerConfig)(after)).not.toThrow();
			expect((after as Config).remoteOpenTargets).toEqual(pushed.remoteOpenTargets);
		} finally {
			ws.close();
		}
		for (let i = 0; i < 40 && listeners.size > 0; i++) await sleep(50);
		expect(listeners.size, "a closed stream unsubscribes").toBe(0);
	} finally {
		await t3.close();
	}
}, 60_000);

it("refuses remoteAccess together with tailscaleServe", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await expect(
		attachT3(f.harness, {
			models: f.model.models,
			stateDir: join(f.root, "t3-state"),
			env: new NodeExecutionEnv({ cwd: f.root }),
			listen: { host: "127.0.0.1", port: PORT + 1 },
			tailscaleServe: {},
			remoteAccess: { current: () => ({}), subscribe: () => () => {} },
		}),
	).rejects.toThrow(/remoteAccess or tailscaleServe, not both/);
});
