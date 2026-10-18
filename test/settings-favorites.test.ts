// T3's model preferences, replicated in the bridge's `ServerSettingsStore.update` (design.md: replicated from
// `packages/shared/src/serverSettings.ts`'s `applyServerSettingsPatch`, no more). These are the per-key patch ops the
// model picker sends — star (`setModelFavorites`), hide (`setModelsHidden`), reorder (`setProviderModelOrder`), whole
// replace (`favorites`/`providerModelPreferences`), and the one-time upload (`migrateModelPreferences`) — which the
// generic `deepMerge` cannot apply: each reads the CURRENT document, not the file. The bridge's writes are synchronous
// against the committed document, so it is the bridge's serialization of these writes (the rule T3 runs under a write
// lock). The tests are T3's, ported: the shared `serverSettings.test.ts` "synchronized model preferences" block and
// the server `serverSettings.test.ts` serialization/persistence cases, retargeted at the store that answers
// `server.updateSettings`. `t3-settings.json` is asserted directly: the star must survive a restart.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ServerSettingsStore, SETTINGS_FILE } from "../src/settings.ts";
import { tempRoot } from "./temp-root.ts";

// T3's tests use these instance ids; the bridge stores what the client names, so the ids are arbitrary labels.
const provider = ProviderInstanceId.make("codex_work");
const otherProvider = ProviderInstanceId.make("claude_work");
const legacy = {
	favorites: [{ provider, model: "sol" }],
	providerModelPreferences: { [provider as string]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
};

/** The store's model-preference answer, matching T3's `resolveModelPreferences` on the settings the update returns. */
const prefs = (store: ServerSettingsStore) => ({
	favorites: store.current().favorites ?? null,
	providerModelPreferences: store.current().providerModelPreferences ?? null,
});

describe("model preferences (T3's per-key patch ops) on the bridge store", () => {
	it("a fresh document answers the contract's null (the client's migrate trigger), and the store keeps it null", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		// Null (not empty) is T3's default: it is what makes the client hydrate its saved list and send `migrateModelPreferences`.
		expect(store.current().favorites).toBeNull();
		expect(store.current().providerModelPreferences).toBeNull();
	});

	it("keeps concurrent adds and removes of the same favorite idempotent", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] } as never;
		expect(store.update(add).favorites).toEqual([{ provider, model: "sol" }]);
		expect(store.update(add).favorites, "re-adding the same id is a no-op").toEqual([{ provider, model: "sol" }]);
		const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] } as never;
		expect(store.update(remove).favorites).toEqual([]);
		expect(store.update(remove).favorites, "re-removing is a no-op").toEqual([]);
	});

	it("preserves unrelated models and providers during bulk visibility and order edits", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ providerModelPreferences: { ...legacy.providerModelPreferences, [otherProvider as string]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] } } } as never);
		store.update({ setModelsHidden: [{ provider, model: "luna", hidden: true }] } as never);
		const web = store.update({
			setModelsHidden: [
				{ provider, model: "astra", hidden: false },
				{ provider, model: "sol", hidden: true },
			],
			setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
		} as never);
		expect((web.providerModelPreferences as Record<string, unknown>)[provider as string]).toEqual({
			hiddenModels: ["luna", "sol"],
			modelOrder: ["sol", "luna", "astra"],
		});
		expect((web.providerModelPreferences as Record<string, unknown>)[otherProvider as string], "the other provider's entry is untouched").toEqual({ hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] });
		expect((store.update({ setProviderModelOrder: { provider, modelOrder: [] } } as never).providerModelPreferences as Record<string, unknown>)[provider as string]).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
	});

	it("migrates a saved list into a fresh document, each key independently", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		const migrated = store.update({ migrateModelPreferences: legacy } as never);
		expect(migrated.favorites).toEqual(legacy.favorites);
		expect(migrated.providerModelPreferences).toEqual(legacy.providerModelPreferences);
		// A key that already owns a value (an empty array included) is authoritative: a favorites-only migration does not
		// resurrect favorites, and the providerModelPreferences key migrates on its own.
		const favoritesCleared = ServerSettingsStore.open(await tempRoot());
		favoritesCleared.update({ favorites: [] } as never);
		const second = favoritesCleared.update({ migrateModelPreferences: { favorites: legacy.favorites, providerModelPreferences: legacy.providerModelPreferences } } as never);
		expect(second.favorites, "an explicit empty favorites list wins over a migration").toEqual([]);
		expect(second.providerModelPreferences, "the unset key migrates independently").toEqual(legacy.providerModelPreferences);
	});

	it("keeps explicit clears when a delayed migration arrives from another device", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ favorites: [], providerModelPreferences: {} } as never);
		const after = store.update({ migrateModelPreferences: legacy } as never);
		expect(prefs(store)).toEqual({ favorites: [], providerModelPreferences: {} });
		expect(after.favorites).toEqual([]);
		expect(after.providerModelPreferences).toEqual({});
	});

	it("replaces visibility records so showing every model clears removed entries", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ migrateModelPreferences: legacy } as never);
		const cleared = store.update({ providerModelPreferences: {} } as never);
		expect(cleared.providerModelPreferences).toEqual({});
		expect(cleared.favorites, "clearing visibility leaves favorites alone").toEqual(legacy.favorites);
	});

	it("sets favorites against the latest state without losing changes from other clients", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ setModelFavorites: [{ provider, model: "sol", favorite: true }] } as never);
		// A second client's add arrives with a stale migration (its own empty saved list); the migration is ignored, the add lands.
		const second = store.update({ setModelFavorites: [{ provider, model: "astra", favorite: true }], migrateModelPreferences: { favorites: [] } } as never);
		expect(second.favorites).toEqual([{ provider, model: "sol" }, { provider, model: "astra" }]);
		const removed = store.update({ setModelFavorites: [{ provider, model: "sol", favorite: false }] } as never);
		expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
		expect(store.update({ setModelFavorites: [{ provider, model: "astra", favorite: false }] } as never).favorites).toEqual([]);
	});

	it("sets visibility against the latest state without replacing other models or their order", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ providerModelPreferences: legacy.providerModelPreferences } as never);
		store.update({ setModelsHidden: [{ provider, model: "sol", hidden: true }] } as never);
		const second = store.update({ setModelsHidden: [{ provider, model: "luna", hidden: true }] } as never);
		expect((second.providerModelPreferences as Record<string, unknown>)[provider as string]).toEqual({ hiddenModels: ["astra", "sol", "luna"], modelOrder: ["sol"] });
		const restored = store.update({ setModelsHidden: [{ provider, model: "sol", hidden: false }] } as never);
		expect((restored.providerModelPreferences as Record<string, unknown>)[provider as string]).toEqual({ hiddenModels: ["astra", "luna"], modelOrder: ["sol"] });
		expect(store.update({ setModelsHidden: [{ provider, model: "sol", hidden: false }] } as never).providerModelPreferences, "un-hiding an already-visible model is a no-op").toEqual(restored.providerModelPreferences);
		const fresh = ServerSettingsStore.open(await tempRoot());
		expect((fresh.update({ setModelsHidden: [{ provider, model: "sol", hidden: true }] } as never).providerModelPreferences as Record<string, { readonly hiddenModels: readonly string[] }>)[provider as string].hiddenModels, "hiding on a fresh document seeds the provider entry").toEqual(["sol"]);
	});

	it("keeps the same model on different provider instances as separate favorites", async () => {
		const personal = ProviderInstanceId.make("codex_personal");
		const store = ServerSettingsStore.open(await tempRoot());
		store.update({ setModelFavorites: [{ provider, model: "sol", favorite: true }] } as never);
		const second = store.update({ setModelFavorites: [{ provider: personal, model: "sol", favorite: true }] } as never);
		expect(second.favorites).toEqual([{ provider, model: "sol" }, { provider: personal, model: "sol" }]);
		expect(store.update({ setModelFavorites: [{ provider, model: "sol", favorite: false }] } as never).favorites, "unfavoriting one instance leaves the other").toEqual([{ provider: personal, model: "sol" }]);
	});

	it("keeps explicit edits when the same patch also carries a legacy migration", async () => {
		const store = ServerSettingsStore.open(await tempRoot());
		const edited = store.update({ migrateModelPreferences: legacy, favorites: [], providerModelPreferences: {} } as never);
		expect(prefs(store)).toEqual({ favorites: [], providerModelPreferences: {} });
		expect(edited.favorites).toEqual([]);
	});

	it("serializes a run of preference edits without cancelling duplicate adds, and the writes survive a restart", async () => {
		// The bridge's writes are synchronous against the committed document (the store is its write lock), so a burst of
		// edits composes exactly as T3's write-locked service composes them concurrently.
		const dir = await tempRoot();
		const store = ServerSettingsStore.open(dir);
		store.update({ setModelFavorites: [{ provider, model: "sol", favorite: true }] } as never);
		store.update({ setModelFavorites: [{ provider, model: "sol", favorite: true }] } as never);
		store.update({ setModelFavorites: [{ provider, model: "luna", favorite: true }] } as never);
		store.update({ setModelsHidden: [{ provider, model: "astra", hidden: true }] } as never);
		store.update({ setModelsHidden: [{ provider, model: "luna", hidden: true }] } as never);
		store.update({ setProviderModelOrder: { provider, modelOrder: ["luna", "sol"] } } as never);
		const settings = store.current();
		expect((settings.favorites ?? []).map((entry) => entry.model).sort()).toEqual(["luna", "sol"]);
		expect((settings.providerModelPreferences as Record<string, { readonly hiddenModels: readonly string[] }>)[provider as string].hiddenModels.toSorted()).toEqual(["astra", "luna"]);
		expect((settings.providerModelPreferences as Record<string, { readonly modelOrder: readonly string[] }>)[provider as string].modelOrder).toEqual(["luna", "sol"]);

		// The bytes land in `t3-settings.json` as T3's document, and a re-opened store reads the star back.
		const written = JSON.parse(await readFile(join(dir, SETTINGS_FILE), "utf8")) as { favorites: { model: string }[]; providerModelPreferences: Record<string, unknown> };
		expect(written.favorites.map((entry) => entry.model).sort()).toEqual(["luna", "sol"]);
		expect(written.providerModelPreferences[provider as string]).toEqual({ hiddenModels: ["astra", "luna"], modelOrder: ["luna", "sol"] });
		const reopened = ServerSettingsStore.open(dir);
		expect((reopened.current().favorites ?? []).map((entry) => entry.model).sort()).toEqual(["luna", "sol"]);
	});
});
