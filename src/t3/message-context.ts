// The `messageContext` hook's types, apart from the facet config so the published declarations reach no internals.
import type { JsonValue } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";

/** A message about to start or steer a turn, as `attachT3`'s `messageContext` hook sees it. */
export type MessageContextRequest = {
	readonly threadId: string;
	/** The thread's head conversation. */
	readonly conversationId: ConversationId;
	/** The message as it was sent. */
	readonly text: string;
	/** Aborted when the bridge stops waiting (`MESSAGE_CONTEXT_TIMEOUT_MS`). */
	readonly signal: AbortSignal;
};

/** Context for the model about one message, and how T3 shows it. */
export type MessageContextAnswer = {
	/** What the model gets with the message: stored with it, outside the message's own text and thread search. */
	readonly text: string;
	/**
	 * The row T3 shows right after the message, so the user sees what the model was given: a tool call named `name`
	 * with `input` (what the context was looked up with), whose output is `text`. No tool ran; the agent did not
	 * call it.
	 */
	readonly shownAs: { readonly name: string; readonly input: { readonly [key: string]: JsonValue } };
};

/**
 * Context for the model about one message, such as memories recalled for it, or `undefined` for none. Stored with the
 * message, not added per request, so the provider's prompt cache holds.
 */
export type MessageContext = (request: MessageContextRequest) => Promise<MessageContextAnswer | undefined>;
