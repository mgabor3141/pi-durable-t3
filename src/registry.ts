// The live project registry + new-thread defaults, backed by the instance file (`settings.json`). It is the single
// source of truth for what a UI edits: the host, the threads layer, and the T3 facet all read through it, and the
// running host writes it on the UI's behalf. Reading is in-memory (loaded at start); every mutation writes the file
// atomically and notifies subscribers, so a facet projection reflects a UI edit at once. A thread never reaches it.
//
// A project's UNIQUENESS KEY is its normalized path — compared normalized, so `…/alpha` and `…/alpha/` are one
// project, not two sharing an id. Its ID is minted by whoever registers it: T3's UI mints a UUID before the project
// exists and navigates to it, and the host honors it exactly as it honors client-minted thread ids; when no client id
// is supplied (integrator-written entries, folders discovered from a conversation cwd), the id derives from the
// normalized path, so nothing mints it and it survives a restart unchanged. The id is then opaque and stable: an id
// is ASSIGNED ONCE and never re-derived from a path after that — a title rename is free, a root MOVE keeps the id
// (the entry stores a derived id on the first update, so a move cannot split a project from its threads), and both
// id and path are keys `add` guards: a duplicate path is refused (T3 refuses the same folder twice,
// `ProjectWorkspaceConflictError`), and so is a minted id another project already owns (`ProjectIdConflict` — one id
// naming two entries is a document the boot parser refuses, and the host never writes a file it cannot read).
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { expandPath, type Project } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";
import {
	INSTANCE_FILE,
	THINKING_LEVELS,
	type InstanceFile,
	type InstanceProject,
	type ResolvedInstance,
	loadInstanceFile,
	parseSettingsJson,
} from "./settings.ts";
import { splitSlug } from "./t3/model-types.ts";
import { updateJsonAtomic } from "./t3/json-store.ts";

/** A mutation refused because the path already belongs to another project (T3: `ProjectWorkspaceConflictError`). */
export class ProjectConflict extends Error {
	readonly workspaceRoot: string;
	readonly conflictingProjectId: string;
	constructor(workspaceRoot: string, conflictingProjectId: string) {
		super(`Workspace ${workspaceRoot} already belongs to project ${conflictingProjectId}.`);
		this.name = "ProjectConflict";
		this.workspaceRoot = workspaceRoot;
		this.conflictingProjectId = conflictingProjectId;
	}
}

/** A mutation minted a project id that another project already owns. A minted id is a KEY, not data: the
 * boot parser refuses a document where one id names two entries, so the write path must refuse it too —
 * the host may never write a file it would refuse to read (the facet maps this to the contract's
 * `ProjectMutationError`; the REST parity route answers 409, as for a path conflict). */
export class ProjectIdConflict extends Error {
	readonly projectId: string;
	readonly conflictingPath: string;
	constructor(projectId: string, conflictingPath: string) {
		super(`Project id ${projectId} already belongs to the project at ${conflictingPath}.`);
		this.name = "ProjectIdConflict";
		this.projectId = projectId;
		this.conflictingPath = conflictingPath;
	}
}

/** A client-minted project id the instance file cannot store. A minted id is honored as the client's identity
 * for the project, so it must fit the file's rules (the parser caps a stored id's length); refusing at mutation
 * time with a typed error keeps the host from writing what its own parser refuses, and keeps a ConfigError from
 * the write validator the last line, not the client refusal. A BLANK id is not an error: it is not a mint, and
 * the id simply derives from the path. (A blank id cannot reach here over the wire: the contract's ProjectId is
 * non-blank, so the boundary refuses it before the mutation.) */
export class ProjectIdInvalid extends Error {
	readonly projectId: string;
	constructor(projectId: string, reason: string) {
		super(`Project id "${projectId.length > 48 ? `${projectId.slice(0, 45)}…` : projectId}" is not a usable project id: ${reason}`);
		this.name = "ProjectIdInvalid";
		this.projectId = projectId;
	}
}

/** A mutation named a project that is not registered. */
export class ProjectNotFound extends Error {
	readonly projectId: string;
	constructor(projectId: string) {
		super(`Project ${projectId} was not found.`);
		this.name = "ProjectNotFound";
		this.projectId = projectId;
	}
}

// A workspace root the filesystem refuses to make usable. These mirror T3's server-side checks
// (`apps/server/src/workspace/WorkspacePaths.ts`: `WorkspaceRootNotDirectoryError`, `WorkspaceRootNotExistsError`,
// `WorkspaceRootCreateFailedError`), each naming the path — a mutation must never store a root that would brick the
// next boot, and the UI shows the message verbatim (the facet maps these to the contract's `ProjectMutationError`).

/** The path exists and is not a directory (T3: `WorkspaceRootNotDirectoryError`). */
export class ProjectWorkspaceNotDirectory extends Error {
	readonly workspaceRoot: string;
	constructor(workspaceRoot: string) {
		super(`Workspace root is not a directory: ${workspaceRoot}`);
		this.name = "ProjectWorkspaceNotDirectory";
		this.workspaceRoot = workspaceRoot;
	}
}

/** The path does not exist and the mutation did not ask to create it (T3: `WorkspaceRootNotExistsError`). */
export class ProjectWorkspaceMissing extends Error {
	readonly workspaceRoot: string;
	constructor(workspaceRoot: string) {
		super(`Workspace root does not exist: ${workspaceRoot}`);
		this.name = "ProjectWorkspaceMissing";
		this.workspaceRoot = workspaceRoot;
	}
}

/** Creating the missing path failed (T3: `WorkspaceRootCreateFailedError`). */
export class ProjectWorkspaceNotCreatable extends Error {
	readonly workspaceRoot: string;
	constructor(workspaceRoot: string, cause: unknown) {
		super(`Failed to create workspace root: ${workspaceRoot} (${cause instanceof Error ? cause.message : String(cause)})`);
		this.name = "ProjectWorkspaceNotCreatable";
		this.workspaceRoot = workspaceRoot;
	}
}

export type RegistryDefaults = { readonly model: ModelRef | undefined; readonly thinkingLevel: string };

/** The cap the instance file enforces on a stored id (its parser refuses longer ones). An id the file cannot
 * store is refused at mutation time with `ProjectIdInvalid`, naming the limit. */
export const MAX_STORED_ID_LENGTH = 128;

/** The mutable registry the host, threads layer, and facet share. */
export interface ProjectRegistry {
	/** The registered projects (path-derived id, title label, absolute cwd). A snapshot, in registry order. */
	list(): Project[];
	/** The new-thread defaults a UI edits. */
	defaults(): RegistryDefaults;
	/** Register a change listener (a mutation fires it after the file is written); returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Register a project at `path` (absolute, `~` expanded). Refuses a path another project already owns.
	 * `options.clientId` is the id the client minted (T3's UI sends a UUID); when it has the minted shape it is
	 * honored exactly — the host navigates-with the client, not against it. Any other id (absent, a placeholder)
	 * derives from the normalized path.
	 */
	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project;
	/** Resolve a project path the way `add` would (absolute, `~` expanded, relative under the data dir, normalized),
	 * for checks that must run BEFORE a registration (a workspace root that cannot exist must never be stored). */
	resolvePath(path: string): string;
	/** Rename (title is a free label) and/or move a project's path; a move that collides is refused. A move keeps the
	 * project's id — rows that reference it (its threads) keep resolving to it. An entry whose id was derived gets it
	 * STORED by the first update: the id was assigned at registration, and never re-derives from a path after that. */
	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project;
	/** Drop a project's entry. Returns the removed project, or `undefined` when it was not registered. */
	remove(id: string): Project | undefined;
	/** Set the new-thread model default (`provider/model`, or `null` to clear → first available). */
	setModel(model: ModelRef | null): void;
	/** Set the new-thread thinking level. */
	setThinkingLevel(level: string): void;
	/** Boot only: the catalog check found a default the host cannot call. Drop the IN-MEMORY model default (the file
	 * keeps the user's value) so new threads fall back to the resolved default and the UI can set a good one. No write, no
	 * listener — this is boot-time, before the facet binds, and the file is unchanged (the boot read never rewrites it). */
	dropModelDefault(): void;
	/** The instance file this registry writes (a refusal that cannot store a setting names it). */
	readonly path: string;
}

/** The document an instance file holds when there is no file to read (a valid first run). */
const EMPTY_INSTANCE: InstanceFile = { projects: [], defaults: {} };

/** The id of a stored entry: the id a client minted when it stored one, else derived from the path. One spelling, used
 * by every read and by every delta that looks an entry up, so an entry is found by the same id `list()` reports. The
 * path-derived id is derived from the RESOLVED path (`dataDir` supplied): the boot parser and `list()` derive from the
 * resolved path, and a delta applied to the RAW on-disk document (a relative path) must look an entry up by the SAME id
 * the client was given — deriving from the raw string would miss the entry. For an absolute (resolved) path, `dataDir`
 * is a no-op (resolve is idempotent), so `list()` on the resolved snapshot is unchanged. */
function idOf(entry: InstanceProject, dataDir?: string): string {
	// Trim a stored id the way the write path trims a minted one (store N6): a hand-edited padded id must be found by the
	// id `list()` publishes. The contract's `ProjectId` is a trimmed brand, so a padded stored id is SHOWN trimmed; an
	// untrimmed read compared the padded bytes, published the trimmed id, and then refused to edit/delete that project.
	return entry.id !== undefined ? entry.id.trim() : projectIdForPath(dataDir === undefined ? entry.path : resolveAbs(entry.path, dataDir));
}

/** The ONE snapshot shape the registry keeps in memory: a document with every project's path RESOLVED the way `open()`
 * resolves it (expanded, under the data dir, normalized) and the defaults normalized. `open()` and every `#commit` pass
 * their document through `instanceFileOf`, so `list()` derives every path id from the SAME spelling at every read. A
 * mutation that stored the RAW disk document (a relative path, exactly as the integrator wrote it) re-derived every
 * derived id from a string whose form changed under it: at boot the id was `projectIdForPath(resolve("rel", dataDir))`,
 * after the first write `projectIdForPath("rel")` — a different id. Existing thread rows (their FK is the boot id)
 * became rows naming an unregistered project, the shell re-published the project under the new id (the sidebar split),
 * and `thread.create` with the id the client navigated with was refused (review conc N16). Disk text is written raw
 * (a relative path stays relative); only the in-memory snapshot is resolved. Runs the STRICT boot parser, so a document
 * that would not boot throws — the write validator's rule, applied to the copy the host reads from. */
function resolvedSnapshot(doc: InstanceFile, dataDir: string, file: string): InstanceFile {
	return instanceFileOf(parseSettingsJson(JSON.stringify(doc), dataDir, file));
}

/** The instance-file document for a resolved instance: what a validated file means, written back in file shape. This is
 * the single mapping from a RESOLVED instance to the in-memory snapshot, shared by `open()` and `#commit` (so the two
 * can never disagree on a path's spelling, and hence on a derived id — conc N16). */
function instanceFileOf(resolved: ResolvedInstance): InstanceFile {
	return {
		projects: resolved.projects.map((project) => ({ ...(project.storedId === undefined ? {} : { id: project.storedId }), path: project.cwd, ...(project.title === "" ? {} : { title: project.title }) })),
		defaults: { ...(resolved.model === undefined ? {} : { model: `${resolved.model.provider}/${resolved.model.modelId}` }), thinkingLevel: resolved.thinkingLevel },
	};
}

/** A `settings.json`-backed registry under `dataDir`. Synchronous reads (an in-memory snapshot); every mutation is a
 * delta applied to the document ON DISK, under a cross-process lock. */
export class FileProjectRegistry implements ProjectRegistry {
	readonly #dataDir: string;
	#file: InstanceFile;
	readonly #listeners = new Set<() => void>();

	private constructor(dataDir: string, file: InstanceFile) {
		this.#dataDir = dataDir;
		this.#file = file;
	}

	/** Load the registry from the instance file. A missing file is an empty registry (a valid first run).
	 * `onWarn` makes the BOOT read tolerant the way a bad project path is tolerated: an entry the parser
	 * refuses (a duplicate id, a duplicate path) is skipped, and the warning naming the file is the user's
	 * pointer. Without it the read is strict — that is the shape the write path validates with, and a
	 * mutation must never publish a document that boot would need to skip. */
	static async open(dataDir: string, onWarn?: (message: string) => void): Promise<FileProjectRegistry> {
		return new FileProjectRegistry(dataDir, instanceFileOf(await loadInstanceFile(dataDir, onWarn === undefined ? {} : { onWarn })));
	}

	/** The raw file path (for logging / a warning that names the file a UI writes). */
	get path(): string {
		return join(this.#dataDir, INSTANCE_FILE);
	}

	list(): Project[] {
		// A stored id (client-minted, durable) is the project's id; without one the id derives from the normalized path.
		return this.#file.projects.map((project) => ({ id: idOf(project, this.#dataDir), name: project.title ?? basenameOf(project.path), cwd: project.path }));
	}

	defaults(): RegistryDefaults {
		// Derived from the document, not from a copy of it: the defaults a UI reads are the ones in the file.
		const model = this.#file.defaults.model;
		return { model: model === undefined ? undefined : splitSlug(model), thinkingLevel: this.#file.defaults.thinkingLevel ?? "off" };
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project {
		const cwd = resolveAbs(path, this.#dataDir);
		// Honor the id the client minted: the contract's ProjectId is a branded TRIMMED NON-EMPTY STRING
		// (`vendor/contracts/src/baseSchemas.ts`), and T3's own server commits the client's id VERBATIM
		// (`apps/server/src/project/ProjectService.ts`: `create` commits `projectId: input.projectId`). Pre-fix
		// this host honored only the UUID shape the T3 UI happens to mint and silently derived the rest: a client
		// that minted "sso:project-7" sent X, navigated to X, and found a shell answering p-<sha> — the
		// id-not-in-the-answer breakage, one shape wider (review wire NEW-2). Opaque thereafter: the host stores
		// and compares it, never parses it. A blank id is not a mint — the id derives; a stored-length overflow
		// is refused typed, because the file could never carry it back.
		const trimmed = options?.clientId?.trim();
		const minted = trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
		if (minted !== undefined && minted.length > MAX_STORED_ID_LENGTH) throw new ProjectIdInvalid(minted, `the instance file stores at most ${MAX_STORED_ID_LENGTH} characters`);
		const project: InstanceProject = { ...(minted === undefined ? {} : { id: minted }), path: cwd, ...(title === undefined || title === "" ? {} : { title }) };
		// The duplicate-path check runs on the document as it is on disk, INSIDE the lock: a peer that registered this
		// folder a moment ago is in it, and the refusal it gets is the one the client would get from a single host.
		// The minted id gets the same check: it is a key, and a document where one id names two entries is one the
		// boot parser refuses — refusing here is what keeps "the host never writes a file it cannot read" true.
		this.#commit((disk) => {
			const owner = this.#ownerOf(disk, cwd);
			if (owner !== undefined) throw new ProjectConflict(cwd, owner);
			if (minted !== undefined) {
				const idOwner = disk.projects.find((project) => idOf(project, this.#dataDir) === minted);
				if (idOwner !== undefined) throw new ProjectIdConflict(minted, resolveAbs(idOwner.path, this.#dataDir));
			}
			return { ...disk, projects: [...disk.projects, project] };
		});
		return { id: idOf(project, this.#dataDir), name: project.title ?? basenameOf(cwd), cwd };
	}

	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project {
		const dataDir = this.#dataDir;
		const moved = patch.path === undefined ? undefined : resolveAbs(patch.path, dataDir);
		const title = patch.title;
		let result: Project | undefined;
		this.#commit((disk) => {
			const index = disk.projects.findIndex((project) => idOf(project, dataDir) === id);
			if (index < 0) throw new ProjectNotFound(id);
			const current = disk.projects[index]!;
			const cwd = moved ?? resolveAbs(current.path, dataDir);
			const owner = this.#ownerOf(disk, cwd);
			if (owner !== undefined && owner !== id) throw new ProjectConflict(cwd, owner);
			// The id is opaque and stable: a move changes the PATH, never the id — the project's threads keep
			// resolving to it. An entry whose id was only ever DERIVED (a client-less registration) gets that id
			// STORED here: an id is assigned once and never re-derived from a path after that, so moving the
			// folder cannot mint a new id and split the project from its threads (the split was conc N3 / store
			// N5 / wire NEW-3: rows kept the old id, the registry answered a new one, and the old entry was
			// unremovable — not registered, so the not-found refusal was correct and permanent).
			const name = title ?? current.title;
			const updated: InstanceProject = { id: idOf(current, dataDir), path: cwd, ...(name === undefined || name === "" ? {} : { title: name }) };
			const projects = [...disk.projects];
			projects[index] = updated;
			result = { id: idOf(updated, dataDir), name: updated.title ?? basenameOf(cwd), cwd };
			return { ...disk, projects };
		});
		return result!;
	}

	resolvePath(path: string): string {
		return resolveAbs(path, this.#dataDir);
	}

	remove(id: string): Project | undefined {
		const dataDir = this.#dataDir;
		let removed: Project | undefined;
		this.#commit((disk) => {
			const matching = disk.projects.filter((project) => idOf(project, dataDir) === id);
			if (matching.length === 0) return disk; // not registered: nothing to write, nothing to notify
			const entry = matching[0]!;
			const cwd = resolveAbs(entry.path, dataDir);
			removed = { id, name: entry.title ?? basenameOf(cwd), cwd };
			// Drop EVERY entry that shares this id, not just the first (store M11): a hand-written file can carry two entries
			// under one DERIVED id (the same normalized path spelled two ways), the tolerant read shows one, and a delete of
			// that project must remove the whole group it names — leaving a twin under the same id republishes the project the
			// client just deleted (the delete answered `ok` while the path stayed registered, and the folder could not be
			// re-added). Removing all of them is the faithful delete, and the result is dup-free, so the strict validator passes.
			return { ...disk, projects: disk.projects.filter((project) => idOf(project, dataDir) !== id) };
		});
		return removed;
	}

	setModel(model: ModelRef | null): void {
		// Only `model` is touched: the rest of the document, defaults included, comes from the file. A peer's thinking
		// level is in that document, so it survives this write instead of being replaced by a snapshot taken at open().
		this.#commit((disk) => {
			const defaults = { ...disk.defaults } as Record<string, string | undefined>;
			if (model === null) delete defaults.model;
			else defaults.model = `${model.provider}/${model.modelId}`;
			return { ...disk, defaults };
		});
	}

	setThinkingLevel(level: string): void {
		if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) return;
		this.#commit((disk) => ({ ...disk, defaults: { ...disk.defaults, thinkingLevel: level } }));
	}

	dropModelDefault(): void {
		// Boot-time (the catalog check dropped the default). Clear the in-memory model default ONLY: the file keeps the
		// user's value (the boot read never rewrites the UI's file), `defaults()` answers `undefined` so `Threads.create`
		// uses the resolved default (the first catalog model), and the UI can set a good one through `setModel`.
		this.#file = { ...this.#file, defaults: { ...this.#file.defaults, model: undefined } };
	}

	/** The id of the project that owns `cwd` in this document, comparing paths the way the parser does (expanded,
	 * resolved, normalized) so a peer's relative spelling of the same folder is recognized as the same project. */
	#ownerOf(disk: InstanceFile, cwd: string): string | undefined {
		const dataDir = this.#dataDir;
		// Compared the way the parser compares paths (expanded, resolved, normalized), and reported with the SAME id
		// `list()` reports, so a refusal names the project the client can see.
		for (const project of disk.projects) if (resolveAbs(project.path, dataDir) === cwd) return idOf(project, dataDir);
		return undefined;
	}

	/**
	 * The registry's ONE writer: apply this mutation as a delta to the document currently on disk, under a cross-process
	 * lock, and write the result atomically. Pre-fix this took the whole file from the snapshot `open()` loaded and
	 * rewrote it, so any write by another process (the documented two-hosts-on-one-data-dir dev setup) was silently
	 * replaced by a stale copy of parts this mutation never touched — a title edit, a thinking level, a default model.
	 * The delta form is what fixes that: the mutation names the part it changes and carries nothing else.
	 *
	 * `validate` is the parser the NEXT boot will use, so a merge that produces a document the host would refuse to
	 * start on (a duplicate path a peer just registered, a malformed slug) is a refusal, never a write over a good file.
	 * The snapshot and the listeners update only after the write lands, so a refused mutation changes nothing at all.
	 */
	#commit(delta: (disk: InstanceFile) => InstanceFile): void {
		const dataDir = this.#dataDir;
		const written = updateJsonAtomic<InstanceFile>(this.path, EMPTY_INSTANCE, delta, {
			// Read the delta base with the STRICT boot parser, not the tolerant `readJson`. A write must never be based on
			// a document the host could not read: an unparseable / boot-refused `settings.json` REFUSES the mutation naming
			// the file and leaves it byte-identical, rather than treating it as empty and rewriting away every entry it held
			// (review store M1). A MISSING file is the empty registry (a valid first run), so the reader returns the fallback.
			read: (path) => readInstanceForWrite(dataDir, path),
			validate: (doc) => {
				parseSettingsJson(JSON.stringify(doc), dataDir, this.path);
			},
		});
		// Store the RESOLVED snapshot, the same shape `open()` stores (see `resolvedSnapshot`). `written` is the raw
		// disk document; storing it directly re-derived every path id from the raw string, flipping a relative-path
		// entry's id at the first mutation (conc N16). The disk text is `written`, unchanged; only the snapshot resolves.
		this.#file = resolvedSnapshot(written, dataDir, this.path);
		for (const listener of this.#listeners) listener();
	}
}

/** Read the instance file as the STRICT base a delta applies to. A missing file is the empty registry (a valid first
 * run); a file that exists is parsed with the boot parser (no `onWarn`), which throws a `ConfigError` naming the file
 * and the key path on anything it would refuse to boot on. The delta operates on the RAW JSON (so a mutation never
 * rewrites a part of the document it did not name), guarded by that parse. A write must never be based on a document
 * the host could not read (review store M1): the tolerant boot read has the license to degrade an entry so it can bind
 * and be told to fix the file, the WRITE path does not — its base is the document it is about to overwrite. */
function readInstanceForWrite(dataDir: string, file: string): InstanceFile {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_INSTANCE;
		throw error;
	}
	// The base a delta applies to is read with the boot's ENTRY-LEVEL tolerance (store D-2 / M11): a document the boot read
	// accepted (duplicate path/id entries it skips) must be readable here, so a mutation can act on it — in particular a
	// delete of the duplicate group, which clears them and heals the file. A file the boot read would NOT accept is refused
	// here, NAMING THE FILE, and left byte-identical (item 2's READ-ONLY). The strict parse is tried first — it names the
	// file on every fatal cause; the tolerant parse is the fallback, and it accepts ONLY entry-level dups (it throws on a
	// document-level shape, and a non-JSON file cannot be `JSON.parse`d at all). The strict guard on what is WRITTEN is
	// `#commit`'s `validate` (the parser the next boot uses), so a merge that would write a document boot fatal-refuses is refused.
	try {
		parseSettingsJson(text, dataDir, file); // strict: the common case (no entry issues) and the file-naming refusal
		return text.trim() === "" ? EMPTY_INSTANCE : (JSON.parse(text) as InstanceFile);
	} catch (strictError) {
		let raw: InstanceFile;
		try {
			raw = text.trim() === "" ? EMPTY_INSTANCE : (JSON.parse(text) as InstanceFile);
		} catch {
			throw strictError; // not JSON at all → the strict refusal, naming the file (READ-ONLY).
		}
		parseSettingsJson(text, dataDir, file, { onWarn: () => {} }); // entry-level dups pass; a document-level shape throws (fatal).
		return raw; // JSON, strict refused only for entries the boot skips → the delta applies to the raw entries.
	}
}

/** Resolve a project path to absolute under `dataDir` and NORMALIZE it (`resolve` collapses `…/alpha/` and `…/alpha/.`
 * to `…/alpha`): `~` expands, a relative path resolves under the data dir, an absolute path stays. Shared with the
 * instance-file parser, so an add and a hand-written file land the same folder under the same normalized key. */
function resolveAbs(value: string, dataDir: string): string {
	return resolve(expandPath(value, dataDir));
}

function basenameOf(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

/** Read the current instance-file text from disk (a test helper to assert what the host wrote). */
export async function readInstanceFileText(dataDir: string): Promise<string> {
	return readFile(join(dataDir, INSTANCE_FILE), "utf8");
}
