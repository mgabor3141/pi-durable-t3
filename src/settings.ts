// The instance file: `settings.json` in the data dir — the tier T3's UI edits, written by the host on the UI's behalf.
// It holds the project registry and the new-thread defaults (the model and thinking level a new thread starts on).
// The integrator's `config.toml` keeps what a UI must not set. Reading: the instance file over defaults, the top
// level checked against a TypeBox schema (`additionalProperties: false`) and each project entry validated against
// `InstanceProjectSchema` so a single hand-edit slip skips that entry instead of bricking the boot; a `ConfigError`
// is printed without a stack. A missing file is VALID (an empty registry). This is state the host owns: the running
// host writes it; a thread never reaches it.
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ModelRef } from "@earendil-works/pi-durable";
import { ConfigError, describeErrors, expandPath, fail } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";
import { splitSlug } from "./t3/model-types.ts";
import { writeJsonAtomic } from "./t3/json-store.ts";

/** The file name, in the data dir. */
export const INSTANCE_FILE = "settings.json";

/**
 * A project as stored in the instance file: a path the user chose (the uniqueness key, compared NORMALIZED), plus a
 * free title label. The `id` is stored when one was assigned: a client minted it (T3's UI sends a UUID and navigates
 * to it — the host honors it, exactly as it honors client-minted thread ids), or the first `update` of a
 * client-less registration stored the id derived from the path at registration (an id is assigned once and never
 * re-derived). An entry without an `id` derives it from the normalized path, so nothing mints it and it survives a
 * restart unchanged.
 */
export type InstanceProject = { readonly path: string; readonly title?: string; readonly id?: string };

/** The new-thread defaults a UI edits. `model` is a `provider/model` slug; `thinkingLevel` mirrors pi-ai's levels. */
export type InstanceDefaults = { readonly model?: string; readonly thinkingLevel?: string };

export type InstanceFile = { readonly projects: readonly InstanceProject[]; readonly defaults: InstanceDefaults };

/** The resolved instance: projects carry their id (client-minted when stored, else derived from the normalized path),
 * absolute `cwd`, and a title; defaults are typed. `storedId` marks an id that is durable state — a move keeps it. */
export type ResolvedProject = { readonly id: string; readonly storedId?: string; readonly title: string; readonly cwd: string };
export type ResolvedInstance = {
	readonly projects: readonly ResolvedProject[];
	readonly model: ModelRef | undefined; // the model a new thread starts on, if set; else the first available.
	readonly thinkingLevel: string; // the thinking level a new thread starts on.
};

/** pi-ai's model thinking levels (the array is not exported from the package index). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// The document is split into a TOP-level schema (the object, `projects` an array, `defaults` an object, no extra keys)
// and a per-entry schema (`InstanceProjectSchema`). The split is the point: a document-level shape (an unknown top-level
// key, `projects` not an array, `defaults` malformed) has no entry to skip and is fatal in both modes, while a single
// bad ENTRY is skipped with a warning at boot — validating entries at the document level is what made one hand-edit
// slip brick the boot (store M3). `additionalProperties: false` everywhere; the checks the schema cannot express (a
// `provider/model` slug, a known thinking level, a unique normalized path) are in `resolveInstance`.
/** A project entry: `{ path, title?, id? }` and nothing else. `path` is the uniqueness key (non-empty); `title` is a
 * label (non-empty when present, else the folder's basename); `id` is a client-minted id (non-empty, ≤128 chars) —
 * absent, the id is derived from the normalized path. Exported so the tolerant boot read validates each entry against
 * it and a write-path fixture can name the exact shape it is testing. */
export const InstanceProjectSchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		title: Type.Optional(Type.String({ minLength: 1 })),
		// The id a client minted (T3's UI sends a UUID before the project exists and navigates to it). Optional:
		// an entry without one derives its id from the normalized path.
		id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);

/** The `defaults` object (document-level: malformed → fatal in both modes, there is no entry to skip). `model` is a
 * `provider/model` slug (non-empty); the value-level checks (the slug splits, the level is known) degrade tolerantly. */
const InstanceDefaultsSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ minLength: 1 })),
		thinkingLevel: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** The document's TOP level: an object with `projects` (an array of entries, validated entry-by-entry against
 * `InstanceProjectSchema` in `resolveInstance`) and `defaults`, and no other keys. Validating the entry shape here
 * would make one hand-edit slip a document-level refusal — the boot bug store M3 reported — so entries are `Unknown`
 * at the document level and checked one at a time below. */
const TopLevelSchema = Type.Object(
	{
		projects: Type.Array(Type.Unknown(), { default: [] }),
		defaults: Type.Optional(InstanceDefaultsSchema),
	},
	{ additionalProperties: false },
);

/** Parse and validate `settings.json` text for `dataDir` (JSON → defaults → schema → checks). A project's `path` is
 * expanded (`~`), resolved under `dataDir`, and NORMALIZED (the uniqueness key: `…/alpha` and `…/alpha/` are one
 * path); the title defaults to the folder's basename; the id is the stored (client-minted) one, else derived from the
 * normalized path. A duplicate normalized path is refused — a project is a path, and T3 refuses the same folder
 * twice — as is a stored id on two entries. `file` names the source in messages. An empty object is valid.
 *
 * With `onWarn` the read is TOLERANT, the boot shape: an entry the checks refuse (a duplicate id, a duplicate path,
 * a path the filesystem refuses) is skipped with a warning naming the file, and the rest of the registry boots —
 * the way a project path that is a file is skipped at boot. The UI is the only place that can edit the instance
 * file, and a host that dies before its listener binds cannot be told to. Without `onWarn` every refusal is fatal:
 * that strict shape is the one the write path validates with, so what the host writes, the host can read. A
 * document-level refusal (unparseable JSON, an unknown key, the wrong shape) is fatal in both modes: there is no
 * entry to skip, and booting an empty registry over a typo would let the next UI edit rewrite away the
 * integrator's whole registry — refusing, naming the file and the key path, is the fixable direction. */
export function parseSettingsJson(text: string, dataDir: string, file = INSTANCE_FILE, options: { readonly onWarn?: (message: string) => void } = {}): ResolvedInstance {
	const onWarn = options.onWarn;
	let parsed: unknown;
	try {
		parsed = text.trim() === "" ? {} : JSON.parse(text);
	} catch (error) {
		// Not JSON at all. Tolerant (boot): serve an empty registry with a warning naming the file, and bind. The write
		// path (strict, no onWarn) refuses. READ-ONLY is the strict reader's job (the write path re-reads and refuses),
		// not a flag here — the empty registry is never written over the entries the broken file holds.
		if (onWarn === undefined) fail(file, (error as Error).message);
		onWarn(`${file}: the file is not valid JSON (${(error as Error).message.replace(/\s+/g, " ").slice(0, 160)}); it is served as an empty registry and every mutation is refused until it is fixed`);
		return { projects: [], model: undefined, thinkingLevel: "off" };
	}
	// Document-level shape (fatal in BOTH modes — there is no entry to skip): top-level object, `projects` an array,
	// `defaults` an object, no other keys.
	const doc = Value.Default(TopLevelSchema, parsed) as { projects: readonly unknown[]; defaults?: { model?: string; thinkingLevel?: string } };
	const topErrors = [...Value.Errors(TopLevelSchema, doc)];
	if (topErrors.length > 0) throw new ConfigError(describeErrors(file, topErrors));
	return resolveInstance(doc.projects, doc.defaults ?? {}, dataDir, file, onWarn);
}

/** Turn a validated document into a resolved instance: derive ids, expand/resolve paths, refuse duplicate paths, parse
 * the model slug, and check the thinking level. With `onWarn` each entry-level refusal becomes a warning naming the
 * file and a skipped entry (the tolerant boot read); without it, each is a fatal `ConfigError` (the strict write-path
 * validator). File-level checks (the model slug, the thinking level) also degrade with `onWarn`: the value falls
 * back to its default, the warning names the file. */
function resolveInstance(entries: readonly unknown[], defaults: { model?: string; thinkingLevel?: string }, dataDir: string, file: string, onWarn?: (message: string) => void): ResolvedInstance {
	const projects: ResolvedProject[] = [];
	const seen = new Set<string>();
	const seenIds = new Set<string>();
	const refuse = (message: string): void => {
		if (onWarn === undefined) fail(file, message);
		onWarn(`${file}: ${message}; the entry was skipped, fix the file if that is not what you meant`);
	};
	for (const [index, entry] of entries.entries()) {
		// Per-entry SHAPE: the entry must be `{ path, title?, id? }` (path non-empty, title non-empty when present, id
		// non-empty ≤128) and nothing else. The classic hand-edit slips (a deleted `path`, an `id` typed as a number, a
		// stray key on one entry) are PER-ENTRY — there IS an entry to skip — so tolerant mode warns and skips (store M3:
		// the old whole-document schema made each of these a fatal document-level refusal before the bind); strict is fatal.
		const entryErrors = [...Value.Errors(InstanceProjectSchema, entry)].map((error) => ({ ...error, instancePath: `/projects/${index}${error.instancePath}` }));
		if (entryErrors.length > 0) {
			// Re-rooted at `/projects/${index}` so the strict message names the key path (`projects[0].path`, `projects[0].unknown
			// key "label"`) exactly as a whole-document validation would, and the tolerant warning points at the entry skipped.
			refuse(describeErrors(file, entryErrors));
			continue;
		}
		const project = entry as { path: string; title?: string; id?: string };
		// Normalize: `resolve` collapses `…/alpha/` and `…/alpha/.` to `…/alpha`, so the path is one key, spelled one way.
		// A path the platform refuses is a skipped entry too. `path.resolve` accepts a NUL byte (it is just a string), but
		// every file operation on the resolved path (`statSync`, `open`) rejects it with `ERR_INVALID_ARG_VALUE`, so a
		// `path` containing a NUL is not a usable project path — refuse it here, naming it, the tolerant read skipping it.
		let cwd: string;
		try {
			if (project.path.includes("\u0000")) throw new Error("the path contains a NUL byte, which no file operation accepts");
			cwd = resolve(expandPath(project.path, dataDir));
		} catch (error) {
			refuse(`projects[${index}].path "${project.path}" is not a usable path (${(error as Error).message})`);
			continue;
		}
		if (seen.has(cwd)) {
			refuse(`projects[${index}]: duplicate project path "${project.path}" (resolved ${cwd}); a project is a path, and the title is a label`);
			continue;
		}
		seen.add(cwd);
		// The id is minted by whoever registers the project: a stored id (T3's UI mints a UUID) is honored; absent, it
		// derives from the normalized path. Two entries may not share one id. The stored id is TRIMMED on read (store N6) —
		// the write path trims a minted id, and the contract's `ProjectId` trims on encode, so a hand-edited padded id must
		// resolve to the same key the client is shown (an untrimmed read published the trimmed id, then refused to name it).
		const storedId = project.id === undefined ? undefined : project.id.trim();
		const hasStoredId = storedId !== undefined && storedId !== "";
		const id = hasStoredId ? storedId! : projectIdForPath(cwd);
		if (seenIds.has(id)) {
			refuse(`projects[${index}]: duplicate project id "${id}"; a minted id is unique, and paths are already refused above`);
			continue;
		}
		seenIds.add(id);
		projects.push({ id, ...(hasStoredId ? { storedId: storedId! } : {}), title: project.title ?? (basename(cwd) || cwd), cwd });
	}
	let model: ModelRef | undefined;
	if (defaults.model !== undefined) {
		const parsed = splitSlug(defaults.model);
		if (parsed === undefined) {
			if (onWarn === undefined) fail(file, `defaults.model "${defaults.model}" must be provider/model`);
			onWarn(`${file}: defaults.model "${defaults.model}" must be provider/model; the default was dropped (new threads take the first available model)`);
		} else model = parsed;
	}
	let thinkingLevel: string = defaults.thinkingLevel ?? "off";
	if (!THINKING_LEVELS.includes(thinkingLevel as (typeof THINKING_LEVELS)[number])) {
		if (onWarn === undefined) fail(file, `defaults.thinkingLevel "${thinkingLevel}" must be one of: ${THINKING_LEVELS.join(", ")}`);
		onWarn(`${file}: defaults.thinkingLevel "${thinkingLevel}" must be one of: ${THINKING_LEVELS.join(", ")}; "off" applies`);
		thinkingLevel = "off";
	}
	return { projects, model, thinkingLevel };
}

/** Read and validate the instance file. A MISSING file is valid — an empty registry, the defaults — so a first run is
 * not an error; the caller warns about an empty registry the way it warns about no projects today. With
 * `options.onWarn` the read is tolerant (see `parseSettingsJson`): that is the boot shape, so a hand-edited entry
 * cannot keep the host from binding. */
export async function loadInstanceFile(dataDir: string, options: { readonly onWarn?: (message: string) => void } = {}): Promise<ResolvedInstance> {
	const file = `${dataDir}/${INSTANCE_FILE}`;
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [], model: undefined, thinkingLevel: "off" };
		throw error;
	}
	return parseSettingsJson(text, dataDir, file, options);
}

/**
 * Write the instance file. There is ONE implementation of that, the facet's atomic JSON writer: a unique temp name, the
 * mode set before the rename, the bytes on disk before the rename, and the cross-process lock that makes a
 * read-modify-write safe. Fixtures and helper tools call this so they write the file exactly the way the host does — a
 * second hand-rolled writer is how a crashed run used to leave a `<file>.tmp` that set the mode of the next write.
 */
export async function writeInstanceFile(dataDir: string, file: InstanceFile): Promise<void> {
	writeJsonAtomic(`${dataDir}/${INSTANCE_FILE}`, file);
}
