// The "pi" provider's model list for T3's ServerConfig: the caller's catalog, each model declaring pi's `thinking`
// ladder for the levels pi-ai says it supports (capabilities.md). The bridge selects nothing and remembers no default.
// The lists themselves are pi's: the models a pi release ships with, plus the newer lists it downloads (pi.dev's
// catalog). The bridge asks for that download now and then, as pi's own model selector does, and on Settings' Refresh.
import type { HostUpdateWatch } from "./host-updates.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelCapabilities, ServerProvider } from "@t3tools/contracts";
import { modelSlug, type ModelRef, THINKING_OPTION } from "./model-types.ts";
import type { Logger } from "./logging.ts";
import { PROVIDER_DRIVER, PROVIDER_INSTANCE_ID } from "./projection.ts";

export type CatalogModel = ModelRef & { name: string; thinkingLevels: readonly ModelThinkingLevel[]; contextWindow: number };

/** Bring the model lists up to date (pi-ai's `Models.refresh`): `force` downloads even a list checked recently. */
export type ModelListUpdate = (options: { force: boolean; signal: AbortSignal }) => Promise<{ readonly errors: ReadonlyMap<string, Error> }>;

/**
 * How often the lists are checked. pi downloads a provider's list at most every 4 hours unless forced (its
 * `REMOTE_CATALOG_REFRESH_INTERVAL_MS`), so most checks cost nothing, and a new model shows within about 5 hours.
 */
export const MODEL_LIST_CHECK_MS = 60 * 60 * 1000;
/** pi's own bound on a model list download (`pi update --models`, its model selector). */
const MODEL_LIST_TIMEOUT_MS = 15_000;
/** A model picker that opens downloads the lists again unless they were downloaded this recently (T3: "a few minutes"). */
export const MODEL_LIST_FRESH_MS = 5 * 60 * 1000;

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
	readonly #update: ModelListUpdate | undefined;
	readonly #log: Logger | undefined;
	#updating: Promise<void> = Promise.resolve();
	/** When a download was last asked for, whatever pi's own freshness rule would have said. */
	#downloadAskedAt = 0;
	#checkedAt = new Date().toISOString();

	/**
	 * The catalog's source — the host's model runtime, kept under the host root so `~/.pi` is never written — and how
	 * to bring its lists up to date (none: the lists are what the source has).
	 */
	constructor(source: () => Promise<CatalogModel[]>, update?: ModelListUpdate, log?: Logger) {
		this.#source = source;
		this.#update = update;
		this.#log = log;
	}

	/** The host's own version and updates, when the integrator has them: the provider's version advisory and its Update. */
	hostUpdates: HostUpdateWatch | undefined;

	/** The provider's snapshot changed for a reason other than its models (its version, an update under way). */
	changed(): void {
		for (const listener of this.#listeners) listener();
	}

	/** Read the source again: what it has now (a list it downloaded, a changed models.json, a new credential). */
	async refresh(): Promise<void> {
		try {
			this.#set(await this.#source());
		} catch (error) {
			this.#log?.warn("model catalog refresh failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/**
	 * Bring the lists up to date, then read them. A failure is logged and keeps the lists the source had. Updates run
	 * one at a time; one asked for while another runs follows it.
	 */
	update(force = false): Promise<void> {
		const update = this.#update;
		if (update === undefined) return this.refresh();
		if (force) this.#downloadAskedAt = Date.now();
		const next = this.#updating.then(async () => {
			try {
				const { errors } = await update({ force, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
				for (const [provider, error] of errors) this.#log?.warn("model list update failed", { provider, error: error.message });
			} catch (error) {
				this.#log?.warn("model list update failed", { error: error instanceof Error ? error.message : String(error) });
			}
			await this.refresh();
		});
		this.#updating = next;
		return next;
	}

	/**
	 * A model picker opened (T3's `modelCatalogOnly`): download the lists, unless one was asked for in the last
	 * `MODEL_LIST_FRESH_MS`. So a model released an hour ago is there when the user next looks for it.
	 */
	updateForPicker(): Promise<void> {
		return Date.now() - this.#downloadAskedAt < MODEL_LIST_FRESH_MS ? this.#updating : this.update(true);
	}

	/** Update the lists now and every `MODEL_LIST_CHECK_MS`, in the background; the returned function stops it. */
	watch(): () => void {
		void this.update();
		const timer = setInterval(() => void this.update(), MODEL_LIST_CHECK_MS);
		timer.unref();
		const stopUpdates = this.hostUpdates?.watch();
		return () => {
			clearInterval(timer);
			stopUpdates?.();
		};
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
		const version = this.hostUpdates?.snapshot();
		return [
			{
				instanceId: PROVIDER_INSTANCE_ID,
				driver: PROVIDER_DRIVER,
				displayName: "pi",
				supportsConversationRollback: true,
				supportedRuntimeModes: ["full-access"],
				showInteractionModeToggle: false,
				reportsContextWindow: true,
				enabled: true,
				installed: true,
				version: "1.1.0",
				// The integrator's own version, what is newest, and an update under way (`host-updates.ts`).
				...version,
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
				slashCommands: [
					{ name: "compact", description: "Summarize the conversation and reduce context usage", input: { hint: "Optional guidance" } },
					{ name: "reload", description: "Reload the system prompt: AGENTS.md, skills, MCP servers and tools" },
				],
				skills: [],
			} as unknown as ServerProvider,
		];
	}
}
