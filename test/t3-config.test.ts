// A project-less instance is documented as valid and must leave the host connectable. The one server-level field T3's
// ServerConfig shows is derived from a project; with no projects it used to read `projects[0]!.path` and throw, putting a
// paired client into a reconnect loop (B4). The derivation is the contracts-free `serverCwd`, tested here directly.
import { describe, expect, it } from "vitest";
import { serverCwd, type BridgeConfig } from "../src/t3/config.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { testRegistry } from "./test-registry.ts";

const ROOT = "/tmp/pi-durable-t3-t3-config";

function bridgeConfig(projects: readonly { id: string; cwd: string }[]): BridgeConfig {
	return { host: "127.0.0.1", port: 4903, label: "pi", stateDir: `${ROOT}/t3-auth`, pairingToken: undefined, tokenTtlSeconds: 90 * 86_400, corsOrigins: [], settings: ServerSettingsStore.open(ROOT), registry: testRegistry(projects) };
}

describe("serverCwd (empty-environment fallback, B4)", () => {
	it("the first project's path when projects exist; the state dir — not a throw — when there are none (B4)", () => {
		const withProjects = bridgeConfig([{ id: "alpha", cwd: `${ROOT}/projects/alpha` }]);
		expect(serverCwd(withProjects)).toBe(`${ROOT}/projects/alpha`);
		const empty = bridgeConfig([]);
		expect(empty.registry.list()).toHaveLength(0);
		expect(serverCwd(empty)).toBe(empty.stateDir);
	});
});
