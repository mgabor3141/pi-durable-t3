// The usage page over the wire. One host, one prompt, then the two usage RPCs the web app sends: `server.getUsageSummary`
// must answer a `pi` bucket that carries the turn's tokens, `server.refreshUsageRates` must answer this host's pricing
// truthfully (no rate table), and an inverted window must come back as T3's typed `UsageReadError` — the shape the UI
// shows. Cost is pi's own; the offline reply model reports no price, so the turn is `unpriced` with real tokens, exactly
// what the page renders as "Unpriced".
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import type { UsageDay, UsageSummary } from "@t3tools/contracts";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-usage-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const dayMs = 86_400_000;
const utcDay = (offsetDays: number): UsageDay => new Date(Date.now() - offsetDays * dayMs).toISOString().slice(0, 10) as UsageDay;

it("server.getUsageSummary answers a pi bucket for a real turn; refreshUsageRates answers honest pricing; a bad window is a typed error", async () => {
	const port = 4940;
	const root = join(scratch, "host");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: projectDir }] }), "utf8");
	const host = launch(root, port, {}, agentDir);
	launched.push(host);
	expect(await waitListening(port), `the host booted: ${host.out()}`).toBe(true);

	const ws = await connectWs(port, await pair(port, pairCode(root)));
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((entry) => entry.models.length > 0);
		expect(provider, `the host's catalog has a model: ${host.out().slice(-400)}`).toBeDefined();

		// A real turn: launch a thread with an initial message and wait for the run to settle.
		const threadId = "usage-thread";
		exitValue(
			await ws.call("orchestration.launchThread", {
				commandId: "cmd-usage-launch",
				threadId,
				projectId: "p-alpha",
				title: "Usage",
				modelSelection: { instanceId: provider!.instanceId, model: provider!.models[0]!.slug },
				runtimeMode: "full-access",
				interactionMode: "default",
				workspaceStrategy: { type: "root" },
				initialMessage: { messageId: "msg-usage", text: "count my tokens", attachments: [] },
			}),
			"launchThread",
		);
		const settled = async (): Promise<boolean> => {
			const projection = exitValue(await ws.call("orchestration.getThreadProjection", { threadId }), "projection") as { runs: { status: string }[] };
			return projection.runs.some((run) => run.status === "completed");
		};
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await settled())) await sleep(250);
		expect(await settled(), `the turn completed: ${host.out().slice(-400)}`).toBe(true);

		// The usage summary the web app asks for (a 30-day window). It must report the turn as a `pi` bucket.
		const summary = exitValue(
			await ws.call("server.getUsageSummary", { sinceDay: utcDay(29), untilDay: utcDay(0), timeZone: "UTC", resolution: "day" }),
			"getUsageSummary",
		) as UsageSummary;
		expect(summary.contractVersion).toBeGreaterThanOrEqual(4);
		expect(summary.sources).toHaveLength(1);
		expect(summary.sources[0]).toMatchObject({ status: "ok" });
		expect(summary.sources[0]!.fingerprint.provider).toBe("pi");
		const piBuckets = summary.buckets.filter((bucket) => bucket.provider === "pi");
		expect(piBuckets.length, `a pi bucket exists: ${JSON.stringify(summary.buckets).slice(0, 400)}`).toBeGreaterThan(0);
		const totalTokens = (t: { uncachedInputTokens: number; cachedInputTokens: number; cacheCreationTokens: number; outputTokens: number }) =>
			t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
		const tokens = piBuckets.reduce((sum, bucket) => sum + totalTokens(bucket.totals), 0);
		expect(tokens, "the turn's tokens are reported").toBeGreaterThan(0);
		expect(piBuckets[0]).toMatchObject({ provider: "pi", records: expect.any(Number), costSource: "unpriced" });

		// Refresh rates: this host has no LiteLLM table (pi prices its own turns) — answered honestly, not refused.
		const pricing = exitValue(await ws.call("server.refreshUsageRates", {}), "refreshUsageRates") as { status: string; knownModels: number };
		expect(pricing).toMatchObject({ status: "unavailable", knownModels: 0 });

		// An inverted window is T3's typed `UsageReadError`, which the client renders as an error line.
		const bad = exitError(await ws.call("server.getUsageSummary", { sinceDay: utcDay(0), untilDay: utcDay(29), timeZone: "UTC", resolution: "day" }), "getUsageSummary bad window");
		expect(bad).toMatchObject({ _tag: "UsageReadError", reason: "invalidWindow" });
	} finally {
		ws.close();
	}
}, 60_000);
