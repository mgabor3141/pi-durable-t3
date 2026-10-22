// The `titleThread` hook's types, apart from the facet config so the published declarations reach no internals.
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";

/** What the bridge asks of `attachT3`'s `titleThread` hook (T3's `ThreadTitleRegenerationService` input, on pi's terms). */
export type TitleThreadRequest = {
	readonly threadId: string;
	/** The thread's head conversation. */
	readonly conversationId: ConversationId;
	/** "first-message": the first user entry; "regenerate": the head's latest entry. */
	readonly at: EntryId;
	readonly reason: "first-message" | "regenerate";
	/** The title being replaced; "regenerate" only. */
	readonly previousTitle?: string;
	/** Aborted when a rename or a newer request supersedes this one. */
	readonly signal: AbortSignal;
};

/** The integrator's title generator: a title, or `undefined` / "New thread" (/ the same title on regenerate) for no change. */
export type TitleThread = (request: TitleThreadRequest) => Promise<string | undefined>;
