// T3 `/ws` RPC handlers (Effect RPC over WsRpcGroup). The minimal viable surface is implemented; every other method
// gets a stub: streams stay open and silent, and unary calls answer with a benign value or a clear failure.
import {
	FilesystemBrowseError,
	type ExecutionEnvironmentDescriptor,
	OrchestrationV2DispatchCommandError,
	OrchestrationV2GetThreadProjectionError,
	OrchestrationV2ThreadLaunchError,
	ProjectMutationError,
	RpcScopeAuthorization,
	type ServerConfig,
	ServerSettingsError,
	WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcSchema from "effect/rpc/RpcSchema";
import { ProjectConflict, ProjectNotFound } from "../registry.ts";
import { type Bridge, CommandError } from "./bridge.ts";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseReadDirectoryFailed, BrowseWindowsPathUnsupported } from "./browse.ts";
import { serverCwd } from "./config.ts";
import type { Logger } from "./logging.ts";
import type { ModelCatalog } from "./models.ts";
import { PROVIDER_INSTANCE_ID } from "./projection.ts";

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
	"thread.settle",
	"thread.unsettle",
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
	"thread.unarchive": "Archiving is not supported by pi-durable-t3 yet.",
	"thread.snooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"thread.unsnooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"thread.metadata.update": "Renaming threads is not supported by pi-durable-t3 yet.",
	"runtime-request.respond": "pi runs without approvals; there is nothing to answer.",
	"provider.switch": "pi is the only provider.",
};

/**
 * A refusal the UI shows verbatim. "yet" claims we intend to build it: only the planned set says so, and
 * an untriaged call is refused flatly. `docs/capabilities.md` keeps the same statuses.
 */
function unsupportedMessage(type: string): string {
	if (UNSUPPORTED[type] !== undefined) return UNSUPPORTED[type];
	if (type.startsWith("queued-") || type === "queue.resume") return "Editing queued messages is not supported by pi-durable-t3 yet.";
	return `${type} is not supported by pi-durable-t3.`;
}

interface RpcDeps {
	readonly bridge: Bridge;
	readonly catalog: ModelCatalog;
	readonly descriptor: () => ExecutionEnvironmentDescriptor;
	readonly authDescriptor: Any;
	readonly log: Logger;
}

/** The host-wide settings T3 reads: the settings store's current document (the file decoded over the contract's
 * defaults, patched by `server.updateSettings`). The store is the source of truth, so `getSettings`,
 * `updateSettings`, and the config snapshot all agree — exactly as T3's server answers from its settings service. */
function serverSettings(deps: RpcDeps) {
	return deps.bridge.config.settings.current();
}

function serverConfig(deps: RpcDeps): ServerConfig {
	return {
		environment: deps.descriptor(),
		auth: deps.authDescriptor,
		// A host with no projects is still connectable: `serverCwd` (./config.ts) falls back to the state dir, so a cwd is
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
		shellResumeCompletionMarker: true,
		threadResumeCompletionMarker: true,
	} as Any;
}

const toPromiseEffect = <A>(run: () => Promise<A>, onError: (message: string) => Any) =>
	Effect.tryPromise({ try: run, catch: (error) => onError((error as Error).message || String(error)) });

export function makeRpcLayer(deps: RpcDeps) {
	const { bridge, log } = deps;
	const stubbed = new Set<string>();
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
					if (command.modelSelection?.model !== undefined) {
						await bridge.selectModel(command.threadId, command.modelSelection.model);
					}
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
					});
					break;
				}
				case "run.interrupt":
				case "thread.stop":
					await bridge.interrupt(command.threadId);
					break;
				case "thread.model-selection.set":
					await bridge.selectModel(command.threadId, command.modelSelection.model);
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
				case "thread.create":
					await bridge.createThread({ threadId: command.threadId, projectId: command.projectId });
					if (command.modelSelection?.model !== undefined) {
						await bridge.selectModel(command.threadId, command.modelSelection.model);
					}
					break;
				case "thread.runtime-mode.set":
					if (command.runtimeMode !== "full-access") throw new CommandError("pi runs tools without approvals; full-access is the only mode.");
					break;
				case "thread.interaction-mode.set":
					if (command.interactionMode !== "default") throw new CommandError("Plan mode is not supported by pi-durable-t3.");
					break;
				default:
					if (!SIDEBAR_NO_OPS.has(command.type)) throw new CommandError(unsupportedMessage(command.type));
					// Sidebar bookkeeping (settle, pin, visit, …) has no host state yet; accepting it changes nothing visible.
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
		"server.getConfig": () => Effect.sync(() => serverConfig(deps)),
		"server.refreshProviders": () => Effect.promise(() => deps.catalog.refresh()).pipe(Effect.map(() => ({ providers: deps.catalog.providers() }))),
		"server.getSettings": () => Effect.sync(() => serverSettings(deps)),
		// T3's settings write: a PATCH merged into the current settings (`updateSettings`), optionally with one
		// provider-instance mutation applied to the same snapshot (`updateProviderInstance`). The store persists, the
		// full settings answer, and the change signal emits `settingsUpdated` — T3's semantics, interpreted nowhere:
		// the bridge validates the model against no catalog, computes no defaults, and rewrites no keys.
		"server.updateSettings": (input: Any) =>
			Effect.try({
				try: () => {
					const settings = deps.bridge.config.settings;
					const patch = input?.patch ?? {};
					return input?.providerInstanceMutation === undefined ? settings.update(patch) : settings.updateProviderInstance(input.providerInstanceMutation, patch);
				},
				// The contract's error for this call, BUILT as the contract's class: `settingsPath` and `operation` are
				// required fields, and the hand-rolled `{_tag, message}` shape used to fail the schema encode at the RPC
				// boundary — the client received a `Die` defect, not a refusal. The specific reason rides in `cause`,
				// which the contract declares as an optional defect.
				catch: (error) =>
					new ServerSettingsError({
						settingsPath: deps.bridge.config.settings.path,
						operation: "write-file",
						providerInstanceId: PROVIDER_INSTANCE_ID,
						cause: error,
					}),
				}).pipe(
					Effect.tapError((error: ServerSettingsError) => Effect.sync(() => log.warn("settings update refused", { operation: error.operation, cause: error.cause instanceof Error ? error.cause.message : String(error.cause) }))),
				),
		// Projects are added/removed/edited through `projects.mutate` (the sendable surface). A duplicate path and a
		// non-empty remove map to the contract's typed errors; every refusal is a `ProjectMutationError` (T3's shape).
		"projects.mutate": (mutation: Any) =>
			Effect.tryPromise({
				try: () => bridge.mutateProject(mutation),
				catch: (error) =>
					new ProjectMutationError({
						commandId: mutation.commandId,
						message: error instanceof ProjectConflict || error instanceof ProjectNotFound ? error.message : (error as Error).message || String(error),
					}),
			}),
		// The read-only directory listing that feeds the "Add project" picker; T3's own semantics, this host's trust model.
		"filesystem.browse": (input: Any) =>
			Effect.tryPromise({
				try: () => browseFilesystem({ partialPath: input.partialPath, ...(input.cwd === undefined ? {} : { cwd: input.cwd }) }),
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
		"server.reportClientActivity": () => Effect.succeed({}),
		// The config stream a paired client reads its settings from. A settings write lands in the store, so the
		// store's change signal is what makes the edit visible: without the `settingsUpdated` event the pane re-renders
		// from its connect-time snapshot and the saved change looks like it reverted (the projection replaces
		// `config.settings` on exactly this event).
		subscribeServerConfig: () =>
			Stream.concat(
				Stream.make({ version: 1, type: "snapshot", config: serverConfig(deps) }),
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
		[`orchestration.subscribeShell`]: (input: Any) =>
			Stream.suspend(() => {
				const initial: Any[] = [{ kind: "snapshot", snapshot: bridge.shellSnapshot() }];
				if (input.requestCompletionMarker === true) initial.push({ kind: "synchronized" });
				return Stream.concat(Stream.fromIterable(initial), fromListener<Any>((emit) => bridge.onShell(emit)));
			}),
		[`orchestration.subscribeArchivedShell`]: () =>
			Stream.concat(
				Stream.make({
					kind: "snapshot",
					snapshot: { schemaVersion: 1, snapshotSequence: bridge.nextSequence(), projects: bridge.projects(), threads: [] },
				}),
				Stream.never,
			),
		[`orchestration.getArchivedShellSnapshot`]: () =>
			Effect.sync(() => ({ schemaVersion: 1, snapshotSequence: bridge.nextSequence(), projects: bridge.projects(), threads: [] })),
		[`orchestration.subscribeThread`]: (input: Any) =>
			Stream.unwrap(
				Effect.sync(() =>
					// A thread the host does not know fails the stream with the contract's typed not-found (the declared
					// stream error of `subscribeThread`) — it never emits a fabricated snapshot and stays open.
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
					const threadId = await bridge.createThread({ threadId: input.threadId, projectId: input.projectId });
					if (input.modelSelection?.model !== undefined) await bridge.selectModel(threadId, input.modelSelection.model);
					if (input.initialMessage !== undefined && input.initialMessage.text.trim().length > 0) {
						await bridge.idempotent(input.commandId, async () => {
							await bridge.sendMessage({
								threadId,
								commandId: input.commandId,
								messageId: input.initialMessage.messageId ?? `launch-${input.commandId}`,
								text: input.initialMessage.text,
								mode: "start",
							});
							return bridge.nextSequence();
						});
					}
					const { projection } = await bridge.projection(threadId);
					return { threadId, projection, resumed: false };
				},
				// The declared failure is `OrchestrationV2ThreadLaunchError` — its payload is `{ commandId, projectId,
				// message, cause? }`. Building it from the catch-all message alone and casting away the checker shipped
				// a payload WITHOUT `projectId`: not a `OrchestrationV2ThreadLaunchError`, so the encode failed at the
				// boundary and a strict client received a Defect ("Schema validation failed") where it asked "did the
				// launch work?". Name the project the client asked about — the whole point of the field.
				(message) => new OrchestrationV2ThreadLaunchError({ commandId: input.commandId, projectId: input.projectId, message }),
			),
		[`orchestration.dispatchCommand`]: dispatch,
	};

	const all: Record<string, (payload: Any) => Any> = {};
	for (const [tag, rpc] of WsRpcGroup.requests as unknown as Map<string, Any>) {
		const implemented = handlers[tag];
		if (implemented !== undefined) {
			all[tag] = implemented;
			continue;
		}
		// Every refusal names why, streams included: a stream that never ends leaves T3 waiting on a blank
		// panel, and a plain `${tag} is not supported` hides that a planned call is only missing "yet".
		all[tag] = () => {
			noteStub(tag);
			const message = tag.startsWith("terminal.") ? "Terminals are not supported by pi-durable-t3." : unsupportedMessage(tag);
			return RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.die(new CommandError(message)) : Effect.die(new CommandError(message));
		};
	}

	const handlersLayer = (WsRpcGroup as Any).toLayer(all) as Layer.Layer<never>;
	// Every paired client holds every standard scope; per-method authorization is not needed.
	const authorization = Layer.succeed(RpcScopeAuthorization)((effect: Any) => effect) as Layer.Layer<never>;
	return Layer.merge(handlersLayer, authorization);
}
