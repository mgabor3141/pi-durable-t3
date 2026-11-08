// T3 `/ws` RPC handlers (Effect RPC over WsRpcGroup), behind T3's per-method scope check. Every method this host does
// not implement is refused with a message the UI shows (`unsupported.ts`), streams included, and logged.
import { basename } from "node:path";
import {
	AssetAttachmentNotFoundError,
	SecretRequestError,
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
	type ServerConfig,
	ScheduledTaskError,
	ServerSettingsError,
	UsageReadError,
	WsRpcGroup,
} from "@t3tools/contracts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { ProjectConflict, ProjectNotFound } from "../registry.ts";
import { ProviderInstanceExists, SettingsReadError } from "../settings.ts";
import { accessChangeEvent, accessSnapshot } from "./access.ts";
import { type AuthStore } from "./auth.ts";
import { type Bridge, CommandError } from "./bridge.ts";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseReadDirectoryFailed, BrowseWindowsPathUnsupported } from "./browse.ts";
import { serverCwd } from "./config.ts";
import { EntriesError, FileError, type WorkspaceFiles } from "./files.ts";
import type { Logger } from "./logging.ts";
import type { ModelCatalog } from "./models.ts";
import { snapshotItem, subscriberFilter, type ThreadStreamItem, type ThreadStreamOptions } from "./thread-stream.ts";
import { RpcAuthorization } from "./t3-server.ts";
import { PROVIDER_INSTANCE_ID } from "./projection.ts";
import { CurrentAuthSession } from "./session-context.ts";
import { resolveServedEndpoint, type ServedEndpoint, type TailscaleCli } from "./tailscale.ts";
import { piUsagePricing, summarizeUsage } from "./usage.ts";
import type { Attachments } from "./attachments.ts";
import type { WorkspaceAssets } from "./workspace-assets.ts";
import { type ScheduledTasks, WEBHOOKS_UNSUPPORTED } from "./scheduled-tasks.ts";
import { AssetAccessError, AssetWorkspaceResolutionError, ThreadId, PreviewInvalidUrlError, PreviewSessionLookupError, type AuthEnvironmentScope } from "@t3tools/contracts";

const isAssetAccessError = Schema.is(AssetAccessError);
import type { PreviewSessions } from "./preview.ts";
import type { WsHandlers, WsItem, WsPayload, WsSuccess } from "./ws-types.ts";
import { attachmentRecords, clientProvenance, dispatchCommand } from "./dispatch.ts";
import { unsupportedMessage } from "./unsupported.ts";
import type { SecretRequests } from "./secret-requests.ts";

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

/** Items a thread subscriber may have unread before it is sent the current projection instead (T3's
 * `MAX_PENDING_UPDATES`). */
const MAX_PENDING_STREAM_ITEMS = 512;

interface RpcDeps {
	readonly bridge: Bridge;
	readonly files: WorkspaceFiles;
	readonly catalog: ModelCatalog;
	readonly descriptor: () => ExecutionEnvironmentDescriptor;
	readonly authDescriptor: ServerConfig["auth"];
	readonly auth: AuthStore;
	/** Absent: the host takes no attachments (no `attachmentsDir`). */
	readonly attachments: Attachments | undefined;
	readonly assets: WorkspaceAssets;
	readonly scheduledTasks: ScheduledTasks;
	readonly tailscale: TailscaleCli;
	readonly preview: PreviewSessions | undefined;
	readonly secretRequests: SecretRequests;
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
	};
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

/** A config read as the contract declares its failure: the settings error T3 raises when it cannot read its config. */
const readConfigEffect = (deps: RpcDeps) =>
	Effect.tryPromise({
		try: () => readServerConfig(deps),
		catch: (cause) => new ServerSettingsError({ settingsPath: deps.bridge.config.settings.path, operation: "read-file", cause }),
	});

const toPromiseEffect = <A, E>(run: () => Promise<A>, onError: (message: string) => E): Effect.Effect<A, E> =>
	Effect.tryPromise({ try: run, catch: (error) => onError((error as Error).message || String(error)) });

/** A scheduled-task call: its refusals are already the contract's `ScheduledTaskError`; anything else becomes one. */
const scheduled = <A>(run: () => Promise<A>) =>
	Effect.tryPromise({
		try: run,
		catch: (error) => (error instanceof ScheduledTaskError ? error : new ScheduledTaskError({ message: (error as Error).message || String(error) })),
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

/** The attachments, for a call that needs them; a host without an `attachmentsDir` takes none. */
function takesAttachments(deps: RpcDeps): Attachments {
	if (deps.attachments === undefined) throw new Error("This host takes no attachments: attachT3 was given no attachmentsDir.");
	return deps.attachments;
}

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
	const rpcLog = bridge.config.rpcLog;
	const now = () => Date.now();
	const elapsed = (started: number) => Math.max(0, now() - started);
	const callSink = (sink: ((call: Any) => void) | undefined, call: Any) => {
		if (sink === undefined) return;
		try {
			sink(call);
		} catch (error) {
			// A debug callback must never turn into a broken RPC: report the sink's own failure and continue.
			log.warn("RPC log callback failed", { method: call.method, error: error instanceof Error ? error.message : String(error) });
		}
	};
	const failureMessage = (cause: Any) => {
		const error = Cause.isCause(cause) ? Cause.squash(cause) : cause;
		return error instanceof Error ? error.message : String(error);
	};
	/** Wrap one implemented handler: success/failure callbacks carry the method, kind and duration. Streams report when
	 * they open (their later failures are the stream's own). */
	const observe = (tag: string, handler: (payload: Any) => Any, stream: boolean): ((payload: Any) => Any) =>
		(payload) => {
			const started = now();
			if (stream) {
				try {
					const value = handler(payload);
					callSink(rpcLog?.onSuccess, { method: tag, kind: "stream", durationMs: elapsed(started) });
					return value;
				} catch (error) {
					callSink(rpcLog?.onFailure, { method: tag, kind: "stream", durationMs: elapsed(started), error: error instanceof Error ? error.message : String(error) });
					throw error;
				}
			}
			let effect: Any;
			try {
				effect = handler(payload);
			} catch (error) {
				callSink(rpcLog?.onFailure, { method: tag, kind: "request", durationMs: elapsed(started), error: error instanceof Error ? error.message : String(error) });
				throw error;
			}
			return Effect.matchCauseEffect(effect, {
				onFailure: (cause) => {
					callSink(rpcLog?.onFailure, { method: tag, kind: "request", durationMs: elapsed(started), error: failureMessage(cause) });
					return Effect.failCause(cause);
				},
				onSuccess: (value) => {
					callSink(rpcLog?.onSuccess, { method: tag, kind: "request", durationMs: elapsed(started) });
					return Effect.succeed(value);
				},
			});
		};
	const noteStub = (tag: string) => {
		if (stubbed.has(tag)) return;
		stubbed.add(tag);
		log.info("stubbed RPC called", { method: tag });
	};

	const dispatch = (command: WsPayload<"orchestration.dispatchCommand">) =>
		toPromiseEffect(
			() => dispatchCommand(bridge, command, clientProvenance(command), log),
			(message) => new OrchestrationV2DispatchCommandError({ commandId: command.commandId, commandType: command.type, message }),
		).pipe(
			Effect.map((sequence) => ({ sequence })),
			Effect.tapError((error) => Effect.sync(() => log.warn("command failed", { type: command.type, error: error.message }))),
		);

	const handlers: WsHandlers = {
		"server.probe": () => Effect.succeed({}),
		"server.getConfig": () => readConfigEffect(deps),
		"server.refreshProviders": () => Effect.promise(() => deps.catalog.refresh()).pipe(Effect.map(() => ({ providers: deps.catalog.providers() }))),
		// Onboarding step 3 scans each environment for importable agent sessions. This host has none to import — the
		// agent's conversations live in pi-durable, not in a Codex/Claude home directory — so it is answered truthfully
		// with an empty scan. The rest of `agentSessions.*` (import) stays refused (capabilities.md).
		"agentSessions.scan": () => Effect.sync(() => ({ candidates: [], scannedAt: new Date().toISOString() })),
		// T3's settings write, replicated (design.md): a PATCH merged into the current settings, optionally with one
		// provider-instance mutation applied to the same snapshot.
		"server.updateSettings": (input) =>
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
						: error instanceof SettingsReadError
							? new ServerSettingsError({ settingsPath: deps.bridge.config.settings.path, operation: "read-file", cause: error.cause })
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
		"projects.mutate": (mutation) =>
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
		"filesystem.browse": (input) =>
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
		"projects.listEntries": (input) =>
			Effect.tryPromise({ try: () => deps.files.list(input), catch: (error) => new ProjectListEntriesError({ cwd: input.cwd, ...entriesFailure(error) }) }),
		"projects.searchEntries": (input) =>
			Effect.tryPromise({ try: () => deps.files.searchEntries(input), catch: (error) => new ProjectSearchEntriesError({ cwd: input.cwd, queryLength: input.query.length, limit: input.limit, ...entriesFailure(error) }) }),
		"projects.searchContents": (input) =>
			Effect.tryPromise({ try: () => deps.files.searchContents(input), catch: (error) => new ProjectSearchContentsError({ cwd: input.cwd, queryLength: input.query.length, limit: input.limit, ...entriesFailure(error) }) }),
		"projects.readFile": (input) =>
			Effect.tryPromise({ try: () => deps.files.readFile(input), catch: (error) => new ProjectReadFileError({ cwd: input.cwd, relativePath: input.relativePath, ...fileFailure(error) }) }),
		"projects.writeFile": (input) =>
			Effect.tryPromise({ try: () => deps.files.writeFile(input), catch: (error) => new ProjectWriteFileError({ cwd: input.cwd, relativePath: input.relativePath, ...fileFailure(error) }) }),
		"server.reportClientActivity": () => Effect.void,
		// T3's secret card: the user's answer to a `request_secret` call, saved into the asking tool's store (`secret-requests.ts`).
		"secrets.answerRequest": (input) =>
			Effect.tryPromise({
				try: () => deps.secretRequests.answer(input),
				catch: (error) => (error instanceof SecretRequestError ? error : new SecretRequestError({ reason: "store_failed", cause: error })),
			}),
		// T3's usage view. `server.getUsageSummary` is answered from what pi-durable records per turn (tokens, cost,
		// model) — replicated bucketing from T3, provider-reported cost, fields pi has no value for omitted (see
		// `usage.ts`). An invalid window is T3's typed `UsageReadError` (the client shows it); a scan that throws while
		// reading conversations is `scanFailed`. `server.refreshUsageRates` is on the client's refresh path: it answers
		// this host's pricing truthfully (no rate table — pi prices its own turns), never a fetched LiteLLM table.
		"server.getUsageSummary": (input) =>
			Effect.tryPromise({
				try: () => bridge.usageConversations().then((conversations) => summarizeUsage(input, conversations, bridge.config.stateDir)),
				catch: (error) =>
					error instanceof UsageReadError
						? error
						: new UsageReadError({ reason: "scanFailed", detail: (error as Error).message || "The usage scan failed.", cause: error }),
			}),
		"server.refreshUsageRates": () => Effect.sync(() => piUsagePricing()),
		// Attachments (capabilities.md): uploads wait in the state dir until their message is sent, which keeps them in the
		// environment (`attachments.ts`). Without an `attachmentsDir` the host advertises no uploads, so a client never
		// calls these; one that does anyway fails.
		"attachments.createUploadUrl": (input) =>
			Effect.sync(() => takesAttachments(deps).mintUpload(input)),
		"attachments.delete": (input) =>
			Effect.sync(() => deps.attachments?.deleteUpload(input.attachmentId)),
		// T3's data-URL path: the client sends an image inline, and it is kept in the environment at once.
		"assets.persistChatAttachments": (input) =>
			Effect.tryPromise({
				try: async () => ({ attachments: await takesAttachments(deps).persist(input.threadId, input.messageId, input.attachments ?? []) }),
				catch: (error) => new PersistChatAttachmentsError({ message: (error as Error).message || String(error) }),
			}),
		"assets.createUrl": (input) => {
			const resource = input.resource;
						if (resource?._tag === "workspace-file" || resource?._tag === "media-file" || resource?._tag === "draft-workspace-file") {
				return Effect.tryPromise({
					try: () => deps.assets.issue(resource),
					// \`issue\` throws the contract's own asset errors; anything else (the environment failing) is a resolution failure.
					catch: (error) => (isAssetAccessError(error) ? error : new AssetWorkspaceResolutionError({ resource, cause: error })),
				});
			}
			// Favicon/tool-output/github resources are not served by this host: the file panel reads text through `projects.readFile`.
			if (resource?._tag !== "attachment") return Effect.fail(new AssetPreviewTypeValidationError({ resource }));
			const attachments = deps.attachments;
			if (attachments === undefined) return Effect.fail(new AssetAttachmentNotFoundError({ resource }));
			return Effect.promise(() =>
				attachments
					.mintAssetUrl({
						attachmentId: resource.attachmentId,
						...(typeof resource.fileName === "string" ? { fileName: resource.fileName } : {}),
						...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
					})
					.catch(() => null),
			).pipe(Effect.flatMap((minted) => (minted === null ? Effect.fail(new AssetAttachmentNotFoundError({ resource })) : Effect.succeed(minted))));
		},
		// The config stream: the store's change signal is what emits `settingsUpdated`, the event on which the projection
		// replaces `config.settings` (capabilities.md).
		subscribeServerConfig: () =>
			Stream.concat(
				Stream.fromEffect(readConfigEffect(deps)).pipe(
					Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
				),
				fromListener<WsItem<"subscribeServerConfig">>((emit) => {
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
			return Stream.concat(Stream.make<WsItem<"subscribeServerLifecycle">[]>({ version: 1, sequence: 0, type: "welcome", payload: { environment, cwd, projectName: basename(cwd) || cwd } }, { version: 1, sequence: 1, type: "ready", payload: { at: new Date().toISOString(), environment } }), Stream.never);
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
						fromListener<WsItem<"subscribeAuthAccess">>((emit) => deps.auth.onAccessChange((change) => emit({ ...accessChangeEvent(deps.auth, change, sessionId), revision: ++revision }))),
					);
				}),
			),
		[`orchestration.getArchivedShellSnapshot`]: () => Effect.sync(() => bridge.archivedShellSnapshot() as unknown as WsSuccess<"orchestration.getArchivedShellSnapshot">),
		[`orchestration.subscribeShell`]: (input) =>
			Stream.suspend(() => {
				const initial: WsItem<"orchestration.subscribeShell">[] = [{ kind: "snapshot", snapshot: bridge.shellSnapshot() }];
				if (input.requestCompletionMarker === true) initial.push({ kind: "synchronized" });
				return Stream.concat(Stream.fromIterable(initial), fromListener<WsItem<"orchestration.subscribeShell">>((emit) => bridge.onShell(emit)));
			}),
		// T3's thread stream (`subscribeOrchestrationV2Thread`): the events after `afterSequence` when the host can replay
		// them, else a snapshot — bounded when the client accepts one — then live events; one completion marker after the
		// first update. A thread the host does not know fails the stream with the contract's typed not-found — never a
		// fabricated snapshot that leaves the panel open (design.md, Invariants).
		[`orchestration.subscribeThread`]: (input) =>
			Stream.unwrap(
				Effect.sync(() => {
					if (!bridge.hasThread(input.threadId)) {
						return Stream.fail(new OrchestrationV2GetThreadProjectionError({ threadId: input.threadId, message: `Unknown thread: ${input.threadId}` }));
					}
					const options: ThreadStreamOptions = {
						bounded: input.acceptBoundedSnapshot === true,
						deferWork: input.acceptDeferredWork === true,
						compactTurnItems: input.acceptCompactTurnItems === true,
						dedupeBodies: input.acceptDedupedBodies === true,
						compactIds: input.acceptCompactIds === true,
					};
					const filter = subscriberFilter(options);
					let first = true;
					return Stream.callback<ThreadStreamItem>((queue) =>
						Effect.acquireRelease(
							Effect.sync(() =>
								// The stream ends when the thread is deleted.
								bridge.subscribeThread(
									input.threadId,
									input.afterSequence,
									(update) => {
										if (update.kind === "snapshot") {
											// A snapshot supersedes whatever the client has not read yet.
											Queue.flushUnsafe(queue);
											Queue.offerUnsafe(queue, filter(snapshotItem(update.sequence, update.projection, options)));
										} else {
											// A client this far behind gets the current projection instead of the backlog (T3's live budget).
											if (Queue.sizeUnsafe(queue) + update.items.length > MAX_PENDING_STREAM_ITEMS) {
												const current = bridge.currentStream(input.threadId);
												Queue.flushUnsafe(queue);
												if (current !== undefined) Queue.offerUnsafe(queue, filter(snapshotItem(current.sequence, current.projection, options)));
											} else {
												for (const item of update.items) Queue.offerUnsafe(queue, filter(item));
											}
										}
										if (first) {
											first = false;
											if (input.requestCompletionMarker === true) Queue.offerUnsafe(queue, { kind: "synchronized" } as ThreadStreamItem);
										}
									},
									() => Queue.endUnsafe(queue),
								),
							),
							(unsubscribe) => Effect.sync(unsubscribe),
						),
					);
				}),
			),
		[`orchestration.getThreadProjection`]: (input) =>

			toPromiseEffect(
				() => bridge.projection(input.threadId),
				(message) => new OrchestrationV2GetThreadProjectionError({ threadId: input.threadId, message }),
			).pipe(Effect.map((result) => result.projection)),
		[`orchestration.launchThread`]: (input) =>
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
						provenance: { createdBy: "user", creationSource: input.creationSource ?? "web" },
						initialMessage:
							message === undefined
								? undefined
								: {
										messageId: message.messageId,
										text: message.text,
										...(message.context === undefined ? {} : { context: message.context }),
										attachments: attachmentRecords(message.attachments),
									},
					});
					const { projection } = await bridge.projection(threadId);
					return { threadId: ThreadId.make(threadId), projection, resumed: false };
				},
				// The declared failure is `OrchestrationV2ThreadLaunchError`, and its payload names the project the client
				// asked about — the whole point of the field (design.md, Invariants).
				(message) => new OrchestrationV2ThreadLaunchError({ commandId: input.commandId, projectId: input.projectId, message }),
			),
		// T3's scheduled tasks, interval and fixed-time triggers (`scheduled-tasks.ts`); webhook triggers are refused with the
		// contract's typed error, which the edit dialog shows as a toast.
		// T3's `subscribeList`: subscribed before the snapshot, so no change falls between; then a fresh list per change.
		"scheduledTasks.subscribe": () =>
			fromListener<WsItem<"scheduledTasks.subscribe">>((emit) => {
				const stop = deps.scheduledTasks.onChange(() => emit(deps.scheduledTasks.list()));
				emit(deps.scheduledTasks.list());
				return stop;
			}),
		"scheduledTasks.upsert": (input) => scheduled(async () => deps.scheduledTasks.upsert(input)),
		"scheduledTasks.setEnabled": (input) => scheduled(async () => deps.scheduledTasks.setEnabled(input)),
		"scheduledTasks.delete": (input) => scheduled(async () => deps.scheduledTasks.delete(input)),
		"scheduledTasks.runNow": (input) => scheduled(() => deps.scheduledTasks.runNow(input)),
		"scheduledTasks.rotateWebhookToken": (input) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		"scheduledTasks.listWebhookDeliveries": (input) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		"scheduledTasks.getWebhookDelivery": (input) => Effect.fail(new ScheduledTaskError({ message: WEBHOOKS_UNSUPPORTED, taskId: input.id })),
		[`orchestration.dispatchCommand`]: dispatch,
		// T3's command-palette / sidebar thread search, answered from the host's conversations (design.md, replication
		// rule). The client validates the query (2..200) and limit; `limit` defaults to T3's 50.
		[`orchestration.searchThreads`]: (input) =>
			toPromiseEffect(
				() => bridge.searchThreads(input.query, input.limit ?? 50),
				(message) => new OrchestrationSearchThreadsError({ message }),
			),
	};

	if (deps.preview !== undefined) {
		const preview = deps.preview;
		const previewHandlers: WsHandlers = {
			"preview.open": (input) => previewCall(async () => preview.open(input)),
			"preview.resize": (input) => previewCall(() => preview.resize(input)),
			"preview.adjust": (input) => previewCall(() => preview.adjust(input)),
			"preview.close": (input) => previewCall(() => preview.close(input)),
			"preview.list": (input) => Effect.sync(() => preview.list(input.threadId)),
			"preview.clearProfile": () => Effect.sync(() => preview.clearProfile()),
			"preview.reportProfiles": () => Effect.sync(() => preview.reportProfiles()),
			"preview.reportStatus": (input) => previewCall(() => preview.reportStatus(input)),
			subscribePreviewEvents: () => fromListener<WsItem<"subscribePreviewEvents">>((emit) => preview.subscribe(emit)),
		};
		Object.assign(handlers, previewHandlers);
	}

	const all: Record<string, (payload: Any) => Any> = {};
	for (const [tag, rpc] of WsRpcGroup.requests as unknown as Map<string, Any>) {
		const implemented = (handlers as Record<string, ((payload: Any) => Any) | undefined>)[tag];
		const stream = RpcSchema.isStreamSchema(rpc.successSchema);
		if (implemented !== undefined) {
			all[tag] = observe(tag, implemented, stream);
			continue;
		}
		// Every refusal names why, streams included: a stream that never ends leaves T3 waiting on a blank panel
		// (capabilities.md).
		all[tag] = () => {
			const started = now();
			noteStub(tag);
			const message = tag.startsWith("terminal.") ? "Terminals are not supported by pi-durable-t3." : unsupportedMessage(tag);
			callSink(rpcLog?.onStubbed, { method: tag, kind: stream ? "stream" : "request", reason: message, durationMs: elapsed(started) });
			return stream ? Stream.die(new CommandError(message)) : Effect.die(new CommandError(message));
		};
	}

	const handlersLayer = (WsRpcGroup as Any).toLayer(all) as Layer.Layer<never>;
	// T3's per-method authorization (`auth/RpcAuthorization.ts`, vendored): every call needs its scope, checked against the
	// socket's session before the handler runs, and refused with the contract's `EnvironmentAuthorizationError`.
	const authorization = Layer.unwrap(Effect.map(CurrentAuthSession, ({ scopes }) => RpcAuthorization.layer(scopes as AuthEnvironmentScope[]))) as unknown as Layer.Layer<never>;
	return Layer.merge(handlersLayer, authorization);
}
