// An in-memory `ProjectRegistry` for tests. It returns the projects it is given, ids included, so a test can
// reference a project by a readable id (`"p"`, `"alpha"`) — the threads layer and bridge treat `projectId` as a
// foreign key resolved through `registry.list()`, and how the id is produced (client-minted / path-derived in
// production, given in a test) is the registry's business, not theirs. `add` honors a `clientId` verbatim (the test
// names its id; the shape policy is the real registry's), and the path is the uniqueness key, compared normalized,
// as in the real registry. The path-derived ids and duplicate-path refusal of the REAL registry are tested in
// `settings.test.ts`.
import { resolve } from "node:path";
import type { Project } from "../src/config.ts";
import type { ProjectRegistry } from "../src/registry.ts";
import { ProjectConflict, ProjectNotFound } from "../src/registry.ts";

export class TestRegistry implements ProjectRegistry {
	#projects: Project[];
	readonly #listeners = new Set<() => void>();
	/** The registry file an in-memory registry claims: nothing is written, a refusal just names something. */
	readonly path: string;

	constructor(projects: readonly Project[], options: { path?: string } = {}) {
		this.#projects = projects.map((project) => ({ ...project }));
		this.path = options.path ?? "/test/projects.json";
	}

	list(): Project[] {
		return this.#projects.map((project) => ({ ...project }));
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	add(title: string | undefined, path: string, options?: { readonly clientId?: string }): Project {
		const cwd = resolve(path);
		if (this.#projects.some((project) => resolve(project.cwd) === cwd)) throw new ProjectConflict(cwd, this.#projects.find((project) => resolve(project.cwd) === cwd)!.id);
		const project: Project = { id: options?.clientId ?? title ?? cwd, name: title ?? cwd, cwd };
		this.#projects = [...this.#projects, project];
		this.#notify();
		return project;
	}

	resolvePath(path: string): string {
		return resolve(path);
	}

	update(id: string, patch: { title?: string; path?: string }): Project {
		const index = this.#projects.findIndex((project) => project.id === id);
		if (index < 0) throw new ProjectNotFound(id);
		const next = { ...this.#projects[index]!, ...(patch.title === undefined ? {} : { name: patch.title }), ...(patch.path === undefined ? {} : { cwd: resolve(patch.path) }) };
		if (this.#projects.some((project, i) => i !== index && resolve(project.cwd) === resolve(next.cwd))) throw new ProjectConflict(next.cwd, this.#projects.find((project, i) => i !== index && resolve(project.cwd) === resolve(next.cwd))!.id);
		const projects = [...this.#projects];
		projects[index] = next;
		this.#projects = projects;
		this.#notify();
		return { ...next };
	}

	remove(id: string): Project | undefined {
		const index = this.#projects.findIndex((project) => project.id === id);
		if (index < 0) return undefined;
		const removed = this.#projects[index]!;
		this.#projects = this.#projects.filter((_, i) => i !== index);
		this.#notify();
		return removed;
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** Shorthand: a registry over `{ id, cwd }` (cwd defaults to `/data/<id>`). */
export function testRegistry(projects: readonly { id: string; name?: string; cwd?: string }[], options: { path?: string } = {}): TestRegistry {
	return new TestRegistry(projects.map((project) => ({ id: project.id, name: project.name ?? project.id, cwd: project.cwd ?? `/data/${project.id}` })), options);
}
