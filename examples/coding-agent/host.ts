// The example host: build a coding-agent Harness (sqlite under the data dir, coding tools, a prompt extension, an
// env builder, a model runtime from your pi credentials), attach the T3 bridge, print pairing URLs. This file is
// the integrator's — the bridge itself is `attachT3` in `src/bridge.ts`.
// Run: `pnpm start [-- --root <dir>]` (no `--root`: XDG config/data dirs). `PI_DURABLE_T3_FAKE=1` swaps in an
// offline reply model.
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai";
import { attachT3 } from "../../src/bridge.ts";
import { ConfigError, loadConfig, resolvePaths } from "./config.ts";
import { CodingExtension } from "./base-prompt.ts";
import { openCodingHarness } from "./host-runtime.ts";
import { installShutdown } from "./shutdown.ts";
import { FileProjectRegistry } from "../../src/registry.ts";
import { AuthStore } from "../../src/t3/auth.ts";
import type { Logger } from "../../src/t3/logging.ts";
import { createReplyModel } from "./reply-model.ts";

const log: Logger = {
	info: (message, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", message, ...fields })),
	warn: (message, fields) => console.log(JSON.stringify({ t: new Date().toISOString(), level: "warn", message, ...fields })),
};

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	// `pnpm start -- pair …` forwards a leading `--` (pnpm does not strip it before a subcommand); drop any leading `--`
	// so `pair` is seen as the subcommand. The Run form (`pnpm start -- --root R`) is unaffected.
	while (argv[0] === "--") argv.shift();
	const paths = resolvePaths(argv);
	const config = await loadConfig(paths.configFile, paths.dataDir);
	// The project registry (`projects.json`, in the data dir): what the T3 UI edits, written by the running host on
	// the UI's behalf. A missing file is valid — an empty registry; an unparseable one is a refusal naming it.
	const registry = FileProjectRegistry.open(paths.dataDir);
	// One line naming the resolved config file and data dir, so a user sees where the instance reads and writes.
	log.info("pi-durable-t3 config resolved", { config: config.configFile, dataDir: config.dataDir, projects: registry.path });
	const pairingToken = process.env["PI_DURABLE_T3_PAIRING_TOKEN"];

	// `pnpm start pair --root <dir>`: mint one more pairing code against the running server's auth store.
	if (argv[0] === "pair") {
		const auth = new AuthStore(config.stateDir, { tokenTtlSeconds: config.tokenTtlSeconds });
		console.log(`Pairing code (single use): ${auth.createPairingCode()}`);
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

	const runtime = await openCodingHarness(config, registry, models, {
		onWarn: (message, error) => log.warn(message, { error: String(error) }),
		// The prompt: a coding-agent base section, plus the optional instructions file as another section.
		extensions: [CodingExtension(config.instructionsPath)],
	});
	const attach = await attachT3(runtime.harness, {
		models,
		projects: registry,
		dataDir: config.dataDir,
		listen: config.listen,
		stateDir: config.stateDir,
		label: config.label,
		...(config.webAppUrl === undefined ? {} : { webAppUrl: config.webAppUrl }),
		...(config.corsOrigins === undefined ? {} : { corsOrigins: config.corsOrigins }),
		tokenTtlSeconds: config.tokenTtlSeconds,
		...(pairingToken === undefined ? {} : { pairingToken }),
		log,
	});

	const address = `http://${config.listen.host}:${config.listen.port}`;
	// A failed bind (a port already in use) rejects `ready`. Fail loudly with the address and the error code BEFORE any
	// "ready" line or pairing link: a server that never bound must not look like it started.
	try {
		await attach.ready;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		const detail = (error as Error).message ? ` (${(error as Error).message})` : "";
		console.error(`pi-durable-t3 failed to listen on ${address}: ${code}${detail}`);
		await Promise.allSettled([attach.close(), runtime.close()]);
		process.exit(1);
	}

	// A facet that stops serving on its own cannot answer a paired client again. That is fatal for this host, and
	// the policy is the host's: say so and exit non-zero, leaving the supervisor to restart it.
	void attach.closed.then(() => process.exit(1));

	const projects = registry.list();
	log.info("pi-durable-t3 ready", { address, dataDir: config.dataDir, projects: projects.map((p) => `${p.name}=${p.cwd}`) });
	// An empty registry is valid and connectable, but a host with no projects cannot make threads — say so, don't
	// leave it a mystery. The UI can add one (the directory picker → "Add project"); the file is written on the UI's behalf.
	if (projects.length === 0) log.warn("no projects yet: add one from the T3 UI (Add project)");
	// One pairing code per start; codes are shown, never logged.
	const code = attach.pairingCode();
	console.log(`\nPairing code (single use): ${code}`);
	if (config.webAppUrl !== undefined) {
		// The web app reads `host` (the facet) and the token from the fragment.
		console.log(`\n  ${config.webAppUrl.replace(/\/$/, "")}/pair?host=${encodeURIComponent(address)}#token=${code}\n`);
	}
	for (const url of attach.pairingUrls(code)) console.log(`  ${url}\n`);

	// Ctrl-C (SIGINT) or SIGTERM stops the host fast: print "stopping", run the graceful close (facet, objects
	// host, storage) under a short grace, then exit 0. A close that hangs on an in-flight turn that ignores its abort
	// signal is bounded, and a second signal exits at once. Crash-safety is pi-durable's job: an aborted turn resumes
	// after a restart. Both signals behave the same way. The process stays alive until then on the servers' handles.
	installShutdown(async () => {
		await attach.close();
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
