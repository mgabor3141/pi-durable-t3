// T3's orchestrator tools on this host (`OrchestratorMcpService`), behind `/mcp`: the thread tools (`t3_thread_list`,
// `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt`, `t3_thread_update`, and `create_threads`,
// which a client outside a thread is refused, as in T3) and the scheduled-task tools, which agents inside the host also
// call (`thread-tools.ts`), as their own thread. Inputs and results are the contract's (`orchestratorMcp.ts`); a refusal
// is its `OrchestratorMcpFailure`.
import { createHash, randomUUID } from "node:crypto";
import {
	OrchestratorMcpFailure,
	type OrchestratorMcpCreateThreadsInput,
	type OrchestratorMcpCreateThreadsResult,
	type OrchestratorMcpThreadDetail,
	type OrchestratorMcpThreadInterruptInput,
	type OrchestratorMcpThreadInterruptResult,
	type OrchestratorMcpThreadListInput,
	type OrchestratorMcpThreadListItem,
	type OrchestratorMcpThreadListResult,
	type OrchestratorMcpThreadReadInput,
	type OrchestratorMcpThreadReadResult,
	type OrchestratorMcpThreadRun,
	type OrchestratorMcpThreadSendInput,
	type OrchestratorMcpThreadSendResult,
	type OrchestratorMcpThreadTimelineItem,
	type OrchestratorMcpThreadWaitInput,
	type OrchestratorMcpThreadWaitResult,
	type OrchestrationV2Run,
	type OrchestrationV2ThreadProjection,
	type OrchestrationV2ThreadShell,
	type OrchestrationV2TurnItem,
	EnvironmentId,
	ThreadId,
	type ThreadMetadataMcpUpdateInput,
	type ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { type AuthMcpClientAccess, type RuntimeMode, scheduledTaskThreadMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { Bridge } from "./bridge.ts";
import { type DispatchCommand, dispatchCommand } from "./dispatch.ts";
import { CommandError } from "./errors.ts";
import { FRESH_SESSION_UNSUPPORTED, type ScheduledTasks } from "./scheduled-tasks.ts";
import { ProjectConflict, ProjectNotFound } from "../registry.ts";
import type { ProjectMutation } from "./bridge.ts";
import type {
	OrchestratorMcpDeleteScheduledTaskInput,
	OrchestratorMcpDeleteScheduledTaskResult,
	OrchestratorMcpListScheduledTasksInput,
	OrchestratorMcpListScheduledTasksResult,
	OrchestratorMcpSaveScheduledTaskInput,
	OrchestratorMcpScheduledTask,
	ScheduledTask,
	ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import type { Logger } from "./logging.ts";

/** Who is calling: the thread the call comes from, or the MCP client that signed in over OAuth (`./mcp-oauth.ts`) with
 * the access the user approved; and the web origin its links should open in. */
export type Caller = {
	readonly threadId?: string;
	readonly webOrigin?: string;
	readonly client?: { readonly sessionId: string; readonly access: AuthMcpClientAccess };
};

/** How much a runtime mode allows, narrowest first (T3's `runtimeModeRank`). */
const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = { "approval-required": 0, "auto-accept-edits": 1, auto: 2, "full-access": 3 };

/** The broadest mode a client may drive (T3's `clientModeCeiling`): its access, or the narrowest for read-only. */
const clientCeiling = (access: AuthMcpClientAccess): RuntimeMode => (access === "read-only" ? "approval-required" : access);

/** The namespace of a caller's request keys (T3's `requestNamespace`): its thread, or `client:<session>`. */
const namespaceOf = (caller: Caller): string | undefined => caller.threadId ?? (caller.client === undefined ? undefined : `client:${caller.client.sessionId}`);

type Failure = OrchestratorMcpFailure["code"];
type ProjectRecord = ReturnType<Bridge["projectRecords"]>[number];
const fail = (code: Failure, message: string): never => {
	throw new OrchestratorMcpFailure({ code, message });
};

// T3's defaults and bounds (`OrchestratorMcpService`).
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

const iso = (value: DateTime.DateTime) => DateTime.formatIso(value);
const isActive = (run: OrchestrationV2Run) => run.status === "preparing" || run.status === "starting" || run.status === "running" || run.status === "waiting";
const isTerminal = (run: OrchestrationV2Run) => ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(run.status);
const byOrdinalDesc = (runs: readonly OrchestrationV2Run[]) => runs.toSorted((left, right) => right.ordinal - left.ordinal);
const latestRun = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) => byOrdinalDesc(projection.runs)[0];
const latestActiveRun = (projection: Pick<OrchestrationV2ThreadProjection, "runs">) => byOrdinalDesc(projection.runs.filter(isActive))[0];

/** A run a subagent's report started, not a person or another agent's message (`orchestration.ts` mints the ids). T3
 * calls these automatic: its notification and delegated-completion messages. */
const isReportRun = (run: OrchestrationV2Run) => (run.userMessageId as string).startsWith("n-");

/**
 * T3's `settleAfterRun` decision (0.1.9), for a thread whose own agent asked to settle it during the completed run at
 * `ordinal`: what the runs after that one say.
 * - A run or message that is not a report: someone wrote to the thread, so it stays active (`"leave"`).
 * - A report's run still working: wait (`undefined`).
 * - A report's run that ended other than completed: the thread stays active.
 * - Otherwise settle, naming the latest run, so a run that starts before the settle lands refuses it.
 */
export function settleVerdict(projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">, ordinal: number): { latestRunId: string } | "leave" | undefined {
	const following = projection.runs.filter((candidate) => candidate.ordinal > ordinal);
	const followingIds = new Set(following.map((candidate) => candidate.id as string));
	const written = projection.messages.some((message) => message.role === "user" && followingIds.has(message.runId as string) && !(message.id as string).startsWith("n-"));
	if (written || following.some((candidate) => !isReportRun(candidate))) return "leave";
	if (following.some(isActive)) return undefined;
	if (following.some((candidate) => candidate.status !== "queued" && candidate.status !== "completed")) return "leave";
	const latest = byOrdinalDesc(projection.runs)[0];
	return latest === undefined ? "leave" : { latestRunId: latest.id as string };
}

/** An id for one operation of one request, stable across a retry with the same `clientRequestId` (T3's `stableCommandId`). */
const stableId = (...parts: readonly (string | number | undefined)[]) =>
	createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("base64url").slice(0, 24);

/** T3's `turnItemText`: what a timeline item says, as text. */
function turnItemText(item: OrchestrationV2TurnItem): string | null {
	const json = (value: unknown) => {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	};
	const it = item as Record<string, unknown> & { type: string };
	switch (it.type) {
		case "user_message":
		case "assistant_message":
		case "reasoning":
			return it.text as string;
		case "proposed_plan":
			return it.markdown as string;
		case "command_execution":
			return [`$ ${it.input as string}`, it.output as string | undefined].filter((line) => line !== undefined).join("\n");
		case "run_interrupt_request":
		case "run_interrupt_result":
		case "system_notice":
			return it.message as string;
		case "error":
			return (it.failure as { message: string }).message;
		case "compaction":
			return (it.summary as string | undefined) ?? null;
		case "fork":
			return `Forked to thread ${it.targetThreadId as string}.`;
		case "subagent":
			return (it.result as string | null) ?? (it.progress as string | undefined) ?? (it.prompt as string);
		case "dynamic_tool":
			return json({ toolName: it.toolName, input: it.input, output: it.output });
		default:
			return null;
	}
}

export class ThreadOps {
	readonly #bridge: Bridge;
	readonly #environmentId: string;
	readonly #log: Logger;
	readonly #scheduledTasks: ScheduledTasks | undefined;

	constructor(bridge: Bridge, environmentId: string, log: Logger, scheduledTasks?: ScheduledTasks) {
		this.#scheduledTasks = scheduledTasks;
		this.#bridge = bridge;
		this.#environmentId = environmentId;
		this.#log = log;
	}

	/** T3's `threadLinkFor`: a link into the caller's web app, else a `t3://` thread link. */
	#link(caller: Caller, threadId: string): string {
		return caller.webOrigin === undefined
			? formatThreadLink({ environmentId: EnvironmentId.make(this.#environmentId), threadId: ThreadId.make(threadId) })
			: `${caller.webOrigin}/${encodeURIComponent(this.#environmentId)}/${encodeURIComponent(threadId)}`;
	}

	/** The calling thread's shell; a caller that names a thread that is gone is refused. */
	#caller(caller: Caller): OrchestrationV2ThreadShell | undefined {
		if (caller.threadId === undefined) return undefined;
		const shell = this.#shell(caller.threadId);
		if (shell === undefined) fail("parent_not_active", `The calling thread ${caller.threadId} no longer exists.`);
		return shell;
	}

	/**
	 * T3's `writesThreads` check: a read-only client writes nothing, and a client may not drive a thread broader than
	 * the access it was approved for. Every thread here runs at `full-access`, so only a `full-access` client writes.
	 */
	#mayWrite(caller: Caller, threadId: string | undefined): void {
		const client = caller.client;
		if (client === undefined) return;
		if (client.access === "read-only") fail("capability_denied", "This tool changes the environment, and this MCP client was approved for read-only access.");
		const target = threadId === undefined ? undefined : this.#shell(threadId);
		if (target === undefined) return;
		const ceiling = clientCeiling(client.access);
		if (RUNTIME_MODE_RANK[target.runtimeMode] > RUNTIME_MODE_RANK[ceiling]) {
			fail("runtime_mode_escalation_denied", `Child runtime mode ${target.runtimeMode} is broader than parent mode ${ceiling}.`);
		}
	}

	#shell(threadId: string): OrchestrationV2ThreadShell | undefined {
		return this.#bridge.hasThread(threadId) ? this.#bridge.threadShell(threadId) : undefined;
	}

	async #projection(threadId: string): Promise<OrchestrationV2ThreadProjection> {
		if (!this.#bridge.hasThread(threadId)) fail("thread_not_found", `Thread ${threadId} was not found.`);
		try {
			return (await this.#bridge.projection(threadId)).projection;
		} catch (error) {
			return fail("orchestration_error", `Unable to read thread ${threadId}: ${(error as Error).message}`);
		}
	}

	#listItem(caller: Caller, shell: OrchestrationV2ThreadShell): OrchestratorMcpThreadListItem {
		const settled = shell.settledOverride === "settled";
		return {
			threadId: shell.id,
			projectId: shell.projectId,
			title: shell.title,
			link: this.#link(caller, shell.id),
			createdBy: shell.createdBy,
			creationSource: shell.creationSource,
			status: shell.activityRunStatus ?? shell.status,
			latestRunId: shell.latestRunId,
			providerInstanceId: shell.modelSelection.instanceId,
			model: shell.modelSelection.model,
			runtimeMode: shell.runtimeMode,
			interactionMode: shell.interactionMode,
			linkedPullRequest: shell.linkedPullRequest ?? null,
			pullRequests: [],
			settled,
			settledAt: settled && shell.settledAt !== null ? iso(shell.settledAt) : null,
			// Snoozing is not supported on this host: nothing is ever snoozed.
			snoozed: false,
			snoozedUntil: null,
			parentThreadId: shell.lineage.parentThreadId,
			relationshipToParent: shell.lineage.relationshipToParent,
			itemCount: shell.visibleItemCount,
			createdAt: iso(shell.createdAt),
			updatedAt: iso(shell.updatedAt),
		} as OrchestratorMcpThreadListItem;
	}

	/** `t3_thread_list`: threads newest first, in the project named (or all). */
	list(caller: Caller, input: OrchestratorMcpThreadListInput): OrchestratorMcpThreadListResult {
		const projectId = input.allProjects === true ? null : (input.projectId ?? fail("target_required", "Name a projectId, or pass allProjects: true, outside a thread."));
		const statuses = input.statuses === undefined || input.statuses.length === 0 ? null : new Set<string>(input.statuses);
		const titleContains = input.titleContains?.toLocaleLowerCase();
		const threads = this.#bridge
			.shellSnapshot()
			.threads.filter((shell) => projectId === null || shell.projectId === projectId)
			// T3's ThreadManagementService: side chats are never listed.
			.filter((shell) => shell.lineage.sideChat !== true)
			.filter((shell) => input.includeSubagents !== false || shell.lineage.relationshipToParent !== "subagent")
			.filter((shell) => statuses === null || statuses.has(shell.activityRunStatus ?? shell.status))
			.filter((shell) => input.settled === undefined || (shell.settledOverride === "settled") === input.settled)
			.filter((shell) => input.snoozed === undefined || input.snoozed === false)
			.filter((shell) => titleContains === undefined || shell.title.toLocaleLowerCase().includes(titleContains))
			.toSorted((left, right) => DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt));
		const cursor = input.cursor ?? 0;
		const page = threads.slice(cursor, cursor + (input.limit ?? DEFAULT_THREAD_LIST_LIMIT));
		return {
			projectId: projectId as never,
			currentThreadId: null,
			threads: page.map((shell) => this.#listItem(caller, shell)),
			nextCursor: cursor + page.length < threads.length ? cursor + page.length : null,
			total: threads.length,
		} as OrchestratorMcpThreadListResult;
	}

	/** `t3_thread_read`: a page of the thread's timeline (`messages`: messages and plans; `activity`: every item). */
	async read(caller: Caller, input: OrchestratorMcpThreadReadInput): Promise<OrchestratorMcpThreadReadResult> {
		const projection = await this.#projection(input.threadId);
		const shell = this.#shell(input.threadId)!;
		const view = input.view ?? "messages";
		const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
		const visible = projection.visibleTurnItems;
		const matching = visible.filter((row) =>
			input.itemId === undefined
				? row.position > (input.afterPosition ?? -1) && (view === "activity" || ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
				: row.sourceItemId === input.itemId,
		);
		const page = matching.slice(0, input.limit ?? DEFAULT_THREAD_READ_LIMIT);
		const messages = new Map(projection.messages.map((message) => [message.id as string, message]));
		const items = page.map((row): OrchestratorMcpThreadTimelineItem => {
			const text = turnItemText(row.item);
			const offset = input.itemId === undefined ? 0 : (input.textOffset ?? 0);
			const end = offset + maxChars;
			const truncated = text !== null && text.length > end;
			const messageId = row.item.type === "user_message" || row.item.type === "assistant_message" ? row.item.messageId : null;
			const message = messageId === null ? undefined : messages.get(messageId as string);
			return {
				position: row.position,
				visibility: row.visibility,
				sourceThreadId: row.sourceThreadId,
				itemId: row.sourceItemId,
				...(row.item.type === "subagent" ? { subagentId: row.item.subagentId } : {}),
				runId: row.item.runId,
				messageId,
				createdBy: message?.createdBy ?? null,
				creationSource: message?.creationSource ?? null,
				...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
				type: row.item.type,
				status: row.item.status,
				title: row.item.title,
				text: text === null ? null : text.slice(offset, end),
				textTruncated: truncated,
				nextTextOffset: truncated ? end : null,
				updatedAt: iso(row.item.updatedAt),
			} as OrchestratorMcpThreadTimelineItem;
		});
		const latest = latestRun(projection);
		const active = latestActiveRun(projection);
		const settled = projection.thread.settledOverride === "settled";
		const thread = {
			threadId: projection.thread.id,
			projectId: projection.thread.projectId,
			title: projection.thread.title,
			link: this.#link(caller, projection.thread.id),
			createdBy: projection.thread.createdBy,
			creationSource: projection.thread.creationSource,
			status: active?.status ?? latest?.status ?? "idle",
			latestRunId: latest?.id ?? null,
			activeRunId: active?.id ?? null,
			providerInstanceId: projection.thread.modelSelection.instanceId,
			model: projection.thread.modelSelection.model,
			runtimeMode: projection.thread.runtimeMode,
			interactionMode: projection.thread.interactionMode,
			linkedPullRequest: projection.thread.linkedPullRequest ?? null,
			pullRequests: [],
			titleRegeneration:
				projection.thread.titleRegeneration == null ? null : { requestId: projection.thread.titleRegeneration.requestId, startedAt: iso(projection.thread.titleRegeneration.startedAt) },
			branch: projection.thread.branch,
			worktreePath: projection.thread.worktreePath,
			parentThreadId: projection.thread.lineage.parentThreadId,
			relationshipToParent: projection.thread.lineage.relationshipToParent,
			runCount: projection.runs.length,
			itemCount: visible.length,
			pendingRequestCount: projection.runtimeRequests.filter((request) => request.status === "pending").length,
			archived: projection.thread.archivedAt !== null,
			settled,
			settledAt: settled && projection.thread.settledAt !== null ? iso(projection.thread.settledAt) : null,
			snoozed: false,
			snoozedUntil: null,
			createdAt: iso(projection.thread.createdAt),
			updatedAt: iso(projection.thread.updatedAt),
		} as OrchestratorMcpThreadDetail;
		void shell;
		return {
			thread,
			recentRuns: byOrdinalDesc(projection.runs)
				.slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
				.map(
					(run): OrchestratorMcpThreadRun =>
						({
							runId: run.id,
							ordinal: run.ordinal,
							status: run.status,
							providerInstanceId: run.modelSelection.instanceId,
							model: run.modelSelection.model,
							requestedAt: iso(run.requestedAt),
							startedAt: run.startedAt === null ? null : iso(run.startedAt),
							completedAt: run.completedAt === null ? null : iso(run.completedAt),
						}) as OrchestratorMcpThreadRun,
				),
			items,
			nextPosition: page.at(-1)?.position ?? null,
			hasMore: matching.length > page.length,
		} as OrchestratorMcpThreadReadResult;
	}

	/**
	 * `t3_thread_send`: a message from the caller (an agent, over MCP) to any thread. `auto` steers a running turn or
	 * starts one; `queue` waits for the running turn; `steer` and `restart` need a running turn.
	 */
	async send(caller: Caller, input: OrchestratorMcpThreadSendInput): Promise<OrchestratorMcpThreadSendResult> {
		this.#mayWrite(caller, input.threadId);
		// T3 0.1.9's "start a new provider session without the thread's earlier context": no thread here can (dispatch.ts).
		if (input.freshContext === true) fail("invalid_request", "freshContext is not supported by pi-durable-t3: a thread keeps its context. Start a new thread instead.");
		const before = await this.#projection(input.threadId);
		const mode = input.mode ?? "auto";
		const running = before.runs.find((run) => run.status === "running");
		if ((mode === "steer" || mode === "restart") && running === undefined) fail("thread_not_sendable", `Thread ${input.threadId} has no running turn to ${mode}.`);
		const key = input.clientRequestId ?? randomUUID();
		const messageId = `mcp-${stableId(namespaceOf(caller), key, "thread-send", "message")}`;
		const commandId = `mcp-${stableId(namespaceOf(caller), key, "thread-send")}`;
		try {
			await this.#bridge.sendMessage({
				threadId: input.threadId,
				commandId,
				messageId,
				text: input.message,
				mode: mode === "auto" ? (running === undefined ? "start" : "steer") : mode === "queue" ? (running === undefined ? "start" : "queue") : mode,
				provenance: { createdBy: "agent", creationSource: "mcp" },
			});
		} catch (error) {
			fail(error instanceof CommandError ? "thread_not_sendable" : "orchestration_error", `Unable to send to thread ${input.threadId}: ${(error as Error).message}`);
		}
		// The message's run, once the thread shows it: the run it started, the one it steered, or its queued run.
		const found = await this.#bridge.waitFor(
			input.threadId,
			(projection) => {
				const message = projection.messages.find((candidate) => candidate.id === messageId);
				const run = message?.runId == null ? undefined : projection.runs.find((candidate) => candidate.id === message.runId);
				if (run === undefined) return undefined;
				const item = projection.turnItems.find((candidate) => candidate.type === "user_message" && candidate.messageId === messageId) as { inputIntent?: string } | undefined;
				return { run, intent: item?.inputIntent };
			},
			15_000,
		);
		if (found === undefined) return fail("orchestration_error", `The message to thread ${input.threadId} was sent, but its run did not appear.`);
		// T3's `restartedAsNextTurn` (0.1.9): a restart that stopped the turn and ran the message as the next one is a
		// restart, not a start. Here every restart is that: the running turn is aborted and the message starts a new run.
		const restartedAsNextTurn = mode === "restart" && found.run.id !== running?.id;
		const delivery = restartedAsNextTurn ? "restarted" : found.run.status === "queued" || found.intent === "queued_turn" ? "queued" : found.intent === "turn_start" ? "started" : mode === "restart" ? "restarted" : "steered";
		return {
			threadId: input.threadId as never,
			link: this.#link(caller, input.threadId),
			messageId: messageId as never,
			runId: found.run.id,
			status: found.run.status,
			delivery,
		} as OrchestratorMcpThreadSendResult;
	}

	/** `t3_thread_wait`: until the thread's run (latest, or the one named) ends, or the time is up. Idle: at once. */
	async wait(caller: Caller, input: OrchestratorMcpThreadWaitInput): Promise<OrchestratorMcpThreadWaitResult> {
		const projection = await this.#projection(input.threadId);
		const selected = input.runId === undefined ? latestRun(projection) : projection.runs.find((run) => run.id === input.runId);
		if (input.runId !== undefined && selected === undefined) fail("run_not_found", `Run ${input.runId} was not found on thread ${input.threadId}.`);
		if (selected === undefined) return { threadId: input.threadId, runId: null, status: "idle", timedOut: false } as OrchestratorMcpThreadWaitResult;
		const timeoutMs = Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
		const ended = await this.#bridge.waitFor(
			input.threadId,
			(current) => {
				const run = current.runs.find((candidate) => candidate.id === selected.id);
				return run !== undefined && isTerminal(run) ? run : undefined;
			},
			timeoutMs,
		);
		const run = ended ?? (await this.#projection(input.threadId)).runs.find((candidate) => candidate.id === selected.id) ?? selected;
		return { threadId: input.threadId, runId: run.id, status: run.status, timedOut: ended === undefined } as OrchestratorMcpThreadWaitResult;
	}

	/** `t3_thread_interrupt`: interrupt the thread's running turn (or the run named, if it is the running one). */
	async interrupt(caller: Caller, input: OrchestratorMcpThreadInterruptInput): Promise<OrchestratorMcpThreadInterruptResult> {
		this.#mayWrite(caller, input.threadId);
		const projection = await this.#projection(input.threadId);
		const named = input.runId === undefined ? undefined : projection.runs.find((run) => run.id === input.runId);
		if (input.runId !== undefined && named === undefined) fail("run_not_found", `Run ${input.runId} was not found on thread ${input.threadId}.`);
		if (named !== undefined && isTerminal(named)) return { threadId: input.threadId, runId: named.id, status: named.status } as OrchestratorMcpThreadInterruptResult;
		const active = latestActiveRun(projection);
		if (active === undefined) {
			if (input.runId === undefined) return { threadId: input.threadId, runId: null, status: "no_active_run" } as OrchestratorMcpThreadInterruptResult;
			fail("thread_not_interruptible", `Run ${input.runId} on thread ${input.threadId} is not running.`);
		}
		if (input.runId !== undefined && active!.id !== input.runId) fail("thread_not_interruptible", `Run ${input.runId} is not the running turn of thread ${input.threadId}.`);
		try {
			await this.#bridge.interrupt(input.threadId);
		} catch (error) {
			fail("orchestration_error", `Unable to interrupt thread ${input.threadId}: ${(error as Error).message}`);
		}
		return { threadId: input.threadId, runId: active!.id, status: "interrupt_requested" } as OrchestratorMcpThreadInterruptResult;
	}

	/** `t3_thread_update`: rename a thread, or regenerate its title. */
	async update(caller: Caller, input: ThreadMetadataMcpUpdateInput): Promise<ThreadMetadataMcpUpdateResult> {
		const threadId = this.#target(caller, input.threadId);
		this.#mayWrite(caller, threadId);
		const commandId = `mcp-${stableId(namespaceOf(caller), input.clientRequestId ?? randomUUID(), "thread-update", input.action)}`;
		const command = { type: "thread.metadata.update", commandId, threadId, ...(input.action === "rename" ? { title: input.title } : { regenerateTitle: true }) };
		let sequence = 0;
		try {
			sequence = await dispatchCommand(this.#bridge, command as unknown as DispatchCommand, { createdBy: "agent", creationSource: "mcp" }, this.#log);
		} catch (error) {
			fail(error instanceof CommandError ? "invalid_request" : "orchestration_error", `Unable to update thread ${threadId}: ${(error as Error).message}`);
		}
		const shell = this.#bridge.threadShell(threadId);
		return {
			threadId: threadId as never,
			action: input.action,
			commandId: commandId as never,
			sequence,
			title: shell.title,
			titleRegeneration: shell.titleRegeneration == null ? null : { requestId: shell.titleRegeneration.requestId, startedAt: iso(shell.titleRegeneration.startedAt) },
			linkedPullRequest: null,
			updatedAt: iso(shell.updatedAt),
		} as ThreadMetadataMcpUpdateResult;
	}

	/** `create_threads` acts as the calling thread (T3's `actsAsCaller`: the new threads' origin is its run), so a client
	 * outside a thread is refused, as T3 refuses it. Agents inside the host start threads with `thread_prompt`. */
	create(caller: Caller, _input: OrchestratorMcpCreateThreadsInput): OrchestratorMcpCreateThreadsResult {
		this.#mayWrite(caller, undefined);
		return fail("thread_credential_required", "create_threads acts as the calling T3 thread, so it needs an agent running inside T3 Code. This MCP client signed in from outside a thread.");
	}

	// ---- scheduled tasks (T3's `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task`) -------------------

	/** The modes a caller may start work at: a thread's own (every thread here runs at full access), a client's
	 * approved ceiling. */
	#limits(caller: Caller): RuntimeMode {
		return caller.client === undefined ? "full-access" : clientCeiling(caller.client.access);
	}

	#tasks(): ScheduledTasks {
		return this.#scheduledTasks ?? fail("orchestration_error", "Scheduled tasks are not available on this host.");
	}

	/** The calling thread, which must have a live run (T3's `assertLiveCaller`); a client has none. */
	async #liveParent(caller: Caller): Promise<OrchestrationV2ThreadShell | undefined> {
		const parent = this.#caller(caller);
		if (parent === undefined) return undefined;
		if (latestActiveRun(await this.#projection(parent.id)) === undefined) fail("parent_not_active", "The calling provider no longer owns an active thread run.");
		return parent;
	}

	#project(projectId: string): { readonly id: string } {
		return this.#bridge.config.registry.list().find((project) => project.id === projectId) ?? fail("invalid_request", `Project ${projectId} was not found.`);
	}

	/** A task the caller may change: its runs (and its bound thread) run at modes no broader than the caller's. */
	async #ownedTask(caller: Caller, scheduledTaskId: string): Promise<ScheduledTask> {
		const task = this.#tasks().list().tasks.find((candidate) => candidate.id === scheduledTaskId) ?? fail("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
		const limit = this.#limits(caller);
		const modes = [task.runtimeMode, ...(task.threadId !== null && this.#bridge.hasThread(task.threadId) ? [this.#bridge.threadShell(task.threadId).runtimeMode] : [])];
		for (const mode of modes) {
			if (RUNTIME_MODE_RANK[mode] > RUNTIME_MODE_RANK[limit]) fail("runtime_mode_escalation_denied", `Child runtime mode ${mode} is broader than parent mode ${limit}.`);
		}
		return task;
	}

	/** T3's `scheduledTaskSummary`; this host serves no webhooks, so no task carries one. */
	#summary(task: ScheduledTask): OrchestratorMcpScheduledTask {
		return {
			scheduledTaskId: task.id,
			title: task.title,
			prompt: task.prompt,
			enabled: task.enabled,
			projectId: task.projectId,
			boundThreadId: task.threadId,
			// Never true here: a task that asks for it is refused on save (`FRESH_SESSION_UNSUPPORTED`).
			freshSession: scheduledTaskThreadMode(task) === "fresh_session",
			schedule: task.schedule,
			nextRunAt: task.nextRunAt,
			lastRunStatus: task.lastRunStatus,
		} as OrchestratorMcpScheduledTask;
	}

	async #upsert(input: ScheduledTaskUpsertInput, verb: string): Promise<ScheduledTask> {
		try {
			return (await this.#tasks().upsert(input)).task;
		} catch (error) {
			return fail("orchestration_error", `Could not ${verb} task: ${(error as Error).message}`);
		}
	}

	/**
	 * `schedule_task`: a new task (no `scheduledTaskId`), or a change to one. A new task runs at the caller's modes on the
	 * calling thread's model, posting each run into the calling thread (`bindToCurrentThread`, the default inside a thread
	 * of the same project) or starting a new thread per run at the project's root. T3 gives an unbound run a fresh
	 * worktree; this host has no worktrees, so it runs at the root, as a Scratch project's does in T3.
	 */
	async scheduleTask(caller: Caller, input: OrchestratorMcpSaveScheduledTaskInput): Promise<OrchestratorMcpScheduledTask> {
		this.#mayWrite(caller, undefined);
		const parent = await this.#liveParent(caller);
		const notInThread = "bindToCurrentThread needs an agent running inside a T3 thread.";
		const otherProject = "bindToCurrentThread binds to this thread, which belongs to a different project.";
		if (input.freshSession === true) fail("invalid_request", `freshSession: ${FRESH_SESSION_UNSUPPORTED}`);
		if (input.scheduledTaskId !== undefined) {
			const existing = await this.#ownedTask(caller, input.scheduledTaskId);
			if (input.bindToCurrentThread === true && (parent === undefined || parent.projectId !== existing.projectId)) fail("invalid_request", parent === undefined ? notInThread : otherProject);
			const threadId = input.bindToCurrentThread === undefined ? existing.threadId : input.bindToCurrentThread && parent !== undefined ? parent.id : null;
			const task = await this.#upsert(
				{
					id: existing.id,
					title: input.title ?? existing.title,
					prompt: input.prompt ?? existing.prompt,
					enabled: input.enabled ?? existing.enabled,
					schedule: input.schedule ?? existing.schedule,
					projectId: existing.projectId,
					threadId,
					// T3's rule, without its fresh sessions: an edit that names no binding keeps the mode; unbinding, or a
					// task that already made a thread per run, runs in new threads; anything else continues one thread.
					threadMode:
						input.freshSession === undefined && input.bindToCurrentThread === undefined
							? scheduledTaskThreadMode(existing)
							: threadId === null && (input.bindToCurrentThread === false || scheduledTaskThreadMode(existing) === "new_thread")
								? "new_thread"
								: "continue",
					workspaceStrategy: { type: "root" },
					modelSelection: existing.modelSelection,
					runtimeMode: existing.runtimeMode,
					interactionMode: existing.interactionMode,
					createdBy: existing.createdBy,
					creationSource: existing.creationSource,
				} as ScheduledTaskUpsertInput,
				"update scheduled",
			);
			return this.#summary(task);
		}
		if (input.prompt === undefined || input.schedule === undefined) fail("invalid_request", "A new scheduled task needs `prompt` and `schedule`.");
		const projectId = input.projectId ?? parent?.projectId ?? fail("target_required", "Pass projectId: this MCP client is not running inside a T3 thread.");
		this.#project(projectId);
		const bind = input.bindToCurrentThread ?? (parent !== undefined && parent.projectId === projectId);
		if (bind && (parent === undefined || parent.projectId !== projectId)) fail("invalid_request", parent === undefined ? notInThread : otherProject);
		const modelSelection = parent?.modelSelection ?? fail("invalid_request", `Project ${projectId} has no default model, so this caller cannot pick one for it.`);
		const derivedTitle = input.prompt!.split("\n")[0]?.trim() ?? "";
		const key = input.clientRequestId;
		const task = await this.#upsert(
			{
				title: input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task"),
				prompt: input.prompt!,
				enabled: input.enabled ?? true,
				schedule: input.schedule!,
				projectId,
				threadId: bind && parent !== undefined ? parent.id : null,
				threadMode: bind ? "continue" : "new_thread",
				workspaceStrategy: { type: "root" },
				modelSelection,
				runtimeMode: this.#limits(caller),
				interactionMode: "default",
				createdBy: "agent",
				creationSource: "mcp",
				...(key === undefined ? {} : { commandId: `mcp-${stableId(namespaceOf(caller), key, "schedule-task")}` }),
			} as ScheduledTaskUpsertInput,
			"schedule",
		);
		this.#log.info("scheduled task saved by an agent", { scheduledTaskId: task.id, threadId: caller.threadId });
		return this.#summary(task);
	}

	/** `list_scheduled_tasks`: the given project's, else the calling thread's project's, else all of them. */
	listScheduledTasks(caller: Caller, input: OrchestratorMcpListScheduledTasksInput): OrchestratorMcpListScheduledTasksResult {
		const projectId = input.projectId ?? this.#caller(caller)?.projectId;
		const tasks = this.#tasks().list().tasks.filter((task) => projectId === undefined || task.projectId === projectId);
		return { tasks: tasks.map((task) => this.#summary(task)) } as OrchestratorMcpListScheduledTasksResult;
	}

	/** `delete_scheduled_task`: it stops at once. */
	async deleteScheduledTask(caller: Caller, input: OrchestratorMcpDeleteScheduledTaskInput): Promise<OrchestratorMcpDeleteScheduledTaskResult> {
		this.#mayWrite(caller, undefined);
		await this.#liveParent(caller);
		const existing = await this.#ownedTask(caller, input.scheduledTaskId);
		try {
			await this.#tasks().delete({ id: existing.id });
		} catch (error) {
			fail("orchestration_error", `Could not delete scheduled task: ${(error as Error).message}`);
		}
		return { scheduledTaskId: existing.id, deleted: true } as OrchestratorMcpDeleteScheduledTaskResult;
	}

	// ---- projects (T3's project toolkit) ------------------------------------------------------------------------

	/** `t3_project_list`: a page of every project, in the registry's order (T3's `listPage`: offset cursor, 20 a page). */
	projectList(_caller: Caller, input: { readonly cursor?: number; readonly limit?: number }): { projects: ProjectRecord[]; nextCursor: number | null } {
		const all = this.#bridge.projectRecords();
		const cursor = input.cursor ?? 0;
		const limit = input.limit ?? 20;
		return { projects: all.slice(cursor, cursor + limit), nextCursor: cursor + limit < all.length ? cursor + limit : null };
	}

	/** `t3_project_read`: one project. */
	projectRead(_caller: Caller, input: { readonly projectId: string }): ProjectRecord {
		return this.#bridge.projectRecords().find((project) => project.id === input.projectId) ?? fail("invalid_request", "The project was not found.");
	}

	/** `t3_project_create`: register a folder (made first with `createWorkspaceRootIfMissing`). The id derives from the
	 * folder, as for a project added in the UI. */
	async projectCreate(caller: Caller, input: Record<string, unknown> & { readonly title: string; readonly workspaceRoot?: string; readonly createWorkspaceRootIfMissing?: boolean }): Promise<ProjectRecord> {
		this.#mayWrite(caller, undefined);
		this.#onlyStoredFields("t3_project_create", input, ["title", "workspaceRoot", "createWorkspaceRootIfMissing"]);
		if (input.workspaceRoot === undefined) fail("invalid_request", "A project here needs a workspaceRoot: this host makes no git repositories.");
		const project = await this.#mutateProject(caller, {
			type: "project.create",
			projectId: "",
			commandId: randomUUID(),
			title: input.title,
			workspaceRoot: input.workspaceRoot,
			...(input.createWorkspaceRootIfMissing === undefined ? {} : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
		});
		return project;
	}

	/** `t3_project_update`: rename, or point at another folder. Only the project changes: no file moves, and each thread
	 * keeps the folder it runs in. */
	async projectUpdate(caller: Caller, input: Record<string, unknown> & { readonly projectId: string; readonly title?: string; readonly workspaceRoot?: string }): Promise<ProjectRecord> {
		this.#mayWrite(caller, undefined);
		this.#onlyStoredFields("t3_project_update", input, ["projectId", "title", "workspaceRoot"]);
		return this.#mutateProject(caller, {
			type: "project.update",
			projectId: input.projectId,
			commandId: randomUUID(),
			...(input.title === undefined ? {} : { title: input.title }),
			...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
		});
	}

	/** `t3_project_delete`: the project, and with `force` its threads; the folder stays. */
	async projectDelete(caller: Caller, input: { readonly projectId: string; readonly force?: boolean }): Promise<ProjectRecord> {
		this.#mayWrite(caller, undefined);
		return this.#mutateProject(caller, { type: "project.delete", projectId: input.projectId, commandId: randomUUID(), ...(input.force === undefined ? {} : { force: input.force }) });
	}

	/** A project here is a title and a folder: any other field T3's payload carries is refused by name, not dropped. */
	#onlyStoredFields(tool: string, input: Record<string, unknown>, stored: readonly string[]): void {
		const extra = Object.keys(input).filter((key) => key !== "environmentId" && !stored.includes(key) && input[key] !== undefined);
		if (extra.length > 0) fail("invalid_request", `${tool}: ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not supported by pi-durable-t3; a project here has only a title and a folder.`);
	}

	/** The mutation, with T3's messages for its refusals (`projectFailure`); any other refusal keeps its own. */
	async #mutateProject(caller: Caller, mutation: ProjectMutation): Promise<ProjectRecord> {
		try {
			const project = await this.#bridge.mutateProject(mutation);
			this.#log.info("project changed over MCP or by an agent", { type: mutation.type, projectId: project.id, threadId: caller.threadId });
			return project;
		} catch (error) {
			const message = (error as Error).message ?? String(error);
			if (error instanceof ProjectNotFound || /was not found/.test(message)) fail("invalid_request", "The project was not found.");
			if (error instanceof ProjectConflict) fail("invalid_request", "The workspace is already registered to a project.");
			if (/is not empty/.test(message)) fail("invalid_request", "The project is not empty; force=true is required to delete it.");
			return fail("invalid_request", message);
		}
	}

	// ---- T3's thread toolkit: `t3_thread_organize`, `t3_queue`, `run_scheduled_task_now` ------------------------

	/** The thread a tool acts on (T3's `readThread`): the one named, else the caller's own. */
	#target(caller: Caller, threadId: string | undefined): string {
		const id = threadId ?? caller.threadId ?? fail("target_required", "Name a threadId outside a thread.");
		if (!this.#bridge.hasThread(id)) fail("thread_not_found", `Thread ${id} was not found.`);
		return id;
	}

	/** One thread command, through the same dispatch as the web app's (T3's `dispatch`, `dispatchFailure`). */
	async #command(command: Record<string, unknown> & { readonly type: string; readonly threadId: string }): Promise<{ sequence: number }> {
		try {
			const sequence = await dispatchCommand(this.#bridge, { commandId: `mcp-${randomUUID()}`, ...command } as unknown as DispatchCommand, { createdBy: "agent", creationSource: "mcp" }, this.#log);
			return { sequence };
		} catch (error) {
			return fail(error instanceof CommandError ? "invalid_request" : "orchestration_error", (error as Error).message);
		}
	}

	/** `t3_thread_organize`: the sidebar's actions. A thread's own agent settling it mid-turn settles it when the turn
	 * ends, and only if the turn completes (T3's `settleThread` with `byOwnAgent`). */
	async organize(caller: Caller, input: { readonly threadId?: string; readonly action: "pin" | "unpin" | "snooze" | "unsnooze" | "settle" | "unsettle" | "archive" | "unarchive" | "mark_unread"; readonly snoozedUntil?: string }): Promise<{ sequence: number } | { settlesWhenTurnEnds: true }> {
		const threadId = this.#target(caller, input.threadId);
		this.#mayWrite(caller, threadId);
		switch (input.action) {
			case "settle": {
				const active = caller.threadId === threadId ? latestActiveRun(await this.#projection(threadId)) : undefined;
				if (active !== undefined) {
					this.#settleAfterRun(threadId, active.id as string);
					return { settlesWhenTurnEnds: true };
				}
				return this.#command({ type: "thread.settle", threadId });
			}
			case "snooze":
				if (input.snoozedUntil === undefined) fail("invalid_request", "snooze requires snoozedUntil.");
				return this.#command({ type: "thread.snooze", threadId, snoozedUntil: input.snoozedUntil });
			case "mark_unread":
				return this.#command({ type: "thread.mark-unread", threadId });
			default:
				return this.#command({ type: `thread.${input.action}`, threadId });
		}
	}

	/**
	 * Settle `threadId` once run `runId` has ended, if it completed (T3's `settleAfterRun`, waiting as long). Since T3
	 * 0.1.9 it looks at what came after the run (`settleVerdict`), and names the latest run it saw in the settle, which
	 * is refused when another started meanwhile: then it looks again. Not kept across a restart, as T3's is not.
	 */
	#settleAfterRun(threadId: string, runId: string): void {
		const deadline = Date.now() + SETTLE_AFTER_RUN_WAIT_MS;
		const provenance = { createdBy: "agent", creationSource: "mcp" } as const;
		void (async () => {
			const run = await this.#bridge.waitFor(
				threadId,
				(projection) => {
					const found = projection.runs.find((candidate) => (candidate.id as string) === runId);
					return found !== undefined && !isActive(found) ? found : undefined;
				},
				SETTLE_AFTER_RUN_WAIT_MS,
			);
			if (run?.status !== "completed") return;
			for (let attempt = 0; Date.now() < deadline; attempt++) {
				const verdict = await this.#bridge.waitFor(threadId, (projection) => settleVerdict(projection, run.ordinal), deadline - Date.now());
				if (verdict === undefined || verdict === "leave") return;
				try {
					await dispatchCommand(this.#bridge, { type: "thread.settle", commandId: `server:settle-after-run:${runId}:${attempt}`, threadId, expectedLatestRunId: verdict.latestRunId } as unknown as DispatchCommand, provenance, this.#log);
					return;
				} catch (error) {
					if (!(error instanceof CommandError)) throw error;
					// A report can start a run between the look and the settle: wait until that run shows, then look again.
					await this.#bridge.waitFor(threadId, (projection) => (byOrdinalDesc(projection.runs)[0]?.id !== verdict.latestRunId ? true : undefined), deadline - Date.now());
				}
			}
		})().catch((error: unknown) => this.#log.warn("settling a thread after its turn failed", { threadId, runId, error: (error as Error).message }));
	}

	/** `t3_queue`: a thread's queued messages, in send order. `reorder` is refused: the queue is pi-durable's inbox, whose
	 * order this host does not change. */
	async queue(
		caller: Caller,
		input: { readonly action: "list" | "read" | "edit" | "cancel" | "reorder" | "promote_to_steer"; readonly threadId?: string; readonly queuedRunId?: string; readonly text?: string; readonly beforeRunId?: string | null; readonly targetRunId?: string; readonly cursor?: number; readonly limit?: number },
	): Promise<unknown> {
		const threadId = this.#target(caller, input.threadId);
		const projection = await this.#projection(threadId);
		if (input.action === "list") {
			const runs = queuedRunsInDeliveryOrder(projection);
			const cursor = input.cursor ?? 0;
			const end = cursor + (input.limit ?? 20);
			return { items: runs.slice(cursor, end).flatMap((run) => queueEntry(projection, run.id as string, 1_000) ?? []), nextCursor: end < runs.length ? end : null };
		}
		const runId = input.queuedRunId ?? fail("invalid_request", "This action needs `queuedRunId`.");
		if (input.action === "read") return queueEntry(projection, runId, 16_000) ?? fail("invalid_request", "The queued message was not found.");
		this.#mayWrite(caller, threadId);
		switch (input.action) {
			case "edit": {
				const text = input.text ?? fail("invalid_request", "This action needs `text`.");
				return this.#command({ type: "queued-run.edit", threadId, runId, text });
			}
			case "reorder":
				return fail("invalid_request", "reorder is not supported by pi-durable-t3: the queue keeps the order messages were sent in.");
			case "promote_to_steer": {
				const targetRunId = input.targetRunId ?? fail("invalid_request", "This action needs `targetRunId`.");
				if ((latestActiveRun(projection)?.id as string | undefined) !== targetRunId) fail("invalid_request", `Run ${targetRunId} is not the running turn of thread ${threadId}.`);
				return this.#command({ type: "queued-message.promote-to-steer", threadId, queuedRunId: runId, targetRunId });
			}
			default:
				return this.#command({ type: "queued-run.cancel", threadId, runId });
		}
	}

	/** `run_scheduled_task_now`: start a task's run; success means started, not finished. */
	async runScheduledTaskNow(caller: Caller, input: { readonly taskId: string }): Promise<{ taskId: string; threadId: string | null; link?: string; lastRunStatus: ScheduledTask["lastRunStatus"]; runCount: number; nextRunAt: ScheduledTask["nextRunAt"] }> {
		this.#mayWrite(caller, undefined);
		if (!this.#tasks().list().tasks.some((task) => task.id === input.taskId)) fail("invalid_request", "The scheduled task was not found.");
		let ran: { task: ScheduledTask; threadId: string | null };
		try {
			ran = await this.#tasks().runNow({ id: input.taskId });
		} catch (error) {
			return fail("orchestration_error", (error as Error).message);
		}
		const { task, threadId } = ran;
		return { taskId: task.id, threadId, ...(threadId === null ? {} : { link: this.#link(caller, threadId) }), lastRunStatus: task.lastRunStatus, runCount: task.runCount, nextRunAt: task.nextRunAt };
	}
}

/** T3's `queuedRunsInDeliveryOrder`: queued runs in the order they will be sent, a delegated completion first. */
function queuedRunsInDeliveryOrder(projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">): OrchestrationV2ThreadProjection["runs"] {
	const automatic = new Set(projection.messages.filter((message) => (message as { delegatedCompletion?: unknown }).delegatedCompletion !== undefined).map((message) => message.id));
	return projection.runs
		.filter((run) => run.status === "queued")
		.toSorted((left, right) => {
			const priority = Number(automatic.has(right.userMessageId)) - Number(automatic.has(left.userMessageId));
			const position = (run: (typeof projection.runs)[number]) => (run as { queuePosition?: number }).queuePosition ?? run.ordinal;
			return priority || position(left) - position(right) || left.ordinal - right.ordinal;
		});
}

/** T3's queue entry: a queued run's message, cut to `limit` characters. */
function queueEntry(projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">, runId: string, limit: number): { queuedRunId: string; text: string; truncated: boolean } | undefined {
	const run = projection.runs.find((candidate) => (candidate.id as string) === runId && candidate.status === "queued");
	const message = projection.messages.find((candidate) => candidate.id === run?.userMessageId);
	if (run === undefined || message === undefined) return undefined;
	const characters = Array.from(message.text);
	return { queuedRunId: run.id as string, text: characters.slice(0, limit).join(""), truncated: characters.length > limit };
}

/** T3's `SETTLE_AFTER_RUN_WAIT_MS`: how long a thread's own settle waits for its turn to end. */
const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;
