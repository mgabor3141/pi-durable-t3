// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. Ownership of models and
// projects follows docs/design.md's north star: the bridge computes no defaults of its own. Everything an integrator
// needs comes from this file.
import { mkdirSync } from "node:fs";
import { createHost } from "@earendil-works/chord";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { createServerFacet } from "./objects.ts";
import { FileProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { Threads } from "./threads.ts";
import { AuthStore } from "./t3/auth.ts";
import type { BridgeConfig } from "./t3/config.ts";
import { type Logger, nullLogger } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";
import { DEFAULT_TAILSCALE_SERVE_PORT, makeTailscaleCli } from "./t3/tailscale.ts";

/** Thrown (rejected) when a file in the state dir doesn't parse; its message names the file and is meant for the user. */
export { ConfigError } from "./config.ts";
export type { Logger } from "./t3/logging.ts";

/** Tailscale helpers for a host that prints its own links (the example's `pair`): this machine's MagicDNS name, T3's
 * default Serve port, and T3's tailnet URL builder. */
export { readTailscaleMagicDnsName, buildTailscaleHttpsBaseUrl, DEFAULT_TAILSCALE_SERVE_PORT } from "./t3/tailscale.ts";

/** T3's desktop app origin (its Electron scheme, `t3code://app`). Allowed by default. */
export const DESKTOP_APP_ORIGIN = "t3code://app";

/** The default listen address: loopback, T3's own app's port plus one (T3 uses 3773). */
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 3774 } as const;

export type AttachT3Options = {
	/** The model catalog: T3's picker list and the list `server.refreshProviders` answers (availability is the Harness's). */
	readonly models: Models;
	/**
	 * The bridge's state directory, created if missing: it holds `t3-settings.json` (T3's server settings), `projects.json`
	 * (the project registry) and `auth.json` (the pairing store). The bridge opens all three itself and writes them on
	 * the UI's behalf; one host per directory.
	 *
	 * The directory PAIRS with the Harness's storage: the harness's threads point at project ids in this directory's
	 * `projects.json`. Back up and move them together — a mismatched pair (threads, no registry) shows an empty
	 * sidebar; nothing here repairs the combination for you.
	 */
	readonly stateDir: string;
	/**
	 * The Scratch project's ("No project") root — agent work output, NOT bridge state. Omitted: the feature is off,
	 * the config advertises no `scratchWorkspaceRoot` and `projects.ensureScratch` is refused.
	 */
	readonly scratchDir?: string;
	/** Listen address. Default `127.0.0.1:3774`. */
	readonly listen?: { readonly host: string; readonly port: number };
	/** Environment name T3 shows. Default `"pi"`. */
	readonly label?: string;
	/** A built T3 web app's directory, served at `/` (static files, with T3's SPA fallback to `index.html`; the API, `/ws`, `/.well-known`, `/oauth` and `/api` routes win; `/pair` is T3's own pairing page). The web app treats the page origin as its primary environment, so serving it here makes the pi host "This machine" and Settings → Connections works in the browser. Unset: no web app, the API/WS serve the desktop app as before. */
	readonly webApp?: string;
	/** Browser origins allowed to call. Default: T3's desktop app. `[]` allows any origin. A web app served from this host's own origin is same-origin and needs no entry; this list is for a web app served from a foreign origin. */
	readonly corsOrigins?: readonly string[];
	/** Bearer-token lifetime, seconds. Default 90 days. */
	readonly tokenTtlSeconds?: number;
	/**
	 * Publish this host over Tailscale Serve: `tailscale serve --bg --https=<port> http://127.0.0.1:<bound port>`,
	 * armed once the listener is up and released on close, so the app is reachable at
	 * `https://<machine>.<tailnet>.ts.net[:port]` (443 needs no port in the URL). Absent (the default): off — the host
	 * runs no `tailscale` command, advertises no tailnet endpoint, and accepts no tailnet `Host`.
	 *
	 * Like T3, a Serve failure only logs: startup does not depend on Tailscale being installed, logged in, or willing.
	 * Serve forwards to loopback carrying the MagicDNS `Host`, so enabling this is what allows a tailnet `Host` on a
	 * loopback listener (T3 checks no `Host` at all; this guard opens no further, and only while Serve is on).
	 */
	readonly tailscaleServe?: { readonly port?: number };
	readonly log?: Logger;
};

export type T3Attachment = {
	/** Resolves when the facet stops serving on its own. Exiting over that is the integrator's policy. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
};

/** Mint a single-use pairing code for the bridge whose dir you name — no server needed; the running host reads the
 * store on every pairing attempt. Returns the code only: the listen address is the host's, not in `stateDir`, so a host
 * prints the ready-to-open links itself (`pair?token=…` against its own address). */
export function mintPairingCode(stateDir: string): { readonly code: string } {
	return { code: new AuthStore(stateDir, { tokenTtlSeconds: 90 * 86_400 }).createPairingCode() };
}

/** Attach T3 to `harness`: opens the bridge's dir (registry, settings, pairing store), builds the threads layer and
 * the objects facet, and starts the T3 facet. Resolves once the facet is LISTENING; rejects with the bind error
 * (e.g. `EADDRINUSE`) if it cannot. `harness.resume()` is the caller's, after this resolves (crash resume:
 * capabilities.md). */
export async function attachT3(harness: Harness, options: AttachT3Options): Promise<T3Attachment> {
	const log = options.log ?? nullLogger;
	// The bridge owns its dir: mode 0700, it holds the pairing store. A pre-existing dir is tightened.
	mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
	const registry = FileProjectRegistry.open(options.stateDir);
	const threads = new Threads({
		harness,
		registry,
		onWarn: (message) => log.warn(message),
	});

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

	const listen = options.listen ?? DEFAULT_LISTEN;
	const config: BridgeConfig = {
		registry,
		settings: ServerSettingsStore.open(options.stateDir),
		host: listen.host,
		port: listen.port,
		label: options.label ?? "pi",
		stateDir: options.stateDir,
		scratchDir: options.scratchDir,
		tokenTtlSeconds: options.tokenTtlSeconds ?? 90 * 86_400,
		corsOrigins: options.corsOrigins ?? [DESKTOP_APP_ORIGIN],
		staticDir: options.webApp,
		tailscaleServe:
			options.tailscaleServe === undefined
				? undefined
				: { port: options.tailscaleServe.port ?? DEFAULT_TAILSCALE_SERVE_PORT },
	};
	const tailscale = makeTailscaleCli();
	const facet = startFacet({ host: server, catalog, log, config, tailscale });
	// Resolve only once LISTENING: a bind failure (a port in use) rejects here, after the listener's own error —
	// release the objects host, then hand the error to the caller.
	try {
		await facet.ready;
	} catch (error) {
		await server.close();
		throw error;
	}
	// Tailscale Serve, armed only once the listener is up (T3's `layerTailscaleServe` waits for the server address for
	// the same reason). A failure is a warning, never a dead host: T3's own comment on this path is that Serve setup
	// can fail without stopping startup.
	const servePort = config.tailscaleServe?.port;
	let serveArmed: number | undefined;
	if (servePort !== undefined) {
		const localPort = await facet.boundPort;
		try {
			await tailscale.ensureServe({ localPort, servePort, localHost: "127.0.0.1" });
			serveArmed = servePort;
			log.info("Tailscale Serve configured", { localPort, servePort });
		} catch (error) {
			log.warn("Failed to configure Tailscale Serve", {
				localPort,
				servePort,
				error: (error as Error).message || String(error),
			});
		}
	}
	return {
		closed: facet.closed,
		close: async () => {
			// Release our own mapping first, so tailnet traffic stops before the listener does (T3's acquireRelease), and
			// only when we armed it: a mapping this host did not create is not this host's to remove.
			if (serveArmed !== undefined) {
				try {
					await tailscale.disableServe({ servePort: serveArmed });
					log.info("Tailscale Serve disabled", { servePort: serveArmed });
				} catch (error) {
					log.warn("Failed to disable Tailscale Serve", {
						servePort: serveArmed,
						error: (error as Error).message || String(error),
					});
				}
			}
			await facet.close();
			await server.close();
		},
	};
}
