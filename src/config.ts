// Small shared pieces the bridge needs from "configuration": the typed config error, the `~`-expanding path resolver,
// and the path-derived `Project` record. The integrator's config FILE is not the bridge's concern (design.md, The split).
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/** Whether `path` is `root` or lies under it, lexically (both should be resolved absolute paths). */
export function isInsidePath(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function fail(file: string, message: string): never {
	throw new ConfigError(`${file}: ${message}`);
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
