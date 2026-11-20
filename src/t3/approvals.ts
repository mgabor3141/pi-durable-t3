// T3's approval card (`approval_request`), on this host. pi runs tools without approvals, so every thread is
// full-access; a host's own tool may still stop for a check of its own (claw: a connection to another machine), as a
// provider may under full access (`fullAccessOverride: "provider_check"`, which T3 explains on the card). The tool asks
// here, the thread shows T3's card in the run and "Needs approval" in the sidebar, and the decision (`runtime-request.
// respond`) is what the tool gets. A message typed while the card waits is its feedback: declined, with that text.
//
// In memory only, as the tool that waits is: a restart ends the call, and with it the request.
import { randomUUID } from "node:crypto";
import { CommandError } from "./errors.ts";

/** T3's decisions (`ProviderApprovalDecision`). */
export type ApprovalDecision = "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel";

/** A button of the card: its decision, in the host's words (`ProviderApprovalOption`). */
export interface ApprovalOption {
	readonly decision: ApprovalDecision;
	readonly label: string;
	/** Shown with the button, as a warning sign and its text. */
	readonly warning?: string;
}

/** What a host's tool asks the user to approve. */
export interface ApprovalAsk {
	/** The conversation of the call that asks: its thread shows the card. */
	readonly conversationId: number;
	/** The card's main line, shown as code: what would happen. */
	readonly prompt: string;
	/** Why, under it. */
	readonly reason?: string;
	/** A name above it, as T3 shows the app a request comes from. */
	readonly appName?: string;
	readonly options: readonly ApprovalOption[];
	/** How long the card waits; default 30 minutes. */
	readonly timeoutMs?: number;
}

/** How the card ended: a decision (with what the user typed, for a decline), or none. */
export type ApprovalOutcome =
	| { readonly status: "decided"; readonly decision: ApprovalDecision; readonly feedback?: string }
	| { readonly status: "timed_out" | "cancelled" };

/** A card as a thread shows it: waiting, or how it ended. */
export interface ShownApproval {
	readonly requestId: string;
	readonly prompt: string;
	readonly reason?: string;
	readonly appName?: string;
	readonly options: readonly ApprovalOption[];
	readonly at: number;
	/** The newest entry the thread had when it was asked: the card stands after it (as a `ShownExchange` does). */
	readonly after: number;
	readonly status: "pending" | "resolved" | "expired" | "cancelled";
	readonly decision?: ApprovalDecision;
	readonly feedback?: string;
	readonly resolvedAt?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** How many cards that ended a thread keeps showing. */
const MAX_ENDED = 20;
const PREFIX = "ap-";

export interface ApprovalDeps {
	readonly threadOf: (conversationId: number) => Promise<string | undefined>;
	/** Where a card asked now stands in the thread (its newest entry), and how to show the change. */
	readonly place: (threadId: string) => { readonly after: number; readonly recompute: () => void };
}

export class ApprovalRequests {
	readonly #deps: ApprovalDeps;
	readonly #byThread = new Map<string, ShownApproval[]>();
	readonly #waiting = new Map<string, { readonly threadId: string; readonly settle: (outcome: ApprovalOutcome) => void }>();

	constructor(deps: ApprovalDeps) {
		this.#deps = deps;
	}

	/** Is `requestId` one of these cards? */
	owns(requestId: string): boolean {
		return requestId.startsWith(PREFIX);
	}

	/** The cards a thread shows: those waiting, and the last ones that ended. */
	shown(threadId: string): readonly ShownApproval[] | undefined {
		return this.#byThread.get(threadId);
	}

	/** A thread was deleted: forget its cards (one still waiting is cancelled). */
	forget(threadId: string): void {
		this.#byThread.delete(threadId);
		for (const waiting of [...this.#waiting.values()]) if (waiting.threadId === threadId) waiting.settle({ status: "cancelled" });
	}

	/**
	 * Show the card in the asking call's thread and wait for the user's decision. Ends without one when the call is
	 * aborted (Stop), when it times out, or when the conversation is no thread's.
	 */
	async request(ask: ApprovalAsk, signal?: AbortSignal): Promise<ApprovalOutcome> {
		if (ask.options.length === 0) throw new Error("an approval needs at least one option");
		const threadId = await this.#deps.threadOf(ask.conversationId);
		if (threadId === undefined || signal?.aborted === true) return { status: "cancelled" };
		const { after, recompute } = this.#deps.place(threadId);
		const requestId = `${PREFIX}${randomUUID()}`;
		const card: ShownApproval = {
			requestId,
			prompt: ask.prompt,
			...(ask.reason === undefined ? {} : { reason: ask.reason }),
			...(ask.appName === undefined ? {} : { appName: ask.appName }),
			options: ask.options,
			at: Date.now(),
			after,
			status: "pending",
		};
		this.#set(threadId, card);
		recompute();
		return new Promise<ApprovalOutcome>((resolve) => {
			const settle = (outcome: ApprovalOutcome) => {
				if (!this.#waiting.delete(requestId)) return;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				// A deleted thread's cards are gone (`forget`): nothing to show, and placing one would open its view again.
				if (this.#byThread.has(threadId)) {
					const status = outcome.status === "decided" ? "resolved" : outcome.status === "timed_out" ? "expired" : "cancelled";
					this.#set(threadId, {
						...card,
						status,
						...(outcome.status === "decided" ? { decision: outcome.decision, ...(outcome.feedback === undefined ? {} : { feedback: outcome.feedback }) } : {}),
						resolvedAt: Date.now(),
					});
					this.#deps.place(threadId).recompute();
				}
				resolve(outcome);
			};
			const onAbort = () => settle({ status: "cancelled" });
			const timer = setTimeout(() => settle({ status: "timed_out" }), ask.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			timer.unref?.();
			this.#waiting.set(requestId, { threadId, settle });
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** T3's `runtime-request.respond` with a `decision`: refused in T3's words when the card no longer waits, or when
	 * the decision is not one the card offered. */
	respond(input: { readonly threadId: string; readonly requestId: string; readonly decision: ApprovalDecision; readonly feedback?: string }): void {
		const waiting = this.#waiting.get(input.requestId);
		if (waiting === undefined || waiting.threadId !== input.threadId) throw new CommandError(`Runtime request ${input.requestId} is no longer pending.`);
		const card = this.#byThread.get(input.threadId)?.find((each) => each.requestId === input.requestId);
		// A typed message declines with feedback, which T3 sends whatever the buttons were.
		const offered = input.decision === "decline" || card?.options.some((option) => option.decision === input.decision) === true;
		if (!offered) throw new CommandError(`The decision ${input.decision} is not one this request offers.`);
		const feedback = input.feedback?.trim();
		waiting.settle({ status: "decided", decision: input.decision, ...(feedback === undefined || feedback === "" ? {} : { feedback }) });
	}

	/** Keep `card` in its thread's list, replacing the one with its id; only the newest ended ones are kept. */
	#set(threadId: string, card: ShownApproval): void {
		const cards = [...(this.#byThread.get(threadId) ?? []).filter((each) => each.requestId !== card.requestId), card];
		const ended = cards.filter((each) => each.status !== "pending");
		const drop = new Set(ended.slice(0, Math.max(0, ended.length - MAX_ENDED)).map((each) => each.requestId));
		this.#byThread.set(threadId, cards.filter((each) => !drop.has(each.requestId)));
	}
}
