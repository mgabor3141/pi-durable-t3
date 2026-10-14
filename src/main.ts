// Entry point: build the Harness (sqlite under the data dir, coding tools, an env builder, a model runtime), wrap it
// in `Threads`, serve the host objects on a chord host, and boot the T3 facet beside them (in-process). Pairing URLs
// print at start. Run: `pnpm start [-- --root <dir>]` (no `--root`: XDG config/data dirs). `PI_DURABLE_T3_FAKE=1` swaps
// in an offline reply model.
import { createHost } from "@earendil-works/chord";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { chooseDefaultModel, ConfigError, loadConfig, resolvePaths } from "./config.ts";
import { ModelNotAvailable } from "./t3/model-types.ts";
import { openHostRuntime } from "./host-runtime.ts";
import { installShutdown } from "./shutdown.ts";
import { createServerFacet } from "./objects.ts";
import { FileProjectRegistry } from "./registry.ts";
import { AuthStore } from "./t3/auth.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";
import type { Logger } from "./t3/logging.ts";
import { createReplyModel } from "./t3/reply-model.ts";

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
	// The instance file (`settings.json`, in the data dir): the project registry and new-thread defaults the T3 UI edits.
	// A missing file is valid — an empty registry, the defaults — and the host writes it on the UI's behalf. The boot
	// read is TOLERANT: an entry the parser refuses (a duplicate id, a duplicate path) is skipped with a warning
	// naming the file, never a crash before the bind — the UI is the only place that can fix the entry.
	const registry = await FileProjectRegistry.open(paths.dataDir, (message) => log.warn(message));
	// One line naming the resolved config file and data dir, so a user sees where the instance reads and writes.
	log.info("pi-durable-t3 config resolved", { config: config.configFile, dataDir: config.dataDir, instance: registry.path });
	const pairingToken = process.env["PI_DURABLE_T3_PAIRING_TOKEN"];
	const bridge = pairingToken === undefined ? { ...config.bridge, registry } : { ...config.bridge, registry, pairingToken };

	// `pnpm start pair --root <dir>`: mint one more pairing code against the running server's auth store.
	if (argv[0] === "pair") {
		const auth = new AuthStore(bridge.stateDir, { tokenTtlSeconds: bridge.tokenTtlSeconds });
		console.log(`Pairing code (single use): ${auth.createPairingCode()}`);
		return;
	}

	let models: Models;
	let available: readonly { provider: string; id: string }[];
	let catalogSource: () => Promise<{ provider: string; modelId: string; name: string }[]>;
	if (process.env["PI_DURABLE_T3_FAKE"] === "1") {
		const reply = createReplyModel();
		models = reply.models;
		catalogSource = async () => reply.catalog;
		available = reply.catalog.map((m) => ({ provider: m.provider, id: m.modelId }));
	} else {
		const runtime = await ModelRuntime.create({ modelsStorePath: config.modelsStorePath });
		models = runtime;
		// `getAvailable()` returns the credentialed models (credentials come from `~/.pi/agent`).
		const credentialed = await runtime.getAvailable();
		available = credentialed.map((m) => ({ provider: m.provider, id: m.id }));
		catalogSource = async () => credentialed.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
	}
	// The new-thread default is validated against the catalog. At BOOT the check is TOLERANT, like the instance file's
	// other fields: a default the catalog cannot call warns naming the model and what IS available, is DROPPED (so new
	// threads fall back to the first catalog model, and the UI can set a good one), and the host BINDS. The instance
	// file is the UI's tier and the UI is its only editor — a host that exits before binding cannot be told to fix it
	// (store M2 / wire NEW-R2-1). "No models at all" is fatal (there is no fallback). At WRITE time the check stays
	// strict (rpc.ts `server.updateSettings` refuses a catalog-absent default with the contract's typed error, M1).
	const defaultModel = chooseDefaultModel(available, registry.defaults().model, (message) => {
		log.warn(message);
		registry.dropModelDefault();
	});

	const runtime = await openHostRuntime(config, registry, models, defaultModel, { onWarn: (message, error) => log.warn(message, { error: String(error) }) });
	const { threads } = runtime;

	const server = createHost({ name: "server" });
	await server.load([createServerFacet(threads, models)]);
	await server.ready();

	const catalog = new ModelCatalog(catalogSource);
	await catalog.refresh();

	const facet = startFacet({ host: server, catalog, log, config: bridge });

	const address = `http://${config.listen.host}:${config.listen.port}`;
	// A failed bind (a port already in use) rejects `ready`. Fail loudly with the address and the error code BEFORE any
	// "ready" line or pairing link: a server that never bound must not look like it started.
	try {
		await facet.ready;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "unknown";
		const detail = (error as Error).message ? ` (${(error as Error).message})` : "";
		console.error(`pi-durable-t3 failed to listen on ${address}: ${code}${detail}`);
		await Promise.allSettled([runtime.close(), server.close()]);
		process.exit(1);
	}

	const projects = registry.list();
	log.info("pi-durable-t3 ready", { address, dataDir: config.dataDir, projects: projects.map((p) => `${p.name}=${p.cwd}`) });
	// An empty instance file is valid and connectable, but a host with no projects cannot make threads — say so, don't
	// leave it a mystery. The UI can add one (the directory picker → "Add project"); the file is written on the UI's behalf.
	if (projects.length === 0) log.warn("no projects configured: the host serves an empty environment and cannot make threads; add one from the T3 UI, or write projects into the instance file settings.json in the data dir");
	// One pairing code per start; codes are shown, never logged.
	const code = facet.pairingCode();
	console.log(`\nPairing code (single use): ${code}`);
	if (config.webAppUrl !== undefined) {
		// The web app reads `host` (the facet) and the token from the fragment.
		console.log(`\n  ${config.webAppUrl.replace(/\/$/, "")}/pair?host=${encodeURIComponent(address)}#token=${code}\n`);
	}
	for (const url of facet.pairingUrls(code)) console.log(`  ${url}\n`);

	// Ctrl-C (SIGINT) or SIGTERM stops the host fast: print "stopping", run the graceful close (facet server, objects
	// host, storage) under a short grace, then exit 0. A close that hangs on an in-flight turn that ignores its abort
	// signal is bounded, and a second signal exits at once. Crash-safety is pi-durable's job: an aborted turn resumes
	// after a restart. Both signals behave the same way. The process stays alive until then on the servers' handles.
	installShutdown(async () => {
		await facet.close();
		await server.close();
		await runtime.close();
	});
}

try {
	await main();
} catch (error) {
	// A bad `config.toml` and a default model the catalog does not have are both user-fixable refusals: print the
	// message and exit 1, never a stack trace.
	if (!(error instanceof ConfigError) && !(error instanceof ModelNotAvailable)) throw error;
	console.error(error.message);
	process.exitCode = 1;
}
