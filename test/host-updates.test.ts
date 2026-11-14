// The host's own updates are T3's provider update. On this host the provider `pi` is the integrator's agent, so its
// version is the host's: the provider's snapshot carries the version that runs, the newest there is, and the command,
// and T3's Update (`server.updateProvider`) installs and restarts. T3 offers that button in the web app and the
// desktop app; its server update (`server.updateServer`) only where a server's T3 version is behind the client's.
import { afterEach, expect, it, vi } from "vitest";
import { HOST_UPDATE_CHECK_MS, HostUpdateWatch, RESTART_AFTER_MS } from "../src/t3/host-updates.ts";
import type { HostUpdates } from "../src/t3/updates-config.ts";
import { ModelCatalog } from "../src/t3/models.ts";

afterEach(() => vi.useRealTimers());

function host(over: Partial<HostUpdates> = {}) {
	const state = { current: "aaa111", latest: "aaa111" as string | undefined, checks: 0, installs: 0, restarts: 0 };
	const updates: HostUpdates = {
		check: async () => {
			state.checks++;
			return { current: state.current, ...(state.latest === undefined ? {} : { latest: state.latest }) };
		},
		install: async () => {
			state.installs++;
			return { version: state.latest ?? state.current, output: "installed\n" };
		},
		restart: () => void state.restarts++,
		command: "docker compose exec harness claw update",
		name: "claw",
		...over,
	};
	const catalog = new ModelCatalog(async () => []);
	let announced = 0;
	catalog.onChange(() => announced++);
	catalog.hostUpdates = new HostUpdateWatch(updates, () => catalog.changed());
	const provider = () => catalog.providers()[0]!;
	return { state, catalog, provider, announced: () => announced };
}

it("the provider's snapshot says the version that runs and the newest; a newer one is T3's update candidate", async () => {
	vi.useFakeTimers();
	const { state, catalog, provider, announced } = host();
	// Before the first answer nothing is claimed of the host: the version is what it is built on.
	expect(provider().versionAdvisory).toBeUndefined();
	expect(provider().version).toMatch(/^pi \d+\.\d+\.\d+$/);

	const stop = catalog.watch();
	await vi.advanceTimersByTimeAsync(0);
	expect(provider().version, "the host's own version, then the pi release").toMatch(/^claw aaa111, pi \d+\.\d+\.\d+$/);
	expect(provider()).toMatchObject({
		versionAdvisory: { status: "current", currentVersion: "aaa111", latestVersion: "aaa111", updateCommand: "docker compose exec harness claw update", canUpdate: true, message: null },
	});
	expect(provider().updateState).toBeUndefined();

	// A newer version appears: found at the hourly check, and announced to the clients that watch.
	state.latest = "bbb222";
	const before = announced();
	await vi.advanceTimersByTimeAsync(HOST_UPDATE_CHECK_MS);
	expect(state.checks).toBe(2);
	expect(announced()).toBeGreaterThan(before);
	// What T3's `isProviderUpdateCandidate` and its one-click check read.
	expect(provider()).toMatchObject({ enabled: true, versionAdvisory: { status: "behind_latest", currentVersion: "aaa111", latestVersion: "bbb222", canUpdate: true } });
	expect(provider().versionAdvisory!.updateCommand).not.toBeNull();

	// A version that cannot be compared (a pinned one): nothing is offered.
	state.latest = undefined;
	await catalog.hostUpdates!.check();
	expect(provider().versionAdvisory).toMatchObject({ status: "current", latestVersion: null });
	stop();
});

it("Update installs, answers, and only then restarts; nothing newer restarts nothing", async () => {
	vi.useFakeTimers();
	const { state, catalog, provider } = host();
	state.latest = "bbb222";
	await catalog.hostUpdates!.check();

	let finish = (): void => {};
	const installing = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const slow = host({
		install: async () => {
			await installing;
			return { version: "bbb222", output: `${"x".repeat(12_000)}tail` };
		},
	});
	slow.state.latest = "bbb222";
	await slow.catalog.hostUpdates!.check();
	const first = slow.catalog.hostUpdates!.update();
	const second = slow.catalog.hostUpdates!.update();
	expect(second, "a second press joins the first").toBe(first);
	expect(slow.provider().updateState).toMatchObject({ status: "running", finishedAt: null });
	finish();
	await first;
	const done = slow.provider().updateState!;
	expect(done).toMatchObject({ status: "succeeded", message: "Version bbb222 is installed. Restarting into it." });
	// In the moment before the restart the provider already names the version it restarts into.
	expect(slow.provider().version).toMatch(/^claw bbb222, /);
	expect(done.output).toHaveLength(10_000);
	expect(done.output!.endsWith("tail")).toBe(true);
	// T3 has its answer; the host restarts a moment later.
	expect(slow.state.restarts).toBe(0);
	await vi.advanceTimersByTimeAsync(RESTART_AFTER_MS);
	expect(slow.state.restarts).toBe(1);

	// Nothing newer: T3's "unchanged", and no restart.
	state.latest = "aaa111";
	await catalog.hostUpdates!.update();
	expect(provider().updateState).toMatchObject({ status: "unchanged", message: "Version aaa111 is the newest." });
	await vi.advanceTimersByTimeAsync(RESTART_AFTER_MS);
	expect(state.restarts).toBe(0);
});

it("a failed install and a failed check are said, not thrown", async () => {
	const broken = host({
		install: async () => {
			throw new Error("version bbb222 needs Node >=26.0.0");
		},
	});
	broken.state.latest = "bbb222";
	await broken.catalog.hostUpdates!.check();
	await broken.catalog.hostUpdates!.update();
	expect(broken.provider().updateState).toMatchObject({ status: "failed", message: "version bbb222 needs Node >=26.0.0" });
	expect(broken.state.restarts).toBe(0);

	let fail = false;
	const offline = host({
		check: async () => {
			if (fail) throw new Error("fetch failed");
			return { current: "aaa111", latest: "aaa111" };
		},
	});
	await offline.catalog.hostUpdates!.check();
	fail = true;
	await offline.catalog.hostUpdates!.check();
	// The version that runs is still known; what is newest is not.
	expect(offline.provider().versionAdvisory).toMatchObject({ status: "unknown", currentVersion: "aaa111", message: "Could not look for a newer version: fetch failed" });
});

// Over the wire, against T3's own schemas: what a client decodes, and the events it is pushed.
it("over /ws: the provider carries the advisory, Update answers T3's provider payload, and the host restarts after it", async () => {
	const { join } = await import("node:path");
	const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
	const Schema = await import("effect/Schema");
	const { ServerConfig, ServerConfigStreamEvent, ServerProviderUpdatedPayload } = await import("@t3tools/contracts");
	const { attachT3, mintPairingCode } = await import("../src/bridge.ts");
	const { connectWs, exitValue, pair, waitListening } = await import("./ws-rpc.ts");
	const { makeThreads } = await import("./threads-harness.ts");
	const PORT = 4973;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	type Provider = { version: string; versionAdvisory?: { status: string; latestVersion: string | null }; updateState?: { status: string; message: string | null } };

	const f = await makeThreads({ projects: [{ id: "p" }] });
	const stateDir = join(f.root, "t3-state");
	const state = { latest: "bbb222", restarts: 0 };
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir,
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		updates: {
			check: async () => ({ current: "aaa111", latest: state.latest }),
			install: async () => ({ version: state.latest, output: "installed bbb222\n" }),
			restart: () => void state.restarts++,
			command: "claw update",
			name: "claw",
		},
	});
	try {
		expect(await waitListening(PORT)).toBe(true);
		const ws = await connectWs(PORT, await pair(PORT, mintPairingCode(stateDir).code));
		try {
			let config: { providers: Provider[] } | undefined;
			for (let i = 0; i < 60; i++) {
				config = exitValue(await ws.call("server.getConfig", {}), "server.getConfig") as { providers: Provider[] };
				if (config.providers[0]!.versionAdvisory !== undefined) break;
				await sleep(50);
			}
			expect(() => Schema.decodeUnknownSync(ServerConfig)(config)).not.toThrow();
			expect(config!.providers[0]).toMatchObject({ versionAdvisory: { status: "behind_latest", currentVersion: "aaa111", latestVersion: "bbb222" } });
			// The integrator's version, then what the host is built on: pi's release and the pinned T3 release.
			expect(config!.providers[0]!.version).toMatch(/^claw aaa111, pi \d+\.\d+\.\d+, t3 \d+\.\d+\.\d+$/);

			const stream = await ws.open("subscribeServerConfig", {});
			const seen = () => ws.chunks(stream).flatMap((frame) => (frame.values ?? []) as { type: string; payload?: { providers: Provider[] } }[]);
			for (let i = 0; i < 60 && seen().length === 0; i++) await sleep(50);
			const answer = exitValue(await ws.call("server.updateProvider", { provider: "pi", instanceId: "pi" }), "server.updateProvider") as { providers: Provider[] };
			expect(() => Schema.decodeUnknownSync(ServerProviderUpdatedPayload)(answer)).not.toThrow();
			expect(answer.providers[0]!.updateState).toMatchObject({ status: "succeeded", message: "Version bbb222 is installed. Restarting into it." });
			expect(state.restarts, "not before the answer").toBe(0);
			for (let i = 0; i < 60 && state.restarts === 0; i++) await sleep(50);
			expect(state.restarts).toBe(1);

			// The watchers saw it run and end, in events that decode.
			const events = seen();
			for (const event of events) expect(() => Schema.decodeUnknownSync(ServerConfigStreamEvent)(event)).not.toThrow();
			expect(events.filter((event) => event.type === "providerStatuses").map((event) => event.payload!.providers[0]!.updateState?.status)).toEqual(["running", "succeeded"]);

			// Another provider's update is not this host's to run.
			const other = await ws.call("server.updateProvider", { provider: "codex" });
			expect(JSON.stringify(other)).toContain("This host does not update itself from T3");
		} finally {
			ws.close();
		}
	} finally {
		await t3.close();
	}
}, 60_000);
