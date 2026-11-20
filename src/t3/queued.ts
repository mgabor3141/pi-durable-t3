// The queue view over pi-durable's `pi.inbox`: queued follow-up and steer submissions not yet placed are T3's queued runs. The bridge reads
// the inbox for the projection and mutates the same items for T3's queued-message commands; no separate store.
import type { ContentBlock } from "./model-types.ts";
import { attachmentsOf, type UserAttachment } from "./runs.ts";
import { textOf } from "./thread-search.ts";

/** One queued follow-up or steer, with the inbox fields a queued-message edit or promotion changes. */
interface QueuedInput {
	readonly submissionId: number;
	readonly mode: "steer" | "followUp";
	readonly messageId: string;
	readonly text: string;
	readonly attachments: readonly UserAttachment[];
	/** The inbox item's model content, kept for an edit. */
	readonly content: unknown;
	/** The entry draft the submission will place, when it carries one. */
	readonly entry: { readonly kind: string; readonly data?: Record<string, unknown> } | undefined;
}

/** Read the inbox items that T3 shows as queued runs: follow-ups and steers, in inbox order. */
export function readQueuedInputs(items: readonly unknown[] | undefined): QueuedInput[] {
	return (items ?? []).flatMap((raw): QueuedInput[] => {
		if (typeof raw !== "object" || raw === null) return [];
		const item = raw as { id?: unknown; mode?: unknown; content?: unknown; entry?: unknown };
		if (typeof item.id !== "number" || (item.mode !== "followUp" && item.mode !== "steer")) return [];
		const entry = typeof item.entry === "object" && item.entry !== null
			? item.entry as { kind?: unknown; data?: Record<string, unknown> }
			: undefined;
		const data = entry?.data;
		const messageId = typeof data?.["messageId"] === "string" ? data["messageId"] : `m${item.id}`;
		return [{
			submissionId: item.id,
			mode: item.mode,
			messageId,
			text: textOf(item.content as string | ContentBlock[] | undefined),
			attachments: attachmentsOf(entry ?? {}),
			content: item.content,
			entry: entry === undefined || typeof entry.kind !== "string"
				? undefined
				: { kind: entry.kind, ...(data === undefined ? {} : { data }) },
		}];
	});
}

/** Replace the text block of a queued submission, keeping image blocks. */
export function withQueuedText(content: unknown, text: string): unknown {
	if (!Array.isArray(content)) return text;
	let replaced = false;
	const blocks = content.map((block) => {
		if (!replaced && typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
			replaced = true;
			return { ...(block as Record<string, unknown>), text };
		}
		return block;
	});
	return replaced ? blocks : [{ type: "text", text }, ...blocks];
}
