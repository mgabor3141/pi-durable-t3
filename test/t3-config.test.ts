// A project-less `host.toml` is documented as valid and must leave the host connectable. The one server-level field T3's
// ServerConfig shows is derived from a project; with no projects it used to read `projects[0]!.path` and throw, putting a
// paired client into a reconnect loop (B4). The derivation is the contracts-free `serverCwd`, tested here directly.
import { describe, expect, it } from "vitest";
import { parseHostToml } from "../src/config.ts";
import { serverCwd } from "../src/t3/config.ts";

const ROOT = "/tmp/pi-durable-t3-t3-config";

describe("serverCwd (empty-environment fallback, B4)", () => {
	it("falls back to the state dir when there are no projects, instead of throwing", () => {
		const config = parseHostToml(`listen = "127.0.0.1:4903"\n`, ROOT);
		expect(config.projects).toHaveLength(0);
		expect(serverCwd(config.bridge)).toBe(config.bridge.stateDir);
	});

	it("uses the first project's path when projects exist (no regression)", () => {
		const config = parseHostToml(`listen = "127.0.0.1:4903"\n\n[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`, ROOT);
		expect(serverCwd(config.bridge)).toBe(config.projects[0]!.cwd);
	});
});
