// What a run is, and what a steer is: one user turn — the user entry that started it plus the entries that followed.
// A leaf: it reads entry shapes only, so the projection, a test, or any other reader groups a conversation the same way.
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

export const firstMessage = (entry: EntryRecord): DurableMessage | undefined => entry.model?.[0];
/**
 * Entry kinds that carry a user turn: pi-durable's default placement, and this host's `app.user`, which rides the
 * client's message id in the entry's `data` (see `Threads.submit`).
 */
export const USER_ENTRY_KINDS: ReadonlySet<string> = new Set(["pi.user", "app.user"]);
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
