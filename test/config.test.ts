// `config.toml` parsing: schema validation (with defaults, unknown-key rejection, and every error path) plus the semantic
// checks the schema can't express. Project-path containment is the design's invariant — a project's cwd must resolve
// under the data dir, or a later env builder would run tools outside it — so `../x`, an absolute path outside the data
// dir, and `a/../../b` are refused. `loadConfig` file behavior (missing vs. empty) is checked against a temp root.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseDefaultModel, loadConfig, parseConfigToml, resolvePaths } from "../src/config.ts";
import { tempRoot } from "./temp-root.ts";

const root = "/srv/host-root";

function toml(paths: string[]): string {
	return paths.map((p, i) => `[[projects]]\nname = "p${i}"\npath = "${p}"`).join("\n\n");
}

describe("project path containment", () => {
	it("accepts a relative path under the root", () => {
		const config = parseConfigToml(toml(["work"]), root);
		expect(config.projects[0]?.cwd).toBe(join(root, "work"));
	});

	it("accepts a nested path that stays under the root", () => {
		const config = parseConfigToml(toml(["a/b/c"]), root);
		expect(config.projects[0]?.cwd).toBe(join(root, "a/b/c"));
	});

	it("accepts an absolute path that stays under the root", () => {
		const config = parseConfigToml(toml([`${root}/inside`]), root);
		expect(config.projects[0]?.cwd).toBe(`${root}/inside`);
	});

	it("refuses a path that escapes the data dir", () => {
		expect(() => parseConfigToml(toml(["../outside"]), root)).toThrow(/outside the data dir/);
	});

	it("refuses an absolute path outside the data dir", () => {
		expect(() => parseConfigToml(toml(["/etc"]), root)).toThrow(/outside the data dir/);
	});

	it("refuses a path that walks back out (`a/../../b`)", () => {
		expect(() => parseConfigToml(toml(["a/../../b"]), root)).toThrow(/outside the data dir/);
	});

	it("names the offending project in the error", () => {
		expect(() => parseConfigToml(toml(["../escape"]), root)).toThrow(/path "\.\.\/escape"/);
	});
});

describe("defaults (a minimal file gets them)", () => {
	const config = parseConfigToml(`[[projects]]\nname = "only"\n`, root);

	it("listen defaults to 127.0.0.1:3774", () => {
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
	});
	it("an absent path defaults to the project name", () => {
		expect(config.projects[0]?.cwd).toBe(join(root, "only"));
	});
	it("web and default_model are absent", () => {
		expect(config.webAppUrl).toBeUndefined();
		expect(config.defaultModel).toBeUndefined();
	});
	it("the facet bridge carries its defaults", () => {
		expect(config.bridge.label).toBe("pi");
		expect(config.bridge.tokenTtlSeconds).toBe(90 * 86_400);
		expect(config.bridge.corsOrigins).toEqual([]); // no `web` set → no CORS origins (was the old wildcard default)
		expect(config.bridge.stateDir).toBe(join(root, "t3-auth"));
		expect(config.bridge.pairingToken).toBeUndefined();
		expect(config.bridge.projects).toEqual([{ id: "only", name: "only", path: join(root, "only") }]);
	});
	it("modelsStorePath sits under the data dir", () => {
		expect(config.modelsStorePath).toBe(join(root, "models-store.json"));
	});
});

describe("full document", () => {
	const config = parseConfigToml(
		`listen = "0.0.0.0:9000"\nweb = "http://localhost:5733"\ndefault_model = "anthropic/claude-sonnet-4-5"\n\n[t3]\nlabel = "studio"\nstate_dir = "auth"\ntoken_ttl_days = 7\ncors_origins = ["http://a", "http://b"]\n\n[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`,
		root,
	);
	it("parses every key", () => {
		expect(config.listen).toEqual({ host: "0.0.0.0", port: 9000 });
		expect(config.webAppUrl).toBe("http://localhost:5733");
		expect(config.defaultModel).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(config.bridge.label).toBe("studio");
		expect(config.bridge.stateDir).toBe(join(root, "auth"));
		expect(config.bridge.pairingToken).toBeUndefined(); // the fixed token is the env var, never the file
		expect(config.bridge.tokenTtlSeconds).toBe(7 * 86_400);
		expect(config.bridge.corsOrigins).toEqual(["http://a", "http://b"]);
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
	it("default_model must be provider/model", () => {
		expect(() => parseConfigToml(`default_model = "noslash"\n`, root)).toThrow(/default_model "noslash" must be provider\/model/);
		expect(() => parseConfigToml(`default_model = "/only-model"\n`, root)).toThrow(/must be provider\/model/);
		expect(() => parseConfigToml(`default_model = "only-provider/"\n`, root)).toThrow(/must be provider\/model/);
	});
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
	it("project names must be unique", () => {
		const dup = `[[projects]]\nname = "same"\npath = "a"\n\n[[projects]]\nname = "same"\npath = "b"\n`;
		expect(() => parseConfigToml(dup, root)).toThrow(/duplicate project name "same"/);
	});
});

describe("schema validation (errors name the file, key path, and expectation)", () => {
	it("rejects a wrong scalar type", () => {
		expect(() => parseConfigToml(`listen = 123\n`, root)).toThrow(/config\.toml:[\s\S]*listen: must be string/);
	});
	it("rejects a wrong nested type", () => {
		expect(() => parseConfigToml(`[t3]\ntoken_ttl_days = "7"\n`, root)).toThrow(/t3\.token_ttl_days: must be integer/);
	});
	it("rejects a project without a name", () => {
		expect(() => parseConfigToml(`[[projects]]\npath = "x"\n`, root)).toThrow(/projects\[0\]: must have required properties name/);
	});
	it("rejects projects that is not an array", () => {
		expect(() => parseConfigToml(`projects = "x"\n`, root)).toThrow(/projects: must be array/);
	});
	it("rejects an empty project name", () => {
		expect(() => parseConfigToml(`[[projects]]\nname = ""\n`, root)).toThrow(/projects\[0\]\.name: must not have fewer than/);
	});
});

describe("unknown keys are rejected (catches typos)", () => {
	it("at the top level", () => {
		expect(() => parseConfigToml(`lstien = "127.0.0.1:1"\n`, root)).toThrow(/unknown key "lstien"/);
	});
	it("inside [t3]", () => {
		expect(() => parseConfigToml(`[t3]\nlabl = "x"\n`, root)).toThrow(/t3\.unknown key "labl"/);
	});
	it("inside a project", () => {
		expect(() => parseConfigToml(`[[projects]]\nname = "a"\npaht = "x"\n`, root)).toThrow(/projects\[0\]\.unknown key "paht"/);
	});
});

describe("empty and missing files", () => {
	it("an empty file is valid: defaults, no projects", () => {
		const config = parseConfigToml("", root);
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
		expect(config.projects).toEqual([]);
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

describe("config.example.toml", () => {
	it("parses as written, with defaults applied", async () => {
		const dir = await tempRoot();
		const text = await readFile(new URL("../config.example.toml", import.meta.url), "utf8");
		const config = parseConfigToml(text, dir, "config.example.toml");
		expect(config.projects.map((p) => p.name)).toEqual(["alpha"]);
		expect(config.projects[0]!.cwd).toBe(join(dir, "alpha"));
		expect(config.listen).toEqual({ host: "127.0.0.1", port: 3774 });
		expect(config.webAppUrl).toBeUndefined();
		expect(config.defaultModel).toBeUndefined();
	});
});
