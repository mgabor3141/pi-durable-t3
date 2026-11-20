// T3's approval card (`approval_request`), on this host. pi runs tools without approvals, so every thread is
// full-access; a host's own check may still stop a call (claw: a connection to another machine), as a provider may under
// full access (`fullAccessOverride: "provider_check"`, which T3 explains on the card). The check is a `beforeTool` gate
// that asks here: the call parks on a signal, the thread shows T3's card in the run and "Needs approval" in the sidebar,
// and the decision (`runtime-request.respond`) is the signal that wakes the gate. A message typed while the card waits is
// its feedback: declined, with that text.
//
// The card is the parked call's: what it says is kept in the call's task when the gate first asks (a memo), and a card
// shows for every call the task graph has asleep on this signal. So it holds no process, outlives a restart with the
// same request id, and waits until it is answered or the run is stopped. Calls of one thread that ask the same question
// (the same key) wait for one card, whose decision answers them all. How a card ended is kept in memory only.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineSignal, type Harness, type HookApi, type SignalKey, type TaskGraph, type TaskId, type ToolTaskInput } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { messageOf } from "../host-errors.ts";

/** T3's decisions (`ProviderApprovalDecision`). */
export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

/** A button of the card: its decision, in the host's words (`ProviderApprovalOption`). */
export interface ApprovalOption {
	readonly decision: ApprovalDecision;
	readonly label: string;
	/** Shown with the button, as a warning sign and its text. */
	readonly warning?: string;
}

/** What a host's gate asks the user to approve. */
export interface ApprovalAsk {
	/** The question, unique within the call: the signal's key. Calls of one thread asking the same key share a card. */
	readonly key: string;
	/** The card's main line, shown as code: what would happen. */
	readonly prompt: string;
	/** Why, under it. */
	readonly reason?: string;
	/** A name above it, as T3 shows the app a request comes from. */
	readonly appName?: string;
	readonly options: readonly ApprovalOption[];
}

/** The user's decision, with what they typed for a decline. */
export interface ApprovalOutcome {
	readonly decision: ApprovalDecision;
	readonly feedback?: string;
}

/** A card as a thread shows it: waiting, or how it ended. */
export interface ShownApproval {
	readonly requestId: string;
	readonly prompt: string;
	readonly reason?: string;
	readonly appName?: string;
	readonly options: readonly ApprovalOption[];
	readonly at: number;
	/** The entry of the model's call it stands under: the card stands after it (as a `ShownExchange` does). */
	readonly after: number;
	readonly status: "pending" | "resolved" | "cancelled";
	readonly decision?: ApprovalDecision;
	readonly feedback?: string;
	readonly resolvedAt?: number;
}

const DECISIONS = ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const;
/** The decision that wakes a gate. */
const Decision = defineSignal({ name: "t3.approval", version: 1, schema: obj({ decision: oneOf(DECISIONS), feedback: opt(str()) }) });
/** The memo a card is kept under in its call's task, by key. */
const MEMO = "t3.approval:";
/** What the memo keeps: the card as first asked, and when. */
type Memo = { readonly prompt: string; readonly reason?: string; readonly appName?: string; readonly options: readonly ApprovalOption[]; readonly at: number };
/** How many cards that ended a thread keeps showing. */
const MAX_ENDED = 20;
const PREFIX = "ap-";

export interface ApprovalDeps {
	readonly harness: () => Harness;
	readonly log: Logger;
	/** The live thread whose head a conversation is. */
	readonly threadOf: (conversationId: number) => string | undefined;
	/** Show a thread's cards as they are now. */
	readonly recompute: (threadId: string) => void;
}

/** A card waiting: the call's task asleep on its key. */
type Asleep = { readonly threadId: string; readonly taskId: TaskId; readonly key: string };

export class ApprovalRequests {
	readonly #deps: ApprovalDeps;
	readonly #byThread = new Map<string, ShownApproval[]>();
	/** The waiting cards, by request id. */
	readonly #asleep = new Map<string, Asleep>();
	/** Cards read from their task now, by request id. */
	readonly #reading = new Set<string>();
	/** The task graph as last seen. */
	#graph: TaskGraph = { tasks: {} };

	constructor(deps: ApprovalDeps) {
		this.#deps = deps;
	}

	/**
	 * In a `beforeTool` gate: ask the user on T3's card in the thread of the call's conversation. The decision once the
	 * user made it; until then the sleep for the gate to return, which parks the call (the gate runs again on every
	 * wake, so it decides from what this returns then). A conversation that is no thread's head has no card to show
	 * it: that throws.
	 */
	async ask(api: Pick<HookApi, "conversationId" | "readSignal" | "memo" | "now">, ask: ApprovalAsk, context: Context): Promise<ApprovalOutcome | { readonly sleep: { readonly signals: readonly SignalKey<unknown>[] } }> {
		if (ask.options.length === 0) throw new Error("an approval needs at least one option");
		if (ask.key === "") throw new Error("an approval needs a key");
		const state = await api.readSignal(Decision, ask.key, context);
		if (state !== undefined && "value" in state) return { decision: state.value.decision, ...(state.value.feedback === undefined ? {} : { feedback: state.value.feedback }) };
		if (this.#deps.threadOf(api.conversationId) === undefined) throw new Error(`conversation ${api.conversationId} is no thread's: there is no card to ask on`);
		// The card as first asked: a gate that runs again (a restart, a registry change) shows the same one.
		const card: Memo = { prompt: ask.prompt, ...(ask.reason === undefined ? {} : { reason: ask.reason }), ...(ask.appName === undefined ? {} : { appName: ask.appName }), options: ask.options, at: api.now() };
		await api.memo(`${MEMO}${ask.key}`, card as never, context);
		return { sleep: { signals: [Decision.key(ask.key)] } };
	}

	/** Is `requestId` one of these cards? */
	owns(requestId: string): boolean {
		return requestId.startsWith(PREFIX);
	}

	/** The cards a thread shows: those waiting (one per question), and the last ones that ended. */
	shown(threadId: string): readonly ShownApproval[] | undefined {
		const cards = this.#byThread.get(threadId);
		return cards?.filter((card) => !this.#hidden(card.requestId));
	}

	/** A thread was deleted: forget its cards. Its calls end with its runs. */
	forget(threadId: string): void {
		this.#byThread.delete(threadId);
		for (const [requestId, asleep] of [...this.#asleep]) if (asleep.threadId === threadId) this.#asleep.delete(requestId);
	}

	/** Each frame of the task graph: a card for every call newly asleep on a decision, and the end of those that no longer
	 * wait. */
	graph(graph: TaskGraph): void {
		this.#graph = graph;
		const asleep = new Set<string>();
		for (const node of Object.values(graph.tasks)) {
			if (node.state.status !== "sleeping") continue;
			for (const signal of node.state.signals ?? []) {
				if (signal.signal !== Decision.name) continue;
				const requestId = `${PREFIX}${node.id}:${signal.key}`;
				asleep.add(requestId);
				if (!this.#asleep.has(requestId) && !this.#reading.has(requestId)) void this.#read(requestId, node.id, Number(node.conversationId), signal.key).catch((error: unknown) => this.#deps.log.warn("an approval card could not be read from its call", { requestId, error: messageOf(error) }));
			}
		}
		const ended = [...this.#asleep].filter(([requestId, card]) => {
			if (asleep.has(requestId)) return false;
			// A gate asked again (a restart, a registry change) runs before it sleeps again on the same key.
			const state = graph.tasks[String(card.taskId)]?.state;
			return !((state?.status === "pending" || state?.status === "running") && state.phase === "call");
		});
		// Stopped, or gone on without a decision from here. One that waited behind another was never shown.
		const hidden = new Set(ended.filter(([requestId]) => this.#hidden(requestId)).map(([requestId]) => requestId));
		for (const [requestId] of ended) this.#end(requestId, hidden.has(requestId) ? undefined : { status: "cancelled" });
	}

	/** A new card: what it says from its call's task, and where it stands, the entry of the model's call it belongs to. */
	async #read(requestId: string, taskId: TaskId, conversationId: number, key: string): Promise<void> {
		this.#reading.add(requestId);
		try {
			const harness = this.#deps.harness();
			const record = await harness.getTask(taskId, BACKGROUND_CONTEXT);
			const memo = record?.memos?.[`${MEMO}${key}`] as Memo | undefined;
			const threadId = this.#deps.threadOf(conversationId);
			if (memo === undefined || threadId === undefined) return;
			let input = record?.input as ToolTaskInput | undefined;
			while (input?.kind === "nested") input = (await harness.getTask(input.parent, BACKGROUND_CONTEXT))?.input as ToolTaskInput | undefined;
			// Still asleep on it now that it is read.
			const node = this.#graph.tasks[String(taskId)];
			if (input === undefined || node?.state.status !== "sleeping" || !(node.state.signals ?? []).some((signal) => signal.signal === Decision.name && signal.key === key)) return;
			this.#asleep.set(requestId, { threadId, taskId, key });
			this.#set(threadId, { requestId, prompt: memo.prompt, ...(memo.reason === undefined ? {} : { reason: memo.reason }), ...(memo.appName === undefined ? {} : { appName: memo.appName }), options: memo.options, at: memo.at, after: Number(input.assistant), status: "pending" });
			this.#deps.recompute(threadId);
		} finally {
			this.#reading.delete(requestId);
		}
	}

	/** T3's `runtime-request.respond` with a `decision`: refused in T3's words when the card no longer waits, or when
	 * the decision is not one the card offered. Delivered to every call of the thread waiting on the same question. */
	async respond(input: { readonly threadId: string; readonly requestId: string; readonly decision: ApprovalDecision; readonly feedback?: string }): Promise<void> {
		const waiting = this.#asleep.get(input.requestId);
		const card = this.#byThread.get(input.threadId)?.find((each) => each.requestId === input.requestId);
		if (waiting === undefined || waiting.threadId !== input.threadId || card === undefined || this.#hidden(input.requestId)) throw new CommandError(`Runtime request ${input.requestId} is no longer pending.`);
		// A typed message declines with feedback, which T3 sends whatever the buttons were.
		const offered = input.decision === "decline" || card.options.some((option) => option.decision === input.decision);
		if (!offered) throw new CommandError(`The decision ${input.decision} is not one this request offers.`);
		const feedback = input.feedback?.trim();
		const value = { decision: input.decision, ...(feedback === undefined || feedback === "" ? {} : { feedback }) };
		const group = [...this.#asleep].filter(([, each]) => each.threadId === waiting.threadId && each.key === waiting.key);
		let delivered = false;
		for (const [, each] of group) if ((await this.#deps.harness().signal(each.taskId, Decision, each.key, value, BACKGROUND_CONTEXT)) === "delivered") delivered = true;
		// The card shown ends with the decision; those that waited behind it were never shown.
		for (const [requestId] of group) this.#end(requestId, requestId !== input.requestId ? undefined : delivered ? { status: "resolved", ...value } : { status: "cancelled" });
		if (!delivered) throw new CommandError(`Runtime request ${input.requestId} is no longer pending.`);
	}

	/** Does the card wait behind an older one of its thread with the same question, which is shown and answers both? */
	#hidden(requestId: string): boolean {
		const waiting = this.#asleep.get(requestId);
		if (waiting === undefined) return false;
		const cards = this.#byThread.get(waiting.threadId) ?? [];
		const at = (id: string) => cards.find((card) => card.requestId === id)?.at ?? Infinity;
		return [...this.#asleep].some(([other, each]) => other !== requestId && each.threadId === waiting.threadId && each.key === waiting.key && (at(other) < at(requestId) || (at(other) === at(requestId) && other < requestId)));
	}

	/** A card stops waiting, with how it ended; without (`undefined`) it goes, as one never shown. */
	#end(requestId: string, outcome: { readonly status: "resolved" | "cancelled"; readonly decision?: ApprovalDecision; readonly feedback?: string } | undefined): void {
		const waiting = this.#asleep.get(requestId);
		if (waiting === undefined) return;
		this.#asleep.delete(requestId);
		const cards = this.#byThread.get(waiting.threadId);
		const card = cards?.find((each) => each.requestId === requestId);
		if (cards === undefined || card === undefined) return;
		if (outcome === undefined) this.#byThread.set(waiting.threadId, cards.filter((each) => each !== card));
		else this.#set(waiting.threadId, { ...card, ...outcome, resolvedAt: Date.now() });
		this.#deps.recompute(waiting.threadId);
	}

	/** Keep `card` in its thread's list, replacing the one with its id; only the newest ended ones are kept. */
	#set(threadId: string, card: ShownApproval): void {
		const cards = [...(this.#byThread.get(threadId) ?? []).filter((each) => each.requestId !== card.requestId), card];
		const ended = cards.filter((each) => each.status !== "pending");
		const drop = new Set(ended.slice(0, Math.max(0, ended.length - MAX_ENDED)).map((each) => each.requestId));
		this.#byThread.set(threadId, cards.filter((each) => !drop.has(each.requestId)));
	}
}
