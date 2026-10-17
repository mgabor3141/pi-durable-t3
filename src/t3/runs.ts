// What a run is, and what a steer is: one user turn — the user entry that started it plus the entries that followed.
// A leaf: it reads entry shapes only, so the projection, a test, or any other reader groups a conversation the same way.
import type { DurableMessage, EntryRecord } from "./model-types.ts";

export interface RunDraft {
	userEntry: EntryRecord;
	steps: EntryRecord[];
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
 */
export function groupRuns(entries: readonly EntryRecord[]): RunDraft[] {
	const runs: RunDraft[] = [];
	for (const entry of entries) {
		if (isUserEntry(entry)) {
			const current = runs.at(-1);
			if (current !== undefined && endsWithCompletedToolRound(current.steps)) current.steps.push(entry);
			else runs.push({ userEntry: entry, steps: [] });
			continue;
		}
		if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") runs.at(-1)?.steps.push(entry);
	}
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
