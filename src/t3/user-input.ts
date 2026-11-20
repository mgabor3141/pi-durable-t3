// T3's question card (`user_input_request`), on this host: the agent asks the user one to four questions with
// `ask_user`, the thread shows T3's card above the composer (the call is projected as the item and a pending runtime
// request), and the user's answer (`runtime-request.respond`) is what the call returns. The run waits meanwhile, as a
// provider's own question tool does under T3 (its `live` response), and goes on with the answer.
//
// The call parks (pi-durable's tools that park): it holds no process while the card waits, and the answer, or the
// dismissal, is a signal to the call's task that wakes it. The card is the parked call itself, so a restart shows the
// same request and runs no tool code; nothing ends the wait but the user or Stop.
import { defineExtension, defineSignal, defineTool, type Extension, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { arr, bool, lit, map, obj, opt, str, union } from "@earendil-works/pi-schema";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CommandError } from "./errors.ts";
import { object } from "./schema.ts";

/** The tool's name. */
export const ASK_USER_TOOL = "ask_user";

/** The user's answer to a call's card, or its dismissal: the signal that wakes the call. */
const UserInputAnswer = defineSignal({
	name: "t3.user-input",
	version: 1,
	schema: union([obj({ status: lit("answered"), answers: map(union([str(), arr(str())])) }), obj({ status: lit("dismissed") })]),
});
/** The one key a call waits on. */
const ANSWER = "answer";

/** What the agent reads when the user dismissed its card. */
const DISMISSED_NOTE = "The user dismissed the questions without answering. Go on with your best judgement, and say what you assumed.";

/** A model's call that has not ended, in a thread's current round: its tool, its task, which an answer signals, and its
 * arguments. */
export type LiveCall = { readonly name: string; readonly taskId: TaskId; readonly arguments: Readonly<Record<string, unknown>> };
/** What answering a card the call is needs of the bridge. */
export interface CardDeps {
	readonly harness: () => Harness;
	/** The call `callId` in `threadId`'s current round, unless it ended (or there is no such call or thread). */
	readonly liveCall: (threadId: string, callId: string) => Promise<LiveCall | undefined>;
}

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

/** An answer per question id: the chosen option or the user's own words, or the chosen options. */
export type Answers = Record<string, string | string[]>;

/** The answers to `ask_user` calls and their dismissals, delivered to the calls waiting for them. */
export class UserInputRequests {
	readonly #deps: CardDeps;

	constructor(deps: CardDeps) {
		this.#deps = deps;
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
		const gone = new CommandError(`Runtime request ${input.requestId} is no longer pending.`);
		const call = await this.#deps.liveCall(input.threadId, input.requestId.slice("uq-".length));
		// Only a question card's call: an answer never reaches another tool's.
		if (call?.name !== ASK_USER_TOOL) throw gone;
		// Only words: an answer is text the model reads. The call keeps the answers to the questions it asked.
		const answers: Answers = {};
		for (const [id, answer] of Object.entries(input.answers ?? {})) {
			if (typeof answer === "string") answers[id] = answer;
			else if (Array.isArray(answer)) answers[id] = answer.filter((value): value is string => typeof value === "string");
		}
		const value = input.answers === undefined ? ({ status: "dismissed" } as const) : ({ status: "answered", answers } as const);
		const delivered = await this.#deps.harness().signal(call.taskId, UserInputAnswer, ANSWER, value, BACKGROUND_CONTEXT);
		// Answered already (a second click), or the call ended meanwhile.
		if (delivered !== "delivered") throw gone;
	}

	/** The `ask_user` tool. Model-facing: the card is the call itself. */
	extension(): Extension {
		return defineExtension({
			name: "t3-ask-user",
			tools: [
				defineTool({
					name: ASK_USER_TOOL,
					description:
						"Ask the user one to four questions in a card in this thread, and wait for the answer. For a decision only the user can make (which of several approaches, a preference, something missing from the request) that the work is blocked on; not for what you can find out yourself, and not to ask permission for what was already asked for. Give each question two to four options when the choices are known (the user can also answer in their own words); leave options out for an open question. Returns the answers by question id, or that the user dismissed the card.",
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
					}),
					callers: ["model"],
					// It only reads its arguments and its signal: a rerun after a crash before it parked parks again.
					replay: "safe",
					async execute(args, api, context) {
						const questions = userInputQuestions(args as unknown as Record<string, unknown>);
						if (questions.length === 0) throw new Error("ask_user needs at least one question");
						if (new Set(questions.map((question) => question.id)).size !== questions.length) throw new Error("ask_user: each question needs its own id");
						const answer = await api.readSignal(UserInputAnswer, ANSWER, context);
						// Asked: the card shows while the call is parked, until the user answers or dismisses it.
						if (answer === undefined || !("value" in answer)) return { sleep: { signals: [UserInputAnswer.key(ANSWER)] } };
						const value = answer.value;
						// Only the questions asked.
						const outcome: { status: "answered"; answers: Answers } | { status: "dismissed" } =
							value.status === "dismissed" ? { status: "dismissed" } : { status: "answered", answers: Object.fromEntries(questions.flatMap((question) => (value.answers[question.id] === undefined ? [] : [[question.id, value.answers[question.id]!]]))) };
						const result = outcome.status === "answered" ? outcome : { ...outcome, note: DISMISSED_NOTE };
						return { output: [{ type: "text", text: JSON.stringify(result) }], details: { userInput: outcome } };
					},
				}),
			],
		});
	}
}
