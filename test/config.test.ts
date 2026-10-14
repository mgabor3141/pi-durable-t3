// `config.toml` parsing: schema validation (with defaults, unknown-key rejection, and every error path) plus the semantic
// checks the schema can't express (host:port). This file holds ONLY what a UI must not set; the project registry and the
// new-thread model default moved to the instance file (`settings.json`), so a `[[projects]]` block or a `default_model`
// key is refused here with a message naming the file they belong in. Project parsing is tested in `settings.test.ts`.
// `loadConfig` file behavior (missing vs. empty) is checked against a temp root.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseDefaultModel, loadConfig, parseConfigToml, resolvePaths } from "../src/config.ts";
import { tempRoot } from "./temp-root.ts";

const root = "/srv/host-root";

describe("config.toml holds only host-owned keys", () => {
	it("listen, web, instructions, and the [t3] table parse; projects and default_model are gone", () => {
		const config = parseConfigToml(
			`listen = "0.0.0.0:9000"\nweb = "http://localhost:5733"\ninstructions = "AGENTS.md"\n\n[t3]\nlabel = "studio"\nstate_dir = "auth"\ntoken_ttl_days = 7\ncors_origins = ["http://a", "http://b"]\n`,
			root,
		);
		expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
		expect(config.webAppUrl).toBe("http://localhost:5733");
		expect(config.instructionsPath).toBe(join(root, "AGENTS.md"));
		expect(config.bridge.label).toBe("studio");
		expect(config.bridge.stateDir).toBe(join(root, "auth"));
		expect(config.bridge.tokenTtlSeconds).toBe(7 * 86_400);
		expect(config.bridge.corsOrigins).toEqual(["http://a", "http://b"]);
	});

	it("a [[projects]] block is refused and names the instance file", () => {
		expect(() => parseConfigToml(`[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`, root)).toThrow(/projects.*settings\.json/i);
		expect(() => parseConfigToml(`[[projects]]\nname = "alpha"\n`, root)).toThrow(/config\.toml/);
	});

	it("a default_model key is refused and names the instance file", () => {
		expect(() => parseConfigToml(`default_model = "anthropic/claude-sonnet-4-5"\n`, root)).toThrow(/default_model.*settings\.json/i);
	});
});

describe("defaults (a minimal file gets them)", () => {
	const config = parseConfigToml(``, root);
	it("listen defaults to 127.0.0.1:3774", () => {
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
	});
	it("web and instructions are absent", () => {
		expect(config.webAppUrl).toBeUndefined();
		expect(config.instructionsPath).toBeUndefined();
	});
	it("the facet bridge carries its defaults", () => {
		expect(config.bridge.label).toBe("pi");
		expect(config.bridge.tokenTtlSeconds).toBe(90 * 86_400);
		expect(config.bridge.corsOrigins).toEqual([]); // no `web` set → no CORS origins
		expect(config.bridge.stateDir).toBe(join(root, "t3-auth"));
		expect(config.bridge.pairingToken).toBeUndefined();
	});
	it("modelsStorePath sits under the data dir", () => {
		expect(config.modelsStorePath).toBe(join(root, "models-store.json"));
	});
});

describe("security defaults (S4)", () => {
	it("CORS defaults to the web origin when web is set", () => {
		expect(parseConfigToml(`web = "http://127.0.0.1:5733"\n`, root).bridge.corsOrigins).toEqual(["http://127.0.0.1:5733"]);
	});
	it("CORS defaults to none when web is unset (no wildcard)", () => {
		expect(parseConfigToml(``, root).bridge.corsOrigins).toEqual([]);
	});
	it("CORS honours an explicit override", () => {
		expect(parseConfigToml(`web = "http://127.0.0.1:5733"\n[t3]\ncors_origins = ["http://a"]\n`, root).bridge.corsOrigins).toEqual(["http://a"]);
	});
	it("pairing_token is rejected in config.toml (env var only)", () => {
		expect(() => parseConfigToml(`[t3]\npairing_token = "s3cr3t"\n`, root)).toThrow(/unknown key "pairing_token"/);
	});
});

describe("semantic checks after validation", () => {
	it("listen must be host:port with a valid, explicit port (S5)", () => {
		expect(() => parseConfigToml(`listen = "nohost"\n`, root)).toThrow(/listen "nohost" must be host:port/);
		expect(() => parseConfigToml(`listen = "host:99999"\n`, root)).toThrow(/port 1-65535/);
		// A bare host, a zero port, and a leading zero are typos that must fail, not bind an ephemeral/wrong port.
		expect(() => parseConfigToml(`listen = "host:"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:0"\n`, root)).toThrow(/explicit port 1-65535/);
		expect(() => parseConfigToml(`listen = "127.0.0.1:007"\n`, root)).toThrow(/explicit port 1-65535/);
		// Valid ports, including the extremes.
		expect(parseConfigToml(`listen = "127.0.0.1:1"\n`, root).listen.port).toBe(1);
		expect(parseConfigToml(`listen = "127.0.0.1:65535"\n`, root).listen.port).toBe(65535);
	});
});

describe("schema validation (errors name the file, key path, and expectation)", () => {
	it("rejects a wrong scalar type", () => {
		expect(() => parseConfigToml(`listen = 123\n`, root)).toThrow(/config\.toml:[\s\S]*listen: must be string/);
	});
	it("rejects a wrong nested type", () => {
		expect(() => parseConfigToml(`[t3]\ntoken_ttl_days = "7"\n`, root)).toThrow(/t3\.token_ttl_days: must be integer/);
	});
});

describe("unknown keys are rejected (catches typos)", () => {
	it("at the top level", () => {
		expect(() => parseConfigToml(`lstien = "127.0.0.1:1"\n`, root)).toThrow(/unknown key "lstien"/);
	});
	it("inside [t3]", () => {
		expect(() => parseConfigToml(`[t3]\nlabl = "x"\n`, root)).toThrow(/t3\.unknown key "labl"/);
	});
});

describe("empty and missing files", () => {
	it("an empty file is valid: defaults apply", () => {
		const config = parseConfigToml("", root);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
		expect(config.bridge.label).toBe("pi");
	});

	it("a missing config.toml is an error naming the path", async () => {
		const dir = await tempRoot();
		await expect(loadConfig(join(dir, "config.toml"), dir)).rejects.toThrow(/config\.toml not found/);
	});

	it("an empty config.toml on disk loads with defaults", async () => {
		const dir = await tempRoot();
		await writeFile(join(dir, "config.toml"), "");
		const config = await loadConfig(join(dir, "config.toml"), dir);
		expect(config.listen.port).toBe(3774);
		expect(config.dataDir).toBe(dir);
	});
});

describe("resolvePaths: XDG config/data, --root overrides both, ~ expansion", () => {
	it("honors XDG_CONFIG_HOME and XDG_DATA_HOME", () => {
		const p = resolvePaths([], { HOME: "/home/tester", XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" });
		expect(p.configFile).toBe(join("/xdg/config", "pi-durable-t3", "config.toml"));
		expect(p.dataDir).toBe(join("/xdg/data", "pi-durable-t3"));
	});

	it("falls back to ~/.config and ~/.local/share when XDG is unset", () => {
		const p = resolvePaths([], { HOME: "/home/tester" });
		expect(p.configFile).toBe(join("/home/tester", ".config", "pi-durable-t3", "config.toml"));
		expect(p.dataDir).toBe(join("/home/tester", ".local/share", "pi-durable-t3"));
	});

	it("--root beats both XDG dirs and puts config + data in one directory", () => {
		const p = resolvePaths(["--root", "/srv/instance"], { HOME: "/home/tester", XDG_CONFIG_HOME: "/xdg/config", XDG_DATA_HOME: "/xdg/data" });
		expect(p.configFile).toBe(join("/srv/instance", "config.toml"));
		expect(p.dataDir).toBe("/srv/instance");
	});

	it("expands ~ in --root", () => {
		const p = resolvePaths(["--root", "~/instance"], { HOME: "/home/tester" });
		expect(p.dataDir).toBe(join("/home/tester", "instance"));
		expect(p.configFile).toBe(join("/home/tester", "instance", "config.toml"));
	});

	it("expands ~ in the XDG dirs", () => {
		const p = resolvePaths([], { HOME: "/home/tester", XDG_CONFIG_HOME: "~/cfg", XDG_DATA_HOME: "~/data" });
		expect(p.configFile).toBe(join("/home/tester", "cfg", "pi-durable-t3", "config.toml"));
		expect(p.dataDir).toBe(join("/home/tester", "data", "pi-durable-t3"));
	});
});

describe("the missing-file message names the XDG path and --root", () => {
	it("an absent XDG config is an error naming the path it looked at", async () => {
		const dir = await tempRoot(); // an isolated HOME with no config written anywhere.
		const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data") };
		const p = resolvePaths([], env);
		// The message names the exact XDG config file it looked at, and points at `--root`.
		await expect(loadConfig(p.configFile, p.dataDir)).rejects.toThrow(p.configFile);
		await expect(loadConfig(p.configFile, p.dataDir)).rejects.toThrow("--root");
	});
});

describe("chooseDefaultModel (S1)", () => {
	it("is the first available model when none is configured", () => {
		expect(chooseDefaultModel([{ provider: "anthropic", id: "sonnet" }], undefined)).toEqual({ provider: "anthropic", modelId: "sonnet" });
	});
	it("is the configured model when one is set", () => {
		expect(chooseDefaultModel([{ provider: "a", id: "m" }], { provider: "x", modelId: "y" })).toEqual({ provider: "x", modelId: "y" });
	});
	it("fails at start, naming ~/.pi/agent, when no models are available", () => {
		expect(() => chooseDefaultModel([], undefined)).toThrow(/no models are available/);
		expect(() => chooseDefaultModel([], undefined)).toThrow(/~\/\.pi\/agent/);
	});
});
