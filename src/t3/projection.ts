// Pure mapping from a pi conversation (the head's `ConversationView` plus the thread's directory row) to T3's thread
// projection and shell: one user turn per run (`runs.ts`), one synthetic "ready" checkpoint per settled run plus a
// baseline (`undo.ts`'s ids), and an aborted assistant partial hidden when a later entry of the run supersedes it.
import type {
	OrchestrationV2Checkpoint,
	OrchestrationV2CheckpointScope,
	OrchestrationV2ConversationMessage,
	OrchestrationV2ExecutionNode,
	OrchestrationV2ProjectedTurnItem,
	OrchestrationV2ProviderSession,
	OrchestrationV2ProviderThread,
	OrchestrationV2ProviderTurn,
	OrchestrationV2Run,
	OrchestrationV2RunAttempt,
	OrchestrationV2Subagent,
	OrchestrationV2ThreadProjection,
	OrchestrationV2ThreadShell,
	OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PI_CAPABILITIES } from "./capabilities.ts";
import { type ContentBlock, type ConversationView, type LiveDoc, type DurableMessage, type EntryRecord, modelSlug, type ModelRef, thinkingOption } from "./model-types.ts";
import { textOf } from "./thread-search.ts";
import { SCHEDULED_MESSAGE_ID } from "./scheduled-tasks.ts";
import { attachmentsOf, firstMessage, groupRuns, isAbortedToolResult, isAssistantEntry, isUserEntry, messageIdOf, stopReason } from "./runs.ts";
import { readQueuedInputs } from "./queued.ts";
import { detailsConversationId, type SubagentRef, subagentNodeId } from "./subagents.ts";
import { BASELINE_CHECKPOINT_ID, type RolledBackRun } from "./undo.ts";

type LiveToolSlot = NonNullable<LiveDoc["tools"]>[number];

export const PROVIDER_INSTANCE_ID = "pi";
export const PROVIDER_DRIVER = "pi";
const BASELINE_SCOPE_ID = "cs-baseline";

// biome-ignore lint/suspicious/noExplicitAny: branded IDs are plain strings on the wire
type Any = any;
const id = (value: string): Any => value;
/** Where a message ends: pi stamps an assistant message when its stream starts, and pi-ai's stream adds `durationMs`. */
const endOf = (message: { role?: string; timestamp?: number; durationMs?: number } | undefined, fallback: number): number =>
	(message?.timestamp ?? fallback) + (message?.role === "assistant" ? (message.durationMs ?? 0) : 0);
const time = (ms: number | undefined) => DateTime.makeUnsafe(ms ?? 0);

export interface ThreadMeta {
	readonly threadId: string;
	readonly projectId: string;
	readonly title: string;
	readonly cwd: string;
	/** The project's root, for the shell's `worktreePath`: a thread running in a folder of its own (a Scratch thread) is
	 * reported with it, exactly as T3 records a launch's folder on the thread. Absent, nothing is reported. */
	readonly projectPath?: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** The Session's model, for the thread's model selection. */
	readonly model: ModelRef | null;
	/** The Session's thinking level, reported back as the selection's `thinking` option. */
	readonly thinkingLevel?: string;
	/** When this thread was promoted/forked from another, that thread's id (lineage → a "fork"). */
	readonly parentThreadId?: string;
	/** Directory status, used when no transcript is loaded. */
	readonly running: boolean;
	/** The subagents this thread's tool calls own, by the owning call's task (`subagents.ts`): a call whose details name
	 * one of these children is shown as a subagent. */
	readonly subagents?: ReadonlyMap<number, SubagentRef>;
	/** Set on a subagent's own thread: pi owns it as Claude owns its Task children (provider-native, so it cannot take
	 * user messages). `parentThreadId` is the thread whose call created it; `nodeId` that call's node. */
	readonly subagentOf?: { readonly parentThreadId: string; readonly nodeId: string };
	/** T3's in-progress title generation (in memory only: none survives a restart). */
	readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: number } | null;
}

/** Bridge-side memory needed for a faithful projection. */
interface ThreadMemory {
	/** Runs removed by rewinds, kept as `rolled_back` so a client looking at a forked head reads them as history —
	 * load-bearing, not cosmetic (design.md, Invariants). */
	readonly rolledBack: readonly RolledBackRun[];
	readonly rollbackRequestId?: string | undefined;
	readonly rollbackFailure?: { requestId: string; message: string } | null | undefined;
}

interface ProjectedRun {
	readonly runId: string;
	readonly ordinal: number;
	/** Entry ID of the user message that started the run. */
	readonly userEntryId: number;
	/** Entry ID of the run's last durable entry (the checkpoint's `ref`). */
	readonly lastEntryId: number;
	readonly status: OrchestrationV2Run["status"];
}

export interface ProjectionResult {
	readonly projection: OrchestrationV2ThreadProjection;
	readonly shell: OrchestrationV2ThreadShell;
	readonly runs: readonly ProjectedRun[];
}

const thinkingOf = (content: ContentBlock[]): string =>
	content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])).join("");


export function projectThread(
	meta: ThreadMeta,
	view: ConversationView | undefined,
	memory: ThreadMemory,
): ProjectionResult {
	const threadId = meta.threadId;
	const providerThreadId = `pt-${threadId}`;
	const live = view?.docs["pi.live"];
	const busy = view === undefined ? meta.running : live?.run !== undefined;
	// The thread's selection, reported as the client named it: the model and the `thinking` level the conversation
	// carries. No model yet is the `"default"` slug, which answers no catalog entry (capabilities.md).
	const modelSelection: Any = {
		instanceId: PROVIDER_INSTANCE_ID,
		model: meta.model === null ? "default" : modelSlug(meta.model),
		...(meta.thinkingLevel === undefined ? {} : { options: thinkingOption(meta.thinkingLevel) }),
	};
	const drafts = groupRuns(view?.entries ?? []);
	// The thread's folder of its own, as T3 spells it on a thread row: a folder UNDER the project root (the registry's
	// cover rule, `Threads.#projectForConversation`), null for a thread running at the root itself.
	const worktreePath = meta.projectPath === undefined || !meta.cwd.startsWith(`${meta.projectPath}/`) ? null : meta.cwd;

	const runs: OrchestrationV2Run[] = [];
	const attempts: OrchestrationV2RunAttempt[] = [];
	const nodes: OrchestrationV2ExecutionNode[] = [];
	const providerTurns: OrchestrationV2ProviderTurn[] = [];
	const messages: OrchestrationV2ConversationMessage[] = [];
	const turnItems: OrchestrationV2TurnItem[] = [];
	const subagents: OrchestrationV2Subagent[] = [];
	const checkpointScopes: OrchestrationV2CheckpointScope[] = [];
	const checkpoints: OrchestrationV2Checkpoint[] = [];
	const projectedRuns: ProjectedRun[] = [];
	let lastActivity = meta.updatedAt;

	// The baseline checkpoint (before the first turn) hangs off a synthetic system node.
	nodes.push({
		id: id("n-baseline"),
		threadId: id(threadId),
		runId: null,
		parentNodeId: null,
		rootNodeId: id("n-baseline"),
		kind: "system",
		status: "completed",
		countsForRun: false,
		providerThreadId: id(providerThreadId),
		providerTurnId: null,
		nativeItemRef: null,
		runtimeRequestId: null,
		checkpointScopeId: id(BASELINE_SCOPE_ID),
		startedAt: time(meta.createdAt),
		completedAt: time(meta.createdAt),
	});
	checkpointScopes.push({
		id: id(BASELINE_SCOPE_ID),
		threadId: id(threadId),
		runId: null,
		nodeId: id("n-baseline"),
		parentScopeId: null,
		providerThreadId: id(providerThreadId),
		kind: "manual",
		ordinalWithinParent: 0,
		advancesAppRunCount: false,
		cwd: meta.cwd,
		createdAt: time(meta.createdAt),
	});
	checkpoints.push({
		id: id(BASELINE_CHECKPOINT_ID),
		threadId: id(threadId),
		scopeId: id(BASELINE_SCOPE_ID),
		runId: null,
		nodeId: id("n-baseline"),
		parentCheckpointId: null,
		ordinalWithinScope: 0,
		appRunOrdinal: null,
		ref: id("pi:baseline"),
		status: "ready",
		files: [],
		capturedAt: time(meta.createdAt),
	});

	drafts.forEach((draft, index) => {
		const ordinal = index + 1;
		const isLast = index === drafts.length - 1;
		const u = draft.userEntry;
		const runId = `r${u.id}`;
		const nodeId = `n${u.id}`;
		const attemptId = `a${u.id}`;
		const turnId = `ptu${u.id}`;
		const userMessage = firstMessage(u)!;
		const requestedAt = userMessage.timestamp ?? meta.createdAt;
		const assistants = draft.steps.filter(isAssistantEntry);
		const lastAssistant = assistants.at(-1);
		const running = isLast && busy;
		let status: OrchestrationV2Run["status"];
		if (running) status = "running";
		else {
			const reason = stopReason(lastAssistant);
			status =
				reason === "stop" || reason === "length"
					? "completed"
					: reason === "error"
						? "failed"
						: "interrupted";
		}
		const lastEntry = draft.steps.at(-1) ?? u;
		// The run ends where its last entry's message ends (`endOf`, the same value the assistant message and its item carry).
		const lastMessage = firstMessage(lastEntry);
		const completedMs = running ? null : endOf(lastMessage, requestedAt);
		lastActivity = Math.max(lastActivity, completedMs ?? requestedAt);
		// The run's model, read from the assistant message pi recorded for it (capabilities.md: no provider session to read).
		const runModel: Any = (() => {
			const m = lastAssistant === undefined ? undefined : firstMessage(lastAssistant);
			return m?.role === "assistant" && m.provider !== undefined && m.model !== undefined
				? { instanceId: PROVIDER_INSTANCE_ID, model: `${m.provider}/${m.model}` }
				: modelSelection;
		})();
		const settled = !running;
		const checkpointId = settled ? `cp${u.id}` : null;
		runs.push({
			id: id(runId),
			threadId: id(threadId),
			ordinal,
			providerInstanceId: id(PROVIDER_INSTANCE_ID),
			modelSelection: runModel,
			providerThreadId: id(providerThreadId),
			userMessageId: id(messageIdOf(u) ?? `m${u.id}`),
			rootNodeId: id(nodeId),
			activeAttemptId: id(attemptId),
			status,
			requestedAt: time(requestedAt),
			startedAt: time(requestedAt),
			completedAt: completedMs === null ? null : time(completedMs),
			checkpointId: checkpointId === null ? null : id(checkpointId),
			contextHandoffId: null,
		});
		const attemptStatus = status === "running" ? "running" : status === "failed" ? "failed" : status;
		attempts.push({
			id: id(attemptId),
			runId: id(runId),
			attemptOrdinal: 1,
			rootNodeId: id(nodeId),
			providerInstanceId: id(PROVIDER_INSTANCE_ID),
			providerThreadId: id(providerThreadId),
			providerTurnId: id(turnId),
			reason: "initial",
			status: attemptStatus as OrchestrationV2RunAttempt["status"],
			startedAt: time(requestedAt),
			completedAt: completedMs === null ? null : time(completedMs),
		});
		nodes.push({
			id: id(nodeId),
			threadId: id(threadId),
			runId: id(runId),
			parentNodeId: null,
			rootNodeId: id(nodeId),
			kind: "root_turn",
			status: status as OrchestrationV2ExecutionNode["status"],
			countsForRun: true,
			providerThreadId: id(providerThreadId),
			providerTurnId: id(turnId),
			nativeItemRef: null,
			runtimeRequestId: null,
			checkpointScopeId: id(`cs${u.id}`),
			startedAt: time(requestedAt),
			completedAt: completedMs === null ? null : time(completedMs),
		});
		providerTurns.push({
			id: id(turnId),
			providerThreadId: id(providerThreadId),
			nodeId: id(nodeId),
			runAttemptId: id(attemptId),
			nativeTurnRef: null,
			ordinal,
			status: attemptStatus as OrchestrationV2ProviderTurn["status"],
			startedAt: time(requestedAt),
			completedAt: completedMs === null ? null : time(completedMs),
		});
		checkpointScopes.push({
			id: id(`cs${u.id}`),
			threadId: id(threadId),
			runId: id(runId),
			nodeId: id(nodeId),
			parentScopeId: null,
			providerThreadId: id(providerThreadId),
			kind: "root_run",
			ordinalWithinParent: index,
			advancesAppRunCount: true,
			cwd: meta.cwd,
			createdAt: time(requestedAt),
		});
		if (checkpointId !== null) {
			checkpoints.push({
				id: id(checkpointId),
				threadId: id(threadId),
				scopeId: id(`cs${u.id}`),
				runId: id(runId),
				nodeId: id(nodeId),
				parentCheckpointId: id(checkpoints.at(-1)!.id),
				ordinalWithinScope: 1,
				appRunOrdinal: ordinal,
				ref: id(`pi:${lastEntry.id}`),
				status: "ready",
				files: [],
				capturedAt: time(completedMs ?? requestedAt),
			});
		}
		projectedRuns.push({ runId, ordinal, userEntryId: u.id, lastEntryId: lastEntry.id, status });

		// ---- items ----
		const base = (itemId: string, at: number, itemStatus: OrchestrationV2TurnItem["status"], done: boolean, end = at) => ({
			id: id(itemId),
			threadId: id(threadId),
			runId: id(runId),
			nodeId: id(nodeId),
			providerThreadId: id(providerThreadId),
			providerTurnId: id(turnId),
			nativeItemRef: null,
			parentItemId: null,
			ordinal,
			status: itemStatus,
			title: null,
			startedAt: time(at),
			completedAt: done ? time(end) : null,
			updatedAt: time(end),
		});
		const pushUser = (entry: EntryRecord, intent: "turn_start" | "steer") => {
			const message = firstMessage(entry)!;
			const messageId = messageIdOf(entry) ?? `m${entry.id}`;
			const at = message.timestamp ?? requestedAt;
			const text = textOf(message.role === "user" ? message.content : undefined);
			// The images the entry carries in its data (T3's `ChatImageAttachment`s) — shown on the message after a restart.
			const attachments = attachmentsOf(entry);
			// A scheduled task's message: T3 records the task on it, and the id the scheduler mints names the task.
			const scheduledTaskId = SCHEDULED_MESSAGE_ID.exec(messageId)?.[1];
			const scheduled = scheduledTaskId === undefined ? {} : { scheduledTaskId: id(scheduledTaskId) };
			// A subagent's first message is its parent's call: T3 records it as the agent's, with the sending thread.
			const fromParent = meta.subagentOf !== undefined && intent === "turn_start";
			const author = fromParent ? ({ createdBy: "agent", creationSource: "provider" } as const) : ({ createdBy: "user", creationSource: "web" } as const);
			const sender = fromParent ? { senderThreadId: id(meta.subagentOf!.parentThreadId) } : {};
			turnItems.push({
				...base(`ti-u${entry.id}`, at, "completed", true),
				...author,
				...sender,
				type: "user_message",
				messageId: id(messageId),
				...scheduled,
				inputIntent: intent,
				text,
				attachments,
			} as Any);
			messages.push({
				...author,
				...sender,
				...scheduled,
				id: id(messageId),
				threadId: id(threadId),
				runId: id(runId),
				nodeId: id(nodeId),
				role: "user",
				text,
				attachments,
				streaming: false,
				createdAt: time(at),
				updatedAt: time(at),
			});
		};
		const pushAssistant = (
			key: string,
			message: Extract<DurableMessage, { role: "assistant" }>,
			at: number,
			streaming: boolean,
			toolResults: ReadonlyMap<string, EntryRecord>,
			liveTools: ReadonlyMap<string, LiveToolSlot>,
		) => {
			const end = endOf(message, at);
			const thinking = thinkingOf(message.content);
			if (thinking.length > 0) {
				turnItems.push({
					...base(`ti-r${key}`, at, streaming ? "running" : "completed", !streaming, end),
					type: "reasoning",
					text: thinking,
					streaming,
				} as Any);
			}
			const text = textOf(message.content);
			if (text.length > 0 || (streaming && message.content.length === 0)) {
				const messageId = `m${key}`;
				turnItems.push({
					...base(`ti-a${key}`, at, streaming ? "running" : "completed", !streaming, end),
					type: "assistant_message",
					messageId: id(messageId),
					text,
					streaming,
				} as Any);
				messages.push({
					createdBy: "agent",
					creationSource: "provider",
					id: id(messageId),
					threadId: id(threadId),
					runId: id(runId),
					nodeId: id(nodeId),
					role: "assistant",
					text,
					attachments: [],
					streaming,
					createdAt: time(at),
					updatedAt: time(end),
				});
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result = toolResults.get(block.id);
				const resultMessage = result === undefined ? undefined : firstMessage(result);
				const liveSlot = liveTools.get(block.id);
				const output =
					resultMessage?.role === "toolResult" ? textOf(resultMessage.content) : (liveSlot?.output ?? undefined);
				const failed = resultMessage?.role === "toolResult" && resultMessage.isError === true;
				const aborted = result !== undefined && isAbortedToolResult(result);
				const itemStatus: OrchestrationV2TurnItem["status"] = aborted
					? "interrupted"
					: result !== undefined
						? failed
							? "failed"
							: "completed"
						: running
							? "running"
							: "interrupted";
				const resultAt = resultMessage?.timestamp ?? at;
				const common = base(`ti-t${block.id}`, resultAt, itemStatus, result !== undefined);
				// A subagent: the call's details name a child conversation that the call's own task owns (`subagents.ts`).
				const callTaskId = result?.byTaskId ?? liveSlot?.taskId;
				const childId = detailsConversationId(resultMessage?.role === "toolResult" ? resultMessage.details : liveSlot?.details);
				const ref = callTaskId === undefined || childId === undefined ? undefined : meta.subagents?.get(callTaskId);
				if (ref !== undefined && ref.conversationId === childId) {
					const subagentStatus: OrchestrationV2Subagent["status"] =
						itemStatus === "interrupted" ? (aborted ? "cancelled" : "interrupted") : (itemStatus as OrchestrationV2Subagent["status"]);
					// The card runs from its task's start to the call's result (the parent message's stamp is when its stream began,
					// long before the call ran).
					const nodeAt = time(resultAt);
					const startAt = time(ref.startedAt);
					const nativeTaskRef = { driver: id(PROVIDER_DRIVER), nativeId: String(ref.taskId), strength: "strong" } as const;
					const subagentNode = subagentNodeId(ref.taskId);
					const prompt = typeof block.arguments["prompt"] === "string" ? block.arguments["prompt"] : "";
					const label = typeof block.arguments["description"] === "string" && block.arguments["description"].trim() !== "" ? block.arguments["description"] : null;
					const settledSubagent = result !== undefined;
					// Claude's cancelled/interrupted subagent carries no result; a failed one carries the tool's error text, which in
					// pi is wrapped in a `<harness>` block.
					const subagentResult =
						!settledSubagent || subagentStatus === "cancelled" || subagentStatus === "interrupted"
							? null
							: (output ?? "").replace(/^\s*<harness>\s*([\s\S]*?)\s*<\/harness>\s*$/, "$1");
					nodes.push({
						id: id(subagentNode),
						threadId: id(threadId),
						runId: id(runId),
						parentNodeId: id(nodeId),
						rootNodeId: id(nodeId),
						kind: "subagent",
						status: subagentStatus as OrchestrationV2ExecutionNode["status"],
						countsForRun: false,
						providerThreadId: id(providerThreadId),
						providerTurnId: id(turnId),
						nativeItemRef: nativeTaskRef,
						runtimeRequestId: null,
						checkpointScopeId: null,
						startedAt: startAt,
						completedAt: settledSubagent ? nodeAt : null,
					} as Any);
					subagents.push({
						id: id(subagentNode),
						threadId: id(threadId),
						runId: id(runId),
						parentNodeId: id(nodeId),
						origin: "provider_native",
						createdBy: "agent",
						driver: id(PROVIDER_DRIVER),
						providerInstanceId: id(PROVIDER_INSTANCE_ID),
						providerThreadId: id(providerThreadId),
						childThreadId: id(ref.threadId),
						nativeTaskRef,
						prompt,
						title: label,
						model: null,
						status: subagentStatus,
						result: subagentResult,
						startedAt: startAt,
						completedAt: settledSubagent ? nodeAt : null,
						updatedAt: nodeAt,
					} as Any);
					turnItems.push({
						...common,
						startedAt: startAt,
						completedAt: settledSubagent ? nodeAt : null,
						nodeId: id(subagentNode),
						nativeItemRef: nativeTaskRef,
						status: subagentStatus,
						title: label,
						type: "subagent",
						subagentId: id(subagentNode),
						origin: "provider_native",
						driver: id(PROVIDER_DRIVER),
						providerInstanceId: id(PROVIDER_INSTANCE_ID),
						childThreadId: id(ref.threadId),
						prompt,
						result: subagentResult,
					} as Any);
					continue;
				}
				if (block.name === "bash" && typeof block.arguments.command === "string") {
					turnItems.push({
						...common,
						title: "bash",
						type: "command_execution",
						input: block.arguments.command,
						...(output === undefined ? {} : { output }),
						...(failed ? { outputIndicatesFailure: true } : {}),
					} as Any);
				} else {
					turnItems.push({
						...common,
						title: block.name,
						type: "dynamic_tool",
						toolName: block.name,
						input: block.arguments,
						...(output === undefined ? {} : { output }),
					} as Any);
				}
			}
			if (message.stopReason === "error" && !streaming) {
				turnItems.push({
					...base(`ti-e${key}`, at, "failed", true),
					type: "error",
					failure: {
						class: "provider_error",
						message: (message.errorMessage ?? "The model request failed.").slice(0, 4000) || "The model request failed.",
						code: null,
						retryable: null,
					},
				} as Any);
			}
		};

		pushUser(u, "turn_start");
		const toolResults = new Map<string, EntryRecord>();
		for (const step of draft.steps) {
			const m = firstMessage(step);
			if (m?.role === "toolResult") toolResults.set(m.toolCallId, step);
		}
		const liveTools = new Map<string, LiveToolSlot>();
		if (running) {
			for (const slot of live?.tools ?? []) {
				const key = (slot["callId"] ?? slot.toolCallId ?? slot.id) as string | undefined;
				if (key !== undefined) liveTools.set(key, slot);
			}
		}
		draft.steps.forEach((step, stepIndex) => {
			if (isUserEntry(step)) {
				pushUser(step, "steer");
				return;
			}
			const m = firstMessage(step);
			if (m?.role !== "assistant") return;
			// A partial interrupted by a crash is superseded by the resumed answer.
			const superseded = m.stopReason === "aborted" && draft.steps.slice(stepIndex + 1).some(isAssistantEntry);
			if (superseded) return;
			pushAssistant(String(step.id), m, m.timestamp ?? requestedAt, false, toolResults, liveTools);
		});
		const partial = running ? live?.generation?.message : undefined;
		if (partial?.role === "assistant") {
			pushAssistant(
				`live${u.id}-${live?.generation?.attempt ?? 0}`,
				partial,
				partial.timestamp ?? Date.now(),
				true,
				toolResults,
				liveTools,
			);
		}
	});

	// Queued follow-ups live in pi's inbox until a boundary places them. T3's queue reads them as runs, so project each
	// follow-up as a queued run now; it disappears from here when the inbox item is placed and a real run replaces it.
	const queued = readQueuedInputs((view?.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined)?.items).filter((item) => item.mode === "followUp");
	queued.forEach((item, index) => {
		const ordinal = drafts.length + index + 1;
		const queuedRunId = `q${item.submissionId}`;
		const queuedNodeId = `nq${item.submissionId}`;
		const requestedAt = meta.updatedAt;
		runs.push({
			id: id(queuedRunId),
			threadId: id(threadId),
			ordinal,
			providerInstanceId: id(PROVIDER_INSTANCE_ID),
			modelSelection,
			providerThreadId: id(providerThreadId),
			userMessageId: id(item.messageId),
			rootNodeId: null,
			activeAttemptId: null,
			status: "queued",
			queuePosition: index + 1,
			requestedAt: time(requestedAt),
			startedAt: null,
			completedAt: null,
			checkpointId: null,
			contextHandoffId: null,
		} as Any);
		messages.push({
			createdBy: "user",
			creationSource: "web",
			id: id(item.messageId),
			threadId: id(threadId),
			runId: id(queuedRunId),
			nodeId: id(queuedNodeId),
			role: "user",
			text: item.text,
			attachments: [...item.attachments],
			streaming: false,
			createdAt: time(requestedAt),
			updatedAt: time(requestedAt),
		} as Any);
	});

	// A subagent's thread carries the root node T3's provider-native children have (`runId: null`): the web app reads the
	// child's status bar ("Running 3s", "Done") from it (`deriveProviderSubagentStatus`).
	if (meta.subagentOf !== undefined) {
		const last = runs.at(-1);
		const rootStatus = (busy ? "running" : (last?.status ?? "pending")) as OrchestrationV2ExecutionNode["status"];
		const settledAt = busy || last === undefined ? null : last.completedAt;
		nodes.push({
			id: id(`n-sub-root`),
			threadId: id(threadId),
			runId: null,
			parentNodeId: null,
			rootNodeId: id(`n-sub-root`),
			kind: "root_turn",
			status: rootStatus,
			countsForRun: false,
			providerThreadId: null,
			providerTurnId: null,
			nativeItemRef: null,
			runtimeRequestId: null,
			checkpointScopeId: null,
			startedAt: time(meta.createdAt),
			completedAt: settledAt,
		} as Any);
	}

	// Runs removed by rewinds stay as rolled back; their items stay hidden (design.md, Invariants).
	const known = new Set(runs.map((run) => run.id as string));
	for (const rolled of memory.rolledBack) {
		if (known.has(rolled.run.id as string)) continue;
		runs.push(rolled.run);
		turnItems.push(...rolled.items);
		messages.push(...rolled.messages);
		nodes.push(...rolled.nodes);
		attempts.push(...rolled.attempts);
		providerTurns.push(...rolled.providerTurns);
		checkpointScopes.push(...rolled.checkpointScopes);
	}

	const rolledBackIds = new Set(runs.filter((run) => run.status === "rolled_back").map((run) => run.id as string));
	const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = turnItems
		.filter((item) => item.runId === null || !rolledBackIds.has(item.runId as string))
		.map((item, position) => ({
			position,
			visibility: "local",
			sourceThreadId: id(threadId),
			sourceItemId: item.id,
			item,
		}));

	const updatedAt = time(lastActivity);
	// One provider session with honest capabilities, so clients hide what pi cannot do instead of offering it and failing.
	const providerSessionId = `ps-${threadId}`;
	const providerSessions: OrchestrationV2ProviderSession[] = meta.subagentOf !== undefined ? [] : [
		{
			id: id(providerSessionId),
			driver: id(PROVIDER_DRIVER),
			providerInstanceId: id(PROVIDER_INSTANCE_ID),
			status: busy ? "running" : "ready",
			cwd: meta.cwd,
			model: meta.model === null ? null : modelSlug(meta.model),
			capabilities: PI_CAPABILITIES,
			createdAt: time(meta.createdAt),
			updatedAt: time(lastActivity),
			lastError: null,
		},
	];
	// A subagent's thread has no provider session or thread, like Claude's provider-native children (so "Disconnect agent session" is not offered).
	// Like T3, a thread gets its provider thread with its first run: until then it has none, and no active one.
	const providerThreads: OrchestrationV2ProviderThread[] = drafts.length === 0 || meta.subagentOf !== undefined ? [] : [
		{
			id: id(providerThreadId),
			driver: id(PROVIDER_DRIVER),
			providerInstanceId: id(PROVIDER_INSTANCE_ID),
			providerSessionId: id(providerSessionId),
			appThreadId: id(threadId),
			ownerNodeId: null,
			nativeThreadRef: null,
			nativeConversationHeadRef: null,
			status: busy ? "active" : "idle",
			firstRunOrdinal: drafts.length > 0 ? 1 : null,
			lastRunOrdinal: drafts.length > 0 ? drafts.length : null,
			handoffIds: [],
			forkedFrom: null,
			pendingBackgroundTasks: [],
			contextUsage: null,
			nativeMetadata: null,
			goal: null,
			createdAt: time(meta.createdAt),
			updatedAt,
		},
	];

	// A subagent's thread: provider-native, like Claude's Task children — `isProviderNativeSubagentThread` makes it read-only
	// in the web app and hides it from the sidebar (`makeSubagentChildThread`, packages/provider-core).
	const sub = meta.subagentOf;
	const lineage = () => ({
		parentThreadId: sub !== undefined ? id(sub.parentThreadId) : meta.parentThreadId === undefined ? null : id(meta.parentThreadId),
		relationshipToParent: sub !== undefined ? "subagent" : meta.parentThreadId === undefined ? null : "fork",
		rootThreadId: sub !== undefined ? id(sub.parentThreadId) : id(threadId),
	});
	const forkedFrom = () => (sub === undefined ? null : { type: "node", nodeId: id(sub.nodeId) });
	const author = sub === undefined ? ({ createdBy: "user", creationSource: "web" } as const) : ({ createdBy: "agent", creationSource: "provider" } as const);
	const thread: Any = {
		...author,
		id: id(threadId),
		projectId: id(meta.projectId),
		title: meta.title,
		titleRegeneration: meta.titleRegeneration == null ? null : { requestId: id(meta.titleRegeneration.requestId), startedAt: time(meta.titleRegeneration.startedAt) },
		providerInstanceId: id(PROVIDER_INSTANCE_ID),
		modelSelection,
		runtimeMode: "full-access",
		interactionMode: "default",
		branch: null,
		worktreePath,
		activeProviderThreadId: drafts.length === 0 || sub !== undefined ? null : id(providerThreadId),
		lineage: lineage(),
		forkedFrom: forkedFrom(),
		createdAt: time(meta.createdAt),
		updatedAt,
		archivedAt: null,
		settledOverride: null,
		settledAt: null,
		lastVisitedAt: null,
		deletedAt: null,
		...(memory.rollbackRequestId === undefined ? {} : { rollbackRequestId: id(memory.rollbackRequestId) }),
		...(memory.rollbackFailure === undefined ? {} : { rollbackFailure: memory.rollbackFailure }),
	};

	const projection: OrchestrationV2ThreadProjection = {
		thread,
		runs,
		attempts,
		nodes,
		subagents,
		providerSessions,
		providerThreads,
		providerTurns,
		runtimeRequests: [],
		messages,
		plans: [],
		turnItems,
		checkpointScopes,
		checkpoints,
		contextHandoffs: [],
		contextTransfers: [],
		visibleTurnItems,
		updatedAt,
	};

	const liveRuns = runs.filter((run) => run.status !== "rolled_back");
	const latestRun = liveRuns.at(-1);
	const activeRun = latestRun?.status === "running" ? latestRun : undefined;
	const lastVisibleMessage = messages.at(-1);
	const lastUser = messages.findLast((message) => message.role === "user");
	const shell: OrchestrationV2ThreadShell = {
		...author,
		id: id(threadId),
		projectId: id(meta.projectId),
		title: meta.title,
		titleRegeneration: meta.titleRegeneration == null ? null : { requestId: id(meta.titleRegeneration.requestId), startedAt: time(meta.titleRegeneration.startedAt) },
		providerInstanceId: id(PROVIDER_INSTANCE_ID),
		modelSelection,
		runtimeMode: "full-access",
		interactionMode: "default",
		branch: null,
		worktreePath,
		lineage: thread.lineage,
		forkedFrom: thread.forkedFrom,
		activeProviderThreadId: drafts.length === 0 || sub !== undefined ? null : id(providerThreadId),
		latestRunId: latestRun?.id ?? null,
		latestRunRequestedAt: latestRun?.requestedAt ?? null,
		latestRunStartedAt: latestRun?.startedAt ?? null,
		latestRunCompletedAt: latestRun?.completedAt ?? null,
		activeRunId: activeRun?.id ?? null,
		activityRunStartedAt: activeRun?.startedAt ?? null,
		activityRunStatus: activeRun === undefined ? null : "running",
		// T3's shell status is the latest run's status, and "idle" only for a thread that never ran (ProjectionStore.ts).
		status: busy ? "running" : (latestRun?.status ?? "idle"),
		pendingRuntimeRequest: null,
		latestVisibleMessage:
			lastVisibleMessage === undefined
				? null
				: {
						id: lastVisibleMessage.id,
						role: lastVisibleMessage.role,
						text: lastVisibleMessage.text.slice(0, 500),
						updatedAt: lastVisibleMessage.updatedAt,
					},
		latestUserMessageAt: lastUser?.createdAt ?? null,
		latestUserAuthoredMessageAt: lastUser?.createdAt ?? null,
		hasActionableProposedPlan: false,
		pendingBackgroundTasks: [],
		providerInstanceHistory: [id(PROVIDER_INSTANCE_ID)],
		itemCount: turnItems.length,
		visibleItemCount: visibleTurnItems.length,
		createdAt: time(meta.createdAt),
		updatedAt,
		archivedAt: null,
		settledOverride: null,
		settledAt: null,
		deletedAt: null,
	} as Any;

	return { projection, shell, runs: projectedRuns };
}
