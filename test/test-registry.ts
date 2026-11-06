// A real `ProjectRegistry` over a test's Harness, seeded with projects at the ids a test reads them by (`"p"`,
// `"alpha"`): the threads layer checks a thread's project inside its commit, against the registry's stored list, so a
// test registers its projects there like the UI does.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { join } from "node:path";
import { ProjectRegistry } from "../src/registry.ts";

/** A registry over `harness` holding `projects` (`cwd` defaults to `/data/<id>`, `name` to the id). */
export async function testRegistry(
	harness: Harness,
	projects: readonly { id: string; name?: string; cwd?: string }[],
	options: { baseDir?: string } = {},
): Promise<ProjectRegistry> {
	const registry = new ProjectRegistry(harness, { baseDir: options.baseDir ?? "/" });
	await registry.load();
	for (const project of projects) {
		if (registry.list().some((existing) => existing.id === project.id)) continue;
		await registry.add(project.name ?? project.id, project.cwd ?? `/data/${project.id}`, { clientId: project.id });
	}
	return registry;
}

/** A registry on a Harness of its own (memory storage), for a test that has no Harness: `close` when done. */
export async function standaloneRegistry(projects: readonly { id: string; name?: string; cwd?: string }[]): Promise<ProjectRegistry> {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	return testRegistry(harness, projects);
}

/** A registry on a Harness over `dir`/durable.db, so a test can close it and read the same storage again. */
export async function storedRegistry(dir: string): Promise<{ registry: ProjectRegistry; harness: Harness; close: () => Promise<void> }> {
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	const registry = new ProjectRegistry(harness, { baseDir: dir });
	await registry.load();
	return { registry, harness, close: () => harness.close(BACKGROUND_CONTEXT) };
}
