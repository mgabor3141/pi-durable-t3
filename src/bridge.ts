// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. The bridge adds the
// threads layer (named pointers over the Harness's conversations), serves the chord objects on a chord host, and
// speaks T3's wire protocol over HTTP + `/ws`. It decides nothing about the agent: the client names the model it
// sends, the caller hands in the model catalog (picker list only), and per-thread configuration for new threads
// comes from the caller's `newThread` hook — the bridge computes no defaults of its own.
import { createHost } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentChange, Harness } from "@earendil-works/pi-durable";
import { createServerFacet } from "./objects.ts";
import type { ProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { Threads } from "./threads.ts";
import type { BridgeConfig } from "./t3/config.ts";
import { type Logger, nullLogger } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";

export type AttachT3Options = {
	/** The model catalog: T3's picker list and the list `server.refreshProviders` answers. The bridge selects nothing. */
	readonly models: Models;
	/** The project registry (the bridge's own file-backed store; `FileProjectRegistry` is the shipped implementation). */
	readonly projects: ProjectRegistry;
	readonly listen: { readonly host: string; readonly port: number };
	/** Directory for facet state (the auth store's `auth.json`). */
	readonly stateDir: string;
	/** The data dir: T3's server settings (`settings.json`, the UI's document) live here, stored as T3's server stores them. */
	readonly dataDir: string;
	/** Environment name T3 shows. Default `"pi"`. */
	readonly label?: string;
	/** Web app base URL: prints a ready-to-open pairing link and pins CORS to its origin when `corsOrigins` is unset. */
	readonly webAppUrl?: string;
	readonly corsOrigins?: readonly string[];
	/** Bearer-token lifetime, seconds. Default 90 days. */
	readonly tokenTtlSeconds?: number;
	/** Fixed reusable pairing token (tests only; production mints single-use codes). */
	readonly pairingToken?: string;
	/** Configure a newly created thread's conversation (model, prompt text, …). The bridge passes the project's
	 * `cwd` and stores what the hook returns — it interprets nothing. */
	readonly newThread?: (info: { readonly projectId: string; readonly cwd: string }) => AgentChange | undefined;
	readonly log?: Logger;
};

export type T3Attachment = {
	/** Resolves when the facet is listening; rejects with the bind error (e.g. `EADDRINUSE`). */
	readonly ready: Promise<void>;
	/** A fresh single-use pairing code. */
	pairingCode(): string;
	/** `Add environment` links (`http://<host>:<port>/pair#token=<code>`). */
	pairingUrls(code: string): string[];
	close(): Promise<void>;
};

/** The scheme://host:port of a URL, for use as a CORS origin; a non-URL value is used raw, minus a trailing slash. */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url.replace(/\/$/, "");
	}
}

/** Attach T3 to `harness`: the threads layer, the objects facet, a chord host, and the T3 facet. Boot repair and
 * `harness.resume()` run here — finishing interrupted runs is the bridge's crash story. */
export async function attachT3(harness: Harness, options: AttachT3Options): Promise<T3Attachment> {
	const log = options.log ?? nullLogger;
	const threads = new Threads({
		harness,
		registry: options.projects,
		...(options.newThread === undefined ? {} : { newThread: options.newThread }),
		onWarn: (message) => log.warn(message),
	});
	await threads.repair();
	harness.resume();

	const server = createHost({ name: "server" });
	await server.load([createServerFacet(threads, options.models)]);
	await server.ready();

	const catalog = new ModelCatalog(async () => (await options.models.getAvailable()).map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })));
	await catalog.refresh();

	const config: BridgeConfig = {
		registry: options.projects,
		settings: ServerSettingsStore.open(options.dataDir),
		host: options.listen.host,
		port: options.listen.port,
		label: options.label ?? "pi",
		stateDir: options.stateDir,
		pairingToken: options.pairingToken,
		tokenTtlSeconds: options.tokenTtlSeconds ?? 90 * 86_400,
		corsOrigins: options.corsOrigins ?? (options.webAppUrl === undefined ? [] : [originOf(options.webAppUrl)]),
	};
	const facet = startFacet({ host: server, catalog, log, config });
	return {
		ready: facet.ready,
		pairingCode: () => facet.pairingCode(),
		pairingUrls: (code) => facet.pairingUrls(code),
		close: async () => {
			await facet.close();
			await server.close();
		},
	};
}
