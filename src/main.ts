// Entry point: build the Harness (sqlite under the env root, coding tools, an env builder, a model runtime), wrap it
// in `Threads`, serve the host objects on a chord host, and boot the T3 facet beside them (in-process). Pairing URLs
// print at start. Run: `pnpm start [-- --root <dir>]`. `PI_DURABLE_T3_FAKE=1` swaps in an offline reply model.
import { createHost } from "@earendil-works/chord";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { chooseDefaultModel, ConfigError, loadHostConfig, rootFromArgv } from "./config.ts";
import { openHostRuntime } from "./host-runtime.ts";
import { createServerFacet } from "./server-facet.ts";
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
	const root = rootFromArgv(argv);
	const config = await loadHostConfig(root);
	const pairingToken = process.env["PI_DURABLE_T3_PAIRING_TOKEN"];
	const bridge = pairingToken === undefined ? config.bridge : { ...config.bridge, pairingToken };

	// `pnpm start pair --root <dir>`: mint one more pairing code against the running server's auth store.
	if (argv[0] === "pair") {
		const auth = new AuthStore(bridge.stateDir, { tokenTtlSeconds: bridge.tokenTtlSeconds });
		console.log(`Pairing code (single use): ${auth.createPairingCode()}`);
		return;
	}

	let models: Models;
	let defaultModel: ModelRef;
	let catalogSource: () => Promise<{ provider: string; modelId: string; name: string; reasoning: boolean }[]>;
	if (process.env["PI_DURABLE_T3_FAKE"] === "1") {
		const reply = createReplyModel();
		models = reply.models;
		defaultModel = reply.modelRef;
		catalogSource = async () => reply.catalog;
	} else {
		const runtime = await ModelRuntime.create({ modelsStorePath: config.modelsStorePath });
		models = runtime;
		// `getAvailable()` returns the credentialed models (credentials come from `~/.pi/agent`).
		const available = await runtime.getAvailable();
		catalogSource = async () => available.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, reasoning: m.reasoning }));
		// `unset → first available`, but fail at start (a clear, credential-naming message) when there is nothing to pick.
		defaultModel = chooseDefaultModel(available, config.defaultModel);
	}

	const runtime = await openHostRuntime(config, models, defaultModel, { onWarn: (message, error) => log.warn(message, { error: String(error) }) });
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

	log.info("pi-durable-t3 ready", { address, root: config.root, projects: config.projects.map((p) => `${p.name}=${p.cwd}`) });
	// An empty `host.toml` is valid and connectable, but a host with no projects cannot make threads — say so, don't leave it a mystery.
	if (config.projects.length === 0) log.warn("no projects configured: the host serves an empty environment and cannot make threads; add [[projects]] to host.toml");
	// One pairing code per start; codes are shown, never logged.
	const code = facet.pairingCode();
	console.log(`\nPairing code (single use): ${code}`);
	if (config.webAppUrl !== undefined) {
		// The web app reads `host` (the facet) and the token from the fragment.
		console.log(`\n  ${config.webAppUrl.replace(/\/$/, "")}/pair?host=${encodeURIComponent(address)}#token=${code}\n`);
	}
	for (const url of facet.pairingUrls(code)) console.log(`  ${url}\n`);

	// Ctrl-C (SIGINT) or SIGTERM stops the host: closing the facet interrupts its server fiber (releasing the port),
	// then the objects host and storage are closed and the process exits. Both signals behave the same way.
	await new Promise<void>((resolve) => {
		for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
	});
	await facet.close();
	await server.close();
	await runtime.close();
}

try {
	await main();
} catch (error) {
	if (!(error instanceof ConfigError)) throw error;
	console.error(error.message);
	process.exitCode = 1;
}
