// The T3 view over the host's threads: the threads layer (`../threads.ts`) for every write, the directory and the shell,
// and one `ThreadView` per open thread (`thread-view.ts`: its head watch, projection and stream). Commands land here.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DateTime } from "effect";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type {
	OrchestrationMessageContext,
	OrchestrationProjectShell,
	OrchestrationSearchThreadsResult,
	OrchestrationV2ShellSnapshot,
	OrchestrationV2ThreadProjection,
	OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { Project } from "../config.ts";
import { ProjectConflict, ProjectIdConflict, ProjectWorkspaceMissing, ProjectWorkspaceNotCreatable, ProjectWorkspaceNotDirectory } from "../registry.ts";
import { claimScratchThreadFolder, ensureScratchProject, isScratchRoot, SCRATCH_PROJECT_ICON } from "../scratch.ts";
import { type Provenance, type Spawn, type SummaryRun, type Thread, type ThreadLineage, type ThreadRecord, type Threads, USER_WEB } from "../threads.ts";
import type { AttachmentRecord, Attachments, KeptAttachment } from "./attachments.ts";
import type { BridgeConfig, TitleThreadRequest } from "./config.ts";
import type { AgentChange, ConversationId, EntryId, TaskGraph, TaskGraphWatch } from "@earendil-works/pi-durable";
import { autoSettleAt, autoSettleDays, recordThreadOpen } from "./sidebar.ts";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { Logger } from "./logging.ts";
import type { WsItem, WsSuccess } from "./ws-types.ts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { type ConversationView, type ContentBlock, type EntryRecord, type ModelRef, splitSlug, thinkingOf } from "./model-types.ts";
import type { TextGenerationModel } from "./title-thread.ts";
import { type ChildCard, type ProjectionResult, projectThread, type ThreadMeta, PROVIDER_INSTANCE_ID } from "./projection.ts";
import { attachmentsOf, USER_ENTRY_KINDS } from "./runs.ts";
import { undoTarget } from "./undo.ts";

import { CommandError } from "./errors.ts";
import { type CatalogEntry, type StreamUpdate, ThreadView, type ThreadViewHost } from "./thread-view.ts";

export { CommandError, type StreamUpdate };


/** The image blocks a prompt carries, gated on the model's capabilities: ONLY a model whose catalog `input` includes
 * "image" receives the bytes; a model that does not (or one absent from the catalog) gets the text alone — the
 * attachment is still recorded on the entry for display. pi-ai accepts image content only for image-input models. */
/** Rebind the context's attachment ids to the adopted copies, so its inline image/file references keep resolving
 * after the client deletes the pending upload. */
function rebindContext(
	context: OrchestrationMessageContext | undefined,
	before: readonly AttachmentRecord[] | undefined,
	after: readonly AttachmentRecord[] | undefined,
): OrchestrationMessageContext | undefined {
	if (context === undefined || before === undefined || after === undefined) return context;
	const ids = new Map(before.map((attachment, index) => [attachment.id, after[index]?.id ?? attachment.id]));
	return {
		version: 1,
		records: context.records.map((record) =>
			"attachmentId" in record ? { ...record, attachmentId: ids.get(record.attachmentId) ?? record.attachmentId } : record,
		),
	};
}

export function selectImageBlocks(
	catalog: readonly { provider: string; modelId: string; input: string[] }[],
	model: { provider: string; modelId: string } | null,
	attachments: readonly AttachmentRecord[] | undefined,
	read: (attachmentId: string) => { data: string; mimeType: string } | null,
): ContentBlock[] | undefined {
	if (attachments === undefined || attachments.length === 0) return undefined;
	const entry = model === null ? undefined : catalog.find((m) => m.provider === model.provider && m.modelId === model.modelId);
	if (entry === undefined || !entry.input.includes("image")) return undefined;
	const blocks: ContentBlock[] = [];
	for (const attachment of attachments) {
		if (attachment.type === "file") continue;
		const image = read(attachment.id);
		if (image === null) continue;
		blocks.push({ type: "image", data: image.data, mimeType: attachment.mimeType });
	}
	return blocks.length === 0 ? undefined : blocks;
}


const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A live shell item: everything \`orchestration.subscribeShell\` streams after its snapshot. */
type ShellItem = Exclude<WsItem<"orchestration.subscribeShell">, { readonly kind: "snapshot" } | { readonly kind: "synchronized" }>;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** One `projects.mutate` payload, as the facet decoded it. */
export type ProjectMutation = {
	readonly type: "project.create" | "project.update" | "project.delete";
	readonly projectId: string;
	readonly commandId: string;
	readonly title?: string;
	readonly workspaceRoot?: string;
	readonly createWorkspaceRootIfMissing?: boolean;
	readonly force?: boolean;
};



/** How often T3 sweeps for threads to settle (`ThreadSettlementService`: every minute). */
const SETTLE_SWEEP_MS = 60_000;

export class Bridge {
	readonly config: BridgeConfig;
	readonly #store: Threads;
	readonly #models: Models;
	readonly #log: Logger;
	readonly #attachments: Attachments | undefined;
	readonly #views = new Map<string, ThreadView>();
	readonly #viewHost: ThreadViewHost;
	readonly #shellListeners = new Set<(item: ShellItem) => void>();
	readonly #deletedListeners = new Set<(threadId: string) => void>();
	readonly #shells = new Map<string, OrchestrationV2ThreadShell>();
	/** The project ids last shown to clients, so a registry change emits the removed shells. */
	#projectIds = new Set<string>();
	readonly #commandResults = new Map<string, Promise<number>>();
	/** T3's `thread.titleRegeneration`, per thread: the one current title request. In memory only (state.md). */
	readonly #titleRequests = new Map<string, { requestId: string; startedAt: number; controller: AbortController }>();
	#directory: Thread[] = [];
	/** Settles once the directory is first loaded. */
	readonly #loaded = Promise.withResolvers<void>();
	#changeStop: (() => void) | undefined;
	#directoryBooted = false;
	#registryStop: (() => void) | undefined;
	#closed = false;
	#sequence = 0;
	#startedAt = new Date().toISOString();
	/** A hold per running thread, keeping it open until its run ends: the bridge sees every run end (and the sidebar, T3's
	 * notifications and a parent's card with it) whether or not a client is looking. */
	readonly #runHolds = new Map<string, () => void>();
	/** The live tasks at the last task-graph frame. */
	#liveTasks = new Set<string>();
	#taskWatch: TaskGraphWatch | undefined;
	#settleTimer: NodeJS.Timeout | undefined;
	#settingsStop: (() => void) | undefined;
	#sweeping = false;

	constructor(config: BridgeConfig, log: Logger, store: Threads, models: Models, attachments?: Attachments) {
		this.config = config;
		this.#log = log;
		this.#store = store;
		this.#models = models;
		this.#attachments = attachments;
		const bridge = this;
		this.#viewHost = {
			get harness() {
				return store.harness;
			},
			log,
			head: (threadId) => this.#summary(threadId)?.head,
			undos: (threadId) => this.#summary(threadId)?.undos ?? [],
			catalog: (): CatalogEntry[] => this.#models.getModels().map((model) => ({ provider: model.provider, modelId: model.id, input: [...model.input], contextWindow: model.contextWindow })),
			meta: (threadId, view) => this.#meta(threadId, this.#summary(threadId), view),
			nextSequence: () => bridge.nextSequence(),
			projected: (view, change) => this.#projected(view, change),
		};
	}

	start(): void {
		// The threads layer announces every committed change before the write returns: the directory is current after any
		// awaited write, with no read of its own.
		this.#changeStop = this.#store.onChange((threadIds) => this.#applyDirectory(threadIds));
		void this.#store
			.load()
			.then(() => {
				this.#applyDirectory(undefined);
				void this.#watchRuns();
				void this.sweepSettlement();
			})
			.catch((error: unknown) => this.#log.warn("the thread directory failed to load", { error: error instanceof Error ? error.message : String(error) }));
		// T3's settlement sweep: every minute, and when the settings change.
		this.#settleTimer = setInterval(() => void this.sweepSettlement(), SETTLE_SWEEP_MS);
		this.#settleTimer.unref();
		this.#settingsStop = this.config.settings.subscribe(() => void this.sweepSettlement());
		// A UI edit to the registry (add/remove/rename/move) lands here: removed ids emit a removal and every current
		// project shell is re-emitted — a client keys shells by id, so an unchanged re-emission is a no-op.
		this.#projectIds = new Set(this.#configured().map((project) => project.id));
		this.#registryStop = this.config.registry.subscribe(() => this.#onRegistryChange());
		this.#log.info("bridge started");
	}

	/** The directory changed (`changed`: these threads; `undefined`: the first load). Open threads whose head moved follow the
	 * new head; the changed threads are re-projected; removed ones emit their removal. */
	#applyDirectory(changed: ReadonlySet<string> | undefined): void {
		if (this.#closed) return;
		this.#directory = this.#store.snapshot();
		const touched = new Set(changed ?? this.#directory.map((thread) => thread.threadId));
		for (const thread of this.#directory) {
			if (!touched.has(thread.threadId)) continue;
			this.#views.get(thread.threadId)?.moved(thread.head);
		}
		this.#refreshShells(touched);
		if (!this.#directoryBooted) {
			this.#directoryBooted = true;
			this.#loaded.resolve();
		}
	}

	#onRegistryChange(): void {
		const current = this.#configured();
		const currentIds = new Set(current.map((project) => project.id));
		for (const id of [...this.#projectIds]) {
			if (currentIds.has(id)) continue;
			this.#emitShell({ kind: "project.removed", sequence: this.nextSequence(), projectId: ProjectId.make(id) });
		}
		for (const project of current) {
			this.#emitShell({ kind: "project.updated", sequence: this.nextSequence(), project: this.#projectShell(project) });
		}
		this.#projectIds = currentIds;
		this.#refreshShells();
	}
	/** Strictly increasing across restarts (clock-based) so clients never drop items as stale. */
	nextSequence(): number {
		this.#sequence = Math.max(this.#sequence + 1, Date.now());
		return this.#sequence;
	}

	// ---- projects ---------------------------------------------------------------------------------------------

	/** The folder of threads without a project (T3's `ServerConfig.scratchWorkspaceRoot`), when the host configured one. */
	get scratchRoot(): string | undefined {
		return this.config.scratchDir;
	}

	/**
	 * `projects.ensureScratch`, answered exactly as T3's server answers it (design.md, replication rule): re-make the
	 * folder, then find-or-create the project rooted at it, and answer its id. The client's `openScratch` atom then
	 * waits for the project in its own store — which is what a registry change emits over the shell stream. With no
	 * scratch dir configured the feature is off: refused with a message the UI shows.
	 */
	async ensureScratch(): Promise<{ readonly projectId: ProjectId }> {
		const root = this.config.scratchDir;
		if (root === undefined) throw new CommandError("This host has no Scratch folder (no scratch dir is configured).");
		const env = this.config.env;
		if (env === undefined) throw new CommandError("This host has no execution environment.");
		const { projectId } = await ensureScratchProject(this.config.registry, root, env, this.config.context ?? BACKGROUND_CONTEXT);
		return { projectId: ProjectId.make(projectId) };
	}

	/** T3's `ManagedProjectFolders.isScratchProject`: the project is rooted at the scratch dir. */
	isScratchProject(projectId: string): boolean {
		const root = this.config.scratchDir;
		const project = this.config.registry.list().find((p) => p.id === projectId);
		return root !== undefined && project !== undefined && isScratchRoot(project.cwd, root);
	}

	/** The registered projects (from the live registry), shaped for the shell. */
	#configured(): { id: string; title: string; path: string }[] {
		return this.config.registry.list().map((project) => ({ id: project.id, title: project.name, path: project.cwd }));
	}

	/** A project shell with the fixed fields T3 expects, stamped at the bridge's start time. The Scratch project carries
	 * T3's icon, derived from its root: this host stores no icons, so no stored choice can be overwritten. */
	#projectShell(project: { id: string; title: string; path: string }): OrchestrationProjectShell {
		return {
			id: project.id,
			title: project.title,
			workspaceRoot: project.path,
			repositoryIdentity: null,
			defaultModelSelection: null,
			...(this.config.scratchDir !== undefined && isScratchRoot(project.path, this.config.scratchDir) ? { projectIcon: SCRATCH_PROJECT_ICON } : {}),
			scripts: [],
			createdAt: this.#startedAt,
			updatedAt: this.#startedAt,
		} as unknown as OrchestrationProjectShell;
	}

	projects(): OrchestrationProjectShell[] {
		return this.#configured().map((p) => this.#projectShell(p));
	}

	/** Every project as the contract's `Project` record (`GET /api/projects`). */
	projectRecords(): WsSuccess<"projects.mutate">[] {
		return this.config.registry.list().map((entry) => this.#projectResult(entry, null));
	}

		/**
	 * One project mutation, answered from the state — no receipt store (design.md, Invariants).
	 */
	mutateProject(mutation: ProjectMutation): Promise<WsSuccess<"projects.mutate">> {
		return this.#applyMutation(mutation);
	}

	async #applyMutation(mutation: ProjectMutation): Promise<WsSuccess<"projects.mutate">> {
		switch (mutation.type) {
			case "project.create": {
				if (mutation.workspaceRoot === undefined) throw new CommandError("A project needs a workspace root (a folder path).");
				await this.#ensureWorkspaceRoot(this.config.registry.resolvePath(mutation.workspaceRoot), mutation.createWorkspaceRootIfMissing === true);
				// Honor the id the client minted; the registry derives from the normalized path for everything else (design.md, IDs).
				const added = await this.#createProject(mutation.title, mutation.workspaceRoot, mutation.projectId);
				return this.#projectResult(added, null);
			}
			case "project.update": {
				// A move names a new root: T3 normalizes an update's root WITHOUT creating it (`ProjectService.update`).
				if (mutation.workspaceRoot !== undefined) await this.#ensureWorkspaceRoot(this.config.registry.resolvePath(mutation.workspaceRoot), false);
				const updated = await this.config.registry.update(mutation.projectId, {
					...(mutation.title === undefined ? {} : { title: mutation.title }),
					...(mutation.workspaceRoot === undefined ? {} : { path: mutation.workspaceRoot }),
				});
				return this.#projectResult(updated, null);
			}
			case "project.delete": {
				const entry = this.config.registry.list().find((project) => project.id === mutation.projectId);
				if (entry === undefined) throw new CommandError(`Project ${mutation.projectId} was not found.`);
				const targets = this.#directory.filter((thread) => thread.projectId === mutation.projectId);
				if (targets.length > 0 && mutation.force !== true) throw new CommandError(`Project ${mutation.projectId} is not empty.`);
				// Drop the threads FIRST (aborts each head, then removes the pointer), then the entry: files on disk are never
				// part of this operation (design.md, Invariants).
				for (const thread of targets) await this.deleteThread(thread.threadId);
				await this.config.registry.remove(mutation.projectId);
				// Drain late arrivals: read the document (current after each awaited delete) until it shows no rows under
				// the id. Rows landing from `registry.remove` onward are refused by the commit-time FK check, so the drain
				// terminates (design.md, Invariants).
				for (;;) {
					const late = (await this.#store.list()).filter((thread) => thread.projectId === mutation.projectId);
					if (late.length === 0) break;
					for (const entry of late) await this.deleteThread(entry.threadId);
				}
				return this.#projectResult(entry, new Date().toISOString());
			}
		}
	}

	/**
	 * Register a project, answering a RETRY honestly: a create whose minted id AND path both name a stored entry is the
	 * command whose commit landed and whose ack the client never saw, so the stored entry is the answer — the state is the
	 * dedup record, and this survives a restart. Anything else is the registry's own conflict (design.md, Invariants).
	 */
	async #createProject(title: string | undefined, workspaceRoot: string, clientId: string | undefined): Promise<Project> {
		try {
			return await this.config.registry.add(title, workspaceRoot, { ...(clientId === undefined ? {} : { clientId }) });
		} catch (error) {
			if (!(error instanceof ProjectConflict) && !(error instanceof ProjectIdConflict)) throw error;
			const minted = clientId?.trim();
			if (minted === undefined || minted === "") throw error;
			const cwd = this.config.registry.resolvePath(workspaceRoot);
			const stored = this.config.registry.list().find((project) => project.id === minted && project.cwd === cwd);
			if (stored === undefined) throw error;
			return stored;
		}
	}

	/**
	 * Validate (and when asked, create) a workspace root with T3's own checks, every failure BEFORE the registry stores
	 * anything (design.md, Invariants).
	 */
	async #ensureWorkspaceRoot(path: string, createIfMissing: boolean): Promise<void> {
		const env = this.config.env;
		if (env !== undefined) return this.#ensureWorkspaceRootInEnv(env, path, createIfMissing);
		const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
			throw new ProjectWorkspaceNotCreatable(path, error);
		});
		if (info === undefined) {
			if (!createIfMissing) throw new ProjectWorkspaceMissing(path);
			try {
				await mkdir(path, { recursive: true });
			}
			catch (error) {
				throw new ProjectWorkspaceNotCreatable(path, error);
			}
			return;
		}
		if (!info.isDirectory()) throw new ProjectWorkspaceNotDirectory(path);
	}

	/** Validate (and when asked, create) a workspace root through the execution environment. */
	async #ensureWorkspaceRootInEnv(env: ExecutionEnv, path: string, createIfMissing: boolean): Promise<void> {
		const context = this.config.context ?? BACKGROUND_CONTEXT;
		const canonical = await env.canonicalPath(path, context);
		const found = canonical.ok ? await env.fileInfo(canonical.value, context) : canonical;
		if (found.ok) {
			if (found.value.kind !== "directory") throw new ProjectWorkspaceNotDirectory(path);
			return;
		}
		if (found.error.code === "not_directory") throw new ProjectWorkspaceNotDirectory(path);
		if (found.error.code !== "not_found") throw new ProjectWorkspaceNotCreatable(path, found.error);
		if (!createIfMissing) throw new ProjectWorkspaceMissing(path);
		const made = await env.createDir(path, { recursive: true }, context);
		if (!made.ok) throw new ProjectWorkspaceNotCreatable(path, made.error);
	}

	/** A T3 `Project` for a mutation's result. Only the fields a paired client reads are set; the rest are the shell's nulls. */
	#projectResult(project: { id: string; name: string; cwd: string }, deletedAt: string | null): WsSuccess<"projects.mutate"> {
		return {
			id: ProjectId.make(project.id),
			title: project.name,
			workspaceRoot: project.cwd,
			repositoryIdentity: null,
			defaultModelSelection: null,
			scripts: [],
			createdAt: this.#startedAt,
			updatedAt: new Date().toISOString(),
			deletedAt,
		};
	}

	// ---- shell ------------------------------------------------------------------------------------------------

	#summary(threadId: string): Thread | undefined {
		return this.#directory.find((thread) => thread.threadId === threadId);
	}

	/** Does this host know the thread? A thread absent from the threads document is the typed not-found on every path
	 * (design.md, Invariants): REST 404, WS the contract's typed error. */
	hasThread(threadId: string): boolean {
		return this.#summary(threadId) !== undefined;
	}

	/** Resolves once the thread list has loaded. */
	loaded(): Promise<void> {
		return this.#loaded.promise;
	}

	threadProjectId(threadId: string): string | undefined {
		return this.#summary(threadId)?.projectId;
	}

	#meta(threadId: string, thread: Thread | undefined, state: ThreadView | undefined): ThreadMeta {
		// The FK is the only lookup: an unregistered `projectId` is reported as it is, with NO invented project, and no row
		// exists without a registered project (design.md, IDs), so this resolves.
		const project = thread === undefined ? undefined : this.#configured().find((candidate) => candidate.id === thread.projectId);
		// A conversation runs where its own `pi.agent.cwd` says: a Scratch thread's folder of its own, every other thread
		// its project's root (the same value, recorded per conversation). Absent a loaded view, the project's root.
		const agentCwd = state?.view?.docs["pi.agent"]?.cwd;
		const cwd = agentCwd ?? project?.path ?? "";
		const model: ModelRef | null = state?.configuration?.model ?? state?.view?.docs["pi.agent"]?.model ?? null;
		const thinkingLevel = state?.configuration?.thinkingLevel ?? state?.view?.docs["pi.agent"]?.thinkingLevel;
		return {
			threadId,
			projectId: project?.id ?? thread?.projectId ?? "",
			title: thread?.title || "New thread",
			cwd,
			...(project === undefined ? {} : { projectPath: project.path }),
			createdAt: thread?.createdAt ?? Date.now(),
			updatedAt: thread?.summary?.updatedAt ?? thread?.createdAt ?? Date.now(),
			...(thread?.summary === undefined ? {} : { summary: thread.summary }),
			model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			...(model === null ? {} : { contextWindow: state?.catalog.find((entry) => entry.provider === model.provider && entry.modelId === model.modelId)?.contextWindow }),
			...(thread === undefined
				? {}
				: {
						createdBy: thread.createdBy,
						creationSource: thread.creationSource,
						lineage: thread.lineage,
						forkedFrom: thread.forkedFrom,
						...(thread.linkOrigin === undefined ? {} : { linkOrigin: thread.linkOrigin }),
						...(thread.delegatedFrom === undefined ? {} : { delegatedFrom: thread.delegatedFrom }),
					}),
			...(thread?.settledOverride === undefined ? {} : { settledOverride: thread.settledOverride }),
			...(thread?.settledAt === undefined ? {} : { settledAt: thread.settledAt }),
			...(thread?.unsettledAt === undefined ? {} : { unsettledAt: thread.unsettledAt }),
			...(thread?.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
			...(thread?.pinOrderKey === undefined ? {} : { pinOrderKey: thread.pinOrderKey }),
			...(thread?.activeOrderKey === undefined ? {} : { activeOrderKey: thread.activeOrderKey }),
			...(thread?.lastVisitedAt === undefined ? {} : { lastVisitedAt: thread.lastVisitedAt }),
			...(thread?.opens === undefined ? {} : { opens: thread.opens }),
			...(thread?.autoSettleDisabledAt === undefined ? {} : { autoSettleDisabledAt: thread.autoSettleDisabledAt }),
			...(thread?.archivedAt === undefined ? {} : { archivedAt: thread.archivedAt }),
			...(thread?.snoozedUntil === undefined ? {} : { snoozedUntil: thread.snoozedUntil }),
			...(thread?.snoozedAt === undefined ? {} : { snoozedAt: thread.snoozedAt }),
			...(thread?.lastSnoozeWakeAt === undefined ? {} : { lastSnoozeWakeAt: thread.lastSnoozeWakeAt }),
			...(thread?.rollback === undefined ? {} : { rollback: thread.rollback }),
			children: this.#children(threadId),
			running: state?.view?.docs["pi.live"]?.run !== undefined,
			titleRegeneration: this.#titleRequests.has(threadId)
				? { requestId: this.#titleRequests.get(threadId)!.requestId, startedAt: this.#titleRequests.get(threadId)!.startedAt }
				: null,
		};
	}

	#shellFor(threadId: string): OrchestrationV2ThreadShell {
		const view = this.#views.get(threadId);
		if (view?.result !== undefined) return view.result.shell;
		return projectThread(this.#meta(threadId, this.#summary(threadId), view), undefined, { rolledBack: view?.rolledBack ?? [] }).shell;
	}

	/**
	 * The folders a client may name as the `cwd` of a file call (`files.ts`): every registered project's root, and every
	 * thread's folder of its own (a Scratch thread's) — the two values T3's client sends, `thread.worktreePath ?? project.workspaceRoot`.
	 */
	workspaceRoots(): string[] {
		const roots = new Set(this.#configured().map((project) => project.path));
		for (const thread of this.#directory) {
			const meta = this.#meta(thread.threadId, this.#summary(thread.threadId), this.#views.get(thread.threadId));
			if (meta.projectPath !== undefined && meta.cwd.startsWith(`${meta.projectPath}/`)) roots.add(meta.cwd);
		}
		return [...roots];
	}

	/** The live shell: T3's active threads. An archived thread is not in it (T3's `subscribeShell` snapshot sends
	 * `archivedThreads: []`); the archive lists it (`archivedShellSnapshot`). */
	shellSnapshot(): OrchestrationV2ShellSnapshot {
		const threads = this.#directory.filter((thread) => thread.archivedAt === undefined).map((thread) => this.#shellFor(thread.threadId));
		for (const shell of threads) this.#shells.set(shell.id as string, shell);
		return {
			schemaVersion: 1,
			snapshotSequence: this.nextSequence(),
			projects: this.projects(),
			threads,
			archivedThreads: [],
		} as unknown as OrchestrationV2ShellSnapshot;
	}

	/** T3's `orchestration.getArchivedShellSnapshot`: the archived threads, newest archive first is the client's to sort. */
	archivedShellSnapshot(): { schemaVersion: number; snapshotSequence: number; projects: OrchestrationProjectShell[]; threads: OrchestrationV2ThreadShell[] } {
		return {
			schemaVersion: 1,
			snapshotSequence: this.nextSequence(),
			projects: this.projects(),
			threads: this.#directory.filter((thread) => thread.archivedAt !== undefined).map((thread) => this.#shellFor(thread.threadId)),
		};
	}

	onShell(listener: (item: ShellItem) => void): () => void {
		this.#shellListeners.add(listener);
		return () => this.#shellListeners.delete(listener);
	}

	#emitShell(item: ShellItem): void {
		for (const listener of this.#shellListeners) listener(item);
	}

	/** Re-project and re-publish the threads in `only` (all of them without it), and emit the removal of every thread that
	 * is gone. */
	#refreshShells(only?: ReadonlySet<string>): void {
		const seen = new Set<string>();
		for (const threadId of this.#directory.map((thread) => thread.threadId)) {
			seen.add(threadId);
			if (only !== undefined && !only.has(threadId)) continue;
			this.#views.get(threadId)?.recompute();
			this.#publishShell(threadId);
		}
		for (const threadId of [...this.#shells.keys()]) {
			if (seen.has(threadId)) continue;
			this.#shells.delete(threadId);
			this.#forget(threadId, new CommandError(`Thread ${threadId} was removed`));
			this.#emitShell({ kind: "thread.removed", sequence: this.nextSequence(), location: "active", threadId: ThreadId.make(threadId) });
		}
	}

	#publishShell(threadId: string): void {
		if (!this.hasThread(threadId)) return;
		const shell = this.#shellFor(threadId);
		const previous = this.#shells.get(threadId);
		// Archived: it leaves the live shell, as T3's shell stream removes it (`shellStreamItemFromThreadShell`).
		if (shell.archivedAt !== null) {
			if (previous === undefined) return;
			this.#shells.delete(threadId);
			this.#emitShell({ kind: "thread.removed", sequence: this.nextSequence(), location: "active", threadId: ThreadId.make(threadId) });
			return;
		}
		if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(shell)) return;
		this.#shells.set(threadId, shell);
		this.#emitShell({ kind: "thread.updated", sequence: this.nextSequence(), location: "active", thread: shell });
		// A child's change is its parent's card: an open parent re-projects.
		const parent = this.#summary(threadId)?.spawn === undefined ? undefined : this.#summary(threadId)?.lineage.parentThreadId;
		if (parent != null) this.#views.get(parent)?.recompute();
	}

	/** The cards of the threads this one started: from an open child's live shell, else from the outcome its record keeps. */
	#children(threadId: string): ChildCard[] {
		const cards: ChildCard[] = [];
		for (const child of this.#directory) {
			const spawn = child.spawn;
			if (spawn === undefined || child.lineage.parentThreadId !== threadId) continue;
			const view = this.#views.get(child.threadId);
			const shell = view?.result?.shell;
			let status: ChildCard["status"];
			let result: string | null = null;
			let completedAt: number | null = null;
			if (shell !== undefined) {
				const active = shell.activityRunStatus != null || ["queued", "preparing", "starting", "running", "waiting"].includes(shell.status);
				status = active ? (shell.activityRunStatus === "waiting" ? "waiting" : "running") : shell.status === "idle" ? "pending" : (shell.status as ChildCard["status"]);
				if (!active && shell.latestRunCompletedAt != null) completedAt = DateTime.toEpochMillis(shell.latestRunCompletedAt);
				if (!active && shell.latestVisibleMessage?.role === "assistant") result = shell.latestVisibleMessage.text;
			} else if (spawn.outcome !== undefined) {
				status = spawn.outcome.status;
				result = spawn.outcome.result;
				completedAt = spawn.outcome.completedAt;
			} else status = "running";
			cards.push({
				threadId: child.threadId,
				title: child.title,
				prompt: spawn.prompt,
				parentRunId: spawn.parentRunId,
				createdAt: child.createdAt,
				status,
				result,
				completedAt,
				model: shell === undefined ? null : shell.modelSelection.model,
			});
		}
		return cards;
	}

	/** A child's run settled: keep its outcome on its record, so its parent's card is right after the child's view closes. */
	#recordOutcome(view: ThreadView): void {
		const spawn = this.#summary(view.threadId)?.spawn;
		const projection = view.result?.projection;
		if (spawn === undefined || projection === undefined) return;
		const run = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
		if (run === undefined || !["completed", "failed", "interrupted", "cancelled"].includes(run.status)) return;
		const answer = projection.messages.filter((message) => message.runId === run.id && message.role === "assistant" && message.text.trim() !== "").at(-1);
		const outcome: NonNullable<Spawn["outcome"]> = {
			status: run.status as NonNullable<Spawn["outcome"]>["status"],
			result: answer?.text ?? null,
			completedAt: run.completedAt === null ? Date.now() : DateTime.toEpochMillis(run.completedAt),
		};
		if (JSON.stringify(spawn.outcome) === JSON.stringify(outcome)) return;
		void this.#store
			.updateRecord(view.threadId, (record) => {
				if (record.spawn === undefined) return false;
				record.spawn.outcome = outcome;
			})
			.catch((error: unknown) => this.#log.warn("child outcome write failed", { threadId: view.threadId, error: error instanceof Error ? error.message : String(error) }));
	}

	// ---- records (for `orchestration.ts`) -----------------------------------------------------------------------

	/** A live thread's record with its summary, from memory. */
	threadRecord(threadId: string): Thread | undefined {
		return this.#summary(threadId);
	}

	/** Every live thread, in creation order. */
	threadRecords(): readonly Thread[] {
		return this.#directory;
	}

	/** Change a live thread's record in one commit (`Threads.updateRecord`). */
	updateThreadRecord(threadId: string, change: (record: ThreadRecord) => boolean | void): Promise<ThreadRecord> {
		return this.#store.updateRecord(threadId, change);
	}

	// ---- threads ----------------------------------------------------------------------------------------------

	/** The view of a thread, opened or not. */
	#viewOf(threadId: string): ThreadView {
		if (!SESSION_ID.test(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		let view = this.#views.get(threadId);
		if (view === undefined) {
			view = new ThreadView(threadId, this.#viewHost);
			this.#views.set(threadId, view);
		}
		return view;
	}

	/** A thread that no longer exists: its view ends its subscriptions. */
	#forget(threadId: string, error: Error): void {
		this.#runHolds.get(threadId)?.();
		this.#runHolds.delete(threadId);
		const view = this.#views.get(threadId);
		if (view === undefined) return;
		this.#views.delete(threadId);
		view.forget(error);
	}

	/** Keep a thread open while `hold` runs or a subscriber exists. */
	acquire(threadId: string): () => void {
		return this.#viewOf(threadId).hold();
	}

	/** After each projection of an open thread: the shell, and the sidebar summary on a load, at a run's end, or when the
	 * latest run changed otherwise (an undo); and a hold while the thread runs. */
	#projected(view: ThreadView, change: { readonly loaded: boolean; readonly settled: boolean }): void {
		// A load writes the first snapshot; a run boundary writes the assistant reply without a per-token document write.
		const run = this.#keptRun(view);
		const kept = this.#summary(view.threadId)?.summary?.latestRun;
		const runChanged = run !== undefined && JSON.stringify(run) !== JSON.stringify(kept ?? null);
		if (change.loaded || change.settled || runChanged) this.#remember(view, run);
		if (change.settled) this.#recordOutcome(view);
		this.#holdWhileRunning(view);
		this.#publishShell(view.threadId);
	}

	/** The latest run as the summary keeps it, from an open thread's shell: `null` with no run, `undefined` while one runs
	 * (the summary keeps the last settled run; a running thread is open, so its shell is the live one). */
	#keptRun(view: ThreadView): SummaryRun | null | undefined {
		const shell = view.result?.shell;
		if (shell === undefined || shell.status === "running") return undefined;
		if (shell.latestRunId === null) return null;
		const ms = (value: DateTime.Utc | null | undefined): number | null => (value == null ? null : DateTime.toEpochMillis(value));
		return {
			id: String(shell.latestRunId),
			status: shell.status,
			requestedAt: ms(shell.latestRunRequestedAt) ?? DateTime.toEpochMillis(shell.createdAt),
			startedAt: ms(shell.latestRunStartedAt),
			completedAt: ms(shell.latestRunCompletedAt),
		};
	}

	/** Keep a running thread open until its run ends; the run's end lets it close after the usual idle time. */
	#holdWhileRunning(view: ThreadView): void {
		const running = view.result?.shell.status === "running";
		const hold = this.#runHolds.get(view.threadId);
		if (running && hold === undefined && !this.#closed) this.#runHolds.set(view.threadId, view.hold());
		else if (!running && hold !== undefined) {
			this.#runHolds.delete(view.threadId);
			hold();
		}
	}

	/** Watch every task of the Harness: a thread's head conversation that gains live work (a prompt from anywhere — a
	 * client, an agent, a scheduled task — or a run resumed after a restart) is opened, and its projection holds it while
	 * it runs. Only a new task opens anything (a conversation's lasting background task does not hide a later run); a
	 * projection that shows no run lets it close again. */
	async #watchRuns(): Promise<void> {
		try {
			const watch = await this.#store.harness.watchTaskGraph(BACKGROUND_CONTEXT);
			if (this.#closed) {
				await watch.stop();
				return;
			}
			this.#taskWatch = watch;
			this.#onTaskGraph(watch.value);
			watch.start(async (call) => {
				if (call.kind === "value") this.#onTaskGraph(call.value);
			});
		} catch (error) {
			this.#log.warn("the task graph watch failed: runs that start without a client are not followed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	#onTaskGraph(graph: TaskGraph): void {
		if (this.#closed) return;
		const arrived = new Set<number>();
		for (const [taskId, task] of Object.entries(graph.tasks)) if (!this.#liveTasks.has(taskId)) arrived.add(Number(task.conversationId));
		this.#liveTasks = new Set(Object.keys(graph.tasks));
		if (arrived.size === 0) return;
		const heads = new Map(this.#directory.map((thread) => [thread.head, thread.threadId]));
		for (const conversationId of arrived) {
			const threadId = heads.get(conversationId);
			if (threadId === undefined || this.#runHolds.has(threadId)) continue;
			// Open it for a projection; while that shows a run, `#holdWhileRunning` keeps it open.
			this.acquire(threadId)();
		}
	}

	#remember(view: ThreadView, run: SummaryRun | null | undefined): void {
		const shell = view.result?.shell;
		if (shell === undefined) return;
		const latest = shell.latestVisibleMessage;
		void this.#store
			.remember(view.threadId, {
				updatedAt: DateTime.toEpochMillis(shell.updatedAt),
				latestVisibleMessage: latest === null ? null : { id: latest.id, role: latest.role, text: latest.text, updatedAt: DateTime.toEpochMillis(latest.updatedAt) },
				latestUserMessageAt: shell.latestUserMessageAt === null ? null : DateTime.toEpochMillis(shell.latestUserMessageAt),
				...(run === undefined ? {} : { latestRun: run }),
				itemCount: shell.itemCount,
				visibleItemCount: shell.visibleItemCount,
			})
			.catch((error: unknown) => this.#log.warn("sidebar summary write failed", { threadId: view.threadId, error: error instanceof Error ? error.message : String(error) }));
	}

	/** The stream's state as subscribers were last brought to it, without a flush (a slow subscriber's catch-up). */
	currentStream(threadId: string): { readonly sequence: number; readonly projection: OrchestrationV2ThreadProjection } | undefined {
		return this.#views.get(threadId)?.stream;
	}

	/** The stream's current state for a reader that is not a subscriber (T3's HTTP snapshot routes): pending changes are
	 * flushed first, so a subscription that resumes after the answered sequence misses nothing. */
	async streamSnapshot(threadId: string): Promise<{ readonly sequence: number; readonly projection: OrchestrationV2ThreadProjection }> {
		await this.projection(threadId);
		const release = this.acquire(threadId);
		try {
			return this.#viewOf(threadId).flush()!;
		} finally {
			release();
		}
	}

	/** Wait until the thread's transcript is loaded and return its projection. A thread absent from the threads
	 * document is the typed not-found — never a fabricated empty thread (design.md, Invariants). */
	async projection(threadId: string, timeoutMs = 30_000): Promise<ProjectionResult> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const release = this.acquire(threadId);
		try {
			return await this.#viewOf(threadId).projection(timeoutMs);
		} finally {
			release();
		}
	}

	/**
	 * Every conversation on this host, as the usage view reads it: the head view of each thread in the directory, with
	 * its entries and the conversation id that names them. Used by `server.getUsageSummary` (see `usage.ts`). A thread
	 * the host cannot open is skipped rather than guessed at; a thread with no usage contributes no records.
	 */
	async usageConversations(timeoutMs = 30_000): Promise<{ readonly conversationId: number; readonly entries: EntryRecord[] }[]> {
		const threadIds = this.#directory.map((thread) => thread.threadId);
		const loaded = await Promise.all(
			threadIds.map(async (threadId) => {
				try {
					await this.projection(threadId, timeoutMs);
				} catch {
					return undefined;
				}
				const view = this.#views.get(threadId);
				const entries = view?.view?.entries;
				const conversationId = view?.conversationId;
				if (entries === undefined || conversationId === undefined) return undefined;
				return { conversationId, entries };
			}),
		);
		return loaded.filter((entry): entry is { conversationId: number; entries: EntryRecord[] } => entry !== undefined);
	}

	/** The thread a conversation is shown as: the live thread whose head it is. */
	threadIdForConversation(conversationId: number): Promise<string | undefined> {
		return this.#store.threadIdForConversation(conversationId);
	}

	/** A thread's shell: its sidebar row, current whether or not the thread is open. */
	threadShell(threadId: string): OrchestrationV2ThreadShell {
		return this.#shellFor(threadId);
	}

	/**
	 * Wait until `read` answers from the thread's projection, holding the thread open meanwhile; `undefined` when the time
	 * is up first. Every new view of the thread wakes it; nothing polls.
	 */
	async waitFor<T>(threadId: string, read: (projection: OrchestrationV2ThreadProjection) => T | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const release = this.acquire(threadId);
		const timedOut = new Error("timed out");
		try {
			const view = this.#viewOf(threadId);
			return await view.waitFor(
				() => {
					const projection = view.loaded ? view.result?.projection : undefined;
					return projection === undefined ? undefined : read(projection);
				},
				timeoutMs,
				() => timedOut,
				signal,
			);
		} catch (error) {
			if (error === timedOut) return undefined;
			throw error;
		} finally {
			release();
		}
	}

	/** Subscribe to a thread's stream (`ThreadView.subscribe`). A thread the host does not know refuses synchronously (the
	 * stream carries the typed not-found); it never sends an empty projection. */
	subscribeThread(threadId: string, afterSequence: number | undefined, update: (update: StreamUpdate) => void, onEnd: () => void = () => {}): () => void {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		return this.#viewOf(threadId).subscribe(afterSequence, update, onEnd);
	}

	// ---- commands ---------------------------------------------------------------------------------------------

	/**
	 * Run a command once per `commandId` (T3's command receipts): a retry after it was accepted — a lost ack, a
	 * reconnect, a restart — gets the answer kept for it, and a duplicate that arrives while it runs joins it. A refused
	 * command keeps no receipt, so its retry runs again.
	 */
	receipted(commandId: string, run: () => Promise<number>): Promise<number> {
		const running = this.#commandResults.get(commandId);
		if (running !== undefined) return running;
		const result = (async () => {
			const kept = await this.#store.receipt(commandId);
			if (kept !== undefined) return kept;
			const sequence = await run();
			await this.#store.recordReceipt(commandId, sequence);
			return sequence;
		})().finally(() => this.#commandResults.delete(commandId));
		this.#commandResults.set(commandId, result);
		return result;
	}

	/** Configure the thread's head (a model or thinking-level choice), then re-read its configuration. */
	async #configureHead(state: ThreadView, change: AgentChange): Promise<void> {
		const head = await state.head();
		const conversation = await this.#store.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new CommandError(`No head for thread ${state.threadId}`);
		await conversation.configure(change, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		state.configured({
			model: agent.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
			thinkingLevel: agent.thinkingLevel,
		});
	}

	/**
	 * A new thread. `launchText` is the launch's first message (or title): T3's server gives a thread launched in the
	 * Scratch project a folder of its own, claimed at launch — a thread whose row already exists is a replayed create and
	 * claims nothing, exactly T3's "only the first attempt claims one" (ManagedProjectFolders, ThreadLaunchService).
	 */
	async createThread(options: {
		threadId?: string | undefined;
		projectId: string;
		launchText?: string;
		title?: string;
		provenance?: Provenance;
		/** A child thread: its parent link, the node of its card and how it was started. */
		child?: { readonly lineage: ThreadLineage; readonly nodeId: string; readonly spawn: Spawn };
	}): Promise<string> {
		const project = this.config.registry.list().find((p) => p.id === options.projectId);
		if (project === undefined) throw new CommandError(`Unknown project: ${options.projectId}`);
		const id = options.threadId !== undefined && SESSION_ID.test(options.threadId) ? options.threadId : randomUUID();
		if (this.#summary(id) !== undefined) return id;
		const scratchRoot = this.config.scratchDir;
		let cwd: string | undefined;
		if (options.launchText !== undefined && scratchRoot !== undefined && isScratchRoot(project.cwd, scratchRoot)) {
			const env = this.config.env;
			if (env === undefined) throw new CommandError("Threads without a project require an execution environment.");
			cwd = await claimScratchThreadFolder(scratchRoot, id, options.launchText, env, this.config.context ?? BACKGROUND_CONTEXT);
		}
		await this.#store.create({
			threadId: id,
			projectId: project.id,
			provenance: options.provenance ?? USER_WEB,
			...(cwd === undefined ? {} : { cwd }),
			...(options.title === undefined ? {} : { title: options.title }),
			...(options.child === undefined ? {} : { lineage: options.child.lineage, forkedFrom: { type: "node" as const, nodeId: options.child.nodeId }, spawn: options.child.spawn }),
		});
		// Read the document back before answering: the next thread-existence check must see the new row.
		return id;
	}

	/**
	 * T3's `orchestration.launchThread` (and a scheduled task's launch): create the thread, apply the client's model, then
	 * start the first message under the launch's commandId, so a retried launch sends it once.
	 */
	async launchThread(input: {
		commandId: string;
		threadId?: string | undefined;
		projectId: string;
		title?: string | undefined;
		/** T3's `generateTitle`: the launch's title is the first message's `titleSeed`. */
		generateTitle?: boolean | undefined;
		modelSelection: { model?: string; options?: readonly { id: string; value: string | boolean }[] } | undefined;
		workspaceStrategy?: { type?: string } | undefined;
		initialMessage?: { messageId?: string; text: string; context?: OrchestrationMessageContext | undefined; attachments?: readonly AttachmentRecord[] | undefined } | undefined;
		/** Who launched it: the thread and its first message carry it (T3's `ThreadLaunchService`). */
		provenance?: Provenance;
	}): Promise<string> {
		// A Scratch launch names the folder it claims: T3 names it from the first message, else the title.
		const launchText = input.initialMessage?.text ?? input.title;
		const provenance = input.provenance ?? USER_WEB;
		const threadId = await this.createThread({
			threadId: input.threadId,
			projectId: input.projectId,
			provenance,
			// T3's launch creates the thread with the launch's title.
			...(input.title === undefined || input.title.trim() === "" ? {} : { title: input.title.trim() }),
			// T3's launch: Scratch has no Git, so a new-worktree request there is the root, with a folder of its own.
			...(launchText !== undefined && [undefined, "root", "worktree"].includes(input.workspaceStrategy?.type) ? { launchText } : {}),
		});
		await this.applySelection(threadId, input.modelSelection);
		const message = input.initialMessage;
		if (message !== undefined && message.text.trim().length > 0) {
			// The launch's commandId is the message's request id: pi-durable sends a retried launch's message once.
			await this.sendMessage({
				threadId,
				commandId: input.commandId,
				messageId: message.messageId ?? `launch-${input.commandId}`,
				text: message.text,
				mode: "start",
				provenance,
				...(input.generateTitle === true && input.title !== undefined && input.title.trim() !== "" ? { titleSeed: input.title.trim() } : {}),
				...(message.attachments === undefined ? {} : { attachments: message.attachments }),
				...(message.context === undefined ? {} : { context: message.context }),
			});
		}
		return threadId;
	}

	/**
	 * T3's selection, applied: the model it names and the `thinking` level it carries. The client owns the choice, the
	 * catalog owns availability (an unknown model is refused by name); no `thinking` option leaves the level alone,
	 * because the bridge computes no defaults (design.md, north star).
	 */
	async applySelection(threadId: string, selection: { model?: string; options?: readonly { id: string; value: string | boolean }[] } | undefined): Promise<void> {
		const model = selection?.model === undefined ? undefined : splitSlug(selection.model);
		if (model === undefined) return;
		const thinking = thinkingOf(selection?.options);
		const release = this.acquire(threadId);
		try {
			const current = this.#viewOf(threadId).configuration;
			const modelChanged = current?.model?.provider !== model.provider || current?.model?.modelId !== model.modelId;
			const thinkingChanged = thinking !== undefined && current?.thinkingLevel !== thinking;
			if (!modelChanged && !thinkingChanged) return;
			// The model first: an unknown one is refused, and the level is applied to the thread the model landed on.
			const state = this.#viewOf(threadId);
			if (modelChanged) {
				if (!state.catalog.some((entry) => entry.provider === model.provider && entry.modelId === model.modelId)) {
					throw new CommandError(`Not in the catalog: ${model.provider}/${model.modelId}`);
				}
				await this.#configureHead(state, { model: { provider: model.provider, modelId: model.modelId } });
			}
			if (thinkingChanged) {
				if (!THINKING_LEVELS.includes(thinking)) throw new CommandError(`Unknown thinking level: ${thinking}`);
				await this.#configureHead(state, { thinkingLevel: thinking as ModelThinkingLevel });
			}
		} finally {
			release();
		}
	}

	/** The prompt's attachment blocks: where each attachment is saved ("Attachments:" and a path per line, hidden in T3's
	 * display), then the images inline when the head's model takes them. */
	#attachmentBlocks(state: ThreadView, kept: readonly KeptAttachment[]): ContentBlock[] | undefined {
		if (kept.length === 0) return undefined;
		const model = state.configuration?.model ?? state.view?.docs["pi.agent"]?.model ?? null;
		const bytes = new Map(kept.flatMap((attachment) => (attachment.bytes === undefined ? [] : [[attachment.record.id, attachment.bytes] as const])));
		const images = selectImageBlocks(state.catalog, model, kept.map((attachment) => attachment.record), (id) => {
			const found = bytes.get(id);
			return found === undefined ? null : { data: Buffer.from(found).toString("base64"), mimeType: "" };
		});
		const list = ["Attachments:", ...kept.map(({ path }) => `- ${path}`)].join("\n");
		return [{ type: "text" as const, text: list, hidden: true }, ...(images ?? [])];
	}

	/** A message's attachments, kept in the environment (`Attachments.keep`); a host without an attachment dir takes none. */
	async #keepAttachments(threadId: string, messageId: string, records: readonly AttachmentRecord[] | undefined): Promise<KeptAttachment[]> {
		if (records === undefined || records.length === 0) return [];
		if (this.#attachments === undefined) throw new CommandError("This host takes no attachments.");
		try {
			return await this.#attachments.keep(threadId, messageId, records);
		} catch (error) {
			throw new CommandError((error as Error).message);
		}
	}

	async sendMessage(input: {
		threadId: string;
		commandId: string;
		messageId: string;
		text: string;
		mode: "start" | "queue" | "steer" | "restart";
		context?: OrchestrationMessageContext | undefined;
		attachments?: readonly AttachmentRecord[] | undefined;
		/** T3's `titleSeed`: honoured only on a thread with no messages yet (Orchestrator's message count 0). */
		titleSeed?: string | undefined;
		/** Who sent it (absent: a person in the web app). */
		provenance?: Provenance;
		/** Add it without starting a turn (`mode: "notify"`): the next turn sees it. */
		note?: boolean;
		/** Sent by the host on its own (a child's report), not by someone: it does not end a snooze (T3's automatic wake). */
		automatic?: boolean;
	}): Promise<void> {
		const release = this.acquire(input.threadId);
		try {
			const state = this.#viewOf(input.threadId);
			const head = await state.head();
			// T3's Orchestrator wakes a settled thread on new activity; the explicit override is cleared before the run. A
			// message someone sent also ends a snooze; an automatic one (a note, a child's report) does not.
			const record = this.#summary(input.threadId);
			const snooze = input.automatic !== true && input.note !== true && record?.snoozedUntil !== undefined;
			if (record?.settledOverride !== undefined || snooze) {
				await this.#store.wake(input.threadId, snooze);
						this.#titleChanged(input.threadId);
			}
			// T3's slash command: `/compact` (with optional guidance) is a compaction task, not a prompt.
			const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(input.text.trim());
			if (compact !== null) {
				const guidance = compact[1]?.trim();
				await this.#store.compact(input.threadId, guidance === undefined || guidance === "" ? undefined : guidance, input.messageId);
				return;
			}
			// `/reload`: the next request renders the system prompt afresh (`Threads.reload`); it starts no turn.
			if (input.text.trim() === "/reload") {
				await this.#store.reload(input.threadId, input.messageId);
				return;
			}
			const live = state.view?.docs["pi.live"] as { run?: unknown; compactions?: readonly unknown[] } | undefined;
			const busy = live?.run !== undefined;
			// A manual compaction owns the thread even though pi models it as conversation-owned work, not a run.
			// Prompts sent while it runs must queue, not start a turn alongside the summary.
			const compacting = (live?.compactions?.length ?? 0) > 0;
			// T3's Orchestrator: the first message's `titleSeed` sets the title and starts an "initial" generation on it.
			const seed = input.titleSeed?.trim();
			const seeded = seed !== undefined && seed !== "" && !this.#hasMessages(state);
			const previousTitle = this.#summary(input.threadId)?.title ?? "";
			if (seeded) {
				this.#cancelTitle(input.threadId);
				await this.#setStoredTitle(input.threadId, seed);
				this.#beginTitle(input.threadId, input.commandId);
			}
			// The client's message id rides in the entry (`app.user`, placed by `Threads.submit`); `requestId` stays the
			// commandId for durable dedup (design.md, Invariants). Attachments are kept in the environment before the message
			// names them (an upload moves there under a deterministic id), then named to the model by path; images also go
			// inline when the model takes them. The records ride in the entry's data, for display.
			const kept = await this.#keepAttachments(input.threadId, input.messageId, input.attachments);
			const attachments = input.attachments === undefined ? undefined : kept.map((attachment) => attachment.record);
			const context = rebindContext(input.context, input.attachments, attachments);
			const promptBlocks = this.#attachmentBlocks(state, kept);
			const request = {
				threadId: input.threadId,
				conversationId: head,
				requestId: input.commandId,
				message: input.text,
				messageId: input.messageId,
				...(input.provenance === undefined ? {} : { provenance: input.provenance }),
				...(promptBlocks === undefined ? {} : { blocks: promptBlocks }),
				...(attachments === undefined || attachments.length === 0 ? {} : { attachments: [...attachments] }),
				// T3's composer context is JSON by construction: the contract decoded it from the wire.
				...(context === undefined ? {} : { context: context as unknown as JsonValue }),
			};
			// `restart` interrupts the active turn first; `steer` applies to it; while a run is live `start`/`queue`
			// become a follow-up. Each is one submission, keyed by the commandId for wire idempotency.
			await (async () => {
				if (input.note === true) return void (await this.#store.submit({ ...request, note: true }, undefined));
				if (input.mode === "restart" && busy) await this.#store.abort({ threadId: input.threadId, conversationId: head });
				if (input.mode === "steer") await this.#store.submit(request, "steer");
				else if ((busy || compacting) && input.mode !== "restart") await this.#store.submit(request, "followUp");
				else await this.#store.submit(request, undefined);
			})().catch((error: unknown) => {
				if (seeded) {
					void this.#completeTitle(input.threadId, input.commandId, undefined);
					// T3 stores the seed and the message in one command: a message that did not land leaves no seed title.
					if (this.#summary(input.threadId)?.title === seed) void this.#setStoredTitle(input.threadId, previousTitle).catch(() => {});
				}
				throw error;
			});
			if (seeded) this.#generateTitle(input.threadId, input.commandId, { reason: "first-message", messageId: input.messageId });
		} finally {
			release();
		}
	}

	// ---- titles (T3's Orchestrator `titleRegeneration` + ThreadTitleRegenerationService) ------------------------

	/** Does the thread's head carry a message yet (T3's `getMessageCount(threadId) > 0`)? */
	#hasMessages(state: ThreadView): boolean {
		return (state.result?.projection.messages.length ?? 0) > 0 || (state.view?.entries ?? []).some((entry) => USER_ENTRY_KINDS.has(entry.kind));
	}

	async #setStoredTitle(threadId: string, title: string): Promise<void> {
		await this.#store.rename(threadId, title);
		this.#titleChanged(threadId);
	}

	/** Re-publish a thread after a title or `titleRegeneration` change. */
	#titleChanged(threadId: string): void {
		this.#views.get(threadId)?.recompute();
		this.#publishShell(threadId);
	}

	/** Start a request (`titleRegeneration: { requestId, startedAt }`), superseding any pending one. */
	#beginTitle(threadId: string, requestId: string): void {
		if (this.config.titleThread === undefined) return;
		this.#cancelTitle(threadId);
		this.#titleRequests.set(threadId, { requestId, startedAt: Date.now(), controller: new AbortController() });
		this.#titleChanged(threadId);
	}

	/** Drop the pending request, aborting its signal (a rename, a newer request, a delete). */
	#cancelTitle(threadId: string): void {
		const pending = this.#titleRequests.get(threadId);
		if (pending === undefined) return;
		this.#titleRequests.delete(threadId);
		pending.controller.abort();
		this.#titleChanged(threadId);
	}

	/**
	 * T3's `thread.title.regeneration.complete`: applied only while `requestId` is still current. A "New thread" (or, on
	 * regenerate, the unchanged title) changes nothing (ThreadTitleRegenerationService).
	 */
	async #completeTitle(threadId: string, requestId: string, title: string | undefined, previousTitle?: string): Promise<void> {
		const pending = this.#titleRequests.get(threadId);
		if (pending?.requestId !== requestId) return;
		this.#titleRequests.delete(threadId);
		const next = title?.trim();
		if (next !== undefined && next !== "" && next !== "New thread" && next !== previousTitle?.trim() && this.hasThread(threadId)) {
			await this.#setStoredTitle(threadId, next).catch((error: unknown) => this.#log.warn("storing a generated title failed", { threadId, error: String(error) }));
		}
		this.#titleChanged(threadId);
	}

	/** Run the integrator's hook for the current request, detached: the caller (a send, a regenerate) does not wait. */
	/**
	 * T3's text-generation model (Settings → the model for titles and other generated text), read at each use: the
	 * model it names when that is one of this host's (`pi` provider, in the catalog), with its thinking level. Unset — the
	 * stored default is T3's own, a Codex model — or a model this host lacks: `undefined`, and the caller uses the
	 * thread's model.
	 */
	textGenerationModel(): TextGenerationModel | undefined {
		const selection = this.config.settings.current().textGenerationModelSelection as { instanceId?: string; model?: string; options?: readonly { id: string; value: string | boolean }[] } | undefined;
		if (selection === undefined || selection.instanceId !== PROVIDER_INSTANCE_ID || selection.model === undefined) return undefined;
		const ref = splitSlug(selection.model);
		if (ref === undefined || this.#models.getModel(ref.provider, ref.modelId) === undefined) return undefined;
		const thinkingLevel = thinkingOf(selection.options);
		return { provider: ref.provider, modelId: ref.modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) };
	}

	#generateTitle(threadId: string, requestId: string, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }): void {
		const hook = this.config.titleThread;
		const pending = this.#titleRequests.get(threadId);
		if (hook === undefined || pending?.requestId !== requestId) return;
		const signal = pending.controller.signal;
		void (async () => {
			const release = this.acquire(threadId);
			let previousTitle: string | undefined;
			try {
				const state = this.#viewOf(threadId);
				const conversationId = (await state.head()) as ConversationId;
				const at = await this.#titleEntry(state, kind, signal);
				if (at === undefined || signal.aborted) return void (await this.#completeTitle(threadId, requestId, undefined));
				const request: TitleThreadRequest =
					kind.reason === "regenerate"
						? { threadId, conversationId, at, reason: "regenerate", previousTitle: (previousTitle = this.#summary(threadId)?.title || "New thread"), signal }
						: { threadId, conversationId, at, reason: "first-message", signal };
				const model = this.textGenerationModel();
				if (model !== undefined) Object.assign(request, { model });
				// The user's title guidance (T3's `threadTitleInstructions`), capped as T3's `policyInstruction` caps it.
				const guidance = (this.config.settings.current().threadTitleInstructions as string | undefined)?.trim();
				if (guidance) Object.assign(request, { guidance: guidance.slice(0, 20_000) });
				const title = await hook(request);
				await this.#completeTitle(threadId, requestId, title, previousTitle);
			} catch (error) {
				// T3: a failure logs a warning and completes without a title.
				if (!signal.aborted) this.#log.warn("Thread title generation failed", { threadId, requestId, error: (error as Error).message || String(error) });
				await this.#completeTitle(threadId, requestId, undefined);
			} finally {
				release();
			}
		})();
	}

	/** The entry a request names: the first message's committed entry (waited for, not its reply), or the head's latest. */
	async #titleEntry(state: ThreadView, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }, signal: AbortSignal): Promise<EntryId | undefined> {
		if (kind.reason === "regenerate") return state.view?.entries.at(-1)?.id as EntryId | undefined;
		const find = (): EntryId | undefined =>
			state.view?.entries.find(
				(candidate) => USER_ENTRY_KINDS.has(candidate.kind) && (candidate.data as { messageId?: unknown } | undefined)?.messageId === kind.messageId,
			)?.id as EntryId | undefined;
		return state.waitFor(find, 60_000, () => new Error("timed out"), signal).catch(() => undefined);
	}

	/** A user rename (T3's `thread.metadata.update` with `title`, or `T3Attachment.setTitle`): durable, and it cancels a
	 * pending generation (`titleRegeneration: null`). */
	async renameThread(threadId: string, title: string): Promise<void> {
		const trimmed = title.trim();
		if (trimmed === "") throw new CommandError("Thread title cannot be empty.");
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		this.#cancelTitle(threadId);
		await this.#setStoredTitle(threadId, trimmed);
	}

	/** T3's `thread.metadata.update`: `title` renames; `regenerateTitle: true` starts a "regenerate" request (refused with
	 * no `titleThread` hook), `false` clears it. Fields this host has no backend for are refused. */
	async updateThreadMetadata(command: { commandId: string; threadId: string; title?: string; regenerateTitle?: boolean } & Record<string, unknown>): Promise<void> {
		const refused = ["linkedPullRequest", "branch", "worktreePath", "expectedBranch", "expectedWorktreePath", "expectedEmpty", "limitRecovery"].filter((field) => command[field] !== undefined);
		if (refused.length > 0) {
			throw new CommandError(
				refused.includes("linkedPullRequest")
					? "Linking pull requests is not supported by pi-durable-t3."
					: `Updating ${refused.join(", ")} is not supported by pi-durable-t3 (no git or limit recovery here).`,
			);
		}
		if (command.regenerateTitle === true && this.config.titleThread === undefined) {
			throw new CommandError("Regenerating titles is not supported by this host (it has no title generator).");
		}
		if (!this.hasThread(command.threadId)) throw new CommandError(`Unknown thread: ${command.threadId}`);
		if (command.title !== undefined) await this.renameThread(command.threadId, command.title);
		if (command.regenerateTitle === true) {
			this.#beginTitle(command.threadId, command.commandId);
			this.#generateTitle(command.threadId, command.commandId, { reason: "regenerate" });
		} else if (command.regenerateTitle === false) {
			this.#cancelTitle(command.threadId);
		}
	}

	/** T3's refusal of sidebar changes to an archived thread. */
	#notArchived(threadId: string): void {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		if (this.#summary(threadId)?.archivedAt !== undefined) throw new CommandError(`Thread ${threadId} is archived.`);
	}

	/** T3's `thread.settle`: a durable sidebar settlement, reflected in the shell immediately. */
	async settleThread(threadId: string): Promise<void> {
		this.#notArchived(threadId);
		await this.#store.settle(threadId);
		this.#titleChanged(threadId);
	}

	/** T3's `thread.unsettle`: put the thread back in the active section, durably. */
	async unsettleThread(threadId: string): Promise<void> {
		this.#notArchived(threadId);
		await this.#store.unsettle(threadId);
		this.#titleChanged(threadId);
	}

	// ---- sidebar state (T3's server keeps it on the thread row) ------------------------------------------------

	#sidebarChange(threadId: string, change: (record: ThreadRecord) => boolean | void): Promise<ThreadRecord> {
		this.#notArchived(threadId);
		return this.#store.updateRecord(threadId, change);
	}

	/** T3's `thread.archive`: out of the sidebar and into the archive; a title being generated is dropped. */
	async archiveThread(threadId: string): Promise<void> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		if (this.#summary(threadId)?.archivedAt !== undefined) throw new CommandError(`Thread ${threadId} is already archived.`);
		this.#cancelTitle(threadId);
		const now = Date.now();
		await this.#store.updateRecord(threadId, (record) => {
			record.archivedAt = now;
		});
	}

	/** T3's `thread.unarchive`. */
	async unarchiveThread(threadId: string): Promise<void> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		if (this.#summary(threadId)?.archivedAt === undefined) throw new CommandError(`Thread ${threadId} is not archived.`);
		await this.#store.updateRecord(threadId, (record) => {
			delete record.archivedAt;
		});
	}

	/** T3's `thread.snooze`: hidden until a time in the future; refused while a message waits in its queue (T3 refuses a
	 * queued run someone sent). */
	async snoozeThread(threadId: string, snoozedUntil: string): Promise<void> {
		this.#notArchived(threadId);
		const until = Date.parse(snoozedUntil);
		const now = Date.now();
		if (Number.isNaN(until) || until <= now) throw new CommandError(`Thread ${threadId} snooze wake time ${snoozedUntil} is not in the future.`);
		const release = this.acquire(threadId);
		try {
			const { projection } = await this.#viewOf(threadId).projection(15_000);
			if (projection.runs.some((run) => run.status === "queued")) throw new CommandError(`Thread ${threadId} has a queued run and cannot be snoozed.`);
		} finally {
			release();
		}
		await this.#store.updateRecord(threadId, (record) => {
			record.snoozedUntil = until;
			record.snoozedAt = now;
		});
	}

	/** T3's `thread.unsnooze`: awake now, stamped unless it already was. */
	async unsnoozeThread(threadId: string): Promise<void> {
		const now = Date.now();
		await this.#sidebarChange(threadId, (record) => {
			const awake = record.snoozedUntil === undefined;
			delete record.snoozedUntil;
			delete record.snoozedAt;
			if (!awake) record.lastSnoozeWakeAt = now;
			if (awake && record.snoozedAt === undefined) return false;
		});
	}

	/** T3's `thread.visit`: the read watermark moves forward only (by the client's clock); an open (`opened`) is counted for
	 * the command palette by the server's clock, with the query that picked the thread. */
	async visitThread(threadId: string, visitedAt: string, opened: boolean, searchQuery: string | undefined): Promise<void> {
		const at = Date.parse(visitedAt);
		if (Number.isNaN(at)) throw new CommandError(`Thread ${threadId} visit time ${visitedAt} is not a valid timestamp.`);
		const now = Date.now();
		await this.#sidebarChange(threadId, (record) => {
			const forward = record.lastVisitedAt === undefined || at > record.lastVisitedAt;
			if (!forward && !opened) return false;
			if (forward) record.lastVisitedAt = at;
			if (opened) record.opens = recordThreadOpen(record.opens, now, searchQuery);
		});
	}

	/** T3's `thread.mark-unread`: the watermark goes back to just before the latest run's end. */
	async markThreadUnread(threadId: string): Promise<void> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const completedAt = this.#shellFor(threadId).latestRunCompletedAt;
		if (completedAt == null) throw new CommandError(`Thread ${threadId} has no completed run to mark unread.`);
		const at = DateTime.toEpochMillis(completedAt) - 1;
		const now = Date.now();
		await this.#sidebarChange(threadId, (record) => {
			record.lastVisitedAt = at;
			// T3 retires a snooze that already ran out, keeping when it woke.
			if (record.snoozedUntil !== undefined && record.snoozedUntil <= now) {
				record.lastSnoozeWakeAt = record.snoozedUntil;
				delete record.snoozedUntil;
				delete record.snoozedAt;
			}
		});
	}

	/** T3's `thread.pin`: pinned once (a later pin keeps its time and place); pinning a settled thread makes it active. */
	async pinThread(threadId: string, orderKey: string | undefined): Promise<void> {
		const now = Date.now();
		await this.#sidebarChange(threadId, (record) => {
			const already = record.pinnedAt !== undefined;
			if (!already) {
				record.pinnedAt = now;
				if (orderKey !== undefined) record.pinOrderKey = orderKey;
			}
			if (record.settledOverride === "settled") {
				record.settledOverride = "active";
				delete record.settledAt;
			}
			// A pinned thread is not snoozed (T3's pin wakes it, stamped).
			if (record.snoozedUntil !== undefined) record.lastSnoozeWakeAt = now;
			delete record.snoozedUntil;
			delete record.snoozedAt;
		});
	}

	/** T3's `thread.unpin`. */
	async unpinThread(threadId: string): Promise<void> {
		await this.#sidebarChange(threadId, (record) => {
			if (record.pinnedAt === undefined && record.pinOrderKey === undefined) return false;
			delete record.pinnedAt;
			delete record.pinOrderKey;
		});
	}

	/** T3's `thread.pin.reorder` and `thread.active.reorder`: the thread's place among the pins, or in the active section. */
	async reorderThread(threadId: string, section: "pinned" | "active", orderKey: string): Promise<void> {
		await this.#sidebarChange(threadId, (record) => {
			const field = section === "pinned" ? "pinOrderKey" : "activeOrderKey";
			if (record[field] === orderKey) return false;
			record[field] = orderKey;
		});
	}

	/** T3's `thread.auto-settle.set`: turn automatic settlement off for this thread (stamped once), or back on. */
	async setAutoSettle(threadId: string, enabled: boolean): Promise<void> {
		const now = Date.now();
		await this.#sidebarChange(threadId, (record) => {
			if (enabled === (record.autoSettleDisabledAt === undefined)) return false;
			if (enabled) delete record.autoSettleDisabledAt;
			else record.autoSettleDisabledAt = now;
		});
	}

	/** T3's `thread.auto-settle`: settle a thread nobody settled or kept active, unless it changed after `snapshotAt`. */
	async autoSettleThread(threadId: string, snapshotAt: number, settledAt: number | undefined): Promise<void> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const shell = this.#shellFor(threadId);
		if (shell.settledOverride !== null || DateTime.toEpochMillis(shell.updatedAt) > snapshotAt) {
			throw new CommandError(`Thread ${threadId} changed before automatic settlement.`);
		}
		await this.#store.settle(threadId, settledAt);
	}

	/**
	 * T3's settlement sweep (`ThreadSettlementService`): settle every thread that has been quiet for longer than its
	 * project's `sidebarAutoSettleAfterDays` (T3's default: 3 days; `null` turns it off), as of when it went quiet. Pinned
	 * threads, threads kept active, threads with automatic settlement turned off, and running threads stay.
	 */
	async sweepSettlement(now = Date.now()): Promise<void> {
		if (this.#closed || this.#sweeping) return;
		this.#sweeping = true;
		try {
			const settings = this.config.settings.current();
			for (const thread of this.#directory) {
				if (this.#closed) return;
				const days = autoSettleDays(settings, thread.projectId);
				if (days === null || !this.hasThread(thread.threadId)) continue;
				const shell = this.#shellFor(thread.threadId);
				const settledAt = autoSettleAt(shell, days, now, thread.lastSnoozeWakeAt);
				if (settledAt === null) continue;
				try {
					await this.autoSettleThread(thread.threadId, DateTime.toEpochMillis(shell.updatedAt), settledAt);
				} catch (error) {
					this.#log.warn("automatic thread settlement skipped", { threadId: thread.threadId, error: error instanceof Error ? error.message : String(error) });
				}
			}
		} finally {
			this.#sweeping = false;
		}
	}

	async interrupt(threadId: string): Promise<void> {
		const release = this.acquire(threadId);
		try {
			const state = this.#viewOf(threadId);
			// Await the loaded head and let a failure surface, rather than returning quietly and leaving a stale run going.
			const head = await state.head();
			await this.#store.abort({ threadId, conversationId: head });
		} finally {
			release();
		}
	}

	async cancelQueued(threadId: string, runId: string): Promise<void> {
		const release = this.acquire(threadId);
		try {
			await this.#store.cancelQueued(threadId, runId);
		} finally {
			release();
		}
	}

	async editQueued(threadId: string, runId: string, text: string, attachments?: readonly { id: string; name: string; mimeType: string; sizeBytes: number }[]): Promise<void> {
		const release = this.acquire(threadId);
		try {
			await this.#store.editQueued(threadId, runId, text, attachments === undefined ? undefined : [...attachments]);
		} finally {
			release();
		}
	}

	async promoteQueued(threadId: string, runId: string): Promise<void> {
		const release = this.acquire(threadId);
		try {
			await this.#store.promoteQueued(threadId, runId);
		} finally {
			release();
		}
	}

	async startQueued(threadId: string, runId: string | undefined, requestId: string): Promise<void> {
		const release = this.acquire(threadId);
		try {
			await this.#store.startQueued(threadId, runId, requestId);
		} finally {
			release();
		}
	}

	/**
	 * T3's `checkpoint.rollback`: fork the head before the reverted turn and move the thread there. The outcome is kept on
	 * the thread record, and the reverted runs are read back from the head it left (`#rolledBack`).
	 */
	async rollback(input: { threadId: string; commandId: string; checkpointId: string; restoreFiles: boolean }) {
		const release = this.acquire(input.threadId);
		const state = this.#viewOf(input.threadId);
		const failure = await (async (): Promise<string | null> => {
			if (input.restoreFiles) return "pi-durable-t3 does not restore files; use “Revert and keep changes”.";
			const { runs } = await this.projection(input.threadId);
			if (runs.some((run) => run.status === "running")) return "Interrupt the current turn before reverting.";
			// Map the checkpoint to the user entry to fork at (see `undoTarget`); rewind forks just before it.
			const target = undoTarget(runs, input.checkpointId);
			if ("unknown" in target) return `Unknown checkpoint ${input.checkpointId}.`;
			if ("nothing" in target) return "Nothing to revert.";
			const expectedHead = await state.head();
			// The commandId is the rewind's requestId, so the host dedups a retry to one fork (design.md, Invariants).
			await this.#store.rewind({ threadId: input.threadId, expectedHead, entryId: target.entryId, requestId: input.commandId });
			this.#log.info("rewound thread", { threadId: input.threadId, checkpointId: input.checkpointId });
			return null;
		})().catch((error: unknown) => (error as Error).message || "Rewind failed.");
		try {
			await this.#store.recordRollback(input.threadId, input.commandId, failure);
		} finally {
			release();
		}
	}

	/** T3's `thread.fork`: a new thread continuing from a run's last durable entry (or the head's last entry for a
	 * `latest_stable` fork). A synthetic run anchored by a compaction summary has no user turn to rewind to, but its
	 * last kept entry is still a valid fork point. The client names the target id, so a retried command returns the
	 * same thread. */
	async forkThread(input: {
		sourceThreadId: string;
		targetThreadId: string;
		runId?: string | undefined;
		title?: string | undefined;
		provenance?: Provenance;
		/** A child that starts with its parent's history (`thread_prompt` with `fork`). */
		child?: { readonly spawn: Spawn; readonly nodeId: string };
	}): Promise<string> {
		if (SESSION_ID.test(input.targetThreadId) === false) throw new CommandError(`Invalid thread id: ${input.targetThreadId}`);
		const source = await this.projection(input.sourceThreadId);
		const run = input.runId === undefined ? source.forkRuns.at(-1) : source.forkRuns.find((candidate) => candidate.runId === input.runId);
		if (run === undefined) throw new CommandError(`Unknown run ${input.runId ?? "latest_stable"} on thread ${input.sourceThreadId}.`);
		await this.#store.fork({
			sourceThreadId: input.sourceThreadId,
			targetThreadId: input.targetThreadId,
			entryId: run.lastEntryId,
			runId: run.runId,
			provenance: input.provenance ?? USER_WEB,
			...(input.title === undefined ? {} : { title: input.title }),
			...(input.child === undefined ? {} : { child: input.child }),
		});
		return input.targetThreadId;
	}

	async deleteThread(threadId: string): Promise<void> {
		this.#cancelTitle(threadId);
		await this.#store.remove(threadId);
		this.#forget(threadId, new CommandError(`Thread ${threadId} was deleted`));
		for (const listener of this.#deletedListeners) listener(threadId);
	}

	/** A thread was deleted (T3's `scheduled-tasks.cleanup` effect of a thread deletion hangs off this). */
	onThreadDeleted(listener: (threadId: string) => void): () => void {
		this.#deletedListeners.add(listener);
		return () => this.#deletedListeners.delete(listener);
	}

	/**
	 * T3's `orchestration.searchThreads`, answered from the host's threads (`Threads.search`, whose scan lives in the
	 * threads layer). The result is T3's shape: message timestamps cross the wire as ISO, the same conversion the projection
	 * makes; the matching, ranking and ordering are T3's (`t3/thread-search.ts`).
	 */
	async searchThreads(query: string, limit: number): Promise<OrchestrationSearchThreadsResult> {
		const matches = await this.#store.search(query, limit);
		return {
			matches: matches.map((match) => ({
				threadId: match.threadId,
				projectId: match.projectId,
				source: match.source,
				snippet: match.snippet,
				messageCreatedAt: match.messageCreatedAt === null ? null : new Date(match.messageCreatedAt).toISOString(),
			})),
		} as unknown as OrchestrationSearchThreadsResult;
	}

	async close(): Promise<void> {
		// Shutdown cancels the title work it started: the hook's model call stops, and nothing lands on a closed host.
		for (const pending of this.#titleRequests.values()) pending.controller.abort();
		this.#titleRequests.clear();
		this.#closed = true;
		if (this.#settleTimer !== undefined) clearInterval(this.#settleTimer);
		this.#settingsStop?.();
		await this.#taskWatch?.stop().catch(() => {});
		this.#runHolds.clear();
		for (const view of this.#views.values()) view.release();
		this.#changeStop?.();
		this.#registryStop?.();
	}
}
