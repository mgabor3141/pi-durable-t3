// The live project registry + new-thread defaults, backed by the instance file (`settings.json`). It is the single
// source of truth for what a UI edits: the host, the threads layer, and the T3 facet all read through it, and the
// running host writes it on the UI's behalf. Reading is in-memory (loaded at start); every mutation writes the file
// atomically and notifies subscribers, so a facet projection reflects a UI edit at once. A thread never reaches it.
//
// A project's identity is its normalized path (the id is derived from it); the title is a free label. `add` refuses a
// duplicate path — T3 refuses the same folder twice (`ProjectWorkspaceConflictError`), and a project IS a path.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

export type RegistryDefaults = { readonly model: ModelRef | undefined; readonly thinkingLevel: string };

/** The mutable registry the host, threads layer, and facet share. */
export interface ProjectRegistry {
	/** The registered projects (path-derived id, title label, absolute cwd). A snapshot, in registry order. */
	list(): Project[];
	/** The new-thread defaults a UI edits. */
	defaults(): RegistryDefaults;
	/** Register a change listener (a mutation fires it after the file is written); returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
	/** Register a project at `path` (absolute, `~` expanded). Refuses a path another project already owns. */
	add(title: string | undefined, path: string): Project;
	/** Rename (title is a free label) and/or move a project's path; a move that collides is refused. */
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
			projects: resolved.projects.map((project) => ({ path: project.cwd, ...(project.title === "" ? {} : { title: project.title }) })),
			defaults: { ...(resolved.model === undefined ? {} : { model: `${resolved.model.provider}/${resolved.model.modelId}` }), thinkingLevel: resolved.thinkingLevel },
		};
		return new FileProjectRegistry(dataDir, file, resolved.model, resolved.thinkingLevel);
	}

	/** The raw file path (for logging / a warning that names the file a UI writes). */
	get path(): string {
		return join(this.#dataDir, INSTANCE_FILE);
	}

	list(): Project[] {
		return this.#file.projects.map((project) => ({ id: projectIdForPath(project.path), name: project.title ?? basenameOf(project.path), cwd: project.path }));
	}

	defaults(): RegistryDefaults {
		return { model: this.#model, thinkingLevel: this.#thinkingLevel };
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	add(title: string | undefined, path: string): Project {
		const cwd = resolveAbs(path, this.#dataDir);
		const conflict = this.#findByCwd(cwd);
		if (conflict !== undefined) throw new ProjectConflict(cwd, conflict.id);
		const project = { path: cwd, ...(title === undefined || title === "" ? {} : { title }) };
		this.#setFile({ ...this.#file, projects: [...this.#file.projects, project] });
		return { id: projectIdForPath(cwd), name: project.title ?? basenameOf(cwd), cwd };
	}

	update(id: string, patch: { readonly title?: string; readonly path?: string }): Project {
		const index = this.#file.projects.findIndex((project) => projectIdForPath(project.path) === id);
		if (index < 0) throw new ProjectNotFound(id);
		const current = this.#file.projects[index]!;
		const cwd = patch.path === undefined ? current.path : resolveAbs(patch.path, this.#dataDir);
		const owner = this.#findByCwd(cwd);
		if (owner !== undefined && owner.id !== id) throw new ProjectConflict(cwd, owner.id);
		const title = patch.title ?? current.title;
		const updated = { path: cwd, ...(title === undefined || title === "" ? {} : { title }) };
		const projects = [...this.#file.projects];
		projects[index] = updated;
		this.#setFile({ ...this.#file, projects });
		return { id: projectIdForPath(cwd), name: updated.title ?? basenameOf(cwd), cwd };
	}

	remove(id: string): Project | undefined {
		const index = this.#file.projects.findIndex((project) => projectIdForPath(project.path) === id);
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

/** Resolve a project path to absolute under `dataDir`: `~` expands, a relative path resolves under the data dir, an
 * absolute path stays. Shared with the instance-file parser, so an add and a hand-written file land the same folder. */
function resolveAbs(value: string, dataDir: string): string {
	return expandPath(value, dataDir);
}

function basenameOf(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}

/** Read the current instance-file text from disk (a test helper to assert what the host wrote). */
export async function readInstanceFileText(dataDir: string): Promise<string> {
	return readFile(join(dataDir, INSTANCE_FILE), "utf8");
}
