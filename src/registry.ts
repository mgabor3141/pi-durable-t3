// The live project registry + new-thread defaults, backed by the instance file (`settings.json`). It is the single
// source of truth for what a UI edits: the host, the threads layer, and the T3 facet all read through it, and the
// running host writes it on the UI's behalf. Reading is in-memory (loaded at start); every mutation writes the file
// atomically and notifies subscribers, so a facet projection reflects a UI edit at once. A thread never reaches it.
//
// A project's UNIQUENESS KEY is its normalized path — compared normalized, so `…/alpha` and `…/alpha/` are one
// project, not two sharing an id. Its ID is minted by whoever registers it: T3's UI mints a UUID before the project
// exists and navigates to it, and the host honors it exactly as it honors client-minted thread ids; when no client id
// is supplied (integrator-written entries, folders discovered from a conversation cwd), the id derives from the
// normalized path, so nothing mints it and it survives a restart unchanged. The id is then opaque and stable: a title
// rename is free, and a root MOVE keeps the id — and therefore the project's threads. `add` refuses a duplicate path —
// T3 refuses the same folder twice (`ProjectWorkspaceConflictError`), and a project IS a path.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { expandPath, type Project } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";
import {
	INSTANCE_FILE,
	THINKING_LEVELS,
	type InstanceFile,
	loadInstanceFile,
} from "./settings.ts";

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

/** The id shape T3's client mints for a project (`apps/web/src/lib/utils.ts`: `ProjectId.make(randomUUID())`).
 * A mutation carrying an id in this shape is a MINT, and the host honors it; anything else is a placeholder, and the
 * id derives from the normalized path. Opaque thereafter: the host never parses it, only stores and compares it. */
export const CLIENT_MINTED_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
	 * project's id — rows that reference it (its threads) keep resolving to it. */
	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project;
	/** Drop a project's entry. Returns the removed project, or `undefined` when it was not registered. */
	remove(id: string): Project | undefined;
	/** Set the new-thread model default (`provider/model`, or `null` to clear → first available). */
	setModel(model: ModelRef | null): void;
	/** Set the new-thread thinking level. */
	setThinkingLevel(level: string): void;
}

/** A `settings.json`-backed registry under `dataDir`. Synchronous reads (an in-memory snapshot); async mutations. */
export class FileProjectRegistry implements ProjectRegistry {
	readonly #dataDir: string;
	#file: InstanceFile;
	readonly #listeners = new Set<() => void>();
	#model: ModelRef | undefined;
	#thinkingLevel: string;

	private constructor(dataDir: string, file: InstanceFile, model: ModelRef | undefined, thinkingLevel: string) {
		this.#dataDir = dataDir;
		this.#file = file;
		this.#model = model;
		this.#thinkingLevel = thinkingLevel;
	}

	/** Load the registry from the instance file. A missing file is an empty registry (a valid first run). */
	static async open(dataDir: string): Promise<FileProjectRegistry> {
		const resolved = await loadInstanceFile(dataDir);
		const file: InstanceFile = {
			projects: resolved.projects.map((project) => ({ ...(project.storedId === undefined ? {} : { id: project.storedId }), path: project.cwd, ...(project.title === "" ? {} : { title: project.title }) })),
			defaults: { ...(resolved.model === undefined ? {} : { model: `${resolved.model.provider}/${resolved.model.modelId}` }), thinkingLevel: resolved.thinkingLevel },
		};
		return new FileProjectRegistry(dataDir, file, resolved.model, resolved.thinkingLevel);
	}

	/** The raw file path (for logging / a warning that names the file a UI writes). */
	get path(): string {
		return join(this.#dataDir, INSTANCE_FILE);
	}

	list(): Project[] {
		// A stored id (client-minted, durable) is the project's id; without one the id derives from the normalized path.
		return this.#file.projects.map((project) => ({ id: project.id ?? projectIdForPath(project.path), name: project.title ?? basenameOf(project.path), cwd: project.path }));
	}

	defaults(): RegistryDefaults {
		return { model: this.#model, thinkingLevel: this.#thinkingLevel };
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project {
		const cwd = resolveAbs(path, this.#dataDir);
		const conflict = this.#findByCwd(cwd);
		if (conflict !== undefined) throw new ProjectConflict(cwd, conflict.id);
		// Honor the id the client minted (the shape it mints, `CLIENT_MINTED_ID`); derive from the normalized path otherwise.
		const minted = options?.clientId !== undefined && CLIENT_MINTED_ID.test(options.clientId) ? options.clientId : undefined;
		const project = { ...(minted === undefined ? {} : { id: minted }), path: cwd, ...(title === undefined || title === "" ? {} : { title }) };
		this.#setFile({ ...this.#file, projects: [...this.#file.projects, project] });
		return { id: project.id ?? projectIdForPath(cwd), name: project.title ?? basenameOf(cwd), cwd };
	}

	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project {
		const index = this.#file.projects.findIndex((project) => (project.id ?? projectIdForPath(project.path)) === id);
		if (index < 0) throw new ProjectNotFound(id);
		const current = this.#file.projects[index]!;
		const cwd = patch.path === undefined ? current.path : resolveAbs(patch.path, this.#dataDir);
		const owner = this.#findByCwd(cwd);
		if (owner !== undefined && owner.id !== id) throw new ProjectConflict(cwd, owner.id);
		const title = patch.title ?? current.title;
		// The id is opaque and stable: a move changes the PATH, never the id — the project's threads keep resolving to it.
		const updated = { ...(current.id === undefined ? {} : { id: current.id }), path: cwd, ...(title === undefined || title === "" ? {} : { title }) };
		const projects = [...this.#file.projects];
		projects[index] = updated;
		this.#setFile({ ...this.#file, projects });
		return { id: updated.id ?? projectIdForPath(cwd), name: updated.title ?? basenameOf(cwd), cwd };
	}

	resolvePath(path: string): string {
		return resolveAbs(path, this.#dataDir);
	}

	remove(id: string): Project | undefined {
		const index = this.#file.projects.findIndex((project) => (project.id ?? projectIdForPath(project.path)) === id);
		if (index < 0) return undefined;
		const removed = this.#file.projects[index]!;
		const projects = [...this.#file.projects];
		projects.splice(index, 1);
		this.#setFile({ ...this.#file, projects });
		return { id, name: removed.title ?? basenameOf(removed.path), cwd: removed.path };
	}

	setModel(model: ModelRef | null): void {
		this.#model = model ?? undefined;
		const defaults = { ...this.#file.defaults };
		if (model === null) delete defaults.model;
		else defaults.model = `${model.provider}/${model.modelId}`;
		this.#setFile({ ...this.#file, defaults });
	}

	setThinkingLevel(level: string): void {
		if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) return;
		this.#thinkingLevel = level;
		this.#setFile({ ...this.#file, defaults: { ...this.#file.defaults, thinkingLevel: level } });
	}

	#findByCwd(cwd: string): Project | undefined {
		return this.list().find((project) => project.cwd === cwd);
	}

	/** Commit the in-memory file, persist it atomically (temp → rename), then notify. The write is synchronous: the file
	 * is durable the instant a mutation returns, so a crash never loses a UI edit and a reader never sees half a file. */
	#setFile(file: InstanceFile): void {
		this.#file = file;
		const path = join(this.#dataDir, INSTANCE_FILE);
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
		for (const listener of this.#listeners) listener();
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
