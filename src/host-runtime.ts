// The host's Harness wiring — the exact code `main.ts` runs — factored out so the tool/env path is testable without
// booting the facet. Opens storage under the data dir, installs the coding tools (`read`/`write`/`edit`/`bash`), and
// supplies an env builder that builds a fresh execution environment per call from the conversation's `cwd`. New
// conversations are configured with that cwd (in `Threads.create`), so a thread runs its tools in its project's dir.
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, type EnvTarget, type Extension, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BasePrompt } from "./base-prompt.ts";
import type { HostConfig } from "./config.ts";
import type { ProjectRegistry } from "./registry.ts";
import { Threads } from "./threads.ts";

type HostRuntime = {
	readonly harness: Harness;
	readonly threads: Threads;
	/** Close to release the storage file. */
	close(context?: typeof BACKGROUND_CONTEXT): Promise<void>;
};

export async function openHostRuntime(
	config: HostConfig,
	projectRegistry: ProjectRegistry,
	models: Models,
	defaultModel: ModelRef | undefined,
	options: { readonly onWarn?: (message: string, error: unknown) => void; readonly extensions?: readonly Extension[] } = {},
): Promise<HostRuntime> {
	// A project is a directory its threads run in; create any that are missing so the first tool call has a cwd.
	for (const project of projectRegistry.list()) await mkdir(project.cwd, { recursive: true });
	const storage = await openNodeSqliteStorage(join(config.dataDir, "durable.db"));

	const registry = createRegistry();
	registry.install(CodingTools); // read, write, edit, bash — available to conversations by default.
	// Extra extensions to install beyond the coding tools. The host passes none; a shutdown test installs a tool whose
	// run ignores its abort signal, to reproduce the mid-turn stall the graceful close must time-box (see test/fast-shutdown).
	for (const extension of options.extensions ?? []) registry.install(extension);
	registry.install(BasePrompt); // the built-in base system prompt section, so a new conversation is not left blank.

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

	// `instructions` is read at thread-create time (not cached), so editing the file affects new threads only.
	const instructions = config.instructionsPath === undefined ? undefined : () => readFileSync(config.instructionsPath!, "utf8");
	const defaults = projectRegistry.defaults();
	const threads = new Threads({ harness, registry: projectRegistry, defaultModel, ...(defaults.thinkingLevel === undefined ? {} : { defaultThinkingLevel: defaults.thinkingLevel }), ...(instructions === undefined ? {} : { instructions }), ...(options.onWarn === undefined ? {} : { onWarn: options.onWarn }) });
	await threads.repair();
	harness.resume(); // continue the runs the last process left unfinished

	return {
		harness,
		threads,
		close: async (context = BACKGROUND_CONTEXT) => {
			await harness.close(context).catch(() => {});
			await storage.close(context);
		},
	};
}
