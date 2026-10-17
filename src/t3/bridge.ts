// The T3 view over the host's threads: a local client of the chord objects (`pi.threads`, `pi.transcript`,
// `pi.models`, `pi.controller`). It holds the per-thread projection memory (rolled-back runs) and the sequence counter.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { Ctx, Handle, Host } from "@earendil-works/chord";
import type {
	OrchestrationProjectShell,
	OrchestrationV2ShellSnapshot,
	OrchestrationV2ThreadProjection,
	OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { PiController, PiModels, PiThreads, PiTranscript } from "../objects.ts";
import type { Project } from "../config.ts";
import { ProjectConflict, ProjectIdConflict, ProjectWorkspaceMissing, ProjectWorkspaceNotCreatable, ProjectWorkspaceNotDirectory } from "../registry.ts";
import { claimScratchThreadFolder, ensureScratchProject, isScratchRoot, SCRATCH_PROJECT_ICON } from "../scratch.ts";
import type { Thread } from "../threads.ts";
import type { BridgeConfig } from "./config.ts";
import type { Logger } from "./logging.ts";
import { type ConversationView, type ModelRef, splitSlug, thinkingOf } from "./model-types.ts";
import { type ProjectionResult, projectThread, type ThreadMeta } from "./projection.ts";
import { BASELINE_CHECKPOINT_ID, MAX_ROLLED_BACK_RUNS, type RolledBackRun, rolledBackRuns, undoTarget } from "./undo.ts";

export class CommandError extends Error {}

interface ThreadState {
	readonly threadId: string;
	refs: number;
	closeTimer: NodeJS.Timeout | undefined;
	rolledBack: RolledBackRun[];
	rollbackRequestId: string | undefined;
	rollbackFailure: { requestId: string; message: string } | null | undefined;
	result: ProjectionResult | undefined;
	snapshotSequence: number;
	listeners: Set<(snapshot: { sequence: number; projection: OrchestrationV2ThreadProjection }) => void>;
	/** Called when the thread is gone (deleted, or unknown to the host); subscriptions end. */
	enders: Set<() => void>;
	gone: Error | undefined;
	emitTimer: NodeJS.Timeout | undefined;
	/** Unsubscribes for this thread's object handles, while it is open. */
	stops: (() => void)[];
	/** The head conversation id (the write target) and its assembled view, from `pi.transcript` / `pi.models`. */
	conversationId: number | undefined;
	view: ConversationView | undefined;
	configuration: { model: ModelRef | null; thinkingLevel: string } | undefined;
	catalog: ModelRef[];
}

type ShellItem =
	| { kind: "thread.updated"; sequence: number; location: "active"; thread: OrchestrationV2ThreadShell }
	| { kind: "thread.removed"; sequence: number; location: "active"; threadId: string }
	| { kind: "project.updated"; sequence: number; project: OrchestrationProjectShell }
	| { kind: "project.removed"; sequence: number; projectId: string };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINK_IDLE_MS = 30_000;
const EMIT_THROTTLE_MS = 60;

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

/** How many client-chosen command ids the bridge remembers for dispatch idempotency: the only memory a client-chosen
 * id can make the host spend (state.md). Past it the oldest entry is dropped, and an old retry is a fresh request. */
export const DEDUP_ENTRY_LIMIT = 2_000;


export class Bridge {
	readonly config: BridgeConfig;
	readonly #host: Host;
	readonly #log: Logger;
	readonly #threads = new Map<string, ThreadState>();
	readonly #shellListeners = new Set<(item: ShellItem) => void>();
	readonly #shells = new Map<string, OrchestrationV2ThreadShell>();
	/** The project ids last shown to clients, so a registry change emits the removed shells. */
	#projectIds = new Set<string>();
	readonly #commandResults = new Map<string, Promise<number>>();
	#directory: Thread[] = [];
	/** The `pi.threads` handle, so a create/remove can refresh the directory synchronously: the thread-existence check
	 * must never race the subscription that mirrors the document. */
	#threadsHandle: Handle<typeof PiThreads> | undefined;
	#directoryStop: (() => void) | undefined;
	#registryStop: (() => void) | undefined;
	#sequence = 0;
	#startedAt = new Date().toISOString();

	constructor(config: BridgeConfig, log: Logger, host: Host) {
		this.config = config;
		this.#log = log;
		this.#host = host;
	}

	start(): void {
		const handle = this.#host.get(PiThreads, {});
		this.#threadsHandle = handle;
		const publish = (): void => {
			this.#directory = (handle.threads.value?.threads ?? []).map((thread) => ({ ...thread }));
			this.#refreshShells();
		};
		this.#directoryStop = handle.threads.subscribe(publish);
		publish();
		// A UI edit to the registry (add/remove/rename/move) lands here: removed ids emit a removal and every current
		// project shell is re-emitted — a client keys shells by id, so an unchanged re-emission is a no-op.
		this.#projectIds = new Set(this.#configured().map((project) => project.id));
		this.#registryStop = this.config.registry.subscribe(() => this.#onRegistryChange());
		this.#log.info("bridge started (over the objects)");
	}

	#onRegistryChange(): void {
		const current = this.#configured();
		const currentIds = new Set(current.map((project) => project.id));
		for (const id of [...this.#projectIds]) {
			if (currentIds.has(id)) continue;
			this.#emitShell({ kind: "project.removed", sequence: this.nextSequence(), projectId: id });
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
	ensureScratch(): Promise<{ readonly projectId: string }> {
		const root = this.config.scratchDir;
		if (root === undefined) throw new CommandError("This host has no Scratch folder (no scratch dir is configured).");
		return ensureScratchProject(this.config.registry, root);
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

		/**
	 * One project mutation, answered from the state — no receipt store (design.md, Invariants).
	 */
	mutateProject(mutation: ProjectMutation): Promise<Record<string, unknown>> {
		return this.#applyMutation(mutation);
	}

	async #applyMutation(mutation: ProjectMutation): Promise<Record<string, unknown>> {
		switch (mutation.type) {
			case "project.create": {
				if (mutation.workspaceRoot === undefined) throw new CommandError("A project needs a workspace root (a folder path).");
				await this.#ensureWorkspaceRoot(this.config.registry.resolvePath(mutation.workspaceRoot), mutation.createWorkspaceRootIfMissing === true);
				// Honor the id the client minted; the registry derives from the normalized path for everything else (design.md, IDs).
				const added = this.#createProject(mutation.title, mutation.workspaceRoot, mutation.projectId);
				return this.#projectResult(added, null);
			}
			case "project.update": {
				// A move names a new root: T3 normalizes an update's root WITHOUT creating it (`ProjectService.update`).
				if (mutation.workspaceRoot !== undefined) await this.#ensureWorkspaceRoot(this.config.registry.resolvePath(mutation.workspaceRoot), false);
				const updated = this.config.registry.update(mutation.projectId, {
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
				this.config.registry.remove(mutation.projectId);
				// Drain late arrivals: read the CELL (authoritative after each awaited delete) until it shows no rows under
				// the id. Rows landing from `registry.remove` onward are refused by the commit-time FK check, so the drain
				// terminates (design.md, Invariants).
				for (;;) {
					if (this.#threadsHandle === undefined) break;
					const late = (this.#threadsHandle.threads.value?.threads ?? []).filter((thread) => thread.projectId === mutation.projectId);
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
	#createProject(title: string | undefined, workspaceRoot: string, clientId: string | undefined): Project {
		try {
			return this.config.registry.add(title, workspaceRoot, { ...(clientId === undefined ? {} : { clientId }) });
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

	/** A T3 `Project` for a mutation's result. Only the fields a paired client reads are set; the rest are the shell's nulls. */
	#projectResult(project: { id: string; name: string; cwd: string }, deletedAt: string | null): Record<string, unknown> {
		return {
			id: project.id,
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

	#meta(threadId: string, thread: Thread | undefined, state: ThreadState | undefined): ThreadMeta {
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
			updatedAt: thread?.createdAt ?? Date.now(),
			model,
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			...(thread?.parent?.threadId === undefined ? {} : { parentThreadId: thread.parent.threadId }),
			running: state?.view?.docs["pi.live"]?.run !== undefined,
		};
	}

	#shellFor(threadId: string): OrchestrationV2ThreadShell {
		const state = this.#threads.get(threadId);
		if (state?.result !== undefined) return state.result.shell;
		return projectThread(this.#meta(threadId, this.#summary(threadId), state), undefined, {
			rolledBack: state?.rolledBack ?? [],
			rollbackRequestId: state?.rollbackRequestId,
			rollbackFailure: state?.rollbackFailure,
		}).shell;
	}

	shellSnapshot(): OrchestrationV2ShellSnapshot {
		const threads = this.#directory.map((thread) => this.#shellFor(thread.threadId));
		for (const shell of threads) this.#shells.set(shell.id as string, shell);
		return {
			schemaVersion: 1,
			snapshotSequence: this.nextSequence(),
			projects: this.projects(),
			threads,
			archivedThreads: [],
		} as unknown as OrchestrationV2ShellSnapshot;
	}

	onShell(listener: (item: ShellItem) => void): () => void {
		this.#shellListeners.add(listener);
		return () => this.#shellListeners.delete(listener);
	}

	#emitShell(item: ShellItem): void {
		for (const listener of this.#shellListeners) listener(item);
	}

	#refreshShells(): void {
		const seen = new Set<string>();
		for (const thread of this.#directory) {
			seen.add(thread.threadId);
			const state = this.#threads.get(thread.threadId);
			if (state !== undefined) this.#recompute(state);
			this.#publishShell(thread.threadId);
		}
		for (const threadId of [...this.#shells.keys()]) {
			if (seen.has(threadId)) continue;
			this.#shells.delete(threadId);
			const state = this.#threads.get(threadId);
			if (state !== undefined) this.#forget(state, new CommandError(`Thread ${threadId} was removed`));
			this.#emitShell({ kind: "thread.removed", sequence: this.nextSequence(), location: "active", threadId });
		}
	}

	#publishShell(threadId: string): void {
		if (this.#summary(threadId) === undefined) return;
		const shell = this.#shellFor(threadId);
		const previous = this.#shells.get(threadId);
		if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(shell)) return;
		this.#shells.set(threadId, shell);
		this.#emitShell({ kind: "thread.updated", sequence: this.nextSequence(), location: "active", thread: shell });
	}

	// ---- threads ----------------------------------------------------------------------------------------------

	#state(threadId: string): ThreadState {
		let state = this.#threads.get(threadId);
		if (state === undefined) {
			state = {
				threadId,
				refs: 0,
				closeTimer: undefined,
				rolledBack: [],
				rollbackRequestId: undefined,
				rollbackFailure: undefined,
				result: undefined,
				snapshotSequence: 0,
				listeners: new Set(),
				enders: new Set(),
				gone: undefined,
				emitTimer: undefined,
				stops: [],
				conversationId: undefined,
				view: undefined,
				configuration: undefined,
				catalog: [],
			};
			this.#threads.set(threadId, state);
		}
		return state;
	}

	/** Attach this thread's object handles; keep its assembled snapshot current and recompute on any change. */
	#open(state: ThreadState): void {
		if (state.closeTimer !== undefined) {
			clearTimeout(state.closeTimer);
			state.closeTimer = undefined;
		}
		if (state.stops.length > 0) return;
		const key = { threadId: state.threadId };
		const transcript = this.#host.get(PiTranscript, key);
		const models = this.#host.get(PiModels, key);
		const fire = (): void => {
			state.view = transcript.transcript.value?.view as ConversationView | undefined;
			state.conversationId = transcript.transcript.value?.conversationId;
			state.catalog = (models.catalog.value ?? []).map((model) => ({ provider: model.provider, modelId: model.modelId }));
			const configuration = models.configuration.value;
			if (configuration !== undefined) state.configuration = { model: configuration.model ?? null, thinkingLevel: configuration.thinkingLevel };
			this.#recompute(state);
		};
		state.stops.push(transcript.transcript.subscribe(fire), models.catalog.subscribe(fire), models.configuration.subscribe(fire));
		fire();
	}

	/** Detach a thread's handles (idle release); its result is dropped and recomputed on the next open. */
	#release(state: ThreadState): void {
		for (const stop of state.stops.splice(0)) stop();
		state.result = undefined;
	}

	/** Drop a thread that no longer exists: end its subscriptions. */
	#forget(state: ThreadState, error: Error): void {
		if (this.#threads.get(state.threadId) !== state) return;
		this.#threads.delete(state.threadId);
		state.gone = error;
		if (state.closeTimer !== undefined) clearTimeout(state.closeTimer);
		this.#release(state);
		for (const end of state.enders) end();
		state.listeners.clear();
		state.enders.clear();
		this.#log.info("thread forgotten", { threadId: state.threadId, reason: error.message });
	}

	/** Keep a thread's handles attached while `hold` runs or a subscriber exists. */
	acquire(threadId: string): () => void {
		if (!SESSION_ID.test(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const state = this.#state(threadId);
		state.refs++;
		this.#open(state);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.refs--;
			if (state.refs > 0) return;
			state.closeTimer = setTimeout(() => {
				if (state.refs > 0) return;
				this.#release(state);
			}, LINK_IDLE_MS);
			state.closeTimer.unref();
		};
	}

	#recompute(state: ThreadState): void {
		if (state.view === undefined) return;
		state.result = projectThread(
			this.#meta(state.threadId, this.#summary(state.threadId), state),
			state.view,
			{ rolledBack: state.rolledBack, rollbackRequestId: state.rollbackRequestId, rollbackFailure: state.rollbackFailure },
		);
		this.#publishShell(state.threadId);
		if (state.listeners.size === 0 || state.emitTimer !== undefined) return;
		state.emitTimer = setTimeout(() => {
			state.emitTimer = undefined;
			this.#emitThread(state);
		}, EMIT_THROTTLE_MS);
	}

	#emitThread(state: ThreadState): void {
		if (state.result === undefined) return;
		state.snapshotSequence = this.nextSequence();
		for (const listener of state.listeners) {
			listener({ sequence: state.snapshotSequence, projection: state.result.projection });
		}
	}

	/** Wait until the thread's transcript is loaded and return its projection. A thread absent from the threads
	 * document is the typed not-found — never a fabricated empty thread (design.md, Invariants). */
	async projection(threadId: string, timeoutMs = 30_000): Promise<ProjectionResult> {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const release = this.acquire(threadId);
		try {
			const state = this.#state(threadId);
			const deadline = Date.now() + timeoutMs;
			while (state.result === undefined) {
				if (state.gone !== undefined) throw new CommandError(`Unknown thread: ${threadId}`);
				if (Date.now() > deadline) throw new CommandError(`Timed out loading thread ${threadId}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			return state.result;
		} finally {
			release();
		}
	}

	/** Subscribe to full projection snapshots of a thread. The first snapshot arrives once the transcript loads.
	 * A thread the host does not know refuses synchronously (the stream carries the typed not-found); it never
	 * emits an empty snapshot and stays open. */
	subscribeThread(
		threadId: string,
		listener: (snapshot: { sequence: number; projection: OrchestrationV2ThreadProjection }) => void,
		onEnd: () => void = () => {},
	): () => void {
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const release = this.acquire(threadId);
		const state = this.#state(threadId);
		state.listeners.add(listener);
		state.enders.add(onEnd);
		if (state.result !== undefined) {
			listener({ sequence: this.nextSequence(), projection: state.result.projection });
		}
		return () => {
			state.listeners.delete(listener);
			state.enders.delete(onEnd);
			release();
		};
	}

	// ---- commands ---------------------------------------------------------------------------------------------

	/** Run a command once per commandId: retries of the same command return the first result. */
	idempotent(commandId: string, run: () => Promise<number>): Promise<number> {
		const existing = this.#commandResults.get(commandId);
		if (existing !== undefined) return existing;
		const result = run();
		this.#commandResults.set(commandId, result);
		result.catch(() => this.#commandResults.delete(commandId));
		while (this.#commandResults.size > DEDUP_ENTRY_LIMIT) {
			const oldest = this.#commandResults.keys().next().value;
			if (oldest !== undefined) this.#commandResults.delete(oldest);
		}
		return result;
	}

	/**
	 * Wait until the thread's head conversation is loaded and return its id: a freshly created thread's transcript cell
	 * resolves a few awaits after `acquire`, and its initial value is the empty view, so every write path awaits the real
	 * head first — no cold message loss, and no reliance on an earlier call having warmed the transcript (design.md).
	 */
	async #awaitHead(state: ThreadState, timeoutMs = 15_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const id = state.conversationId;
			if (id !== undefined) return id;
			if (state.gone !== undefined) throw new CommandError(`Unknown thread: ${state.threadId}`);
			if (Date.now() > deadline) throw new CommandError(`The thread ${state.threadId} is still loading; send again in a moment.`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	/** Run a `pi.controller` / `pi.models` call for a thread under the host root. */
	#call<T>(threadId: string, fn: (controller: Handle<typeof PiController>, models: Handle<typeof PiModels>, c: Ctx) => Promise<T>): Promise<T> {
		const controller = this.#host.get(PiController, { threadId });
		const models = this.#host.get(PiModels, { threadId });
		return this.#host.root((c) => fn(controller, models, c));
	}

	/**
	 * A new thread. `launchText` is the launch's first message (or title): T3's server gives a thread launched in the
	 * Scratch project a folder of its own, claimed at launch — a thread whose row already exists is a replayed create and
	 * claims nothing, exactly T3's "only the first attempt claims one" (ManagedProjectFolders, ThreadLaunchService).
	 */
	async createThread(options: { threadId?: string | undefined; projectId: string; launchText?: string }): Promise<string> {
		const project = this.config.registry.list().find((p) => p.id === options.projectId);
		if (project === undefined) throw new CommandError(`Unknown project: ${options.projectId}`);
		const id = options.threadId !== undefined && SESSION_ID.test(options.threadId) ? options.threadId : randomUUID();
		if (this.#summary(id) !== undefined) return id;
		const scratchRoot = this.config.scratchDir;
		const cwd =
			options.launchText === undefined || scratchRoot === undefined || !isScratchRoot(project.cwd, scratchRoot)
				? undefined
				: await claimScratchThreadFolder(scratchRoot, id, options.launchText);
		const handle = this.#host.get(PiThreads, {});
		await this.#host.root((c) => handle.create({ threadId: id, projectId: project.id, ...(cwd === undefined ? {} : { cwd }) }, c));
		// Read the document back synchronously: the thread-existence check must not race the subscription mirror.
		this.#syncDirectory();
		return id;
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
			const current = this.#state(threadId).configuration;
			const modelChanged = current?.model?.provider !== model.provider || current?.model?.modelId !== model.modelId;
			const thinkingChanged = thinking !== undefined && current?.thinkingLevel !== thinking;
			if (!modelChanged && !thinkingChanged) return;
			// The model first: an unknown one is refused, and the level is applied to the thread the model landed on.
			await this.#call(threadId, async (_controller, models, c) => {
				if (modelChanged) await models.select({ provider: model.provider, modelId: model.modelId }, c);
				if (thinkingChanged) await models.selectThinking({ level: thinking }, c);
			});
		} finally {
			release();
		}
	}

	async sendMessage(input: {
		threadId: string;
		commandId: string;
		messageId: string;
		text: string;
		mode: "start" | "queue" | "steer" | "restart";
	}): Promise<void> {
		const release = this.acquire(input.threadId);
		try {
			const state = this.#state(input.threadId);
			const head = await this.#awaitHead(state);
			const busy = state.view?.docs["pi.live"]?.run !== undefined;
			// The client's message id rides in the entry (`app.user`, placed by `Threads.submit`); `requestId` stays the
			// commandId for durable dedup (design.md, Invariants).
			const request = { conversationId: head, requestId: input.commandId, message: input.text, messageId: input.messageId };
			// `restart` interrupts the active turn first; `steer` applies to it; while a run is live `start`/`queue`
			// become a follow-up. Each maps to one `pi.controller` write, keyed by the commandId for wire idempotency.
			await this.#call(input.threadId, async (controller, _models, c) => {
				if (input.mode === "restart" && busy) await controller.abort({ conversationId: head }, c);
				if (input.mode === "steer") await controller.steer(request, c);
				else if (busy && input.mode !== "restart") await controller.followUp(request, c);
				else await controller.prompt(request, c);
			});
		} finally {
			release();
		}
	}

	async interrupt(threadId: string): Promise<void> {
		const release = this.acquire(threadId);
		try {
			const state = this.#state(threadId);
			// Await the loaded head and let a failure surface, rather than returning quietly and leaving a stale run going.
			const head = await this.#awaitHead(state);
			await this.#call(threadId, (controller, _models, c) => controller.abort({ conversationId: head }, c));
		} finally {
			release();
		}
	}

	async rollback(input: { threadId: string; commandId: string; checkpointId: string; restoreFiles: boolean }) {
		const release = this.acquire(input.threadId);
		const state = this.#state(input.threadId);
		const fail = (message: string) => {
			state.rollbackFailure = { requestId: input.commandId, message };
			this.#recompute(state);
		};
		try {
			const { projection, runs } = await this.projection(input.threadId);
			state.rollbackRequestId = input.commandId;
			state.rollbackFailure = null;
			if (input.restoreFiles) {
				return fail("pi-durable-t3 does not restore files; use “Revert and keep changes”.");
			}
			if (runs.some((run) => run.status === "running")) return fail("Interrupt the current turn before reverting.");

			// Map the checkpoint to the user entry to fork at (see `undoTarget`); rewind forks there, keeping runs 1..N.
			const target = undoTarget(runs, input.checkpointId);
			if ("unknown" in target) return fail(`Unknown checkpoint ${input.checkpointId}.`);
			if ("nothing" in target) return fail("Nothing to revert.");

			const expectedHead = await this.#awaitHead(state);

			const rolled = rolledBackRuns(projection, target.keepOrdinal);
			// The commandId is the rewind's requestId, so the host dedups a retry to one fork (design.md, Invariants).
			await this.#call(input.threadId, (controller, _models, c) =>
				controller.rewind({ expectedHead, entryId: target.entryId, requestId: input.commandId }, c),
			);
			state.rolledBack = [
				...state.rolledBack.filter((r) => !rolled.some((x) => x.run.id === r.run.id)),
				...rolled,
			].slice(-MAX_ROLLED_BACK_RUNS);
			this.#recompute(state);
			this.#log.info("rewound thread", { threadId: input.threadId, keepOrdinal: target.keepOrdinal, rolledBack: rolled.length });
		} catch (error) {
			fail((error as Error).message || "Rewind failed.");
		} finally {
			release();
		}
	}

	async deleteThread(threadId: string): Promise<void> {
		const handle = this.#host.get(PiThreads, {});
		await this.#host.root((c) => handle.remove({ threadId }, c));
		this.#syncDirectory();
		const state = this.#threads.get(threadId);
		if (state !== undefined) this.#forget(state, new CommandError(`Thread ${threadId} was deleted`));
	}

	/** Refresh the directory mirror from the `pi.threads` handle (its cell value is authoritative after an awaited
	 * mutation), so a just-created thread is never "unknown" to the next read and a just-deleted one is never known. */
	#syncDirectory(): void {
		const handle = this.#threadsHandle;
		if (handle === undefined) return;
		this.#directory = (handle.threads.value?.threads ?? []).map((thread) => ({ ...thread }));
	}

	async close(): Promise<void> {
		for (const state of this.#threads.values()) this.#release(state);
		this.#directoryStop?.();
		this.#registryStop?.();
	}
}
