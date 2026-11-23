// Pure mapping from a pi conversation (the head's `ConversationView` plus the thread's directory row) to T3's thread
// projection and shell: one user turn per run (`runs.ts`), one synthetic "ready" checkpoint per settled run plus a
// baseline (`undo.ts`'s ids), and an aborted assistant partial hidden when a later entry of the run supersedes it.
import { HTML_RENDER_MESSAGE, HTML_RENDER_TOOL_NAME, type HtmlRenderReference } from "./html-render.ts";
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
import { idleCompactionOf } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { PI_CAPABILITIES } from "./capabilities.ts";
import { type ContentBlock, type ConversationView, type LiveDoc, type DurableMessage, type EntryRecord, modelSlug, type ModelRef, thinkingOf as thinkingLevelOf, thinkingOption } from "./model-types.ts";
import { textOf } from "./thread-search.ts";
import { SCHEDULED_MESSAGE_ID } from "./scheduled-tasks.ts";
import { APP_CONTINUE_ENTRY, APP_UNREAD_STEER_ENTRY, attachmentsOf, contextFromText, contextOf, firstMessage, groupRuns, htmlRenderOf, isAbortedToolResult, isAssistantEntry, isCompactCommandEntry, isNoteEntry, isUserEntry, messageIdOf, type RunDraft, sentAs, stopReason, authorOf, unreadSteerOf } from "./runs.ts";
import type { ThreadSummary } from "../threads.ts";
import { readQueuedInputs } from "./queued.ts";
import { type Answers, ASK_USER_TOOL, userInputQuestions, userInputRequestId } from "./user-input.ts";
import type { ShownApproval } from "./approvals.ts";
import { BASELINE_CHECKPOINT_ID, type RolledBackRun } from "./undo.ts";
import { type ImageAt, omittedImage } from "./image-data.ts";
import { REQUEST_SECRET_TOOL } from "./secret-requests.ts";
import { DISPLAY_ONLY_RULE } from "./message-context.ts";
import { contextEdits as messageContextEdits } from "./message-contexts.ts";
import { type SectionChange, systemPromptUpdates, updateDetails, updateTitle } from "./prompt-updates.ts";
import { sentTokens, sizeAfterCompaction } from "./context-size.ts";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH, MAX_TOOL_OUTPUT_IMAGES, readToolOutputImage } from "@t3tools/shared/toolOutput";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

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
/**
 * When the prompt cache a request wrote expires (T3's `promptCacheTtlMs` and `promptCacheExpiresAt`): the provider
 * says which lifetime it wrote (Anthropic's one-hour tokens, or the short default), the model how long each is, and the
 * lifetime starts with the request. A request that wrote nothing reports none.
 */
function promptCacheOf(usage: { cacheWrite?: number; cacheWrite1h?: number }, requestedAt: number | undefined, lifetimes: { readonly short?: number; readonly long?: number } | undefined): { promptCacheTtlMs?: number; promptCacheExpiresAt?: string } {
	const seconds = (usage.cacheWrite1h ?? 0) > 0 ? lifetimes?.long : (usage.cacheWrite ?? 0) > 0 ? lifetimes?.short : undefined;
	if (seconds === undefined || seconds <= 0) return {};
	return { promptCacheTtlMs: seconds * 1000, ...(requestedAt === undefined ? {} : { promptCacheExpiresAt: new Date(requestedAt + seconds * 1000).toISOString() }) };
}

/** Where a message ends: pi stamps an assistant message when its stream starts, and pi-ai's stream adds `durationMs`. */
const endOf = (message: { role?: string; timestamp?: number; durationMs?: number } | undefined, fallback: number): number =>
	(message?.timestamp ?? fallback) + (message?.role === "assistant" ? (message.durationMs ?? 0) : 0);
/**
 * T3's class for a failed request, from pi's error text. A 429 is T3's `usage_limit` (its Claude adapter classes every
 * 429 so): T3 shows it as a warning, "Usage limit reached".
 */
const failureClass = (message: string): "usage_limit" | "provider_error" =>
	/(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|usage.?limit|too many requests/i.test(message) ? "usage_limit" : "provider_error";
/**
 * How long a provider asked to wait before a request is sent again, when pi would not wait that long inside the
 * request: pi-ai then fails the request and says so in its error ("Server requested 6514s retry delay (max: 60s). …").
 * The only place the provider's `retry-after` reaches us.
 */
export const requestedRetryDelayMs = (error: string | undefined): number | undefined => {
	const seconds = /Server requested (\d+)s retry delay/u.exec(error ?? "")?.[1];
	return seconds === undefined ? undefined : Number(seconds) * 1_000;
};
/** When the provider's limit resets, by a failed request's own account: its time plus the wait the provider asked for. */
export const limitResetAt = (message: { readonly errorMessage?: string; readonly timestamp?: number }): number | undefined => {
	const delay = requestedRetryDelayMs(message.errorMessage);
	return delay === undefined || message.timestamp === undefined ? undefined : message.timestamp + delay;
};
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
export const MESSAGE_CONTEXT_ITEM = "ti-x";
export const isMessageContextItem = (item: { readonly id: string }): boolean => item.id.startsWith(MESSAGE_CONTEXT_ITEM);

/**
 * A command the host answered itself, shown in the thread and nowhere else: not an entry of the conversation, so the
 * model is never sent it, and gone when the host restarts. The command is the user's message as T3 sent it; T3 keeps
 * its own copy of a sent message on screen until the server shows that message, so it must be shown. It stands in the
 * latest of the thread's runs that had begun when it was answered, as a note does (T3 has no place for a user's message
 * outside a run): found by the newest entry there was then, so that an undo, which changes the runs, leaves it
 * standing in a run that is still there. With no such run (an undo that emptied the thread) only the answer is shown.
 * The answer is a message of no run, which T3 shows as a reply where its time puts it. Without a `command` (what the
 * host has to say after T3's own Revert, which sends no message) there is only the answer.
 */
export interface ShownExchange {
	readonly messageId: string;
	readonly command?: string;
	readonly answer: string;
	/** A page shown above the answer (`/tree`), as `html_render` shows one. */
	readonly htmlRender?: HtmlRenderReference;
	readonly at: number;
	/** The newest entry the thread had when the command was answered; none: -1. */
	readonly after: number;
}

/** The id prefix of a shown exchange's answer: a message no entry holds. */
const SHOWN_MESSAGE = "shown-";

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
	/** How many times the harness sends a failed request again (its `settings.retry.maxRetries`), for the retry row's
	 * "3/64". Absent, the row shows the count alone. */
	readonly maxRetries?: number;
	/** The host's words for a change of its system prompt, for the row that says so (`BridgeConfig.promptUpdateTitle`). */
	readonly promptUpdateTitle?: (changes: readonly SectionChange[]) => string | undefined;
	/** The Session's thinking level, reported back as the selection's `thinking` option. */
	readonly thinkingLevel?: string;
	/** The selected model's context window, for T3's context meter. */
	readonly contextWindow?: number;
	/** How long the selected model's provider keeps a prompt cache entry, in seconds (`CatalogEntry.promptCache`). */
	readonly promptCache?: { readonly short?: number; readonly long?: number };
	/** The thread record's creation fields, lineage and origin (`threads.ts`); a subagent's thread derives its own. */
	readonly createdBy?: "user" | "agent" | "system";
	readonly creationSource?: "web" | "mobile" | "mcp" | "provider" | "server";
	readonly lineage?: { readonly parentThreadId: string | null; readonly relationshipToParent: "fork" | "subagent" | null; readonly rootThreadId: string; readonly sideChat?: true };
	/** A side chat's fork entry: only the entries after it are shown (T3: a side chat shows only its own rows). */
	readonly forkEntryId?: number;
	readonly forkedFrom?: { readonly type: "run"; readonly threadId: string; readonly runId: string } | { readonly type: "node"; readonly nodeId: string } | null;
	/** The threads this one started (`thread_prompt` with `new`), each shown as a card in the run that started it (T3's
	 * app-owned subagent: a real thread that takes messages). */
	readonly children?: readonly ChildCard[];
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
	/** T3's limit recovery, from the thread record: the run a provider's limit ended, when the limit resets, and whether
	 * the host continues the run then. Shown while that run is still the thread's last. */
	readonly limitRecovery?: { readonly runId: string; readonly resetAt: number; readonly autoResume: boolean; readonly snooze?: boolean };
	/** Message contexts a request was sent with whose edit is not placed yet, by the message's entry
	 * (`message-contexts.ts`): shown meanwhile. In memory only. */
	readonly pendingContexts?: ReadonlyMap<number, ContentBlock>;
	/** Commands answered on the spot (`/context`): shown in the thread, in memory only (`ShownExchange`). */
	readonly shown?: readonly ShownExchange[];
	/** The approvals a host's gates asked for (`approvals.ts`): waiting (the parked calls'), or how they ended (in memory only). */
	readonly approvals?: readonly ShownApproval[];
	/** T3's in-progress title generation (in memory only: none survives a restart). */
	readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: number } | null;
	/** T3's `lastTitleRegeneration`: how the last "regenerate" ended (in memory, as the request is). */
	readonly lastTitleRegeneration?: { readonly status: "renamed" | "unchanged" | "failed"; readonly message?: string; readonly requestId: string; readonly completedAt: number } | null;
}

/** Bridge-side memory needed for a faithful projection. */
interface ThreadMemory {
	/** Runs removed by rewinds, kept as `rolled_back` so a client looking at a forked head reads them as history —
	 * load-bearing, not cosmetic (design.md, Invariants). */
	readonly rolledBack: readonly RolledBackRun[];
	/** Transcript before the active context's cut, for display only. Compaction keeps these entries on disk but drops
	 * them from the model context; without them the thread appears to start at the divider. They are never rewound. */
	readonly history?: readonly EntryRecord[];
	/** The ordinals this view of the thread has given its rows (`TurnItemOrdinals`); absent, rows are numbered by place. */
	readonly ordinals?: TurnItemOrdinals;
}

/**
 * The ordinal each turn item was given, kept by whoever projects a thread again and again (a `ThreadView`). T3 numbers
 * items as they enter a thread and never reuses a number, and its client relies on that: holding the newest rows of
 * a long thread, it takes a new row whose ordinal is not above the highest it has seen for history it has not loaded,
 * and drops it. Rows go away here (an undo, a queued message that is placed), so numbering by place would hand a new
 * row a number a client has seen. So a row keeps its ordinal, and a new one is above every ordinal given before.
 */
export type TurnItemOrdinals = { readonly byId: Map<string, number>; high: number };

/** Number `items`, which are in the order the thread shows them: rising, each row's own where that still fits. */
function numberTurnItems(items: readonly OrchestrationV2TurnItem[], ordinals: TurnItemOrdinals | undefined): void {
	let last = 0;
	items.forEach((item, index) => {
		const kept = ordinals?.byId.get(item.id as string);
		// A row that is new, or that now stands after one numbered above it, is numbered anew.
		const ordinal = ordinals === undefined ? index + 1 : kept !== undefined && kept > last ? kept : Math.max(last, ordinals.high) + 1;
		(item as { ordinal: number }).ordinal = ordinal;
		last = ordinal;
		if (ordinals === undefined) return;
		ordinals.byId.set(item.id as string, ordinal);
		ordinals.high = Math.max(ordinals.high, ordinal);
	});
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

/** An image a tool returned, as the model was given it: its data, or where the store has it (`image-data.ts`). */
export interface ToolImage {
	readonly data?: string;
	readonly at?: ImageAt;
	readonly mimeType: string;
}

/** The images of a tool result that T3 shows (`toolOutputImages`): a type it previews, within its size limit, at most
 * MAX_TOOL_OUTPUT_IMAGES. Read with T3's own reader, so an index here is the client's index. */
function toolImagesOf(content: ContentBlock[] | string | undefined): ToolImage[] {
	if (!Array.isArray(content)) return [];
	const images: ToolImage[] = [];
	for (const block of content) {
		const image = readToolOutputImage(block);
		const at = omittedImage(block);
		const length = at?.length ?? image?.data?.length;
		if (image === null || length === undefined || length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) continue;
		images.push(at === undefined ? { data: image.data!, mimeType: image.mimeType } : { at, mimeType: image.mimeType });
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

/** What a thread's projection is built from, and the rows it is built into: `begin` makes it, each part adds to it. */
type Build = ReturnType<typeof begin> & { lastActivity: number };

function begin(meta: ThreadMeta, view: ConversationView | undefined, memory: ThreadMemory) {
	const threadId = meta.threadId;
	const providerThreadId = `pt-${threadId}`;
	const live = view?.docs["pi.live"];
	const liveCompactions = live?.compactions ?? [];
	// The thread's selection, reported as the client named it: the model and the `thinking` level the conversation
	// carries. No model yet is the `"default"` slug, which answers no catalog entry (capabilities.md).
	const modelSelection: Any = {
		instanceId: PROVIDER_INSTANCE_ID,
		model: meta.model === null ? "default" : modelSlug(meta.model),
		...(meta.thinkingLevel === undefined ? {} : { options: thinkingOption(meta.thinkingLevel) }),
	};
	const history = memory.history ?? [];
	// A side chat shows only its own rows: what it inherited reaches the model, and T3 links the main thread instead.
	const transcript = [...history, ...(view?.entries ?? [])].filter((entry) => meta.forkEntryId === undefined || entry.id > meta.forkEntryId);
	const drafts = groupRuns(transcript);
	// What is left after the newest compaction, estimated until a request measures it: the meter's size and the card's.
	const sizeAfter = sizeAfterCompaction(transcript);
	const compactionTokens = compactionTokenCounts(transcript, sizeAfter);
	const contextEdits = messageContextEdits(transcript);
	const promptUpdates = systemPromptUpdates(transcript);
	// A live manual compaction has a durable /compact user entry: the newest run, whose summary has not landed yet. Treat
	// that entry as its run, so T3 paints the compacting state with a real run id (its composer queues instead of
	// starting a parallel turn). An older /compact, long done, is not the run of a compaction that runs now.
	const manualCompaction = liveCompactions.find((compaction) => compaction.trigger === "manual");
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
	/** The questions the agent asked (`ask_user`): T3 reads a card's state from its runtime request. */
	const runtimeRequests: OrchestrationV2ThreadProjection["runtimeRequests"][number][] = [];
	/** Messages of commands the host answered itself (`ShownExchange`): shown, and not the thread's own. */
	const shownIds = new Set<string>();
	const subagents: OrchestrationV2Subagent[] = [];
	const checkpointScopes: OrchestrationV2CheckpointScope[] = [];
	const checkpoints: OrchestrationV2Checkpoint[] = [];
	const projectedRuns: ProjectedRun[] = [];
	const forkRuns: ProjectedRun[] = [];
	const toolImages = new Map<string, readonly ToolImage[]>();
	const lastActivity = meta.updatedAt;
	return { meta, view, memory, threadId, providerThreadId, live, liveCompactions, modelSelection, transcript, drafts, sizeAfter, compactionTokens, contextEdits, promptUpdates, manualCompaction, newestDraft, compactDraft, manualCompactionRunId, busy, worktreePath, runs, attempts, nodes, providerTurns, messages, turnItems, runtimeRequests, shownIds, subagents, checkpointScopes, checkpoints, projectedRuns, forkRuns, toolImages, lastActivity };
}

function pushBaseline(b: Build): void {
	const { meta, threadId, providerThreadId, nodes, checkpointScopes, checkpoints } = b;
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
}

// A compaction is the context head. Its card is emitted where the cut is: after the history it replaces and
// before the kept entries. It is normally runless; a manual `/compact` command owns it, so T3 can fold the command
// and the card into one compaction row rather than showing both.
function pushCompaction(b: Build, entry: EntryRecord, runId: string | null = null): void {
	const { meta, threadId, providerThreadId, compactionTokens, turnItems } = b;
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
		// Numbered with every other turn item in `projectRows` (`numberTurnItems`).
		ordinal: 0,
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
}

// Where each answered command stands (`ShownExchange`): the latest run a user's message began, begun by then.
function shownAnswer(b: Build, shown: ShownExchange): void {
	const { threadId, providerThreadId, messages, turnItems, shownIds } = b;
	const answerId = `${SHOWN_MESSAGE}${shown.messageId}`;
	const at = shown.at + 1;
	if (shown.htmlRender !== undefined) {
		const reference = shown.htmlRender;
		turnItems.push({ id: id(`ti-shown-h${shown.messageId}`), threadId: id(threadId), runId: null, nodeId: null, providerThreadId: id(providerThreadId), providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 0, status: "completed", title: HTML_RENDER_TOOL_NAME, startedAt: time(at), completedAt: time(at), updatedAt: time(at), type: "dynamic_tool", toolName: HTML_RENDER_TOOL_NAME, input: { title: reference.title, height: reference.height }, output: JSON.stringify({ htmlRender: reference, message: HTML_RENDER_MESSAGE }) } as Any);
	}
	turnItems.push({ id: id(`ti-shown-a${shown.messageId}`), threadId: id(threadId), runId: null, nodeId: null, providerThreadId: id(providerThreadId), providerTurnId: null, nativeItemRef: null, parentItemId: null, ordinal: 0, status: "completed", title: null, startedAt: time(at), completedAt: time(at), updatedAt: time(at), type: "assistant_message", messageId: id(answerId), text: shown.answer, streaming: false } as Any);
	messages.push({ createdBy: "system", creationSource: "server", id: id(answerId), threadId: id(threadId), runId: null, nodeId: null, role: "assistant", text: shown.answer, attachments: [], streaming: false, createdAt: time(at), updatedAt: time(at) } as Any);
	shownIds.add(answerId);
	// T3 takes a sent message as received when the thread's run or its update time changes: no run does here.
	b.lastActivity = Math.max(b.lastActivity, at);
}

/** The run something the host shows stands in (`ShownExchange`, `ShownApproval`): the latest a user's message began
 * by the entry it stands after. */
const shownDraft = (b: Build, after: number): RunDraft | undefined =>
	b.drafts.findLast((candidate) => candidate.synthetic !== true && isUserEntry(candidate.userEntry) && candidate.userEntry.id <= after);

/** One run: its rows, then its turn items in the order they happened. A draft that is only a compaction card has neither. */
function projectRun(b: Build, shownIn: ReadonlyMap<RunDraft, ShownExchange[]>, draft: RunDraft, index: number): void {
	const { drafts } = b;
	const previous = index === 0 ? undefined : drafts[index - 1];
	const compactCardRunId = previous !== undefined && isCompactCommandEntry(previous.userEntry) ? `r${previous.userEntry.id}` : null;
	if (draft.card !== undefined) pushCompaction(b, draft.card, compactCardRunId);
	if (draft.markerOnly === true) return;
	projectRunItems(b, shownIn, draft, projectRunRows(b, draft, index));
}

/** A run's rows: the run, its attempt, node, provider turn (with the usage of its last request) and checkpoint. */
function projectRunRows(b: Build, draft: RunDraft, index: number) {
	const { meta, threadId, providerThreadId, modelSelection, drafts, busy, runs, attempts, nodes, providerTurns, checkpointScopes, checkpoints, projectedRuns, forkRuns } = b;
	const ordinal = index + 1;
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
	// The usage T3's context meter reads: the last request that was counted. One that failed has zeros, and would
	// show an empty context.
	const lastAssistantMessage = assistants.map((entry) => firstMessage(entry)).findLast((message) => message?.role === "assistant" && sentTokens(message.usage) > 0);
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
	// Nor is a steer Stop found unread, written once the run had ended.
	const lastEntry = draft.steps.findLast((step) => !isCompactionEntry(step) && step.kind !== APP_UNREAD_STEER_ENTRY) ?? u;
	// The run ends where its last entry's message ends (`endOf`, the same value the assistant message and its item carry).
	const lastMessage = firstMessage(lastEntry);
	// Never before it was asked for: a message stamped earlier (a clock step, a reply made ahead) still ends the run then.
	const completedMs = running ? null : Math.max(requestedAt, endOf(lastMessage, requestedAt));
	b.lastActivity = Math.max(b.lastActivity, completedMs ?? requestedAt);
	// The run's model, read from the assistant message pi recorded for it (capabilities.md: no provider session to read).
	const runModel: Any = (() => {
		const m = lastAssistant === undefined ? undefined : firstMessage(lastAssistant);
		return m?.role === "assistant" && m.provider !== undefined && m.model !== undefined
			? { instanceId: PROVIDER_INSTANCE_ID, model: `${m.provider}/${m.model}`, ...(m.thinkingLevel === undefined ? {} : { options: thinkingOption(m.thinkingLevel) }) }
			: modelSelection;
	})();
	// A synthetic run has no user turn to rewind to, so it carries no checkpoint (undo.ts maps checkpoints to prompts).
	// History runs do: a rewind into the transcript above a compaction is a real rewind, not display-only.
	const checkpointId = !running && !synthetic ? `cp${u.id}` : null;
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
	attempts.push({
		id: id(attemptId),
		runId: id(runId),
		attemptOrdinal: 1,
		rootNodeId: id(nodeId),
		providerInstanceId: id(PROVIDER_INSTANCE_ID),
		providerThreadId: id(providerThreadId),
		providerTurnId: id(turnId),
		reason: "initial",
		status: status as OrchestrationV2RunAttempt["status"],
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
		status: status as OrchestrationV2ProviderTurn["status"],
		startedAt: time(requestedAt),
		completedAt: completedMs === null ? null : time(completedMs),
		...(usage === undefined || meta.contextWindow === undefined || meta.contextWindow <= 0 ? {} : { tokenUsage: {
			usedTokens: usage.totalTokens,
			maxTokens: meta.contextWindow,
			inputTokens: usage.input,
			cachedInputTokens: usage.cacheRead,
			outputTokens: usage.output,
			...(usage.reasoning === undefined ? {} : { reasoningOutputTokens: usage.reasoning }),
			...promptCacheOf(usage, lastAssistantMessage?.timestamp, meta.promptCache),
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
	return { synthetic, u, runId, nodeId, turnId, requestedAt, running };
}

/** A run's turn items: the user's message, each response with its tool calls, failed requests, child cards, steers, and what is still streaming. */
function projectRunItems(b: Build, shownIn: ReadonlyMap<RunDraft, ShownExchange[]>, draft: RunDraft, r: ReturnType<typeof projectRunRows>): void {
	const { meta, threadId, providerThreadId, live, nodes, messages, turnItems, shownIds, subagents, toolImages, runtimeRequests } = b;
	/** A request of the user is activity of the thread, in the middle of a run too: T3's `updatedAt` moves with every
	 * event, and a client that shows the thread visits it at each move (`threadVisits.ts`), which says that its user
	 * has the request before them (`user-notifications.ts`). */
	const asked = (at: number): void => {
		b.lastActivity = Math.max(b.lastActivity, at);
	};
	const { synthetic, u, runId, nodeId, turnId, requestedAt, running } = r;
	const base = (itemId: string, at: number, itemStatus: OrchestrationV2TurnItem["status"], done: boolean, end = at) => ({
		id: id(itemId),
		threadId: id(threadId),
		runId: id(runId),
		nodeId: id(nodeId),
		providerThreadId: id(providerThreadId),
		providerTurnId: id(turnId),
		nativeItemRef: null,
		parentItemId: null,
		// Numbered with every other turn item in `projectRows` (`numberTurnItems`).
		ordinal: 0,
		status: itemStatus,
		title: null,
		startedAt: time(at),
		completedAt: done ? time(end) : null,
		updatedAt: time(end),
	});
	const pushUser = (entry: EntryRecord, intent: "turn_start" | "steer" | "promoted_queued_to_steer") => {
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
		// T3 marks the `/compact` it sent by itself (`idle-compaction.ts`), and says so on the compaction's row.
		const idle = isCompactCommandEntry(entry) && (entry.data as { idleCompaction?: unknown } | undefined)?.idleCompaction === "beforeCacheExpires" ? { idleCompaction: "beforeCacheExpires" as const } : {};
		const sender = senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) };
		turnItems.push({
			...base(userItemId(entry.data, messageId) ?? `ti-u${entry.id}`, at, "completed", true),
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
		// A context asked for by the run that answers the message is a context edit of the message's entry
		// (`message-contexts.ts`), shown from the request that carried it until the edit is placed.
		const own = message.role === "user" && Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
		// Only while the thread works: the edit is placed by the time its run has ended, and a context whose edit an
		// undo took back is not the message's any more.
		const pending = b.busy ? meta.pendingContexts?.get(entry.id) : undefined;
		const content = b.contextEdits.get(entry.id) ?? (pending === undefined ? own : [{ type: "text" as const, text: "" }, pending]);
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
			...idle,
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
					// T3's card waiting for the user: its item waits too, as the call does (parked).
					...(secretStatus === "pending" ? { status: "waiting" } : {}),
					title: label,
					type: "secret_request",
					label,
					reason: typeof block.arguments["reason"] === "string" ? block.arguments["reason"] : "",
					// The card's button (T3 0.1.9): the page to get the value from.
					...(typeof block.arguments["url"] === "string" && block.arguments["url"].trim() !== "" ? { url: block.arguments["url"].trim() } : {}),
					...(typeof block.arguments["placeholder"] === "string" ? { placeholder: block.arguments["placeholder"] } : {}),
					// T3's `file` delivery, for its note: the agent's commands can read the value, as they can here.
					delivery: "file",
					secretStatus,
				} as Any);
				asked(at);
				continue;
			}
			// T3's question card: the call is the request (`user-input.ts`). T3 reads whether it still waits, and the
			// answers once it does not, from the runtime request beside the item.
			if (block.name === ASK_USER_TOOL) {
				const requestId = userInputRequestId(block.id);
				const questions = userInputQuestions(block.arguments);
				const outcome = (resultMessage?.role === "toolResult" ? (resultMessage.details as { userInput?: { status?: string; answers?: Answers } } | undefined) : undefined)?.userInput;
				const answers = outcome?.status === "answered" ? (outcome.answers ?? {}) : undefined;
				const requestStatus = itemStatus === "running" ? "pending" : answers !== undefined ? "resolved" : outcome?.status === "timed_out" ? "expired" : "cancelled";
				turnItems.push({
					...common,
					...(requestStatus === "pending" ? { status: "waiting" } : {}),
					title: questions[0]?.header ?? "Question",
					type: "user_input_request",
					requestId: id(requestId),
					questions,
					...(answers === undefined ? {} : { questionAnswer: { requestId, answers, attachmentsByQuestionId: {}, questionTextById: Object.fromEntries(questions.map((question) => [question.id, question.question])) } }),
				} as Any);
				runtimeRequests.push({
					id: id(requestId),
					nodeId: id(nodeId),
					providerTurnId: id(turnId),
					nativeRequestRef: null,
					kind: "user_input",
					status: requestStatus,
					// The asking call waits for the answer, as a provider's own question does under T3.
					responseCapability: { type: "live", providerSessionId: id(`ps-${threadId}`) },
					createdAt: time(at),
					resolvedAt: requestStatus === "pending" ? null : time(resultAt),
					...(answers === undefined ? {} : { answers }),
				} as Any);
				asked(at);
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
	};
	// Requests that failed one after another are one row, as T3 shows a provider's retries: it stands where the first
	// failed, says the last one's error, and counts. pi-durable records every failed request as an entry of its own.
	let failures: { readonly key: string; readonly at: number; readonly count: number; readonly last: Extract<DurableMessage, { role: "assistant" }> } | undefined;
	const pushFailures = (outcome: "retrying" | "recovered" | "stopped" | "failed", endedAt?: number) => {
		if (failures === undefined) return;
		const { key, at, count, last } = failures;
		failures = undefined;
		// The request that ended the run was not sent again.
		const retries = outcome === "failed" ? count - 1 : count;
		const message = (last.errorMessage ?? "").trim().slice(0, 4000).trim() || "The model request failed.";
		const wait = outcome === "retrying" ? live?.generation?.retry : undefined;
		const status = ({ retrying: "running", recovered: "completed", stopped: "interrupted", failed: "failed" } as const)[outcome];
		turnItems.push({
			...base(`ti-e${key}`, at, status, outcome !== "retrying", endedAt ?? endOf(last, at)),
			type: "error",
			failure: { class: failureClass(message), message, code: null, retryable: retries > 0 ? true : null, ...(outcome === "failed" && limitResetAt(last) !== undefined ? { resetAt: new Date(limitResetAt(last)!).toISOString() } : {}) },
			...(retries === 0
				? {}
				: {
						retry: {
							attempt: retries,
							maxAttempts: meta.maxRetries !== undefined && meta.maxRetries >= 1 ? meta.maxRetries : null,
							retryDelayMs: wait === undefined ? null : Math.max(0, Math.round(wait.at - (last.timestamp ?? wait.at))),
						},
					}),
		} as Any);
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
		for (const slot of live?.tools ?? []) liveTools.set(slot.callId, slot);
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
	// What the host answered itself while this was the latest run (`ShownExchange`), where it was answered: after the
	// items of the entries there were then and before those of any written since (a run goes on after a `/continue`,
	// and one that runs was asked `/context`). T3 numbers items in this order.
	const shownHere = [...(shownIn.get(draft) ?? [])];
	// The approvals a host's gates asked for in this run (`approvals.ts`), after the model's call that asked, as answered
	// commands stand: T3's approval card, waiting or decided, with the runtime request it answers.
	const approvalsHere = (meta.approvals ?? []).filter((card) => shownDraft(b, card.after) === draft);
	const pushApprovals = (before: number) => {
		for (const card of approvalsHere.filter((each) => each.after < before)) {
			approvalsHere.splice(approvalsHere.indexOf(card), 1);
			const waiting = card.status === "pending";
			const end = card.resolvedAt ?? card.at;
			turnItems.push({
				...base(`ti-${card.requestId}`, card.at, waiting ? "waiting" : card.status === "resolved" ? "completed" : "cancelled", !waiting, end),
				title: card.appName ?? "Approval",
				type: "approval_request",
				requestId: id(card.requestId),
				requestKind: "permission",
				prompt: card.prompt,
				...(card.reason === undefined ? {} : { reason: card.reason }),
				// Every thread here is full-access: the card is a check the host makes of its own, which T3 explains.
				fullAccessOverride: "provider_check",
				...(card.appName === undefined ? {} : { appName: card.appName }),
				options: card.options,
			} as Any);
			runtimeRequests.push({
				id: id(card.requestId),
				nodeId: id(nodeId),
				providerTurnId: id(turnId),
				nativeRequestRef: null,
				kind: "permission",
				status: card.status,
				// The asking tool waits for the decision; a message typed meanwhile is its feedback.
				responseCapability: { type: "live", providerSessionId: id(`ps-${threadId}`), supportsFeedback: true },
				createdAt: time(card.at),
				resolvedAt: waiting ? null : time(end),
				...(card.decision === undefined ? {} : { decision: card.decision }),
				...(card.feedback === undefined ? {} : { feedback: card.feedback }),
			} as Any);
			asked(card.at);
		}
	};
	const pushShown = (before: number) => {
		for (const shown of shownHere.splice(0)) {
			if (shown.after >= before) {
				shownHere.push(shown);
				continue;
			}
			if (shown.command !== undefined) {
				const author = { createdBy: "user", creationSource: "web" } as const;
				turnItems.push({ ...base(`ti-shown-u${shown.messageId}`, shown.at, "completed", true), ...author, type: "user_message", messageId: id(shown.messageId), inputIntent: "steer", text: shown.command, attachments: [] } as Any);
				messages.push({ ...author, id: id(shown.messageId), threadId: id(threadId), runId: id(runId), nodeId: id(nodeId), role: "user", text: shown.command, attachments: [], streaming: false, createdAt: time(shown.at), updatedAt: time(shown.at) });
				shownIds.add(shown.messageId);
			}
			shownAnswer(b, shown);
		}
	};
	// A system prompt that changed while the thread went on (`systemPromptUpdates`): a row among the run's work, where
	// it did, that opens to the lines that changed. Not T3's notice row, which is a warning, and this is none.
	// Its entry is no step of the run, so the rows are placed by entry id, among this run's.
	const nextRun = b.drafts[b.drafts.indexOf(draft) + 1]?.userEntry.id ?? Number.POSITIVE_INFINITY;
	const updates = b.promptUpdates.filter((update) => update.id > u.id && update.id < nextRun);
	const pushUpdates = (before: number) => {
		while (updates.length > 0 && updates[0]!.id < before) {
			const update = updates.shift()!;
			const at = update.at ?? requestedAt;
			pushCards(at);
			turnItems.push({
				...base(`ti-s${update.id}`, at, "completed", true),
				title: meta.promptUpdateTitle?.(update.sections) ?? updateTitle(update),
				type: "dynamic_tool",
				toolName: "system_prompt",
				input: {},
				output: `The agent was given these sections as they are now. Shown here only: the lines that differ from what it had.\n\n${updateDetails(update)}`,
			} as Any);
		}
	};
	draft.steps.forEach((step, stepIndex) => {
		pushUpdates(step.id);
		pushShown(step.id);
		pushApprovals(step.id);
		// A continue is not a retry: the requests that failed before it are a row that failed, and the count starts over.
		if (step.kind === APP_CONTINUE_ENTRY) pushFailures("failed");
		if (isUserEntry(step) || isNoteEntry(step)) {
			pushUser(step, sentAs(step.data)?.promoted === true ? "promoted_queued_to_steer" : "steer");
			return;
		}
		// A compaction that landed in this run: its card where it took effect, as T3 shows a provider's compaction.
		if (isCompactionEntry(step)) {
			pushCards(firstMessage(step)?.timestamp ?? requestedAt);
			pushCompaction(b, step, runId);
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
		// A steer Stop found unread: T3's `requeueUnreadSteers` marks its row cancelled where it waited, and says so in a
		// notice with the text, to be sent again if needed.
		const unread = unreadSteerOf(step);
		if (unread !== undefined) {
			const sent = sentAs(step.data);
			const at = sent?.sentAt ?? unread.cancelledAt;
			const attachments = attachmentsOf(step);
			const context = contextOf(step) ?? contextFromText(unread.text, attachments);
			const { senderThreadId, ...author } = authorOf(step.data);
			const sender = senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) };
			pushCards(unread.cancelledAt);
			turnItems.push({
				...base(userItemId(step.data, unread.messageId) ?? `ti-u${step.id}`, at, "cancelled", true, unread.cancelledAt),
				...author,
				...sender,
				type: "user_message",
				messageId: id(unread.messageId),
				inputIntent: sent?.promoted === true ? "promoted_queued_to_steer" : "steer",
				text: unread.text,
				attachments,
				...(context === undefined ? {} : { context }),
			} as Any);
			messages.push({ ...author, ...sender, id: id(unread.messageId), threadId: id(threadId), runId: id(runId), nodeId: id(nodeId), role: "user", text: unread.text, attachments, ...(context === undefined ? {} : { context }), streaming: false, createdAt: time(at), updatedAt: time(at) } as Any);
			turnItems.push({
				...base(`ti-unread-steer-${unread.messageId}`, unread.cancelledAt, "completed", true),
				type: "system_notice",
				title: "Steer delivery not confirmed",
				message: `The agent did not confirm reading your steer before Stop. It may not have been delivered. Resend it if needed: "${unread.text}"`,
			} as Any);
			return;
		}
		const m = firstMessage(step);
		if (m?.role !== "assistant") return;
		pushCards(m.timestamp ?? requestedAt);
		const key = `${u.id}.${assistantIndex++}`;
		const at = m.timestamp ?? requestedAt;
		const answeredAgain = draft.steps.slice(stepIndex + 1).some(isAssistantEntry);
		if (m.stopReason === "error") {
			failures = { key: failures?.key ?? key, at: failures?.at ?? at, count: (failures?.count ?? 0) + 1, last: m };
			// What a failed request left is superseded by the request sent again, and one that waits to be sent again
			// will be. The request that ended the run keeps what it left.
			if (answeredAgain || running) return;
			pushAssistant(key, m, at, false, toolResults, liveTools);
			pushFailures("failed");
			return;
		}
		pushFailures(m.stopReason === "aborted" && !answeredAgain ? "stopped" : "recovered", at);
		// A partial interrupted by a crash is superseded by the resumed answer.
		if (m.stopReason === "aborted" && answeredAgain) return;
		pushAssistant(key, m, at, false, toolResults, liveTools);
	});
	pushUpdates(Number.POSITIVE_INFINITY);
	pushFailures("retrying");
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
	pushShown(Infinity);
	pushApprovals(Infinity);
	// The steers pi has not placed yet: in the run they steer, waiting to be read, as T3 shows a steer its provider
	// holds until the agent reads it (`steer.updated` pending). pi reads one at the run's next boundary: after the tool
	// calls in flight, or at the end of the answer. The row is the one the placed steer keeps (`userItemId`), so it
	// stays where it is and only stops waiting; the run's newer rows come after it until it is placed among them.
	if (draft === steeredDraft(b)) {
		for (const steer of waitingSteers(b)) {
			const sent = sentAs(steer.entry?.data);
			const at = sent?.sentAt ?? requestedAt;
			const { senderThreadId, ...author } = authorOf(steer.entry?.data);
			const sender = senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) };
			const context = contextOf(steer.entry as EntryRecord) ?? contextFromText(steer.text, steer.attachments);
			turnItems.push({
				...base(userItemId(steer.entry?.data, steer.messageId) ?? `ti-w${steer.submissionId}`, at, "pending", false),
				...author,
				...sender,
				type: "user_message",
				messageId: id(steer.messageId),
				inputIntent: sent?.promoted === true ? "promoted_queued_to_steer" : "steer",
				text: steer.text,
				attachments: [...steer.attachments],
				...(context === undefined ? {} : { context }),
			} as Any);
			messages.push({ ...author, ...sender, id: id(steer.messageId), threadId: id(threadId), runId: id(runId), nodeId: id(nodeId), role: "user", text: steer.text, attachments: [...steer.attachments], ...(context === undefined ? {} : { context }), streaming: false, createdAt: time(at), updatedAt: time(at) } as Any);
		}
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
}

function projectLiveCompactions(b: Build): void {
	const { meta, threadId, providerThreadId, live, liveCompactions, manualCompaction, manualCompactionRunId, newestDraft, compactDraft, turnItems } = b;
	// A live compaction is shown only while something waits for it, as T3 shows a provider's compaction: a manual one
	// (`/compact`, its own run; a reload still shows it) and a blocking one (the agent's next request waits for it, in
	// the agent's run). A background compaction runs while the agent keeps working, so it has no row until its summary
	// lands. The completed summary replaces this item where it lands.
	const agentRunId = live?.run !== undefined && newestDraft !== undefined ? `r${newestDraft.userEntry.id}` : null;
	const lastActivityAt = (draft: RunDraft | undefined): number => {
		const last = draft?.steps.findLast((step) => firstMessage(step)?.timestamp !== undefined) ?? draft?.userEntry;
		return (last === undefined ? undefined : firstMessage(last)?.timestamp) ?? meta.updatedAt;
	};
	for (const compaction of liveCompactions) {
		const manual = compaction === manualCompaction;
		const runId = manual ? manualCompactionRunId : compaction.blocking ? agentRunId : null;
		if (runId === null && !manual) continue;
		// Stable across projections: when it was asked for (the /compact) or when the agent's run paused for it.
		const startedAt = manual && compactDraft !== undefined ? (firstMessage(compactDraft.userEntry)?.timestamp ?? meta.updatedAt) : lastActivityAt(newestDraft);
		turnItems.push({
			id: id(`ti-live-compaction-${compaction.taskId}`),
			threadId: id(threadId),
			runId: runId === null ? null : id(runId),
			nodeId: null,
			providerThreadId: id(providerThreadId),
			providerTurnId: null,
			nativeItemRef: null,
			parentItemId: null,
			// Numbered with every other turn item in `projectRows` (`numberTurnItems`).
			ordinal: 0,
			status: "running",
			title: "Compacting context",
			startedAt: time(startedAt),
			completedAt: null,
			updatedAt: time(startedAt),
			type: "compaction",
			driver: id(PROVIDER_DRIVER),
		} as Any);
	}
}

/**
 * A manual compaction that ended without a summary because it failed (pi's `compactionFailure`: the provider refused,
 * retries ran out, the host gave it up at a provider's stated wait): T3's failed compaction card on its `/compact`, "Context
 * compaction failed · <why>", where the run would otherwise read as done. The failure is the newest one pi keeps; it is
 * this `/compact`'s when its task came after the command (task and entry ids share one sequence) and no summary did.
 */
function projectCompactionFailure(b: Build): void {
	const { threadId, providerThreadId, live, drafts, turnItems } = b;
	const failure = live?.compactionFailure;
	if (failure === undefined || failure.trigger !== "manual") return;
	const taskId = failure.taskId as unknown as number;
	const draft = drafts.findLast((candidate) => isCompactCommandEntry(candidate.userEntry) && candidate.userEntry.id < taskId);
	if (draft === undefined || draft.steps.some(isCompactionEntry) || b.manualCompactionRunId === `r${draft.userEntry.id}`) return;
	const at = firstMessage(draft.userEntry)?.timestamp ?? b.meta.updatedAt;
	turnItems.push({
		id: id(`ti-failed-compaction-${String(taskId)}`),
		threadId: id(threadId),
		runId: id(`r${draft.userEntry.id}`),
		nodeId: null,
		providerThreadId: id(providerThreadId),
		providerTurnId: null,
		nativeItemRef: null,
		parentItemId: null,
		// Numbered with every other turn item in `projectRows` (`numberTurnItems`).
		ordinal: 0,
		status: "failed",
		title: "Context compaction failed",
		summary: failure.error,
		startedAt: time(at),
		completedAt: time(at),
		updatedAt: time(at),
		type: "compaction",
		driver: id(PROVIDER_DRIVER),
	} as Any);
}

/** A user message's turn item, keyed by its message id as T3 keys one (`userTurnItem({ messageId })`) when the entry
 * records how it was sent: a steer's row is the same while it waits and once it is placed. Older entries keep theirs. */
const userItemId = (data: unknown, messageId: string): string | undefined => (sentAs(data) === undefined ? undefined : `ti-m${messageId}`);

const inboxOf = (b: Build) => readQueuedInputs((b.view?.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined)?.items);

/** The run a waiting steer is shown in: the agent's run while it works. Nothing runs (a Stop, a failure, a wait for a
 * limit): the steer waits in the queue, held, as pi keeps it. A manual compaction is no run a steer joins. */
const steeredDraft = (b: Build): RunDraft | undefined =>
	b.live?.run !== undefined && b.manualCompactionRunId === null && b.newestDraft?.markerOnly !== true ? b.newestDraft : undefined;

const waitingSteers = (b: Build) => inboxOf(b).filter((item) => item.mode === "steer");

function projectQueued(b: Build): void {
	const { meta, threadId, providerThreadId, modelSelection, drafts, busy, runs, messages } = b;
	// Queued messages live in pi's inbox until a boundary places them: a follow-up when the turn ends, a steer at the
	// running turn's next boundary. T3's queue reads queued messages as runs, so project each follow-up as a queued run,
	// with edit and remove; it disappears from here when it is placed, as a run of its own. A steer is shown in the run
	// it steers, waiting to be read (`steeredDraft`), as T3 shows a steer: never in the queue. Only when no run takes it
	// (stopped, failed, waiting for a limit) is it queued here, first, as pi places it, and held until the thread goes on.
	const inbox = inboxOf(b);
	const steers = steeredDraft(b) === undefined ? inbox.filter((item) => item.mode === "steer") : [];
	const queued = [...steers, ...inbox.filter((item) => item.mode === "followUp")];
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
			// Nothing runs, so nothing will start it: pi keeps a message queued behind a run that was stopped or failed until
			// the next message. T3 calls that a held queue and offers Resume (`queue.resume`).
			...(busy ? {} : { queueHeld: true }),
			requestedAt: time(requestedAt),
			startedAt: null,
			completedAt: null,
			checkpointId: null,
			contextHandoffId: null,
		} as Any);
		// A scheduled task's message names its task while it waits too, as T3's does (a settle passes over it).
		const scheduledTaskId = SCHEDULED_MESSAGE_ID.exec(item.messageId)?.[1];
		messages.push({
			...(({ senderThreadId, ...written }) => ({ ...written, ...(senderThreadId === undefined ? {} : { senderThreadId: id(senderThreadId) }) }))(authorOf(item.entry?.data)),
			...(scheduledTaskId === undefined ? {} : { scheduledTaskId: id(scheduledTaskId) }),
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
}

/** The rows are built: number the items, add the runs that were rolled back, and make the thread's row. */
function projectRows(b: Build) {
	const { meta, memory, threadId, providerThreadId, modelSelection, drafts, busy, worktreePath, runs, attempts, nodes, providerTurns, messages, turnItems, subagents, checkpointScopes, checkpoints, runtimeRequests } = b;
	// T3 numbers turn items in the order they enter the thread (`nextTurnItemOrdinal`), one ordinal per item: a client
	// places an item by it, and a bounded window's watermark is the newest ordinal. Items are built in that order.
	numberTurnItems(turnItems, memory.ordinals);

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

	const updatedAt = time(b.lastActivity);
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
			updatedAt: time(b.lastActivity),
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
			firstRunOrdinal: 1,
			lastRunOrdinal: drafts.length,
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
		...(meta.lineage?.sideChat === true ? { sideChat: true } : {}),
	});
	const forkedFrom = () =>
		meta.forkedFrom == null
			? null
			: meta.forkedFrom.type === "node"
				? { type: "node", nodeId: id(meta.forkedFrom.nodeId) }
				: { type: "run", threadId: id(meta.forkedFrom.threadId), runId: id(meta.forkedFrom.runId) };
	const author = { createdBy: meta.createdBy ?? "user", creationSource: meta.creationSource ?? "web" };
	// T3's limit recovery stands while the run the limit ended is still the last one that ran, and failed.
	const limited = runs.findLast((run) => run.status !== "queued" && run.status !== "rolled_back");
	const recovery = meta.limitRecovery !== undefined && limited?.status === "failed" && (limited.id as string) === meta.limitRecovery.runId ? meta.limitRecovery : undefined;
	// T3's sidebar state, on the thread and its shell alike.
	const sidebar = {
		limitRecovery: recovery === undefined ? null : { runId: id(recovery.runId), resetAt: new Date(recovery.resetAt).toISOString(), autoResume: recovery.autoResume, snooze: recovery.snooze === true },
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
		lastTitleRegeneration: meta.lastTitleRegeneration == null ? null : { ...meta.lastTitleRegeneration, requestId: id(meta.lastTitleRegeneration.requestId), completedAt: time(meta.lastTitleRegeneration.completedAt) },
		providerInstanceId: id(PROVIDER_INSTANCE_ID),
		modelSelection,
		runtimeMode: "full-access",
		interactionMode: "default",
		branch: null,
		worktreePath,
		activeProviderThreadId: drafts.length === 0 ? null : id(providerThreadId),
		lineage: lineage(),
		forkedFrom: forkedFrom(),
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
		runtimeRequests,
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
	return { projection, visibleTurnItems, updatedAt, author, sidebar, thread };
}

/** Execution rows (T3's `EXECUTION_TURN_ITEM_TYPES`): what a turn is doing, as against what it says. */
const EXECUTION_ITEM_TYPES: ReadonlySet<string> = new Set(["command_execution", "dynamic_tool", "subagent", "file_change", "file_search", "web_search", "compaction"]);

/** T3's `deriveBlockedOnThreadWait`, with this host's waits for T3's `t3_thread_wait` and `delegate_task` in `wait`
 * mode: every row the running turn still works on is `thread_wait`, or a `thread_prompt` that waits (its default). A
 * child's card follows the child, not the wait, so it does not count. */
function blockedOnThreadWait(activeRun: OrchestrationV2Run | undefined, turnItems: readonly OrchestrationV2TurnItem[]): boolean {
	if (activeRun?.status !== "running") return false;
	let waits = false;
	for (const item of turnItems) {
		if (item.runId !== activeRun.id || !EXECUTION_ITEM_TYPES.has(item.type) || (item.status !== "running" && item.status !== "waiting")) continue;
		if (item.type === "subagent" && item.origin === "app_owned") continue;
		if (item.type !== "dynamic_tool") return false;
		const input = item.input as { wait?: unknown } | null | undefined;
		if (item.toolName !== "thread_wait" && !(item.toolName === "thread_prompt" && input?.wait !== false)) return false;
		waits = true;
	}
	return waits;
}

/** T3's `isSilentRunForShell`: a run of T3's own idle compaction (`idle-compaction.ts`, its message among `idle`) that
 * did not fail. Neither failure can happen here yet (a compaction that fails leaves no row, and its run reads completed);
 * the checks are T3's, kept so the rule stays T3's. */
function isSilentRun(run: OrchestrationV2Run, idle: ReadonlySet<string>, turnItems: readonly OrchestrationV2TurnItem[]): boolean {
	return run.status !== "failed" && idle.has(run.userMessageId as string) && !turnItems.some((item) => item.runId === run.id && item.type === "compaction" && item.status === "failed");
}

/** The line an answer ends with to end its run silently. */
export const SILENT_REPLY = "SILENT";

/**
 * Whether an answer ends its run silently: its last line is `SILENT_REPLY` and nothing else. The agent's way to say
 * that a run left nothing the user needs to see (a scheduled check that found nothing): the run completes, and the
 * shell presents it as T3 presents a run that was stopped, which no client announces. Nor does the run make its
 * thread unread (`Bridge`, as the run ends), as a stopped run does not in T3.
 */
export function endsSilent(answer: string | undefined): boolean {
	return answer !== undefined && answer.trimEnd().split("\n").at(-1)?.trim() === SILENT_REPLY;
}

/** The thread's shell: its sidebar row, with the latest run and message as T3's shell reads them. */
function projectShell(b: Build, rows: ReturnType<typeof projectRows>): OrchestrationV2ThreadShell {
	const { meta, view, threadId, providerThreadId, modelSelection, drafts, busy, worktreePath, runs: allRuns, messages, turnItems, shownIds } = b;
	const { visibleTurnItems, updatedAt, author, sidebar, thread } = rows;
	// T3's own idle compactions stay out of the shell unless they fail, so thread lists, notifications and the relay keep
	// presenting the user's last turn (T3's `isSilentRunForShell`): a compaction is neither the latest run nor work.
	const idle = new Set(messages.flatMap((message) => (idleCompactionOf(message) === undefined ? [] : [message.id as string])));
	const silent = new Set(idle.size === 0 ? [] : allRuns.filter((run) => isSilentRun(run, idle, turnItems)).map((run) => run.id as string));
	const runs = silent.size === 0 ? allRuns : allRuns.filter((run) => !silent.has(run.id as string));
	// Nor does the shell show the thread working while only such a compaction runs.
	const working = busy && !(b.live?.run === undefined && b.manualCompactionRunId !== null && silent.has(b.manualCompactionRunId));
	const liveRuns = runs.filter((run) => run.status !== "rolled_back");
	// T3's `latestUnheldRun`: the newest run that is not waiting in a held queue, so a thread whose run stopped or
	// reached a limit shows that, and not "queued", while messages wait behind it.
	const latestRun = liveRuns.findLast((run) => !(run.status === "queued" && (run as { queueHeld?: boolean }).queueHeld === true));
	const activeRun = liveRuns.findLast((run) => run.status === "running");
	// The latest run ended silent (`endsSilent`): its last answer says so.
	const endedSilent = latestRun?.status === "completed" && endsSilent(messages.findLast((message) => message.role === "assistant" && message.runId === latestRun.id)?.text);
	// The thread's own messages: a command the host answered on the spot is not the thread's latest message, nor is
	// T3's idle `/compact` (T3's shell leaves it out of the user's messages).
	const durable = messages.filter((message) => !shownIds.has(message.id as string) && !idle.has(message.id as string));
	const lastVisibleMessage = durable.at(-1);
	const lastUser = durable.findLast((message) => message.role === "user");
	const lastUserAuthored = durable.findLast((message) => message.role === "user" && ((message as Any).createdBy ?? "user") === "user");
	// Not loaded: the latest run the summary kept, so a closed thread sorts and shows its state as an open one does.
	const keptRun = view === undefined ? (meta.summary?.latestRun ?? null) : null;
	const shell: OrchestrationV2ThreadShell = {
		...author,
		id: id(threadId),
		projectId: id(meta.projectId),
		title: meta.title,
		titleRegeneration: meta.titleRegeneration == null ? null : { requestId: id(meta.titleRegeneration.requestId), startedAt: time(meta.titleRegeneration.startedAt) },
		lastTitleRegeneration: meta.lastTitleRegeneration == null ? null : { ...meta.lastTitleRegeneration, requestId: id(meta.lastTitleRegeneration.requestId), completedAt: time(meta.lastTitleRegeneration.completedAt) },
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
		// T3's `latestRunStopRequested`: the latest run was stopped, so T3's clients do not announce it completed. T3 keeps
		// the run's `run_interrupt_request` row, which goes with the run's end here; but only a Stop, an agent's stop or a
		// restart's send ends a run interrupted (each of which leaves that row in T3), so an interrupted run was stopped.
		// One that completed although Stop was pressed as it ended is not flagged once it has ended. A run that ended
		// silent is flagged too: the flag's one use in T3 is to keep a completion from being announced (its clients'
		// notification gate, and `projectThreadAwarenessV2` for its phone alerts).
		latestRunStopRequested: (() => {
			const shown = latestRun ?? keptRun ?? undefined;
			return shown !== undefined && (endedSilent || shown.status === "interrupted" || turnItems.some((item) => item.runId === shown.id && item.type === "run_interrupt_request"));
		})(),
		activeRunId: activeRun?.id ?? null,
		activityRunStartedAt: activeRun?.startedAt ?? null,
		activityRunStatus: activeRun === undefined ? null : "running",
		// T3's shell status is the latest run's status, and "idle" only for a thread that never ran (ProjectionStore.ts).
		status: working ? "running" : (latestRun?.status ?? keptRun?.status ?? "idle"),
		// T3's `threadErrorSummary`: what the latest run failed with, for the sidebar ("limited" for a provider's limit).
		...(() => {
			const failed = working || latestRun?.status !== "failed" ? undefined : (turnItems.findLast((item) => item.type === "error" && item.status === "failed" && item.runId === latestRun.id) as { failure?: { class: string; message: string; resetAt?: string } } | undefined)?.failure;
			if (failed !== undefined) return { lastError: failed.message, lastErrorClass: failed.class, lastErrorCode: null, usageLimitResetAt: failed.class === "usage_limit" ? (failed.resetAt ?? null) : null };
			if (latestRun === undefined && keptRun?.status === "failed" && keptRun.errorClass !== undefined) return { lastErrorClass: keptRun.errorClass, usageLimitResetAt: keptRun.resetAt ?? null };
			return {};
		})(),
		// T3's `pendingRuntimeRequest`: the newest request that waits, an approval before a question, which the sidebar
		// shows ("Needs approval", "Needs input") and a parent shows for its child.
		pendingRuntimeRequest: (() => {
			const pending = b.runtimeRequests
				.filter((request) => request.status === "pending")
				.toSorted((left, right) => Number(left.kind === "user_input") - Number(right.kind === "user_input") || DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt))[0];
			const request = pending === undefined ? null : { id: pending.id, kind: pending.kind, createdAt: pending.createdAt, blocking: pending.responseCapability.type !== "message" };
			if (request !== null && request.kind !== "user_input") return request;
			// T3's `secretRequestAsPendingInput`: a secret card its call still waits on is the thread's request too, one only
			// the user can answer (`userOnly`: a parent shows it for its child), unless a newer question waits.
			const card = turnItems
				.filter((item) => item.type === "secret_request" && (item as { secretStatus?: string }).secretStatus === "pending")
				.toSorted((left, right) => DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt))[0];
			const asked = card === undefined ? undefined : (card.startedAt ?? card.updatedAt);
			if (card === undefined || asked === undefined || (request !== null && DateTime.toEpochMillis(asked) < DateTime.toEpochMillis(request.createdAt))) return request;
			return { id: id(card.id), kind: "user_input", createdAt: asked, blocking: true, userOnly: true };
		})(),
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
		// T3's `deriveBlockedOnThreadWait`: the running turn does nothing but wait for other threads (T3's sidebar shows
		// it waiting, not working). Here that is `thread_wait`, or `thread_prompt` waiting for its answer.
		blockedOnThreadWait: blockedOnThreadWait(activeRun, turnItems),
		// T3's `derivePendingBackgroundWork`: work the latest run left going, here the children it started without waiting
		// (`thread_prompt` with `wait: false`) that still work, each a subagent task. Read from the cards the thread's
		// children give it, which a thread that is not open has too, as its card rows.
		pendingBackgroundTasks: derivePendingBackgroundWork({
			latestRun: latestRun ?? (keptRun === null ? null : { id: id(keptRun.id), status: keptRun.status as OrchestrationV2Run["status"], ordinal: 0 }),
			providerThreads: [],
			turnItems: (meta.children ?? []).map((child) => ({ id: `ti-c${child.threadId}`, type: "subagent" as const, status: child.status, title: child.title, runId: child.parentRunId, prompt: child.prompt, childThreadId: id(child.threadId) })),
			runs,
			activeProviderThreadId: null,
		}),
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
	return shell;
}

export function projectThread(
	meta: ThreadMeta,
	view: ConversationView | undefined,
	memory: ThreadMemory,
): ProjectionResult {
	const b: Build = begin(meta, view, memory);
	const { drafts } = b;
	pushBaseline(b);
	const shownIn = new Map<RunDraft, ShownExchange[]>();
	const shownAlone: ShownExchange[] = [];
	for (const shown of meta.shown ?? []) {
		const draft = shownDraft(b, shown.after);
		if (draft === undefined) shownAlone.push(shown);
		else shownIn.set(draft, [...(shownIn.get(draft) ?? []), shown]);
	}
	drafts.forEach((draft, index) => projectRun(b, shownIn, draft, index));
	projectCompactedSize(b);
	// Answers with no run to stand by: an undo's, on a thread it emptied.
	for (const shown of shownAlone) shownAnswer(b, shown);

	markModelSwitches(b.runs, b.turnItems, drafts);
	projectLiveCompactions(b);
	projectCompactionFailure(b);
	projectQueued(b);
	const rows = projectRows(b);
	return { projection: rows.projection, shell: projectShell(b, rows), runs: b.projectedRuns, forkRuns: b.forkRuns, toolImages: b.toolImages };
}

/**
 * After a compaction, until a request answers: the newest run's usage is the context's estimated size
 * (`context-size.ts`). T3's meter shows the newest report, which would be the size from before.
 */
function projectCompactedSize(b: Build): void {
	const { meta, transcript, providerTurns, sizeAfter: usedTokens } = b;
	const turn = providerTurns.at(-1);
	if (turn === undefined || meta.contextWindow === undefined || meta.contextWindow <= 0) return;
	if (usedTokens === undefined) return;
	const compactedAt = firstMessage(transcript.findLast(isCompactionEntry)!)?.timestamp ?? 0;
	// Not older than the report it replaces: T3 takes the newest by this time.
	const reportedAt = turn.tokenUsage === undefined ? 0 : Date.parse(turn.tokenUsage.updatedAt);
	const endedAt = turn.completedAt ?? turn.startedAt;
	const updatedAt = new Date(Math.max(compactedAt, reportedAt, endedAt === null ? 0 : DateTime.toEpochMillis(endedAt))).toISOString();
	providerTurns[providerTurns.length - 1] = { ...turn, tokenUsage: { usedTokens, maxTokens: meta.contextWindow, updatedAt } } as OrchestrationV2ProviderTurn;
}

/** A compaction summary entry: shown as T3's compaction card where it landed. */
function isCompactionEntry(entry: EntryRecord): boolean {
	return entry.kind === "pi.compaction";
}

/**
 * The context size before and after each compaction, as T3's card shows it ("Context compacted 183k → 41k tokens"):
 * before, what the last request before the summary used (its input, cache and answer); after, what the first request
 * after it sent. A request without usage (one that failed) does not count. Until a request follows the newest
 * compaction, its after is `estimatedAfter` (`sizeAfterCompaction`, what the meter shows), as T3's pi driver reports
 * pi's estimate; before is absent when no request preceded it.
 */
function compactionTokenCounts(entries: readonly EntryRecord[], estimatedAfter: number | undefined): Map<EntryRecord["id"], { before?: number; after?: number }> {
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
		const sent = sentTokens(usage);
		if (sent <= 0) continue;
		for (const count of waiting) count.after = sent;
		waiting = [];
		lastContext = sent + (usage?.output ?? 0);
	}
	if (estimatedAfter !== undefined) for (const count of waiting) count.after = estimatedAfter;
	return counts;
}
