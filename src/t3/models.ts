// The "pi" provider's model list for T3's ServerConfig: the provider's models as the caller's catalog reports them
// (`Models.getAvailable()`). The picker list and the answer to `server.refreshProviders` — the bridge selects
// nothing, remembers no default, and adopts no thread's model.
import type { ServerProvider } from "@t3tools/contracts";
import { modelSlug, type ModelRef } from "./model-types.ts";
import { PROVIDER_DRIVER, PROVIDER_INSTANCE_ID } from "./projection.ts";

type CatalogModel = ModelRef & { name: string };

export class ModelCatalog {
	#models: CatalogModel[] = [];
	readonly #listeners = new Set<() => void>();
	readonly #source: (() => Promise<CatalogModel[]>) | undefined;
	#checkedAt = new Date().toISOString();

	/**
	 * `source` supplies the provider's models (the host passes its own model runtime, kept under the host root so
	 * `~/.pi` is never written). Without one the catalog only follows what `adopt` sees from a thread.
	 */
	constructor(source?: () => Promise<CatalogModel[]>) {
		this.#source = source;
	}

	async refresh(): Promise<void> {
		if (this.#source === undefined) return;
		try {
			const models = await this.#source();
			if (this.#models.length === 0 || models.length > 0) this.#set(models);
		} catch (error) {
			console.error("model catalog refresh failed:", error);
		}
	}

	/** The catalog's models: the list a new-thread default is validated against, and the list a refusal names. */
	available(): CatalogModel[] {
		return this.#models.map((model) => ({ ...model }));
	}

	#set(models: CatalogModel[]): void {
		this.#models = models;
		this.#checkedAt = new Date().toISOString();
		for (const listener of this.#listeners) listener();
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	providers(): ServerProvider[] {
		return [
			{
				instanceId: PROVIDER_INSTANCE_ID,
				driver: PROVIDER_DRIVER,
				displayName: "pi",
				supportsConversationRollback: true,
				supportedRuntimeModes: ["full-access"],
				showInteractionModeToggle: false,
				enabled: true,
				installed: true,
				version: "1.1.0",
				status: "ready",
				auth: { status: "authenticated" },
				checkedAt: this.#checkedAt,
				models: this.#models.map((model) => ({
					slug: modelSlug(model),
					name: model.name,
					shortName: model.modelId,
					subProvider: model.provider,
					isCustom: false,
					capabilities: null,
				})),
				slashCommands: [],
				skills: [],
			} as unknown as ServerProvider,
		];
	}
}
