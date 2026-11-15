// `/context`: a few rows on what fills the model's context, answered by the host and shown only. Nothing is written
// to the conversation: the model is never sent the command or its answer, and no request is made for it. T3 shows the
// command (it keeps a sent message on screen until the server shows it) and the answer as a reply of no run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { contextReport, type ContextReportView } from "../src/t3/context-report.ts";
import { object } from "../src/t3/schema.ts";
import { conversation, createNamed, idle, makeThreads } from "./threads-harness.ts";

const usage = (input: number, cacheRead: number, output: number) => ({ input, output, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

it("the report: the total pi goes by, and parts that add up to it", () => {
	const system = { role: "system", content: "", sections: { preamble: "p".repeat(700), codemode: "c".repeat(2_100) }, toolsAdded: [{ name: "bash", description: "run", parameters: { type: "object" } }], timestamp: 1 } as unknown as Message;
	const summary = { role: "user", content: [{ type: "text", text: "s".repeat(1_400) }], timestamp: 2 } as unknown as Message;
	const asked = { role: "user", content: [{ type: "text", text: "u".repeat(350) }, { type: "text", text: "m".repeat(700), hidden: true, shownAs: { name: "hindsight_recall", input: {} } }, { type: "image", data: "", mimeType: "image/png" }], timestamp: 3 } as unknown as Message;
	const called = { role: "assistant", content: [{ type: "thinking", thinking: "t".repeat(350) }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "x".repeat(340) } }], stopReason: "toolUse", usage: usage(100, 3_900, 200), timestamp: 4 } as unknown as Message;
	const result = { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "r".repeat(7_000) }], isError: false, timestamp: 5 } as unknown as Message;
	const answered = { role: "assistant", content: [{ type: "text", text: "a".repeat(700) }], stopReason: "stop", usage: usage(2_100, 4_100, 200), timestamp: 6 } as unknown as Message;
	const entries = [
		{ id: 10, kind: "pi.compaction" },
		{ id: 11, kind: "pi.system" },
		{ id: 12, kind: "app.user" },
		{ id: 13, kind: "pi.assistant" },
		{ id: 14, kind: "pi.tool-result" },
		{ id: 15, kind: "pi.assistant" },
	];
	const contributions = [[summary], [system], [asked], [called], [result], [answered]];
	const view: ContextReportView = { head: { id: 10 }, entries, contributions, messages: [system, summary, asked, called, result, answered] };
	const report = contextReport({ view, window: 200_000, model: "anthropic/claude-fable-5-2" });
	const rows = report.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| What")).map((line) => line.split("|").slice(1, 4).map((cell) => cell.trim()));

	// The last answer's request: 2,100 + 4,100 in and 200 out, which the next request carries too.
	expect(report.split("\n")[0]).toBe("**Context: 6,400 of 200,000 tokens (3%)** · anthropic/claude-fable-5-2");
	expect(rows.map((row) => row[0])).toEqual([
		"System prompt",
		"&nbsp;&nbsp;· codemode",
		"&nbsp;&nbsp;· preamble",
		"Tool definitions (1)",
		"Summary of the earlier conversation",
		"Your messages",
		"Added to your messages",
		"Images (1)",
		"Agent: replies",
		"Agent: thinking",
		"Agent: tool calls",
		"Tool results (1)",
	]);
	// Scaled to the total: the parts (not their sub-rows) add up to it, within rounding.
	const tokens = (label: string) => Number(rows.find((row) => row[0] === label)![1]!.replaceAll(",", ""));
	const parts = rows.filter((row) => !row[0]!.startsWith("&nbsp;")).reduce((sum, row) => sum + Number(row[1]!.replaceAll(",", "")), 0);
	expect(Math.abs(parts - 6_400)).toBeLessThanOrEqual(6);
	// The tool result is ten times the reply, and says so.
	expect(tokens("Tool results (1)") / tokens("Agent: replies")).toBeCloseTo(10, 0);
	expect(tokens("Added to your messages")).toBe(tokens("Agent: replies"));
	expect(report).toContain("Last request: 6,200 tokens in (4,100 read from cache, 0 written to it), 200 out.");
	expect(report).toContain("Shown here only: not sent to the model, not saved.");

	// No window known, nothing in the context.
	const empty = contextReport({ view: { head: undefined, entries: [], contributions: [], messages: [] } });
	expect(empty.split("\n")[0]).toBe("**Context: 0 tokens**");
	expect(empty).toContain("| Nothing yet | 0 | 0% |");
});

it("/context is answered in the thread and written nowhere: no entry, no request, and a later turn does not see it", { timeout: 60_000 }, async () => {
	const echo = defineTool({ name: "echo", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "tool output ".repeat(200) }] }) });
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [defineExtension({ name: "echo", tools: [echo] })] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-context-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, { info: () => {}, warn: () => {} }, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	const entryCount = async () => (await (await conversation(f.harness, thread.head)).context(BACKGROUND_CONTEXT)).entries.length;
	type Item = { id: string; type: string; runId: string | null; text?: string; inputIntent?: string };

	// Nothing has run: nothing is in the context, and there is no run for the command to stand in.
	await expect(bridge.sendMessage({ threadId: "t", commandId: "c0", messageId: "m0", text: "/context", mode: "start" })).rejects.toThrow("Nothing is in the context yet");

	const seen: string[] = [];
	f.model.respond(
		fauxAssistantMessage([fauxToolCall("echo", {}, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("first answer"),
		(context) => {
			seen.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("second answer");
		},
	);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "go", mode: "start" });
	await idle(f.harness, thread.head);
	const before = await entryCount();

	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: " /context ", mode: "start" });
	expect(await entryCount(), "no entry was written").toBe(before);
	const { projection, shell } = await bridge.projection("t");
	const items = projection.turnItems as unknown as Item[];
	const run = projection.runs[0]!.id as string;
	// T3 is shown the message it sent (in the run that was the latest, as a note is) and the answer, a reply of no run.
	expect(items.slice(-2).map((item) => [item.id, item.type, item.runId, item.inputIntent])).toEqual([
		["ti-shown-um2", "user_message", run, "steer"],
		["ti-shown-am2", "assistant_message", null, undefined],
	]);
	const answer = items.at(-1)!.text!;
	expect(answer).toMatch(/^\*\*Context: [\d,]+ of [\d,]+ tokens \(\d+%\)\*\* · faux\/faux-1/);
	expect(answer).toContain("| Tool results (1) |");
	expect(answer).toContain("| Your messages |");
	expect(projection.messages.map((message) => [message.id, message.role])).toEqual([["m1", "user"], [expect.any(String), "assistant"], ["m2", "user"], ["shown-m2", "assistant"]]);
	expect(projection.runs.map((candidate) => candidate.status), "it is not a run, and the thread is not running").toEqual(["completed"]);
	// The thread's latest message is still the agent's, for the sidebar.
	expect(shell.latestVisibleMessage).toMatchObject({ role: "assistant", text: "first answer" });

	// The same command sent again (a retry) is one exchange; the next turn's request has neither the command nor its answer.
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "/context", mode: "start" });
	expect(((await bridge.projection("t")).projection.turnItems as unknown as Item[]).filter((item) => item.id.startsWith("ti-shown-"))).toHaveLength(2);
	await bridge.sendMessage({ threadId: "t", commandId: "c3", messageId: "m3", text: "more", mode: "start" });
	await idle(f.harness, thread.head);
	expect(seen).toHaveLength(1);
	expect(seen[0]).not.toContain("/context");
	expect(seen[0]).not.toContain("Shown here only");
	// It stays where it was said: after the first run's items and before the second's.
	const later = (await bridge.projection("t")).projection.turnItems as unknown as Item[];
	const order = later.map((item) => item.id);
	expect(order.indexOf("ti-shown-am2")).toBeLessThan(order.findIndex((itemId) => itemId.startsWith("ti-u") && later[order.indexOf(itemId)]!.text === "more"));
	expect((await bridge.projection("t")).shell.latestVisibleMessage).toMatchObject({ text: "second answer" });
});
