// T3 `/ws` RPC handlers (Effect RPC over WsRpcGroup). The minimal viable surface is implemented; every other method
// gets a stub: streams stay open and silent, and unary calls answer with a benign value or a clear failure.
import { basename } from "node:path";
import {
	AssetAttachmentNotFoundError,
	AuthFilesystemReadScope,
	AuthPreviewOperateScope,
	AuthOrchestrationReadScope,
	AuthFilesystemWriteScope,
	authScopeRequiredResponse,
	EnvironmentAuthorizationError,
	ProjectListEntriesError,
	ProjectReadFileError,
	ProjectSearchContentsError,
	ProjectSearchEntriesError,
	ProjectWriteFileError,
	AssetPreviewTypeValidationError,
	FilesystemBrowseError,
	PersistChatAttachmentsError,
	type ExecutionEnvironmentDescriptor,
	OrchestrationDispatchCommandError,
	OrchestrationSearchThreadsError,
	OrchestrationV2DispatchCommandError,
	OrchestrationV2GetThreadProjectionError,
	OrchestrationV2ThreadLaunchError,
	ProjectMutationError,
	RpcScopeAuthorization,
	type ServerConfig,
	ScheduledTaskError,
	ServerSettingsError,
	UsageReadError,
	WsRpcGroup,
} from "@t3tools/contracts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { ProjectConflict, ProjectNotFound } from "../registry.ts";
import { ProviderInstanceExists } from "../settings.ts";
import { accessChangeEvent, accessSnapshot } from "./access.ts";
import { type AuthStore } from "./auth.ts";
import { type Bridge, CommandError } from "./bridge.ts";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseReadDirectoryFailed, BrowseWindowsPathUnsupported } from "./browse.ts";
import { serverCwd } from "./config.ts";
import { EntriesError, FileError, type WorkspaceFiles } from "./files.ts";
import type { Logger } from "./logging.ts";
import type { ModelCatalog } from "./models.ts";
import { PROVIDER_INSTANCE_ID } from "./projection.ts";
import { CurrentAuthSession } from "./session-context.ts";
import { resolveServedEndpoint, type ServedEndpoint, type TailscaleCli } from "./tailscale.ts";
import { piUsagePricing, summarizeUsage } from "./usage.ts";
import type { AttachmentStore } from "./attachment-store.ts";
import type { WorkspaceAssets } from "./workspace-assets.ts";
import { type ScheduledTasks, WEBHOOKS_UNSUPPORTED } from "./scheduled-tasks.ts";
import { PreviewInvalidUrlError, PreviewSessionLookupError, type AuthEnvironmentScope } from "@t3tools/contracts";
import type { PreviewSessions } from "./preview.ts";

// biome-ignore lint/suspicious/noExplicitAny: handler payloads are decoded by the RPC schemas
type Any = any;

const fromListener = <A>(
	subscribe: (emit: (value: A) => void, end: () => void) => () => void,
): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() =>
				subscribe(
					(value) => Queue.offerUnsafe(queue, value),
					() => Queue.endUnsafe(queue),
				),
			),
			(unsubscribe) => Effect.sync(unsubscribe),
		),
	);

/** Sidebar bookkeeping commands that may be acknowledged without host state. Everything else unknown fails. */
const SIDEBAR_NO_OPS = new Set([
	"thread.visit",
	"thread.mark-unread",
	"thread.auto-settle",
	"thread.auto-settle.set",
	"thread.pin",
	"thread.unpin",
	"thread.pin.reorder",
	"thread.active.reorder",
	"notification.delivery.accept",
]);

const UNSUPPORTED: Record<string, string> = {
	"thread.fork": "Forking is not supported by pi-durable-t3 yet.",
	"thread.merge_back": "Merging a fork back is not supported by pi-durable-t3 yet.",
	"thread.archive": "Archiving is not supported by pi-durable-t3 yet.",
	"orchestration.subscribeArchivedShell": "Archiving is not supported by pi-durable-t3 yet: there is nothing to list.",
	"orchestration.getArchivedShellSnapshot": "Archiving is not supported by pi-durable-t3 yet: there is nothing to list.",
	"thread.unarchive": "Archiving is not supported by pi-durable-t3 yet.",
	"thread.snooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"thread.unsnooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"runtime-request.respond": "pi runs without approvals; there is nothing to answer.",
	"provider.switch": "pi is the only provider.",
	"subagent.stop": "Stopping one subagent is not supported by pi-durable-t3: interrupt the parent's turn, which stops the subagent with it.",
	// Self-update RPCs. The descriptor advertises no `serverSelfUpdate` capability, so a client offers a manual
	// relaunch command and never sends these; if one arrives (a hand-built client, a future default), refuse it
	// honestly: the bridge is not a T3 install and updates by updating itself on the host, not over the wire.
	"server.updateServer": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.updateServerWithProgress": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.commitDesktopUpdate": "This server is not supervised by the T3 Code desktop app; there is no desktop update to commit.",
};

/**
 * The refusal the UI shows verbatim: "yet" claims we intend to build it, so only the planned set says so and an
 * untriaged call is refused flatly (capabilities.md keeps the same statuses).
 */
function unsupportedMessage(type: string): string {
	if (UNSUPPORTED[type] !== undefined) return UNSUPPORTED[type];
	if (type.startsWith("queued-") || type === "queue.resume") return "Editing queued messages is not supported by pi-durable-t3 yet.";
	return `${type} is not supported by pi-durable-t3.`;
}

interface RpcDeps {
	readonly bridge: Bridge;
	readonly files: WorkspaceFiles;
	readonly catalog: ModelCatalog;
	readonly descriptor: () => ExecutionEnvironmentDescriptor;
	readonly authDescriptor: Any;
	readonly auth: AuthStore;
	readonly attachments: AttachmentStore;
	readonly assets: WorkspaceAssets;
	readonly scheduledTasks: ScheduledTasks;
	readonly tailscale: TailscaleCli;
	readonly preview: PreviewSessions | undefined;
	readonly log: Logger;
}

/** The host-wide settings T3 reads: the settings store's current document — one source every settings read answers from
 * (state.md). */
function serverSettings(deps: RpcDeps) {
	return deps.bridge.config.settings.current();
}

function serverConfig(deps: RpcDeps, directEndpoints: readonly ServedEndpoint[]): ServerConfig {
	return {
		environment: deps.descriptor(),
		auth: deps.authDescriptor,
		// A host with no projects stays connectable: `serverCwd` (./config.ts) falls back to the state dir, so a cwd is
		// always answerable and a project-less host cannot throw here and drop a paired client into a reconnect loop.
		cwd: serverCwd(deps.bridge.config),
		keybindingsConfigPath: `${deps.bridge.config.stateDir}/keybindings.json`,
		keybindings: [],
		issues: [],
		providers: deps.catalog.providers(),
		availableEditors: [],
		observability: {
			logsDirectoryPath: deps.bridge.config.stateDir,
			localTracingEnabled: false,
			otlpTracesEnabled: false,
			otlpMetricsEnabled: false,
			otlpLogsEnabled: false,
		},
		settings: serverSettings(deps),
		// T3's `directEndpoints`, smaller: this host advertises only the tailnet Serve URL (no LAN addresses), read
		// fresh on every config read — the served name is the machine's, not this process's, fact.
		directEndpoints,
		shellResumeCompletionMarker: true,
		threadResumeCompletionMarker: true,
		// T3's client offers "New thread without a project" on an environment only when its config carries this folder
		// (`availableScratchWorkspaceRoot`), and the same config answers `projects.ensureScratch` for it (rpc.ts). A host
		// with no scratch dir advertises nothing, and the client offers no such thread.
		...(deps.bridge.scratchRoot === undefined ? {} : { scratchWorkspaceRoot: deps.bridge.scratchRoot }),
	} as Any;
}

/** A config read: the static fields plus the served tailnet URL (bounded: a machine with no `tailscale` CLI answers
 * in milliseconds, not in timeouts). */
async function readServerConfig(deps: RpcDeps): Promise<ServerConfig> {
	const served = deps.bridge.config.tailscaleServe === undefined
		? null
		: await resolveServedEndpoint({
				servePort: deps.bridge.config.tailscaleServe.port,
				tailscale: deps.tailscale,
			});
	return serverConfig(deps, served === null ? [] : [served]);
}

/** The image attachments of a command (the persisted records the client sent), shaped for `Bridge.sendMessage`. Files
 * are dropped: this host sends only images to the model (the file-attachment path needs the upload store, refused). */
function imageRecords(attachments: unknown): { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number }[] | undefined {
	if (!Array.isArray(attachments)) return undefined;
	const records = attachments
		.filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && a.type === "image" && typeof a.id === "string")
		.map((a) => ({ type: "image" as const, id: a.id as string, name: String(a.name ?? "image"), mimeType: String(a.mimeType ?? "application/octet-stream"), sizeBytes: Number(a.sizeBytes ?? 0) }));
	return records.length > 0 ? records : undefined;
}

const toPromiseEffect = <A>(run: () => Promise<A>, onError: (message: string) => Any) =>
	Effect.tryPromise({ try: run, catch: (error) => onError((error as Error).message || String(error)) });

/** A scheduled-task call: its refusals are already the contract's `ScheduledTaskError`; anything else becomes one. */
const scheduled = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) => (error instanceof ScheduledTaskError ? error : new ScheduledTaskError({ message: (error as Error).message || String(error) })),
	});

/**
 * T3's per-method scope gate, for the file calls (`auth/RpcAuthorization.ts`: read/list/search need
 * `filesystem:read`, write needs `filesystem:write`). The scopes are the session's own, read from the socket's session
 * (`CurrentAuthSession`); a grant without the scope is refused with the contract's `EnvironmentAuthorizationError`, the
 * error T3's middleware raises — the client shows it as a missing permission.
 */
const withScope = <A, E>(scope: AuthEnvironmentScope, run: () => Effect.Effect<A, E>) =>
	Effect.gen(function* () {
		const { scopes } = yield* CurrentAuthSession;
		if (!scopes.includes(scope)) {
			return yield* Effect.fail(new EnvironmentAuthorizationError({ message: `The authenticated token is missing required scope: ${scope}.`, ...authScopeRequiredResponse(scope) }));
		}
		return yield* run();
	});

/** A file-call refusal as the contract's typed error: T3's `projectEntriesFailureContext` / `projectFileFailureContext`. */
const entriesFailure = (error: unknown) =>
	error instanceof EntriesError
		? { failure: error.failure, ...error.context, message: error.message, cause: error }
		: { failure: "search_index_search_failed" as const, message: (error as Error).message || String(error), cause: error };
const fileFailure = (error: unknown) =>
	error instanceof FileError
		? { failure: error.failure, ...error.context, message: error.message, cause: error }
		: { failure: "operation_failed" as const, message: (error as Error).message || String(error), cause: error };

export function makeRpcLayer(deps: RpcDeps) {
	const { bridge, log } = deps;
	const stubbed = new Set<string>();
	const previewCall = <A>(run: () => Promise<A>) =>
		Effect.tryPromise({ try: run, catch: (error) => error as Error }).pipe(
			Effect.catch((error) =>
				error instanceof PreviewInvalidUrlError || error instanceof PreviewSessionLookupError
					? Effect.fail(error)
					: Effect.die(error),
			),
		);
	const noteStub = (tag: string) => {
		if (stubbed.has(tag)) return;
		stubbed.add(tag);
		log.info("stubbed RPC called", { method: tag });
	};

	const dispatch = (command: Any) => {
		const fail = (message: string) =>
			new OrchestrationV2DispatchCommandError({ commandId: command.commandId, commandType: command.type, message });
		const run = async (): Promise<number> => {
			switch (command.type) {
				case "message.dispatch": {
					await bridge.applySelection(command.threadId, command.modelSelection);
					// With serverResolvedCommandContext the client sends start_immediately plus a deliveryIntent
					// (steer/restart/auto); queued sends are queue_after_active. Older clients name the mode directly.
					const modeType = command.dispatchMode?.type ?? "start_immediately";
					const intent = command.deliveryIntent;
					const mode =
						modeType === "steer_active" || intent === "steer" || intent === "auto"
							? "steer"
							: modeType === "restart_active" || intent === "restart"
								? "restart"
								: modeType === "queue_after_active"
									? "queue"
									: "start";
					await bridge.sendMessage({
						threadId: command.threadId,
						commandId: command.commandId,
						messageId: command.messageId,
						text: command.text,
						mode,
						...(typeof command.titleSeed === "string" ? { titleSeed: command.titleSeed } : {}),
						...(imageRecords(command.attachments) === undefined ? {} : { attachments: imageRecords(command.attachments) }),
					});
					break;
				}
				case "run.interrupt":
				case "thread.stop":
					await bridge.interrupt(command.threadId);
					break;
				case "queued-run.cancel":
					await bridge.cancelQueued(command.threadId, command.runId);
					break;
				case "queued-run.edit":
					await bridge.editQueued(command.threadId, command.runId, command.text, imageRecords(command.attachments));
					break;
				case "queued-message.promote-to-steer":
					await bridge.promoteQueued(command.threadId, command.queuedRunId);
					break;
				case "queued-run.reorder":
					await bridge.reorderQueued(command.threadId, command.runId, command.beforeRunId);
					break;
				case "queue.resume":
					break;
				case "thread.settle":
					await bridge.settleThread(command.threadId);
					break;
				case "thread.unsettle":
					await bridge.unsettleThread(command.threadId);
					break;
				case "thread.model-selection.set":
					await bridge.applySelection(command.threadId, command.modelSelection);
					break;
				case "checkpoint.rollback":
					await bridge.rollback({
						threadId: command.threadId,
						commandId: command.commandId,
						checkpointId: command.checkpointId,
						restoreFiles: command.restoreFiles === true,
					});
					break;
				case "thread.delete":
					await bridge.deleteThread(command.threadId);
					break;
				case "thread.metadata.update":
					await bridge.updateThreadMetadata(command);
					break;
				case "thread.create":
					await bridge.createThread({ threadId: command.threadId, projectId: command.projectId, title: command.title });
					await bridge.applySelection(command.threadId, command.modelSelection);
					break;
				case "thread.runtime-mode.set":
					if (bridge.isSubagentThread(command.threadId)) throw new CommandError("This is a subagent's thread: the agent that started it owns it.");
					if (command.runtimeMode !== "full-access") throw new CommandError("pi runs tools without approvals; full-access is the only mode.");
					break;
				case "thread.interaction-mode.set":
					if (bridge.isSubagentThread(command.threadId)) throw new CommandError("This is a subagent's thread: the agent that started it owns it.");
					if (command.interactionMode !== "default") throw new CommandError("Plan mode is not supported by pi-durable-t3.");
					break;
				default:
					if (!SIDEBAR_NO_OPS.has(command.type)) throw new CommandError(unsupportedMessage(command.type));
					// Sidebar bookkeeping (pin, visit, …) has no host state yet; accepting it changes nothing visible.
					log.info("command accepted without effect", { type: command.type });
			}
			return bridge.nextSequence();
		};
		return toPromiseEffect(() => bridge.idempotent(command.commandId, run), fail).pipe(
			Effect.map((sequence) => ({ sequence })),
			Effect.tapError((error: Any) => Effect.sync(() => log.warn("command failed", { type: command.type, error: error.message }))),
		);
	};

	const handlers: Record<string, (payload: Any) => Any> = {
		"server.probe": () => Effect.succeed({}),
		"server.getConfig": () =>
			toPromiseEffect(() => readServerConfig(deps), (message) => new Error(message) as Any),
		"server.refreshProviders": () => Effect.promise(() => deps.catalog.refresh()).pipe(Effect.map(() => ({ providers: deps.catalog.providers() }))),
		"server.getSettings": () => Effect.sync(() => serverSettings(deps)),
		// Onboarding step 3 scans each environment for importable agent sessions. This host has none to import — the
		// agent's conversations live in pi-durable, not in a Codex/Claude home directory — so it is answered truthfully
		// with an empty scan. The rest of `agentSessions.*` (import) stays refused (capabilities.md).
		"agentSessions.scan": () => Effect.sync(() => ({ candidates: [], scannedAt: new Date().toISOString() })),
		// T3's settings write, replicated (design.md): a PATCH merged into the current settings, optionally with one
		// provider-instance mutation applied to the same snapshot.
		"server.updateSettings": (input: Any) =>
			Effect.try({
				try: () => {
					const settings = deps.bridge.config.settings;
					const patch = input?.patch ?? {};
					return input?.providerInstanceMutation === undefined ? settings.update(patch) : settings.updateProviderInstance(input.providerInstanceMutation, patch);
				},
				// Build the contract's own class: `settingsPath` and `operation` are required, so a hand-rolled literal fails
				// the schema encode at the boundary and reaches the client as a defect, not a refusal (capabilities.md).
				catch: (error) =>
					error instanceof ProviderInstanceExists
						? new ServerSettingsError({
								settingsPath: deps.bridge.config.settings.path,
								operation: "create-provider-instance",
								providerInstanceId: error.instanceId,
								cause: error,
							})
						: new ServerSettingsError({
								settingsPath: deps.bridge.config.settings.path,
								operation: "write-file",
								providerInstanceId: PROVIDER_INSTANCE_ID,
								cause: error,
							}),
				}).pipe(
					Effect.tapError((error: ServerSettingsError) => Effect.sync(() => log.warn("settings update refused", { operation: error.operation, cause: error.cause instanceof Error ? error.cause.message : String(error.cause) }))),
				),
		// Projects through `projects.mutate` (the sendable surface); every refusal is the contract's `ProjectMutationError`.
		"projects.mutate": (mutation: Any) =>
			Effect.tryPromise({
				try: () => bridge.mutateProject(mutation),
				catch: (error) =>
					new ProjectMutationError({
						commandId: mutation.commandId,
						message: error instanceof ProjectConflict || error instanceof ProjectNotFound ? error.message : (error as Error).message || String(error),
					}),
			}),
		// Finds or creates the "No project" project (`../scratch.ts`), answered as T3's server answers it: the folder is
		// re-made, the project found-or-created, and the reply is its id. The declared failure is the dispatch error T3
		// maps every Scratch failure to.
		"projects.ensureScratch": () =>
			toPromiseEffect(
				() => bridge.ensureScratch(),
				(message) => new OrchestrationDispatchCommandError({ message }),
			),
		// The read-only directory listing that feeds the "Add project" picker; T3's own semantics, this host's trust model.
		"filesystem.browse": (input: Any) =>
			Effect.tryPromise({
				try: () => {
					const env = deps.bridge.config.env;
					if (env === undefined) throw new Error("This host has no execution environment.");
					return browseFilesystem({ partialPath: input.partialPath, ...(input.cwd === undefined ? {} : { cwd: input.cwd }), env, context: deps.bridge.config.context ?? BACKGROUND_CONTEXT });
				},
				catch: (error) =>
					new FilesystemBrowseError({
						partialPath: input.partialPath,
						...(input.cwd === undefined ? {} : { cwd: input.cwd }),
						failure:
							error instanceof BrowseWindowsPathUnsupported
								? "windows_path_unsupported"
								: error instanceof BrowseCurrentProjectRequired
									? "current_project_required"
									: "read_directory_failed",
						...(error instanceof BrowseReadDirectoryFailed ? { parentPath: error.parentPath } : {}),
					}),
			}),
		// T3's file panel and quick-open (`files.ts`, replicated from `apps/server/src/workspace`). The `cwd` must be a root this
		// host knows; every failure is the contract's own typed error.
		"projects.listEntries": (input: Any) =>
			withScope(AuthFilesystemReadScope, () =>
				Effect.tryPromise({ try: () => deps.files.list(input), catch: (error) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(error) } as Any) }),
			),
		"projects.searchEntries": (input: Any) =>
			withScope(AuthFilesystemReadScope, () =>
				Effect.tryPromise({ try: () => deps.files.searchEntries(input), catch: (error) => new ProjectSearchEntriesError({ cwd: input.cwd, queryLength: input.query.length, limit: input.limit, ...entriesFailure(error) } as Any) }),
			),
		"projects.searchContents": (input: Any) =>
			withScope(AuthFilesystemReadScope, () =>
				Effect.tryPromise({ try: () => deps.files.searchContents(input), catch: (error) => new ProjectSearchContentsError({ cwd: input.cwd, queryLength: input.query.length, limit: input.limit, ...entriesFailure(error) } as Any) }),
			),
		"projects.readFile": (input: Any) =>
			withScope(AuthFilesystemReadScope, () =>
				Effect.tryPromise({ try: () => deps.files.readFile(input), catch: (error) => new ProjectReadFileError({ cwd: input.cwd, relativePath: input.relativePath, ...fileFailure(error) } as Any) }),
			),
		"projects.writeFile": (input: Any) =>
			withScope(AuthFilesystemWriteScope, () =>
				Effect.tryPromise({ try: () => deps.files.writeFile(input), catch: (error) => new ProjectWriteFileError({ cwd: input.cwd, relativePath: input.relativePath, ...fileFailure(error) } as Any) }),
			),
		"server.reportClientActivity": () => Effect.succeed({}),
		// T3's usage view. `server.getUsageSummary` is answered from what pi-durable records per turn (tokens, cost,
		// model) — replicated bucketing from T3, provider-reported cost, fields pi has no value for omitted (see
		// `usage.ts`). An invalid window is T3's typed `UsageReadError` (the client shows it); a scan that throws while
		// reading conversations is `scanFailed`. `server.refreshUsageRates` is on the client's refresh path: it answers
		// this host's pricing truthfully (no rate table — pi prices its own turns), never a fetched LiteLLM table.
		"server.getUsageSummary": (input: Any) =>
			Effect.tryPromise({
				try: () => bridge.usageConversations().then((conversations) => summarizeUsage(input, conversations, bridge.config.stateDir)),
				catch: (error) =>
					error instanceof UsageReadError
						? error
						: new UsageReadError({ reason: "scanFailed", detail: (error as Error).message || "The usage scan failed.", cause: error }),
			}),
		"server.refreshUsageRates": () => Effect.sync(() => piUsagePricing()),
		// Image attachments, the data-URL path (capabilities.md): the client sends the bytes inline, this host stores
		// them under the bridge's dir and answers a persisted record; display is served by `assets.createUrl` + the
		// `/api/assets/*` HTTP route (signature-authed, no bearer — like T3). The upload-URL path (`attachments.*`) is
		// refused: this host does not advertise `attachmentUploads`, so the client never calls it.
		"assets.persistChatAttachments": (input: Any) =>
			Effect.try({
				try: () => ({ attachments: deps.attachments.persist(input.threadId, input.messageId, input.attachments ?? []) }),
				catch: (error) => new PersistChatAttachmentsError({ message: (error as Error).message || String(error) }),
			}),
		"assets.createUrl": (input: Any) => {
			const resource = input.resource;
						if (resource?._tag === "workspace-file" || resource?._tag === "media-file" || resource?._tag === "draft-workspace-file") {
				return Effect.tryPromise({ try: () => deps.assets.issue(resource), catch: (error) => error as Error });
			}
			// Favicon/tool-output/github resources are not served by this host: the file panel reads text through `projects.readFile`.
			if (resource?._tag !== "attachment") return Effect.fail(new AssetPreviewTypeValidationError({ resource } as Any));
			const minted = deps.attachments.mintAssetUrl({
				attachmentId: resource.attachmentId,
				...(typeof resource.fileName === "string" ? { fileName: resource.fileName } : {}),
				...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
			});
			return minted === null
				? Effect.fail(new AssetAttachmentNotFoundError({ resource } as Any))
				: Effect.succeed(minted);
		},
		// The config stream: the store's change signal is what emits `settingsUpdated`, the event on which the projection
		// replaces `config.settings` (capabilities.md).
		subscribeServerConfig: () =>
			Stream.concat(
				Stream.fromEffect(toPromiseEffect(() => readServerConfig(deps), (message) => new Error(message) as Any)).pipe(
					Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
				),
				fromListener<Any>((emit) => {
					const stopCatalog = deps.catalog.onChange(() =>
						emit({ version: 1, type: "providerStatuses", payload: { providers: deps.catalog.providers() } }),
					);
					const stopSettings = bridge.config.settings.subscribe(() =>
						emit({ version: 1, type: "settingsUpdated", payload: { settings: serverSettings(deps) } }),
					);
					return () => {
						stopCatalog();
						stopSettings();
					};
				}),
			),
		// The server lifecycle stream (T3's `subscribeServerLifecycle`): the opening snapshot — `welcome` (the
		// environment + cwd, what the web app's onboarding gate reads to confirm this workspace) then `ready` —
		// followed by live events. This host self-updates never, so after the snapshot the stream stays open and
		// silent. A refused (dying) stream breaks the web app's connection reducer, so the snapshot is required.
		subscribeServerLifecycle: () => {
			const environment = deps.descriptor();
			const cwd = serverCwd(deps.bridge.config);
			return Stream.concat(Stream.make({ version: 1, sequence: 0, type: "welcome", payload: { environment, cwd, projectName: basename(cwd) || cwd } } as Any, { version: 1, sequence: 1, type: "ready", payload: { at: new Date().toISOString(), environment } } as Any), Stream.never);
		},
		// The Connections access stream (T3's `subscribeAuthAccess`): the snapshot first (links + sessions, `current` for
		// this socket's session), then the store's changes as incremental events at an increasing revision (the client
		// reducer folds each into the snapshot; it never re-reads the store). `current` is the viewer's own client.
		subscribeAuthAccess: () =>
			Stream.unwrap(
				Effect.map(CurrentAuthSession, ({ sessionId }) => {
					let revision = 1;
					const snapshot = { version: 1 as const, revision: 1, type: "snapshot" as const, payload: accessSnapshot(deps.auth, sessionId) };
					return Stream.concat(
						Stream.make(snapshot),
						fromListener<Any>((emit) => deps.auth.onAccessChange((change) => emit({ ...accessChangeEvent(deps.auth, change, sessionId), revision: ++revision }))),
					);
				}),
			),
		[`orchestration.subscribeShell`]: (input: Any) =>
			Stream.suspend(() => {
				const initial: Any[] = [{ kind: "snapshot", snapshot: bridge.shellSnapshot() }];
				if (input.requestCompletionMarker === true) initial.push({ kind: "synchronized" });
				return Stream.concat(Stream.fromIterable(initial), fromListener<Any>((emit) => bridge.onShell(emit)));
			}),
		[`orchestration.subscribeThread`]: (input: Any) =>
			Stream.unwrap(
				Effect.sync(() =>
					// A thread the host does not know fails the stream with the contract's typed not-found — never a fabricated
					// snapshot that leaves the panel open (design.md, Invariants).
					bridge.hasThread(input.threadId)
						? fromListener<Any>((emit, end) => {
								let first = true;
								// The stream ends when the thread is deleted.
								return bridge.subscribeThread(
									input.threadId,
									({ sequence, projection }) => {
										emit({ kind: "snapshot", snapshotSequence: sequence, projection });
										if (first && input.requestCompletionMarker === true) emit({ kind: "synchronized" });
										first = false;
									},
									end,
								);
							})
						: Stream.fail(new OrchestrationV2GetThreadProjectionError({ threadId: input.threadId, message: `Unknown thread: ${input.threadId}` } as Any)),
				),
			),
		[`orchestration.getThreadProjection`]: (input: Any) =>

			toPromiseEffect(
				() => bridge.projection(input.threadId),
				(message) => new OrchestrationV2GetThreadProjectionError({ threadId: input.threadId, message } as Any),
			).pipe(Effect.map((result) => result.projection)),
		[`orchestration.launchThread`]: (input: Any) =>
			toPromiseEffect(
				async () => {
					const message = input.initialMessage;
					const threadId = await bridge.launchThread({
						commandId: input.commandId,
						threadId: input.threadId,
						projectId: input.projectId,
						title: input.title,
						generateTitle: input.generateTitle === true,
						modelSelection: input.modelSelection,
						workspaceStrategy: input.workspaceStrategy,
						initialMessage: message === undefined ? undefined : { messageId: message.messageId, text: message.text, attachments: imageRecords(message.attachments) },
					});
					const { projection } = await bridge.projection(threadId);
					return { threadId, projection, resumed: false };
				},
				// The declared failure is `OrchestrationV2ThreadLaunchError`, and its payload names the project the client
				// asked about — the whole point of the field (design.md, Invariants).
				(message) => new OrchestrationV2ThreadLaunchError({ commandId: input.commandId, projectId: input.projectId, message }),
			),
		// T3's scheduled tasks, interval and fixed-time triggers (`scheduled-tasks.ts`); webhook triggers are refused with the
		// contract's typed error, which the edit dialog shows as a toast.
		"scheduledTasks.list": () => scheduled(async () => deps.scheduledTasks.list()),
		// T3's `subscribeList`: subscribed before the snapshot, so no change falls between; then a fresh list per change.
		"scheduledTasks.subscribe": () =>
			fromListener<Any>((emit) => {
				const stop = deps.scheduledTasks.onChange(() => emit(deps.scheduledTasks.list()));
				emit(deps.scheduledTasks.list());
				return stop;
			}),
		"scheduledTasks.upsert": (input: Any) => scheduled(async () => deps.scheduledTasks.upsert(input)),
		"scheduledTasks.setEnabled": (input: Any) => scheduled(async () => deps.scheduledTasks.setEnabled(input)),
		"scheduledTasks.delete": (input: Any) => scheduled(async () => deps.scheduledTasks.delete(input)),
		"scheduledTasks.runNow": (input: Any) => scheduled(() => deps.scheduledTasks.runNow(input)),
		"scheduledTasks.rotateWebhookToken": (input: Any) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		"scheduledTasks.listWebhookDeliveries": (input: Any) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		"scheduledTasks.getWebhookDelivery": (input: Any) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		[`orchestration.dispatchCommand`]: dispatch,
		// T3's command-palette / sidebar thread search, answered from the host's conversations (design.md, replication
		// rule). The client validates the query (2..200) and limit; `limit` defaults to T3's 50.
		[`orchestration.searchThreads`]: (input: Any) =>
			toPromiseEffect(
				() => bridge.searchThreads(input.query, input.limit ?? 50),
				(message) => new OrchestrationSearchThreadsError({ message }),
			),
	};

	if (deps.preview !== undefined) {
		const preview = deps.preview;
		Object.assign(handlers, {
			"preview.open": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(async () => preview.open(input))),
			"preview.navigate": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.navigate(input))),
			"preview.resize": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.resize(input))),
			"preview.adjust": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.adjust(input))),
			"preview.refresh": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.refresh(input))),
			"preview.close": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.close(input))),
			"preview.list": (input: Any) => withScope(AuthOrchestrationReadScope, () => Effect.sync(() => preview.list(input.threadId))),
			"preview.clearProfile": () => withScope(AuthPreviewOperateScope, () => Effect.sync(() => preview.clearProfile())),
			"preview.reportProfiles": () => withScope(AuthPreviewOperateScope, () => Effect.sync(() => preview.reportProfiles())),
			"preview.reportStatus": (input: Any) => withScope(AuthPreviewOperateScope, () => previewCall(() => preview.reportStatus(input))),
			subscribePreviewEvents: () => fromListener<Any>((emit) => preview.subscribe(emit)),
		});
	}

	const all: Record<string, (payload: Any) => Any> = {};
	for (const [tag, rpc] of WsRpcGroup.requests as unknown as Map<string, Any>) {
		const implemented = handlers[tag];
		if (implemented !== undefined) {
			all[tag] = implemented;
			continue;
		}
		// Every refusal names why, streams included: a stream that never ends leaves T3 waiting on a blank panel
		// (capabilities.md).
		all[tag] = () => {
			noteStub(tag);
			const message = tag.startsWith("terminal.") ? "Terminals are not supported by pi-durable-t3." : unsupportedMessage(tag);
			return RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.die(new CommandError(message)) : Effect.die(new CommandError(message));
		};
	}

	const handlersLayer = (WsRpcGroup as Any).toLayer(all) as Layer.Layer<never>;
	// Per-method authorization is not a middleware here: a standard grant holds every scope, and the one split a
	// narrowed grant can express — the file calls — is checked in their handlers (`withScope`).
	const authorization = Layer.succeed(RpcScopeAuthorization)((effect: Any) => effect) as Layer.Layer<never>;
	return Layer.merge(handlersLayer, authorization);
}
