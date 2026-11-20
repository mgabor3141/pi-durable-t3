// Small shared pieces the bridge needs from "configuration": the typed config error, the `~`-expanding path resolver,
// and the path-derived `Project` record. The integrator's config FILE is not the bridge's concern (design.md, The split).
import { isAbsolute, resolve } from "node:path";

/** A configuration refusal; its message is meant for the user as is. */
export class ConfigError extends Error {}

/** A project directory, resolved to an absolute `cwd`. The registry's unit of registration. */
export type Project = { readonly id: string; readonly name: string; readonly cwd: string };

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
