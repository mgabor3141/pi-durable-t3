// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. Ownership of models and
// projects follows docs/design.md's north star: the bridge computes no defaults of its own. Everything an integrator
// needs comes from this file.
import { HostUpdateWatch } from "./t3/host-updates.ts";
import type { HostUpdates } from "./t3/updates-config.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import type { SecretSink } from "./t3/secret-sink.ts";
export type { SecretSink } from "./t3/secret-sink.ts";
export type { HostRoute } from "./t3/host-route.ts";
import { ProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { Threads } from "./threads.ts";
import { AuthStore } from "./t3/auth.ts";
import type { BridgeConfig } from "./t3/config.ts";
import type { PreviewBrowserConfig } from "./t3/preview-config.ts";
import type { HostRoute } from "./t3/host-route.ts";
import type { TextGenerationModel } from "./t3/title-thread.ts";
import type { MessageContext } from "./t3/message-context.ts";
import type { RemoteAccess } from "./t3/remote-access.ts";
import type { Page } from "playwright-core";
import type { TitleThread } from "./t3/title-thread.ts";
import { type Logger, nullLogger, type RpcLog } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { startFacet } from "./t3/facet.ts";

/** Thrown (rejected) when a file in the state dir doesn't parse; its message names the file and is meant for the user. */
import { ConfigError } from "./config.ts";
export { ConfigError };
export type { Logger, RpcCall, RpcCallFailure, RpcCallStub, RpcLog } from "./t3/logging.ts";
export type { TextGenerationModel, TitleThread, TitleThreadRequest } from "./t3/title-thread.ts";
export type { MessageContext, MessageContextAnswer, MessageContextRequest } from "./t3/message-context.ts";
export { DISPLAY_ONLY_RULE, messageContextData } from "./t3/message-context.ts";
export type { HostUpdates } from "./t3/updates-config.ts";
export type { RemoteAccess, RemoteAccessState } from "./t3/remote-access.ts";
export { abortable, abortableExtension } from "./t3/abortable.ts";
export { imageCheckExtension } from "./t3/image-check.ts";

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
	 * (the pairing store) and `uploads/` (attachments not yet sent). The bridge opens them itself and writes them on the UI's behalf; one host
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
	 * Where attachments live in `env`: each image and file a user sends is saved there as `<id>.<ext>` and named to the
	 * model by path, as T3 names its own attachment store to its agents; images also go to the model inline when it
	 * takes them. Nothing removes them. Omitted: the host takes no attachments (T3 is told it has no uploads).
	 */
	readonly attachmentsDir?: string;
	/**
	 * The Scratch project's ("No project") root — agent work output, NOT bridge state. Omitted: the feature is off,
	 * the config advertises no `scratchWorkspaceRoot` and `projects.ensureScratch` is refused.
	 */
	readonly scratchDir?: string;
	/** Listen address. Default `127.0.0.1:3774`. */
	readonly listen?: { readonly host: string; readonly port: number };
	/** Environment name T3 shows. Default `"pi"`. */
	readonly label?: string;
	/** A built T3 web app's directory, served at `/`. Default: the T3 web app shipped in this package (`web/`). Set `webApp` to serve a different build. Static files, with T3's SPA fallback to `index.html`; the API, `/ws`, `/.well-known`, `/oauth` and `/api` routes win; `/pair` is T3's own pairing page. The web app treats the page origin as its primary environment, so serving it here makes the pi host "This machine" and Settings → Sharing & access works in the browser. */
	readonly webApp?: string;
	/** Browser origins allowed to call. Default: T3's desktop app. `[]` allows any origin. A web app served from this host's own origin is same-origin and needs no entry; this list is for a web app served from a foreign origin. */
	readonly corsOrigins?: readonly string[];
	/** Bearer-token lifetime, seconds. Default 90 days. */
	readonly tokenTtlSeconds?: number;
	/**
	 * A route to this host that you run yourself, such as your own tailnet node or an SSH relay into the environment.
	 * T3 learns its HTTPS URL (`directEndpoints`) and the SSH host
	 * editors open paths on (`remoteOpenTargets`: "Open in VS Code", file links). Read at each config read; on a change,
	 * connected clients get a fresh config. Absent: none.
	 */
	readonly remoteAccess?: RemoteAccess;
	/**
	 * Title generation, delegated to you (T3's `ThreadTitleRegenerationService`). Called once a thread's first user
	 * entry is committed (not after the reply) and on "Regenerate title"; resolve with a title, or `undefined` / "New
	 * thread" (/ the same title on regenerate) for no change. `signal` aborts when a rename or a newer request supersedes
	 * the call; a late result is ignored either way. A rejection is logged as a warning and changes nothing. Absent: the
	 * first message's seed and renames still work, and "Regenerate title" is refused.
	 */
	readonly titleThread?: TitleThread;
	/**
	 * Context for the model about each message that starts or steers a turn, such as memories recalled for it. The text
	 * you resolve with is stored with the message, hidden in T3's display and thread search, so the prompt cache holds.
	 * Not called for notes or automatic messages (a child's report). The bridge waits at most 5 seconds; a rejection or a
	 * timeout is logged as a warning and the message goes on without it. Absent: none.
	 */
	readonly messageContext?: MessageContext;
	/**
	 * How many times your Harness sends a failed model request again: its `settings.retry.maxRetries` (pi-durable's
	 * default is 3). T3 shows the requests that failed in a row as one row, "Retrying provider (3/64)"; absent, the row
	 * shows the count alone. The bridge only shows this number: the Harness's settings decide what is retried.
	 */
	readonly maxRetries?: number;
	/**
	 * Your host's own versions and how it updates: what runs, the newest there is, an install, a restart. T3 then shows
	 * them as the `pi` provider's version and its update, in Settings → Providers, the sidebar and "Update everything",
	 * in the web app and the desktop app: on this host the provider is your agent. Absent: T3's Update is refused.
	 */
	readonly updates?: HostUpdates;
	/** A Chromium CDP endpoint for T3's server preview panel. Absent: `preview.*` stays unsupported. */
	readonly preview?: PreviewBrowserConfig;
	/** HTTP routes of your own on the host's listener (an OAuth callback): public, so they check their callers. */
	readonly routes?: readonly HostRoute[];
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
	 * T3's thread tools (`t3_thread_list`, `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`,
	 * `create_threads`, `t3_thread_update`) as an extension to install in the Harness's registry: an agent's call acts as
	 * the thread its conversation is the head of. The same operations `/mcp` serves. `callers` defaults to the model
	 * and scripts.
	 */
	threadTools(options?: { readonly callers?: readonly ("model" | "tools")[] }): Extension;
	/**
	 * T3's html tools: `html_render` shows a finished page (a chart, a diagram, a mockup) inline in the caller's thread,
	 * above its reply, and `html_preview` — only with `preview` configured — renders a page in that browser and returns a
	 * PNG, its height and its console, so the agent can check it first. Pages are kept in `attachmentsDir` (required).
	 * `callers` as for `threadTools`.
	 */
	htmlTools(options?: { readonly callers?: readonly ("model" | "tools")[] }): Extension;
	/**
	 * T3's `request_secret` as a model-facing tool: the thread shows T3's secret card, and the value the user enters goes
	 * to `sink` under the name the agent chose — never into the conversation. This host keeps no secrets itself.
	 */
	secretRequests(sink: SecretSink): Extension;
	/**
	 * T3's text-generation model (Settings), read at each call: the model to use for generated text such as summaries,
	 * when the setting names one of this host's models; `undefined` means use the conversation's own model.
	 */
	textGenerationModel(): TextGenerationModel | undefined;
	/**
	 * The models the user hid from T3's model picker (Settings → Providers), as `provider/model` slugs, read at each
	 * call: for an integrator that lists models to its agent and wants the list to be the picker's. T3 hides a model
	 * from the picker only; nothing here refuses a thread that names one.
	 */
	hiddenModels(): ReadonlySet<string>;
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

	const catalog = new ModelCatalog(
		async () => (await options.models.getAvailable()).map((model) => ({
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			// pi-ai's own rule for which thinking levels a model has — the picker declares exactly these (capabilities.md).
			thinkingLevels: getSupportedThinkingLevels(model),
		})),
		// pi's lists, downloaded as pi downloads them (its runtime keeps PI_OFFLINE: then nothing is downloaded).
		({ force, signal }) => options.models.refresh({ force, signal }),
		log,
	);
	// The integrator's own updates are T3's provider update: its version advisory, and the Update button.
	if (options.updates !== undefined) catalog.hostUpdates = new HostUpdateWatch(options.updates, () => catalog.changed(), log);
	await catalog.refresh();

	const listen = options.listen ?? DEFAULT_LISTEN;
	const webApp = options.webApp ?? bundledWebApp();
	if (webApp === undefined) log.warn("no web app to serve (`web/` is missing; in a checkout, run `pnpm setup:t3`)");
	for (const route of options.routes ?? []) {
		if (!/^\/host\/[A-Za-z0-9._~\/-]+$/.test(route.path)) throw new ConfigError(`a host route's path must be a plain path under /host/, not ${JSON.stringify(route.path)}`);
	}
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
		...(options.attachmentsDir === undefined ? {} : { attachmentsDir: options.attachmentsDir }),
		tokenTtlSeconds: options.tokenTtlSeconds ?? 90 * 86_400,
		corsOrigins: options.corsOrigins ?? [DESKTOP_APP_ORIGIN],
		staticDir: webApp,
		...(options.titleThread === undefined ? {} : { titleThread: options.titleThread }),
		...(options.messageContext === undefined ? {} : { messageContext: options.messageContext }),
		...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
		...(options.remoteAccess === undefined ? {} : { remoteAccess: options.remoteAccess }),
		...(options.preview === undefined ? {} : { preview: options.preview }),
		...(options.rpcLog === undefined ? {} : { rpcLog: options.rpcLog }),
		...(options.routes === undefined ? {} : { routes: options.routes }),
	};
	const facet = startFacet({ threads, models: options.models, catalog, log, config });
	// Resolve only once LISTENING and loaded: a bind failure (a port in use) or unreadable tasks reject here, after the
	// facet is closed again.
	try {
		await facet.ready;
	} catch (error) {
		await facet.close().catch(() => {});
		throw error;
	}
	// New models (a release after this pi's) reach the picker without an update: pi.dev's lists, checked hourly. A newer
	// version of the host, when the integrator has updates, is looked for as often.
	const stopWatching = catalog.watch();
	void facet.closed.finally(stopWatching);
	return {
		closed: facet.closed,
		setTitle: (threadId, title) => facet.setTitle(threadId, title),
		threadTools: (toolOptions) => facet.threadTools(toolOptions),
		htmlTools: (toolOptions) => facet.htmlTools(toolOptions),
		secretRequests: (sink) => facet.secretRequests(sink),
		textGenerationModel: () => facet.textGenerationModel(),
		hiddenModels: () => facet.hiddenModels(),
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
			stopWatching();
			await facet.close();
		},
	};
}
