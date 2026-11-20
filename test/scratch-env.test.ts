// The Scratch claim must create its folder in the caller's execution environment, never on the harness's filesystem.
// This guards the call site in `Bridge.createThread`: with a recording environment, a host `mkdir` fallback is visible.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Context } from "@earendil-works/chord/context";
import type { Result, FileError } from "@earendil-works/pi-durable/env";
import { claimScratchThreadFolder } from "../src/scratch.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { makeThreads, bridgeConfig } from "./threads-harness.ts";

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
	const bridge = new Bridge(
		bridgeConfig({ stateDir: fixture.root, registry: fixture.registry, env, scratchDir: scratchRoot }),
		{ info: () => {}, warn: () => {} },
		fixture.threads, fixture.model.models,
	);
	bridge.start();
	try {
		const ensured = await bridge.ensureScratch();
		await bridge.createThread({ projectId: ensured.projectId, launchText: "claim through env" });
		expect(created.some((path) => path.startsWith(`${scratchRoot}/`)), `folders created: ${JSON.stringify(created)}`).toBe(true);
	} finally {
		await bridge.close();
	}
});

it("names a Scratch thread's folder from its message with accented letters folded, as T3 0.1.11 does", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-scratch-words-"));
	try {
		const folder = await claimScratchThreadFolder(join(root, "scratch"), "thread-0001", "Résumé fix für Ñandú", new NodeExecutionEnv({ cwd: "/" }));
		expect(basename(folder)).toMatch(/^\d{4}-\d{2}-\d{2}-resume-fix-fur-nandu-read0001$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
