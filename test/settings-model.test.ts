// T3's server settings over the bridge: `server.updateSettings` applies a PATCH (T3's `deepMerge`: nested keys
// merge, `undefined` is skipped, everything else — including `null` — replaces), answers the FULL settings, and the
// change signal re-emits them as `settingsUpdated` on the config stream (M2: without the event, a saved edit looks
// like it reverted). A failed write answers the contract's typed `ServerSettingsError`, BUILT as the contract's
// class with the required `settingsPath`/`operation` (M3: the hand-rolled shape encoded as a Defect). The bridge
// validates the model against no catalog and computes no defaults — it stores what the client sent.
import { mkdir, mkdtemp, chmod, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ServerConfigStreamEvent, ServerSettingsError } from "@t3tools/contracts";
import { ServerSettingsStore, SETTINGS_FILE } from "../src/settings.ts";
import { ConfigError } from "../src/config.ts";
import { connectWs, exitError, exitValue, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-settings-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

describe("the settings store (T3's patch + persistence semantics)", () => {
	it("a missing file is the baseline: contract defaults with the pi provider instance enabled; an unparseable file is a refusal naming it", async () => {
		const dir = join(scratch, "store-baseline");
		await mkdir(dir);
		const store = ServerSettingsStore.open(dir);
		expect((store.current().providerInstances as Record<string, { enabled?: boolean } | undefined>).pi?.enabled).toBe(true);
		expect(store.current().defaultModelSelection).toBeNull();
		await writeFile(join(dir, SETTINGS_FILE), "{ nope");
		expect(() => ServerSettingsStore.open(dir)).toThrow(new RegExp(SETTINGS_FILE));
	});


	it("update PATCHES: nested keys merge, siblings survive, null clears, and the write persists (re-readable whole)", async () => {
		const dir = join(scratch, "store-patch");
		await mkdir(dir);
		const store = ServerSettingsStore.open(dir);
		let notified = 0;
		store.subscribe(() => notified++);

		const patched = store.update({ defaultModelSelection: { instanceId: "pi", model: "pi/one" } as never });
		expect(patched.defaultModelSelection).toEqual({ instanceId: "pi", model: "pi/one" });
		expect((patched.providerInstances as Record<string, { enabled?: boolean } | undefined>).pi?.enabled, "the patch touches only the keys it names").toBe(true);
		expect(notified).toBe(1);

		// A second patch merges: the first key survives (the file is a document, not a per-key store).
		const settings = store.update({ responseStreamingMode: "turn" } as never);
		expect(settings.defaultModelSelection).toEqual({ instanceId: "pi", model: "pi/one" });
		expect((settings as { responseStreamingMode?: string }).responseStreamingMode).toBe("turn");

		// `null` clears (a nullable key replaces, per T3's merge).
		expect(store.update({ defaultModelSelection: null }).defaultModelSelection).toBeNull();

		// The document persists whole: a fresh store reads what the first one wrote.
		const reopened = ServerSettingsStore.open(dir);
		expect(reopened.current().responseStreamingMode).toBe("turn");
	});

	it("providerInstanceMutation deletes an instance and upserts one (T3's instance-map operations)", async () => {
		const dir = join(scratch, "store-instances");
		await mkdir(dir);
		const store = ServerSettingsStore.open(dir);
		expect((store.updateProviderInstance({ operation: "delete", instanceId: "pi" } as never).providerInstances as Record<string, unknown>).pi).toBeUndefined();
		const up = store.updateProviderInstance({ operation: "upsert", instanceId: "pi", instance: { driver: "pi", displayName: "pi", enabled: true } } as never);
		expect((up.providerInstances as Record<string, { enabled?: boolean } | undefined>).pi?.enabled).toBe(true);
	});
});

const TOKEN = "probe-token-settings-0123456789";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A root with one project, the offline reply model, and a fixed pairing token. */
async function makeRoot(name: string, port: number): Promise<string> {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ path: join(root, "projects/alpha"), title: "alpha" }] }), "utf8");
	return root;
}

/** Pair, open `/ws`, and read the provider catalog. */
async function connect(port: number) {
	const token = await pair(port, TOKEN);
	const ws = await connectWs(port, token);
	const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
	const provider = providers.providers.find((entry) => entry.instanceId === "pi") ?? providers.providers[0];
	const slugs = (provider?.models ?? []).map((model) => model.slug);
	if (slugs.length === 0) throw new Error("the offline catalog is empty");
	return { ws, slugs };
}

const eventsOf = (chunks: Frame[]) => chunks.flatMap((frame) => (frame.values ?? []) as { type: string; payload?: { settings?: { defaultModelSelection?: { model?: string } | null } } }[]);

it("a settings write answers the full settings, the stream emits settingsUpdated, and a failed write reaches the client as the typed ServerSettingsError (M2, M3)", async () => {
	const port = 4932;
	const root = await makeRoot("m2", port);
	const file = join(root, SETTINGS_FILE);
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		expect(await waitListening(port)).toBe(true);
		ws = await connect(port);
		const streamId = await ws.ws.open("subscribeServerConfig", {});
		for (let i = 0; i < 60 && eventsOf(ws.ws.chunks(streamId)).length === 0; i++) await sleep(50);
		let events = eventsOf(ws.ws.chunks(streamId));
		expect(events[0]?.type).toBe("snapshot");

		const good = ws.slugs[0]!;
		const answer = await ws.ws.call("server.updateSettings", { patch: { defaultModelSelection: { instanceId: "pi", model: good } } });
		const saved = exitValue(answer, "server.updateSettings(good)") as { defaultModelSelection: { model: string } };
		expect(saved.defaultModelSelection.model).toBe(good);

		// The stream pushes the same settings: the pane follows the write instead of looking like it reverted.
		for (let i = 0; i < 60 && !eventsOf(ws.ws.chunks(streamId)).some((event) => event.type === "settingsUpdated"); i++) await sleep(50);
		events = eventsOf(ws.ws.chunks(streamId));
		const updated = events.filter((event) => event.type === "settingsUpdated");
		expect(updated.length, `stream events: ${JSON.stringify(events.map((event) => event.type))}`).toBeGreaterThan(0);
		expect(updated.at(-1)!.payload?.settings?.defaultModelSelection?.model).toBe(good);
		// Every event on the stream is a contract-valid `ServerConfigStreamEvent`.
		for (const event of events) expect(() => Schema.decodeUnknownSync(ServerConfigStreamEvent)(event)).not.toThrow();
		// And the write landed in the settings file, which stays T3's document shape.
		expect((JSON.parse(await readFile(file, "utf8")) as { defaultModelSelection: { model: string } }).defaultModelSelection.model).toBe(good);

		// M3 — a failed write is a typed refusal, not a defect: the data dir stops accepting creates, so the
		// store's atomic write fails. `exitError` throws on a `Defect` frame: that is exactly what this names.
		await chmod(root, 0o500);
		try {
			const answer = await ws.ws.call("server.updateSettings", { patch: { defaultModelSelection: { instanceId: "pi", model: "pi/two" } } });
			const error = exitError(answer, "server.updateSettings(write failure)");
			expect(error._tag).toBe("ServerSettingsError");
			expect(typeof error.settingsPath).toBe("string");
			expect(typeof error.operation).toBe("string");
			expect(() => Schema.decodeUnknownSync(ServerSettingsError)(error)).not.toThrow();
		} finally {
			await chmod(root, 0o700);
		}
	} finally {
		ws?.ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

