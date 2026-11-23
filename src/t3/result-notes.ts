// What a tool result says besides its output: its notes (pi-durable's diagnostics: an exit code, a timeout, a Stop, a
// cut-off output), and how this bridge reads them from a stored result. pi-durable renders them after the output in a
// block of its own and keeps the list in the result entry's `data`; `plainResultsExtension` (`plain-results.ts`)
// writes them as plain lines instead and keeps the list in the result's details (`NOTES`). Both are read here, so a result
// written either way is shown the same: which call a Stop cut off decides where a run ends (`isAbortedToolResult`), and
// a command's exit code is T3's to show.
import type { EntryRecord } from "./model-types.ts";

/** One thing a result says besides its output (pi-durable's `ToolDiagnostic`). */
export type ResultNote = { readonly severity: "info" | "warn" | "error"; readonly message: string; readonly code?: string };

/** Where a result written plainly keeps its notes: in its details, under this name (not one a tool would use for
 * details of its own). */
export const NOTES = "plainResultNotes";
const EXIT_CODE = /^Command exited with code (-?\d+)$/u;

/** Anything that names a code or says something: a note is read by its code, and one without words says none. */
const isNote = (value: unknown): value is ResultNote => typeof value === "object" && value !== null && (typeof (value as { code?: unknown }).code === "string" || typeof (value as { message?: unknown }).message === "string");

/**
 * The notes a stored result was written with: pi-durable's own (the entry's `data.diagnostics`), and, where
 * `plainResultsExtension` wrote them as lines, the list it kept in the result's details.
 */
export function notesOf(entry: EntryRecord): readonly ResultNote[] {
	const stored = (entry.data as { diagnostics?: unknown } | undefined)?.diagnostics;
	const message = entry.model?.[0] as { role?: string; details?: unknown } | undefined;
	const details = message?.role === "toolResult" && typeof message.details === "object" && message.details !== null ? (message.details as Record<string, unknown>)[NOTES] : undefined;
	return [...(Array.isArray(stored) ? stored : []), ...(Array.isArray(details) ? details : [])].filter(isNote);
}

/** A command's exit code, from the note pi-durable's `bash` ends a failed command with. */
export function exitCodeOf(notes: readonly ResultNote[]): number | undefined {
	const note = notes.find((each) => each.code === "exit_code");
	const code = note === undefined ? undefined : EXIT_CODE.exec(String(note.message ?? "").trim())?.[1];
	return code === undefined ? undefined : Number(code);
}

/**
 * A command's output without the line that says its exit code, in either form a result has it: the plain line, or its
 * line in pi-durable's block (and the block, when that was its only line). For T3, which shows the code itself.
 */
export function withoutExitLine(output: string, notes: readonly ResultNote[]): string {
	const note = notes.find((each) => each.code === "exit_code");
	if (note === undefined || typeof note.message !== "string") return output;
	const line = note.message.trim();
	const block = `<harness>\n[${note.severity}] ${line}\n</harness>`;
	if (output.endsWith(block)) return output.slice(0, -block.length);
	const inBlock = `\n[${note.severity}] ${line}\n`;
	const at = output.lastIndexOf(inBlock);
	if (at >= 0 && output.indexOf("</harness>", at) >= 0 && output.lastIndexOf("<harness>", at) >= 0) return `${output.slice(0, at)}\n${output.slice(at + inBlock.length)}`;
	if (output === line) return "";
	// Its paragraph among the plain lines, with the blank line before it.
	const paragraph = output.lastIndexOf(`\n\n${line}`);
	const rest = paragraph < 0 ? undefined : output.slice(paragraph + 2 + line.length);
	if (rest !== undefined && (rest === "" || rest.startsWith("\n"))) return `${output.slice(0, paragraph)}${rest}`;
	return output.startsWith(`${line}\n\n`) ? output.slice(line.length + 2) : output;
}
