// T3's `request_secret` (`apps/server/src/secrets/SecretRequests.ts`), on this host: the agent asks for a secret by name,
// the thread shows T3's secret card (the call is projected as a `secret_request` item), and the user's answer
// (`secrets.answerRequest`) goes straight to the integrator's store. The value never enters the conversation: the call's
// arguments carry the name and the card's text, its result only the outcome.
//
// One deliberate difference from T3: T3 answers with a one-use `secretRef` that only its own tools accept. Here the
// agent gets the secret's name, which the integrator's tools resolve wherever it is written (`${NAME}`). The card says
// so: it is projected with T3's `file` delivery, whose note reads that the agent's commands can read the value.
import { SecretRequestError, type SecretRequestAnswerInput } from "@t3tools/contracts";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { Type } from "typebox";

/** Where an answered secret goes. The integrator's: this host keeps no secret store of its own. */
export interface SecretSink {
	save(name: string, value: string): Promise<void>;
}

/** The tool's name, as T3's. */
export const REQUEST_SECRET_TOOL = "request_secret";
/** A secret's name: an environment variable's, so a shell can use it as one. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
/** How long an answer waits for its call to start waiting. */
const ARRIVAL_MS = 5_000;

/** The outcome a call reports in its details, for the card. T3's statuses, plus `timed_out` (shown as ended). */
export type SecretRequestStatus = "saved" | "declined" | "cancelled" | "timed_out";

type Pending = {
	readonly name: string;
	readonly sink: SecretSink;
	readonly conversationId: number;
	settled: boolean;
	readonly settle: (outcome: { status: "saved" } | { status: "declined" }) => void;
};

/** The requests waiting for an answer, by the asking call's id (the card's turn item is `ti-t<callId>`). */
export class SecretRequests {
	readonly #pending = new Map<string, Pending>();
	/** Answers that arrived before their call started waiting (the card shows as soon as the call exists, and again
	 * while a call replays after a restart): woken when it does. */
	readonly #arrivals = new Map<string, Set<() => void>>();
	/** Which thread a conversation is shown as, to check an answer comes from the thread that asked. */
	readonly #threadOf: (conversationId: number) => Promise<string | undefined>;
	readonly #arrivalMs: number;

	constructor(threadOf: (conversationId: number) => Promise<string | undefined>, options: { readonly arrivalMs?: number } = {}) {
		this.#threadOf = threadOf;
		this.#arrivalMs = options.arrivalMs ?? ARRIVAL_MS;
	}

	/** The answer to the card `turnItemId` in `threadId`: saved into the asking tool's store, or declined. */
	async answer(input: SecretRequestAnswerInput): Promise<void> {
		const callId = /^ti-t(.+)$/.exec(input.turnItemId)?.[1];
		const pending = callId === undefined ? undefined : await this.#waiting(callId, this.#arrivalMs);
		// Gone from memory: the asking call ended (answered, timed out, stopped) or the host restarted and the call is
		// not waiting again yet.
		if (pending === undefined) throw new SecretRequestError({ reason: "agent_stopped" });
		if ((await this.#threadOf(pending.conversationId)) !== input.threadId) throw new SecretRequestError({ reason: "not_found" });
		if (pending.settled) throw new SecretRequestError({ reason: "already_answered" });
		if (input.answer.type === "decline") {
			pending.settle({ status: "declined" });
			return;
		}
		try {
			await pending.sink.save(pending.name, input.answer.secret);
		} catch (error) {
			throw new SecretRequestError({ reason: "store_failed", cause: error });
		}
		pending.settle({ status: "saved" });
	}

	/** The `request_secret` tool, saving answers into `sink`. Model-facing: the card is the call itself. */
	extension(sink: SecretSink): Extension {
		const requests = this;
		return defineExtension({
			name: "t3-request-secret",
			tools: [
				defineTool({
					name: REQUEST_SECRET_TOOL,
					description:
						"Ask the user to enter a secret (an API key, a password, a token) in a private card in this thread, and wait. The value never enters the chat. Returns the secret's name once saved; write it as ${NAME} wherever the value is needed (tool arguments, MCP config, $NAME in shell commands). Asked how to provide a secret: call this now, do not explain instead.",
					parameters: Type.Object({
						name: Type.String({ pattern: SECRET_NAME.source, description: "The name to save it under, like an environment variable: GITHUB_TOKEN. An existing secret of that name is replaced." }),
						label: Type.String({ minLength: 1, description: "Card title, such as 'GitHub token'." }),
						reason: Type.String({ minLength: 1, description: "What it is for and where to get it." }),
						placeholder: Type.Optional(Type.String()),
						timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS, description: "Default 10 min." })),
					}),
					callers: ["model"],
					// A rerun after a crash shows the same card (its turn item is the call) and waits again.
					replay: "safe",
					async execute(args, api, context) {
						const outcome = await requests.#wait(api.callId, args.name, sink, api.conversationId, args.timeoutMs ?? DEFAULT_TIMEOUT_MS, context.abortSignal);
						const result = outcome === "saved" ? { status: outcome, name: args.name } : { status: outcome };
						return { output: [{ type: "text", text: JSON.stringify(result) }], details: { secretRequest: { status: outcome } } };
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

	#wait(callId: string, name: string, sink: SecretSink, conversationId: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<SecretRequestStatus> {
		return new Promise<SecretRequestStatus>((resolve) => {
			const finish = (status: SecretRequestStatus) => {
				if (this.#pending.get(callId) !== pending) return;
				pending.settled = true;
				this.#pending.delete(callId);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(status);
			};
			const pending: Pending = { name, sink, conversationId, settled: false, settle: (outcome) => finish(outcome.status) };
			const onAbort = () => finish("cancelled");
			const timer = setTimeout(() => finish("timed_out"), Math.min(MAX_TIMEOUT_MS, timeoutMs));
			this.#pending.set(callId, pending);
			for (const wake of [...(this.#arrivals.get(callId) ?? [])]) wake();
			if (signal?.aborted === true) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
