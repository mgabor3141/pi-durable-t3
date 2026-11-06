// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. Ownership of models and
// projects follows docs/design.md's north star: the bridge computes no defaults of its own. Everything an integrator
// needs comes from this file.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import { ProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { Threads } from "./threads.ts";
import { AuthStore } from "./t3/auth.ts";
import type { BridgeConfig } from "./t3/config.ts";
import type { PreviewBrowserConfig } from "./t3/preview-config.ts";
import type { Page } from "playwright-core";
import type { TitleThread } from "./t3/title-thread.ts";
import { type Logger, nullLogger, type RpcLog } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";
import { DEFAULT_TAILSCALE_SERVE_PORT, makeTailscaleCli, type TailscaleCommandError } from "./t3/tailscale.ts";

/** Thrown (rejected) when a file in the state dir doesn't parse; its message names the file and is meant for the user. */
export { ConfigError } from "./config.ts";
export type { Logger, RpcCall, RpcCallFailure, RpcCallStub, RpcLog } from "./t3/logging.ts";
export type { TitleThread, TitleThreadRequest } from "./t3/title-thread.ts";

/** T3's desktop app origin (its Electron scheme, `t3code://app`). Allowed by default. */
export const DESKTOP_APP_ORIGIN = "t3code://app";

/** The default listen address: loopback, T3's own app's port plus one (T3 uses 3773). */
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 3774 } as const;

/** The package's `web/` directory (T3's built web app, filled by `pnpm setup:t3`): `../web` from both `src/` and `dist/`. `undefined` when it is missing. */
function bundledWebApp(): string | undefined {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
	return existsSync(join(dir, "index.html")) ? dir : undefined;
}

export type AttachT3Options = {
	/** The model catalog: T3's picker list and the list `server.refreshProviders` answers (availability is the Harness's). */
	readonly models: Models;
	/**
	 * The bridge's state directory, created if missing: it holds `t3-settings.json` (T3's server settings), `auth.json`
	 * (the pairing store) and `attachments/`. The bridge opens them itself and writes them on the UI's behalf; one host
	 * per directory. Threads and projects live in the Harness's own storage.
	 */
	readonly stateDir: string;
	/**
	 * The environment T3 works in. Its `cwd` is the root of every absolute path in the protocol: projects, scratch,
	 * the file panel, the picker and scripts. The environment is the boundary; there is no host-filesystem fallback.
	 */
	readonly env: ExecutionEnv;
	/** Invocation context for environment calls. Default: `BACKGROUND_CONTEXT`. */
	readonly context?: Context;
	/**
	 * The Scratch project's ("No project") root — agent work output, NOT bridge state. Omitted: the feature is off,
	 * the config advertises no `scratchWorkspaceRoot` and `projects.ensureScratch` is refused.
	 */
	readonly scratchDir?: string;
	/** Listen address. Default `127.0.0.1:3774`. */
	readonly listen?: { readonly host: string; readonly port: number };
	/** Environment name T3 shows. Default `"pi"`. */
	readonly label?: string;
	/** A built T3 web app's directory, served at `/`. Default: the T3 web app shipped in this package (`web/`). Set `webApp` to serve a different build. Static files, with T3's SPA fallback to `index.html`; the API, `/ws`, `/.well-known`, `/oauth` and `/api` routes win; `/pair` is T3's own pairing page. The web app treats the page origin as its primary environment, so serving it here makes the pi host "This machine" and Settings → Connections works in the browser. */
	readonly webApp?: string;
	/** Browser origins allowed to call. Default: T3's desktop app. `[]` allows any origin. A web app served from this host's own origin is same-origin and needs no entry; this list is for a web app served from a foreign origin. */
	readonly corsOrigins?: readonly string[];
	/** Bearer-token lifetime, seconds. Default 90 days. */
	readonly tokenTtlSeconds?: number;
	/**
	 * Publish this host over Tailscale Serve: `tailscale serve --bg --https=<port> http://127.0.0.1:<bound port>`,
	 * armed once the listener is up and released on close, so the app is reachable at
	 * `https://<machine>.<tailnet>.ts.net[:port]` (443 needs no port in the URL). Absent (the default): off.
	 *
	 * A Serve failure only warns: startup never depends on Tailscale. Before arming, the host reads
	 * `tailscale serve status` and refuses to arm an HTTPS port that already maps elsewhere — unlike T3, which arms
	 * unconditionally and would take over (and later remove) a mapping another process created. Serve forwards to
	 * loopback carrying the machine's MagicDNS `Host`; the host checks no `Host` header (like T3), so a forwarded
	 * request reaches the same routes and the same credential check as any other.
	 */
	readonly tailscaleServe?: { readonly port?: number };
	/**
	 * Title generation, delegated to you (T3's `ThreadTitleRegenerationService`). Called once a thread's first user
	 * entry is committed (not after the reply) and on "Regenerate title"; resolve with a title, or `undefined` / "New
	 * thread" (/ the same title on regenerate) for no change. `signal` aborts when a rename or a newer request supersedes
	 * the call; a late result is ignored either way. A rejection is logged as a warning and changes nothing. Absent: the
	 * first message's seed and renames still work, and "Regenerate title" is refused.
	 */
	readonly titleThread?: TitleThread;
	/** A Chromium CDP endpoint for T3's server preview panel. Absent: `preview.*` stays unsupported. */
	readonly preview?: PreviewBrowserConfig;
	/**
	 * Optional per-call observation for debugging the T3 wire: `onSuccess` for a request handler that succeeds or a
	 * stream that opens, `onFailure` for a failing request, and `onStubbed` for a method this host does not implement.
	 * The callbacks run synchronously and their exceptions are caught and logged, so a debug sink never breaks a call.
	 */
	readonly rpcLog?: RpcLog;
	readonly log?: Logger;
};

/** The page an agent drives in T3; the page is the one T3 streams to the user. */
export type AgentPreviewSession = {
	readonly id: string;
	readonly page: Page;
	touch(): void;
	close(): Promise<void>;
};

export type T3Attachment = {
	/** Resolves when the facet stops serving on its own. Exiting over that is the integrator's policy. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
	/** Rename a thread, as a user rename in T3 does: durable, and it cancels a pending title generation. */
	setTitle(threadId: string, title: string): Promise<void>;
	/**
	 * A T3-visible preview page for an agent conversation, when the preview browser is configured and the conversation
	 * is a thread's head. The page is the one T3 streams to the user; `undefined` falls back to a private browser.
	 */
	readonly previewBrowser?: {
		open(conversationId: number, url: string): Promise<AgentPreviewSession | undefined>;
	};
};

/** Mint a single-use pairing code for the bridge whose dir you name — no server needed; the running host reads the
 * store on every pairing attempt. Returns the code only: the listen address is the host's, not in `stateDir`, so a host
 * prints the ready-to-open links itself (`pair?token=…` against its own address). */
export function mintPairingCode(stateDir: string): { readonly code: string } {
	return { code: new AuthStore(stateDir, { tokenTtlSeconds: 90 * 86_400 }).createPairingCode() };
}

/** Attach T3 to `harness`: opens the bridge's dir (registry, settings, pairing store), builds the threads layer and
 * starts the T3 facet. Resolves once the facet is LISTENING; rejects with the bind error
 * (e.g. `EADDRINUSE`) if it cannot. `harness.resume()` is the caller's, after this resolves (crash resume:
 * capabilities.md). */
export async function attachT3(harness: Harness, options: AttachT3Options): Promise<T3Attachment> {
	const log = options.log ?? nullLogger;
	// The bridge owns its dir: mode 0700, it holds the pairing store. A pre-existing dir is tightened.
	mkdirSync(options.stateDir, { recursive: true, mode: 0o700 });
	const registry = new ProjectRegistry(harness, { baseDir: options.stateDir });
	const threads = new Threads({
		harness,
		registry,
		env: options.env,
		...(options.context === undefined ? {} : { context: options.context }),
		onWarn: (message) => log.warn(message),
	});
	// The projects and threads are read once, before anything is served: a store this version cannot read stops the host here.
	try {
		await registry.load();
		await threads.load();
	} catch (error) {
		throw new Error(`pi-durable-t3: cannot read the threads in this Harness's storage (${error instanceof Error ? error.message : String(error)}). A store written by an earlier version is migrated by hand.`, { cause: error });
	}

	const catalog = new ModelCatalog(async () => (await options.models.getAvailable()).map((model) => ({
		provider: model.provider,
		modelId: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		// pi-ai's own rule for which thinking levels a model has — the picker declares exactly these (capabilities.md).
		thinkingLevels: getSupportedThinkingLevels(model),
	})));
	await catalog.refresh();

	const listen = options.listen ?? DEFAULT_LISTEN;
	const webApp = options.webApp ?? bundledWebApp();
	if (webApp === undefined) log.warn("no web app to serve (`web/` is missing; in a checkout, run `pnpm setup:t3`)");
	const config: BridgeConfig = {
		registry,
		settings: ServerSettingsStore.open(options.stateDir),
		host: listen.host,
		port: listen.port,
		label: options.label ?? "pi",
		stateDir: options.stateDir,
		env: options.env,
		...(options.context === undefined ? {} : { context: options.context }),
		scratchDir: options.scratchDir,
		tokenTtlSeconds: options.tokenTtlSeconds ?? 90 * 86_400,
		corsOrigins: options.corsOrigins ?? [DESKTOP_APP_ORIGIN],
		staticDir: webApp,
		...(options.titleThread === undefined ? {} : { titleThread: options.titleThread }),
		tailscaleServe:
			options.tailscaleServe === undefined
				? undefined
				: { port: options.tailscaleServe.port ?? DEFAULT_TAILSCALE_SERVE_PORT },
		...(options.preview === undefined ? {} : { preview: options.preview }),
		...(options.rpcLog === undefined ? {} : { rpcLog: options.rpcLog }),
	};
	const tailscale = makeTailscaleCli();
	const facet = startFacet({ threads, models: options.models, catalog, log, config, tailscale });
	// Resolve only once LISTENING: a bind failure (a port in use) rejects here, after the listener's own error.
	await facet.ready;
	// Tailscale Serve, armed only once the listener is up. A failure is a warning, never a dead host (T3's rule for
	// this path). Safety check first — a deliberate, safer-than-T3 deviation: only a free port, or one already pointed
	// at this host's own loopback port (a stale mapping of ours), is armed. A mapping this host did not create is
	// never taken over, and so never removed on close. A status read that fails (no CLI, logged out) is fail-closed.
	const servePort = config.tailscaleServe?.port;
	let serveArmed: number | undefined;
	if (servePort !== undefined) {
		const localPort = await facet.ready;
		const isOwnTarget = (target: string) =>
			target === `http://127.0.0.1:${String(localPort)}` || target === `http://localhost:${String(localPort)}`;
		try {
			const targets = await tailscale.readServeTargets({ servePort });
			if (targets !== null && !targets.every(isOwnTarget)) {
				log.warn(
					`Tailscale Serve HTTPS port ${String(servePort)} already maps to ${targets.length > 0 ? targets.join(", ") : "a mapping this host cannot read"}; not arming. Pick another tailscale_serve_port.`,
					{ servePort, localPort },
				);
			} else {
				await tailscale.ensureServe({ localPort, servePort, localHost: "127.0.0.1" });
				serveArmed = servePort;
				log.info("Tailscale Serve configured", { localPort, servePort });
			}
		} catch (error) {
			log.warn("Failed to configure Tailscale Serve", {
				localPort,
				servePort,
				error: (error as Error).message || String(error),
				...serveDiagnostic(error),
			});
		}
	}
	return {
		closed: facet.closed,
		setTitle: (threadId, title) => facet.setTitle(threadId, title),
		...(facet.preview === undefined
			? {}
			: {
				previewBrowser: {
					open: async (conversationId: number, url: string) => {
						const threadId = await threads.threadIdForConversation(conversationId);
						return threadId === undefined ? undefined : facet.preview!.openAgentSession(threadId, url);
					},
				},
			}),
		close: async () => {
			// Release our own mapping first, so tailnet traffic stops before the listener does (T3's acquireRelease
			// order). Only an armed port is released: the status check above guarantees an armed mapping is ours.
			if (serveArmed !== undefined) {
				try {
					await tailscale.disableServe({ servePort: serveArmed });
					log.info("Tailscale Serve disabled", { servePort: serveArmed });
				} catch (error) {
					log.warn("Failed to disable Tailscale Serve", {
						servePort: serveArmed,
						error: (error as Error).message || String(error),
						...serveDiagnostic(error),
					});
				}
			}
			await facet.close();
		},
	};
}

/** The safe, named classification a `TailscaleCommandError` carries — warnings log it, never the stderr itself. */
function serveDiagnostic(error: unknown): { diagnostic: string } | Record<string, never> {
	const diagnostic = (error as TailscaleCommandError).stderrDiagnostic;
	return diagnostic === undefined ? {} : { diagnostic };
}
