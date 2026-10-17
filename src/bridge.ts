// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. Ownership of models and
// projects follows docs/design.md's north star: the bridge computes no defaults of its own.
import { createHost } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { createServerFacet } from "./objects.ts";
import type { ProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { Threads } from "./threads.ts";
import type { BridgeConfig } from "./t3/config.ts";
import { type Logger, nullLogger } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";

/** T3's desktop app origin (its Electron scheme, `t3code://app`). Allowed by default. */
export const DESKTOP_APP_ORIGIN = "t3code://app";

export type AttachT3Options = {
	/** The model catalog: T3's picker list and the list `server.refreshProviders` answers (availability is the Harness's). */
	readonly models: Models;
	/** The project registry (the bridge's own file-backed store; `FileProjectRegistry` is the shipped implementation). */
	readonly projects: ProjectRegistry;
	readonly listen: { readonly host: string; readonly port: number };
	/** Directory for facet state (the auth store's `auth.json`). */
	readonly stateDir: string;
	/** The data dir: T3's `settings.json` and the bridge's `projects.json` live here (state.md). */
	readonly dataDir: string;
	/** Environment name T3 shows. Default `"pi"`. */
	readonly label?: string;
	/** Web app base URL: prints a ready-to-open pairing link, and its origin joins the default CORS list. */
	readonly webAppUrl?: string;
	/** Browser origins allowed to call. Default: the desktop app plus `webAppUrl`. `[]` allows any origin. */
	readonly corsOrigins?: readonly string[];
	/** Bearer-token lifetime, seconds. Default 90 days. */
	readonly tokenTtlSeconds?: number;
	/** Fixed reusable pairing token (tests only; production mints single-use codes). */
	readonly pairingToken?: string;
	readonly log?: Logger;
};

export type T3Attachment = {
	/** Resolves when the facet is listening; rejects with the bind error (e.g. `EADDRINUSE`). */
	readonly ready: Promise<void>;
	/** Resolves when the facet stops serving on its own. Exiting over that is the integrator's policy. */
	readonly closed: Promise<void>;
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
 * `harness.resume()` run here (crash resume: capabilities.md). */
export async function attachT3(harness: Harness, options: AttachT3Options): Promise<T3Attachment> {
	const log = options.log ?? nullLogger;
	const threads = new Threads({
		harness,
		registry: options.projects,
		onWarn: (message) => log.warn(message),
	});
	await threads.repair();
	harness.resume();

	const server = createHost({ name: "server" });
	await server.load([createServerFacet(threads, options.models)]);
	await server.ready();

	const catalog = new ModelCatalog(async () => (await options.models.getAvailable()).map((model) => ({
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		// pi-ai's own rule for which thinking levels a model has — the picker declares exactly these (capabilities.md).
		thinkingLevels: getSupportedThinkingLevels(model),
	})));
	await catalog.refresh();

	const config: BridgeConfig = {
		registry: options.projects,
		settings: ServerSettingsStore.open(options.dataDir),
		host: options.listen.host,
		port: options.listen.port,
		label: options.label ?? "pi",
		stateDir: options.stateDir,
		dataDir: options.dataDir,
		pairingToken: options.pairingToken,
		tokenTtlSeconds: options.tokenTtlSeconds ?? 90 * 86_400,
		corsOrigins: options.corsOrigins ?? [DESKTOP_APP_ORIGIN, ...(options.webAppUrl === undefined ? [] : [originOf(options.webAppUrl)])],
	};
	const facet = startFacet({ host: server, catalog, log, config });
	return {
		ready: facet.ready,
		closed: facet.closed,
		pairingCode: () => facet.pairingCode(),
		pairingUrls: (code) => facet.pairingUrls(code),
		close: async () => {
			await facet.close();
			await server.close();
		},
	};
}
