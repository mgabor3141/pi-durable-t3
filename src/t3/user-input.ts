// T3's question card (`user_input_request`), on this host: the agent asks the user one to four questions with
// `ask_user`, the thread shows T3's card above the composer (the call is projected as the item and a pending runtime
// request), and the user's answer (`runtime-request.respond`) is what the call returns. The agent waits meanwhile, as
// a provider's own question tool does under T3 (its `live` response): the run goes on with the answer.
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { arr, bool, int, opt, str } from "@earendil-works/pi-schema";
import { CommandError } from "./errors.ts";
import { object } from "./schema.ts";

/** The tool's name. */
export const ASK_USER_TOOL = "ask_user";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_TIMEOUT_MS = 8 * 60 * 60 * 1000;
/** How long an answer waits for its call to start waiting (a card shows as soon as the call exists, and again while
 * a call replays after a restart). */
const ARRIVAL_MS = 5_000;

/** How a call ended, in its result's details, for the card. */
type UserInputStatus = "answered" | "dismissed" | "cancelled" | "timed_out";

/** What the agent reads when its card ends without an answer. */
const UNANSWERED_NOTE: Record<Exclude<UserInputStatus, "answered">, string> = {
	dismissed: "The user dismissed the questions without answering. Go on with your best judgement, and say what you assumed.",
	cancelled: "The card closed with the run.",
	timed_out: "No answer in time. Go on with your best judgement and say what you assumed, or end your turn with the questions in your reply.",
};

/** One question as T3's card takes it (`OrchestrationV2UserInputQuestion`). */
type UserInputQuestion = {
	readonly id: string;
	readonly header: string;
	readonly question: string;
	readonly options: readonly { readonly label: string; readonly description: string }[];
	readonly multiSelect?: boolean;
	readonly allowCustomAnswer?: boolean;
};

/** The runtime request of a call: T3's `RuntimeRequestId` for the card of tool call `callId`. */
export const userInputRequestId = (callId: string): string => `uq-${callId}`;

/**
 * The questions of an `ask_user` call as the card shows them, from the call's arguments (a model's, so read with
 * care): an id each (`q1`, `q2`, … where the call names none), and T3's required texts never empty.
 */
export function userInputQuestions(args: Record<string, unknown>): UserInputQuestion[] {
	const text = (value: unknown, fallback: string): string => (typeof value === "string" && value.trim() !== "" ? value.trim() : fallback);
	const questions = Array.isArray(args["questions"]) ? (args["questions"] as unknown[]) : [];
	return questions.flatMap((raw, index) => {
		if (typeof raw !== "object" || raw === null) return [];
		const question = raw as Record<string, unknown>;
		const asked = text(question["question"], "");
		if (asked === "") return [];
		const options = (Array.isArray(question["options"]) ? (question["options"] as unknown[]) : []).flatMap((option) => {
			if (typeof option !== "object" || option === null) return [];
			const label = text((option as Record<string, unknown>)["label"], "");
			return label === "" ? [] : [{ label, description: text((option as Record<string, unknown>)["description"], label) }];
		});
		return [
			{
				id: text(question["id"], `q${index + 1}`),
				header: text(question["header"], `Question ${index + 1}`),
				question: asked,
				options,
				...(question["multiSelect"] === true ? { multiSelect: true } : {}),
				// A question with no options is answered in words; one with options takes other words unless told not to.
				allowCustomAnswer: options.length === 0 || question["allowCustomAnswer"] !== false,
			},
		];
	});
}

type Pending = { readonly conversationId: number; readonly questions: readonly UserInputQuestion[]; readonly settle: (outcome: { status: "answered"; answers: Answers } | { status: "dismissed" }) => void };
/** An answer per question id: the chosen option or the user's own words, or the chosen options. */
export type Answers = Record<string, string | string[]>;
type Outcome = { status: UserInputStatus; answers?: Answers };

/** The questions waiting for an answer, by the asking call's id. In memory: a call that replays after a restart waits again. */
export class UserInputRequests {
	readonly #pending = new Map<string, Pending>();
	readonly #arrivals = new Map<string, Set<() => void>>();
	/** Which thread a conversation is shown as, to check an answer comes from the thread that asked. */
	readonly #threadOf: (conversationId: number) => Promise<string | undefined>;
	readonly #arrivalMs: number;

	constructor(threadOf: (conversationId: number) => Promise<string | undefined>, options: { readonly arrivalMs?: number } = {}) {
		this.#threadOf = threadOf;
		this.#arrivalMs = options.arrivalMs ?? ARRIVAL_MS;
	}

	/** Is `requestId` one of this host's question cards? */
	owns(requestId: string): boolean {
		return requestId.startsWith("uq-");
	}

	/**
	 * T3's `runtime-request.respond` with `answers` (an answer per question id: the chosen option, the chosen options,
	 * or the user's own words), or `thread.user-input.dismiss` (`answers` absent). Refused in T3's words when the card
	 * is no longer waiting.
	 */
	async respond(input: { readonly threadId: string; readonly requestId: string; readonly answers?: Record<string, unknown> }): Promise<void> {
		const callId = input.requestId.slice("uq-".length);
		const pending = await this.#waiting(callId, this.#arrivalMs);
		if (pending === undefined || (await this.#threadOf(pending.conversationId)) !== input.threadId) throw new CommandError(`Runtime request ${input.requestId} is no longer pending.`);
		if (input.answers === undefined) return pending.settle({ status: "dismissed" });
		// Only the questions asked, and only words: an answer is text the model reads.
		const answers: Answers = {};
		for (const question of pending.questions) {
			const answer = input.answers[question.id];
			if (typeof answer === "string") answers[question.id] = answer;
			else if (Array.isArray(answer)) answers[question.id] = answer.filter((value): value is string => typeof value === "string");
		}
		pending.settle({ status: "answered", answers });
	}

	/** The `ask_user` tool. Model-facing: the card is the call itself. */
	extension(): Extension {
		const requests = this;
		return defineExtension({
			name: "t3-ask-user",
			tools: [
				defineTool({
					name: ASK_USER_TOOL,
					description:
						"Ask the user one to four questions in a card in this thread, and wait for the answer. For a decision only the user can make (which of several approaches, a preference, something missing from the request) that the work is blocked on; not for what you can find out yourself, and not to ask permission for what was already asked for. Give each question two to four options when the choices are known (the user can also answer in their own words); leave options out for an open question. Returns the answers by question id, or says that none came.",
					parameters: object({
						questions: arr(
							object({
								question: str({ minLength: 1, description: "The whole question, ending in a question mark." }),
								header: str({ minLength: 1, maxLength: 40, description: "A short label for it, a few words: 'Database', 'Release date'." }),
								id: opt(str({ minLength: 1, maxLength: 64, description: "The key its answer comes back under. Default q1, q2, …" })),
								options: opt(
									arr(
										object({
											label: str({ minLength: 1, description: "The choice, a few words." }),
											description: str({ minLength: 1, description: "What choosing it means." }),
										}),
										{ maxItems: 6 },
									),
								),
								multiSelect: opt(bool({ description: "Several options may be chosen. Default false." })),
								allowCustomAnswer: opt(bool({ description: "The user may answer in their own words instead. Default true." })),
							}),
							{ minItems: 1, maxItems: 4 },
						),
						timeoutMs: opt(int({ minimum: 1000, maximum: MAX_TIMEOUT_MS, description: "How long to wait. Default 30 min." })),
					}),
					callers: ["model"],
					// A rerun after a crash shows the same card (its turn item is the call) and waits again.
					replay: "safe",
					async execute(args, api, context) {
						const questions = userInputQuestions(args as unknown as Record<string, unknown>);
						if (questions.length === 0) throw new Error("ask_user needs at least one question");
						if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("ask_user: each question needs its own id");
						const outcome = await requests.#wait(api.callId, questions, api.conversationId, args.timeoutMs ?? DEFAULT_TIMEOUT_MS, context.abortSignal);
						const result = outcome.status === "answered" ? { status: outcome.status, answers: outcome.answers } : { status: outcome.status, note: UNANSWERED_NOTE[outcome.status] };
						return { output: [{ type: "text", text: JSON.stringify(result) }], details: { userInput: outcome } };
					},
				}),
			],
		});
	}

	/** The call's pending request, waiting up to `ms` for it to start waiting. */
	async #waiting(callId: string, ms: number): Promise<Pending | undefined> {
		const now = this.#pending.get(callId);
		if (now !== undefined) return now;
		await new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				this.#arrivals.get(callId)?.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, ms);
			const waiters = this.#arrivals.get(callId) ?? new Set();
			waiters.add(wake);
			this.#arrivals.set(callId, waiters);
		});
		if (this.#arrivals.get(callId)?.size === 0) this.#arrivals.delete(callId);
		return this.#pending.get(callId);
	}

	#wait(callId: string, questions: readonly UserInputQuestion[], conversationId: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<Outcome> {
		return new Promise<Outcome>((resolve) => {
			const finish = (outcome: Outcome) => {
				if (this.#pending.get(callId) !== pending) return;
				this.#pending.delete(callId);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(outcome);
			};
			const pending: Pending = { conversationId, questions, settle: finish };
			const onAbort = () => finish({ status: "cancelled" });
			const timer = setTimeout(() => finish({ status: "timed_out" }), Math.min(MAX_TIMEOUT_MS, timeoutMs));
			this.#pending.set(callId, pending);
			for (const wake of [...(this.#arrivals.get(callId) ?? [])]) wake();
			if (signal?.aborted === true) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
