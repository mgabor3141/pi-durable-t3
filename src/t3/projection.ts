// Pure mapping from a pi conversation (the head's `ConversationView` plus the thread's directory row) to T3's thread
// projection and shell: one user turn per run (`runs.ts`), one synthetic "ready" checkpoint per settled run plus a
// baseline (`undo.ts`'s ids), and an aborted assistant partial hidden when a later entry of the run supersedes it.
import { HTML_RENDER_MESSAGE, HTML_RENDER_TOOL_NAME } from "./html-render.ts";
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
import { type ContentBlock, type ConversationView, type LiveDoc, type DurableMessage, type EntryRecord, modelSlug, type ModelRef, thinkingOf as thinkingLevelOf, thinkingOption } from "./model-types.ts";
import { textOf } from "./thread-search.ts";
import { SCHEDULED_MESSAGE_ID } from "./scheduled-tasks.ts";
import { attachmentsOf, contextFromText, contextOf, firstMessage, groupRuns, htmlRenderOf, isAbortedToolResult, isAssistantEntry, isCompactCommandEntry, isNoteEntry, isUserEntry, messageIdOf, type RunDraft, stopReason, authorOf } from "./runs.ts";
import type { ThreadSummary } from "../threads.ts";
import { readQueuedInputs } from "./queued.ts";
import { BASELINE_CHECKPOINT_ID, type RolledBackRun } from "./undo.ts";
import { REQUEST_SECRET_TOOL } from "./secret-requests.ts";
import { DISPLAY_ONLY_RULE } from "./message-context.ts";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, MAX_TOOL_OUTPUT_IMAGES, readToolOutputImage } from "@t3tools/shared/toolOutput";

/** pi-durable's codemode tool (`CODEMODE_TOOL_NAME`): its one argument, `code`, is a JavaScript script. */
const CODEMODE_TOOL = "codemode";
/** The tool name T3's web app shows as JavaScript. */
const T3_JAVASCRIPT_TOOL = "js";
const HEADLINE_MAX = 200;

/**
 * A script's first line that says something: blank lines and codemode's `// @options` line are skipped. Null for a
 * script with none (T3 then labels the row "Run JavaScript").
 */
export function scriptHeadline(code: string): string | null {
	for (const line of code.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || /^\/\/\s*@options\b/u.test(trimmed)) continue;
		return trimmed.length > HEADLINE_MAX ? `${trimmed.slice(0, HEADLINE_MAX - 1)}…` : trimmed;
	}
	return null;
}

type LiveToolSlot = NonNullable<LiveDoc["tools"]>[number];

export const PROVIDER_INSTANCE_ID = "pi";
export const PROVIDER_DRIVER = "pi";
const BASELINE_SCOPE_ID = "cs-baseline";
/** T3's message on a Stop the user asked for (`RunExecutionService.USER_STOP_REASON`). */
const USER_STOP_REASON = "Stopped by user";

// biome-ignore lint/suspicious/noExplicitAny: branded IDs are plain strings on the wire
type Any = any;
const id = (value: string): Any => value;
/** Where a message ends: pi stamps an assistant message when its stream starts, and pi-ai's stream adds `durationMs`. */
const endOf = (message: { role?: string; timestamp?: number; durationMs?: number } | undefined, fallback: number): number =>
	(message?.timestamp ?? fallback) + (message?.role === "assistant" ? (message.durationMs ?? 0) : 0);
/** A DateTime is immutable, and a thread's instants repeat on every projection: one per instant. */
const instants = new Map<number, DateTime.Utc>();
const time = (ms: number | undefined): DateTime.Utc => {
	const at = ms ?? 0;
	let instant = instants.get(at);
	if (instant === undefined) {
		if (instants.size >= 50_000) instants.clear();
		instant = DateTime.makeUnsafe(at);
		instants.set(at, instant);
	}
	return instant;
};

/** A thread another started, as its parent shows it: what the parent's card reads from the child's own thread. */
export interface ChildCard {
	readonly threadId: string;
	readonly title: string;
	/** The message that started it. */
	readonly prompt: string;
	/** The parent's run that started it. */
	readonly parentRunId: string;
	readonly createdAt: number;
	readonly status: OrchestrationV2Subagent["status"];
	/** Its latest answer once it settled. */
	readonly result: string | null;
	readonly completedAt: number | null;
	readonly model: string | null;
}

/** The node of a child's card in its parent; the child's `forkedFrom` names it. */
export const childCardNodeId = (childThreadId: string): string => `nc-${childThreadId}`;

/** The id prefix of a message's context row (`messageContext`): a tool row no tool call made. */
const MESSAGE_CONTEXT_ITEM = "ti-x";
export const isMessageContextItem = (item: { readonly id: string }): boolean => item.id.startsWith(MESSAGE_CONTEXT_ITEM);

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
	/** The durable sidebar snapshot, used when the transcript is not loaded. */
	readonly summary?: ThreadSummary;
	/** The Session's model, for the thread's model selection. */
	readonly model: ModelRef | null;
	/** The Session's thinking level, reported back as the selection's `thinking` option. */
	readonly thinkingLevel?: string;
	/** The selected model's context window, for T3's context meter. */
	readonly contextWindow?: number;
	/** The thread record's creation fields, lineage and origin (`threads.ts`); a subagent's thread derives its own. */
	readonly createdBy?: "user" | "agent" | "system";
	readonly creationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
	readonly lineage?: { readonly parentThreadId: string | null; readonly relationshipToParent: "fork" | "subagent" | null; readonly rootThreadId: string };
	readonly forkedFrom?: { readonly type: "run"; readonly threadId: string; readonly runId: string } | { readonly type: "node"; readonly nodeId: string } | null;
	/** The threads this one started (`thread_prompt` with `new`), each shown as a card in the run that started it (T3's
	 * app-owned subagent: a real thread that takes messages). */
	readonly children?: readonly ChildCard[];
	readonly linkOrigin?: { readonly sessionId: string; readonly label: string; readonly access?: string };
	readonly delegatedFrom?: { readonly environmentId: string; readonly threadId: string; readonly title: string };
	/** T3's manual settlement, durable on the thread row. */
	readonly settledOverride?: "settled" | "active";
	readonly settledAt?: number;
	readonly unsettledAt?: number;
	/** T3's sidebar state from the thread record (`threads.ts`): pin, dragged place, read watermark, opens, auto-settle. */
	readonly pinnedAt?: number;
	readonly pinOrderKey?: string;
	readonly activeOrderKey?: string;
	readonly lastVisitedAt?: number;
	readonly opens?: { readonly openedAt: number; readonly score: number; readonly picks: readonly { readonly query: string; readonly at: number }[] };
	readonly autoSettleDisabledAt?: number;
	/** T3's thread tags, from the thread record. */
	readonly tags?: readonly string[];
	/** T3's archive and snooze, from the thread record. */
	readonly archivedAt?: number;
	readonly snoozedUntil?: number;
	readonly snoozedAt?: number;
	readonly lastSnoozeWakeAt?: number;
	/** Directory status, used when no transcript is loaded. */
	readonly running: boolean;
	/** A Stop of the running run: when it was asked for, and when the run was found not ending (T3's
	 * `run_interrupt_request`, which its clients show as "Stopping", then "Agent not responding to Stop"). */
	readonly stop?: { readonly requestedAt: number; readonly unresponsiveAt?: number };
	/** The last rollback asked of the thread and its failure, from the thread record. */
	readonly rollback?: { readonly requestId: string; readonly failure: string | null };
	/** T3's in-progress title generation (in memory only: none survives a restart). */
	readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: number } | null;
}

/** Bridge-side memory needed for a faithful projection. */
interface ThreadMemory {
	/** Runs removed by rewinds, kept as `rolled_back` so a client looking at a forked head reads them as history —
	 * load-bearing, not cosmetic (design.md, Invariants). */
	readonly rolledBack: readonly RolledBackRun[];
	/** Transcript before the active context's cut, for display only. Compaction keeps these entries on disk but drops
	 * them from the model context; without them the thread appears to start at the divider. They are never rewound. */
	readonly history?: readonly EntryRecord[];
}

interface ProjectedRun {
	readonly runId: string;
	readonly ordinal: number;
	/** Entry ID that anchors the run: a user prompt, or the compaction summary for a synthetic run. */
	readonly userEntryId: number;
	/** Entry ID of the run's last durable entry (the checkpoint's `ref`). */
	readonly lastEntryId: number;
	readonly status: OrchestrationV2Run["status"];
}

export interface ProjectionResult {
	readonly projection: OrchestrationV2ThreadProjection;
	readonly shell: OrchestrationV2ThreadShell;
	/** Runs with a user turn, which undo can fork before. */
	readonly runs: readonly ProjectedRun[];
	/** Every run a client can fork from, including a synthetic run anchored by a compaction summary. */
	readonly forkRuns: readonly ProjectedRun[];
	/** The images of each tool row that shows some, by item id, in the order of the row's image markers: what T3's
	 * `tool-output-image` asset serves. The projection itself carries only the markers. */
	readonly toolImages: ReadonlyMap<string, readonly ToolImage[]>;
}

/** An image a tool returned, as the model was given it. */
export interface ToolImage {
	readonly data: string;
	readonly mimeType: string;
}

/** The images of a tool result that T3 shows (`toolOutputImages`): a type it previews, within its size limit, at most
 * MAX_TOOL_OUTPUT_IMAGES. Read with T3's own reader, so an index here is the client's index. */
function toolImagesOf(content: ContentBlock[] | string | undefined): ToolImage[] {
	if (!Array.isArray(content)) return [];
	const images: ToolImage[] = [];
	for (const block of content) {
		const image = readToolOutputImage(block);
		if (image?.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) continue;
		images.push({ data: image.data, mimeType: image.mimeType });
		if (images.length === MAX_TOOL_OUTPUT_IMAGES) break;
	}
	return images;
}

/** A tool row's output with its images: T3's content blocks, the text and then one marker per image, without the data
 * (T3's own wire form, `omitToolOutputImageData`). Without images, the text as it was. */
function withImageMarkers(output: string | undefined, images: readonly ToolImage[]): unknown {
	if (images.length === 0) return output;
	return [...(output === undefined || output === "" ? [] : [{ type: "text", text: output }]), ...images.map((image) => ({ type: "image", mimeType: image.mimeType }))];
}

const thinkingOf = (content: ContentBlock[]): string =>
	content.flatMap((block) => (block.type === "thinking" ? [block.thinking] : [])).join("");


/** An html_render call's result without its page reference (its `message` stays): the published page is shown once,
 * from its own entry. */
function withoutHtmlRender(output: string): string {
	try {
		const parsed = JSON.parse(output) as Record<string, unknown>;
		if (typeof parsed !== "object" || parsed === null || !("htmlRender" in parsed)) return output;
		const { htmlRender: _shownByItsEntry, ...rest } = parsed;
		return JSON.stringify(rest);
	} catch {
		return output;
	}
}

/** Same model, and the same thinking level where both runs name one (an answer from before pi recorded the level names
 * none: comparing it would show a switch that did not happen). */
function sameModel(left: Any, right: Any): boolean {
	if (left?.model !== right?.model) return false;
	const a = thinkingLevelOf(left?.options);
	const b = thinkingLevelOf(right?.options);
	return a === undefined || b === undefined || a === b;
}

/**
 * T3's `modelSwitchSince`: a run's user message shows the model or effort change it brought, measured from the latest
 * run the timeline shows (not a rolled-back or queued run, a `/compact` command, or a run with no prompt of its own).
 */
function markModelSwitches(runs: readonly Any[], turnItems: Any[], drafts: readonly RunDraft[]): void {
	const userItems = new Map<string, Any>();
	for (const item of turnItems) if (item.type === "user_message" && item.inputIntent === "turn_start") userItems.set(String(item.messageId), item);
	const hidden = new Set(drafts.flatMap((draft) => (draft.synthetic === true || isCompactCommandEntry(draft.userEntry) ? [`r${draft.userEntry.id}`] : [])));
	let previous: Any;
	for (const run of runs) {
		if (run.status === "rolled_back" || run.status === "queued" || hidden.has(String(run.id))) continue;
		const item = userItems.get(String(run.userMessageId));
		if (item === undefined) continue;
		if (previous !== undefined && !sameModel(previous.modelSelection, run.modelSelection)) item.modelSwitch = { from: previous.modelSelection, to: run.modelSelection };
		previous = run;
	}
}

export function projectThread(
	meta: ThreadMeta,
	view: ConversationView | undefined,
	memory: ThreadMemory,
): ProjectionResult {
	const threadId = meta.threadId;
	const providerThreadId = `pt-${threadId}`;
	const live = view?.docs["pi.live"];
	const liveCompactions = ((live as { compactions?: readonly Any[] } | undefined)?.compactions ?? []);
	// The thread's selection, reported as the client named it: the model and the `thinking` level the conversation
	// carries. No model yet is the `"default"` slug, which answers no catalog entry (capabilities.md).
	const modelSelection: Any = {
		instanceId: PROVIDER_INSTANCE_ID,
		model: meta.model === null ? "default" : modelSlug(meta.model),
		...(meta.thinkingLevel === undefined ? {} : { options: thinkingOption(meta.thinkingLevel) }),
	};
	const history = memory.history ?? [];
	const transcript = [...history, ...(view?.entries ?? [])];
	const drafts = groupRuns(transcript);
	const compactionTokens = compactionTokenCounts(transcript);
	// A live manual compaction has a durable /compact user entry: the newest run, whose summary has not landed yet. Treat
	// that entry as its run, so T3 paints the compacting state with a real run id (its composer queues instead of
	// starting a parallel turn). An older /compact, long done, is not the run of a compaction that runs now.
	const manualCompaction = liveCompactions.find((compaction) => compactionTrigger(compaction) === "manual");
	const newestDraft = drafts.at(-1);
	const compactDraft = newestDraft !== undefined && isCompactCommandEntry(newestDraft.userEntry) && !newestDraft.steps.some(isCompactionEntry) ? newestDraft : undefined;
	const manualCompactionRunId = manualCompaction === undefined || compactDraft === undefined ? null : `r${compactDraft.userEntry.id}`;
	const busy = view === undefined ? meta.running : live?.run !== undefined || manualCompactionRunId !== null;
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
	const forkRuns: ProjectedRun[] = [];
	const toolImages = new Map<string, readonly ToolImage[]>();
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

	// A compaction is the context head. Its card is emitted where the cut is: after the history it replaces and
	// before the kept entries. It is normally runless; a manual `/compact` command owns it, so T3 can fold the command
	// and the card into one compaction row rather than showing both.
	const pushCompaction = (entry: EntryRecord, ordinal: number, runId: string | null = null): void => {
		const message = firstMessage(entry);
		const at = message?.timestamp ?? meta.createdAt;
		const summary = textOf(message?.role === "user" ? message.content : undefined);
		const tokens = compactionTokens.get(entry.id);
		turnItems.push({
			id: id(`ti-k${entry.id}`),
			threadId: id(threadId),
			runId: runId === null ? null : id(runId),
			nodeId: null,
			providerThreadId: id(providerThreadId),
			providerTurnId: null,
			nativeItemRef: null,
			parentItemId: null,
			ordinal,
			status: "completed",
			title: "Context compacted",
			startedAt: time(at),
			completedAt: time(at),
			updatedAt: time(at),
			type: "compaction",
			driver: id(PROVIDER_DRIVER),
			...(summary.length === 0 ? {} : { summary }),
			...(tokens?.before === undefined ? {} : { beforeTokenCount: tokens.before }),
			...(tokens?.after === undefined ? {} : { afterTokenCount: tokens.after }),
		} as Any);
	};

	drafts.forEach((draft, index) => {
		const ordinal = index + 1;
		const previous = index === 0 ? undefined : drafts[index - 1];
		const compactCardRunId = previous !== undefined && isCompactCommandEntry(previous.userEntry) ? `r${previous.userEntry.id}` : null;
		if (draft.card !== undefined) pushCompaction(draft.card, ordinal, compactCardRunId);
		if (draft.markerOnly === true) return;
		const isLast = index === drafts.length - 1;
		const synthetic = draft.synthetic === true;
		const u = draft.userEntry;
		const runId = `r${u.id}`;
		const nodeId = `n${u.id}`;
		const attemptId = `a${u.id}`;
		const turnId = `ptu${u.id}`;
		const userMessage = firstMessage(u)!;
		const anchorAt = userMessage.timestamp ?? meta.createdAt;
		// A synthetic run starts where its kept entries start: the compaction summary is only a marker, not a prompt.
		const firstStep = draft.steps[0];
		const requestedAt = synthetic ? (firstStep === undefined ? anchorAt : (firstMessage(firstStep)?.timestamp ?? anchorAt)) : anchorAt;
		const assistants = draft.steps.filter(isAssistantEntry);
		const lastAssistant = assistants.at(-1);
		const lastAssistantMessage = lastAssistant === undefined ? undefined : firstMessage(lastAssistant);
		const usage = lastAssistantMessage?.role === "assistant" ? lastAssistantMessage.usage : undefined;
		const running = isLast && busy;
		const compactCommand = isCompactCommandEntry(u);
		let status: OrchestrationV2Run["status"];
		if (running) status = "running";
		else if ((synthetic || compactCommand) && lastAssistant === undefined) status = "completed";
		else {
			const reason = stopReason(lastAssistant);
			status =
				reason === "stop" || reason === "length"
					? "completed"
					: reason === "error"
						? "failed"
						: "interrupted";
		}
		// A compaction card is not a place to fork at or a run's last message: the run's own last entry is.
		const lastEntry = draft.steps.findLast((step) => !isCompactionEntry(step)) ?? u;
		// The run ends where its last entry's message ends (`endOf`, the same value the assistant message and its item carry).
		const lastMessage = firstMessage(lastEntry);
		// Never before it was asked for: a message stamped earlier (a clock step, a reply made ahead) still ends the run then.
		const completedMs = running ? null : Math.max(requestedAt, endOf(lastMessage, requestedAt));
		lastActivity = Math.max(lastActivity, completedMs ?? requestedAt);
		// The run's model, read from the assistant message pi recorded for it (capabilities.md: no provider session to read).
		const runModel: Any = (() => {
			const m = lastAssistant === undefined ? undefined : firstMessage(lastAssistant);
			return m?.role === "assistant" && m.provider !== undefined && m.model !== undefined
				? { instanceId: PROVIDER_INSTANCE_ID, model: `${m.provider}/${m.model}`, ...(m.thinkingLevel === undefined ? {} : { options: thinkingOption(m.thinkingLevel) }) }
				: modelSelection;
		})();
		const settled = !running;
		// A synthetic run has no user turn to rewind to, so it carries no checkpoint (undo.ts maps checkpoints to prompts).
		// History runs do: a rewind into the transcript above a compaction is a real rewind, not display-only.
		const checkpointId = settled && !synthetic ? `cp${u.id}` : null;
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
			...(usage === undefined || meta.contextWindow === undefined || meta.contextWindow <= 0 ? {} : { tokenUsage: {
				usedTokens: usage.totalTokens,
				maxTokens: meta.contextWindow,
				inputTokens: usage.input,
				cachedInputTokens: usage.cacheRead,
				outputTokens: usage.output,
				...(usage.reasoning === undefined ? {} : { reasoningOutputTokens: usage.reasoning }),
				updatedAt: new Date(completedMs ?? requestedAt).toISOString(),
			} }),
		});
		if (!synthetic) {
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
		}
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
		const projectedRun = { runId, ordinal, userEntryId: u.id, lastEntryId: lastEntry.id, status };
		// A synthetic run has no user turn to rewind to, but its last entry is still a valid fork point.
		forkRuns.push(projectedRun);
		if (!synthetic) projectedRuns.push(projectedRun);

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
			// The compaction anchor is shown as the card, not as the summary in a bubble: report the prompt the clients
			// already know how to hide when the same run carries a compaction item (`/compact`).
			const anchor = synthetic && entry === u;
			const at = anchor ? requestedAt : (message.timestamp ?? requestedAt);
			const text = anchor ? "/compact" : textOf(message.role === "user" ? message.content : undefined);
			// The images the entry carries in its data (T3's `ChatImageAttachment`s) — shown on the message after a restart.
			const attachments = anchor ? [] : attachmentsOf(entry);
			// The composer records its text references resolve against. Older entries only kept the attachments; rebuild
			// the image/file bindings from the references so their inline labels do not render "(unavailable)".
			const context = anchor ? undefined : contextOf(entry) ?? contextFromText(text, attachments);
			// A scheduled task's message: T3 records the task on it, and the id the scheduler mints names the task.
			const scheduledTaskId = SCHEDULED_MESSAGE_ID.exec(messageId)?.[1];
			const scheduled = scheduledTaskId === undefined ? {} : { scheduledTaskId: id(scheduledTaskId) };
			// The thread a message came from (`thread_prompt`, a child's report): recorded on the entry with its author.
			const { senderThreadId, ...author } = authorOf(entry.data);
			const sender = senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) };
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
				...(context === undefined ? {} : { context }),
			} as Any);
			// The message's context (`messageContext`, such as recalled memories), shown as the tool row the integrator named,
			// so the user sees what the model was given with the message. No tool ran.
			const content = message.role === "user" && Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
			content.forEach((block, index) => {
				if (block.type !== "text" || block.shownAs === undefined) return;
				turnItems.push({
					...base(`${MESSAGE_CONTEXT_ITEM}${entry.id}.${index}`, at, "completed", true),
					title: block.shownAs.name,
					type: "dynamic_tool",
					toolName: block.shownAs.name,
					input: block.shownAs.input,
					output: block.shownAs.details === undefined ? block.text : `${block.text}\n\n${DISPLAY_ONLY_RULE}\n${block.shownAs.details}`,
				} as Any);
			});
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
				...(context === undefined ? {} : { context }),
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
				const images = resultMessage?.role === "toolResult" ? toolImagesOf(resultMessage.content) : [];
				if (images.length > 0) toolImages.set(`ti-t${block.id}`, images);
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
				// T3's secret card: the call is the request (`secret-requests.ts`). Its outcome is in the result's details; a
				// call still running waits for the user, and one that ended without a result was stopped.
				if (block.name === REQUEST_SECRET_TOOL) {
					const outcome = (resultMessage?.role === "toolResult" ? (resultMessage.details as { secretRequest?: { status?: string } } | undefined) : undefined)?.secretRequest?.status;
					const secretStatus = itemStatus === "running" ? "pending" : outcome === "saved" || outcome === "declined" ? outcome : "cancelled";
					const label = typeof block.arguments["label"] === "string" && block.arguments["label"].trim() !== "" ? block.arguments["label"].trim() : "Secret";
					turnItems.push({
						...common,
						title: label,
						type: "secret_request",
						label,
						reason: typeof block.arguments["reason"] === "string" ? block.arguments["reason"] : "",
						...(typeof block.arguments["placeholder"] === "string" ? { placeholder: block.arguments["placeholder"] } : {}),
						// T3's `file` delivery, for its note: the agent's commands can read the value, as they can here.
						delivery: "file",
						secretStatus,
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
				} else if (block.name === CODEMODE_TOOL && typeof block.arguments.code === "string") {
					// T3 shows a JavaScript tool (`js`, `isJavaScriptReplTool` in T3's shared toolActivity) with a code icon, its
					// title as the row's label, and its `code` highlighted as TypeScript; a script's first line is that label,
					// as a command's own text is a command row's.
					turnItems.push({
						...common,
						title: scriptHeadline(block.arguments.code),
						type: "dynamic_tool",
						toolName: T3_JAVASCRIPT_TOOL,
						input: { code: block.arguments.code },
						...(output === undefined && images.length === 0 ? {} : { output: withImageMarkers(output, images) }),
					} as Any);
				} else {
					// The model's own html_render call: its page is the `app.html-render` entry's item, so the call's output
					// must not name it too, or T3 would show the page twice.
					const shown = block.name === HTML_RENDER_TOOL_NAME && output !== undefined ? withoutHtmlRender(output) : output;
					turnItems.push({
						...common,
						title: block.name,
						type: "dynamic_tool",
						toolName: block.name,
						input: block.arguments,
						...(shown === undefined && images.length === 0 ? {} : { output: withImageMarkers(shown, images) }),
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

		// A synthetic run has no prompt to show: the card at the cut is its start. Emitting the summary as a
		// `/compact` user message would put it inside the run, where the fold and the compaction marker disagree.
		if (!synthetic) pushUser(u, "turn_start");
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
		// An assistant message is keyed by its run and its place among the run's assistant messages, not by its entry: the
		// message streaming now and the entry it is committed as are one item, so a client keeps updating the same record.
		let assistantIndex = 0;
		// The cards of the threads this run started, each placed before the first assistant message that began after it.
		const cards = (meta.children ?? []).filter((child) => child.parentRunId === runId).toSorted((left, right) => left.createdAt - right.createdAt);
		const pushCards = (before: number) => {
			while (cards.length > 0 && cards[0]!.createdAt < before) {
				const child = cards.shift()!;
				const cardNode = childCardNodeId(child.threadId);
				const settledCard = child.completedAt !== null;
				const startAt = time(child.createdAt);
				const endAt = settledCard ? time(child.completedAt!) : null;
				nodes.push({
					id: id(cardNode),
					threadId: id(threadId),
					runId: id(runId),
					parentNodeId: id(nodeId),
					rootNodeId: id(nodeId),
					kind: "subagent",
					status: child.status as OrchestrationV2ExecutionNode["status"],
					countsForRun: false,
					providerThreadId: null,
					providerTurnId: null,
					nativeItemRef: null,
					runtimeRequestId: null,
					checkpointScopeId: null,
					startedAt: startAt,
					completedAt: endAt,
				} as Any);
				const card = {
					origin: "app_owned",
					driver: id(PROVIDER_DRIVER),
					providerInstanceId: id(PROVIDER_INSTANCE_ID),
					childThreadId: id(child.threadId),
					prompt: child.prompt,
					result: child.result,
				};
				subagents.push({
					id: id(cardNode),
					threadId: id(threadId),
					runId: id(runId),
					parentNodeId: id(nodeId),
					createdBy: "agent",
					providerThreadId: null,
					nativeTaskRef: null,
					title: child.title,
					model: child.model,
					status: child.status,
					startedAt: startAt,
					completedAt: endAt,
					updatedAt: endAt ?? startAt,
					...card,
				} as Any);
				turnItems.push({
					...base(`ti-c${child.threadId}`, child.createdAt, child.status as OrchestrationV2TurnItem["status"], settledCard, child.completedAt ?? child.createdAt),
					nodeId: id(cardNode),
					title: child.title,
					type: "subagent",
					subagentId: id(cardNode),
					...card,
				} as Any);
			}
		};
		draft.steps.forEach((step, stepIndex) => {
			if (isUserEntry(step) || isNoteEntry(step)) {
				pushUser(step, "steer");
				return;
			}
			// A compaction that landed in this run: its card where it took effect, as T3 shows a provider's compaction.
			if (isCompactionEntry(step)) {
				pushCards(firstMessage(step)?.timestamp ?? requestedAt);
				pushCompaction(step, ordinal, runId);
				return;
			}
			// A published page: T3's html_render tool item, which its timeline shows inline (`htmlRenderFromToolItem`).
			const render = htmlRenderOf(step);
			if (render !== undefined) {
				const { createdAt, ...reference } = render;
				pushCards(createdAt);
				turnItems.push({
					...base(`ti-h${step.id}`, createdAt, "completed", true),
					title: HTML_RENDER_TOOL_NAME,
					type: "dynamic_tool",
					toolName: HTML_RENDER_TOOL_NAME,
					input: { title: reference.title, height: reference.height },
					output: JSON.stringify({ htmlRender: reference, message: HTML_RENDER_MESSAGE }),
				} as Any);
				return;
			}
			const m = firstMessage(step);
			if (m?.role !== "assistant") return;
			pushCards(m.timestamp ?? requestedAt);
			const key = `${u.id}.${assistantIndex++}`;
			// A partial interrupted by a crash is superseded by the resumed answer.
			const superseded = m.stopReason === "aborted" && draft.steps.slice(stepIndex + 1).some(isAssistantEntry);
			if (superseded) return;
			pushAssistant(key, m, m.timestamp ?? requestedAt, false, toolResults, liveTools);
		});
		const partial = running ? live?.generation?.message : undefined;
		if (partial?.role === "assistant") pushCards(partial.timestamp ?? Date.now());
		pushCards(Infinity);
		if (partial?.role === "assistant") {
			pushAssistant(
				`${u.id}.${assistantIndex}`,
				partial,
				partial.timestamp ?? Date.now(),
				true,
				toolResults,
				liveTools,
			);
		}
		// A Stop the run has not answered yet: its end removes this, as a run that ends removes T3's banner.
		const stop = running ? meta.stop : undefined;
		if (stop !== undefined) {
			turnItems.push({
				...base(`ti-stop${u.id}`, stop.requestedAt, "completed", true),
				providerTurnId: null,
				title: "Interrupt requested",
				type: "run_interrupt_request",
				message: USER_STOP_REASON,
				...(stop.unresponsiveAt === undefined ? {} : { unresponsiveAt: time(stop.unresponsiveAt) }),
			} as Any);
		}
	});

	markModelSwitches(runs, turnItems, drafts);

	// A live compaction is shown only while something waits for it, as T3 shows a provider's compaction: a manual one
	// (`/compact`, its own run; a reload still shows it) and a blocking one (the agent's next request waits for it, in
	// the agent's run). A background compaction runs while the agent keeps working, so it has no row until its summary
	// lands. The completed summary replaces this item where it lands.
	const agentRunId = live?.run !== undefined && newestDraft !== undefined ? `r${newestDraft.userEntry.id}` : null;
	const lastActivityAt = (draft: RunDraft | undefined): number => {
		const last = draft?.steps.findLast((step) => firstMessage(step)?.timestamp !== undefined) ?? draft?.userEntry;
		return (last === undefined ? undefined : firstMessage(last)?.timestamp) ?? meta.updatedAt;
	};
	let liveOrdinal = turnItems.reduce((max, item) => Math.max(max, item.ordinal ?? 0), 0) + 1;
	for (const compaction of liveCompactions) {
		const manual = compaction === manualCompaction;
		const runId = manual ? manualCompactionRunId : compaction.blocking === true ? agentRunId : null;
		if (runId === null && !manual) continue;
		// Stable across projections: when it was asked for (the /compact) or when the agent's run paused for it.
		const startedAt = manual && compactDraft !== undefined ? (firstMessage(compactDraft.userEntry)?.timestamp ?? meta.updatedAt) : lastActivityAt(newestDraft);
		turnItems.push({
			id: id(`ti-live-compaction-${compaction.taskId ?? liveOrdinal}`),
			threadId: id(threadId),
			runId: runId === null ? null : id(runId),
			nodeId: null,
			providerThreadId: id(providerThreadId),
			providerTurnId: null,
			nativeItemRef: null,
			parentItemId: null,
			ordinal: liveOrdinal++,
			status: "running",
			title: "Compacting context",
			startedAt: time(startedAt),
			completedAt: null,
			updatedAt: time(startedAt),
			type: "compaction",
			driver: id(PROVIDER_DRIVER),
		} as Any);
	}

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
			...(({ senderThreadId, ...written }) => ({ ...written, ...(senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) }) }))(authorOf(item.entry?.data)),
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

	// T3 numbers turn items in the order they enter the thread (`nextTurnItemOrdinal`), one ordinal per item: a client
	// places an item by it, and a bounded window's watermark is the newest ordinal. Items are built in that order.
	turnItems.forEach((item, index) => {
		(item as { ordinal: number }).ordinal = index + 1;
	});

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
		checkpoints.push(...rolled.checkpoints);
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
	const providerSessions: OrchestrationV2ProviderSession[] = [
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
	// Like T3, a thread gets its provider thread with its first run: until then it has none, and no active one.
	const providerThreads: OrchestrationV2ProviderThread[] = drafts.length === 0 ? [] : [
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

	const lineage = () => ({
		parentThreadId: meta.lineage?.parentThreadId == null ? null : id(meta.lineage.parentThreadId),
		relationshipToParent: meta.lineage?.relationshipToParent ?? null,
		rootThreadId: id(meta.lineage?.rootThreadId ?? threadId),
	});
	const forkedFrom = () =>
		meta.forkedFrom == null
			? null
			: meta.forkedFrom.type === "node"
				? { type: "node", nodeId: id(meta.forkedFrom.nodeId) }
				: { type: "run", threadId: id(meta.forkedFrom.threadId), runId: id(meta.forkedFrom.runId) };
	const author = { createdBy: meta.createdBy ?? "user", creationSource: meta.creationSource ?? "web" };
	// T3's sidebar state, on the thread and its shell alike.
	const sidebar = {
		pinnedAt: meta.pinnedAt === undefined ? null : time(meta.pinnedAt),
		pinOrderKey: meta.pinOrderKey ?? null,
		activeOrderKey: meta.activeOrderKey ?? null,
		autoSettleDisabledAt: meta.autoSettleDisabledAt === undefined ? null : time(meta.autoSettleDisabledAt),
		lastVisitedAt: meta.lastVisitedAt === undefined ? null : time(meta.lastVisitedAt),
		opens: meta.opens === undefined ? null : { openedAt: meta.opens.openedAt, score: meta.opens.score, picks: meta.opens.picks.map((pick) => ({ ...pick })) },
		// As T3's shell: only a thread that has tags carries them.
		...(meta.tags === undefined || meta.tags.length === 0 ? {} : { tags: [...meta.tags] }),
		archivedAt: meta.archivedAt === undefined ? null : time(meta.archivedAt),
		snoozedUntil: meta.snoozedUntil === undefined ? null : time(meta.snoozedUntil),
		snoozedAt: meta.snoozedAt === undefined ? null : time(meta.snoozedAt),
	};
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
		activeProviderThreadId: drafts.length === 0 ? null : id(providerThreadId),
		lineage: lineage(),
		forkedFrom: forkedFrom(),
		...(meta.linkOrigin === undefined ? {} : { linkOrigin: meta.linkOrigin }),
		...(meta.delegatedFrom === undefined ? {} : { delegatedFrom: { ...meta.delegatedFrom, environmentId: id(meta.delegatedFrom.environmentId), threadId: id(meta.delegatedFrom.threadId) } }),
		createdAt: time(meta.createdAt),
		updatedAt,
		settledOverride: meta.settledOverride ?? null,
		settledAt: meta.settledAt === undefined ? null : time(meta.settledAt),
		...(meta.unsettledAt === undefined ? {} : { unsettledAt: time(meta.unsettledAt) }),
		...sidebar,
		lastSnoozeWakeAt: meta.lastSnoozeWakeAt === undefined ? null : time(meta.lastSnoozeWakeAt),
		deletedAt: null,
		...(meta.rollback === undefined
			? {}
			: {
					rollbackRequestId: id(meta.rollback.requestId),
					rollbackFailure: meta.rollback.failure === null ? null : { requestId: id(meta.rollback.requestId), message: meta.rollback.failure },
				}),
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
	const activeRun = liveRuns.findLast((run) => run.status === "running");
	const lastVisibleMessage = messages.at(-1);
	const lastUser = messages.findLast((message) => message.role === "user");
	const lastUserAuthored = messages.findLast((message) => message.role === "user" && ((message as Any).createdBy ?? "user") === "user");
	// Not loaded: the latest run the summary kept, so a closed thread sorts and shows its state as an open one does.
	const keptRun = view === undefined ? (meta.summary?.latestRun ?? null) : null;
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
		activeProviderThreadId: drafts.length === 0 ? null : id(providerThreadId),
		latestRunId: latestRun?.id ?? (keptRun === null ? null : id(keptRun.id)),
		latestRunRequestedAt: latestRun?.requestedAt ?? (keptRun === null ? null : time(keptRun.requestedAt)),
		latestRunStartedAt: latestRun?.startedAt ?? (keptRun?.startedAt == null ? null : time(keptRun.startedAt)),
		latestRunCompletedAt: latestRun?.completedAt ?? (keptRun?.completedAt == null ? null : time(keptRun.completedAt)),
		activeRunId: activeRun?.id ?? null,
		activityRunStartedAt: activeRun?.startedAt ?? null,
		activityRunStatus: activeRun === undefined ? null : "running",
		// T3's shell status is the latest run's status, and "idle" only for a thread that never ran (ProjectionStore.ts).
		status: busy ? "running" : (latestRun?.status ?? keptRun?.status ?? "idle"),
		pendingRuntimeRequest: null,
		latestVisibleMessage:
			lastVisibleMessage === undefined
				? (meta.summary?.latestVisibleMessage === null || meta.summary?.latestVisibleMessage === undefined
					? null
					: {
							id: meta.summary.latestVisibleMessage.id,
							role: meta.summary.latestVisibleMessage.role,
							text: meta.summary.latestVisibleMessage.text.slice(0, 500),
							updatedAt: time(meta.summary.latestVisibleMessage.updatedAt),
						})
				: {
						id: lastVisibleMessage.id,
						role: lastVisibleMessage.role,
						text: lastVisibleMessage.text.slice(0, 500),
						updatedAt: lastVisibleMessage.updatedAt,
					},
		latestUserMessageAt: lastUser?.createdAt ?? (meta.summary?.latestUserMessageAt == null ? null : time(meta.summary.latestUserMessageAt)),
		// Only what a person wrote: an agent's prompt or a child's report is a user-role message too (T3's field excludes them).
		latestUserAuthoredMessageAt: (() => {
			if (view !== undefined) return lastUserAuthored?.createdAt ?? null;
			const at = meta.summary?.latestUserAuthoredMessageAt === undefined ? meta.summary?.latestUserMessageAt : meta.summary.latestUserAuthoredMessageAt;
			return at == null ? null : time(at);
		})(),
		hasActionableProposedPlan: false,
		pendingBackgroundTasks: [],
		providerInstanceHistory: [id(PROVIDER_INSTANCE_ID)],
		itemCount: meta.summary === undefined || view !== undefined ? turnItems.length : meta.summary.itemCount,
		visibleItemCount: meta.summary === undefined || view !== undefined ? visibleTurnItems.length : meta.summary.visibleItemCount,
		createdAt: time(meta.createdAt),
		updatedAt,
		settledOverride: meta.settledOverride ?? null,
		settledAt: meta.settledAt === undefined ? null : time(meta.settledAt),
		...(meta.unsettledAt === undefined ? {} : { unsettledAt: time(meta.unsettledAt) }),
		...sidebar,
		deletedAt: null,
	} as Any;

	return { projection, shell, runs: projectedRuns, forkRuns, toolImages };
}

/** A compaction summary entry: shown as T3's compaction card where it landed. */
function isCompactionEntry(entry: EntryRecord): boolean {
	return entry.kind === "pi.compaction";
}

/** Why a live compaction runs, as pi-durable records it in `pi.live` (`manual`, `threshold`, `overflow`). */
function compactionTrigger(compaction: Any): string | undefined {
	return typeof compaction?.trigger === "string" ? compaction.trigger : undefined;
}

/**
 * The context size before and after each compaction, as T3's card shows it ("Context compacted 183k → 41k tokens"):
 * before, what the last request before the summary used (its input, cache and answer); after, what the first request
 * after it sent. A request without usage (one that failed) does not count. Each is absent until there is such a request.
 */
export function compactionTokenCounts(entries: readonly EntryRecord[]): Map<EntryRecord["id"], { before?: number; after?: number }> {
	const counts = new Map<EntryRecord["id"], { before?: number; after?: number }>();
	let lastContext: number | undefined;
	let waiting: { before?: number; after?: number }[] = [];
	for (const entry of entries) {
		if (isCompactionEntry(entry)) {
			const count: { before?: number; after?: number } = lastContext === undefined ? {} : { before: lastContext };
			counts.set(entry.id, count);
			waiting.push(count);
			continue;
		}
		const message = firstMessage(entry);
		if (message?.role !== "assistant") continue;
		const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
		const sent = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
		if (sent <= 0) continue;
		for (const count of waiting) count.after = sent;
		waiting = [];
		lastContext = sent + (usage?.output ?? 0);
	}
	return counts;
}
