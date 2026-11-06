// The shell projects REGISTERED folders and nothing else (H2: the bridge used to mint a path-derived `(other)`
// project for any unregistered folder — one bogus thread probe injected a phantom project into every client's
// shell). There is no cwd→project lookup left to invent one: a thread's project is its row's `projectId` read
// through the registry (the FK, checked at commit), and an unregistered one is reported with that id and no
// invented project. Ids for paths are the registry's business — see `settings.test.ts` and `projects.mutate`.
import { expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { unstartedStore } from "./threads-harness.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { standaloneRegistry } from "./test-registry.ts";

const log: Logger = { info: () => {}, warn: () => {} };

async function makeBridge(projects: readonly { id: string; path: string }[]): Promise<Bridge> {
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		label: "t",
		stateDir: "/tmp/pi-durable-t3-project-id-unused",
		scratchDir: undefined,
		tokenTtlSeconds: 60,
		settings: ServerSettingsStore.open("/tmp/pi-durable-t3-project-id-unused"),
		corsOrigins: [], staticDir: undefined,
		registry: await standaloneRegistry(projects.map((project) => ({ id: project.id, cwd: project.path }))),
	};
	// `projects()` never touches the host, so an unloaded one is enough to construct a Bridge.
	return new Bridge(config, log, unstartedStore(), createModels());
}

it("the shell lists registered projects and nothing else — no invented id, no `(other)` project (H2)", async () => {
	const bridge = await makeBridge([{ id: "alpha", path: "/data/alpha" }]);
	expect(bridge.projects().map((project) => project.workspaceRoot as string)).toEqual(["/data/alpha"]);
	expect((await makeBridge([])).projects()).toEqual([]);
});
