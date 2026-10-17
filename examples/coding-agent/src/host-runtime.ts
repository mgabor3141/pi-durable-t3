// The example's Harness recipe (adapted from upstream pi-durable's example 26): durable sqlite storage under the data
// dir, the coding tools (`read`/`write`/`edit`/`bash`), the prompt extension, and an env builder that returns a FRESH
// execution environment per call from the conversation's `cwd`. New conversations are configured with that cwd (in
// `Threads.create`), so a thread runs its tools in its project's dir. Everything T3-facing lives in `src/` (the
// bridge); this file is what "bring your own Harness" looks like in code.
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type EnvTarget, type Extension, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";

export type CodingHarness = {
	readonly harness: Harness;
	/** Close to release the storage file. */
	close(): Promise<void>;
};

export async function openCodingHarness(
	config: { readonly dataDir: string },
	models: Models,
	options: { readonly onWarn?: (message: string, error: unknown) => void; readonly extensions?: readonly Extension[] } = {},
): Promise<CodingHarness> {
	// A project is a directory its threads run in; `attachT3` creates the registered ones (the bridge owns the
	// registry). This harness never touches the registry: a conversation runs where its own `cwd` says.
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
