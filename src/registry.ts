// The bridge's project registry: the list T3's UI edits, in the bridge's own `projects.json`. The rules it enforces —
// the normalized path as the uniqueness key, an id assigned once and never re-derived, the boot parser as the
// definition of writable, one host per data dir — are docs/design.md's (IDs, Invariants).
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

/** A mutation minted a project id that another project already owns: one id naming two entries is a document the
 * parser refuses, so the write path refuses it too (design.md, IDs; the facet answers the typed project error). */
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

/** A client-minted project id the registry file cannot store. A blank id is not a mint: the id derives (design.md, IDs). */
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

// The workspace-root refusals mirror T3's own checks (`apps/server/src/workspace/WorkspacePaths.ts`), each naming the
// path: a root is validated before anything is stored (design.md, Invariants).

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

/** The cap the registry file's parser enforces on a stored id; the write path refuses what its parser refuses. */
export const MAX_STORED_ID_LENGTH = 128;

/** The mutable registry the host, threads layer, and facet share. */
export interface ProjectRegistry {
	/** The registered projects (path-derived id, title label, absolute cwd). A snapshot, in registry order. */
	list(): Project[];
	/** Register a change listener (a mutation fires it after the file is written); returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
	/**
	 * Register a project at `path` (absolute, `~` expanded); `options.clientId` is honored when the contract's
	 * `ProjectId` accepts it, and the id derives from the normalized path otherwise (design.md, IDs).
	 */
	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project;
	/** Resolve a path the way `add` would, for checks that must run BEFORE a registration. */
	resolvePath(path: string): string;
	/** Rename (the title is a free label) and/or move a project's path; a move keeps the project's id (design.md, IDs). */
	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project;
	/** Drop a project's entry. Returns the removed project, or `undefined` when it was not registered. */
	remove(id: string): Project | undefined;
	/** The registry file this host writes (a refusal that cannot store an entry names it). */
	readonly path: string;
}

/** A project as the registry file stores it: `path` is the uniqueness key (compared NORMALIZED), `title` is a free
 * label, and `id` is present once one was assigned (design.md, IDs). */
type ProjectEntry = { readonly path: string; readonly title?: string; readonly id?: string };
type ProjectsFile = { readonly projects: readonly ProjectEntry[] };

/** The registry entry shape, strict: `{ path, title?, id? }` and nothing else. */
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

/** Parse and validate `projects.json` text for `dataDir` (JSON → defaults → schema → checks). STRICT: this parser is
 * the definition of writable (design.md, Invariants); `file` names the source in messages. */
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
		// `path.resolve` accepts a NUL byte (it is just a string); every file operation on the resolved path rejects it,
		// so a NUL path is not a usable project path.
		let cwd: string;
		try {
			if (entry.path.includes("\u0000")) throw new Error("the path contains a NUL byte, which no file operation accepts");
			cwd = resolve(expandPath(entry.path, dataDir));
		} catch (error) {
			fail(file, `projects[${index}].path "${entry.path}" is not a usable path (${(error as Error).message})`);
		}
		if (seen.has(cwd)) fail(file, `projects[${index}]: duplicate project path "${entry.path}" (resolved ${cwd}); a project is a path, and the title is a label`);
		seen.add(cwd);
		// A stored id is honored and TRIMMED; absent, it derives from the normalized path (design.md, IDs).
		const storedId = entry.id === undefined ? undefined : entry.id.trim();
		const hasStoredId = storedId !== undefined && storedId !== "";
		const id = hasStoredId ? storedId! : projectIdForPath(cwd);
		if (seenIds.has(id)) fail(file, `projects[${index}]: duplicate project id "${id}"; a minted id is unique, and paths are already refused above`);
		seenIds.add(id);
		projects.push({ id, name: entry.title ?? titleFor(cwd), cwd });
	}
	return projects;
}

/** The id a stored entry answers, spelled the way the parser and `list()` spell it: the trimmed mint, else one
 * derived from its RESOLVED path. */
function idOf(entry: ProjectEntry, dataDir: string): string {
	return entry.id !== undefined ? entry.id.trim() : projectIdForPath(resolveAbs(entry.path, dataDir));
}

/** A `projects.json`-backed registry under `dataDir`: in-memory reads, every mutation a delta on the document. */
export class FileProjectRegistry implements ProjectRegistry {
	readonly #dataDir: string;
	#projects: Project[];
	readonly #listeners = new Set<() => void>();

	private constructor(dataDir: string, projects: Project[]) {
		this.#dataDir = dataDir;
		this.#projects = projects;
	}

	/** Load the registry from the file: a missing file is an empty registry, an unreadable one a refusal naming it
	 * (design.md: the host does not boot over damage). */
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
		// Honor the id the client minted (design.md, IDs), then treat it as opaque: stored and compared, never parsed.
		const trimmed = options?.clientId?.trim();
		const minted = trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
		if (minted !== undefined && minted.length > MAX_STORED_ID_LENGTH) throw new ProjectIdInvalid(minted, `the registry file stores at most ${MAX_STORED_ID_LENGTH} characters`);
		const project: Project = { id: minted ?? projectIdForPath(cwd), name: title ?? titleFor(cwd), cwd };
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
			// A move changes the PATH, never the id, and a derived id gets STORED here: an id is assigned once and never
			// re-derived (design.md, IDs), so a move cannot split a project from its threads.
			const name = title ?? current.title ?? titleFor(cwd);
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
			const index = disk.projects.findIndex((entry) => idOf(entry, dataDir) === id);
			if (index === -1) return disk; // not registered: nothing to write, nothing to notify
			const entry = disk.projects[index]!;
			const cwd = resolveAbs(entry.path, dataDir);
			removed = { id, name: entry.title ?? titleFor(cwd), cwd };
			const projects = [...disk.projects];
			projects.splice(index, 1);
			return { ...disk, projects };
		});
		return removed;
	}

	/** The id of the project that owns `cwd` in this document, comparing paths the way the parser does. */
	#ownerOf(disk: ProjectsFile, cwd: string): string | undefined {
		const dataDir = this.#dataDir;
		for (const entry of disk.projects) if (resolveAbs(entry.path, dataDir) === cwd) return idOf(entry, dataDir);
		return undefined;
	}

	/**
	 * The registry's ONE writer: read the document, apply this mutation as a delta, validate it with the parser the
	 * NEXT boot will use, write atomically. A refusal changes nothing at all (design.md, Invariants).
	 */
	#commit(delta: (disk: ProjectsFile) => ProjectsFile): void {
		const file = this.path;
		const disk = readDisk(file, this.#dataDir);
		const next = delta(disk);
		if (JSON.stringify(next) === JSON.stringify(disk)) return; // a no-op mutation writes nothing and notifies nobody.
		const projects = parseProjectsJson(JSON.stringify(next), this.#dataDir, file);
		writeJsonAtomic(file, next);
		this.#projects = projects;
		for (const listener of this.#listeners) listener();
	}
}

/** Read the registry file as the strict base a delta applies to: missing is the empty registry, and a document the
 * boot parser refuses is a refusal naming it (design.md, Invariants). */
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
	return { ...(minted === undefined ? {} : { id: minted }), path: project.cwd, ...(project.name === titleFor(project.cwd) ? {} : { title: project.name }) };
}

/** Resolve a project path to absolute, normalized, under `dataDir` — the one spelling of the uniqueness key. */
function resolveAbs(value: string, dataDir: string): string {
	return resolve(expandPath(value, dataDir));
}

function titleFor(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}
