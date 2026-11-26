// The bridge's one entry point: attach a T3 Code facet to a caller-owned pi-durable Harness. Ownership of models and
// projects follows docs/design.md's north star: the bridge computes no defaults of its own. Everything an integrator
// needs comes from this file.
import { HostUpdateWatch } from "./t3/host-updates.ts";
import { SERVER_VERSION } from "./t3/http.ts";
import type { HostUpdates } from "./t3/updates-config.ts";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai";
import type { ConversationId, Extension, Harness, RegistryReader } from "@earendil-works/pi-durable";
import type { SecretSink } from "./t3/secret-sink.ts";
export type { SecretSink } from "./t3/secret-sink.ts";
export type { HostRoute } from "./t3/host-route.ts";
export type { HostCommand } from "./t3/host-command.ts";
export type { ApprovalAsk, ApprovalDecision, ApprovalOption, ApprovalOutcome } from "./t3/approvals.ts";
export type { SectionChange as PromptSectionChange } from "./t3/prompt-updates.ts";
import type { SectionChange as PromptSectionChange } from "./t3/prompt-updates.ts";
import { ProjectRegistry } from "./registry.ts";
import { ServerSettingsStore } from "./settings.ts";
import { type ThreadOrigin, Threads } from "./threads.ts";
import { AuthStore } from "./t3/auth.ts";
import type { BridgeConfig } from "./t3/config.ts";
import type { PreviewBrowserConfig } from "./t3/preview-config.ts";
import type { HostRoute } from "./t3/host-route.ts";
import type { HostCommand } from "./t3/host-command.ts";
import type { ApprovalAsk, ApprovalOutcome } from "./t3/approvals.ts";
import type { HookApi, SignalKey } from "@earendil-works/pi-durable";
import type { TextGenerationModel } from "./t3/title-thread.ts";
import type { MessageContext } from "./t3/message-context.ts";
import type { RemoteAccess } from "./t3/remote-access.ts";
import type { NotifyUser } from "./t3/notify-user.ts";
import type { Page } from "playwright-core";
import type { TitleThread } from "./t3/title-thread.ts";
import { type Logger, nullLogger, type RpcLog } from "./t3/logging.ts";
import { ModelCatalog } from "./t3/models.ts";
import { takesPriority } from "./t3/priority.ts";
import { startFacet } from "./t3/facet.ts";
import { ConfigError } from "./config.ts";
import { messageOf } from "./host-errors.ts";

/** Thrown (rejected) when a file in the state dir doesn't parse; its message names the file and is meant for the user. */
export { ConfigError };
export type { Logger, RpcCall, RpcCallFailure, RpcCallStub, RpcLog } from "./t3/logging.ts";
export type { TextGenerationModel, TitleThread, TitleThreadRequest } from "./t3/title-thread.ts";
export type { ThreadOrigin } from "./threads.ts";
export type { MessageContext, MessageContextAnswer, MessageContextRequest } from "./t3/message-context.ts";
export { DISPLAY_ONLY_RULE, messageContextData } from "./t3/message-context.ts";
export type { HostUpdates } from "./t3/updates-config.ts";
export type { RemoteAccess, RemoteAccessState } from "./t3/remote-access.ts";
export type { NotifyUser, UserNotification } from "./t3/notify-user.ts";
export { abortable } from "./t3/abortable.ts";
export { imageCheckExtension } from "./t3/image-check.ts";
// Tool results with their notes as plain lines: `T3Attachment.plainResults` is this with the bridge's knowledge of
// who stopped a run; a host without a bridge at hand (a test of its tools) installs it with its own `stopOf`.
export { type PlainResultsHost, plainResultsExtension, type StopBy } from "./t3/plain-results.ts";

/** T3's desktop app origin (its Electron scheme, `t3code://app`). Allowed by default. */
const DESKTOP_APP_ORIGIN = "t3code://app";

/** The default listen address: loopback, T3's own app's port plus one (T3 uses 3773). */
const DEFAULT_LISTEN = { host: "127.0.0.1", port: 3774 } as const;

/** The package's `web/` directory (T3's built web app, filled by `pnpm setup:t3`): `../web` from both `src/` and `dist/`. `undefined` when it is missing. */
function bundledWebApp(): string | undefined {
	const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
	return existsSync(join(dir, "index.html")) ? dir : undefined;
}

type AttachT3Options = {
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
	 * Where a webhook's sender reaches this host, as `https://host` (no path), read at each use. A scheduled task with
	 * a webhook trigger shows `<origin>/api/hooks/<task id>/<token>` as its URL, and agents are told it. Absent, or
	 * answering nothing: the task shows the path only. The route itself is always served; whether a sender on the
	 * internet reaches it is your network's doing.
	 */
	readonly webhookOrigin?: () => string | undefined;
	/**
	 * How many times your Harness sends a failed model request again: its `settings.retry.maxRetries` (pi-durable's
	 * default is 3). T3 shows the requests that failed in a row as one row, "Retrying provider (3/64)"; absent, the row
	 * shows the count alone. The bridge only shows this number: the Harness's settings decide what is retried.
	 */
	readonly maxRetries?: number;
	/**
	 * Your words for a change of the system prompt while a thread goes on (an AGENTS.md that was edited, a skill that
	 * was added), given the sections that differ from what the model had, each with its text before and after. The
	 * thread shows it as a quiet row among the run's work, where the change was written; opened, the row lists the
	 * lines that differ. Absent, or answering nothing: "System prompt updated: " and the sections' keys.
	 */
	readonly promptUpdateTitle?: (changes: readonly PromptSectionChange[]) => string | undefined;
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
	 * Slash commands of your own (`HostCommand`): listed in T3's composer menu after this host's, and answered in the
	 * thread they are sent in, shown there only. A name this host answers itself is refused.
	 */
	readonly commands?: readonly HostCommand[];
	/**
	 * Tell a user who is not looking: called once when a thread needs them (an approval, a question, a secret), fails
	 * or finishes its run, and no T3 client has shown them so. You deliver it (a push to a phone, say). The same threads
	 * stay quiet as for T3's own alerts: children and side chats (what a child asks of the user is told for its
	 * top-level thread), archived threads, threads hidden by their tags, a completion while the thread is snoozed, and
	 * a run that was stopped or ended silent.
	 *
	 * Whether the user is looking is what T3's clients report of themselves. With no client in front and no input in
	 * the last two minutes it is called at once (a completion after 5 seconds, as T3 confirms one). Otherwise it waits
	 * 90 seconds and is not called at all when the user proves to be there: input since then, or a thread opened, in a
	 * web or desktop window that is in front; the thread on the screen of the phone app; a message of theirs in the
	 * thread. It is not called either for a request that was answered, or for a run's end that the thread's next
	 * request or run's end takes the place of. A rejection is logged as a warning. Absent: nobody is told.
	 */
	readonly notifyUser?: NotifyUser;
	/**
	 * Optional per-call observation for debugging the T3 wire: `onSuccess` for a request handler that succeeds or a
	 * stream that opens, `onFailure` for a failing request, and `onStubbed` for a method this host does not implement.
	 * The callbacks run synchronously and their exceptions are caught and logged, so a debug sink never breaks a call.
	 */
	readonly rpcLog?: RpcLog;
	readonly log?: Logger;
};

/** The page an agent drives in T3; the page is the one T3 streams to the user. */
type AgentPreviewSession = {
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
	 * to `sink` under the name the agent chose — never into the conversation. This host keeps no secrets itself. The
	 * call parks while the card waits (no time limit, through a restart). One sink: call this once.
	 */
	secretRequests(sink: SecretSink): Extension;
	/**
	 * `ask_user` as a model-facing tool: the agent asks the user one to four questions, the thread shows T3's question
	 * card above the composer, and the call returns the answers. The call parks meanwhile: no time limit, no process
	 * held, and the same card after a restart; a card that is dismissed tells the agent so, and Stop ends it.
	 */
	askUser(): Extension;
	/**
	 * Context for the model about each message that starts or steers a turn, such as memories recalled for it, as an
	 * extension to install on the Harness's registry. The run that answers a message asks `messageContext` for it
	 * before its next request (the message itself is taken at once), waits at most 5 seconds, and stores what it
	 * resolves with as part of the message: hidden in T3's display and thread search, shown as the row it names, and
	 * the same in every later request, so the prompt cache holds. Not called for notes or automatic messages (a
	 * child's report). A rejection or a timeout is logged as a warning and the message goes on without it. Once.
	 */
	messageContext(messageContext: MessageContext): Extension;
	/**
	 * The commands that wait their turn, as an extension to install on the Harness's registry. With it, a `/compact`
	 * or a `/reload` sent as a queued message while the agent works stays in the queue like any message (shown, edited,
	 * removed), and when it is the next one the run that ends does what it says before the messages behind it go on:
	 * compacts, or has the next message's request render the system prompt again. Without it, and sent any other way,
	 * each is answered at once.
	 */
	queuedCommands(): Extension;
	/**
	 * Tool results written for the model as pi coding agent writes them, as an extension to install on the Harness's
	 * registry: the output, then one plain line for each thing to know (`Command exited with code 3`, `Command timed out
	 * after 60 seconds`, `[Showing the last 2000 lines. Full output: <file>]`, `(no output)`), where pi-durable puts
	 * them in a `<harness>` block. A call that was cut off says by whom (`Command interrupted by the user; it may have
	 * partially run`, `... by another agent`, `... by a restart of the harness`), and one that did not run says so (`Not
	 * run: ...`). For the calls the model makes; a script's call gets its result as before. Install it last: after every
	 * extension whose `afterTool` adds a note or changes a result. `registry`: the one the Harness reads, for each
	 * tool's output bound. A call that had not started when its run was stopped gets pi-durable's own result (`Tool
	 * <name> was aborted`, in its block): pi-durable writes that one without asking a hook.
	 */
	plainResults(registry: RegistryReader): Extension;
	/**
	 * Each thread's request priority (T3's "Priority" model option: Inherit, Urgent, Normal, Relaxed), as an extension to
	 * install on the Harness's registry: a request that pi gives a `priority` field (a model whose `compat.vllmPriority`
	 * is set in models.json, on its provider or on the model) carries the thread's instead, -5, 0 or 5 (lower is taken
	 * sooner). A thread on Inherit takes its parent's (a subagent's, a side chat's), else keeps models.json's value.
	 * The option shows only on such models; without this extension, a choice is kept and shown but not sent.
	 */
	requestPriority(): Extension;
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
	 * The thread a conversation is the head of, and where that thread came from (a person, an agent's `thread_prompt`,
	 * a scheduled task; its parent; a side chat): for an integrator that treats its conversations differently by that,
	 * such as a longer prompt cache for the threads a person works in. `undefined` for a conversation that is no
	 * thread's head (one an undo left, or the integrator's own) and until the threads are read at startup.
	 */
	threadOf(conversationId: ConversationId): ThreadOrigin | undefined;
	/** A thread's origin by its id (`threadOf`), for walking up to its parent. */
	threadOrigin(threadId: string): ThreadOrigin | undefined;
	/**
	 * In a `beforeTool` gate of yours (pi-durable's gates), ask the user to approve the call on T3's approval card in the
	 * thread of the call's conversation. Every thread here is full-access, so T3 explains the card as a check the host
	 * makes of its own. The card offers `options` (T3's decisions, in your words); a message the user types meanwhile
	 * declines it, with that text as `feedback`. Resolves with the decision once the user made it; until then with the
	 * `sleep` the gate returns, which parks the call: the card waits, holding no process, until the user answers or the
	 * run is stopped, also across a restart. The gate runs again on every wake (and after a restart or a registry
	 * change), so it asks again and decides from what this returns then; keep its side effects idempotent. Calls of one
	 * thread that ask with the same `key` share one card. Throws for a conversation that is no thread's head.
	 */
	requestApproval(api: Pick<HookApi, "conversationId" | "readSignal" | "memo" | "now">, ask: ApprovalAsk, context: Context): Promise<ApprovalOutcome | { readonly sleep: { readonly signals: readonly SignalKey<unknown>[] } }>;
	/**
	 * Send now the notifications that wait for the user to come back (`notifyUser`), and resolve once they are sent.
	 * Nothing is kept on disk, so a process that stops would lose them: call this first when you shut down. `close()`
	 * starts with it too, but a shutdown that closes other things before the bridge may run out of time.
	 */
	flushNotifications(): Promise<void>;
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
		throw new Error(`pi-durable-t3: cannot read the threads in this Harness's storage (${messageOf(error)}). A store written by an earlier version is migrated by hand.`, { cause: error });
	}

	const catalog = new ModelCatalog(
		async () => (await options.models.getAvailable()).map((model) => ({
			provider: model.provider,
			modelId: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			// pi-ai's own rule for which thinking levels a model has — the picker declares exactly these (capabilities.md).
			thinkingLevels: getSupportedThinkingLevels(model),
			// pi sends these a `priority` field: they show T3's "Priority" option (`priority.ts`).
			...(takesPriority(model) ? { priority: true as const } : {}),
		})),
		// pi's lists, downloaded as pi downloads them (its runtime keeps PI_OFFLINE: then nothing is downloaded).
		({ force, signal }) => options.models.refresh({ force, signal }),
		log,
	);
	// The integrator's own updates are T3's provider update: its version advisory, and the Update button.
	if (options.updates !== undefined) catalog.hostUpdates = new HostUpdateWatch(options.updates, () => catalog.changed(), log);
	catalog.platform = `${catalog.platform}, t3 ${SERVER_VERSION}`;
	await catalog.refresh();

	const listen = options.listen ?? DEFAULT_LISTEN;
	const webApp = options.webApp ?? bundledWebApp();
	if (webApp === undefined) log.warn("no web app to serve (`web/` is missing; in a checkout, run `pnpm setup:t3`)");
	const builtIn = catalog.slashCommandNames();
	for (const command of options.commands ?? []) {
		if (!/^[a-z0-9-]+$/.test(command.name)) throw new ConfigError(`a command's name is lowercase letters, digits and dashes, not ${JSON.stringify(command.name)}`);
		if (builtIn.has(command.name) || (options.commands ?? []).filter((other) => other.name === command.name).length > 1) throw new ConfigError(`the command /${command.name} is already taken`);
	}
	catalog.hostCommands = options.commands ?? [];
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
		...(options.webhookOrigin === undefined ? {} : { webhookOrigin: options.webhookOrigin }),
		...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
		...(options.promptUpdateTitle === undefined ? {} : { promptUpdateTitle: options.promptUpdateTitle }),
		...(options.remoteAccess === undefined ? {} : { remoteAccess: options.remoteAccess }),
		...(options.preview === undefined ? {} : { preview: options.preview }),
		...(options.rpcLog === undefined ? {} : { rpcLog: options.rpcLog }),
		...(options.notifyUser === undefined ? {} : { notifyUser: options.notifyUser }),
		...(options.routes === undefined ? {} : { routes: options.routes }),
		...(options.commands === undefined ? {} : { commands: options.commands }),
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
		askUser: () => facet.askUser(),
		messageContext: (messageContext) => facet.messageContext(messageContext),
		queuedCommands: () => facet.queuedCommands(),
		plainResults: (registry) => facet.plainResults(registry),
		requestPriority: () => facet.requestPriority(),
		textGenerationModel: () => facet.textGenerationModel(),
		hiddenModels: () => facet.hiddenModels(),
		threadOf: (conversationId) => facet.threadOf(conversationId),
		threadOrigin: (threadId) => facet.threadOrigin(threadId),
		requestApproval: (api, ask, context) => facet.requestApproval(api, ask, context),
		flushNotifications: () => facet.flushNotifications(),
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
