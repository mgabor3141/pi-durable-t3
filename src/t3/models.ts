// The "pi" provider's model list for T3's ServerConfig: the caller's catalog, each model declaring pi's `thinking`
// ladder for the levels pi-ai says it supports (capabilities.md). The bridge selects nothing and remembers no default.
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

/** The picker capabilities: pi's ladder, restricted to the model's levels; fewer than two declares no control. */
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
	readonly #source: () => Promise<CatalogModel[]>;
	#checkedAt = new Date().toISOString();

	/** The catalog's source — the host's model runtime, kept under the host root so `~/.pi` is never written. */
	constructor(source: () => Promise<CatalogModel[]>) {
		this.#source = source;
	}

	async refresh(): Promise<void> {
		try {
			this.#set(await this.#source());
		} catch (error) {
			console.error("model catalog refresh failed:", error);
		}
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
