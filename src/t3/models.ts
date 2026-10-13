// The "pi" provider's model list for T3's ServerConfig. Read from pi's own model runtime (same agent dir and
// models.json as the host) and replaced by a Session's `pi.models` catalog whenever the bridge sees one.
import type { ServerProvider } from "@t3tools/contracts";
import type { ModelRef, ModelsState } from "./model-types.ts";
import { modelSlug, PROVIDER_DRIVER, PROVIDER_INSTANCE_ID } from "./projection.ts";

type CatalogModel = ModelRef & { name: string; reasoning: boolean };

export class ModelCatalog {
	#models: CatalogModel[] = [];
	#default: ModelRef | undefined;
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

	/** Adopt a Session's catalog and its selected model as the default for new threads. */
	adopt(state: ModelsState | undefined): void {
		if (state === undefined) return;
		const models = state.catalog.availableModels.map((m) => ({ ...m }));
		if (state.configuration.model !== null) this.#default = state.configuration.model;
		if (models.length > 0 && JSON.stringify(models) !== JSON.stringify(this.#models)) this.#set(models);
	}

	#set(models: CatalogModel[]): void {
		this.#models = models;
		this.#checkedAt = new Date().toISOString();
		for (const listener of this.#listeners) listener();
	}

	/** The model new or not-yet-loaded threads report: the last Session's model, else the first available one. */
	defaultModel(): ModelRef | null {
		return this.#default ?? this.#models[0] ?? null;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	providers(): ServerProvider[] {
		const defaultSlug = this.#default === undefined ? undefined : modelSlug(this.#default);
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
					...(modelSlug(model) === defaultSlug ? { isDefault: true } : {}),
					capabilities: null,
				})),
				slashCommands: [],
				skills: [],
			} as unknown as ServerProvider,
		];
	}
}
