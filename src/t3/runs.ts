// What a run is, and what a steer is: one user turn — the user entry that started it plus the entries that followed.
// A leaf: it reads entry shapes only, so the projection, a test, or any other reader groups a conversation the same way.
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import type { DurableMessage, EntryRecord } from "./model-types.ts";

export interface RunDraft {
	/** The entry that anchors the run: normally the user prompt; a compaction summary when a compaction kept a tail
	 * that starts inside a turn (`synthetic`). */
	userEntry: EntryRecord;
	steps: EntryRecord[];
	/** The anchor is a compaction summary, not a prompt. The kept entries have no user turn of their own, so the run
	 * has no user entry to rewind to and the projection shows the compaction card where the prompt would be. */
	synthetic?: boolean;
	/** The compaction divider that belongs immediately before this run: at the cut, after the history it replaces. */
	card?: EntryRecord;
	/** A compaction that kept nothing: the draft carries only its card, no run. */
	markerOnly?: boolean;
}

export const APP_COMPACT_ENTRY = "app.compact";

/** The text a compact command entry carries for display; the entry has no model messages, so pi never sees it. */
const compactCommandMessage = (entry: EntryRecord): DurableMessage | undefined => {
	const data = entry.data;
	if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const text = (data as { text?: unknown }).text;
	if (typeof text !== "string") return undefined;
	const timestamp = (data as { timestamp?: unknown }).timestamp;
	return { role: "user", content: [{ type: "text", text }], ...(typeof timestamp === "number" ? { timestamp } : {}) };
};

/** A display-only `/compact` command. It anchors the compaction run for T3, but pi ignores it because it has no model. */
export const isCompactCommandEntry = (entry: EntryRecord): boolean =>
	entry.kind === APP_COMPACT_ENTRY ||
	(entry.kind === "app.user" && (entry.data as { compact?: unknown } | undefined)?.compact === true);

/** Model-visible message, or the display-only command T3 shows for a manual compaction. */
export const firstMessage = (entry: EntryRecord): DurableMessage | undefined =>
	entry.model?.[0] ?? (entry.kind === APP_COMPACT_ENTRY ? compactCommandMessage(entry) : undefined);
/**
 * Entry kinds that carry a user turn: pi-durable's default placement, this host's `app.user`, which rides the
 * client's message id in the entry's `data` (see `Threads.submit`), and the display-only compact command.
 */
export const USER_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.user", "app.user", APP_COMPACT_ENTRY]);
export const isUserEntry = (entry: EntryRecord) => USER_ENTRY_KINDS.has(entry.kind) && firstMessage(entry)?.role === "user";
/** The client's message id a user entry carries in its `data` (`app.user` entries set it), if it carries one. */
export const messageIdOf = (entry: EntryRecord): string | undefined => {
	const data = entry.data;
	if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const id = (data as { messageId?: unknown }).messageId;
	return typeof id === "string" ? id : undefined;
};

/** A persisted image or file on a message, as the projection reports it (T3's `ChatAttachment`). */
export type UserAttachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number };

/** The images a user entry carries in its `data` (`app.user` entries set them — `Threads.submit`); empty for a
 * message with none. The projection reports these as the message's attachments, so the thread shows them after a
 * restart (the record is durable; the bytes live in the bridge's attachment store). */
export const attachmentsOf = (entry: EntryRecord): UserAttachment[] => {
	const data = entry.data;
	if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) return [];
	const list = (data as { attachments?: unknown }).attachments;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item): UserAttachment[] => {
		if (typeof item !== "object" || item === null) return [];
		const a = item as Record<string, unknown>;
		if ((a.type !== "image" && a.type !== "file" && a.type !== undefined) || typeof a.id !== "string") return [];
		const type = a.type === "file" ? "file" : "image";
		return [{ type, id: a.id, name: String(a.name ?? (type === "file" ? "file" : "image")), mimeType: String(a.mimeType ?? "application/octet-stream"), sizeBytes: Number(a.sizeBytes ?? 0) }];
	});
};
export type MessageContext = OrchestrationMessageContext;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The composer context a user entry carries in its `data` (`Threads.submit`); T3 resolves its text references
 * against these records. Empty for a message without one. */
export const contextOf = (entry: EntryRecord): MessageContext | undefined => {
	const data = entry.data;
	if (!isRecord(data)) return undefined;
	const context = data.context;
	if (!isRecord(context) || context.version !== 1 || !Array.isArray(context.records)) return undefined;
	const records = context.records.filter(isRecord).map((record) => ({ ...record }));
	return { version: 1, records } as unknown as MessageContext;
};

/** Older entries only kept the attachment list, not the composer context. Rebuild the image/file records from the
 * text's `t3-context://v1/<kind>/<id>` references and the attachments they name, so their inline labels do not show
 * "(unavailable)" after the client lost its composer state. */
export const contextFromText = (text: string, attachments: readonly UserAttachment[]): MessageContext | undefined => {
	if (!text.includes("t3-context://v1/") || attachments.length === 0) return undefined;
	const used = new Set<number>();
	const records: Record<string, unknown>[] = [];
	for (const match of text.matchAll(/!?\[([^\]]*)\]\(t3-context:\/\/v1\/(image|file)\/([a-z0-9_-]+)\)/gi)) {
		const kind = match[2] === "file" ? "file" : "image";
		const contextId = match[3]!;
		let index = attachments.findIndex((attachment, i) => !used.has(i) && attachment.type === kind && attachment.name === match[1]);
		if (index < 0) index = attachments.findIndex((attachment, i) => !used.has(i) && attachment.type === kind);
		if (index < 0) continue;
		used.add(index);
		const attachment = attachments[index]!;
		const label = (match[1] === "" ? attachment.name : match[1]!).slice(0, 200);
		records.push({
			version: 1,
			contextId,
			kind,
			label,
			attachmentId: attachment.id,
			name: attachment.name,
			mimeType: attachment.mimeType,
			sizeBytes: attachment.sizeBytes,
		});
	}
	return records.length === 0 ? undefined : ({ version: 1, records } as unknown as MessageContext);
};
export const isAssistantEntry = (entry: EntryRecord) => firstMessage(entry)?.role === "assistant";
export const stopReason = (entry: EntryRecord | undefined) => {
	const message = entry === undefined ? undefined : firstMessage(entry);
	return message?.role === "assistant" ? message.stopReason : undefined;
};

/** A tool result the Harness wrote because the run was aborted (interrupt) while the tool ran. */
export const isAbortedToolResult = (entry: EntryRecord) =>
	entry.kind === "pi.tool-result" &&
	((entry.data as { diagnostics?: { code?: string }[] } | undefined)?.diagnostics ?? []).some(
		(diagnostic) => diagnostic.code === "aborted",
	);

/**
 * Split active entries into runs. A user entry is a steer of the current run only when the run was demonstrably
 * still going: its last step is a completed tool round (every call of the last assistant entry has a result, none of
 * them aborted). After an interrupted tool round the run has ended, so the next user entry starts a new one.
 *
 * A compaction is a context head, not a step of a run: it closes the run before it and its card belongs at the cut.
 * When the cut fell inside a turn (pi's split-turn compaction) the kept tail starts with assistant/tool entries that
 * no user prompt precedes, so the compaction entry anchors a synthetic run and the tail stays visible instead of
 * being dropped. A compaction that kept a user turn attaches its card to that turn's run; one that kept nothing is a
 * marker-only draft.
 */
export function groupRuns(entries: readonly EntryRecord[]): RunDraft[] {
	const runs: RunDraft[] = [];
	let steerable = false;
	let pendingCard: EntryRecord | undefined;
	for (const [index, entry] of entries.entries()) {
		if (entry.kind === "pi.compaction") {
			steerable = false;
			pendingCard = entry;
			const next = entries[index + 1];
			if (next !== undefined && !isUserEntry(next)) {
				runs.push({ userEntry: entry, steps: [], synthetic: true, card: entry });
				pendingCard = undefined;
			}
			continue;
		}
		if (isCompactCommandEntry(entry)) {
			// The display-only command always starts its own compaction run; it is never a steer of a tool round.
			runs.push({ userEntry: entry, steps: [], ...(pendingCard === undefined ? {} : { card: pendingCard }) });
			pendingCard = undefined;
			steerable = false;
			continue;
		}
		if (isUserEntry(entry)) {
			const current = runs.at(-1);
			if (steerable && current !== undefined && endsWithCompletedToolRound(current.steps)) current.steps.push(entry);
			else {
				runs.push({ userEntry: entry, steps: [], ...(pendingCard === undefined ? {} : { card: pendingCard }) });
				pendingCard = undefined;
				steerable = true;
			}
			continue;
		}
		if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") runs.at(-1)?.steps.push(entry);
	}
	if (pendingCard !== undefined) runs.push({ userEntry: pendingCard, steps: [], synthetic: true, card: pendingCard, markerOnly: true });
	return runs;
}

function endsWithCompletedToolRound(steps: readonly EntryRecord[]): boolean {
	const lastAssistantIndex = steps.findLastIndex(isAssistantEntry);
	if (lastAssistantIndex < 0) return false;
	const assistant = firstMessage(steps[lastAssistantIndex]!);
	if (assistant?.role !== "assistant" || assistant.stopReason !== "toolUse") return false;
	const results = steps.slice(lastAssistantIndex + 1).filter((step) => step.kind === "pi.tool-result");
	if (results.length === 0 || results.some(isAbortedToolResult)) return false;
	const answered = new Set(
		results.flatMap((step) => {
			const message = firstMessage(step);
			return message?.role === "toolResult" ? [message.toolCallId] : [];
		}),
	);
	return assistant.content.every((block) => block.type !== "toolCall" || answered.has(block.id));
}
