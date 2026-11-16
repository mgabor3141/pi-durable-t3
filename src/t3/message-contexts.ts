// A message's context from the integrator (`T3Attachment.messageContext`, such as memories recalled for it), asked for
// inside the run the message starts or steers, not while the message is sent: the sender is answered at once, and the
// run's next request waits for the context instead, where the thread shows as working and Stop ends the wait.
//
// A `beforeRequest` hook does it. For each of the user's messages no request has answered yet:
// - it asks the integrator (at most `MESSAGE_CONTEXT_TIMEOUT_MS`) and keeps the answer as the run's memo, so a request
//   sent again (a retry, a restart) carries the same bytes;
// - it puts the context block into that message for this request;
// - it admits a write whose context edit replaces the message's entry with the same message and block, which
//   pi-durable places at the run's next boundary. Every later request reads the edit, with the same bytes at the same
//   place, so the provider's prompt cache holds.
// A message a request has answered is never touched: changing it would change the start of every request after it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineExtension, GenerationTask, hook, type ConversationId, type EntryRecord as DurableEntry, type Extension, type Harness } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { Logger } from "./logging.ts";
import type { MessageContext, MessageContextAnswer } from "./message-context.ts";
import type { ContentBlock } from "./model-types.ts";
import { textOf } from "./thread-search.ts";
import { messageOf } from "../host-errors.ts";

/** How long a run's request waits for the integrator's context for a message before it goes on without it. */
export const MESSAGE_CONTEXT_TIMEOUT_MS = 5_000;
/** The entry whose context edit adds a message's context to it. No model messages of its own. */
export const APP_MESSAGE_CONTEXT_ENTRY = "app.message-context";
/** In a user entry's data: the message gets the integrator's context before a request answers it. */
export const AWAITS_CONTEXT = "awaitsContext";
/** How far back a request looks for messages it is the first to answer: a run's tool results lie between. */
const LOOK_BACK = 200;
/** Contexts shown before their edit is placed, kept at most. */
const MAX_PENDING = 200;
/** The memo of a message the integrator had no context for. */
const NONE = { none: true } as const;

type Host = {
	readonly harness: Harness;
	readonly log: Logger;
	threadIdForConversation(conversationId: number): Promise<string | undefined>;
	/** A thread's rows changed without an entry: show it again. */
	changed(threadId: string): void;
};

/** The block a context is stored as: model-visible, hidden from the message's text, shown as the row it names. */
function contextBlock(answer: MessageContextAnswer): ContentBlock {
	return {
		type: "text",
		text: answer.text,
		hidden: true,
		shownAs: { name: answer.shownAs.name, input: { ...answer.shownAs.input }, ...(answer.shownAs.details === undefined || answer.shownAs.details.trim() === "" ? {} : { details: answer.shownAs.details }) },
		...(answer.data === undefined ? {} : { data: answer.data }),
	};
}

/** `message` with `block` after its own text, before anything else it carries (attachments). */
function withContext<M extends { content: unknown }>(message: M, block: ContentBlock): M {
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : [...(message.content as unknown[])];
	content.splice(1, 0, block);
	return { ...message, content };
}

const answered = (entry: DurableEntry): boolean =>
	(entry.model ?? []).some((message) => message.role === "assistant" && (message.usage?.input ?? 0) + (message.usage?.cacheRead ?? 0) + (message.usage?.cacheWrite ?? 0) > 0);

/** The context blocks context edits gave to messages, by the message's entry: what `entries` hold of them. */
export function contextEdits(entries: readonly { readonly kind: string; readonly edits?: readonly { readonly target: number; readonly messages?: readonly { readonly content?: unknown }[] }[] }[]): Map<number, ContentBlock[]> {
	const found = new Map<number, ContentBlock[]>();
	for (const entry of entries) {
		if (entry.kind !== APP_MESSAGE_CONTEXT_ENTRY) continue;
		for (const edit of entry.edits ?? []) {
			const content = edit.messages?.[0]?.content;
			if (Array.isArray(content)) found.set(edit.target, content as ContentBlock[]);
		}
	}
	return found;
}

export class MessageContexts {
	readonly #host: Host;
	#hook: MessageContext | undefined;
	/** Contexts a request was sent with, by the message's entry, until their edit is placed: the row shows meanwhile. */
	readonly #pending = new Map<number, ContentBlock>();

	constructor(host: Host) {
		this.#host = host;
	}

	/** Whether an integrator gives context: messages are marked to get it only then. */
	get active(): boolean {
		return this.#hook !== undefined;
	}

	/** The contexts not placed yet, by the message's entry (`ThreadMeta.pendingContexts`). */
	get pending(): ReadonlyMap<number, ContentBlock> {
		return this.#pending;
	}

	/** The integrator's answer for one message: at most `MESSAGE_CONTEXT_TIMEOUT_MS`; a failure is logged, not fatal. */
	async #ask(threadId: string, conversationId: ConversationId, text: string, stopped: AbortSignal | undefined): Promise<MessageContextAnswer | undefined> {
		const signal = stopped === undefined ? AbortSignal.timeout(MESSAGE_CONTEXT_TIMEOUT_MS) : AbortSignal.any([AbortSignal.timeout(MESSAGE_CONTEXT_TIMEOUT_MS), stopped]);
		const late = () => new Error(`no answer within ${MESSAGE_CONTEXT_TIMEOUT_MS} ms`);
		try {
			const answer = await Promise.race([
				this.#hook!({ threadId, conversationId, text, signal }),
				new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(late()), { once: true })),
			]);
			// An answer that settled as the wait ended (a hook resolving on its abort) is as late as none.
			if (signal.aborted) throw late();
			if (answer === undefined || answer.text.trim() === "") return undefined;
			if (typeof answer.shownAs?.name !== "string" || answer.shownAs.name.trim() === "") throw new Error("the answer names no shownAs.name");
			return answer;
		} catch (error) {
			if (stopped?.aborted !== true) this.#host.log.warn("message context failed; the message goes on without it", { threadId, error: messageOf(error) });
			return undefined;
		}
	}

	/** `T3Attachment.messageContext`: the extension that gives each message its context. One integrator. */
	extension(messageContext: MessageContext): Extension {
		if (this.#hook !== undefined) throw new Error("messageContext is installed already: one integrator gives a message's context");
		this.#hook = messageContext;
		return defineExtension({
			name: "t3-message-context",
			hooks: [
				hook(GenerationTask, {
					beforeRequest: async (request, api, context) => {
						const page = await api.entries({ order: "descending" }, LOOK_BACK, undefined, context);
						// Newest first, down to the last request that was answered: the messages above it are what this
						// request is the first to answer. Those a context edit names have theirs already.
						const placed = new Set<number>();
						const waiting: DurableEntry[] = [];
						for (const entry of page.items) {
							if (answered(entry)) break;
							if (entry.kind === APP_MESSAGE_CONTEXT_ENTRY) for (const edit of entry.edits ?? []) placed.add(edit.target as number);
							else if ((entry.data as { [AWAITS_CONTEXT]?: unknown } | undefined)?.[AWAITS_CONTEXT] === true && entry.model?.[0]?.role === "user" && !placed.has(entry.id as number)) waiting.unshift(entry);
						}
						for (const target of placed) this.#pending.delete(target);
						if (waiting.length === 0) return undefined;
						const threadId = await this.#host.threadIdForConversation(api.conversationId as number);
						if (threadId === undefined) return undefined;
						// A context shown for one of these was a run's that an undo took back: this run asks again.
						if (waiting.map((entry) => this.#pending.delete(entry.id as number)).includes(true)) this.#host.changed(threadId);
						const blocks = await Promise.all(
							waiting.map(async (entry) => {
								const name = `t3.message-context:${entry.id}`;
								let kept = await api.memo<JsonValue>(name, context);
								if (kept === undefined) {
									const answer = await this.#ask(threadId, api.conversationId, textOf(entry.model![0]!.content as string | ContentBlock[]), context.abortSignal);
									// Stopped while it waited: nothing is kept, so the message's next run asks again.
									if (context.abortSignal?.aborted === true) return undefined;
									kept = await api.memo<JsonValue>(name, (answer === undefined ? NONE : contextBlock(answer)) as unknown as JsonValue, context);
								}
								return (kept as { none?: boolean }).none === true ? undefined : (kept as unknown as ContentBlock);
							}),
						);
						let messages = request.messages;
						let shown = false;
						for (const [index, entry] of waiting.entries()) {
							const block = blocks[index];
							if (block === undefined) continue;
							const own = entry.model![0]!;
							// The message as this request carries it: another hook may have changed its content.
							const at = messages.findLastIndex((message) => message.role === "user" && message.timestamp === own.timestamp);
							if (at < 0) continue;
							messages = messages.map((message, position) => (position === at ? (withContext(message, block) as Message) : message));
							const conversation = await this.#host.harness.conversation(api.conversationId, BACKGROUND_CONTEXT);
							await conversation
								?.submit(
									{ type: "write", requestId: `message-context:${entry.id}`, entry: { kind: APP_MESSAGE_CONTEXT_ENTRY, edits: [{ target: entry.id, action: "replace", messages: [withContext(own, block) as Message] }] } },
									BACKGROUND_CONTEXT,
								)
								.catch((error: unknown) => this.#host.log.warn("message context: the edit was not admitted; later requests go without it", { threadId, error: messageOf(error) }));
							this.#pending.delete(entry.id as number);
							this.#pending.set(entry.id as number, block);
							if (this.#pending.size > MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value as number);
							shown = true;
						}
						if (shown) this.#host.changed(threadId);
						return messages === request.messages ? undefined : { messages };
					},
				}),
			],
		});
	}
}
