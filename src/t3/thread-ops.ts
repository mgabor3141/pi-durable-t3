// T3's thread tools (`OrchestratorMcpService`: `t3_thread_list`, `t3_thread_read`, `t3_thread_send`, `t3_thread_wait`,
// `t3_thread_interrupt`, `create_threads`, `t3_thread_update`), on this host's threads. Inputs and results are the
// contract's (`orchestratorMcp.ts`); a refusal is its `OrchestratorMcpFailure`. The caller is the thread the call comes
// from, when it comes from one (MCP's `_meta`, or an agent's own conversation): it names what "this thread" and "this
// project" mean, and it is recorded as the sender of what it writes.
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
import * as DateTime from "effect/DateTime";
import type { Bridge } from "./bridge.ts";
import { type DispatchCommand, dispatchCommand } from "./dispatch.ts";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";

/** Who is calling: the thread the call comes from, if any, and the web origin its links should open in. */
export type Caller = { readonly threadId?: string; readonly webOrigin?: string };

type Failure = OrchestratorMcpFailure["code"];
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

/** An id for one operation of one request, stable across a retry with the same `clientRequestId` (T3's `stableCommandId`). */
const stableId = (...parts: readonly (string | number | undefined)[]) =>
	createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\0")).digest("base64url").slice(0, 24);

/** T3's `threadTitle` for a created thread: the title, else the prompt, clipped to 80; else "<parent> thread <n>". */
function createdThreadTitle(input: { parentTitle: string; title: string | undefined; prompt: string | undefined; index: number }): string {
	const detail = input.title?.trim() || input.prompt?.trim();
	if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
	return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

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

	constructor(bridge: Bridge, environmentId: string, log: Logger) {
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

	/** `t3_thread_list`: threads newest first, in the caller's project (or the one named, or all). */
	list(caller: Caller, input: OrchestratorMcpThreadListInput): OrchestratorMcpThreadListResult {
		const parent = this.#caller(caller);
		const projectId = input.allProjects === true ? null : (input.projectId ?? parent?.projectId ?? fail("target_required", "Name a projectId, or pass allProjects: true, outside a thread."));
		const statuses = input.statuses === undefined || input.statuses.length === 0 ? null : new Set<string>(input.statuses);
		const titleContains = input.titleContains?.toLocaleLowerCase();
		const threads = this.#bridge
			.shellSnapshot()
			.threads.filter((shell) => projectId === null || shell.projectId === projectId)
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
			currentThreadId: (parent?.id ?? null) as never,
			threads: page.map((shell) => this.#listItem(caller, shell)),
			nextCursor: cursor + page.length < threads.length ? cursor + page.length : null,
			total: threads.length,
		} as OrchestratorMcpThreadListResult;
	}

	/** `t3_thread_read`: a page of the thread's timeline (`messages`: messages and plans; `activity`: every item). */
	async read(caller: Caller, input: OrchestratorMcpThreadReadInput): Promise<OrchestratorMcpThreadReadResult> {
		this.#caller(caller);
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
		const parent = this.#caller(caller);
		const before = await this.#projection(input.threadId);
		const mode = input.mode ?? "auto";
		const running = before.runs.find((run) => run.status === "running");
		if ((mode === "steer" || mode === "restart") && running === undefined) fail("thread_not_sendable", `Thread ${input.threadId} has no running turn to ${mode}.`);
		const key = input.clientRequestId ?? randomUUID();
		const messageId = `mcp-${stableId(caller.threadId, key, "thread-send", "message")}`;
		const commandId = `mcp-${stableId(caller.threadId, key, "thread-send")}`;
		try {
			await this.#bridge.sendMessage({
				threadId: input.threadId,
				commandId,
				messageId,
				text: input.message,
				mode: mode === "auto" ? (running === undefined ? "start" : "steer") : mode === "queue" ? (running === undefined ? "start" : "queue") : mode,
				provenance: { createdBy: "agent", creationSource: "mcp", ...(parent === undefined ? {} : { senderThreadId: parent.id }) },
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
		const delivery = found.run.status === "queued" || found.intent === "queued_turn" ? "queued" : found.intent === "turn_start" ? "started" : mode === "restart" ? "restarted" : "steered";
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
		this.#caller(caller);
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
		this.#caller(caller);
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

	/** `t3_thread_update`: rename a thread, or regenerate its title (this thread when none is named). */
	async update(caller: Caller, input: ThreadMetadataMcpUpdateInput): Promise<ThreadMetadataMcpUpdateResult> {
		const parent = this.#caller(caller);
		const threadId = input.threadId ?? parent?.id ?? fail("target_required", "Name a threadId outside a thread.");
		if (!this.#bridge.hasThread(threadId)) fail("thread_not_found", `Thread ${threadId} was not found.`);
		const commandId = `mcp-${stableId(caller.threadId, input.clientRequestId ?? randomUUID(), "thread-update", input.action)}`;
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

	/**
	 * `create_threads`: new top-level threads in the caller's project, each started with its prompt when it has one. Only a
	 * thread with a running turn may create threads (T3: the creating run is their origin). A retry with the same
	 * `clientRequestId` returns the same threads.
	 */
	async create(caller: Caller, input: OrchestratorMcpCreateThreadsInput): Promise<OrchestratorMcpCreateThreadsResult> {
		const parent = this.#caller(caller) ?? fail("parent_not_active", "Thread creation requires a calling thread.");
		const parentProjection = await this.#projection(parent.id);
		if (latestActiveRun(parentProjection) === undefined) fail("parent_not_active", "Thread creation requires an active run in the calling thread.");
		const key = input.clientRequestId ?? randomUUID();
		const created: OrchestratorMcpCreateThreadsResult["threads"][number][] = [];
		for (const [index, request] of input.threads.entries()) {
			if (request.target?.environmentId !== undefined) fail("invalid_request", "Linked environments are not supported by this host.");
			const threadId = `mcp-${stableId(caller.threadId, key, "create-thread", index)}`;
			const model = request.target?.model ?? parent.modelSelection.model;
			const title = createdThreadTitle({ parentTitle: parent.title, title: request.title, prompt: request.prompt, index });
			try {
				await this.#bridge.launchThread({
					commandId: `mcp-${stableId(caller.threadId, key, "create-thread-command", index)}`,
					threadId,
					projectId: parent.projectId,
					title,
					modelSelection: { model },
					...(request.prompt === undefined ? {} : { initialMessage: { messageId: `mcp-${stableId(caller.threadId, key, "create-thread-message", index)}`, text: request.prompt } }),
					provenance: { createdBy: "agent", creationSource: "mcp", senderThreadId: parent.id },
				});
			} catch (error) {
				fail(error instanceof CommandError ? "invalid_request" : "orchestration_error", `Unable to create thread ${index + 1}: ${(error as Error).message}`);
			}
			const shell = this.#shell(threadId)!;
			created.push({
				threadId: threadId as never,
				link: this.#link(caller, threadId),
				runId: shell.latestRunId,
				status: (shell.activityRunStatus ?? shell.status) as never,
				title: shell.title,
				createdBy: shell.createdBy,
				creationSource: shell.creationSource,
				providerInstanceId: shell.modelSelection.instanceId,
				model: shell.modelSelection.model,
			} as OrchestratorMcpCreateThreadsResult["threads"][number]);
		}
		return { threads: created } as OrchestratorMcpCreateThreadsResult;
	}
}
