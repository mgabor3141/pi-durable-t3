// A thread running in a folder that is not in the configuration gets a project id derived from its normalized absolute
// path — the way a configured folder is stable — so the same folder keeps the SAME id across processes. A per-process
// random id (`p-other-<uuid>`) stranded T3's selection for that folder on every restart. These cases drive two real
// `Bridge`s over the same config and assert the derivation is identical across them, across repeat calls, and across
// path spellings that normalize to the same directory. `projectForCwd` reads only the config and the path, so no host,
// storage, model, or filesystem is needed to call it.
import { describe, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { Bridge } from "../src/t3/bridge.ts";
import type { BridgeConfig } from "../src/t3/config.ts";
import type { Logger } from "../src/t3/logging.ts";
import { testRegistry } from "../src/testing/test-registry.ts";

const log: Logger = { info: () => {}, warn: () => {} };

function makeBridge(projects: readonly { id: string; path: string }[]): Bridge {
	const config: BridgeConfig = {
		host: "127.0.0.1",
		port: 0,
		label: "t",
		stateDir: "/tmp/pi-durable-t3-project-id-unused",
		pairingToken: undefined,
		tokenTtlSeconds: 60,
		corsOrigins: [],
		registry: testRegistry(projects.map((project) => ({ id: project.id, cwd: project.path }))),
	};
	// `projectForCwd` never touches the host, so an unloaded one is enough to construct a Bridge.
	return new Bridge(config, log, createHost({ name: "server" }));
}

describe("project ids for unconfigured folders", () => {
	it("the same cwd yields the same id across two Bridges (stable across restarts)", () => {
		const projects = [{ id: "alpha", path: "/data/alpha" }] as const;
		const a = makeBridge(projects);
		const b = makeBridge(projects);

		const cwd = "/data/loose/nested";
		const idA = a.projectForCwd(cwd);
		const idB = b.projectForCwd(cwd);
		expect(idA.id).toBe(idB.id);
		expect(idA.path).toBe(cwd);
		// A path-derived id (a hex digest), not a per-process random one.
		expect(idA.id).toMatch(/^p-[0-9a-f]{16}$/);
		// Deterministic within one Bridge, too.
		expect(a.projectForCwd(cwd).id).toBe(idA.id);
	});

	it("normalizes the path before deriving the id (same folder, spelled differently → same id)", () => {
		const bridge = makeBridge([]);
		const spelled = bridge.projectForCwd("/data/loose/./nested/../nested").id;
		const plain = bridge.projectForCwd("/data/loose/nested").id;
		expect(spelled).toBe(plain);
	});

	it("a configured folder keeps its id (and a subpath of it maps to it); a different folder differs", () => {
		const projects = [{ id: "alpha", path: "/data/alpha" }] as const;
		const bridge = makeBridge(projects);
		expect(bridge.projectForCwd("/data/alpha").id).toBe("alpha");
		expect(bridge.projectForCwd("/data/alpha/sub").id).toBe("alpha");
		expect(bridge.projectForCwd("/data/other").id).toBe(bridge.projectForCwd("/data/other").id);
		expect(bridge.projectForCwd("/data/other").id).not.toBe(bridge.projectForCwd("/data/alpha").id);
	});
});
