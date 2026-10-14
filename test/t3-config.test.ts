// A project-less instance is documented as valid and must leave the host connectable. The one server-level field T3's
// ServerConfig shows is derived from a project; with no projects it used to read `projects[0]!.path` and throw, putting a
// paired client into a reconnect loop (B4). The derivation is the contracts-free `serverCwd`, tested here directly.
import { describe, expect, it } from "vitest";
import { parseConfigToml } from "../src/config.ts";
import { serverCwd, type BridgeConfig } from "../src/t3/config.ts";
import { testRegistry } from "../src/testing/test-registry.ts";

const ROOT = "/tmp/pi-durable-t3-t3-config";

function bridgeConfig(projects: readonly { id: string; cwd: string }[]): BridgeConfig {
	const config = parseConfigToml(`listen = "127.0.0.1:4903"\n`, ROOT);
	return { ...config.bridge, registry: testRegistry(projects) };
}

describe("serverCwd (empty-environment fallback, B4)", () => {
	it("falls back to the state dir when there are no projects, instead of throwing", () => {
		const bridge = bridgeConfig([]);
		expect(bridge.registry.list()).toHaveLength(0);
		expect(serverCwd(bridge)).toBe(bridge.stateDir);
	});

	it("uses the first project's path when projects exist (no regression)", () => {
		const bridge = bridgeConfig([{ id: "alpha", cwd: `${ROOT}/projects/alpha` }]);
		expect(serverCwd(bridge)).toBe(`${ROOT}/projects/alpha`);
	});
});
