// The Scratch claim must create its folder in the caller's execution environment, never on the harness's filesystem.
// This guards the call site in `Bridge.createThread`: with a recording environment, a host `mkdir` fallback is visible.
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord/context";
import type { Result, FileError } from "@earendil-works/pi-durable/env";
import { Bridge } from "../src/t3/bridge.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { makeThreads } from "./threads-harness.ts";

it("claims a Scratch thread folder through the bridge's execution environment", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	const env = new NodeExecutionEnv({ cwd: "/" });
	const created: string[] = [];
	const createDir = env.createDir.bind(env);
	env.createDir = (path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> => {
		created.push(path);
		return createDir(path, options, context);
	};
	const scratchRoot = join(fixture.root, "scratch");
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{
			host: "127.0.0.1",
			port: 0,
			label: "t",
			stateDir: fixture.root,
			env,
			scratchDir: scratchRoot,
			tokenTtlSeconds: 60,
			settings: ServerSettingsStore.open(fixture.root),
			corsOrigins: [],
			staticDir: undefined,
			registry: fixture.registry,
		},
		{ info: () => {}, warn: () => {} },
		host,
	);
	bridge.start();
	try {
		const ensured = await bridge.ensureScratch();
		await bridge.createThread({ projectId: ensured.projectId, launchText: "claim through env" });
		expect(created.some((path) => path.startsWith(`${scratchRoot}/`)), `folders created: ${JSON.stringify(created)}`).toBe(true);
	} finally {
		await bridge.close();
		await host.close();
	}
});
