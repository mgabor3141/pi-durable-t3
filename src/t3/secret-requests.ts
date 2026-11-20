// T3's `request_secret` (`apps/server/src/secrets/SecretRequests.ts`), on this host: the agent asks for a secret by name,
// the thread shows T3's secret card (the call is projected as a `secret_request` item), and the user's answer
// (`secrets.answerRequest`) goes straight to the integrator's store. The value never enters the conversation: the call's
// arguments carry the name and the card's text, its result only the outcome.
//
// One deliberate difference from T3: T3 answers with a one-use `secretRef` that only its own tools accept. Here the
// agent gets the secret's name, which the integrator's tools resolve wherever it is written (`${NAME}`). The card says
// so: it is projected with T3's `file` delivery, whose note reads that the agent's commands can read the value.
//
// The call parks (pi-durable's tools that park): it holds no process while the card waits, and the answer is a signal to
// the call's task, sent once the store took the value (or with the decline), that wakes it. The card is the parked call
// itself, so a restart shows the same card and runs no tool code; nothing ends the wait but the user or Stop.
import { SecretRequestError, type SecretRequestAnswerInput } from "@t3tools/contracts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineSignal, defineTool, type Extension } from "@earendil-works/pi-durable";

import type { SecretSink } from "./secret-sink.ts";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { object } from "./schema.ts";
import type { CardDeps } from "./user-input.ts";

/** The tool's name, as T3's. */
export const REQUEST_SECRET_TOOL = "request_secret";
/** A secret's name: an environment variable's, so a shell can use it as one. */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

/** The user's answer to a call's card: the signal that wakes the call. Never the value, which goes to the store. */
const SecretAnswer = defineSignal({ name: "t3.secret-request", version: 1, schema: obj({ status: oneOf(["saved", "declined"]) }) });
/** The one key a call waits on. */
const ANSWER = "answer";

/** What the agent reads when the user declined (T3's `SECRET_REQUEST_UNSAVED_NOTE`, without its retry key, which this
 * tool does not have: a new call is a new card). */
const DECLINED_NOTE = "The user declined. Don't ask for it in chat or another way; say what's blocked and go on without it.";

/** T3's `secretRequestPageUrl`: the http(s) page a secret card may open. */
const isPageUrl = (value: string): boolean => {
	if (!URL.canParse(value)) return false;
	const url = new URL(value);
	return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "";
};

/** The answers to `request_secret` calls (the card's turn item is `ti-t<callId>`): saved into the store, then delivered to
 * the call waiting for them. */
export class SecretRequests {
	readonly #deps: CardDeps & { readonly hasThread: (threadId: string) => boolean };
	readonly #onSaved: ((threadId: string) => Promise<void>) | undefined;
	/** Where answers are saved: the store the tool was installed with (`extension`). */
	#sink: SecretSink | undefined;

	/** `onSaved`: told the thread of each secret saved, after the store took it (T3 wakes a snoozed thread then). */
	constructor(deps: CardDeps & { readonly hasThread: (threadId: string) => boolean }, options: { readonly onSaved?: (threadId: string) => Promise<void> } = {}) {
		this.#deps = deps;
		this.#onSaved = options.onSaved;
	}

	/** The answer to the card `turnItemId` in `threadId`: saved into the store, or declined. */
	async answer(input: SecretRequestAnswerInput): Promise<void> {
		if (!this.#deps.hasThread(input.threadId)) throw new SecretRequestError({ reason: "not_found" });
		const callId = /^ti-t(.+)$/.exec(input.turnItemId)?.[1];
		const call = callId === undefined ? undefined : await this.#deps.liveCall(input.threadId, callId);
		// No such call waiting in the thread: it ended (answered, stopped), or it is no request_secret's card.
		const name = call?.arguments["name"];
		const sink = this.#sink;
		if (call === undefined || sink === undefined || typeof name !== "string" || !SECRET_NAME.test(name)) throw new SecretRequestError({ reason: "agent_stopped" });
		// T3 0.1.9's answer from a secret provider (1Password and the like). This host configures none and does not
		// advertise `secretRequestReferences`, so its clients do not offer it; one that sends it anyway is told.
		if (input.answer.type === "reference") throw new SecretRequestError({ reason: "reference_unreadable", provider: input.answer.reference.provider });
		// Answered already: an answer woke the call, which may not have ended yet. T3 refuses before it stores, so a late
		// answer saves nothing. (Not "is it asleep": an answer may come before the call parked, and pi keeps it.)
		const state = (await this.#deps.harness().getTask(call.taskId, BACKGROUND_CONTEXT))?.state as { readonly checkpoint?: { readonly wake?: unknown } } | undefined;
		if (state?.checkpoint?.wake !== undefined) throw new SecretRequestError({ reason: "already_answered" });
		if (input.answer.type === "save") {
			try {
				await sink.save(name, input.answer.secret);
			} catch (error) {
				throw new SecretRequestError({ reason: "store_failed", cause: error });
			}
		}
		const status = input.answer.type === "save" ? "saved" : "declined";
		const delivered = await this.#deps.harness().signal(call.taskId, SecretAnswer, ANSWER, { status }, BACKGROUND_CONTEXT);
		if (delivered === "duplicate") throw new SecretRequestError({ reason: "already_answered" });
		if (delivered !== "delivered") throw new SecretRequestError({ reason: "agent_stopped" });
		// The secret is saved and the call has its answer; what follows must not turn that into a failure.
		if (status === "saved") await this.#onSaved?.(input.threadId).catch(() => {});
	}

	/** The `request_secret` tool, saving answers into `sink`. Model-facing: the card is the call itself. */
	extension(sink: SecretSink): Extension {
		// One store: an answer is saved where the tool that asked says, and a card may be answered after a restart, when
		// only the store given now is known.
		if (this.#sink !== undefined && this.#sink !== sink) throw new Error("request_secret saves into one store: secretRequests was given another one already");
		this.#sink = sink;
		return defineExtension({
			name: "t3-request-secret",
			tools: [
				defineTool({
					name: REQUEST_SECRET_TOOL,
					description:
						"Ask the user to enter a secret (an API key, a password, a token) in a private card in this thread, and wait. The value never enters the chat. Returns the secret's name once saved; write it as ${NAME} wherever the value is needed (tool arguments, MCP config, $NAME in shell commands). Asked how to provide a secret: call this now, do not explain instead.",
					parameters: object({
						name: str({ pattern: SECRET_NAME.source, description: "The name to save it under, like an environment variable: GITHUB_TOKEN. An existing secret of that name is replaced." }),
						label: str({ minLength: 1, description: "Card title, such as 'GitHub token'." }),
						reason: str({ minLength: 1, description: "What it is for and where to get it. A link goes in `url`." }),
						url: opt(str({ minLength: 1, description: "Sign-in or setup page for the value (http or https). Shown as a button." })),
						placeholder: opt(str()),
					}),
					callers: ["model"],
					// It only reads its arguments and its signal: a rerun after a crash before it parked parks again.
					replay: "safe",
					async execute(args, api, context) {
						// Refused before the card waits: T3's schema refuses the same at the call.
						if (args.url !== undefined && !isPageUrl(args.url.trim())) throw new Error("url must be an http(s) URL");
						const answer = await api.readSignal(SecretAnswer, ANSWER, context);
						// Asked: the card shows while the call is parked, until the user saves a value or declines.
						if (answer === undefined || !("value" in answer)) return { sleep: { signals: [SecretAnswer.key(ANSWER)] } };
						const status = answer.value.status;
						const result = status === "saved" ? { status, name: args.name } : { status, note: DECLINED_NOTE };
						return { output: [{ type: "text", text: JSON.stringify(result) }], details: { secretRequest: { status } } };
					},
				}),
			],
		});
	}
}
