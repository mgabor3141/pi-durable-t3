// The instance file: `settings.json` in the data dir — the tier T3's UI edits, written by the host on the UI's behalf.
// It holds the project registry and the new-thread defaults (the model and thinking level a new thread starts on).
// The integrator's `config.toml` keeps what a UI must not set. Reading: the instance file over defaults, validated
// against ONE TypeBox schema (defaults via `Value.Default`, `additionalProperties: false`, semantic checks after, a
// `ConfigError` printed without a stack). A missing file is VALID (an empty registry). This is state the host owns:
// the running host writes it; a thread never reaches it.
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelRef } from "@earendil-works/pi-durable";
import { ConfigError, describeErrors, expandPath, fail } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";
import { splitSlug } from "./t3/model-types.ts";

/** The file name, in the data dir. */
export const INSTANCE_FILE = "settings.json";

/** A project as stored in the instance file: a path the user chose, plus a free title label. No id — the id is the path. */
export type InstanceProject = { readonly path: string; readonly title?: string };

/** The new-thread defaults a UI edits. `model` is a `provider/model` slug; `thinkingLevel` mirrors pi-ai's levels. */
export type InstanceDefaults = { readonly model?: string; readonly thinkingLevel?: string };

export type InstanceFile = { readonly projects: readonly InstanceProject[]; readonly defaults: InstanceDefaults };

/** The resolved instance: projects carry a derived id, absolute `cwd`, and a title; defaults are typed. */
export type ResolvedProject = { readonly id: string; readonly title: string; readonly cwd: string };
export type ResolvedInstance = {
	readonly projects: readonly ResolvedProject[];
	readonly model: ModelRef | undefined; // the model a new thread starts on, if set; else the first available.
	readonly thinkingLevel: string; // the thinking level a new thread starts on.
};

/** pi-ai's model thinking levels (the array is not exported from the package index). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// One schema for the whole `settings.json`: defaults in `default` annotations (applied by `Value.Default`), every object
// `additionalProperties: false` (an unknown key names the file, key path, and expectation). The checks the schema cannot
// express (a `provider/model` slug, a known thinking level, a unique normalized path) are after validation.
const InstanceFileSchema = Type.Object(
	{
		projects: Type.Array(
			Type.Object({ path: Type.String({ minLength: 1 }), title: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
			{ default: [] },
		),
		defaults: Type.Object(
			{
				model: Type.Optional(Type.String({ minLength: 1 })), // `provider/model` new threads start on.
				thinkingLevel: Type.String({ default: "off" }), // pi-ai thinking level new threads start on.
			},
			{ additionalProperties: false, default: {} },
		),
	},
	{ additionalProperties: false },
);
type InstanceFileDoc = Type.Static<typeof InstanceFileSchema>;

/** Parse and validate `settings.json` text for `dataDir` (JSON → defaults → schema → checks). A project's `path` is
 * expanded (`~`) and resolved under `dataDir` (an absolute path stays); the title defaults to the folder's basename. A
 * duplicate normalized path is refused — a project is a path, and T3 refuses the same folder twice. `file` names the
 * source in messages. An empty object is valid (an empty registry, defaults). */
export function parseSettingsJson(text: string, dataDir: string, file = INSTANCE_FILE): ResolvedInstance {
	let parsed: unknown;
	try {
		parsed = text.trim() === "" ? {} : JSON.parse(text);
	} catch (error) {
		fail(file, (error as Error).message);
	}
	const doc = Value.Default(InstanceFileSchema, parsed) as InstanceFileDoc;
	const errors = [...Value.Errors(InstanceFileSchema, doc)];
	if (errors.length > 0) throw new ConfigError(describeErrors(file, errors));
	return resolveInstance(doc, dataDir, file);
}

/** Turn a validated document into a resolved instance: derive ids, expand/resolve paths, refuse duplicate paths, parse
 * the model slug, and check the thinking level. */
function resolveInstance(doc: InstanceFileDoc, dataDir: string, file: string): ResolvedInstance {
	const projects: ResolvedProject[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of doc.projects.entries()) {
		const cwd = expandPath(entry.path, dataDir);
		if (seen.has(cwd)) fail(file, `projects[${index}]: duplicate project path "${entry.path}" (resolved ${cwd}); a project is a path, and the title is a label`);
		seen.add(cwd);
		projects.push({ id: projectIdForPath(cwd), title: entry.title ?? (basename(cwd) || cwd), cwd });
	}
	const model = doc.defaults.model === undefined ? undefined : parseModel(doc.defaults.model, file);
	if (!THINKING_LEVELS.includes(doc.defaults.thinkingLevel as (typeof THINKING_LEVELS)[number])) {
		fail(file, `defaults.thinkingLevel "${doc.defaults.thinkingLevel}" must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return { projects, model, thinkingLevel: doc.defaults.thinkingLevel };
}

/** Split `provider/model`; both parts must be non-empty. */
function parseModel(value: string, file: string): ModelRef {
	const model = splitSlug(value);
	if (model === undefined) fail(file, `defaults.model "${value}" must be provider/model`);
	return model;
}

/** Read and validate the instance file. A MISSING file is valid — an empty registry, the defaults — so a first run is
 * not an error; the caller warns about an empty registry the way it warns about no projects today. */
export async function loadInstanceFile(dataDir: string): Promise<ResolvedInstance> {
	const file = `${dataDir}/${INSTANCE_FILE}`;
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [], model: undefined, thinkingLevel: "off" };
		throw error;
	}
	return parseSettingsJson(text, dataDir, file);
}

/** Atomically write the instance file (temp → rename), so a crash never leaves a half-written registry. The raw
 * instance-file shape (paths + titles + defaults) is written; ids are never stored (they are derived from paths). */
export async function writeInstanceFile(dataDir: string, file: InstanceFile): Promise<void> {
	const path = `${dataDir}/${INSTANCE_FILE}`;
	const tmp = `${path}.tmp`;
	await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, path);
}
