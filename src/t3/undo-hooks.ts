// The `undo` hooks: what an integrator keeps of turns outside the conversation (memories written from them) follows
// an undo and a redo. Apart from the facet config, so the published declarations reach no internals.
import type { JsonValue } from "@earendil-works/chord/json";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";

/** An undo that was applied, as `UndoHooks.undone` sees it. */
export type UndoneTurns = {
	readonly threadId: string;
	/**
	 * The conversations this thread has had as its head, the one the undo left first: what its own turns ran in. A
	 * thread that began as a fork of another has that thread's earlier turns in its context too; they ran in a
	 * conversation that is not listed, and are still that thread's.
	 */
	readonly conversations: readonly ConversationId[];
	/** Everything from this entry on was taken back: a turn that reaches it or starts after it is no longer whole. */
	readonly entryId: EntryId;
	/** Aborted when the bridge stops waiting (30 seconds). */
	readonly signal: AbortSignal;
};

/** An undo that was taken back, as `UndoHooks.redone` sees it. */
export type RedoneTurns = {
	readonly threadId: string;
	/** What `undone` resolved with as `kept` for the undo this redo takes back; `undefined` when it kept nothing. */
	readonly kept: JsonValue | undefined;
	readonly signal: AbortSignal;
};

/**
 * What the integrator did, for the user: `note` is a sentence or two of Markdown shown with the command's answer
 * (after T3's own Revert, as a reply of no run). It is shown only, never sent to the model.
 */
export type UndoHookAnswer = { readonly note?: string };

export interface UndoHooks {
	/**
	 * `/undo` or T3's Revert moved the thread back. Take back what you keep of the turns that went; `kept` is stored
	 * with the undo and handed to `redone`.
	 */
	undone(event: UndoneTurns): Promise<(UndoHookAnswer & { readonly kept?: JsonValue }) | undefined>;
	/** `/redo` returned what that undo took. */
	redone(event: RedoneTurns): Promise<UndoHookAnswer | undefined>;
}
