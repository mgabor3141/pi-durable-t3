// T3's server settings, stored as T3's server stores them (the replication is design.md's rule and state.md). The
// bridge interprets none of it — it answers what the client wrote — except `HOST_PROVIDER_FACTS`, which answer the
// provider instances a fresh document leaves silent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Equal, Schema } from "effect";
import { DEFAULT_SERVER_SETTINGS, ProviderDriverKind, ServerSettings, type ProviderInstanceConfig, type ProviderInstanceMutation, type ServerSettingsPatch } from "@t3tools/contracts";
import { ConfigError, fail } from "./config.ts";
import { writeJsonAtomic } from "./t3/json-store.ts";

/** T3's server settings document, in the state dir: prefixed, as the one file there in T3's format rather than ours. */
export const SETTINGS_FILE = "t3-settings.json";

/** This host serves one provider: pi. Where the file is silent on `providerInstances`, it is answered with these
 * entries — the instance answers emptiness, not damage (design.md, Invariants; state.md). A document that names a
 * key owns it, so a UI toggle wins. pi is answered enabled (T3 defaults it off, and the pane would show it Disabled);
 * codex and claudeAgent are answered DISABLED: T3 defaults an unconfigured built-in instance of those drivers to
 * ENABLED (`isUnconfiguredDefaultInstanceEnabled`), so on this host — which runs neither — the UI would probe them
 * "Checking…" forever. Naming them disabled is the host's answer to that default. */
const HOST_PROVIDER_FACTS: Record<string, ProviderInstanceConfig> = {
	pi: { driver: ProviderDriverKind.make("pi"), displayName: "pi", enabled: true },
	codex: { driver: ProviderDriverKind.make("codex"), enabled: false },
	claudeAgent: { driver: ProviderDriverKind.make("claudeAgent"), enabled: false },
};

/** T3's persisted defaults — what a write is compared against (T3's `stripDefaultServerSettings`). */
const PERSISTED_DEFAULTS = DEFAULT_SERVER_SETTINGS as unknown as Record<string, unknown>;

/** Values under these keys are compared whole, never field by field (T3's `ATOMIC_SETTINGS_KEYS`). */
const ATOMIC_KEYS = new Set(["backgroundActivity", "automaticGitFetchInterval", "providerHealthRefreshInterval", "sourceControlWriterModelSelection", "reviewGuideModelSelection", "textGenerationModelSelection", "pullRequestMergeMethod"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The model-preference ops T3 applies per key (`packages/shared/src/serverSettings.ts`'s `applyServerSettingsPatch`),
 * which the generic `deepMerge` cannot: they read the CURRENT document, not the file. T3 stores the favorites and
 * per-provider preferences server-side as `favorites` (null = no client has migrated yet) and `providerModelPreferences`
 * (same), so a star toggled on one device is authoritative for every device. Replicated faithfully and no more:
 *
 * - `setModelFavorites` / `setModelsHidden` / `setProviderModelOrder` fold into the current lists, entry by entry, so two
 *   clients editing at once do not cancel each other. Favorites are keyed by (provider, model): re-adding is a no-op,
 *   removing a model on one instance leaves it on another.
 * - `favorites` / `providerModelPreferences` replace the whole value (a clear is authoritative — an empty value beats a
 *   late migration from another device).
 * - `migrateModelPreferences` is the client's one-time upload of a saved list, applied ONLY while the key is still unset
 *   (`current.<key>` is null): a key that owns a value — an empty array included — keeps it. The bridge applies every
 *   patch synchronously against the committed document, which is its serialization of these writes (the rule T3 runs
 *   under a write lock); no `await` sits between the read and the commit.
 *
 * The other per-key special cases (background activity, project overrides, source control, usage maps, model-selection
 * options) stay unreplicated (capabilities.md, Settings row): the model picker sends none of them.
 */
function applyModelPreferences(current: Record<string, unknown>, patch: ServerSettingsPatch): { favorites: unknown; providerModelPreferences: unknown } {
	const { setModelFavorites, setModelsHidden, setProviderModelOrder, favorites: favoritesPatch, providerModelPreferences: preferencesPatch, migrateModelPreferences } = patch;

	const initialFavorites = favoritesPatch ?? (current.favorites as unknown[] | null) ?? migrateModelPreferences?.favorites ?? null;
	const favorites =
		setModelFavorites?.reduce<unknown[]>((list, change) => {
			const exists = list.some((favorite) => (favorite as { provider: string }).provider === change.provider && (favorite as { model: string }).model === change.model);
			return change.favorite
				? exists
					? list
					: [...list, { provider: change.provider, model: change.model }]
				: list.filter((favorite) => (favorite as { provider: string }).provider !== change.provider || (favorite as { model: string }).model !== change.model);
		}, (initialFavorites as unknown[] | null) ?? []) ?? initialFavorites;

	const initialPreferences = (preferencesPatch ?? (current.providerModelPreferences as Record<string, { hiddenModels: string[]; modelOrder: string[] }> | null) ?? migrateModelPreferences?.providerModelPreferences ?? null) as Record<string, { hiddenModels: string[]; modelOrder: string[] }> | null;
	let nextPreferences = initialPreferences;
	for (const change of setModelsHidden ?? []) {
		const preferences = nextPreferences?.[change.provider] ?? { hiddenModels: [], modelOrder: [] };
		const hiddenModels = preferences.hiddenModels.filter((model) => model !== change.model);
		if (change.hidden) hiddenModels.push(change.model);
		nextPreferences = { ...nextPreferences, [change.provider]: { ...preferences, hiddenModels } };
	}
	if (setProviderModelOrder) {
		const preferences = nextPreferences?.[setProviderModelOrder.provider] ?? { hiddenModels: [], modelOrder: [] };
		nextPreferences = { ...nextPreferences, [setProviderModelOrder.provider]: { ...preferences, modelOrder: [...setProviderModelOrder.modelOrder] } };
	}
	return { favorites, providerModelPreferences: nextPreferences };
}

/** T3's patch rule (`packages/shared/src/Struct.ts`): recursive plain-object merge; `undefined` keys are skipped,
 * arrays and non-objects (including `null`) replace. */
function deepMerge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const existing = next[key];
		next[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return next;
}

/** T3's `stripDefaultServerSettings`: a value equal to its default is not written, an object whose keys all strip
 * disappears, arrays and atomic keys are compared as a whole. */
function stripDefaults(current: unknown, defaults: unknown): unknown | undefined {
	if (Array.isArray(current) || Array.isArray(defaults)) return Equal.equals(current, defaults) ? undefined : current;
	if (isPlainObject(current) && isPlainObject(defaults)) {
		const next: Record<string, unknown> = {};
		for (const key of Object.keys(current)) {
			if (ATOMIC_KEYS.has(key)) {
				if (!Equal.equals(current[key], defaults[key])) next[key] = current[key];
				continue;
			}
			const stripped = stripDefaults(current[key], defaults[key]);
			if (stripped !== undefined) next[key] = stripped;
		}
		return Object.keys(next).length > 0 ? next : undefined;
	}
	return Object.is(current, defaults) ? undefined : current;
}

/** The document to write: T3's default-stripping. `clientWroteInstances` keeps a client-mutated instance map whole, so
 * a deleted instance stays deleted (design.md: the bridge interprets nothing in the file). */
function persisted(merged: Record<string, unknown>, clientWroteInstances: boolean): Record<string, unknown> {
	const sparse = (stripDefaults(merged, PERSISTED_DEFAULTS) ?? {}) as Record<string, unknown>;
	if (clientWroteInstances) sparse.providerInstances = merged.providerInstances ?? {};
	return sparse;
}

function decodeSettings(raw: Record<string, unknown>): Record<string, unknown> {
	return Schema.decodeUnknownSync(Schema.toCodecJson(ServerSettings))(raw) as Record<string, unknown>;
}

/** The settings a stored document answers: the decoded document, with the provider facts filled in where the file
 * is silent (`HOST_PROVIDER_FACTS`). */
function withProviderFacts(full: Record<string, unknown>, raw: Record<string, unknown>): ServerSettings {
	// A copy: the facts answer this host; they do not edit the document a patch merges into. An unnamed
	// `providerInstances` is answered the host's instances; one the file names owns itself (a client-mutated map —
	// emptied included — keeps its bytes, so a deleted instance stays deleted).
	const settings = { ...full } as ServerSettings;
	if (raw.providerInstances === undefined) {
		(settings as { providerInstances: Record<string, ProviderInstanceConfig> }).providerInstances = { ...HOST_PROVIDER_FACTS };
	}
	return settings;
}

/** A `create` for an instance id the document already has (T3's `ensureProviderInstanceMutationAllowed`). */
export class ProviderInstanceExists extends Error {
	readonly instanceId: string;
	constructor(instanceId: string) {
		super(`Provider instance ${instanceId} already exists`);
		this.instanceId = instanceId;
	}
}

/** The live `ServerSettings` document: the sparse file read at start, kept in memory, every mutation validated,
 * persisted, and announced. Missing is the defaults; unparseable is a fatal `ConfigError` naming the file (state.md). */
export class ServerSettingsStore {
	readonly #file: string;
	/** Exactly the file's content: the sparse document. */
	#raw: Record<string, unknown>;
	/** The stored document decoded over the defaults — the merge base. The provider facts are answers, not bytes. */
	#full: Record<string, unknown>;
	/** The settings the document answers, provider facts included. */
	#settings: ServerSettings;
	readonly #listeners = new Set<() => void>();

	private constructor(file: string, raw: Record<string, unknown>) {
		this.#file = file;
		this.#raw = raw;
		this.#full = decodeSettings(raw);
		this.#settings = withProviderFacts(this.#full, raw);
	}

	static open(dataDir: string): ServerSettingsStore {
		const file = join(dataDir, SETTINGS_FILE);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ServerSettingsStore(file, {});
			throw error;
		}
		let raw: unknown;
		try {
			raw = text.trim() === "" ? {} : JSON.parse(text);
		} catch (error) {
			fail(file, (error as Error).message);
		}
		if (!isPlainObject(raw)) fail(file, "the settings file must contain a JSON object");
		return new ServerSettingsStore(file, raw); // the constructor's decode validates; a refusal names the file.
	}

	get path(): string {
		return this.#file;
	}

	current(): ServerSettings {
		return this.#settings;
	}

	/** `server.updateSettings`: patch the materialized settings (T3 merges into the decoded document, not the file),
	 * then fold in the model-preference ops T3 applies per key (the model picker's star, hide and reorder). */
	update(patch: ServerSettingsPatch): ServerSettings {
		// The model-preference keys are consumed per key below, never deep-merged into the document (they read the
		// current lists, not the file); the rest merges as T3's patch rule.
		const { setModelFavorites: _f, setModelsHidden: _h, setProviderModelOrder: _o, providerModelPreferences: _p, migrateModelPreferences: _m, ...patchForMerge } = patch;
		const merged = deepMerge(this.#full, patchForMerge as Record<string, unknown>);
		const { favorites, providerModelPreferences } = applyModelPreferences(this.#full, patch);
		return this.#commit({ ...merged, favorites, providerModelPreferences }, false);
	}

	/** `providerInstanceMutation` + patch against one snapshot (T3's `updateProviderInstance`): a `create` for an id
	 * the document has is refused, `upsert`/`create` set, `delete` removes. */
	updateProviderInstance(mutation: ProviderInstanceMutation, patch: ServerSettingsPatch = {}): ServerSettings {
		const instances: Record<string, unknown> = isPlainObject(this.#full.providerInstances) ? { ...this.#full.providerInstances } : {};
		if (mutation.operation === "create" && instances[mutation.instanceId] !== undefined) throw new ProviderInstanceExists(mutation.instanceId);
		if (mutation.operation === "upsert" || mutation.operation === "create") instances[mutation.instanceId] = mutation.instance;
		else delete instances[mutation.instanceId];
		return this.#commit({ ...deepMerge(this.#full, patch as Record<string, unknown>), providerInstances: instances }, true);
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#commit(merged: Record<string, unknown>, clientWroteInstances: boolean): ServerSettings {
		const sparse = persisted(merged, clientWroteInstances);
		let full: Record<string, unknown>;
		try {
			full = decodeSettings(sparse); // the decode the NEXT boot performs; a refusal leaves the file alone.
		} catch (error) {
			fail(this.#file, (error as Error).message);
		}
		writeJsonAtomic(this.#file, sparse);
		this.#raw = sparse;
		this.#full = full;
		this.#settings = withProviderFacts(full, sparse);
		for (const listener of this.#listeners) listener();
		return this.#settings;
	}
}
