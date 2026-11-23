// A tool result as the model reads it: its notes (an exit code, a timeout, a stop, a cut-off output) are plain lines
// after its output, as pi coding agent writes them, where pi-durable would put them in a `<harness>` block; the result
// stays within its tool's output bound, so pi-durable does not cut it again and add its block; and the list is kept
// in the result's details, where the bridge reads which call a Stop cut off and a command's exit code.
import { boundOutput } from "@earendil-works/chord/output";
import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { plainResult } from "../src/t3/plain-results.ts";
import { exitCodeOf, notesOf, withoutExitLine } from "../src/t3/result-notes.ts";
import type { EntryRecord } from "../src/t3/model-types.ts";

const HEAD = { maxBytes: 50 * 1024, maxLines: 2000, retain: "head" } as const;
const TAIL = { ...HEAD, retain: "tail" } as const;
const call = (name: string, args: Record<string, unknown> = {}): ToolHookCall => ({ type: "toolCall", id: "c1", name, arguments: args }) as ToolHookCall;
const text = (value: string) => [{ type: "text" as const, text: value }];
const note = (code: string, message: string, severity: "error" | "warn" | "info" = "error") => ({ severity, code, message });
/** The one text of a result, as the model gets it. */
const said = (result: ToolExecutionResult | undefined) => (result?.output ?? []).flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n⸻\n");
const bash = (output: string, notes: ReturnType<typeof note>[], extra: Partial<ToolExecutionResult> = {}, args: Record<string, unknown> = { command: "x" }, around: Parameters<typeof plainResult>[2] = { limits: TAIL }) =>
	plainResult(call("bash", args), { ...(output === "" ? {} : { output: text(output) }), ...(notes.length === 0 ? {} : { diagnostics: notes, isError: notes.some((each) => each.severity === "error") }), ...extra }, around);

describe("a command's result", () => {
	it("ends with its exit code on a line of its own, and keeps the note in its details", () => {
		const result = bash("before\nproblem\n", [note("exit_code", "Command exited with code 3")]);
		expect(said(result)).toBe("before\nproblem\n\nCommand exited with code 3");
		expect(result).toMatchObject({ isError: true, diagnostics: [], details: { plainResultNotes: [{ severity: "error", code: "exit_code", message: "Command exited with code 3" }] } });
	});

	it("says that it printed nothing, also before an exit code, and stands as it is when it printed something and ended well", () => {
		expect(said(bash("", []))).toBe("(no output)");
		expect(said(bash("", [note("exit_code", "Command exited with code 1")]))).toBe("(no output)\n\nCommand exited with code 1");
		expect(bash("hello\n", [])).toBeUndefined();
		// Not another tool's: an empty result of `write` is its own.
		expect(plainResult(call("write"), {}, { limits: HEAD })).toBeUndefined();
	});

	it("says a timeout after what it printed, and only that when it printed nothing", () => {
		expect(said(bash("started\n", [note("tool_error", "Command timed out after 60 seconds")]))).toBe("started\n\nCommand timed out after 60 seconds");
		expect(said(bash("", [note("tool_error", "Command timed out after 60 seconds")]))).toBe("Command timed out after 60 seconds");
	});

	it("says who cut it off: the user, another agent with its reason, a restart, or nobody known", () => {
		const aborted = [note("aborted", "Tool bash was aborted")];
		expect(said(bash("started\n", aborted, {}, undefined, { limits: TAIL, stop: { by: "user" } }))).toBe("started\n\nCommand interrupted by the user; it may have partially run");
		expect(said(bash("", aborted, {}, undefined, { limits: TAIL, stop: { by: "agent" } }))).toBe("Command interrupted by another agent; it may have partially run");
		expect(said(bash("", aborted, {}, undefined, { limits: TAIL, stop: { by: "agent", reason: "the plan changed" } }))).toBe("Command interrupted by another agent (the plan changed); it may have partially run");
		expect(said(bash("", aborted))).toBe("Command interrupted; it may have partially run");
		expect(said(bash("started\n", [note("interrupted", "Tool bash was interrupted and may have partially run")]))).toBe("started\n\nCommand interrupted by a restart of the harness; it may have partially run");
	});

	it("says where its full output is, in one line, after the lines it still shows", () => {
		const lines = `${Array.from({ length: 2000 }, (_, index) => index + 58_001).join("\n")}\n`;
		const result = bash(lines, [note("full_output", "Full output: /tmp/tmp-x/pi-output-1.log", "info")], { structuredOutput: { output: lines, truncated: true, exitCode: 0 } as never });
		const shown = said(result);
		// Room is made for the lines: the oldest of the output go.
		expect(shown.endsWith("\n59999\n60000\n\n[Showing the last 1998 lines. Full output: /tmp/tmp-x/pi-output-1.log]")).toBe(true);
		expect(shown.startsWith("58003\n")).toBe(true);
		expect(boundOutput(shown, TAIL).droppedBytes, "pi-durable finds nothing to cut").toBe(0);
		expect(shown).not.toContain("<harness>");
		// On another machine the file is there, not in the workspace.
		expect(said(bash("a\n", [note("full_output", "Full output: /tmp/o.log", "info")], {}, { command: "x", machine: "bespin" }))).toBe("a\n\n[Showing the last 1 line. Full output on bespin: /tmp/o.log]");
	});

	it("says that earlier output is not shown, without a count of it: when its start was dropped and not saved, and when a stop cut it off", () => {
		expect(said(bash("tail\n", [], { structuredOutput: { output: "tail\n", truncated: true, exitCode: 0 } as never }))).toBe("tail\n\n[Showing the last 1 line; earlier output is not shown.]");
		// A command that was cut off has no result of its own to say what was dropped: its slot says it (`dropped`). What
		// it still shows is at the bound, and reads as its whole output otherwise.
		const kept = `${Array.from({ length: 2000 }, (_, index) => index + 98_001).join("\n")}\n`;
		const stopped = said(bash(kept, [note("aborted", "Tool bash was aborted")], {}, undefined, { limits: TAIL, stop: { by: "user" }, dropped: true }));
		expect(stopped).toMatch(/\n100000\n\n\[Showing the last (\d+) lines; earlier output is not shown\.\]\n\nCommand interrupted by the user; it may have partially run$/u);
		expect(stopped).not.toMatch(/ of \d+ lines/u);
		expect(boundOutput(stopped, TAIL).droppedBytes).toBe(0);
		// Nor is a count made up where nothing says the start was dropped: how much a command printed is not known here.
		expect(said(bash(kept, [note("aborted", "Tool bash was aborted")]))).not.toMatch(/ of \d+ lines/u);
	});

	it("counts nothing of any output that was dropped as it streamed, whatever the tool, and which end it kept", () => {
		const kept = `${Array.from({ length: 2000 }, (_, index) => index + 1).join("\n")}\n`;
		const aborted = { isError: true, output: text(kept), diagnostics: [note("aborted", "Tool stream was aborted")] };
		const tail = said(plainResult(call("stream"), aborted, { limits: TAIL, dropped: true }));
		expect(tail).toMatch(/\n2000\n\n\[Showing the last \d+ lines; earlier output is not shown\.\]\n\nInterrupted; it may have partially run$/u);
		const head = said(plainResult(call("stream"), aborted, { limits: HEAD, dropped: true }));
		expect(head).toMatch(/^1\n2\n[^]*\n\n\[Showing the first \d+ lines; later output is not shown\.\]\n\nInterrupted; it may have partially run$/u);
		expect(`${tail}${head}`).not.toMatch(/ of \d+ lines/u);
		// Said though nothing more is cut.
		expect(said(plainResult(call("stream"), { isError: true, output: text("end\n"), diagnostics: [note("aborted", "Tool stream was aborted")] }, { limits: TAIL, dropped: true }))).toBe(
			"end\n\n[Showing the last 1 line; earlier output is not shown.]\n\nInterrupted; it may have partially run",
		);
	});

	it("leaves a result to pi-durable when the lines would take all the room: its own text is not dropped for them", () => {
		// A note so long that, with the line that says the cut, nothing of the output fits beside it.
		const long = Array.from({ length: TAIL.maxLines - 3 }, (_, index) => `problem ${index + 1}`).join("\n");
		for (const limits of [TAIL, HEAD]) expect(plainResult(call("bash", { command: "check" }), { isError: true, output: text("a\nb\nc\n"), diagnostics: [note("tool_error", long)] }, { limits })).toBeUndefined();
		// One line shorter, and all of the output fits beside it.
		expect(said(plainResult(call("bash", { command: "check" }), { isError: true, output: text("a\nb\nc\n"), diagnostics: [note("tool_error", long.replace(/\n[^\n]*$/u, ""))] }, { limits: TAIL }))).toMatch(/^a\nb\nc\n\nproblem 1\n/u);
	});

	it("leaves a line longer than the bound to pi-durable: no whole line of it is shown to count", () => {
		const one = "x".repeat(100 * 1024);
		expect(plainResult(call("read", { path: "min.js" }), { output: text(one) }, { limits: HEAD })).toBeUndefined();
		expect(plainResult(call("read", { path: "min.js" }), { output: text(`first\n${one}\nlast\n`) }, { limits: HEAD })?.output).toEqual([{ type: "text", text: "first\n\n[Showing lines 1-1 of 3 (50KB limit). Use offset=2 to continue.]" }]);
		expect(bash(one, [note("exit_code", "Command exited with code 1")])).toBeUndefined();
		expect(plainResult(call("other"), { output: text(`${one}\n`) }, { limits: HEAD })).toBeUndefined();
	});

	it("stays within its bound by its bytes too, on whole lines, each thing to know in a paragraph of its own", () => {
		// What pi-durable's stream leaves of a long output: its last lines, up to the bound.
		const all = `${Array.from({ length: 1500 }, (_, index) => `${index} ${"x".repeat(60)}`).join("\n")}\n`;
		const kept = boundOutput(all, TAIL).text;
		expect(new TextEncoder().encode(kept).length).toBeGreaterThan(TAIL.maxBytes - 100);
		const shown = said(bash(kept, [note("full_output", "Full output: /tmp/o.log", "info"), note("exit_code", "Command exited with code 2")], { structuredOutput: { output: kept, truncated: true, exitCode: 2 } as never }));
		expect(boundOutput(shown, TAIL).droppedBytes).toBe(0);
		expect(shown).toMatch(new RegExp(`\\n1499 x{60}\\n\\n\\[Showing the last \\d+ lines\\. Full output: /tmp/o\\.log\\]\\n\\nCommand exited with code 2$`, "u"));
		const count = Number(/Showing the last (\d+) lines/u.exec(shown)![1]);
		expect(shown.split("\n\n[Showing")[0]!.split("\n")).toHaveLength(count);
		expect(count).toBeLessThan(kept.split("\n").length - 1);
	});
});

describe("any tool's result", () => {
	it("says that a call did not run, with the reason, and leaves an answer that stands in for the call as it is", () => {
		expect(said(plainResult(call("bash"), { isError: true, diagnostics: [note("blocked", "Tool call blocked: The user did not allow nas, and said: not now")] }, { limits: TAIL }))).toBe("Not run: The user did not allow nas, and said: not now");
		expect(said(plainResult(call("ssh"), { isError: true, diagnostics: [note("tool_unavailable", "Tool ssh is not available")] }, { limits: HEAD }))).toBe("Not run: Tool ssh is not available");
		const answered = plainResult(call("ssh"), { isError: true, output: text("`ssh` is called from a script: ..."), diagnostics: [note("tool_unavailable", "Tool ssh is called from codemode scripts, not directly")] }, { limits: HEAD });
		expect(said(answered)).toBe("`ssh` is called from a script: ...");
		expect(answered?.diagnostics).toEqual([]);
	});

	it("gives an error as it is said, and anything else to know in brackets", () => {
		expect(said(plainResult(call("read", { path: "a.txt" }), { isError: true, diagnostics: [note("tool_error", "a.txt: ENOENT: no such file or directory")] }, { limits: HEAD }))).toBe("a.txt: ENOENT: no such file or directory");
		expect(said(plainResult(call("read", { path: "a.png" }), { output: text("x"), diagnostics: [note("resized", "Image resized from 4000x3000 to 2000x1500", "info")] }, { limits: HEAD }))).toBe("x\n\n[Image resized from 4000x3000 to 2000x1500]");
		expect(said(plainResult(call("bash"), { isError: true, diagnostics: [note("invalid_arguments", 'Validation failed for tool "bash":\n  - command: missing')] }, { limits: TAIL }))).toBe('Validation failed for tool "bash":\n  - command: missing');
	});

	it("does not say twice what its output already says", () => {
		const message = "The image could not be read: it is not a PNG";
		expect(said(plainResult(call("read"), { isError: true, output: text(message), diagnostics: [note("unusable_image", message)] }, { limits: HEAD }))).toBe(message);
	});

	it("says who cut it off without calling it a command, and a script's own calls with it", () => {
		const aborted = { isError: true, diagnostics: [note("aborted", "Tool ask_user was aborted")] };
		expect(said(plainResult(call("ask_user"), aborted, { limits: HEAD, stop: { by: "user" } }))).toBe("Interrupted by the user; it may have partially run");
		expect(said(plainResult(call("codemode"), aborted, { limits: HEAD, stop: { by: "user" }, calls: ["bash (ok)", "write (cancelled)"] }))).toBe(
			"Script interrupted by the user; it may have partially run. Tool calls made before that (they are not undone): bash (ok), write (cancelled)",
		);
		expect(said(plainResult(call("codemode"), aborted, { limits: HEAD, calls: [] }))).toBe("Script interrupted; it may have partially run. No tool calls were made.");
	});

	it("cuts a text over its bound itself, and says what there was: for a file, where to go on", () => {
		const file = `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		const whole = said(plainResult(call("read", { path: "big.txt" }), { output: text(file) }, { limits: HEAD }));
		expect(whole.endsWith("\nline 1998\n\n[Showing lines 1-1998 of 5000. Use offset=1999 to continue.]")).toBe(true);
		expect(boundOutput(whole, HEAD).droppedBytes).toBe(0);
		// From an offset, the lines are counted from there; with a limit, the file's length is not known.
		expect(said(plainResult(call("read", { path: "big.txt", offset: 101 }), { output: text(file) }, { limits: HEAD })).endsWith("[Showing lines 101-2098 of 5100. Use offset=2099 to continue.]")).toBe(true);
		expect(said(plainResult(call("read", { path: "big.txt", offset: 101, limit: 4000 }), { output: text(file) }, { limits: HEAD })).endsWith("[Showing lines 101-2098. Use offset=2099 to continue.]")).toBe(true);
		// Another tool's text has no offset to go on from.
		expect(said(plainResult(call("other"), { output: text(file) }, { limits: HEAD })).endsWith("\nline 1998\n\n[Showing the first 1998 of 5000 lines.]")).toBe(true);
		// Cut by its bytes: the bound is named.
		const wide = `${Array.from({ length: 1000 }, (_, index) => `${index} ${"y".repeat(100)}`).join("\n")}\n`;
		const cut = said(plainResult(call("read", { path: "wide.txt" }), { output: text(wide) }, { limits: HEAD }));
		expect(cut).toMatch(/\n\n\[Showing lines 1-\d+ of 1000 \(50KB limit\)\. Use offset=\d+ to continue\.\]$/u);
		expect(boundOutput(cut, HEAD).droppedBytes).toBe(0);
		// A text within its bound and with nothing to say stands as it is.
		expect(plainResult(call("read", { path: "small.txt" }), { output: text("short\n") }, { limits: HEAD })).toBeUndefined();
	});

	it("keeps what is not text where it was, and its own details beside the notes", () => {
		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const result = plainResult(call("read"), { output: [image, { type: "text", text: "caption" }], details: { truncation: { lines: 3 } }, diagnostics: [note("scaled", "Scaled to half", "info")] }, { limits: HEAD });
		expect(result?.output).toEqual([image, { type: "text", text: "caption\n\n[Scaled to half]" }]);
		expect(result?.details).toEqual({ truncation: { lines: 3 }, plainResultNotes: [{ severity: "info", code: "scaled", message: "Scaled to half" }] });
		// Nothing is moved where nothing is cut: the lines follow the last text.
		const mixed = plainResult(call("read"), { output: [{ type: "text", text: "a\n" }, image, { type: "text", text: "b\n" }], diagnostics: [note("scaled", "Scaled to half", "info")] }, { limits: HEAD });
		expect(mixed?.output).toEqual([{ type: "text", text: "a\n" }, image, { type: "text", text: "b\n\n[Scaled to half]" }]);
		// Only notes, beside a picture: after it.
		expect(plainResult(call("read"), { output: [image], diagnostics: [note("scaled", "Scaled to half", "info")] }, { limits: HEAD })?.output).toEqual([image, { type: "text", text: "[Scaled to half]" }]);
		// A text that is cut is one text, where pi-durable puts it: at the first text when the start is kept, at the last
		// when the end is.
		const long = `${Array.from({ length: 3000 }, (_, index) => `l${index + 1}`).join("\n")}\n`;
		const head = plainResult(call("other"), { output: [{ type: "text", text: long }, image, { type: "text", text: "after\n" }] }, { limits: HEAD });
		expect(head?.output?.map((item) => item.type)).toEqual(["text", "image"]);
		const tail = plainResult(call("other"), { output: [{ type: "text", text: "before\n" }, image, { type: "text", text: long }] }, { limits: TAIL });
		expect(tail?.output?.map((item) => item.type)).toEqual(["image", "text"]);
		expect(said(tail)).toMatch(/\nl3000\n\n\[Showing the last 1998 of 3001 lines\.\]$/u);
	});

	it("leaves a result to pi-durable when its tool cut it and said how much it shows: there is no room to say it plainly", () => {
		// pi-durable's own `read`: 2000 lines, the bound, and its note of what they are.
		const shown = `${Array.from({ length: 2000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		const told = note("truncated", "Showing lines 1-2000 of 5000. Use offset=2001 to continue.", "info");
		expect(plainResult(call("read", { path: "big.txt" }), { output: text(shown), diagnostics: [told] }, { limits: HEAD })).toBeUndefined();
		// With room, its note is a line like any other.
		expect(said(plainResult(call("read", { path: "big.txt", limit: 3 }), { output: text("a\nb\nc\n"), diagnostics: [note("truncated", "4997 more lines in file. Use offset=4 to continue.", "info")] }, { limits: HEAD }))).toBe(
			"a\nb\nc\n\n[4997 more lines in file. Use offset=4 to continue.]",
		);
	});

	it("is left in pi-durable's form when its details are no object to keep the notes in", () => {
		expect(plainResult(call("odd"), { isError: true, details: "a string", diagnostics: [note("tool_error", "failed")] }, { limits: HEAD })).toBeUndefined();
	});
});

describe("reading a stored result's notes", () => {
	const stored = (data: unknown, details?: unknown): EntryRecord => ({ id: 1, kind: "pi.tool-result", data, model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [], isError: true, ...(details === undefined ? {} : { details }) }] }) as never;
	const exit = { severity: "error", code: "exit_code", message: "Command exited with code 3" } as const;

	it("finds them where pi-durable keeps them and where a plain result does", () => {
		expect(notesOf(stored({ diagnostics: [exit] }))).toEqual([exit]);
		expect(notesOf(stored({ diagnostics: [] }, { plainResultNotes: [exit] }))).toEqual([exit]);
		expect(notesOf(stored(undefined, { plainResultNotes: "not a list" }))).toEqual([]);
		// A tool's own details are its own, whatever they are called.
		expect(notesOf(stored(undefined, { diagnostics: [exit] }))).toEqual([]);
		expect(exitCodeOf([exit])).toBe(3);
		expect(exitCodeOf([{ severity: "error", code: "tool_error", message: "Command timed out after 1 seconds" }])).toBeUndefined();
	});

	it("takes the exit code's line out of what T3 shows, in either form", () => {
		expect(withoutExitLine("before\nproblem\n\nCommand exited with code 3", [exit])).toBe("before\nproblem");
		expect(withoutExitLine("(no output)\n\nCommand exited with code 3", [exit])).toBe("(no output)");
		expect(withoutExitLine("Command exited with code 3", [exit])).toBe("");
		// With another line after it.
		expect(withoutExitLine("a\n\nCommand exited with code 3\n\n[Showing the last 1 line. Full output: /tmp/o]", [exit])).toBe("a\n\n[Showing the last 1 line. Full output: /tmp/o]");
		expect(withoutExitLine("a\n\n[Showing the last 1 line. Full output: /tmp/o]\n\nCommand exited with code 3", [exit])).toBe("a\n\n[Showing the last 1 line. Full output: /tmp/o]");
		// A command that prints the same words itself keeps them.
		expect(withoutExitLine("Command exited with code 3 was printed\n\nCommand exited with code 3", [exit])).toBe("Command exited with code 3 was printed");
		expect(withoutExitLine("a\n\nCommand exited with code 30", [exit])).toBe("a\n\nCommand exited with code 30");
		// pi-durable's block: the block goes when the code was all it said, else only the line.
		expect(withoutExitLine("before\n<harness>\n[error] Command exited with code 3\n</harness>", [exit])).toBe("before\n");
		expect(withoutExitLine("before\n<harness>\n[info] Full output: /tmp/o\n[error] Command exited with code 3\n</harness>", [exit])).toBe("before\n<harness>\n[info] Full output: /tmp/o\n</harness>");
		// Nothing to take out without the note.
		expect(withoutExitLine("Command exited with code 3", [])).toBe("Command exited with code 3");
	});
});
