// An in-memory `ProjectRegistry` for tests. It returns the projects it is given, ids included, so a test can reference
// a project by a readable id (`"p"`, `"alpha"`) — the threads layer and bridge treat `projectId` as a foreign key
// resolved through `registry.list()`, and how the id is produced (path-derived in production, given in a test) is the
// registry's business, not theirs. The path-derived ids and duplicate-path refusal of the REAL registry are tested in
// `settings.test.ts` / `registry.test.ts`, not by forcing every threads test to hash an id.
import type { ModelRef } from "@earendil-works/pi-durable";
import type { Project } from "../config.ts";
import type { ProjectRegistry, RegistryDefaults } from "../registry.ts";
import { ProjectConflict, ProjectNotFound } from "../registry.ts";

export class TestRegistry implements ProjectRegistry {
	#projects: Project[];
	#model: ModelRef | undefined;
	#thinkingLevel: string;
	readonly #listeners = new Set<() => void>();

	constructor(projects: readonly Project[], defaults: { model?: ModelRef; thinkingLevel?: string } = {}) {
		this.#projects = projects.map((project) => ({ ...project }));
		this.#model = defaults.model;
		this.#thinkingLevel = defaults.thinkingLevel ?? "off";
	}

	list(): Project[] {
		return this.#projects.map((project) => ({ ...project }));
	}
	defaults(): RegistryDefaults {
		return { model: this.#model, thinkingLevel: this.#thinkingLevel };
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
	add(title: string | undefined, path: string): Project {
		if (this.#projects.some((project) => project.cwd === path)) throw new ProjectConflict(path, this.#projects.find((project) => project.cwd === path)!.id);
		const project: Project = { id: title ?? path, name: title ?? path, cwd: path };
		this.#projects = [...this.#projects, project];
		this.#notify();
		return project;
	}
	update(id: string, patch: { title?: string; path?: string }): Project {
		const index = this.#projects.findIndex((project) => project.id === id);
		if (index < 0) throw new ProjectNotFound(id);
		const next = { ...this.#projects[index]!, ...(patch.title === undefined ? {} : { name: patch.title }), ...(patch.path === undefined ? {} : { cwd: patch.path }) };
		if (this.#projects.some((project, i) => i !== index && project.cwd === next.cwd)) throw new ProjectConflict(next.cwd, this.#projects.find((project, i) => i !== index && project.cwd === next.cwd)!.id);
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
	setModel(model: ModelRef | null): void {
		this.#model = model ?? undefined;
		this.#notify();
	}
	setThinkingLevel(level: string): void {
		this.#thinkingLevel = level;
		this.#notify();
	}
	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

/** Shorthand: a registry over `{ id, cwd }` (cwd defaults to `/data/<id>`). */
export function testRegistry(projects: readonly { id: string; name?: string; cwd?: string }[], defaults: { model?: ModelRef; thinkingLevel?: string } = {}): TestRegistry {
	return new TestRegistry(projects.map((project) => ({ id: project.id, name: project.name ?? project.id, cwd: project.cwd ?? `/data/${project.id}` })), defaults);
}
