// The `messageContext` hook: its types, and how an integrator reads back what it stored (`messageContextData`). Apart
// from the facet config, so the published declarations reach no internals.
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
	 * call it. `details`, when given, follow `text` in the row under `DISPLAY_ONLY_RULE`: for the user only, never
	 * sent to the model.
	 */
	readonly shownAs: { readonly name: string; readonly input: { readonly [key: string]: JsonValue }; readonly details?: string };
	/**
	 * Kept with the stored block for the integrator to read back later (`messageContextData`), such as the ids of what
	 * was injected. Never sent to the model or shown.
	 */
	readonly data?: JsonValue;
};

/** The line that separates a context row's model text from its display-only `details`. */
export const DISPLAY_ONLY_RULE = "──── shown here only, not sent to the model ────";

/** A message's stored context blocks, as the bridge writes them (a text block, hidden, with `shownAs`). */
type StoredContextBlock = { readonly type: "text"; readonly hidden: true; readonly shownAs: object; readonly data?: JsonValue };

/**
 * The `data` of the context blocks in an entry's messages (`MessageContextAnswer.data`), oldest first: what an
 * integrator stored with each message's context, read back from the transcript (for example the entries still in the
 * model's context, `Conversation.context()`).
 */
export function messageContextData(entry: { readonly model?: readonly { readonly role: string; readonly content?: unknown }[] }): JsonValue[] {
	const found: JsonValue[] = [];
	for (const message of entry.model ?? []) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue;
		for (const block of message.content as Partial<StoredContextBlock>[]) {
			if (block.type === "text" && block.hidden === true && typeof block.shownAs === "object" && block.data !== undefined) found.push(block.data);
		}
	}
	return found;
}

/**
 * Context for the model about one message, such as memories recalled for it, or `undefined` for none. Stored with the
 * message, not added per request, so the provider's prompt cache holds.
 */
export type MessageContext = (request: MessageContextRequest) => Promise<MessageContextAnswer | undefined>;
