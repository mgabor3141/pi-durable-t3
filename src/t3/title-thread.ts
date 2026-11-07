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
	/** T3's text-generation model (Settings), when it names one of this host's models: generate with it. Absent: the
	 * setting is unset or names a model this host does not have, and the thread's own model is the one to use. */
	readonly model?: TextGenerationModel;
};

/** A model for text generation (titles, summaries), from T3's `textGenerationModelSelection` setting. */
export type TextGenerationModel = { readonly provider: string; readonly modelId: string; readonly thinkingLevel?: string };

/** The integrator's title generator: a title, or `undefined` / "New thread" (/ the same title on regenerate) for no change. */
export type TitleThread = (request: TitleThreadRequest) => Promise<string | undefined>;
