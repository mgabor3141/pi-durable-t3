// The "pi" provider's model list for T3's ServerConfig: the provider's models as the caller's catalog reports them
// (`Models.getAvailable()`), each carrying the thinking levels pi-ai says it supports. A reasoning model gets the
// same `thinking` select descriptor T3's own pi provider declares, so the composer renders the control with only
// the choices that model has; a model with no reasoning declares nothing. The bridge selects nothing, remembers no
// default, and adopts no thread's model.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelCapabilities, ServerProvider } from "@t3tools/contracts";
import { modelSlug, type ModelRef, THINKING_OPTION } from "./model-types.ts";
import { PROVIDER_DRIVER, PROVIDER_INSTANCE_ID } from "./projection.ts";

export type CatalogModel = ModelRef & { name: string; thinkingLevels: readonly ModelThinkingLevel[] };

const LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};

/** The picker capabilities: pi's ladder, restricted to the levels this model supports. pi-ai answers `["off"]` for
 * a model with no reasoning, and T3 declares no control for such a model — so nothing is declared here. */
export function thinkingCapabilities(levels: readonly ModelThinkingLevel[]): ModelCapabilities | null {
	if (levels.length < 2) return null;
	return {
		optionDescriptors: [
			{
				id: THINKING_OPTION,
				label: "Thinking",
				type: "select",
				options: levels.map((level) => ({ id: level, label: LEVEL_LABELS[level] })),
			},
		],
	};
}

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
					capabilities: thinkingCapabilities(model.thinkingLevels),
				})),
				slashCommands: [],
				skills: [],
			} as unknown as ServerProvider,
		];
	}
}
