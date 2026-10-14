// A catalog-absent `defaults.model` must not brick the boot before the bind (review store M2 + wire NEW-R2-1, MEDIUM).
// The instance file (`settings.json`) is the tier the T3 UI edits — its ONLY editor. `main.ts` called
// `chooseDefaultModel(available, registry.defaults().model)` (the boot path) which THREW `ModelNotAvailable` for a
// default the catalog lacks → `main`'s catch printed and exited 1 BEFORE the listener bound. The host is then
// unreachable, and the only recovery is a hand-edit of the file the UI owns. That is the exact shape the tolerant boot
// read of project entries exists to prevent: "a host that dies before its listener binds cannot be told to fix the
// file" (settings.ts).
//
// The catalog is a function of credentials at boot (a rotated provider key, a revoked key, a laptop with no route to
// the gateway, `PI_CODING_AGENT_DIR` pointed elsewhere, a model renamed upstream), so a default the catalog lacks is
// reachable WITHOUT the UI doing anything wrong — it was valid at set-time (the picker validates against the catalog
// of that moment), then the catalog changed under it. The tolerant boot read already handles the same field's other
// spelling (a malformed `no-slash` slug is dropped with a warning); the catalog check was fatal — the strict check the
// wire path needs, applied at boot.
//
// The fix mirrors the entry rule: at BOOT, a catalog-absent default is warned (naming the model + what IS available)
// and DROPPED, new threads fall back to the first catalog model, and the host BINDS. No models at all is still fatal
// (no fallback). The mutation-time check (`server.updateSettings`) stays strict — it refuses a catalog-absent default
// with the contract's typed error (M1), because the UI is reachable there.
//
// Probes, watched failing pre-fix:
//   (a) unit: `chooseDefaultModel(available, configured, onWarn)` — with `onWarn` (the boot) a catalog-absent default
//       warns (naming model + available) and returns the first model; WITHOUT `onWarn` (the write path) it is a fatal
//       `ModelNotAvailable`; "no models at all" is fatal in both.
//   (b) a real host (FAKE model) booted on a hand-written catalog-absent `defaults.model` binds and warns (pre-fix:
//       exits before the bind, no listener), and the effective default is the first catalog model (a thread runs).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { chooseDefaultModel } from "../src/config.ts";
import { ModelNotAvailable } from "../src/t3/model-types.ts";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-bootmodel-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-bootmodel-0123456789";

it("(a) chooseDefaultModel is tolerant at boot (warn + first) and strict at write time (fatal) (M2 / NEW-R2-1)", () => {
	const available = [{ provider: "pi", id: "one" }, { provider: "pi", id: "two" }];
	const missing = { provider: "pi", modelId: "typo" };

	// Boot (onWarn supplied): a catalog-absent default warns naming the model and what IS available, and returns FIRST.
	const warnings: string[] = [];
	const chosen = chooseDefaultModel(available, missing, (message) => warnings.push(message));
	expect(chosen, "the boot falls back to the first catalog model").toEqual({ provider: "pi", modelId: "one" });
	expect(warnings.length, `the boot warned: ${JSON.stringify(warnings)}`).toBe(1);
	expect(warnings[0], "the warning names the refused model").toContain("pi/typo");
	expect(warnings[0], "the warning names what IS available").toContain("pi/one");

	// Write time (no onWarn): the strict, typed refusal is unchanged — the UI is reachable and must be told.
	expect(() => chooseDefaultModel(available, missing), "the write path stays strict").toThrow(ModelNotAvailable);
	// A model the catalog HAS is used verbatim at boot, no warning; none configured is the first.
	const clean: string[] = [];
	expect(chooseDefaultModel(available, { provider: "pi", modelId: "two" }, (m) => clean.push(m))).toEqual({ provider: "pi", modelId: "two" });
	expect(clean, "a catalog-present default warns nothing").toEqual([]);
	expect(chooseDefaultModel(available, undefined, (m) => clean.push(m))).toEqual({ provider: "pi", modelId: "one" });
	expect(clean, "no default configured warns nothing").toEqual([]);
	// No models at all: fatal in both modes (there is no fallback).
	expect(() => chooseDefaultModel([], missing, () => {}), "no models is fatal at boot too").toThrow(/no models are available/);
});

it("(b) a host booted on a catalog-absent defaults.model binds and warns; new threads fall back to a usable model (M2)", async () => {
	const port = 4970;
	const root = join(scratch, "b");
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	// A syntactically-valid, catalog-absent default (the offline demo catalog has one `reply/*` model, not this).
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [{ path: join(root, "projects/alpha"), title: "alpha" }], defaults: { model: "reply/this-model-does-not-exist" } }), "utf8");

	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	let ws: Awaited<ReturnType<typeof connectWs>> | undefined;
	try {
		// Pre-fix: the host exits before binding (exit 1, "model … is not available"). Post-fix: it binds.
		expect(await waitListening(port, 30_000), `the host binds over the bad default: ${host.out()}`).toBe(true);
		const out = host.out();
		expect(out, `the boot warns naming the model: ${out}`).toMatch(/this-model-does-not-exist/);
		expect(out, "the warning is on the boot path, not a fatal exit").toMatch(/not available|dropped|falling back/i);

		// The effective default is a model the host CAN call, so a thread launches and runs (not an interrupted turn).
		ws = await connectWs(port, await pair(port, TOKEN));
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((entry) => (entry.models?.length ?? 0) > 0);
		expect(provider, `the host's catalog has a model: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const modelSelection = { instanceId: provider!.instanceId, model: provider!.models[0]!.slug };
		const projects = exitValue(await ws.call("orchestration.getArchivedShellSnapshot", {}), "shell") as { projects: { id: string }[] };
		const projectId = projects.projects[0]!.id;
		const launchedThread = exitValue(await ws.call("orchestration.launchThread", {
			commandId: "bm-1",
			threadId: "bm-thread",
			projectId,
			title: "bm",
			modelSelection,
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
		}), "launchThread") as { threadId: string };
		expect(launchedThread.threadId).toBe("bm-thread");
	} finally {
		ws?.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);
