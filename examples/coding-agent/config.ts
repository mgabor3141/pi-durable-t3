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
import { ConfigError, describeErrors, expandPath, fail } from "../../src/config.ts";

export { ConfigError, expandPath, fail };

/** The name of this app's directory under the XDG config/data bases. */
const APP_DIR = "pi-durable-t3";

/** Where the integrator's `config.toml` is read from, and the data dir every path (storage, models store, facet state,
 * project cwds) resolves under. `--root` sets both to one directory; the XDG default splits them. */
export type Paths = { readonly configFile: string; readonly dataDir: string };

export type HostConfig = {
	readonly configFile: string; // the `config.toml` this config was read from (for logging and error messages).
	readonly dataDir: string; // where durable storage, the models store, facet state, and project cwds live.
	readonly listen: { readonly host: string; readonly port: number };
	readonly webAppUrl: string | undefined; // web app base URL; prints a ready-to-open pairing link at start.
	readonly modelsStorePath: string; // pi-ai models store, under the data dir so `~/.pi/agent` is never written.
	/** Absolute path to an explicit instructions file, if configured; its text joins every thread's system prompt, re-read each turn. */
	readonly instructionsPath: string | undefined;
	readonly label: string;
	readonly stateDir: string;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[] | undefined;
};

// One schema for the whole `config.toml`. This file holds ONLY what a UI must not set; UI-edited settings live in
// the data dir - the registry (`projects.json`) and T3's server settings (`settings.json`) - so `[[projects]]` and
// `default_model` are rejected below, naming where they belong.
const HostTomlSchema = Type.Object(
	{
		listen: Type.String({ default: "127.0.0.1:3774", minLength: 1 }), // the facet address; T3's own app uses 3773.
		web: Type.Optional(Type.String({ minLength: 1 })), // web app URL, only to print a pairing link.
		instructions: Type.Optional(Type.String({ minLength: 1 })), // path to a file whose text joins the system prompt.
		t3: Type.Object(
			{
				label: Type.String({ default: "pi", minLength: 1 }),
				state_dir: Type.Optional(Type.String({ minLength: 1 })), // facet state dir, relative to the data dir.
				// `pairing_token` is intentionally not a config key: it is the `PI_DURABLE_T3_PAIRING_TOKEN` env var, for
				// tests only. A reusable static token in a file is the wrong default for a control plane that runs `bash`
				// with no approvals, so putting it in `config.toml` is now rejected here as an unknown key.
				token_ttl_days: Type.Integer({ default: 90, minimum: 1 }),
				// CORS origins: unset takes the `web` origin. With `web` unset the list is empty, and Effect's CORS router
				// answers `Access-Control-Allow-Origin: *` — harmless while every call needs a bearer token and the Host
				// check stands, but set `web` to pin it. Set this key to override either way.
				cors_origins: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false },
);
type HostToml = Type.Static<typeof HostTomlSchema>;

/** Parse and validate `config.toml` text for `dataDir` (TOML → defaults → schema → checks). Every path (models store,
 * facet state, relative `instructions`) resolves under `dataDir`; `file` names the source in messages. Empty is valid.
 * `[[projects]]` and `default_model` are refused with a message naming the instance file they belong in. */
export function parseConfigToml(text: string, dataDir: string, file = "config.toml"): HostConfig {
	let parsed: unknown;
	try {
		parsed = parse(text);
	} catch (error) {
		fail(file, (error as Error).message);
	}
	// These keys moved to the data dir, which the T3 UI edits through the host: projects to the registry file
	// (`projects.json`), the model default to T3's server settings (`settings.json`, the UI's model picker writes it).
	// Reject them by name with a message that says where they belong, before the generic unknown-key path.
	if (parsed !== null && typeof parsed === "object") {
		for (const key of ["projects", "default_model"] as const) {
			if (key in (parsed as Record<string, unknown>)) {
				const where = key === "projects"
					? `projects (a [[projects]] block) belongs in the registry file projects.json in the data dir, which the T3 UI edits`
					: `the new-thread model default (default_model) belongs in T3's server settings, the data dir's settings.json, which the UI's model picker writes`;
				fail(file, `"${key}" is not a ${file} key: ${where} (see README)`);
			}
		}
	}
	const doc = Value.Default(HostTomlSchema, parsed) as HostToml;
	const errors = [...Value.Errors(HostTomlSchema, doc)];
	if (errors.length > 0) throw new ConfigError(describeErrors(file, errors));
	const { host, port } = parseListen(doc.listen, file);
	return {
		configFile: file,
		dataDir,
		listen: { host, port },
		webAppUrl: doc.web,
		modelsStorePath: join(dataDir, "models-store.json"),
		instructionsPath: doc.instructions === undefined ? undefined : expandPath(doc.instructions, dataDir),
		label: doc.t3.label,
		stateDir: resolve(dataDir, doc.t3.state_dir ?? "t3-auth"),
		tokenTtlSeconds: doc.t3.token_ttl_days * 86_400,
		corsOrigins: doc.t3.cors_origins,
	};
}

/** Read and validate the integrator's `config.toml` (at `configFile`), resolving every path under `dataDir`. A missing
 * file is an error that names the path looked at and points at `--root`; an empty file is valid (defaults, no projects).
 * If an `instructions` file is configured, it must be readable here too, so a bad path fails at start, not at create. */
export async function loadConfig(configFile: string, dataDir: string): Promise<HostConfig> {
	let config: HostConfig;
	try {
		config = parseConfigToml(await readFile(configFile, "utf8"), dataDir, configFile);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			fail(configFile, `config.toml not found: write it there (see config.example.toml) or pass --root <dir> for a single-directory instance`);
		throw error;
	}
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
