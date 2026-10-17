// T3's server settings, stored the way T3's server stores them: the same document as T3's server (the contracts'
// `ServerSettings`), the same persistence (a SPARSE JSON file — the file decodes over the schema's defaults, and
// T3's own persisted file is exactly "what the defaults would not produce"), the same write (`server.updateSettings`
// applies a PATCH — keys deep-merged into the stored document, `undefined` keys skipped, everything else replaced —
// validates the result against the schema, persists atomically, and answers the FULL settings), and the same signal
// (a settings change re-emits the full settings, which is what carries `settingsUpdated` on the config stream). The
// project registry is NOT here — it is the bridge's own file (`registry.ts`); this file holds exactly what T3's
// server keeps in its `settings.json`.
//
// Deliberately not replicated from T3's settings service: the patch's per-key special cases (legacy project-override
// maps, background-activity profiles, per-entry replacements), secret redaction, provider-history folding, and the
// secret-store indirection. The bridge answers what the client wrote; it interprets nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { ServerSettings, type ProviderInstanceMutation, type ServerSettingsPatch } from "@t3tools/contracts";
import { ConfigError, fail } from "./config.ts";
import { writeJsonAtomic } from "./t3/json-store.ts";

/** The settings file's name, in the data dir — T3's server's own file name. */
export const SETTINGS_FILE = "settings.json";

/** T3's web app treats a provider instance absent from `settings.providerInstances` as DISABLED
 * (`applyProviderInstanceSettings`), so a host whose file carries NO `providerInstances` key serves the `pi`
 * instance — the one fact about this host's driver. It is the only deviation from the contract's defaults, and it
 * disappears the moment the document names its instances (a UI `providerInstanceMutation` is an explicit edit). */
const PI_INSTANCE = { driver: "pi", displayName: "pi", enabled: true };

/** T3's patch rule (`packages/shared/src/Struct.ts`): recursive plain-object merge; `undefined` keys are skipped,
 * arrays and non-objects (including `null`) replace. This is the semantics of `server.updateSettings`. */
function deepMerge(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const existing = next[key];
		next[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
	}
	return next;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The full settings a stored document means: decoded over the schema's defaults, with the `pi` provider instance
 * applied when the document does not name its instances (see `PI_INSTANCE`). Throws on a document the schema
 * refuses — the same decode the next boot performs. */
function materialize(raw: Record<string, unknown>): ServerSettings {
	const settings = Schema.decodeUnknownSync(ServerSettings)(raw) as ServerSettings;
	if (raw.providerInstances === undefined) (settings as { providerInstances: Record<string, unknown> }).providerInstances = { pi: PI_INSTANCE };
	return settings;
}

/** The live `ServerSettings` document: the sparse file read at start, kept in memory (raw + materialized), every
 * mutation validated, persisted, and announced. A missing file is the defaults (a valid first run); an unparseable
 * or undecodable file is a fatal `ConfigError` naming the file — the settings are the UI's document, and the host
 * refuses to boot over damage it cannot show back. */
export class ServerSettingsStore {
	readonly #file: string;
	#raw: Record<string, unknown>;
	#settings: ServerSettings;
	readonly #listeners = new Set<() => void>();

	private constructor(file: string, raw: Record<string, unknown>) {
		this.#file = file;
		this.#raw = raw;
		this.#settings = materialize(raw);
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
		const store = new ServerSettingsStore(file, raw); // materialize() validates the decode; a refusal names the file.
		return store;
	}

	get path(): string {
		return this.#file;
	}

	/** The current full settings (what `server.getSettings` and the config snapshot answer). */
	current(): ServerSettings {
		return this.#settings;
	}

	/** `server.updateSettings`: patch the stored document, validate the result (the decode the NEXT boot performs —
	 * a document the host could not read is a refusal, never a write), persist, notify, and return the full settings. */
	update(patch: ServerSettingsPatch): ServerSettings {
		return this.#commit(deepMerge(this.#raw, patch as Record<string, unknown>));
	}

	/** `providerInstanceMutation` + patch against one snapshot (T3's `updateProviderInstance`): the instance map is
	 * mutated by the contract's operation (`upsert`/`create` set, `delete` removes), and the patch merges the same way. */
	updateProviderInstance(mutation: ProviderInstanceMutation, patch: ServerSettingsPatch = {}): ServerSettings {
		const nextRaw = deepMerge(this.#raw, patch as Record<string, unknown>);
		const providerInstances: Record<string, unknown> = { ...this.#settings.providerInstances };
		if (mutation.operation === "upsert" || mutation.operation === "create") providerInstances[mutation.instanceId] = mutation.instance;
		else delete providerInstances[mutation.instanceId];
		return this.#commit({ ...nextRaw, providerInstances });
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#commit(nextRaw: Record<string, unknown>): ServerSettings {
		let next: ServerSettings;
		try {
			next = materialize(nextRaw);
		} catch (error) {
			fail(this.#file, (error as Error).message);
		}
		writeJsonAtomic(this.#file, nextRaw);
		this.#raw = nextRaw;
		this.#settings = next;
		for (const listener of this.#listeners) listener();
		return next;
	}
}

