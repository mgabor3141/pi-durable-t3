// The example host: build a coding-agent Harness (sqlite under the data dir, coding tools, a prompt extension, an
// env builder, a model runtime from your pi credentials), attach the T3 bridge, listen. Pairing is out of band:
// `pnpm start pair` mints a code with `mintPairingCode` against the state dir. This file is the integrator's — the
// bridge itself is `attachT3` in `src/bridge.ts`.
// Run: `pnpm start [-- --root <dir>]` (no `--root`: XDG config/data dirs). `PI_DURABLE_T3_FAKE=1` swaps in an
// offline reply model.
import { networkInterfaces } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Models } from "@earendil-works/pi-ai";
import { attachT3, type Logger, mintPairingCode } from "../../../src/bridge.ts";
import { ConfigError, loadConfig, resolvePaths } from "./config.ts";
import { CodingExtension } from "./base-prompt.ts";
import { openCodingHarness } from "./host-runtime.ts";
import { installShutdown } from "./shutdown.ts";
import { createReplyModel } from "./reply-model.ts";
import { titleThread } from "./title.ts";

const log: Logger = {
	info: (message, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", message, ...fields })),
	warn: (message, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "warn", message, ...fields })),
};

/** `PI_DURABLE_T3_RPC_LOG=1` or `all`: one line per T3 RPC call; `errors`: failures and stubbed methods only.
 * Off by default. */
const rpcLogMode = process.env["PI_DURABLE_T3_RPC_LOG"];
const rpcLog = rpcLogMode === undefined || rpcLogMode === "0" || rpcLogMode === ""
	? undefined
	: {
		...(rpcLogMode === "errors" || rpcLogMode === "failures" ? {} : { onSuccess: (call: { method: string; kind: string; durationMs: number }) => log.info("rpc call", { ...call }) }),
		onFailure: (call: { method: string; kind: string; durationMs: number; error: string }) => log.warn("rpc call failed", { ...call }),
		onStubbed: (call: { method: string; kind: string; reason: string; durationMs: number }) => log.warn("rpc not implemented", { ...call }),
	};

/** Pairing links for a minted code (the `/pair#token=` form T3's web page and desktop app both parse). A wildcard
 * bind is spelled out per LAN address, so every printed link opens. */
function pairingLinks(code: string, listen: { host: string; port: number }): string[] {
	const hosts =
		listen.host === "0.0.0.0" || listen.host === "::"
			? Object.values(networkInterfaces())
					.flat()
					.filter((n) => n !== undefined && n.family === "IPv4" && !n.internal)
					.map((n) => n!.address)
			: [listen.host];
	return hosts.map((h) => `http://${h}:${listen.port}/pair#token=${code}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	// `pnpm start -- pair …` forwards a leading `--` (pnpm does not strip it before a subcommand); drop any leading `--`
	// so `pair` is seen as the subcommand. The Run form (`pnpm start -- --root R`) is unaffected.
	while (argv[0] === "--") argv.shift();
	const paths = resolvePaths(argv);
	const config = await loadConfig(paths.configFile, paths.dataDir);

	// `pnpm start pair --root <dir>`: mint one more pairing code against the state dir's auth store and exit. The
	// running host reads the store on every pairing attempt, so no restart is involved.
	if (argv[0] === "pair") {
		const { code } = mintPairingCode(config.stateDir);
		console.log(`Pairing code (single use): ${code}`);
		const links = pairingLinks(code, config.listen);
		// The links double as the `/pair` page a browser opens; the desktop app parses the token from the link itself.
		console.log("\n  Open in a browser (pairs and opens the web app), or paste into the T3 desktop app's Add computer:");
		for (const link of links) console.log(`  ${link}\n`);
		return;
	}

	let models: Models;
	if (process.env["PI_DURABLE_T3_FAKE"] === "1") {
		models = createReplyModel().models;
	} else {
		const runtime = await ModelRuntime.create({ modelsStorePath: config.modelsStorePath });
		// `getAvailable()` returns the credentialed models (credentials come from `~/.pi/agent`). No credentials at all
		// is a fatal, credential-naming refusal: the host has nothing to answer with.
		if ((await runtime.getAvailable()).length === 0)
			throw new ConfigError("no models are available: add provider credentials under ~/.pi/agent (or set PI_CODING_AGENT_DIR), or run with PI_DURABLE_T3_FAKE=1 for the offline demo model");
		models = runtime;
	}

	const runtime = await openCodingHarness(config, models, {
		onWarn: (message, error) => log.warn(message, { error: String(error) }),
		// The prompt: a coding-agent base section, plus the optional instructions file as another section.
		extensions: [CodingExtension(config.instructionsPath)],
	});

	const address = `http://${config.listen.host}:${config.listen.port}`;
	// `attachT3` opens the state dir (registry, settings, pairing store) and resolves only once LISTENING; a failed
	// bind (a port already in use) rejects here. Fail loudly with the address and the error code BEFORE any "ready"
	// line: a server that never bound must not look like it started.
	let t3;
	try {
		t3 = await attachT3(runtime.harness, {
			models,
			stateDir: config.stateDir,
			env: new NodeExecutionEnv({ cwd: "/" }),
			scratchDir: config.scratchDir,
			attachmentsDir: config.attachmentsDir,
			listen: config.listen,
			label: config.label,
			...(config.corsOrigins === undefined ? {} : { corsOrigins: config.corsOrigins }),
			tokenTtlSeconds: config.tokenTtlSeconds,
			// Thread titles: one tool-less completion on the thread's model (./title.ts).
			titleThread: titleThread(runtime.harness, models),
			...(rpcLog === undefined ? {} : { rpcLog }),
			log,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		const detail = (error as Error).message ? ` (${(error as Error).message})` : "";
		console.error(`pi-durable-t3 failed to listen on ${address}: ${code}${detail}`);
		await runtime.close();
		process.exit(1);
	}

	// The thread tools (`thread_prompt` and the rest, with T3's scheduled-task tools): a conversation that is a thread's
	// head acts as that thread. Installed once the bridge exists, before anything resumes.
	runtime.registry.install(t3.threadTools());

	// Crash resume: the caller resumes the harness, AFTER the attach resolved (an interrupted run resumes on its own;
	// capabilities.md).
	runtime.harness.resume();

	// A facet that stops serving on its own cannot answer a paired client again. That is fatal for this host, and
	// the policy is the host's: say so and exit non-zero, leaving the supervisor to restart it.
	void t3.closed.then(() => process.exit(1));

	// One line naming the resolved config, data dir, and state dir, so a user sees where the instance reads and
	// writes. The state dir pairs with the harness storage: back them up and move them together.
	log.info("pi-durable-t3 ready", { address, dataDir: config.dataDir, stateDir: config.stateDir });
	// Pairing codes are minted on demand, never printed at start.
	console.log(`\n  Run \`pnpm start pair\` to add a device.\n`);

	// Ctrl-C (SIGINT) or SIGTERM stops the host fast: print "stopping", run the graceful close (facet, objects
	// host, storage) under a short grace, then exit 0. A close that hangs on an in-flight turn that ignores its abort
	// signal is bounded, and a second signal exits at once. Crash-safety is pi-durable's job: an aborted turn resumes
	// after a restart. Both signals behave the same way. The process stays alive until then on the servers' handles.
	installShutdown(async () => {
		await t3.close();
		await runtime.close();
	});
}

try {
	await main();
} catch (error) {
	// A bad `config.toml` is a user-fixable refusal: print the message and exit 1, never a stack trace.
	if (!(error instanceof ConfigError)) throw error;
	console.error(error.message);
	process.exitCode = 1;
}
