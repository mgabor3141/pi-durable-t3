// The queue view over pi-durable's `pi.inbox`: queued follow-up submissions are T3's queued runs. The bridge reads
// the inbox for the projection and mutates the same items for T3's queued-message commands; no separate store.
import type { UserAttachment } from "./runs.ts";

/** One queued follow-up, with the inbox fields a queued-message edit or promotion changes. */
export interface QueuedInput {
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

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block): string[] => {
		if (typeof block !== "object" || block === null) return [];
		const value = block as { type?: unknown; text?: unknown };
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("");
};

const attachmentsOf = (entry: { readonly data?: Record<string, unknown> } | undefined): UserAttachment[] => {
	const list = entry?.data?.["attachments"];
	if (!Array.isArray(list)) return [];
	return list.flatMap((item): UserAttachment[] => {
		if (typeof item !== "object" || item === null) return [];
		const value = item as Record<string, unknown>;
		if (value["type"] !== "image" || typeof value["id"] !== "string") return [];
		return [{
			type: "image",
			id: value["id"],
			name: typeof value["name"] === "string" ? value["name"] : "image",
			mimeType: typeof value["mimeType"] === "string" ? value["mimeType"] : "application/octet-stream",
			sizeBytes: typeof value["sizeBytes"] === "number" ? value["sizeBytes"] : 0,
		}];
	});
};

/** Read the inbox items that T3 shows as queued runs: follow-ups only, in inbox order. */
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
			text: textOf(item.content),
			attachments: attachmentsOf(entry),
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
