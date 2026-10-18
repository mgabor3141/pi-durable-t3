// `config.toml` parsing, one test per invariant: the keys parse; the defaults; the CORS default; the semantic `listen`
// check; damage refused by name (types, unknown keys); path resolution (XDG, `--root`, `~`).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfigToml, resolvePaths } from "../src/config.ts";
import { tempRoot } from "../../../test/temp-root.ts";

const root = "/srv/host-root";

describe("config.toml", () => {
	it("every key parses", () => {
		const config = parseConfigToml(
			`listen = "0.0.0.0:9000"\ninstructions = "AGENTS.md"\nlabel = "studio"\nscratch_dir = "ws-scratch"\ntoken_ttl_days = 7\ncors_origins = ["http://a", "http://b"]\ntailscale_serve = true\ntailscale_serve_port = 8443\n`,
			root,
		);
		expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
		expect(config.instructionsPath).toBe(join(root, "AGENTS.md"));
		expect(config.label).toBe("studio");
		expect(config.scratchDir).toBe(join(root, "ws-scratch"));
		expect(config.tokenTtlSeconds).toBe(7 * 86_400);
		expect(config.corsOrigins).toEqual(["http://a", "http://b"]);
		expect(config.tailscaleServe).toBe(true);
		expect(config.tailscaleServePort).toBe(8443);
	});

	it("Tailscale Serve is off by default, and 443 is the port that needs no name", () => {
		const config = parseConfigToml(``, root);
		expect([config.tailscaleServe, config.tailscaleServePort], "unset").toEqual([false, 443]);
		// Enabling without a port is the whole feature: Serve's HTTPS port defaults to 443, T3's own default.
		const enabled = parseConfigToml(`tailscale_serve = true\n`, root);
		expect([enabled.tailscaleServe, enabled.tailscaleServePort]).toEqual([true, 443]);
		// A port is a port: the range is the schema's, and the port only means anything with Serve on.
		expect(() => parseConfigToml(`tailscale_serve_port = 0\n`, root)).toThrow(/tailscale_serve_port/);
		expect(() => parseConfigToml(`tailscale_serve_port = 70000\n`, root)).toThrow(/tailscale_serve_port/);
		expect(() => parseConfigToml(`tailscale_serve = "yes"\n`, root)).toThrow(/tailscale_serve: must be boolean/);
	});

	it("a minimal file carries the defaults", () => {
		const config = parseConfigToml(``, root);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
		expect(config.instructionsPath).toBeUndefined();
		expect(config.label).toBe("pi");
		expect(config.tokenTtlSeconds).toBe(90 * 86_400);
		// The state dir is fixed under the data dir; the scratch root defaults under it.
		expect(config.stateDir).toBe(join(root, "t3"));
		expect(config.scratchDir).toBe(join(root, "scratch"));
		expect(config.modelsStorePath).toBe(join(root, "models-store.json"));
	});

	it("CORS is the bridge default when unset, and an override wins", () => {
		expect(parseConfigToml(``, root).corsOrigins, "unset: the bridge's default").toBeUndefined();
		expect(parseConfigToml(`cors_origins = ["http://a"]\n`, root).corsOrigins).toEqual(["http://a"]);
	});

	it("listen must be host:port with a valid, explicit port (S5)", () => {
		expect(() => parseConfigToml(`listen = "nohost"\n`, root)).toThrow(/listen "nohost" must be host:port/);
		expect(() => parseConfigToml(`listen = "host:99999"\n`, root)).toThrow(/port 1-65535/);
		expect(() => parseConfigToml(`listen = "host:"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:0"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:007"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(parseConfigToml(`listen = "127.0.0.1:65535"\n`, root).listen.port).toBe(65535);
	});

	it("damage is refused by name (wrong types, unknown keys); a missing or empty file is the defaults", async () => {
		expect(() => parseConfigToml(`listen = 123\n`, root)).toThrow(/config\.toml:[\s\S]*listen: must be string/);
		expect(() => parseConfigToml(`token_ttl_days = "7"\n`, root)).toThrow(/token_ttl_days: must be integer/);
		expect(() => parseConfigToml(`lstien = "127.0.0.1:1"\n`, root)).toThrow(/unknown key "lstien"/);
		expect(() => parseConfigToml(`tailscale_serve = false\ntailscale-serve = true\n`, root)).toThrow(/unknown key/);
		const dir = await tempRoot();
		expect((await loadConfig(join(dir, "config.toml"), dir)).listen.port, "missing: the defaults").toBe(3774);
		await writeFile(join(dir, "config.toml"), "");
		const config = await loadConfig(join(dir, "config.toml"), dir);
		expect(config.listen.port).toBe(3774);
		expect(config.dataDir).toBe(dir);
	});

	it("paths: XDG config/data, the ~/.config fallback, --root over both, and ~ expansion", async () => {
		const xdg = resolvePaths([], { HOME: "/home/tester", XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" });
		expect(xdg.configFile).toBe(join("/xdg/config", "pi-durable-t3", "config.toml"));
		expect(xdg.dataDir).toBe(join("/xdg/data", "pi-durable-t3"));
		const fallback = resolvePaths([], { HOME: "/home/tester" });
		expect(fallback.configFile).toBe(join("/home/tester", ".config", "pi-durable-t3", "config.toml"));
		expect(fallback.dataDir).toBe(join("/home/tester", ".local/share", "pi-durable-t3"));
		const overridden = resolvePaths(["--root", "/srv/instance"], { HOME: "/home/tester", XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" });
		expect(overridden.configFile).toBe(join("/srv/instance", "config.toml"));
		expect(overridden.dataDir).toBe("/srv/instance");
		const expanded = resolvePaths(["--root", "~/instance"], { HOME: "/home/tester", XDG_CONFIG_HOME: "~/cfg", XDG_DATA_HOME: "~/data" });
		expect(expanded.dataDir).toBe(join("/home/tester", "instance"));
		expect(resolvePaths([], { HOME: "/home/tester", XDG_CONFIG_HOME: "~/cfg", XDG_DATA_HOME: "~/data" }).configFile).toBe(join("/home/tester", "cfg", "pi-durable-t3", "config.toml"));
	});
});
