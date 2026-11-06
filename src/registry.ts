// The bridge's project registry: the list T3's UI edits, stored in the Harness beside the threads that point at it.
// The rules it enforces — the normalized path as the uniqueness key, an id assigned once and never re-derived — are
// docs/design.md's (IDs, Invariants).
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import { type Project, expandPath } from "./config.ts";
import { projectIdForPath } from "./project-ids.ts";

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

/** A client-minted project id the registry cannot store. A blank id is not a mint: the id derives (design.md, IDs). */
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

/** The cap on a stored id: a client-minted id longer than this is refused. */
export const MAX_STORED_ID_LENGTH = 128;

/** A project as stored: `path` is the uniqueness key (compared normalized), `id` is assigned once (design.md, IDs). */
type StoredProject = { id: string; path: string; title: string };
type ProjectsState = { projects: StoredProject[]; revision: number };

/** The project registry, in the Harness's storage beside the threads that point at it (T3 keeps its projects in its
 * database too). One document: the list is short. */
export const ProjectsDoc = defineDoc<ProjectsState>({
	kind: "pi-durable-t3.projects",
	version: 1,
	scope: "session",
	initial: () => ({ projects: [], revision: 0 }),
	checkpointWhen: () => true,
});

const toProject = (stored: StoredProject): Project => ({ id: stored.id, name: stored.title, cwd: stored.path });

/** The projects a commit sees (the threads layer checks its foreign key with this, inside the commit that writes). */
export async function projectsInCommit(tx: Tx): Promise<Project[]> {
	return (await tx.doc(ProjectsDoc)).projects.map((stored) => toProject(stored as StoredProject));
}

/**
 * The registry T3's UI edits, in pi-durable: reads from memory, every mutation one commit that checks the path and id
 * rules against the stored list. It is the only writer of its document: one registry per Harness.
 */
export class ProjectRegistry {
	readonly #harness: Harness;
	readonly #baseDir: string;
	#state: ProjectsState = { projects: [], revision: 0 };
	readonly #listeners = new Set<() => void>();
	#loading: Promise<void> | undefined;

	/** `baseDir` resolves a relative path and `~` (`expandPath`), as T3 resolves a workspace root. */
	constructor(harness: Harness, options: { readonly baseDir: string }) {
		this.#harness = harness;
		this.#baseDir = options.baseDir;
	}

	/** Read the stored list into memory, once. */
	load(): Promise<void> {
		this.#loading ??= (async () => {
			const stored = await this.#harness.snapshot(ProjectsDoc, BACKGROUND_CONTEXT);
			if (stored !== undefined) this.#state = JSON.parse(JSON.stringify(stored)) as ProjectsState;
		})();
		return this.#loading;
	}

	/** The registered projects, in registration order. Valid once `load()` settled. */
	list(): Project[] {
		return this.#state.projects.map(toProject);
	}

	/** Called after every committed change, before the mutation returns. */
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Resolve a path the way `add` would, for checks that must run BEFORE a registration. */
	resolvePath(path: string): string {
		return resolve(expandPath(path, this.#baseDir));
	}

	/**
	 * Register a project at `path`; `options.clientId` is honored (trimmed, opaque) and the id derives from the normalized
	 * path otherwise (design.md, IDs).
	 */
	async add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Promise<Project> {
		const cwd = this.resolvePath(path);
		const trimmed = options?.clientId?.trim();
		const minted = trimmed !== undefined && trimmed !== "" ? trimmed : undefined;
		if (minted !== undefined && minted.length > MAX_STORED_ID_LENGTH) throw new ProjectIdInvalid(minted, `a project id is at most ${MAX_STORED_ID_LENGTH} characters`);
		const stored: StoredProject = { id: minted ?? projectIdForPath(cwd), path: cwd, title: title ?? titleFor(cwd) };
		await this.#commit((state) => {
			const owner = state.projects.find((entry) => entry.path === cwd);
			if (owner !== undefined) throw new ProjectConflict(cwd, owner.id);
			const idOwner = state.projects.find((entry) => entry.id === stored.id);
			if (idOwner !== undefined) throw new ProjectIdConflict(stored.id, idOwner.path);
			state.projects.push(stored);
		});
		return toProject(stored);
	}

	/** Rename (the title is a free label) and/or move a project's path; a move keeps the project's id (design.md, IDs). */
	async update(id: string, patch: { readonly title?: string; readonly path?: string }): Promise<Project> {
		const moved = patch.path === undefined ? undefined : this.resolvePath(patch.path);
		let result: Project | undefined;
		await this.#commit((state) => {
			const entry = state.projects.find((candidate) => candidate.id === id);
			if (entry === undefined) throw new ProjectNotFound(id);
			const cwd = moved ?? entry.path;
			const owner = state.projects.find((candidate) => candidate.path === cwd);
			if (owner !== undefined && owner.id !== id) throw new ProjectConflict(cwd, owner.id);
			entry.path = cwd;
			if (patch.title !== undefined) entry.title = patch.title;
			result = toProject(entry);
		});
		return result!;
	}

	/** Drop a project's entry. Returns the removed project, or `undefined` when it was not registered. */
	async remove(id: string): Promise<Project | undefined> {
		let removed: Project | undefined;
		await this.#commit((state) => {
			const index = state.projects.findIndex((entry) => entry.id === id);
			if (index < 0) return false;
			removed = toProject(state.projects[index]!);
			state.projects.splice(index, 1);
		});
		return removed;
	}

	/** The registry's one writer: apply `change` to the stored list in one commit; a refusal (a throw) changes nothing,
	 * and `false` is a no-op that writes nothing and notifies nobody. */
	async #commit(change: (state: ProjectsState) => false | void): Promise<void> {
		await this.load();
		const next = await this.#harness.commit(async (tx) => {
			const draft = await tx.doc(ProjectsDoc);
			const state = JSON.parse(JSON.stringify(draft)) as ProjectsState;
			if (change(state) === false) return undefined;
			state.revision += 1;
			draft.projects = state.projects;
			draft.revision = state.revision;
			return state;
		}, BACKGROUND_CONTEXT);
		if (next === undefined || next.revision <= this.#state.revision) return;
		this.#state = next;
		for (const listener of this.#listeners) listener();
	}
}

function titleFor(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/");
	return parts[parts.length - 1] || path;
}
