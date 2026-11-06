// The T3 view over the host's threads: the threads layer (`../threads.ts`) for every write, one watch on the threads
// document for the directory, and one watch per open thread on its head conversation. It holds the per-thread projection
// memory (rolled-back runs) and the sequence counter.
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
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
import { type Provenance, type Thread, type Threads, USER_WEB } from "../threads.ts";
import type { AttachmentRecord, AttachmentStore } from "./attachment-store.ts";
import type { BridgeConfig, TitleThreadRequest } from "./config.ts";
import type { AgentChange, Conversation, ConversationId, Cursor, EntryId, WatchHandle } from "@earendil-works/pi-durable";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JsonValue } from "@earendil-works/chord";
import type { Logger } from "./logging.ts";
import type { WsItem, WsSuccess } from "./ws-types.ts";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { type ConversationView, type ContentBlock, type EntryRecord, type ModelRef, splitSlug, thinkingOf } from "./model-types.ts";
import { type ProjectionResult, projectThread, type ThreadMeta } from "./projection.ts";
import { attachmentsOf, USER_ENTRY_KINDS } from "./runs.ts";
import { detailsConversationId, parseSubagentThreadId, type SubagentRef, subagentNodeId, subagentThreadTitle } from "./subagents.ts";
import { BASELINE_CHECKPOINT_ID, MAX_ROLLED_BACK_RUNS, type RolledBackRun, rolledBackRuns, undoTarget } from "./undo.ts";

export class CommandError extends Error {}

/** Where file attachments are copied so the workspace tools can read them by path. */
export const ATTACHMENT_WORKSPACE_DIR = "/home/agent/attachments";

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

interface ThreadState {
	readonly threadId: string;
	refs: number;
	closeTimer: NodeJS.Timeout | undefined;
	rolledBack: RolledBackRun[];
	rollbackRequestId: string | undefined;
	rollbackFailure: { requestId: string; message: string } | null | undefined;
	result: ProjectionResult | undefined;
	/** The head's real view has been projected once since the thread was opened. */
	loadedView: boolean;
	/** Replaced and settled on every load-state change (a view, a release, a removal): what waiters wait on. */
	changed: PromiseWithResolvers<void>;
	snapshotSequence: number;
	listeners: Set<(snapshot: { sequence: number; projection: OrchestrationV2ThreadProjection }) => void>;
	/** Called when the thread is gone (deleted, or unknown to the host); subscriptions end. */
	enders: Set<() => void>;
	gone: Error | undefined;
	emitTimer: NodeJS.Timeout | undefined;
	/** The watch on the head conversation while the thread is open; `undefined` once released. */
	follower: Follower | undefined;
	/** The head conversation id (the write target) once its view has loaded, and that view. */
	conversationId: number | undefined;
	view: ConversationView | undefined;
	/** Display-only transcript above the active context's compaction cut. */
	history: EntryRecord[] | undefined;
	configuration: { model: ModelRef | null; thinkingLevel: string } | undefined;
	/** The catalog entries, each with its input modalities, so the send path knows which models accept images. */
	catalog: { provider: string; modelId: string; input: string[]; contextWindow: number }[];
}

/** An open thread's watch on its head conversation. A head switch (undo, fork promotion) restarts it on the new head. */
interface Follower {
	head: number | undefined;
	watch: WatchHandle<ConversationView> | undefined;
	/** Bumped on every head switch, so a callback of a superseded watch changes nothing. */
	generation: number;
	/** Bumped on every view, so a slow history load cannot overwrite a newer view. */
	viewSeq: number;
	/** The compaction cut the cached history was loaded for (`-1`: none). */
	historyCutoff: number;
	history: EntryRecord[];
	/** The head's `pi.agent` document as last read; its configuration is re-read only when it changes. */
	agentKey: string | undefined;
	closed: boolean;
}

/** The view of a head conversation that does not exist: no entries, no docs. */
const EMPTY_VIEW = { conversation: {}, entries: [], docs: {} } as unknown as ConversationView;

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The entry before the active context's first kept entry, when the view starts at a compaction; else `-1`. */
function compactionCutoff(view: ConversationView): number {
	const head = view.entries[0];
	if (head?.kind !== "pi.compaction") return -1;
	const firstKept = view.entries[1];
	return (firstKept?.id ?? head.id) - 1;
}

/** The entries above a compaction cut, for display only: compaction keeps them durably but drops them from the view. */
async function loadHistory(conversation: Conversation, cutoff: number): Promise<EntryRecord[]> {
	if (cutoff <= 0) return [];
	const items: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending", maxEntryId: cutoff as EntryId }, 500, cursor, BACKGROUND_CONTEXT);
		items.push(...(page.items as unknown as EntryRecord[]));
		cursor = page.next;
	} while (cursor !== undefined);
	// Compaction markers are rendered as cards by the projection; an older summary here would be a stray bubble.
	return items.filter((entry) => entry.kind !== "pi.compaction" && entry.id <= cutoff);
}

/** A live shell item: everything \`orchestration.subscribeShell\` streams after its snapshot. */
type ShellItem = Exclude<WsItem<"orchestration.subscribeShell">, { readonly kind: "snapshot" } | { readonly kind: "synchronized" }>;

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LINK_IDLE_MS = 30_000;
const EMIT_THROTTLE_MS = 60;
const LARGE_EMIT_THROTTLE_MS = 250;
const LARGE_THREAD_TURN_ITEMS = 500;

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
	readonly #store: Threads;
	readonly #models: Models;
	readonly #log: Logger;
	readonly #attachments: AttachmentStore | undefined;
	readonly #threads = new Map<string, ThreadState>();
	readonly #shellListeners = new Set<(item: ShellItem) => void>();
	readonly #deletedListeners = new Set<(threadId: string) => void>();
	readonly #shells = new Map<string, OrchestrationV2ThreadShell>();
	/** The project ids last shown to clients, so a registry change emits the removed shells. */
	#projectIds = new Set<string>();
	readonly #commandResults = new Map<string, Promise<number>>();
	/** T3's `thread.titleRegeneration`, per thread: the one current title request. In memory only (state.md). */
	readonly #titleRequests = new Map<string, { requestId: string; startedAt: number; controller: AbortController }>();
	#directory: Thread[] = [];
	/** The subagents of the threads (`t3/subagents.ts`), by their child thread's id: discovered from ownership, refreshed
	 * with the directory and whenever an open thread shows a call that names a child not yet discovered. Nothing is stored. */
	#subagents = new Map<string, SubagentRef>();
	#subagentSync: Promise<void> | undefined;
	#subagentsBooted = false;
	/** Threads whose subagents need a scan once the running one ends (`undefined` in the set: all of them). */
	readonly #subagentScan = new Set<string | undefined>();
	/** The calls (`taskId:conversationId`) a sync was already run for, so an unowned `conversationId` in some tool's
	 * details costs one scan, not one per streamed update. */
	readonly #probedCalls = new Set<string>();
	/** Settles once the directory and the subagents are first loaded. */
	readonly #loaded = Promise.withResolvers<void>();
	#changeStop: (() => void) | undefined;
	#directoryBooted = false;
	#registryStop: (() => void) | undefined;
	#closed = false;
	#sequence = 0;
	#startedAt = new Date().toISOString();

	constructor(config: BridgeConfig, log: Logger, store: Threads, models: Models, attachments?: AttachmentStore) {
		this.config = config;
		this.#log = log;
		this.#store = store;
		this.#models = models;
		this.#attachments = attachments;
	}

	start(): void {
		// The threads layer announces every committed change before the write returns: the directory is current after any
		// awaited write, with no read of its own.
		this.#changeStop = this.#store.onChange((threadIds) => this.#applyDirectory(threadIds));
		void this.#store
			.load()
			.then(() => this.#applyDirectory(undefined))
			.catch((error: unknown) => this.#log.warn("the thread directory failed to load", { error: error instanceof Error ? error.message : String(error) }));
		// A UI edit to the registry (add/remove/rename/move) lands here: removed ids emit a removal and every current
		// project shell is re-emitted — a client keys shells by id, so an unchanged re-emission is a no-op.
		this.#projectIds = new Set(this.#configured().map((project) => project.id));
		this.#registryStop = this.config.registry.subscribe(() => this.#onRegistryChange());
		this.#log.info("bridge started");
	}

	/** The directory changed (`changed`: these threads; `undefined`: the first load). Open threads whose head moved follow the
	 * new head; the changed threads (and their subagents' threads) are re-projected; removed ones emit their removal. The
	 * first load also discovers the subagents. */
	#applyDirectory(changed: ReadonlySet<string> | undefined): void {
		if (this.#closed) return;
		this.#directory = this.#store.snapshot();
		const touched = new Set(changed ?? this.#directory.map((thread) => thread.threadId));
		for (const thread of this.#directory) {
			if (!touched.has(thread.threadId)) continue;
			const state = this.#threads.get(thread.threadId);
			if (state?.follower !== undefined && state.follower.head !== thread.head) void this.#follow(state, thread.head);
		}
		// A subagent's thread takes its title and project from its parent's row.
		for (const ref of this.#subagents.values()) if (touched.has(ref.parentThreadId)) touched.add(ref.threadId);
		this.#refreshShells(touched);
		if (this.#directoryBooted) {
			this.#dropOrphanSubagents();
		} else {
			this.#directoryBooted = true;
			// A client may open a child thread straight away: the first load settles once the subagents are known too.
			void this.#syncSubagents().finally(() => this.#loaded.resolve());
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
	 * (design.md, Invariants): REST 404, WS the contract's typed error. A subagent's thread is known while its parent's
	 * conversation owns the call that made it. */
	hasThread(threadId: string): boolean {
		return this.#summary(threadId) !== undefined || this.#subagents.has(threadId);
	}

	/** Is this a subagent's thread? pi owns it, as Claude owns its Task children: it takes no commands. */
	isSubagentThread(threadId: string): boolean {
		return this.#subagents.has(threadId);
	}

	/** Refuse a command that writes to a subagent's thread. */
	#writable(threadId: string): void {
		if (this.#subagents.has(threadId)) throw new CommandError("This is a subagent's thread: the agent that started it owns it, and it takes no messages or changes.");
	}

	/** Rediscover the subagents (single-flight: a request that arrives during a sync runs one more after it). A change
	 * re-projects what shows them: the shells, and every open parent's cards. */
	#syncSubagents(only?: string): Promise<void> {
		this.#subagentScan.add(only);
		if (this.#subagentSync !== undefined) return this.#subagentSync;
		const run = async (): Promise<void> => {
			while (this.#subagentScan.size > 0) {
				const targets = [...this.#subagentScan];
				this.#subagentScan.clear();
				const full = targets.includes(undefined);
				const scanned: (string | undefined)[] = full ? [undefined] : targets;
				const refs: SubagentRef[] = [];
				let failed = false;
				for (const target of scanned) {
					const found = await this.#store.subagents(target).catch((error: unknown) => {
						this.#log.warn("subagent discovery failed", { error: String(error) });
						return undefined;
					});
					if (found === undefined) {
						failed = true;
						// Forget the batch's probes so the next update scans again.
						if (target !== undefined) for (const probe of [...this.#probedCalls]) if (probe.startsWith(`${target}:`)) this.#probedCalls.delete(probe);
					}
					else refs.push(...found);
				}
				if (failed) continue;
				// A scan replaces what it covers: everything, or the scanned threads' children.
				const kept = full ? [] : [...this.#subagents.values()].filter((ref) => !scanned.includes(ref.parentThreadId));
				const next = new Map([...kept, ...refs].map((ref) => [ref.threadId, ref]));
				const same = next.size === this.#subagents.size && [...next].every(([key, ref]) => JSON.stringify(this.#subagents.get(key)) === JSON.stringify(ref));
				if (same) continue;
				this.#subagents = next;
				this.#refreshShells();
			}
		};
		this.#subagentSync = run().finally(() => {
			this.#subagentSync = undefined;
		});
		return this.#subagentSync;
	}

	/** A deleted thread's children go with it, at once (their conversations stay in the store). */
	#dropOrphanSubagents(): void {
		const live = new Set(this.#directory.map((thread) => thread.threadId));
		const next = new Map([...this.#subagents].filter(([, ref]) => live.has(ref.parentThreadId)));
		if (next.size === this.#subagents.size) return;
		this.#subagents = next;
		this.#refreshShells();
	}

	/** The calls an open thread's view shows that name a child conversation (live details, then result entries), as
	 * `taskId:conversationId` keys. */
	#namedChildren(view: ConversationView): { key: string; taskId: number; conversationId: number }[] {
		const found: { key: string; taskId: number; conversationId: number }[] = [];
		for (const slot of view.docs["pi.live"]?.tools ?? []) {
			const childId = detailsConversationId(slot.details);
			if (slot.taskId !== undefined && childId !== undefined) found.push({ key: `${slot.taskId}:${childId}`, taskId: slot.taskId, conversationId: childId });
		}
		for (const entry of view.entries) {
			const message = entry.model?.[0];
			const childId = message?.role === "toolResult" ? detailsConversationId(message.details) : undefined;
			if (entry.byTaskId !== undefined && childId !== undefined) found.push({ key: `${entry.byTaskId}:${childId}`, taskId: entry.byTaskId, conversationId: childId });
		}
		return found;
	}

	/** The project a known thread belongs to. */
	/** Resolves once the thread list has loaded. */
	loaded(): Promise<void> {
		return this.#loaded.promise;
	}

	threadProjectId(threadId: string): string | undefined {
		return this.#summary(threadId)?.projectId;
	}

	/** A subagent thread's meta: its parent's project, the title T3 gives a provider-native child, the child conversation's
	 * own agent. */
	#subagentMeta(ref: SubagentRef, state: ThreadState | undefined): ThreadMeta {
		const parent = this.#summary(ref.parentThreadId);
		const project = parent === undefined ? undefined : this.#configured().find((candidate) => candidate.id === parent.projectId);
		const agent = state?.view?.docs["pi.agent"];
		const ordinal = [...this.#subagents.values()].filter((other) => other.parentThreadId === ref.parentThreadId).findIndex((other) => other.threadId === ref.threadId) + 1;
		return {
			threadId: ref.threadId,
			projectId: project?.id ?? parent?.projectId ?? "",
			title: subagentThreadTitle({ parentTitle: parent?.title || "New thread", title: ref.title, prompt: ref.prompt, ordinal }),
			cwd: agent?.cwd ?? project?.path ?? "",
			...(project === undefined ? {} : { projectPath: project.path }),
			createdAt: ref.startedAt,
			updatedAt: ref.startedAt,
			model: agent?.model ?? null,
			...(agent?.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
			subagentOf: { parentThreadId: ref.parentThreadId, nodeId: subagentNodeId(ref.taskId) },
			running: state?.view?.docs["pi.live"]?.run !== undefined,
		};
	}

	#meta(threadId: string, thread: Thread | undefined, state: ThreadState | undefined): ThreadMeta {
		const subagent = this.#subagents.get(threadId);
		if (subagent !== undefined) return this.#subagentMeta(subagent, state);
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
			subagents: new Map([...this.#subagents.values()].filter((ref) => ref.parentThreadId === threadId).map((ref) => [ref.taskId, ref])),
			running: state?.view?.docs["pi.live"]?.run !== undefined,
			titleRegeneration: this.#titleRequests.has(threadId)
				? { requestId: this.#titleRequests.get(threadId)!.requestId, startedAt: this.#titleRequests.get(threadId)!.startedAt }
				: null,
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

	/**
	 * The folders a client may name as the `cwd` of a file call (`files.ts`): every registered project's root, and every
	 * thread's folder of its own (a Scratch thread's) — the two values T3's client sends, `thread.worktreePath ?? project.workspaceRoot`.
	 */
	workspaceRoots(): string[] {
		const roots = new Set(this.#configured().map((project) => project.path));
		for (const thread of this.#directory) {
			const meta = this.#meta(thread.threadId, this.#summary(thread.threadId), this.#threads.get(thread.threadId));
			if (meta.projectPath !== undefined && meta.cwd.startsWith(`${meta.projectPath}/`)) roots.add(meta.cwd);
		}
		return [...roots];
	}

	shellSnapshot(): OrchestrationV2ShellSnapshot {
		// A subagent's shell travels with the rest: the web app finds a thread's lineage, and the child thread itself,
		// among the shells it holds (and hides it from the sidebar by its lineage).
		const threads = [...this.#directory.map((thread) => thread.threadId), ...this.#subagents.keys()].map((threadId) => this.#shellFor(threadId));
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

	/** Re-project and re-publish the threads in `only` (all of them without it), and emit the removal of every thread that
	 * is gone. */
	#refreshShells(only?: ReadonlySet<string>): void {
		const seen = new Set<string>();
		for (const threadId of [...this.#directory.map((thread) => thread.threadId), ...this.#subagents.keys()]) {
			seen.add(threadId);
			if (only !== undefined && !only.has(threadId)) continue;
			const state = this.#threads.get(threadId);
			if (state !== undefined) this.#recompute(state);
			this.#publishShell(threadId);
		}
		for (const threadId of [...this.#shells.keys()]) {
			if (seen.has(threadId)) continue;
			this.#shells.delete(threadId);
			const state = this.#threads.get(threadId);
			if (state !== undefined) this.#forget(state, new CommandError(`Thread ${threadId} was removed`));
			this.#emitShell({ kind: "thread.removed", sequence: this.nextSequence(), location: "active", threadId: ThreadId.make(threadId) });
		}
	}

	#publishShell(threadId: string): void {
		if (!this.hasThread(threadId)) return;
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
				loadedView: false,
				changed: Promise.withResolvers<void>(),
				snapshotSequence: 0,
				listeners: new Set(),
				enders: new Set(),
				gone: undefined,
				emitTimer: undefined,
				follower: undefined,
				conversationId: undefined,
				view: undefined,
				history: undefined,
				configuration: undefined,
				catalog: [],
			};
			this.#threads.set(threadId, state);
		}
		return state;
	}

	/** Settle the waiters of a thread's load state and arm a fresh signal. */
	#signal(state: ThreadState): void {
		const previous = state.changed;
		state.changed = Promise.withResolvers<void>();
		previous.resolve();
	}

	/** Wait until `read` answers, the thread is gone, `signal` aborts, or the time is up. Every new view and every
	 * load-state change wakes it; nothing polls. */
	async #waitFor<T>(state: ThreadState, read: () => T | undefined, timeoutMs: number, onTimeout: () => Error, signal?: AbortSignal): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (state.gone !== undefined) throw new CommandError(`Unknown thread: ${state.threadId}`);
			if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
			const value = read();
			if (value !== undefined) return value;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw onTimeout();
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			await Promise.race([
				state.changed.promise,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, remaining);
					onAbort = resolve;
					signal?.addEventListener("abort", onAbort, { once: true });
				}),
			]);
			clearTimeout(timer);
			if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Open a thread: follow its head conversation (a subagent's thread: its child conversation, fixed by the id). */
	#open(state: ThreadState): void {
		if (state.closeTimer !== undefined) {
			clearTimeout(state.closeTimer);
			state.closeTimer = undefined;
		}
		if (state.follower !== undefined) return;
		state.follower = { head: undefined, watch: undefined, generation: 0, viewSeq: 0, historyCutoff: -1, history: [], agentKey: undefined, closed: false };
		// A subagent's thread has no model controls: it reads its conversation and nothing else.
		state.catalog = this.isSubagentThread(state.threadId)
			? []
			: this.#models.getModels().map((model) => ({ provider: model.provider, modelId: model.id, input: [...model.input], contextWindow: model.contextWindow }));
		const head = parseSubagentThreadId(state.threadId)?.conversationId ?? this.#summary(state.threadId)?.head;
		if (head !== undefined) void this.#follow(state, head);
	}

	/** Point an open thread at `head`: watch that conversation, and project each of its views. */
	async #follow(state: ThreadState, head: number): Promise<void> {
		const follower = state.follower;
		if (follower === undefined || follower.closed || follower.head === head) return;
		follower.head = head;
		const generation = ++follower.generation;
		const previous = follower.watch;
		follower.watch = undefined;
		follower.historyCutoff = -1;
		follower.history = [];
		follower.agentKey = undefined;
		await previous?.stop().catch(() => {});
		const current = (): boolean => state.follower === follower && !follower.closed && follower.generation === generation;
		try {
			const conversation = await this.#store.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
			if (!current()) return;
			if (conversation === undefined) {
				await this.#setView(state, head, EMPTY_VIEW, undefined, current);
				return;
			}
			const watch = (await conversation.watch(BACKGROUND_CONTEXT)) as unknown as WatchHandle<ConversationView>;
			if (!current()) {
				await watch.stop().catch(() => {});
				return;
			}
			follower.watch = watch;
			watch.start(async (view) => {
				if (current()) await this.#setView(state, head, view, conversation, current);
			});
			await this.#setView(state, head, watch.value, conversation, current);
		} catch (error) {
			this.#log.warn("could not follow a thread's head", { threadId: state.threadId, head, error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** One view of the head: the history above its compaction cut (loaded once per cut), its configuration (re-read only
	 * when its `pi.agent` document changes), then the projection. A newer view started meanwhile wins. */
	async #setView(state: ThreadState, head: number, view: ConversationView, conversation: Conversation | undefined, current: () => boolean): Promise<void> {
		const follower = state.follower!;
		const seq = ++follower.viewSeq;
		const latest = (): boolean => current() && follower.viewSeq === seq;
		const cutoff = compactionCutoff(view);
		if (cutoff !== follower.historyCutoff) {
			const history = conversation === undefined ? [] : await loadHistory(conversation, cutoff).catch(() => []);
			if (!latest()) return;
			follower.history = history;
			follower.historyCutoff = cutoff;
		}
		const agentKey = JSON.stringify(view.docs["pi.agent"] ?? null);
		if (!this.isSubagentThread(state.threadId) && agentKey !== follower.agentKey) {
			const agent = conversation === undefined ? undefined : await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined);
			if (!latest()) return;
			follower.agentKey = agentKey;
			state.configuration = {
				model: agent?.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
				thinkingLevel: agent?.thinkingLevel ?? "off",
			};
		}
		state.view = view;
		state.history = follower.history;
		state.conversationId = head;
		this.#recompute(state);
		this.#signal(state);
	}

	/** Stop following a thread (idle release); its result and transcript are dropped and re-read on the next open.
	 * Keeping `view.entries` and `history` here retains every opened transcript for the life of the process. */
	#release(state: ThreadState): void {
		const follower = state.follower;
		state.follower = undefined;
		if (follower !== undefined) {
			follower.closed = true;
			void follower.watch?.stop().catch(() => {});
		}
		state.result = undefined;
		state.history = undefined;
		// Keep the small `docs` for shell metadata; release the entry arrays that dominate memory.
		if (state.view !== undefined) state.view = { ...state.view, entries: [] };
		state.loadedView = false;
		// The head may move while released: a write after the next open waits for the head it then loads.
		state.conversationId = undefined;
		this.#signal(state);
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

	#remember(state: ThreadState): void {
		const shell = state.result?.shell;
		if (shell === undefined) return;
		const latest = shell.latestVisibleMessage;
		void this.#store
			.remember(state.threadId, {
				updatedAt: DateTime.toEpochMillis(shell.updatedAt),
				latestVisibleMessage: latest === null ? null : { id: latest.id, role: latest.role, text: latest.text, updatedAt: DateTime.toEpochMillis(latest.updatedAt) },
				latestUserMessageAt: shell.latestUserMessageAt === null ? null : DateTime.toEpochMillis(shell.latestUserMessageAt),
				itemCount: shell.itemCount,
				visibleItemCount: shell.visibleItemCount,
			})
			.catch((error: unknown) => this.#log.warn("sidebar summary write failed", { threadId: state.threadId, error: error instanceof Error ? error.message : String(error) }));
	}

	#recompute(state: ThreadState): void {
		if (state.view === undefined) return;
		const wasRunning = state.result?.shell.status === "running";
		// A call that names a child this thread's discovery has not seen (a subagent made just now): scan this thread alone,
		// once per call. (A subagent's own thread names no children: a subagent of a subagent is not discovered.)
		if (!this.#subagents.has(state.threadId)) {
			const stale = this.#namedChildren(state.view).filter((call) => {
				const seen = [...this.#subagents.values()].some((other) => other.parentThreadId === state.threadId && other.taskId === call.taskId && other.conversationId === call.conversationId);
				const probe = `${state.threadId}:${call.key}`;
				if (seen || this.#probedCalls.has(probe)) return false;
				this.#probedCalls.add(probe);
				return true;
			});
			if (stale.length > 0) void this.#syncSubagents(state.threadId);
		}
		// Only a projection of the head's real view counts as loaded.
		const loaded = state.conversationId !== undefined && !state.loadedView;
		if (loaded) state.loadedView = true;
		state.result = projectThread(
			this.#meta(state.threadId, this.#summary(state.threadId), state),
			state.view,
			{ rolledBack: state.rolledBack, rollbackRequestId: state.rollbackRequestId, rollbackFailure: state.rollbackFailure, history: state.history },
		);
		// A load writes the first snapshot; a run boundary writes the assistant reply without a per-token document write.
		if (loaded) this.#restoreAttachments([...(state.history ?? []), ...state.view.entries]);
		if (loaded || (wasRunning && state.result.shell.status !== "running")) this.#remember(state);
		this.#publishShell(state.threadId);
		if (state.listeners.size === 0 || state.emitTimer !== undefined) return;
		const throttle = (state.result.projection.turnItems.length >= LARGE_THREAD_TURN_ITEMS ? LARGE_EMIT_THROTTLE_MS : EMIT_THROTTLE_MS);
		state.emitTimer = setTimeout(() => {
			state.emitTimer = undefined;
			this.#emitThread(state);
		}, throttle);
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
			return await this.#waitFor(state, () => (state.loadedView ? state.result : undefined), timeoutMs, () => new CommandError(`Timed out loading thread ${threadId}`));
		} finally {
			release();
		}
	}

	/**
	 * Every conversation on this host, as the usage view reads it: the head view of each thread in the directory, with
	 * its entries and the conversation id that names them. Used by `server.getUsageSummary` (see `usage.ts`). Each head
	 * is loaded through the same acquire path as a projection, so a thread the host cannot open is skipped rather than
	 * guessed at; a thread with no usage contributes no records.
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
				const state = this.#threads.get(threadId);
				const view = state?.view;
				const conversationId = state?.conversationId;
				if (view === undefined || conversationId === undefined) return undefined;
				return { conversationId, entries: view.entries };
			}),
		);
		return loaded.filter((entry): entry is { conversationId: number; entries: EntryRecord[] } => entry !== undefined);
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
	 * Wait until the thread's head conversation is loaded and return its id: a freshly created or just reopened thread
	 * follows its head a few awaits after `acquire`, so every write path awaits the real head first — no cold message
	 * loss, and no reliance on an earlier call having warmed the transcript (design.md).
	 */
	#awaitHead(state: ThreadState, timeoutMs = 15_000): Promise<number> {
		return this.#waitFor(state, () => state.conversationId, timeoutMs, () => new CommandError(`The thread ${state.threadId} is still loading; send again in a moment.`));
	}

	/** Configure the thread's head (a model or thinking-level choice), then re-read its configuration. */
	async #configureHead(state: ThreadState, change: AgentChange): Promise<void> {
		const head = await this.#awaitHead(state);
		const conversation = await this.#store.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) throw new CommandError(`No head for thread ${state.threadId}`);
		await conversation.configure(change, BACKGROUND_CONTEXT);
		const agent = await conversation.agent(BACKGROUND_CONTEXT);
		state.configuration = {
			model: agent.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
			thinkingLevel: agent.thinkingLevel,
		};
		if (state.follower !== undefined) state.follower.agentKey = undefined;
		this.#recompute(state);
	}

	/**
	 * A new thread. `launchText` is the launch's first message (or title): T3's server gives a thread launched in the
	 * Scratch project a folder of its own, claimed at launch — a thread whose row already exists is a replayed create and
	 * claims nothing, exactly T3's "only the first attempt claims one" (ManagedProjectFolders, ThreadLaunchService).
	 */
	async createThread(options: { threadId?: string | undefined; projectId: string; launchText?: string; title?: string; provenance?: Provenance }): Promise<string> {
		const project = this.config.registry.list().find((p) => p.id === options.projectId);
		if (project === undefined) throw new CommandError(`Unknown project: ${options.projectId}`);
		const id = options.threadId !== undefined && SESSION_ID.test(options.threadId) ? options.threadId : randomUUID();
		// A derived subagent id names a child conversation, never a thread of the threads document.
		if (parseSubagentThreadId(id) !== undefined) throw new CommandError(`Thread ids ending in .sub.<number> are reserved for subagents: ${id}`);
		this.#writable(id);
		if (this.#summary(id) !== undefined) return id;
		const scratchRoot = this.config.scratchDir;
		let cwd: string | undefined;
		if (options.launchText !== undefined && scratchRoot !== undefined && isScratchRoot(project.cwd, scratchRoot)) {
			const env = this.config.env;
			if (env === undefined) throw new CommandError("Threads without a project require an execution environment.");
			cwd = await claimScratchThreadFolder(scratchRoot, id, options.launchText, env, this.config.context ?? BACKGROUND_CONTEXT);
		}
		await this.#store.create({ threadId: id, projectId: project.id, provenance: options.provenance ?? USER_WEB, ...(cwd === undefined ? {} : { cwd }), ...(options.title === undefined ? {} : { title: options.title }) });
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
			await this.idempotent(input.commandId, async () => {
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
				return this.nextSequence();
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
		this.#writable(threadId);
		const thinking = thinkingOf(selection?.options);
		const release = this.acquire(threadId);
		try {
			const current = this.#state(threadId).configuration;
			const modelChanged = current?.model?.provider !== model.provider || current?.model?.modelId !== model.modelId;
			const thinkingChanged = thinking !== undefined && current?.thinkingLevel !== thinking;
			if (!modelChanged && !thinkingChanged) return;
			// The model first: an unknown one is refused, and the level is applied to the thread the model landed on.
			const state = this.#state(threadId);
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

	/** Restore an old uploaded image from the bytes its entry already carries. The client used to delete its pending
	 * upload after sending; the model's image block is the remaining copy, so a missing file is repaired on first load. */
	#restoreAttachments(entries: readonly EntryRecord[] | undefined): void {
		if (this.#attachments === undefined || entries === undefined) return;
		for (const entry of entries) {
			const records = attachmentsOf(entry);
			if (records.length === 0) continue;
			const images: { data: string }[] = [];
			for (const message of entry.model ?? []) {
				if (!Array.isArray(message.content)) continue;
				for (const block of message.content) if (block.type === "image") images.push(block);
			}
			records.forEach((record, index) => {
				if (record.type === "file" || this.#attachments!.resolvePath(record.id) !== null) return;
				const image = images[index];
				if (image !== undefined) this.#attachments!.restoreFromData(record, image.data);
			});
		}
	}

	/** The image content blocks for a prompt, gated on the head's model (see `selectImageBlocks`). */
	#imageBlocks(state: ThreadState, attachments: readonly AttachmentRecord[] | undefined): ContentBlock[] | undefined {
		if (this.#attachments === undefined) return undefined;
		const model = state.configuration?.model ?? state.view?.docs["pi.agent"]?.model ?? null;
		return selectImageBlocks(state.catalog, model, attachments, (id) => this.#attachments!.readForModel(id));
	}

	/** Copy file attachments into the workspace and return the path-bearing prompt line the model reads. */
	async #filePrompt(attachments: readonly AttachmentRecord[] | undefined): Promise<string | undefined> {
		const files = (attachments ?? []).filter((attachment) => attachment.type === "file");
		if (files.length === 0) return undefined;
		const env = this.config.env;
		if (env === undefined || this.#attachments === undefined) throw new CommandError("This host cannot store file attachments.");
		const context = this.config.context ?? BACKGROUND_CONTEXT;
		const made = await env.createDir(ATTACHMENT_WORKSPACE_DIR, { recursive: true }, context);
		if (!made.ok) throw new CommandError(`Cannot create the attachment directory: ${made.error.message}`);
		const lines: string[] = [];
		for (const file of files) {
			const bytes = this.#attachments.readBytes(file.id);
			const local = this.#attachments.resolvePath(file.id);
			if (bytes === null || local === null) throw new CommandError(`Attachment ${file.name} is missing.`);
			const target = `${ATTACHMENT_WORKSPACE_DIR}/${basename(local)}`;
			const written = await env.writeFile(target, bytes, context);
			if (!written.ok) throw new CommandError(`Cannot save attachment ${file.name}: ${written.error.message}`);
			lines.push(`[Attached file "${file.name}" is saved at: ${target}]`);
		}
		return lines.join("\n\n");
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
	}): Promise<void> {
		this.#writable(input.threadId);
		const release = this.acquire(input.threadId);
		try {
			const state = this.#state(input.threadId);
			const head = await this.#awaitHead(state);
			// T3's Orchestrator wakes a settled thread on new activity; the explicit override is cleared before the run.
			if (this.#summary(input.threadId)?.settledOverride !== undefined) {
				await this.#store.wake(input.threadId);
						this.#titleChanged(input.threadId);
			}
			// T3's slash command: `/compact` (with optional guidance) is a compaction task, not a prompt.
			const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(input.text.trim());
			if (compact !== null) {
				const guidance = compact[1]?.trim();
				await this.#store.compact(input.threadId, guidance === undefined || guidance === "" ? undefined : guidance, input.messageId);
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
			// commandId for durable dedup (design.md, Invariants). Images ride along as content blocks (model) and entry
			// data (display), only when the model accepts them; files are copied to the workspace and named by path.
			// The client's upload is only a pending record: adopt it under a deterministic id before the message references
			// it, because the client may delete the pending upload once the send is acknowledged.
			const attachments = input.attachments === undefined || this.#attachments === undefined ? input.attachments : this.#attachments.adopt(input.threadId, input.messageId, input.attachments);
			const context = rebindContext(input.context, input.attachments, attachments);
			const blocks = this.#imageBlocks(state, attachments);
			const filePrompt = await this.#filePrompt(attachments);
			const promptBlocks = filePrompt === undefined ? blocks : [{ type: "text" as const, text: filePrompt, hidden: true }, ...(blocks ?? [])];
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
	#hasMessages(state: ThreadState): boolean {
		return (state.result?.projection.messages.length ?? 0) > 0 || (state.view?.entries ?? []).some((entry) => USER_ENTRY_KINDS.has(entry.kind));
	}

	async #setStoredTitle(threadId: string, title: string): Promise<void> {
		await this.#store.rename(threadId, title);
		this.#titleChanged(threadId);
	}

	/** Re-publish a thread after a title or `titleRegeneration` change. */
	#titleChanged(threadId: string): void {
		const state = this.#threads.get(threadId);
		if (state !== undefined) this.#recompute(state);
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
	#generateTitle(threadId: string, requestId: string, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }): void {
		const hook = this.config.titleThread;
		const pending = this.#titleRequests.get(threadId);
		if (hook === undefined || pending?.requestId !== requestId) return;
		const signal = pending.controller.signal;
		void (async () => {
			const release = this.acquire(threadId);
			let previousTitle: string | undefined;
			try {
				const state = this.#state(threadId);
				const conversationId = (await this.#awaitHead(state)) as ConversationId;
				const at = await this.#titleEntry(state, kind, signal);
				if (at === undefined || signal.aborted) return void (await this.#completeTitle(threadId, requestId, undefined));
				const request: TitleThreadRequest =
					kind.reason === "regenerate"
						? { threadId, conversationId, at, reason: "regenerate", previousTitle: (previousTitle = this.#summary(threadId)?.title || "New thread"), signal }
						: { threadId, conversationId, at, reason: "first-message", signal };
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
	async #titleEntry(state: ThreadState, kind: { reason: "first-message"; messageId: string } | { reason: "regenerate" }, signal: AbortSignal): Promise<EntryId | undefined> {
		if (kind.reason === "regenerate") return state.view?.entries.at(-1)?.id as EntryId | undefined;
		const find = (): EntryId | undefined =>
			state.view?.entries.find(
				(candidate) => USER_ENTRY_KINDS.has(candidate.kind) && (candidate.data as { messageId?: unknown } | undefined)?.messageId === kind.messageId,
			)?.id as EntryId | undefined;
		return this.#waitFor(state, find, 60_000, () => new Error("timed out"), signal).catch(() => undefined);
	}

	/** A user rename (T3's `thread.metadata.update` with `title`, or `T3Attachment.setTitle`): durable, and it cancels a
	 * pending generation (`titleRegeneration: null`). */
	async renameThread(threadId: string, title: string): Promise<void> {
		this.#writable(threadId);
		const trimmed = title.trim();
		if (trimmed === "") throw new CommandError("Thread title cannot be empty.");
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		this.#cancelTitle(threadId);
		await this.#setStoredTitle(threadId, trimmed);
	}

	/** T3's `thread.metadata.update`: `title` renames; `regenerateTitle: true` starts a "regenerate" request (refused with
	 * no `titleThread` hook), `false` clears it. Fields this host has no backend for are refused. */
	async updateThreadMetadata(command: { commandId: string; threadId: string; title?: string; regenerateTitle?: boolean } & Record<string, unknown>): Promise<void> {
		this.#writable(command.threadId);
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

	/** T3's `thread.settle`: a durable sidebar settlement, reflected in the shell immediately. */
	async settleThread(threadId: string): Promise<void> {
		this.#writable(threadId);
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		await this.#store.settle(threadId);
		this.#titleChanged(threadId);
	}

	/** T3's `thread.unsettle`: put the thread back in the active section, durably. */
	async unsettleThread(threadId: string): Promise<void> {
		this.#writable(threadId);
		if (!this.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		await this.#store.unsettle(threadId);
		this.#titleChanged(threadId);
	}

	async interrupt(threadId: string): Promise<void> {
		this.#writable(threadId);
		const release = this.acquire(threadId);
		try {
			const state = this.#state(threadId);
			// Await the loaded head and let a failure surface, rather than returning quietly and leaving a stale run going.
			const head = await this.#awaitHead(state);
			await this.#store.abort({ threadId, conversationId: head });
		} finally {
			release();
		}
	}

	async cancelQueued(threadId: string, runId: string): Promise<void> {
		this.#writable(threadId);
		const release = this.acquire(threadId);
		try {
			await this.#store.cancelQueued(threadId, runId);
		} finally {
			release();
		}
	}

	async editQueued(threadId: string, runId: string, text: string, attachments?: readonly { id: string; name: string; mimeType: string; sizeBytes: number }[]): Promise<void> {
		this.#writable(threadId);
		const release = this.acquire(threadId);
		try {
			await this.#store.editQueued(threadId, runId, text, attachments === undefined ? undefined : [...attachments]);
		} finally {
			release();
		}
	}

	async promoteQueued(threadId: string, runId: string): Promise<void> {
		this.#writable(threadId);
		const release = this.acquire(threadId);
		try {
			await this.#store.promoteQueued(threadId, runId);
		} finally {
			release();
		}
	}

	async startQueued(threadId: string, runId: string | undefined, requestId: string): Promise<void> {
		this.#writable(threadId);
		const release = this.acquire(threadId);
		try {
			await this.#store.startQueued(threadId, runId, requestId);
		} finally {
			release();
		}
	}

	async rollback(input: { threadId: string; commandId: string; checkpointId: string; restoreFiles: boolean }) {
		this.#writable(input.threadId);
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
			await this.#store.rewind({ threadId: input.threadId, expectedHead, entryId: target.entryId, requestId: input.commandId });
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

	/** T3's `thread.fork`: a new thread continuing from a run's last durable entry (or the head's last entry for a
	 * `latest_stable` fork). A synthetic run anchored by a compaction summary has no user turn to rewind to, but its
	 * last kept entry is still a valid fork point. The client names the target id, so a retried command returns the
	 * same thread. */
	async forkThread(input: { sourceThreadId: string; targetThreadId: string; runId?: string | undefined; title?: string | undefined; provenance?: Provenance }): Promise<string> {
		this.#writable(input.targetThreadId);
		if (SESSION_ID.test(input.targetThreadId) === false) throw new CommandError(`Invalid thread id: ${input.targetThreadId}`);
		if (parseSubagentThreadId(input.targetThreadId) !== undefined) throw new CommandError(`Thread ids ending in .sub.<number> are reserved for subagents: ${input.targetThreadId}`);
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
		});
		return input.targetThreadId;
	}

	async deleteThread(threadId: string): Promise<void> {
		this.#writable(threadId);
		this.#cancelTitle(threadId);
		await this.#store.remove(threadId);
		this.#dropOrphanSubagents();
		const state = this.#threads.get(threadId);
		if (state !== undefined) this.#forget(state, new CommandError(`Thread ${threadId} was deleted`));
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
		for (const state of this.#threads.values()) this.#release(state);
		this.#changeStop?.();
		this.#registryStop?.();
	}
}
