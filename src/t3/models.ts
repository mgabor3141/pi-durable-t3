// The "pi" provider's model list for T3's ServerConfig: the caller's catalog, each model declaring pi's `thinking`
// ladder for the levels pi-ai says it supports (capabilities.md). The bridge selects nothing and remembers no default.
// The lists themselves are pi's: the models a pi release ships with, plus the newer lists it downloads (pi.dev's
// catalog). The bridge asks for that download now and then, as pi's own model selector does, and on Settings' Refresh.
import type { HostUpdateWatch } from "./host-updates.ts";
import { type ModelThinkingLevel, PI_AI_VERSION } from "@earendil-works/pi-ai";
import type { ModelCapabilities, ServerProvider } from "@t3tools/contracts";
import { modelSlug, type ModelRef, THINKING_OPTION } from "./model-types.ts";
import type { Logger } from "./logging.ts";
import { PROVIDER_DRIVER, PROVIDER_INSTANCE_ID } from "./projection.ts";
import { messageOf } from "../host-errors.ts";

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
function thinkingCapabilities(levels: readonly ModelThinkingLevel[]): ModelCapabilities | null {
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

/** The slash commands this host answers itself (`thread-commands.ts`), as T3's composer lists them. */
const BUILT_IN_COMMANDS = [
	{ name: "compact", description: "Summarize the conversation and reduce context usage", input: { hint: "Optional guidance" } },
	{ name: "reload", description: "Reload the system prompt: AGENTS.md, skills, MCP servers and tools" },
	{ name: "context", description: "Show what fills the context window; shown here only, not sent to the model" },
	{ name: "undo", description: "Take back your last message and what the agent did for it", input: { hint: "n, or: step [n] for the agent's last steps only" } },
	{ name: "redo", description: "Bring back what the last undo took, while nothing new was written; /redo fork opens it as a new thread" },
	{ name: "tree", description: "Show every line this thread has had, undone ones too, as a tree: go to any turn, or open it as a new thread" },
	{ name: "continue", description: "Let the agent go on from where the conversation stands, with no new message" },
] as const;

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

	/** The integrator's slash commands (`HostCommand`), listed after this host's own. */
	hostCommands: readonly { readonly name: string; readonly description: string; readonly hint?: string }[] = [];

	/** The names of the slash commands this host answers itself. */
	slashCommandNames(): ReadonlySet<string> {
		return new Set(BUILT_IN_COMMANDS.map((command) => command.name));
	}

	/** The host's own version and updates, when the integrator has them: the provider's version advisory and its Update. */
	hostUpdates: HostUpdateWatch | undefined;

	/**
	 * What this host is built on, in the provider's version: the pi release, and the T3 release `attachT3` adds. The
	 * integrator's own version comes first when it has updates, "claw 680f25f, pi 1.6.0, t3 0.1.11": it is the part
	 * that changes, and T3's provider list shows about a dozen characters of a version.
	 */
	platform = `pi ${PI_AI_VERSION}`;

	/** The provider's snapshot changed for a reason other than its models (its version, an update under way). */
	changed(): void {
		for (const listener of this.#listeners) listener();
	}

	/** Read the source again: what it has now (a list it downloaded, a changed models.json, a new credential). */
	async refresh(): Promise<void> {
		try {
			this.#set(await this.#source());
		} catch (error) {
			this.#log?.warn("model catalog refresh failed", { error: messageOf(error) });
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
				this.#log?.warn("model list update failed", { error: messageOf(error) });
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
		const { label, ...version } = this.hostUpdates?.snapshot() ?? {};
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
				// T3 shows a version that starts with a letter as it is.
				version: label === undefined ? this.platform : `${label}, ${this.platform}`,
				// What is newest, and an update under way (`host-updates.ts`).
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
					...BUILT_IN_COMMANDS,
					...this.hostCommands.map((command) => ({ name: command.name, description: command.description, ...(command.hint === undefined ? {} : { input: { hint: command.hint } }) })),
				],
				skills: [],
			} as unknown as ServerProvider,
		];
	}
}
