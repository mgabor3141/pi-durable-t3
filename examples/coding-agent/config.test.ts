// `config.toml` parsing, one test per invariant: the host-owned keys parse (with the UI-owned keys refused and named);
// the defaults; the CORS/security defaults; the semantic `listen` check; damage refused by name (types, unknown keys,
// missing file); path resolution (XDG, `--root`, `~`). Project parsing is `settings.test.ts`; the instance file is T3's
// server settings — `[[projects]]` and `default_model` are refused here with a message naming the file they belong in.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, parseConfigToml, resolvePaths } from "./config.ts";
import { tempRoot } from "../../test/temp-root.ts";

const root = "/srv/host-root";

describe("config.toml", () => {
	it("the host-owned keys parse, and the UI-owned keys are refused naming the instance file", () => {
		const config = parseConfigToml(
			`listen = "0.0.0.0:9000"\nweb = "http://localhost:5733"\ninstructions = "AGENTS.md"\n\n[t3]\nlabel = "studio"\nstate_dir = "auth"\ntoken_ttl_days = 7\ncors_origins = ["http://a", "http://b"]\n`,
			root,
		);
		expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
		expect(config.webAppUrl).toBe("http://localhost:5733");
		expect(config.instructionsPath).toBe(join(root, "AGENTS.md"));
		expect(config.label).toBe("studio");
		expect(config.stateDir).toBe(join(root, "auth"));
		expect(config.tokenTtlSeconds).toBe(7 * 86_400);
		expect(config.corsOrigins).toEqual(["http://a", "http://b"]);
		expect(() => parseConfigToml(`[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`, root)).toThrow(/projects.*projects\.json/i);
		expect(() => parseConfigToml(`default_model = "anthropic/claude-sonnet-4-5"\n`, root)).toThrow(/default_model.*settings\.json/i);
	});

	it("a minimal file carries the defaults", () => {
		const config = parseConfigToml(``, root);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
		expect(config.webAppUrl).toBeUndefined();
		expect(config.instructionsPath).toBeUndefined();
		expect(config.label).toBe("pi");
		expect(config.tokenTtlSeconds).toBe(90 * 86_400);
		expect(config.stateDir).toBe(join(root, "t3-auth"));
		expect(config.modelsStorePath).toBe(join(root, "models-store.json"));
	});

	it("CORS is the web origin by default, none without it, and an override wins; the pairing token is env-only (S4)", () => {
		expect(parseConfigToml(`web = "http://127.0.0.1:5733"\n`, root).corsOrigins).toEqual(["http://127.0.0.1:5733"]);
		expect(parseConfigToml(``, root).corsOrigins).toEqual([]);
		expect(parseConfigToml(`web = "http://127.0.0.1:5733"\n[t3]\ncors_origins = ["http://a"]\n`, root).corsOrigins).toEqual(["http://a"]);
		expect(() => parseConfigToml(`[t3]\npairing_token = "s3cr3t"\n`, root)).toThrow(/unknown key "pairing_token"/);
	});

	it("listen must be host:port with a valid, explicit port (S5)", () => {
		expect(() => parseConfigToml(`listen = "nohost"\n`, root)).toThrow(/listen "nohost" must be host:port/);
		expect(() => parseConfigToml(`listen = "host:99999"\n`, root)).toThrow(/port 1-65535/);
		expect(() => parseConfigToml(`listen = "host:"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:0"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:007"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(parseConfigToml(`listen = "127.0.0.1:65535"\n`, root).listen.port).toBe(65535);
	});

	it("damage is refused by name: wrong types, unknown keys, a missing file (an empty one is defaults)", async () => {
		expect(() => parseConfigToml(`listen = 123\n`, root)).toThrow(/config\.toml:[\s\S]*listen: must be string/);
		expect(() => parseConfigToml(`[t3]\ntoken_ttl_days = "7"\n`, root)).toThrow(/t3\.token_ttl_days: must be integer/);
		expect(() => parseConfigToml(`lstien = "127.0.0.1:1"\n`, root)).toThrow(/unknown key "lstien"/);
		expect(() => parseConfigToml(`[t3]\nlabl = "x"\n`, root)).toThrow(/t3\.unknown key "labl"/);
		const dir = await tempRoot();
		await expect(loadConfig(join(dir, "config.toml"), dir)).rejects.toThrow(/config\.toml not found/);
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
		// The missing-file message names the exact path it looked at, and points at `--root`.
		const dir = await tempRoot();
		const absent = resolvePaths([], { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") });
		await expect(loadConfig(absent.configFile, absent.dataDir)).rejects.toThrow(absent.configFile);
		await expect(loadConfig(absent.configFile, absent.dataDir)).rejects.toThrow("--root");
	});
});
