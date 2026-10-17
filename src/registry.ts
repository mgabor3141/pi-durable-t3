// The bridge's project registry: the list of projects T3's UI edits, kept in the bridge's own file (`projects.json`
// in the data dir). T3's server keeps projects in its database; this host keeps the same list in a file it writes on
// the UI's behalf. The visible behavior is T3's: `projects.mutate` add/update/remove with the contract's typed
// refusals, ids honored, and the normalized path as the uniqueness key. Reads are in-memory (loaded at start); every
// mutation is applied to the document on disk and written atomically, then subscribers are notified — so a facet
// projection reflects a UI edit at once. One host per data dir: the writer is a plain in-process read-modify-write.
//
// A project's UNIQUENESS KEY is its normalized path — `…/alpha` and `…/alpha/` are one project, not two sharing an
// id. Its ID is minted by whoever registers it: T3's UI mints a UUID before the project exists and navigates to it,
// and the host honors it exactly as it honors client-minted thread ids; when no client id is supplied (an
// integrator-written entry, a folder discovered from a conversation cwd), the id derives from the normalized path,
// so nothing mints it and it survives a restart unchanged. The id is then opaque and stable: an id is ASSIGNED ONCE
// and never re-derived from a path after that — a title rename is free, a root MOVE keeps the id (the entry stores a
// derived id on the first update, so a move cannot split a project from its threads), and both id and path are keys
// `add` guards: a duplicate path is refused (T3 refuses the same folder twice, `ProjectWorkspaceConflictError`), and
// so is a minted id another project already owns (`ProjectIdConflict` — one id naming two entries is a document the
// parser refuses, and the host never writes a file it cannot read).
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { type Project, ConfigError, describeErrors, expandPath, fail } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";
import { writeJsonAtomic } from "./t3/json-store.ts";

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

/** A mutation minted a project id that another project already owns. A minted id is a KEY, not data: the parser
 * refuses a document where one id names two entries, so the write path must refuse it too — the host may never
 * write a file it would refuse to read (the facet maps this to the contract's `ProjectMutationError`; the REST
 * parity route answers 409, as for a path conflict). */
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

/** A client-minted project id the registry file cannot store. A minted id is honored as the client's identity for
 * the project, so it must fit the file's rules (the parser caps a stored id's length); refusing at mutation time
 * with a typed error keeps the host from writing what its own parser refuses. A BLANK id is not an error: it is not
 * a mint, and the id simply derives from the path. (A blank id cannot reach here over the wire: the contract's
 * ProjectId is non-blank, so the boundary refuses it before the mutation.) */
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

// The workspace-root refusals mirror T3's server-side checks (`apps/server/src/workspace/WorkspacePaths.ts`:
// `WorkspaceRootNotDirectoryError`, `WorkspaceRootNotExistsError`, `WorkspaceRootCreateFailedError`), each naming
// the path — a mutation must never store a root that would brick the next boot, and the UI shows the message
// verbatim (the facet maps these to the contract's `ProjectMutationError`).

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

/** The cap the registry file enforces on a stored id (its parser refuses longer ones). An id the file cannot store
 * is refused at mutation time with `ProjectIdInvalid`, naming the limit. */
export const MAX_STORED_ID_LENGTH = 128;

/** The mutable registry the host, threads layer, and facet share. */
export interface ProjectRegistry {
	/** The registered projects (path-derived id, title label, absolute cwd). A snapshot, in registry order. */
	list(): Project[];
	/** Register a change listener (a mutation fires it after the file is written); returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Register a project at `path` (absolute, `~` expanded). Refuses a path another project already owns.
	 * `options.clientId` is the id the client minted (T3's UI sends a UUID); any id the contract's `ProjectId`
	 * accepts is honored exactly — the host navigates-with the client, not against it. Absent or blank, the id
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
	/** The registry file this host writes (a refusal that cannot store an entry names it). */
	readonly path: string;
}

/** A project as stored in the registry file: a path the user chose (the uniqueness key, compared NORMALIZED), plus
 * a free title label. The `id` is stored when one was assigned: a client minted it (T3's UI sends a UUID and
 * navigates to it — the host honors it, exactly as it honors client-minted thread ids), or the first `update` of a
 * client-less registration stored the id derived from the path at registration. An entry without an `id` derives it
 * from the normalized path, so nothing mints it and it survives a restart unchanged. */
type ProjectEntry = { readonly path: string; readonly title?: string; readonly id?: string };
type ProjectsFile = { readonly projects: readonly ProjectEntry[] };

/** A project entry: `{ path, title?, id? }` and nothing else. `path` is the uniqueness key (non-empty); `title` is a
 * label (non-empty when present, else the folder's basename); `id` is a client-minted id (non-empty, ≤128 chars) —
 * absent, the id is derived from the normalized path. */
const ProjectEntrySchema = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
		title: Type.Optional(Type.String({ minLength: 1 })),
		id: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_STORED_ID_LENGTH })),
	},
	{ additionalProperties: false },
);

const ProjectsFileSchema = Type.Object(
	{
		projects: Type.Array(ProjectEntrySchema, { default: [] }),
	},
	{ additionalProperties: false },
);

/** The registry file's name, in the data dir. */
export const PROJECTS_FILE = "projects.json";

/** Parse and validate `projects.json` text for `dataDir` (JSON → defaults → schema → checks). STRICT: this is the
 * definition of writable — every rule checked here is enforced at mutation time too, so the host never writes a
 * file it would refuse to read, and a file the host cannot read is a refusal naming it (the host does not boot).
 * A project's `path` is expanded (`~`), resolved under `dataDir`, and NORMALIZED (the uniqueness key: `…/alpha`
 * and `…/alpha/` are one path); the title defaults to the folder's basename; the id is the stored (client-minted)
 * one, else derived from the normalized path. A duplicate normalized path is refused — a project is a path, and T3
 * refuses the same folder twice — as is a stored id on two entries. `file` names the source in messages. */
export function parseProjectsJson(text: string, dataDir: string, file = PROJECTS_FILE): Project[] {
	let parsed: unknown;
	try {
		parsed = text.trim() === "" ? {} : JSON.parse(text);
	} catch (error) {
		fail(file, (error as Error).message);
	}
	const doc = Value.Default(ProjectsFileSchema, parsed) as { projects: readonly ProjectEntry[] };
	const errors = [...Value.Errors(ProjectsFileSchema, doc)];
	if (errors.length > 0) throw new ConfigError(describeErrors(file, errors));
	const projects: Project[] = [];
	const seen = new Set<string>();
	const seenIds = new Set<string>();
	for (const [index, entry] of doc.projects.entries()) {
		// Normalize: `resolve` collapses `…/alpha/` and `…/alpha/.` to `…/alpha`, so the path is one key, spelled one
		// way. `path.resolve` accepts a NUL byte (it is just a string), but every file operation on the resolved path
		// (`statSync`, `open`) rejects it with `ERR_INVALID_ARG_VALUE`, so a NUL path is not a usable project path.
		let cwd: string;
		try {
			if (entry.path.includes("\u0000")) throw new Error("the path contains a NUL byte, which no file operation accepts");
			cwd = resolve(expandPath(entry.path, dataDir));
		} catch (error) {
			fail(file, `projects[${index}].path "${entry.path}" is not a usable path (${(error as Error).message})`);
		}
		if (seen.has(cwd)) fail(file, `projects[${index}]: duplicate project path "${entry.path}" (resolved ${cwd}); a project is a path, and the title is a label`);
		seen.add(cwd);
		// The id is minted by whoever registers the project: a stored id (T3's UI mints a UUID) is honored and TRIMMED
		// (the write path trims a minted id, and the contract's `ProjectId` trims on encode, so a hand-edited padded
		// id must resolve to the same key the client is shown); absent, it derives from the normalized path.
		const storedId = entry.id === undefined ? undefined : entry.id.trim();
		const hasStoredId = storedId !== undefined && storedId !== "";
		const id = hasStoredId ? storedId! : projectIdForPath(cwd);
		if (seenIds.has(id)) fail(file, `projects[${index}]: duplicate project id "${id}"; a minted id is unique, and paths are already refused above`);
		seenIds.add(id);
		projects.push({ id, name: entry.title ?? (basename(cwd) || cwd), cwd });
	}
	return projects;
}

/** The id of a stored entry: the id a client minted when it stored one, else derived from the path. One spelling,
 * used by every read and by every delta that looks an entry up, so an entry is found by the same id `list()`
 * reports. The path-derived id is derived from the RESOLVED path (`dataDir` supplied): the parser and `list()`
 * derive from the resolved path, and a delta applied to the RAW on-disk document (a relative path) must look an
 * entry up by the SAME id the client was given — deriving from the raw string would miss the entry. */
function idOf(entry: ProjectEntry, dataDir?: string): string {
	return entry.id !== undefined ? entry.id.trim() : projectIdForPath(dataDir === undefined ? entry.path : resolveAbs(entry.path, dataDir));
}

/** A `projects.json`-backed registry under `dataDir`. Synchronous reads (an in-memory snapshot); every mutation is
 * a delta applied to the document on disk and written atomically. */
export class FileProjectRegistry implements ProjectRegistry {
	readonly #dataDir: string;
	#projects: Project[];
	readonly #listeners = new Set<() => void>();

	private constructor(dataDir: string, projects: Project[]) {
		this.#dataDir = dataDir;
		this.#projects = projects;
	}

	/** Load the registry from the file. A missing file is an empty registry (a valid first run). The parse is
	 * STRICT: a file the host cannot read is a `ConfigError` naming it, and the host does not boot — the UI cannot
	 * fix a file behind a host that serves an empty registry over a typo. */
	static open(dataDir: string): FileProjectRegistry {
		const file = join(dataDir, PROJECTS_FILE);
		return new FileProjectRegistry(dataDir, parseProjectsJson(readText(file), dataDir, file));
	}

	/** The raw file path (for logging / a warning that names the file a UI writes). */
	get path(): string {
		return join(this.#dataDir, PROJECTS_FILE);
	}

	list(): Project[] {
		return this.#projects.map((project) => ({ ...project }));
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project {
		const cwd = resolveAbs(path, this.#dataDir);
		// Honor the id the client minted: the contract's ProjectId is a branded TRIMMED NON-EMPTY STRING
		// (`vendor/contracts/src/baseSchemas.ts`), and T3's own server commits the client's id VERBATIM
		// (`apps/server/src/project/ProjectService.ts`: `create` commits `projectId: input.projectId`). Any such id
		// is a mint — the host trims it, stores it, and answers with it. Opaque thereafter: the host stores and
		// compares it, never parses it. A blank id is not a mint — the id derives; a stored-length overflow is
		// refused typed, because the file could never carry it back.
		const trimmed = options?.clientId?.trim();
		const minted = trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
		if (minted !== undefined && minted.length > MAX_STORED_ID_LENGTH) throw new ProjectIdInvalid(minted, `the registry file stores at most ${MAX_STORED_ID_LENGTH} characters`);
		const project: Project = { id: minted ?? projectIdForPath(cwd), name: title ?? basenameOf(cwd), cwd };
		this.#commit((disk) => {
			const owner = this.#ownerOf(disk, cwd);
			if (owner !== undefined) throw new ProjectConflict(cwd, owner);
			if (minted !== undefined) {
				const idOwner = disk.projects.find((entry) => idOf(entry, this.#dataDir) === minted);
				if (idOwner !== undefined) throw new ProjectIdConflict(minted, resolveAbs(idOwner.path, this.#dataDir));
			}
			return { ...disk, projects: [...disk.projects, entryOf(project, minted)] };
		});
		return { ...project };
	}

	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project {
		const dataDir = this.#dataDir;
		const moved = patch.path === undefined ? undefined : resolveAbs(patch.path, dataDir);
		const title = patch.title;
		let result: Project | undefined;
		this.#commit((disk) => {
			const index = disk.projects.findIndex((entry) => idOf(entry, dataDir) === id);
			if (index < 0) throw new ProjectNotFound(id);
			const current = disk.projects[index]!;
			const cwd = moved ?? resolveAbs(current.path, dataDir);
			const owner = this.#ownerOf(disk, cwd);
			if (owner !== undefined && owner !== id) throw new ProjectConflict(cwd, owner);
			// The id is opaque and stable: a move changes the PATH, never the id — the project's threads keep
			// resolving to it. An entry whose id was only ever DERIVED gets that id STORED here: an id is assigned
			// once and never re-derived from a path after that, so moving the folder cannot mint a new id and split
			// the project from its threads.
			const name = title ?? current.title ?? basenameOf(cwd);
			const updated: Project = { id, name, cwd };
			const projects = [...disk.projects];
			projects[index] = { id, path: cwd, ...(name === undefined || name === "" ? {} : { title: name }) };
			result = { ...updated };
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
			const matching = disk.projects.filter((entry) => idOf(entry, dataDir) === id);
			if (matching.length === 0) return disk; // not registered: nothing to write, nothing to notify
			const entry = matching[0]!;
			const cwd = resolveAbs(entry.path, dataDir);
			removed = { id, name: entry.title ?? basenameOf(cwd), cwd };
			// Drop EVERY entry that shares this id, not just the first: a hand-written file can carry two entries
			// under one DERIVED id (the same normalized path spelled two ways), and a delete of that project must
			// remove the whole group it names. Removing all of them is the faithful delete, and the result is
			// dup-free, so the strict parser passes.
			return { ...disk, projects: disk.projects.filter((entry) => idOf(entry, dataDir) !== id) };
		});
		return removed;
	}

	/** The id of the project that owns `cwd` in this document, comparing paths the way the parser does (expanded,
	 * resolved, normalized) so a relative spelling of the same folder is recognized as the same project. */
	#ownerOf(disk: ProjectsFile, cwd: string): string | undefined {
		const dataDir = this.#dataDir;
		for (const entry of disk.projects) if (resolveAbs(entry.path, dataDir) === cwd) return idOf(entry, dataDir);
		return undefined;
	}

	/**
	 * The registry's ONE writer: apply this mutation as a delta to the document on disk and write the result
	 * atomically. The delta form means a mutation names the part it changes and carries nothing else. The validate
	 * step is the parser the NEXT boot will use, so a mutation that would produce a document the host refuses to
	 * start on is a refusal, never a write over a good file. The snapshot and the listeners update only after the
	 * write lands, so a refused mutation changes nothing at all.
	 */
	#commit(delta: (disk: ProjectsFile) => ProjectsFile): void {
		const file = this.path;
		const disk = readDisk(file, this.#dataDir);
		const next = delta(disk);
		if (JSON.stringify(next) === JSON.stringify(disk)) return; // a no-op mutation writes nothing and notifies nobody.
		// The validate step is the parser the NEXT boot will use, so a mutation that would produce a document the
		// host refuses to start on is a refusal, never a write over a good file. The snapshot and the listeners
		// update only after the write lands, so a refused mutation changes nothing at all.
		const projects = parseProjectsJson(JSON.stringify(next), this.#dataDir, file);
		writeJsonAtomic(file, next);
		this.#projects = projects;
		for (const listener of this.#listeners) listener();
	}
}

/** Read the registry file as the strict base a delta applies to. A missing file is the empty registry (a valid
 * first run); a file that exists is parsed with the boot parser, which throws a `ConfigError` naming the file and
 * key path — the base a delta applies to must be a document the host can read. */
function readDisk(file: string, dataDir: string): ProjectsFile {
	const text = readText(file);
	parseProjectsJson(text, dataDir, file); // strict guard: a file the host would not boot on refuses the mutation.
	return text.trim() === "" ? { projects: [] } : (JSON.parse(text) as ProjectsFile);
}

function readText(file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

/** The registry-file entry for a project: the stored id (when one was minted) and the resolved path. */
function entryOf(project: Project, minted: string | undefined): ProjectEntry {
	return { ...(minted === undefined ? {} : { id: minted }), path: project.cwd, ...(project.name === basenameOf(project.cwd) ? {} : { title: project.name }) };
}

/** Resolve a project path to absolute under `dataDir` and NORMALIZE it (`resolve` collapses `…/alpha/` and
 * `…/alpha/.` to `…/alpha`): `~` expands, a relative path resolves under the data dir, an absolute path stays. */
function resolveAbs(value: string, dataDir: string): string {
	return resolve(expandPath(value, dataDir));
}

function basenameOf(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}
