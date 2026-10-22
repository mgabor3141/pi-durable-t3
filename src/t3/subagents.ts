// Subagents: a tool call whose `details` carry the `conversationId` of a conversation OWNED BY THAT CALL'S TASK is a
// subagent (pi-durable's convention, README "Abort and Subagents"; the example's tool is `examples/coding-agent`). This
// file is the bridge's whole vocabulary for them: the child thread's id, the discovered `SubagentRef`, and the thread
// title T3 gives a provider-native child (`packages/provider-core/src/server/subagentProjection.ts`, `subagentThreadTitle`).

/** One verified subagent: the child conversation, the tool task that owns it, and the call's arguments. */
export interface SubagentRef {
	/** The child thread's id, derived from the parent thread and the child conversation (`subagentThreadId`). */
	readonly threadId: string;
	readonly parentThreadId: string;
	readonly conversationId: number;
	/** The owning tool call's task: the call is the one whose slot / result entry names this task. */
	readonly taskId: number;
	/** The call's `prompt` and `description` arguments (the convention T3's Task tool uses). */
	readonly prompt: string;
	readonly title: string | null;
	/** When the owning task started: the child thread's creation time. */
	readonly startedAt: number;
}

const SEPARATOR = ".sub.";

/** A deterministic id from the parent thread and the child conversation: nothing is stored. Thread ids may contain `.`. */
export const subagentThreadId = (parentThreadId: string, conversationId: number): string => `${parentThreadId}${SEPARATOR}${conversationId}`;

/** The parent thread and child conversation a derived id names, or `undefined` for an ordinary thread id. */
export function parseSubagentThreadId(threadId: string): { parentThreadId: string; conversationId: number } | undefined {
	const match = /^(.+)\.sub\.(\d+)$/.exec(threadId);
	return match === null ? undefined : { parentThreadId: match[1]!, conversationId: Number(match[2]) };
}

/** The node id of a subagent's call, in the parent's projection. */
export const subagentNodeId = (taskId: number): string => `nsub${taskId}`;

const trimmed = (value: string | null | undefined): string | undefined => {
	const result = value?.trim();
	return result !== undefined && result.length > 0 ? result : undefined;
};

/** T3's `subagentThreadTitle`: the label, else the prompt, clipped to 72 characters; else "<parent> subagent <n>". */
export function subagentThreadTitle(input: { parentTitle: string; title: string | null; prompt: string; ordinal: number }): string {
	const detail = trimmed(input.title) ?? trimmed(input.prompt);
	if (detail === undefined) return `${input.parentTitle} subagent ${input.ordinal}`;
	return detail.length > 72 ? `${detail.slice(0, 69)}...` : detail;
}

/** The `{ conversationId }` a call's details name, or `undefined`. */
export function detailsConversationId(details: unknown): number | undefined {
	const id = (details as { conversationId?: unknown } | null | undefined)?.conversationId;
	return typeof id === "number" ? id : undefined;
}
