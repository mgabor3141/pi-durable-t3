// A tool result written for the model as pi coding agent writes it: the output, a blank line, and one plain line for
// each thing to know ("Command exited with code 3", "Command timed out after 60 seconds", "[Showing the last 2000
// lines. Full output: <file>]", and "(no output)" for a command that printed nothing).
//
// pi-durable keeps those as a result's diagnostics and renders them itself, in a block after the output:
//
//   <harness>
//   [error] Command exited with code 3
//   </harness>
//
// `plainResultsExtension` is an `afterTool` hook that writes them as lines instead, and says what pi-durable's own
// words leave out: who stopped a call ("Command interrupted by the user"), that a restart cut it off, that a call did
// not run ("Not run: ..."), and on which machine a command's full output is. The list itself is kept in the result's
// details, where this bridge reads it (`result-notes.ts`).
//
// For the calls the model makes. A script's call gets its result as a value, with the list as it is.
//
// One result is out of a hook's reach: a call that had not started when its run was stopped gets its result from the
// run itself (pi-durable's generation task), so that one keeps pi-durable's block ("Tool bash was aborted").
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { boundOutput, type OutputLimits, utf8ByteLength } from "@earendil-works/chord/output";
import { defineExtension, type Extension, hook, type HookApi, LiveDoc, type RegistryReader, type ToolDiagnostic, type ToolExecutionResult, type ToolHookCall, ToolTask } from "@earendil-works/pi-durable";
import { NOTES, type ResultNote } from "./result-notes.ts";

/** Who asked a run to stop: a person, or an agent, with the reason it gave (T3's `t3_thread_interrupt`). */
export type StopBy = { readonly by: "user" | "agent"; readonly reason?: string };

/** pi-durable's output bound for a tool that names none (its `truncate.ts`). */
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
/** The tools whose result is a command's: its notes say "Command ...", and no output is said in words. */
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);
const CODEMODE_TOOL = "codemode";

/** The lines of a text, a last one without its newline counted too. */
const lineCount = (text: string): number => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

const kilobytes = (bytes: number): string => `${Math.round(bytes / 1024)}KB`;

/** " by the user", " by another agent (why)", or nothing where nobody is known to have asked. */
const byWhom = (stop: StopBy | undefined): string => {
	if (stop === undefined) return "";
	if (stop.by === "user") return " by the user";
	const reason = stop.reason?.trim();
	return reason === undefined || reason === "" ? " by another agent" : ` by another agent (${reason})`;
};

/** What a call was working with: its tool's output bound, who stopped its run, and a stopped script's own calls. */
type Around = {
	readonly limits: OutputLimits;
	readonly stop?: StopBy;
	/** The calls a script had made when it was cut off, each with how it stood. */
	readonly calls?: readonly string[];
	/** The start of the output was dropped while it streamed, as the call's slot says: a call that was cut off has no
	 * result of its own to say so. */
	readonly dropped?: boolean;
};

/**
 * A note as a line. `undefined`: nothing to say (the output says it already). `text`: the result's own text; `shown`:
 * how many lines of a command's output the result still holds, where its start was dropped.
 */
function lineOf(note: ResultNote, call: ToolHookCall, text: string, around: Around, shown: number): string | undefined {
	const what = COMMAND_TOOLS.has(call.name) ? "Command interrupted" : call.name === CODEMODE_TOOL ? "Script interrupted" : "Interrupted";
	const machine = (call.arguments as { machine?: unknown }).machine;
	// A script's own calls ran, whoever cut the script off: which, as a failed script's result says them.
	const made = call.name !== CODEMODE_TOOL || around.calls === undefined ? "" : around.calls.length === 0 ? ". No tool calls were made." : `. Tool calls made before that (they are not undone): ${around.calls.join(", ")}`;
	switch (note.code) {
		case "aborted":
			return `${what}${byWhom(around.stop)}; it may have partially run${made}`;
		case "interrupted":
			return `${what} by a restart of the harness; it may have partially run${made}`;
		case "blocked":
			return `Not run: ${note.message.replace(/^Tool call blocked: /u, "")}`;
		case "tool_unavailable":
			// The integrator may have answered with what to call instead: that is the result then.
			return text.trim() === "" ? `Not run: ${note.message}` : undefined;
		case "full_output": {
			const file = note.message.replace(/^Full output: /u, "");
			return `[Showing the last ${shown} line${shown === 1 ? "" : "s"}. Full output${typeof machine === "string" && machine.trim() !== "" ? ` on ${machine.trim()}` : ""}: ${file}]`;
		}
		default:
			return note.severity === "error" ? note.message : `[${note.message}]`;
	}
}

/**
 * A result with its notes as plain lines after its output, within the tool's output bound (pi-durable cuts a text
 * over it once more, and says so in its block). `undefined`: the result stands as it is.
 */
export function plainResult(call: ToolHookCall, result: ToolExecutionResult, around: Around): ToolExecutionResult | undefined {
	const notes = (result.diagnostics ?? []) as readonly ToolDiagnostic[];
	const items = result.output ?? [];
	const command = COMMAND_TOOLS.has(call.name);
	// The notes are kept in the details: a result whose details are not an object keeps pi-durable's form.
	if (result.details !== undefined && (typeof result.details !== "object" || result.details === null || Array.isArray(result.details))) return undefined;
	const whole = items.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
	// A command that printed nothing says so, as pi coding agent's does; one that was cut off says only that.
	const empty = command && whole === "" && notes.every((note) => note.code === "exit_code" || note.severity !== "error") ? "(no output)" : "";
	const spilled = notes.some((note) => note.code === "full_output");
	const dropped = around.dropped === true || (result.structuredOutput as { truncated?: unknown } | undefined)?.truncated === true;
	const { limits } = around;
	const over = boundOutput(whole, limits).droppedBytes > 0;
	if (notes.length === 0 && empty === "" && !over && !dropped) return undefined;

	// The lines, with room kept for them: the text is cut to what the bound leaves beside them. A cut the hook makes of a
	// text nothing had cut yet (a long file) is said too, with what there was.
	const total = lineCount(whole);
	const compose = (shown: number, cut: string | undefined): string[] => {
		const lines = notes.flatMap((note) => {
			const line = lineOf(note, call, whole, around, shown);
			return line === undefined || line.trim() === whole.trim() ? [] : [line];
		});
		if (cut !== undefined) lines.unshift(cut);
		return lines;
	};
	const cutLine = (kept: number, byBytes: boolean): string | undefined => {
		if (spilled) return undefined;
		// Output that is cut as it streams (a command's, always): how much there was is not known here, so only what is
		// shown is said.
		if (command || dropped) {
			const lines = `${kept} line${kept === 1 ? "" : "s"}`;
			return limits.retain === "head" ? `[Showing the first ${lines}; later output is not shown.]` : `[Showing the last ${lines}; earlier output is not shown.]`;
		}
		const limit = byBytes ? ` (${kilobytes(limits.maxBytes)} limit)` : "";
		if (limits.retain === "tail") return `[Showing the last ${kept} of ${total} lines${limit}.]`;
		if (call.name !== "read") return `[Showing the first ${kept} of ${total} lines${limit}.]`;
		// pi coding agent's line for a file: where the lines shown stand in it, and where to go on.
		const args = call.arguments as { offset?: unknown; limit?: unknown };
		const start = typeof args.offset === "number" && Number.isFinite(args.offset) ? Math.max(1, Math.trunc(args.offset)) : 1;
		const end = start + kept - 1;
		const of = args.limit === undefined ? ` of ${start - 1 + total}` : "";
		return `[Showing lines ${start}-${end}${of}${limit}. Use offset=${end + 1} to continue.]`;
	};
	// Each line is a paragraph of its own, as pi coding agent sets a note and a status apart.
	const after = (lines: readonly string[]): string => lines.join("\n\n");
	const fit = (lines: readonly string[]): { text: string; kept: number; byBytes: boolean; cut: boolean; within: boolean } => {
		const tail = after(lines);
		const room = { ...limits, maxLines: Math.max(0, limits.maxLines - lineCount(tail) - (tail === "" ? 0 : 1)), maxBytes: Math.max(0, limits.maxBytes - utf8ByteLength(tail) - (tail === "" ? 0 : 2)) };
		const bounded = boundOutput(whole, room);
		const byLines = boundOutput(whole, { ...room, maxBytes: Number.MAX_SAFE_INTEGER });
		// Whether the cut fell between lines: a line longer than the bound is cut inside.
		const within = limits.retain === "head" ? bounded.text.endsWith("\n") : whole[whole.length - bounded.text.length - 1] === "\n";
		return { text: bounded.text, kept: lineCount(bounded.text), byBytes: bounded.droppedBytes > byLines.droppedBytes, cut: bounded.droppedBytes > 0, within };
	};
	// Output that was dropped as it streamed is said too, though the hook cuts nothing more of it.
	const said = (fitted: { kept: number; byBytes: boolean; cut: boolean }) => (fitted.cut || dropped ? cutLine(fitted.kept, fitted.byBytes) : undefined);
	// Twice: the first pass finds how much fits beside the lines, the second writes the lines with those numbers.
	let fitted = fit(compose(total, undefined));
	let lines = compose(fitted.kept, said(fitted));
	fitted = fit(lines);
	lines = compose(fitted.kept, said(fitted));

	// Two cuts are left to pi-durable, whose own form needs no room for the notes and says what it dropped in bytes.
	// A tool that cut its text itself says what it shows (pi-durable's `read`: "Showing lines 1-2000 of 5000"): cutting
	// more to make room would make that untrue. And a cut inside a line (one longer than the bound) shows no whole
	// line to count.
	if (fitted.cut && (!fitted.within || fitted.text === "" || notes.some((note) => note.code === "truncated"))) return undefined;
	const text = fitted.text === "" ? empty : fitted.text.replace(/\n$/u, "");
	const body = [text, after(lines)].filter((part) => part !== "").join("\n\n");
	// Still over the bound: pi-durable's own form is the safe one.
	if (boundOutput(body, limits).droppedBytes > 0) return undefined;
	if (body === whole && notes.length === 0) return undefined;
	const texts = items.flatMap((item, index) => (item.type === "text" ? [index] : []));
	let output: NonNullable<ToolExecutionResult["output"]>[number][];
	if (!fitted.cut && texts.length > 0) {
		// Nothing was cut: every item stays where it is, and the lines follow the last text.
		const last = texts.at(-1)!;
		const ending = (items[last] as { text: string }).text.replace(/\n$/u, "");
		output = items.map((item, index) => (index === last ? { type: "text" as const, text: [ending, after(lines)].filter((part) => part !== "").join("\n\n") } : item));
	} else {
		// A text that was cut is one text, where pi-durable would put it: at the first of the texts when it keeps the
		// start, at the last when it keeps the end; after anything else when the result had no text.
		const at = texts.length === 0 ? -1 : limits.retain === "head" ? texts[0]! : texts.at(-1)!;
		output = [];
		for (const [index, item] of items.entries()) {
			if (item.type !== "text") output.push(item);
			else if (index === at && body !== "") output.push({ type: "text", text: body });
		}
		if (at < 0 && body !== "") output.push({ type: "text", text: body });
	}
	const details = notes.length === 0 ? result.details : ({ ...((result.details as Record<string, JsonValue> | undefined) ?? {}), [NOTES]: notes.map((note) => ({ ...note })) as unknown as JsonValue } as JsonValue);
	const { diagnostics: _rendered, details: _details, ...kept } = result;
	return { ...kept, output, ...(details === undefined ? {} : { details }), diagnostics: [] };
}

/** What the extension needs of its host: the tools as registered (for a tool's output bound), and who stopped a run. */
export type PlainResultsHost = {
	readonly registry: RegistryReader;
	/** Who asked the conversation's thread to stop, while that stop is under way. */
	stopOf(conversationId: number): StopBy | undefined;
	readonly log: { warn(message: string, fields?: Record<string, unknown>): void };
};

/** The calls a script had made, from the rows pi-durable shows of them while it runs: "bash (ok)", "write (error)". */
/**
 * What pi-durable shows of a call while it runs, for one that was cut off: such a call has no result of its own, so
 * what its result cannot say is read here. `dropped`: the start of its output went as it streamed. `calls`: a
 * script's own calls, "bash (ok)", "write (error)".
 */
async function cutOffCall(call: ToolHookCall, api: HookApi, context: Context): Promise<{ readonly dropped: boolean; readonly calls?: string[] }> {
	try {
		const live = await api.snapshot(LiveDoc, api.conversationId, context);
		const dropped = ((live?.tools ?? []).find((slot) => slot.taskId === api.taskId)?.droppedBytes ?? 0) > 0;
		if (call.name !== CODEMODE_TOOL) return { dropped };
		const slots = (live?.nestedTools ?? []).filter((slot) => slot.parentTaskId === api.taskId);
		// One the stop cut off ended with pi-durable's own words for that: "cancelled", as a script's result calls a call
		// that was still running when the script ended.
		const how = (slot: (typeof slots)[number]) => (slot.summary === undefined || /^Tool .+ was aborted$/u.test(slot.summary.error ?? "") ? "cancelled" : slot.summary.isError ? "error" : "ok");
		return { dropped, calls: slots.map((slot) => `${slot.name} (${how(slot)})`) };
	} catch {
		return { dropped: false };
	}
}

/**
 * `T3Attachment.plainResults`: the hook. Install it after every extension whose `afterTool` adds a note or changes
 * a result (an image check, an answer for a tool that cannot be called directly), so it writes what they left.
 */
export function plainResultsExtension(host: PlainResultsHost): Extension {
	return defineExtension({
		name: "t3-plain-results",
		hooks: [
			hook(ToolTask, {
				afterTool: async (call, result, api, context) => {
					if (call.parent !== undefined) return undefined;
					const tool = host.registry.snapshot().tools().find((entry) => entry.tool.name === call.name)?.tool;
					const limits: OutputLimits = { maxBytes: tool?.outputLimits?.maxBytes ?? DEFAULT_MAX_BYTES, maxLines: tool?.outputLimits?.maxLines ?? DEFAULT_MAX_LINES, retain: tool?.outputLimits?.retain ?? "head" };
					const cutOff = (result.diagnostics ?? []).some((note) => note.code === "aborted" || note.code === "interrupted");
					const stop = cutOff ? host.stopOf(api.conversationId as number) : undefined;
					const shown = cutOff ? await cutOffCall(call, api, context) : undefined;
					// A result that cannot be written plainly keeps pi-durable's form: the call's result is never lost to this.
					try {
						return plainResult(call, result, { limits, ...(stop === undefined ? {} : { stop }), ...(shown?.calls === undefined ? {} : { calls: shown.calls }), ...(shown?.dropped === true ? { dropped: true } : {}) });
					} catch (error) {
						host.log.warn("a tool result was left in pi-durable's form", { tool: call.name, error: error instanceof Error ? error.message : String(error) });
						return undefined;
					}
				},
			}),
		],
	});
}
