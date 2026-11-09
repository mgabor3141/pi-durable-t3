// The `messageContext` hook's types, apart from the facet config so the published declarations reach no internals.
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

/**
 * Context for the model about one message, such as memories recalled for it: a text the bridge stores with the message,
 * hidden in T3's display and thread search, or `undefined` for none. Stored with the message, not added per request, so
 * the provider's prompt cache holds.
 */
export type MessageContext = (request: MessageContextRequest) => Promise<string | undefined>;
