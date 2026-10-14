// The one config module. Reads the integrator's `config.toml` with `smol-toml`, validates it against one TypeBox schema
// (defaults via `Value.Default`), runs the checks the schema can't express (paths under the data dir, unique names,
// provider/model, host:port), and assembles the facet's `BridgeConfig`. `~/.pi` is never read. `resolvePaths` picks the
// config file and data dir: `--root <dir>` keeps them in one directory; otherwise XDG (`$XDG_CONFIG_HOME`,
// `$XDG_DATA_HOME`, falling back to `~/.config` and `~/.local/share`).
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { FacetConfig } from "./t3/config.ts";

/** A bad `config.toml`; its message is meant for the user as is. */
export class ConfigError extends Error {}

/** The name of this app's directory under the XDG config/data bases. */
const APP_DIR = "pi-durable-t3";

/** Where the integrator's `config.toml` is read from, and the data dir every path (storage, models store, facet state,
 * project cwds) resolves under. `--root` sets both to one directory; the XDG default splits them. */
export type Paths = { readonly configFile: string; readonly dataDir: string };

/** A project directory, resolved to an absolute `cwd` under the data dir (the invariant every env builder relies on). */
export type Project = { readonly id: string; readonly name: string; readonly cwd: string };

export type HostConfig = {
	readonly configFile: string; // the `config.toml` this config was read from (for logging and error messages).
	readonly dataDir: string; // where durable storage, the models store, facet state, and project cwds live.
	readonly listen: { readonly host: string; readonly port: number };
	readonly webAppUrl: string | undefined; // web app base URL; prints a ready-to-open pairing link at start.
	readonly modelsStorePath: string; // pi-ai models store, under the data dir so `~/.pi/agent` is never written.
	/** Absolute path to an explicit instructions file, if configured; its text is read when a thread is created. */
	readonly instructionsPath: string | undefined;
	/** The facet's integrator-owned fields. The live project registry is NOT here: it is the instance file, opened at
	 * start (`../registry.ts`) and assembled into the facet's `BridgeConfig` in `main.ts`. */
	readonly bridge: FacetConfig;
};

// One schema for the whole `config.toml`: defaults live in `default` annotations (applied by `Value.Default`) and every
// object sets `additionalProperties: false`, so an unknown key is rejected here, naming the file, the key path and what
// was expected. This file holds ONLY what a UI must not set; the project registry and the new-thread defaults (model,
// thinking level) are the instance file (`../settings.ts`), so `[[projects]]`/`default_model` are rejected below, naming
// where they belong. The checks the schema cannot express — host:port — are below.
const HostTomlSchema = Type.Object(
	{
		listen: Type.String({ default: "127.0.0.1:3774", minLength: 1 }), // the facet address; T3's own app uses 3773.
		web: Type.Optional(Type.String({ minLength: 1 })), // web app URL, only to print a pairing link.
		instructions: Type.Optional(Type.String({ minLength: 1 })), // path to a file whose text becomes new threads' instructions.
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
	// These keys moved to the instance file (settings.json, in the data dir), which the T3 UI edits. Reject them by name
	// with a message that says where they belong, before the generic unknown-key path (so the guidance is specific).
	if (parsed !== null && typeof parsed === "object") {
		for (const key of ["projects", "default_model"] as const) {
			if (key in (parsed as Record<string, unknown>)) {
				const where = key === "projects" ? `projects (a [[projects]] block)` : `the new-thread model default (default_model)`;
				fail(file, `"${key}" is not a ${file} key: ${where} belongs in the instance file settings.json in the data dir, which the T3 UI edits (see README)`);
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
		bridge: {
			host,
			port,
			label: doc.t3.label,
			stateDir: resolve(dataDir, doc.t3.state_dir ?? "t3-auth"),
			pairingToken: undefined, // from `PI_DURABLE_T3_PAIRING_TOKEN` in main.ts (tests only); never read from the file.
			tokenTtlSeconds: doc.t3.token_ttl_days * 86_400,
			corsOrigins: doc.t3.cors_origins ?? (doc.web === undefined ? [] : [originOf(doc.web)]),
		},
	};
}

/** The scheme://host:port of a URL, for use as a CORS origin; if `web` is not a parseable URL, fall back to the raw value. */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url.replace(/\/$/, "");
	}
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
 * `--root R` puts both under one directory (`R/config.toml`, data dir `R`) so an instance is a single directory —
 * byte-for-byte the layout in use. Otherwise XDG: config under `$XDG_CONFIG_HOME/pi-durable-t3` (fallback
 * `$HOME/.config/...`), data under `$XDG_DATA_HOME/pi-durable-t3` (fallback `$HOME/.local/share/...`).
 * `~` in `--root` and in the XDG env vars expands to `$HOME`. */
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

/** Expand a leading `~`/`~/` to `$HOME`, then resolve a relative path against `base` (the data dir) — an absolute path stays. */
export function expandPath(value: string, base: string): string {
	const home = process.env["HOME"] ?? ".";
	if (value === "~") return resolve(home);
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return isAbsolute(value) ? value : resolve(base, value);
}

export function fail(file: string, message: string): never {
	throw new ConfigError(`${file}: ${message}`);
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

/** The model new threads start on: the instance file's default, else the first available model. With no models
 * available, fail loudly (naming where credentials live) instead of defaulting to a blank model, which makes every
 * thread show an unexplained interrupted turn: "unset → the first available" promises a model, and it holds only when one exists. */
export function chooseDefaultModel(available: readonly { provider: string; id: string }[], configured: ModelRef | undefined): ModelRef {
	const first = available[0];
	if (first === undefined) throw new ConfigError("no models are available: add provider credentials under ~/.pi/agent (or set PI_CODING_AGENT_DIR), or run with PI_DURABLE_T3_FAKE=1 for the offline demo model");
	return configured ?? { provider: first.provider, modelId: first.id };
}

/** TypeBox errors → one line each (dotted key path + expectation); unknown keys are named, the paired `schema is false` sub-error folded in. */
export function describeErrors(file: string, errors: readonly { keyword: string; instancePath: string; message: string; params: object }[]): string {
	const dotted = (p: string) => p.split("/").filter(Boolean).reduce((o, k) => (/^\d+$/.test(k) ? `${o}[${k}]` : o ? `${o}.${k}` : k), "");
	const lines = errors.flatMap((e) => {
		const at = dotted(e.instancePath);
		if (e.keyword === "additionalProperties") return ((e.params as { additionalProperties?: string[] }).additionalProperties ?? []).map((k) => `${at ? `${at}.` : ""}unknown key "${k}"`);
		return e.keyword === "boolean" && e.message === "schema is false" ? [] : [`${at || "(root)"}: ${e.message}`];
	});
	return lines.length === 0 ? `Invalid ${file}` : `Invalid ${file}:\n  ${lines.join("\n  ")}`;
}
