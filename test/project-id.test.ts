// Which project a cwd belongs to: the registry answers, and only the registry. `projectForCwd` maps a cwd to the
// registered project rooted at it (or above it); an UNREGISTERED folder maps to NO project (H2: the bridge used to
// mint a path-derived `(other)` project for any unregistered folder — one bogus thread probe injected a phantom
// project into every client's shell). A thread whose project is not registered is reported with its own `projectId`
// and no invented project; ids for unregistered paths exist only where a path is REGISTERED without an id
// (the registry derives one — see `settings.test.ts`, and `projects.mutate` for the id policy).
import { describe, expect, it } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { createHost } from "@earendil-works/chord";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { testRegistry } from "./test-registry.ts";

const log: Logger = { info: () => {}, warn: () => {} };

function makeBridge(projects: readonly { id: string; path: string }[]): Bridge {
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		label: "t",
		stateDir: "/tmp/pi-durable-t3-project-id-unused",
		pairingToken: undefined,
		tokenTtlSeconds: 60,
		settings: ServerSettingsStore.open("/tmp/pi-durable-t3-project-id-unused"), corsOrigins: [],
		registry: testRegistry(projects.map((project) => ({ id: project.id, cwd: project.path }))),
	};
	// `projectForCwd` never touches the host, so an unloaded one is enough to construct a Bridge.
	return new Bridge(config, log, createHost({ name: "server" }));
}

describe("which project covers a cwd (registry only)", () => {
	it("a registered folder keeps its id; a subpath of it maps to it", () => {
		const bridge = makeBridge([{ id: "alpha", path: "/data/alpha" }]);
		expect(bridge.projectForCwd("/data/alpha")).toMatchObject({ id: "alpha", path: "/data/alpha" });
		expect(bridge.projectForCwd("/data/alpha/sub")).toMatchObject({ id: "alpha" });
		expect(bridge.projectForCwd("/data/alphax"), "a sibling prefix is not covered (…/alpha vs …/alphax)").toBeUndefined();
	});

	it("an unregistered folder maps to NO project — the bridge invents no id, no `(other)` shell (H2)", () => {
		const bridge = makeBridge([{ id: "alpha", path: "/data/alpha" }]);
		expect(bridge.projectForCwd("/data/other")).toBeUndefined();
		expect(bridge.projectForCwd("/data/loose/nested")).toBeUndefined();
		expect(bridge.projectForCwd(undefined)).toBeUndefined();
		// The shell projects registered folders and nothing else.
		expect(bridge.projects().map((project) => project.workspaceRoot as string)).toEqual(["/data/alpha"]);
	});

});
