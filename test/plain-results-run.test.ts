// Plain results in a running thread (`T3Attachment.plainResults`), with pi-durable's own `bash`: what the model is given
// for a command that fails, prints nothing, takes too long or prints too much; who a call says stopped it; what the
// first message after a stop tells the model; and what T3's command row shows of it all (the exit code in its own
// field, the machine a command ran on).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { expect, it, onTestFinished } from "vitest";
import { abortable } from "../src/t3/abortable.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { object } from "../src/t3/schema.ts";
import { bridgeConfig, conversation, createNamed, gated, idle, makeThreads, quietLog } from "./threads-harness.ts";

type Item = { type: string; status: string; input?: unknown; output?: string; exitCode?: number; outputIndicatesFailure?: boolean; message?: string; toolName?: string };
type Stored = { readonly text: string; readonly isError: boolean; readonly details: unknown };

async function setup(options: { readonly extensions?: readonly Extension[]; readonly tokensPerSecond?: number } = {}) {
	const f = await makeThreads({ projects: [{ id: "p" }], coding: true, sequential: true, extensions: options.extensions ?? [], ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-plain-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	// Last, as an integrator installs it: after every extension that changes a result.
	f.tools.install(bridge.plainResults(f.tools));
	let sent = 0;
	const send = async (text: string, mode: "start" | "queue" | "restart" | "steer" = "start") => {
		const n = ++sent;
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode });
	};
	// The thread's head as it is now: an undo moves it.
	const head = async () => (await f.threads.thread("t"))!.head;
	const messages = async (): Promise<readonly Message[]> => (await (await conversation(f.harness, await head())).context(BACKGROUND_CONTEXT)).messages;
	/** The tool results as the model is given them: each one's text, its items joined by a mark. */
	const results = async (): Promise<Stored[]> =>
		(await messages()).flatMap((message) =>
			message.role === "toolResult" ? [{ text: message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("⸻"), isError: message.isError === true, details: message.details }] : [],
		);
	/** The user's messages as the model is given them: each one's blocks. */
	const said = async () => (await messages()).flatMap((message) => (message.role === "user" ? [typeof message.content === "string" ? [message.content] : message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`))] : []));
	const items = async () => (await bridge.projection("t")).projection.turnItems as unknown as Item[];
	const statuses = async (wanted: readonly string[]) => {
		const found = await bridge.waitFor("t", (projection) => (JSON.stringify(projection.runs.map((run) => run.status)) === JSON.stringify(wanted) ? true : undefined), 15_000);
		if (found !== true) throw new Error(`the thread never showed ${wanted.join(", ")}: ${JSON.stringify((await bridge.projection("t")).projection.runs.map((run) => run.status))}`);
	};
	/** Until the command's row shows `text` in its output while it runs. */
	const printed = async (text: string) => {
		const found = await bridge.waitFor("t", (projection) => ((projection.turnItems as unknown as Item[]).some((item) => item.status === "running" && String(item.output ?? "").includes(text)) ? true : undefined), 15_000);
		if (found !== true) throw new Error(`no running row printed ${text}`);
	};
	/** The host restarted: another bridge over the same threads, which remembers nothing of the first. */
	const reopened = async () => {
		await bridge.close();
		const next = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
		next.start();
		onTestFinished(() => next.close());
		await next.loaded();
		f.tools.install(next.plainResults(f.tools));
		return next;
	};
	return { f, thread, bridge, send, results, said, items, statuses, printed, reopened, settled: async () => idle(f.harness, await head()) };
}

const calls = (...list: [id: string, name: string, args: Record<string, string | number>][]) => fauxAssistantMessage(list.map(([id, name, args]) => fauxToolCall(name, args, { id })), { stopReason: "toolUse" });

it("a command's result reads as pi coding agent writes it, and T3 shows the exit code and the machine itself", { timeout: 90_000 }, async () => {
	// A tool that gives a long text whole, as an integrator's `read` may: the hook cuts it at the tool's bound.
	const dump = defineTool({ name: "dump", description: "a long text", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n")}\n` }] }) });
	const { f, send, results, items, settled } = await setup({ extensions: [defineExtension({ name: "dump", tools: [dump] })] });
	await writeFile(join(f.projects[0]!.cwd, "big.txt"), `${Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n")}\n`);
	f.model.respond(
		calls(
			["ok", "bash", { command: "echo hello" }],
			["silent", "bash", { command: "true" }],
			["fails", "bash", { command: "echo before; echo problem >&2; exit 3" }],
			["slow", "bash", { command: "echo started; sleep 5; echo done", timeout: 1 }],
			["long", "bash", { command: "seq 1 60000", machine: "bespin" }],
			["wrong", "bash", {}],
			["whole", "dump", {}],
			["file", "read", { path: "big.txt" }],
		),
		fauxAssistantMessage("done"),
	);
	await send("go");
	await settled();
	const stored = await results();
	// A text its tool gave whole keeps its start, as pi-durable would keep it, with what there was.
	expect(stored[6]!.text.startsWith("line 1\nline 2\n")).toBe(true);
	expect(stored[6]!.text.endsWith("\nline 1998\n\n[Showing the first 1998 of 5000 lines.]")).toBe(true);
	// pi-durable's own `read` cut the file itself and said so: that result is its own, block and all.
	expect(stored[7]!.text).toMatch(/\nline 2000⸻<harness>\n\[info\] Showing lines 1-2000 of \d+\. Use offset=2001 to continue\.\n<\/harness>$/u);
	stored.splice(6, 2);
	expect(stored.map((result) => result.text).join("\n")).not.toContain("<harness>");
	expect(stored[0]).toMatchObject({ text: "hello\n", isError: false });
	expect(stored[1]).toMatchObject({ text: "(no output)", isError: false });
	expect(stored[2]).toMatchObject({ text: "before\nproblem\n\nCommand exited with code 3", isError: true, details: { plainResultNotes: [{ code: "exit_code" }] } });
	expect(stored[3]).toMatchObject({ text: "started\n\nCommand timed out after 1 seconds", isError: true });
	// The last lines of a long output, with where the rest is: on the machine the command named.
	expect(stored[4]!.text).toMatch(/\n59999\n60000\n\n\[Showing the last \d+ lines\. Full output on bespin: \S+pi-output-\S+\.log\]$/u);
	expect(stored[4]!.text.split("\n").length, "within pi-durable's bound of 2000 lines").toBeLessThanOrEqual(2000);
	expect(stored[5]).toMatchObject({ text: 'Validation failed for tool "bash":\n  - command: missing\n\nReceived arguments:\n{}', isError: true });

	const rows = (await items()).filter((item) => item.type === "command_execution");
	expect(rows.map((row) => [row.input, row.status, row.exitCode, row.outputIndicatesFailure])).toEqual([
		["echo hello", "completed", 0, undefined],
		["true", "completed", 0, undefined],
		["echo before; echo problem >&2; exit 3", "failed", 3, undefined],
		["echo started; sleep 5; echo done", "failed", undefined, true],
		["# on bespin\nseq 1 60000", "completed", 0, undefined],
	]);
	// T3 writes "exit 3" under the output itself: the line that says it is not there twice.
	expect(rows[2]!.output).toBe("before\nproblem");
	expect(rows[1]!.output).toBe("(no output)");
	expect(rows[3]!.output).toBe("started\n\nCommand timed out after 1 seconds");
});

it("a call a Stop cut off says the user stopped it; the next message is a new turn, and tells the model so once", { timeout: 90_000 }, async () => {
	const { f, bridge, send, results, said, items, statuses, printed, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30; echo done" }], ["second", "bash", { command: "echo never" }]), fauxAssistantMessage("I see"), fauxAssistantMessage("and again"));
	await send("go");
	await printed("started");
	// T3's Stop button: a client's command.
	await dispatchCommand(bridge, { type: "run.interrupt", commandId: "stop-1", threadId: "t" } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	await statuses(["interrupted"]);
	const stored = await results();
	expect(stored[0]).toMatchObject({ text: "started\n\nCommand interrupted by the user; it may have partially run", isError: true, details: { plainResultNotes: [{ code: "aborted" }] } });
	// The call that had not started gets its result from the run, not from a tool's task: pi-durable's own words.
	expect(stored[1]!.text).toBe("<harness>\n[error] Tool bash was aborted\n</harness>");
	expect((await items()).filter((item) => item.type === "command_execution").map((item) => item.status)).toEqual(["interrupted", "interrupted"]);

	// A note starts no turn, and says nothing of the stop: the message that does start one says it.
	await bridge.sendMessage({ threadId: "t", commandId: "note-1", messageId: "note-1", text: "for later", mode: "queue", note: true });
	expect((await said()).at(-1)).toEqual(["for later"]);
	// As T3 sends a message by default: a steer, which starts a turn when nothing runs.
	await send("what happened?", "steer");
	await settled();
	// A new run, not a steer of the stopped one: the bridge still finds the call the Stop cut off.
	await statuses(["interrupted", "completed"]);
	expect((await said()).at(-1)).toEqual(["what happened?", "[The user stopped your previous turn before it finished.]"]);
	const projection = (await bridge.projection("t")).projection;
	expect(projection.messages.filter((message) => message.role === "user").map((message) => message.text)).toEqual(["go", "for later", "what happened?"]);

	await send("and now?");
	await settled();
	expect((await said()).at(-1), "only the first message after the stop says it").toEqual(["and now?"]);
});

it("another agent's stop says so, with its reason: in the call it cut off, and with the next message", { timeout: 90_000 }, async () => {
	const slow = defineTool({ name: "slow", description: "works for a while", parameters: object({}), execute: () => new Promise<{ output: { type: "text"; text: string }[] }>((resolve) => setTimeout(() => resolve({ output: [{ type: "text", text: "finished" }] }), 3_000)) });
	const { f, bridge, send, results, said, statuses, settled } = await setup({ extensions: [defineExtension({ name: "slow", tools: [slow] })] });
	f.model.respond(calls(["one", "slow", {}]), fauxAssistantMessage("ok"));
	await send("go");
	await bridge.waitFor("t", (projection) => ((projection.turnItems as unknown as Item[]).some((item) => item.toolName === "slow" && item.status === "running") ? true : undefined), 10_000);
	// As an agent's tools stop a thread (`t3_thread_interrupt`, `thread_cancel`), with the reason it gave (the banner:
	// stop.test.ts).
	await bridge.interrupt("t", { by: "agent", reason: "the plan changed" });
	await statuses(["interrupted"]);
	expect((await results())[0]!.text).toBe("Interrupted by another agent (the plan changed); it may have partially run");
	await send("go on");
	await settled();
	expect((await said()).at(-1)).toEqual(["go on", "[Another agent stopped your previous turn before it finished, saying: the plan changed.]"]);
});

it("a message that restarts the run says who stopped it, to the call it cuts off and to the model", { timeout: 90_000 }, async () => {
	const { f, bridge, send, results, said, statuses, printed, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("doing that instead"));
	await send("go");
	await printed("started");
	await send("no, do this instead", "restart");
	await settled();
	await statuses(["interrupted", "completed"]);
	expect((await results())[0]!.text).toBe("started\n\nCommand interrupted by the user; it may have partially run");
	expect((await said()).at(-1)).toEqual(["no, do this instead", "[The user stopped your previous turn before it finished.]"]);

	// An agent's message that restarts the run: the same, said of the agent, after T3's line of who sent it.
	f.model.respond(calls(["second", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("as the agent asked"));
	await send("go again");
	await printed("started");
	await bridge.sendMessage({ threadId: "t", commandId: "agent-1", messageId: "agent-1", text: "stop, the plan changed", mode: "restart", provenance: { createdBy: "agent", creationSource: "mcp" } });
	await settled();
	expect((await results()).at(-1)!.text).toBe("started\n\nCommand interrupted by another agent; it may have partially run");
	expect((await said()).at(-1)).toEqual(["stop, the plan changed", "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]", "[Another agent stopped your previous turn before it finished.]"]);
});

it("a message that restarts a run which had answered says nothing of a stop: the run was not kept from anything", { timeout: 90_000 }, async () => {
	// A run that has answered is still busy while its `afterRun` hooks run (the bridge's own queued commands have one; a
	// queued `/compact` holds a run there for as long as it takes); a restart's message sent then ends that run.
	let entered!: () => void;
	const finishing = new Promise<void>((resolve) => (entered = resolve));
	let release!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	let held = false;
	const slowEnd = defineExtension({
		name: "slow-end",
		hooks: [
			hook(GenerationTask, {
				afterRun: async () => {
					if (held) return undefined;
					held = true;
					entered();
					await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 5_000))]);
					return undefined;
				},
			}),
		],
	});
	const { f, send, said, statuses, settled } = await setup({ extensions: [slowEnd] });
	f.model.respond(fauxAssistantMessage("the whole answer"), fauxAssistantMessage("on to the next"));
	await send("go");
	await finishing;
	await send("next thing", "restart");
	release();
	await settled();
	await statuses(["completed", "completed"]);
	expect(await said()).toEqual([["go"], ["next thing"]]);
});

it("a Stop while the model writes is told with the next message; a Resume tells nothing", { timeout: 90_000 }, async () => {
	const { f, bridge, send, said, statuses, settled } = await setup({ tokensPerSecond: 8 });
	const seen: string[] = [];
	const answer = (text: string) => (request: { messages: readonly unknown[] }) => {
		seen.push(JSON.stringify(request.messages));
		return fauxAssistantMessage(text);
	};
	f.model.respond(fauxAssistantMessage("First I will look at the logs, then at the unit file, and after that I will restart the service and see that it came up."), answer("ok"));
	await send("go");
	await bridge.waitFor("t", (projection) => (projection.runs.some((run) => run.status === "running") && (projection.turnItems as unknown as { type: string; text?: string }[]).some((item) => item.type === "assistant_message" && (item.text ?? "").length > 5) ? true : undefined), 15_000);
	await bridge.interrupt("t");
	await statuses(["interrupted"]);

	// Resume: the stopped turn goes on, and nothing says it was stopped, then or with the message after it.
	await send("/continue");
	await settled();
	await statuses(["completed"]);
	expect(seen).toHaveLength(1);
	expect(seen[0]).not.toContain("stopped your previous turn");
	f.model.respond(fauxAssistantMessage("you are welcome"));
	await send("thanks");
	await settled();
	expect((await said()).at(-1)).toEqual(["thanks"]);

	// Stopped again while it writes, then a message: that one says it.
	f.model.respond(fauxAssistantMessage("Second, a long answer that will not be finished because it is stopped before its end comes."), answer("I was stopped"));
	await send("again");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" && (projection.turnItems as unknown as { type: string; text?: string }[]).filter((item) => item.type === "assistant_message").length >= 3 ? true : undefined), 15_000);
	await bridge.interrupt("t");
	await statuses(["completed", "completed", "interrupted"]);
	await send("what happened?");
	await settled();
	expect((await said()).at(-1)).toEqual(["what happened?", "[The user stopped your previous turn before it finished.]"]);
	// What the model is sent: its unfinished answer is not there, the line is.
	expect(seen[1]).toContain("The user stopped your previous turn before it finished.");
	expect(seen[1]).not.toContain("Second, a long answer");
});

it("a message sent behind others that wait says nothing of the stop: they run first", { timeout: 90_000 }, async () => {
	const { f, bridge, send, said, statuses, printed, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("to the queued one"), fauxAssistantMessage("to the new one"));
	await send("go");
	await printed("started");
	await send("queued before the stop", "queue");
	await bridge.interrupt("t");
	await statuses(["interrupted", "queued"]);
	await send("sent after it");
	await settled();
	const user = await said();
	expect(user.flat().some((text) => text.includes("stopped your previous turn"))).toBe(false);
	expect(user.map((blocks) => blocks[0])).toEqual(["go", "queued before the stop", "sent after it"]);
});

it("a stopped command that had printed more than is shown says so, and counts only what it shows", { timeout: 90_000 }, async () => {
	const { f, bridge, send, results, statuses, printed } = await setup();
	f.model.respond(calls(["loud", "bash", { command: "seq 1 100000; echo started; sleep 30" }]));
	await send("go");
	await printed("started");
	await bridge.interrupt("t");
	await statuses(["interrupted"]);
	const stored = (await results())[0]!.text;
	expect(stored).toMatch(/\n100000\nstarted\n\n\[Showing the last \d+ lines; earlier output is not shown\.\]\n\nCommand interrupted by the user; it may have partially run$/u);
	expect(stored).not.toMatch(/ of \d+ lines/u);
	expect(stored).not.toContain("<harness>");
	const count = Number(/Showing the last (\d+) lines/u.exec(stored)![1]);
	expect(stored.split("\n\n[Showing")[0]!.split("\n")).toHaveLength(count);

	// Dropped by its bytes, with room left for the lines: nothing more is cut, and it is still said (the call's own
	// record of what it dropped is all that tells).
	f.model.respond(calls(["wide", "bash", { command: "for i in $(seq 1 200); do printf '%0500d\\n' $i; done; echo started; sleep 30" }]));
	await send("again");
	await printed("started");
	await bridge.interrupt("t");
	await statuses(["interrupted", "interrupted"]);
	const wide = (await results()).at(-1)!.text;
	expect(wide).toMatch(/0200\nstarted\n\n\[Showing the last \d+ lines; earlier output is not shown\.\]\n\nCommand interrupted by the user; it may have partially run$/u);
	expect(wide.startsWith(`${"0".repeat(497)}001\n`), "its first lines went").toBe(false);
});

it("a Stop before the model's first word leaves nothing in the transcript, and is still told; after a restart of the host, without who", { timeout: 90_000 }, async () => {
	const { f, bridge, send, said, statuses, settled, reopened } = await setup();
	const held = gated("never said");
	f.model.respond(held.step, fauxAssistantMessage("I see"));
	await send("go");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await bridge.interrupt("t");
	await statuses(["interrupted"]);
	held.release();
	await send("what happened?", "steer");
	await settled();
	expect((await said()).at(-1)).toEqual(["what happened?", "[The user stopped your previous turn before it finished.]"]);

	// Who asked is in the host's memory; that the run was stopped is pi-durable's record, and outlives the host.
	const again = gated("never said either");
	f.model.respond(again.step, fauxAssistantMessage("I see"), fauxAssistantMessage("and again"));
	await send("go on", "steer");
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await bridge.interrupt("t");
	await statuses(["interrupted", "completed", "interrupted"]);
	again.release();
	const next = await reopened();
	await next.sendMessage({ threadId: "t", commandId: "after", messageId: "after", text: "and now?", mode: "steer" });
	await settled();
	expect((await said()).at(-1)).toEqual(["and now?", "[Your previous turn was stopped before it finished.]"]);
	await next.sendMessage({ threadId: "t", commandId: "last", messageId: "last", text: "thanks", mode: "steer" });
	await settled();
	expect((await said()).at(-1)).toEqual(["thanks"]);
});

it("after an undo, who stopped the turn that was undone is not said of the turn before it", { timeout: 90_000 }, async () => {
	const { f, bridge, send, results, said, statuses, printed, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]));
	await send("one");
	await printed("started");
	await bridge.interrupt("t", { by: "agent", reason: "the plan changed" });
	await statuses(["interrupted"]);
	f.model.respond(calls(["second", "bash", { command: "echo started; sleep 30" }]));
	await send("two");
	await printed("started");
	await bridge.interrupt("t");
	await statuses(["interrupted", "interrupted"]);
	// The turn the user stopped is taken back: what the thread now ends with is the one the agent stopped, in another
	// conversation. Nothing is said of a stop there: the call that agent cut off says it in its own result.
	await send("/undo");
	f.model.respond(fauxAssistantMessage("ok"));
	await send("three");
	await settled();
	expect((await said()).at(-1)).toEqual(["three"]);
	expect((await results()).at(-1)!.text).toBe("started\n\nCommand interrupted by another agent (the plan changed); it may have partially run");
});

it("a run stopped by nobody this host knows of says only that it was stopped, whoever stopped an earlier one", { timeout: 90_000 }, async () => {
	const { f, thread, bridge, send, results, said, statuses, printed, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]));
	await send("go");
	await printed("started");
	await bridge.interrupt("t", { by: "agent", reason: "the plan changed" });
	await statuses(["interrupted"]);
	f.model.respond(fauxAssistantMessage("ok"), calls(["second", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("I see"));
	await send("next");
	await settled();
	// Another run has been since: who stopped the first is not who stopped the next.
	await send("again");
	await printed("started");
	// Stopped past the bridge, as pi-durable ends a conversation's work for reasons of its own.
	await (await conversation(f.harness, thread.head)).abort(BACKGROUND_CONTEXT);
	await statuses(["interrupted", "completed", "interrupted"]);
	expect((await results()).at(-1)!.text).toBe("started\n\nCommand interrupted; it may have partially run");
	await send("and?");
	await settled();
	expect((await said()).at(-1)).toEqual(["and?", "[Your previous turn was stopped before it finished.]"]);
});

it("of two messages sent at once after a stop, only the one admitted first says it", { timeout: 90_000 }, async () => {
	const { f, bridge, said, statuses, printed, send, settled } = await setup();
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("to one"), fauxAssistantMessage("to the other"));
	await send("go");
	await printed("started");
	await bridge.interrupt("t");
	await statuses(["interrupted"]);
	// Both are on their way before either is admitted: each has read that the last run was stopped.
	await Promise.all([
		bridge.sendMessage({ threadId: "t", commandId: "both-1", messageId: "both-1", text: "one", mode: "steer" }),
		bridge.sendMessage({ threadId: "t", commandId: "both-2", messageId: "both-2", text: "the other", mode: "queue" }),
	]);
	await settled();
	const after = (await said()).slice(1);
	expect(after.map((blocks) => blocks[0]).sort()).toEqual(["one", "the other"]);
	// The one that started the run says it; the other follows that run, which nobody stopped.
	expect(after[0]).toHaveLength(2);
	expect(after[0]![1]).toBe("[The user stopped your previous turn before it finished.]");
	expect(after[1]).toHaveLength(1);
});

it("a message that joins a run says nothing of a stop before it: the stopped turn was resumed", { timeout: 90_000 }, async () => {
	const { f, bridge, send, said, statuses, printed, settled } = await setup({ tokensPerSecond: 8 });
	f.model.respond(calls(["first", "bash", { command: "echo started; sleep 30" }]), fauxAssistantMessage("Going on now with a long answer that takes its time to be written out in full, word after word."), fauxAssistantMessage("and that too"));
	await send("go");
	await printed("started");
	await bridge.interrupt("t");
	await statuses(["interrupted"]);
	await send("/continue");
	// While the resumed turn writes, a steer: the call the Stop cut off is still the last thing in the transcript.
	await bridge.waitFor("t", (projection) => (projection.runs.at(-1)?.status === "running" ? true : undefined), 15_000);
	await send("and also this", "steer");
	await settled();
	expect((await said()).at(-1)).toEqual(["and also this"]);
});

it("a run an undo left without its answer was not stopped: the next message says nothing", { timeout: 90_000 }, async () => {
	const { f, send, said, settled } = await setup();
	f.model.respond(fauxAssistantMessage("an answer"), fauxAssistantMessage("another"));
	await send("go");
	await settled();
	await send("/undo step");
	await send("differently");
	await settled();
	expect((await said()).at(-1)).toEqual(["differently"]);
});

it("a script a Stop cut off says so, with the calls it had made", { timeout: 90_000 }, async () => {
	const echo = defineTool({ name: "echo", description: "answers", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: "echoed" }] }) });
	const slow = abortable(defineTool({ name: "slow", description: "works for a while", parameters: object({}), execute: () => new Promise<{ output: { type: "text"; text: string }[] }>((resolve) => setTimeout(() => resolve({ output: [{ type: "text", text: "finished" }] }), 30_000)) }));
	const codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }) as never;
	const { f, bridge, send, results, statuses } = await setup({ extensions: [codemode, defineExtension({ name: "tools", tools: [echo, slow] })] });
	f.model.respond(calls(["script", "codemode", { code: "console.log('before');\nawait tools.echo({});\nawait tools.slow({});" }]), fauxAssistantMessage("ok"));
	await send("go");
	// The script is at its second call.
	for (let waited = 0; ; waited += 50) {
		const live = (await f.harness.snapshot((await import("@earendil-works/pi-durable")).LiveDoc, (await f.threads.thread("t"))!.head as never, BACKGROUND_CONTEXT)) as { nestedTools?: { name: string }[] } | undefined;
		if ((live?.nestedTools ?? []).some((slot) => slot.name === "slow")) break;
		if (waited > 15_000) throw new Error("the script never reached its second call");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	await bridge.interrupt("t");
	await statuses(["interrupted"]);
	expect((await results())[0]!.text).toBe("Script interrupted by the user; it may have partially run. Tool calls made before that (they are not undone): echo (ok), slow (cancelled)");
});
