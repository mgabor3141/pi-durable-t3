// The new-thread model, validated, and settings changes that reach the UI. Review M1/M2/M3 (anchor, wire):
//   (a) M1 — `chooseDefaultModel` returned `configured ?? first` with no catalog check, and `server.updateSettings`
//       wrote `splitSlug(...)` straight into the registry: a typo'd default made EVERY new thread an interrupted turn,
//       the exact failure the config layer exists to prevent. Both paths now validate against the catalog and refuse
//       with a typed error naming the model and a bounded list of what is available.
//   (b) M2 — `subscribeServerConfig` emitted `snapshot` and `providerStatuses` only, never `settingsUpdated`, so a
//       saved edit looked like it had reverted. The stream follows the registry's change signal now.
//   (c) M3 — the catch path built `{_tag:"ServerSettingsError", message}` — missing the contract-required
//       `settingsPath` and `operation` — so a write failure reached the client as a schema-encoding DEFECT.
// Probes: a bad slug is refused and the registry is byte-unchanged; a good slug is stored and the subscriber receives
// `settingsUpdated`; every error response decodes against the contract's `ServerSettingsError`.
import { mkdtemp, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ServerConfigStreamEvent, ServerSettingsError } from "@t3tools/contracts";
import { ModelNotAvailable, modelSlug } from "../src/t3/model-types.ts";
import { chooseDefaultModel } from "../src/config.ts";
import { connectWs, exitError, exitValue, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-settings-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-settings-0123456789";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A root with one project, the offline reply model, and a fixed pairing token. */
async function makeRoot(name: string, port: number): Promise<string> {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [{ path: join(root, "projects/alpha"), title: "alpha" }], defaults: {} }), "utf8");
	return root;
}

/** Pair, open `/ws`, and read the provider catalog — the list a default model is validated against. */
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

it("a default model outside the catalog is refused naming it and what IS available; the registry is unchanged (M1)", async () => {
	const port = 4931;
	const root = await makeRoot("m1", port);
	const file = join(root, "settings.json");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		expect(await waitListening(port)).toBe(true);
		ws = await connect(port);
		const before = await readFile(file, "utf8");
		const bad = "pi/no-such-model-anywhere";
		const answer = await ws.ws.call("server.updateSettings", { patch: { defaultModelSelection: { instanceId: "pi", model: bad } } });
		// A typed refusal — `exitError` throws if the frame is a `Defect` (a schema-encode failure).
		const error = exitError(answer, `server.updateSettings(${bad})`);
		expect(error._tag).toBe("ServerSettingsError");
		// It names the refused model and the available ones.
		const detail = JSON.stringify(error);
		expect(detail).toContain(bad);
		for (const slug of ws.slugs) expect(detail).toContain(slug);
		// The registry is unchanged: the file bytes, and what a reader sees.
		expect(await readFile(file, "utf8")).toBe(before);
		const settings = exitValue(await ws.ws.call("server.getSettings", {}), "server.getSettings") as { defaultModelSelection: unknown };
		expect(settings.defaultModelSelection).toBeNull();
	} finally {
		ws?.ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a good slug is stored, and the subscriber receives settingsUpdated (M2)", async () => {
	const port = 4932;
	const root = await makeRoot("m2", port);
	const file = join(root, "settings.json");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		expect(await waitListening(port)).toBe(true);
		ws = await connect(port);
		const streamId = await ws.ws.open("subscribeServerConfig", {});
		// The connect-time snapshot arrives first.
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
		// And the write landed in the instance file.
		expect((JSON.parse(await readFile(file, "utf8")) as { defaults: { model?: string } }).defaults.model).toBe(good);
	} finally {
		ws?.ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a failed settings write reaches the client as the contract's typed ServerSettingsError, not a defect (M3)", async () => {
	const port = 4933;
	const root = await makeRoot("m3", port);
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connect>> | undefined;
	try {
		expect(await waitListening(port)).toBe(true);
		ws = await connect(port);
		const good = ws.slugs[0]!;
		// Make the registry's write fail: the data dir stops accepting creates, so the temp file cannot be made.
		await chmod(root, 0o500);
		try {
			const answer = await ws.ws.call("server.updateSettings", { patch: { defaultModelSelection: { instanceId: "pi", model: good } } });
			// `exitError` throws on a `Defect` frame: that is exactly the defect this probe names.
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

it("chooseDefaultModel refuses a configured model the catalog does not have (M1, the boot path)", () => {
	const available = [{ provider: "pi", id: "one" }, { provider: "pi", id: "two" }];
	// A configured model the catalog has is used as-is; none configured is the first available.
	expect(chooseDefaultModel(available, { provider: "pi", modelId: "two" })).toEqual({ provider: "pi", modelId: "two" });
	expect(chooseDefaultModel(available, undefined)).toEqual({ provider: "pi", modelId: "one" });
	// A configured model the catalog does not have is a typed refusal naming it and every model that IS available.
	let refusal: unknown;
	try {
		chooseDefaultModel(available, { provider: "pi", modelId: "typo" });
	} catch (error) {
		refusal = error;
	}
	expect(refusal).toBeInstanceOf(ModelNotAvailable);
	const message = (refusal as Error).message;
	expect(message).toContain("pi/typo");
	expect(message).toContain("pi/one");
	expect(message).toContain("pi/two");
	// No models at all keeps its own credential-naming failure.
	expect(() => chooseDefaultModel([], undefined)).toThrow(/no models are available/);
	expect(() => chooseDefaultModel([], { provider: "pi", modelId: "typo" })).toThrow(/no models are available/);
	expect(modelSlug({ provider: "pi", modelId: "one" })).toBe("pi/one");
});
