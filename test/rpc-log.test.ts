// The optional per-call RPC callbacks: a successful request reports its method and duration, and a method this host
// does not implement reports the refusal reason without entering the success path.
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { attachT3, mintPairingCode, type RpcCall, type RpcCallFailure, type RpcCallStub } from "../src/bridge.ts";
import { connectWs, pair, waitListening } from "./ws-rpc.ts";
import { makeThreads } from "./threads-harness.ts";

const PORT = 4968;

it("reports successful and stubbed RPC calls through optional callbacks", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const stateDir = join(f.root, "t3-state");
	const successes: RpcCall[] = [];
	const failures: RpcCallFailure[] = [];
	const stubs: RpcCallStub[] = [];
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir,
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		rpcLog: {
			onSuccess: (call) => successes.push(call),
			onFailure: (call) => failures.push(call),
			onStubbed: (call) => stubs.push(call),
		},
	});
	try {
		expect(await waitListening(PORT), "the test facet is listening").toBe(true);
		const token = await pair(PORT, mintPairingCode(stateDir).code);
		const ws = await connectWs(PORT, token);
		try {
			await ws.call("server.getConfig", {});
			await ws.call("orchestration.getThreadProjection", { threadId: "missing" });
			await ws.call("server.updateServer", { targetVersion: "0.0.0" });
		} finally {
			ws.close();
		}
		const config = successes.find((call) => call.method === "server.getConfig");
		expect(config, "the successful method is reported").toBeDefined();
		expect(config?.kind).toBe("request");
		expect(typeof config?.durationMs).toBe("number");
		const failure = failures.find((call) => call.method === "orchestration.getThreadProjection");
		expect(failure, "a failing implemented method is reported").toBeDefined();
		expect(failure?.error).toContain("Unknown thread");
		expect(failures.some((call) => call.method === "server.updateServer"), "a stub is not reported as a failure").toBe(false);
		const stub = stubs.find((call) => call.method === "server.updateServer");
		expect(stub, "the unimplemented method is reported as stubbed").toBeDefined();
		expect(stub?.reason).toContain("does not self-update");
	} finally {
		await t3.close();
	}
}, 60_000);
