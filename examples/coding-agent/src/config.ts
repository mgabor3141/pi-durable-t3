// The example's integrator file: `config.toml`, read with `smol-toml` and validated against one TypeBox schema
// (defaults via `Value.Default`, `additionalProperties: false` so an unknown key is rejected, naming the file, key
// path, and what was expected; checks the schema cannot express are below). The bridge takes plain options
// (`attachT3`); parsing a file is this example's choice. `~/.pi` is never read. `resolvePaths` picks the config file
// and data dir: `--root <dir>` keeps them in one directory; otherwise XDG (`$XDG_CONFIG_HOME`, `$XDG_DATA_HOME`,
// falling back to `~/.config` and `~/.local/share`).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "smol-toml";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ConfigError } from "../../../src/bridge.ts";

export { ConfigError };

function fail(file: string, message: string): never {
	throw new ConfigError(`${file}: ${message}`);
}

/** TypeBox errors, one line each: the dotted key path and what was expected; unknown keys are named. */
function describeErrors(file: string, errors: readonly { keyword: string; instancePath: string; message: string; params: object }[]): string {
	const lines = errors.flatMap((e) => {
		const at = e.instancePath.split("/").filter(Boolean).join(".");
		if (e.keyword === "additionalProperties") return ((e.params as { additionalProperties?: string[] }).additionalProperties ?? []).map((k) => `${at ? `${at}.` : ""}unknown key "${k}"`);
		return e.keyword === "boolean" && e.message === "schema is false" ? [] : [`${at || "(root)"}: ${e.message}`];
	});
	return lines.length === 0 ? `Invalid ${file}` : `Invalid ${file}:\n  ${lines.join("\n  ")}`;
}

/** The name of this app's directory under the XDG config/data bases. */
const APP_DIR = "pi-durable-t3";

/** Where the integrator's `config.toml` is read from, and the data dir every path (storage, models store, scratch
 * root, relative keys) resolves under. `--root` sets both to one directory; the XDG default splits them. */
export type Paths = { readonly configFile: string; readonly dataDir: string };

export type HostConfig = {
	readonly configFile: string; // the `config.toml` this config was read from (for logging and error messages).
	readonly dataDir: string; // where the harness files (durable storage, models store) live, and what relative paths resolve under.
	readonly listen: { readonly host: string; readonly port: number };
	readonly modelsStorePath: string; // pi-ai models store, under the data dir so `~/.pi/agent` is never written.
	/** Absolute path to an explicit instructions file, if configured; its text joins every thread's system prompt, re-read each turn. */
	readonly instructionsPath: string | undefined;
	readonly label: string;
	/** The bridge's dir (`attachT3`'s `stateDir`): t3-settings.json, projects.json, auth.json — the bridge owns it. */
	readonly stateDir: string;
	/** The Scratch project's root (agent work output); under the data dir by default. */
	readonly scratchDir: string;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[] | undefined;
	/** Tailscale Serve: publish the host on the tailnet HTTPS name (`tailscale serve`), and the HTTPS port to publish on. */
	readonly tailscaleServe: boolean;
	readonly tailscaleServePort: number;
};

// One flat schema for `config.toml`: the example host's own options, mostly passed straight to `attachT3`. Projects and
// the default model are not here: the T3 UI edits them (the bridge's projects.json and t3-settings.json).
const HostTomlSchema = Type.Object(
	{
		listen: Type.String({ default: "127.0.0.1:3774", minLength: 1 }),
		instructions: Type.Optional(Type.String({ minLength: 1 })),
		label: Type.String({ default: "pi", minLength: 1 }),
		scratch_dir: Type.Optional(Type.String({ minLength: 1 })),
		token_ttl_days: Type.Integer({ default: 90, minimum: 1 }),
		cors_origins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		tailscale_serve: Type.Boolean({ default: false }),
		tailscale_serve_port: Type.Integer({ default: 443, minimum: 1, maximum: 65_535 }),
	},
	{ additionalProperties: false },
);
type HostToml = Type.Static<typeof HostTomlSchema>;

/** Parse and validate `config.toml` text for `dataDir` (TOML → defaults → schema → checks). Every relative path
 * (models store, scratch dir, relative `instructions`) resolves under `dataDir`; `file` names the source in messages.
 * Empty is valid; unknown keys are an error. */
export function parseConfigToml(text: string, dataDir: string, file = "config.toml"): HostConfig {
	let parsed: unknown;
	try {
		parsed = parse(text);
	} catch (error) {
		fail(file, (error as Error).message);
	}
	const doc = Value.Default(HostTomlSchema, parsed) as HostToml;
	const errors = [...Value.Errors(HostTomlSchema, doc)];
	if (errors.length > 0) throw new ConfigError(describeErrors(file, errors));
	const { host, port } = parseListen(doc.listen, file);
	return {
		configFile: file,
		dataDir,
		listen: { host, port },
		modelsStorePath: join(dataDir, "models-store.json"),
		instructionsPath: doc.instructions === undefined ? undefined : resolve(dataDir, expandHome(doc.instructions, process.env)),
		label: doc.label,
		stateDir: join(dataDir, "t3"),
		scratchDir: resolve(dataDir, doc.scratch_dir ?? "scratch"),
		tokenTtlSeconds: doc.token_ttl_days * 86_400,
		corsOrigins: doc.cors_origins,
		tailscaleServe: doc.tailscale_serve,
		tailscaleServePort: doc.tailscale_serve_port,
	};
}

/** Read and validate the integrator's `config.toml` (at `configFile`), resolving every path under `dataDir`. A missing
 * or empty file is the defaults: every key is optional.
 * If an `instructions` file is configured, it must be readable here too, so a bad path fails at start, not at create. */
export async function loadConfig(configFile: string, dataDir: string): Promise<HostConfig> {
	const text = await readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	const config = parseConfigToml(text, dataDir, configFile);
	if (config.instructionsPath !== undefined) {
		try {
			await readFile(config.instructionsPath, "utf8");
		} catch (error) {
			fail(configFile, `instructions file ${config.instructionsPath} is not readable: ${(error as Error).message}`);
		}
	}
	return config;
}

/** Resolve where the config file is read from and where data lives.
 * `--root R` puts both under one directory (`R/config.toml`, data dir `R`) so an instance is a single directory.
 * Otherwise XDG: config under `$XDG_CONFIG_HOME/pi-durable-t3` (fallback `$HOME/.config/...`), data under
 * `$XDG_DATA_HOME/pi-durable-t3` (fallback `$HOME/.local/share/...`). `~` in `--root` and in the XDG env vars
 * expands to `$HOME`. */
export function resolvePaths(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Paths {
	const rootArg = rootArgFromArgv(argv);
	if (rootArg !== undefined) {
		const root = expandHome(rootArg, env);
		return { configFile: join(root, "config.toml"), dataDir: root };
	}
	return { configFile: join(xdgDir("XDG_CONFIG_HOME", ".config", env), APP_DIR, "config.toml"), dataDir: join(xdgDir("XDG_DATA_HOME", ".local/share", env), APP_DIR) };
}

/** The value after `--root` in argv, if any — `undefined` when absent, at the end, or followed by another flag. */
function rootArgFromArgv(argv: readonly string[]): string | undefined {
	const index = argv.indexOf("--root");
	const value = index >= 0 ? argv[index + 1] : undefined;
	if (value === undefined || value.startsWith("--")) return undefined;
	return value;
}

/** The XDG base for `key` (e.g. `XDG_CONFIG_HOME`): its value when set, else `$HOME/<fallback>`. A set value is used as
 * given (so an empty one is honoured as a real path); a leading `~` expands to `$HOME`. */
function xdgDir(key: string, fallback: string, env: NodeJS.ProcessEnv): string {
	const value = env[key];
	if (value !== undefined && value !== "") return expandHome(value, env);
	return join(expandHome(env["HOME"] ?? ".", env), fallback);
}

/** Expand a leading `~`/`~/` to `$HOME`; any other path is returned unchanged (so `resolve`/`join` keep it absolute). */
function expandHome(value: string, env: NodeJS.ProcessEnv): string {
	const home = env["HOME"] ?? ".";
	if (value === "~") return resolve(home);
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return value;
}

/** Split `host:port` into its parts. The port is required, explicit and bounded: a bare `host:` (empty), a `0`, or a
 * leading zero (a likely typo that would otherwise bind an ephemeral/wrong port) is rejected, not silently accepted. */
function parseListen(value: string, file: string): { host: string; port: number } {
	const index = value.lastIndexOf(":");
	const host = index < 0 ? "" : value.slice(0, index);
	const portText = index < 0 ? "" : value.slice(index + 1);
	// Digits only, first digit non-zero (so no empty, no `0`, no leading zeros), at most five digits.
	if (host === "" || !/^[1-9]\d{0,4}$/.test(portText)) fail(file, `listen "${value}" must be host:port with an explicit port 1-65535 (no leading zeros)`);
	const port = Number(portText);
	if (port > 65_535) fail(file, `listen "${value}" must be host:port with an explicit port 1-65535 (no leading zeros)`);
	return { host, port };
}
