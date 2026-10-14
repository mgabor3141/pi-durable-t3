// Bridge core: the T3 view over the host's threads. It is a local client of the chord2 objects — it reads the thread
// directory from `pi.threads`, each thread's head view from `pi.transcript` and model state from `pi.models`, and
// writes through `pi.controller` (prompt/steer/followUp/abort/rewind). It holds the per-thread projection memory
// (rolled-back runs) and the monotonic sequence counter.
import { createHash, randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { Ctx, Handle, Host } from "@earendil-works/chord";
import type {
	OrchestrationProjectShell,
	OrchestrationV2ShellSnapshot,
	OrchestrationV2ThreadProjection,
	OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { PiController, PiModels, PiThreads, PiTranscript } from "../objects.ts";
import type { Thread } from "../threads.ts";
import type { BridgeConfig } from "./config.ts";
import type { Logger } from "./logging.ts";
import { type ConversationView, type ModelRef, type ModelsState, splitSlug } from "./model-types.ts";
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
	| { kind: "project.updated"; sequence: number; project: OrchestrationProjectShell };

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINK_IDLE_MS = 30_000;
const EMIT_THROTTLE_MS = 60;

/** A project id derived from a normalized absolute path, so the same folder maps to the same id every process: a random
 * per-process id strands T3's selection for that folder on every restart. Configured projects use their name (a stable,
 * user-chosen id); this is the path-derived form for a cwd the configuration does not cover. */
const projectIdForPath = (path: string): string => `p-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;

export class Bridge {
	readonly config: BridgeConfig;
	readonly #host: Host;
	readonly #log: Logger;
	readonly #threads = new Map<string, ThreadState>();
	readonly #shellListeners = new Set<(item: ShellItem) => void>();
	readonly #shells = new Map<string, OrchestrationV2ThreadShell>();
	readonly #extraProjects = new Map<string, { title: string; path: string }>();
	readonly #commandResults = new Map<string, Promise<number>>();
	/** Called with every thread's `pi.models` state, so the provider catalog follows the host. */
	onModels: ((models: ModelsState | undefined) => void) | undefined;
	/** Model reported for threads whose transcript is not loaded. */
	defaultModel: () => ModelRef | null = () => null;
	#directory: Thread[] = [];
	#directoryStop: (() => void) | undefined;
	#sequence = 0;
	#startedAt = new Date().toISOString();

	constructor(config: BridgeConfig, log: Logger, host: Host) {
		this.config = config;
		this.#log = log;
		this.#host = host;
	}

	start(): void {
		const handle = this.#host.get(PiThreads, {});
		const publish = (): void => {
			this.#directory = (handle.threads.value?.threads ?? []).map((thread) => ({ ...thread }));
			this.#refreshShells();
		};
		this.#directoryStop = handle.threads.subscribe(publish);
		publish();
		this.#log.info("bridge started (over the objects)");
	}

	/** Strictly increasing across restarts (clock-based) so clients never drop items as stale. */
	nextSequence(): number {
		this.#sequence = Math.max(this.#sequence + 1, Date.now());
		return this.#sequence;
	}

	// ---- projects ---------------------------------------------------------------------------------------------

	#projectPath(projectId: string): string | undefined {
		return this.config.projects.find((project) => project.id === projectId)?.path;
	}

	projectForCwd(cwd: string | undefined): { id: string; title: string; path: string } {
		const configured = this.config.projects.find(
			(project) => cwd !== undefined && (cwd === project.path || cwd.startsWith(`${project.path}/`)),
		);
		if (configured !== undefined) return { id: configured.id, title: configured.name, path: configured.path };
		// Not configured: derive the id from the normalized absolute path, so the folder keeps its identity across restarts.
		const path = cwd === undefined ? "/" : resolve(cwd);
		return { id: projectIdForPath(path), title: `${basename(path) || path} (other)`, path };
	}

	/** A project shell with the fixed fields T3 expects, stamped at the bridge's start time. */
	#projectShell(project: { id: string; title: string; path: string }): OrchestrationProjectShell {
		return {
			id: project.id,
			title: project.title,
			workspaceRoot: project.path,
			repositoryIdentity: null,
			defaultModelSelection: null,
			scripts: [],
			createdAt: this.#startedAt,
			updatedAt: this.#startedAt,
		} as unknown as OrchestrationProjectShell;
	}

	projects(): OrchestrationProjectShell[] {
		return [
			...this.config.projects.map((p) => this.#projectShell({ id: p.id, title: p.name, path: p.path })),
			...[...this.#extraProjects].map(([id, project]) => this.#projectShell({ id, title: project.title, path: project.path })),
		];
	}

	// ---- shell ------------------------------------------------------------------------------------------------

	#summary(threadId: string): Thread | undefined {
		return this.#directory.find((thread) => thread.threadId === threadId);
	}

	#meta(threadId: string, thread: Thread | undefined, state: ThreadState | undefined): ThreadMeta {
		const cwd = (thread === undefined ? undefined : this.#projectPath(thread.projectId)) ?? state?.view?.docs["pi.agent"]?.cwd ?? "/";
		const project = this.projectForCwd(cwd);
		if (!this.config.projects.some((p) => p.id === project.id) && !this.#extraProjects.has(project.id)) {
			this.#extraProjects.set(project.id, { title: project.title, path: project.path });
			const shell = this.#projectShell(project);
			queueMicrotask(() => this.#emitShell({ kind: "project.updated", sequence: this.nextSequence(), project: shell }));
		}
		const model: ModelRef | null = state?.configuration?.model ?? state?.view?.docs["pi.agent"]?.model ?? this.defaultModel();
		return {
			threadId,
			projectId: project.id,
			title: thread?.title || "New thread",
			cwd,
			createdAt: thread?.createdAt ?? Date.now(),
			updatedAt: thread?.createdAt ?? Date.now(),
			model,
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

	#buildModelsState(state: ThreadState): ModelsState {
		return {
			catalog: { revision: 1, availableModels: state.catalog.map((model) => ({ ...model, name: model.modelId })) },
			configuration: { model: state.configuration?.model ?? null, thinkingLevel: state.configuration?.thinkingLevel ?? "off" },
		};
	}

	#recompute(state: ThreadState): void {
		if (state.view === undefined) return;
		this.onModels?.(this.#buildModelsState(state));
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

	/** Wait until the thread's transcript is loaded and return its projection. */
	async projection(threadId: string, timeoutMs = 30_000): Promise<ProjectionResult> {
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

	/** Subscribe to full projection snapshots of a thread. The first snapshot arrives once the transcript loads. */
	subscribeThread(
		threadId: string,
		listener: (snapshot: { sequence: number; projection: OrchestrationV2ThreadProjection }) => void,
		onEnd: () => void = () => {},
	): () => void {
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
		if (this.#commandResults.size > 2_000) {
			const oldest = this.#commandResults.keys().next().value;
			if (oldest !== undefined) this.#commandResults.delete(oldest);
		}
		return result;
	}

	/**
	 * Wait until the thread's head conversation is actually loaded and return its id. A freshly created thread's
	 * transcript cell resolves a few awaits after `acquire`, and its initial value is the empty view with a `0` id — so a
	 * write that read `conversationId` directly could see `undefined`/`0` and lose the message (or aim at conversation 0).
	 * Every write path awaits the real head first: no cold message loss, and no reliance on some earlier call having
	 * warmed the transcript.
	 */
	async #awaitHead(state: ThreadState, timeoutMs = 15_000): Promise<number> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const id = state.conversationId;
			if (id !== undefined && id !== 0) return id;
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

	async createThread(options: { threadId?: string | undefined; projectId: string }): Promise<string> {
		const project = this.config.projects.find((p) => p.id === options.projectId);
		if (project === undefined) throw new CommandError(`Unknown project: ${options.projectId}`);
		const id = options.threadId !== undefined && SESSION_ID.test(options.threadId) ? options.threadId : randomUUID();
		if (this.#summary(id) !== undefined) return id;
		const handle = this.#host.get(PiThreads, {});
		await this.#host.root((c) => handle.create({ threadId: id, projectId: project.id }, c));
		return id;
	}

	async selectModel(threadId: string, slug: string): Promise<void> {
		const model = splitSlug(slug);
		if (model === undefined) return;
		const release = this.acquire(threadId);
		try {
			const state = this.#state(threadId);
			const current = state.configuration?.model;
			if (current?.provider === model.provider && current.modelId === model.modelId) return;
			await this.#call(threadId, (_controller, models, c) => models.select({ provider: model.provider, modelId: model.modelId }, c));
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
			// The client's message id rides in the entry (`app.user`, placed by `Threads.submit`), so the projection reads it
			// back from the entry it is already reading; `requestId` stays the commandId for durable dedup.
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
			// The commandId is the rewind's requestId, so the host dedups a retry (and a lost connection) to one fork.
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
		const state = this.#threads.get(threadId);
		if (state !== undefined) this.#forget(state, new CommandError(`Thread ${threadId} was deleted`));
	}

	async close(): Promise<void> {
		for (const state of this.#threads.values()) this.#release(state);
		this.#directoryStop?.();
	}
}
