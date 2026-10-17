// The example's Harness recipe (adapted from upstream pi-durable's example 26): durable sqlite storage under the data
// dir, the coding tools (`read`/`write`/`edit`/`bash`), the prompt extension, and an env builder that returns a FRESH
// execution environment per call from the conversation's `cwd`. New conversations are configured with that cwd (in
// `Threads.create`), so a thread runs its tools in its project's dir. Everything T3-facing lives in `src/` (the
// bridge); this file is what "bring your own Harness" looks like in code.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type EnvTarget, type Extension, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import type { ProjectRegistry } from "../../src/registry.ts";

export type CodingHarness = {
	readonly harness: Harness;
	/** Close to release the storage file. */
	close(): Promise<void>;
};

export async function openCodingHarness(
	config: { readonly dataDir: string },
	projectRegistry: ProjectRegistry,
	models: Models,
	options: { readonly onWarn?: (message: string, error: unknown) => void; readonly extensions?: readonly Extension[] } = {},
): Promise<CodingHarness> {
	// A project is a directory its threads run in; create any that are missing so the first tool call has a cwd. A
	// registered path that cannot be made a directory (an existing FILE at that path) must NEVER keep the host from
	// binding: the UI is the only place that can fix the entry, and a host that dies before its listener binds cannot
	// be told to. Catch per project, warn naming the path, skip; a thread in a skipped project fails later with a
	// typed error (`Threads.create`).
	for (const project of projectRegistry.list()) {
		try {
			await mkdir(project.cwd, { recursive: true });
		}
		catch (error) {
			options.onWarn?.(`project "${project.name}" at ${project.cwd} is not usable as a workspace root and was skipped: ${(error as Error).message}`, error);
		}
	}
	const storage: Storage = await openNodeSqliteStorage(join(config.dataDir, "durable.db"));

	const registry = createRegistry();
	registry.install(CodingTools); // read, write, edit, bash — available to conversations by default.
	for (const extension of options.extensions ?? []) registry.install(extension);

	const harness = await Harness.open(
		storage,
		{
			models,
			registry,
			// A fresh env per invocation, honoring the conversation's `cwd` (its project dir); the data dir is the fallback.
			env: (target: EnvTarget) => new NodeExecutionEnv({ cwd: target.cwd ?? config.dataDir }),
		},
		BACKGROUND_CONTEXT,
	);

	return {
		harness,
		close: async () => {
			await harness.close(BACKGROUND_CONTEXT).catch(() => {});
			await storage.close(BACKGROUND_CONTEXT);
		},
	};
}
