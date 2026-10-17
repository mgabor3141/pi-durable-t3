// T3's server settings, stored as T3's server stores them: the contracts' `ServerSettings` as a SPARSE file that
// decodes over the schema's defaults, patched by `server.updateSettings` with T3's merge rule, validated by the
// decode the next boot performs, answered FULL, and announced on the change signal. The bytes are T3's bytes: a
// write persists the materialized document with the contract's defaults stripped, so a key written back at its
// default costs no bytes. The project registry is NOT here (`registry.ts`); this is what T3's server keeps in
// `settings.json`. The bridge interprets none of it — it answers what the client wrote — except the provider facts
// in `HOST_PROVIDER_FACTS`, which answer keys a fresh document leaves silent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Equal, Schema } from "effect";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, type ProviderInstanceMutation, type ServerSettingsPatch } from "@t3tools/contracts";
import { ConfigError, fail } from "./config.ts";
import { writeJsonAtomic } from "./t3/json-store.ts";

/** The settings file's name, in the data dir — T3's server's own file name. */
export const SETTINGS_FILE = "settings.json";

/** This host serves one provider: pi. T3's web app reads the instance map for the picker (an instance absent from it
 * is DISABLED) and the legacy `providers` map for its provider pane (a driver's `enabled` is that row's switch).
 * The contract's defaults leave every driver off EXCEPT Codex and Claude Agent — so an untouched document tells the
 * composer "no provider" and the pane "Codex and Claude are live here", with an editor for a CLI this host does not
 * run. A document that names neither key is answered the other way round: the `pi` instance on, those two drivers
 * off. A document that names a key owns it, and a write AT a contract default writes no byte (T3's stripping), so
 * the answer for an unnamed key stands — the pane cannot light up a provider this host does not run. */
const HOST_PROVIDER_FACTS = {
	instance: { driver: "pi", displayName: "pi", enabled: true },
	/** The drivers whose contract default is ENABLED, minus `pi` (whose own defaults are left alone). */
	offDrivers: ["codex", "claudeAgent"] as const,
};

/** T3's persisted defaults — what a write is compared against. These three drivers' `enabled` is deliberately not
 * a default to strip: provider history cannot recover a new opt-in. */
const PERSISTED_DEFAULTS = {
	...DEFAULT_SERVER_SETTINGS,
	providers: {
		...(DEFAULT_SERVER_SETTINGS.providers as unknown as Record<string, Record<string, unknown>>),
		cursor: { ...(DEFAULT_SERVER_SETTINGS.providers.cursor as unknown as Record<string, unknown>), enabled: undefined },
		grok: { ...(DEFAULT_SERVER_SETTINGS.providers.grok as unknown as Record<string, unknown>), enabled: undefined },
		opencode: { ...(DEFAULT_SERVER_SETTINGS.providers.opencode as unknown as Record<string, unknown>), enabled: undefined },
	},
} as unknown as Record<string, unknown>;

/** Values under these keys are compared whole, never field by field (T3's `ATOMIC_SETTINGS_KEYS`). */
const ATOMIC_KEYS = new Set(["backgroundActivity", "automaticGitFetchInterval", "providerHealthRefreshInterval", "sourceControlWriterModelSelection", "textGenerationModelSelection", "pullRequestMergeMethod"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

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

/** The document to write: T3's default-stripping. `clientWroteInstances` is the host rule: an emptied
 * `providerInstances` equals the contract's `{}` and would strip to nothing, and a stripped key hands the map back
 * to the host's provider fact — so a map the client mutated keeps its bytes, and a delete of the `pi` instance
 * stays deleted. A patch that never touched instances leaves the map to the stripping, so the fact survives a
 * theme change. */
function persisted(merged: Record<string, unknown>, clientWroteInstances: boolean): Record<string, unknown> {
	const sparse = (stripDefaults(merged, PERSISTED_DEFAULTS) ?? {}) as Record<string, unknown>;
	if (clientWroteInstances) sparse.providerInstances = merged.providerInstances ?? {};
	return sparse;
}

function decodeSettings(raw: Record<string, unknown>): Record<string, unknown> {
	return Schema.decodeUnknownSync(Schema.toCodecJson(ServerSettings))(raw) as Record<string, unknown>;
}

/** The settings a stored document answers: the decoded document, with the provider facts filled in where the file
 * is silent (see `HOST_PROVIDER_FACTS`). */
function withProviderFacts(full: Record<string, unknown>, raw: Record<string, unknown>): ServerSettings {
	// A copy: the facts answer this host, they do not edit the document a patch merges into.
	const settings = { ...full } as ServerSettings;
	if (raw.providerInstances === undefined) (settings as { providerInstances: Record<string, unknown> }).providerInstances = { pi: HOST_PROVIDER_FACTS.instance };
	const stored = isPlainObject(raw.providers) ? (raw.providers as Record<string, unknown>) : {};
	const providers = { ...(settings.providers as unknown as Record<string, Record<string, unknown>>) };
	for (const driver of HOST_PROVIDER_FACTS.offDrivers) {
		const blob = stored[driver];
		if (isPlainObject(blob) && blob.enabled !== undefined) continue;
		providers[driver] = { ...providers[driver], enabled: false };
	}
	(settings as unknown as { providers: Record<string, unknown> }).providers = providers;
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

/** The live `ServerSettings` document: the sparse file read at start, kept in memory (the stored document, and the
 * settings it answers), every mutation validated, persisted, and announced. A missing file is the defaults (a valid
 * first run); an unparseable or undecodable file is a fatal `ConfigError` naming the file. */
export class ServerSettingsStore {
	readonly #file: string;
	/** Exactly the file's content: the sparse document. */
	#raw: Record<string, unknown>;
	/** The stored document decoded over the defaults — the merge base. The provider facts are answers, not bytes: a
	 * patch merges without them, so a client's write decides whether the document names the key. */
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
		return new ServerSettingsStore(file, raw); // materialize() validates the decode; a refusal names the file.
	}

	get path(): string {
		return this.#file;
	}

	current(): ServerSettings {
		return this.#settings;
	}

	/** `server.updateSettings`: patch the materialized settings (T3 merges into the decoded document, not the file). */
	update(patch: ServerSettingsPatch): ServerSettings {
		return this.#commit(deepMerge(this.#full, patch as Record<string, unknown>), false);
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
