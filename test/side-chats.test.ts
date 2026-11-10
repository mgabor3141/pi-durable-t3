// T3's side chats and "Bring back": a side chat is a hidden fork showing only its own rows, whose first message tells
// the model it is a side chat and what the main thread did since; "Bring back" (`thread.merge_back`) gives the main
// thread's next message the side chat's conversation. Both are hidden context blocks, shown as rows.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { Orchestration } from "../src/t3/orchestration.ts";
import { mergeBackContext, sideChatNote } from "../src/t3/side-chats.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

type Msg = { role: string; content: unknown };
type Block = { type: string; text?: string; hidden?: boolean; shownAs?: { name: string; input: Record<string, string> } };

async function setup() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "main", projectId: "p", title: "Main" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-side-chats-"));
	const log: Logger = { info: () => {}, warn: () => {} };
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const seen: Msg[][] = [];
	const send = async (threadId: string, text: string, answer: string, extra: { titleSeed?: string } = {}) => {
		f.model.respond((context: { messages: unknown }) => {
			seen.push(context.messages as Msg[]);
			return fauxAssistantMessage(answer);
		});
		await bridge.sendMessage({ threadId, commandId: `c-${threadId}-${text}`, messageId: `m-${threadId}-${text}`, text, mode: "start", ...extra });
		await idle(f.harness, bridge.threadRecord(threadId)!.head as never);
	};
	/** The blocks of the last user message the model got. */
	const lastUser = (): Block[] => {
		const content = seen.at(-1)!.filter((message) => message.role === "user").at(-1)!.content;
		return typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);
	};
	const texts = (messages: Msg[]) => messages.flatMap((message) => (typeof message.content === "string" ? [message.content] : (message.content as Block[]).filter((block) => block.hidden !== true).map((block) => block.text ?? "")));
	return { bridge, send, lastUser, seen, texts };
}

it("a side chat is a hidden fork: its first message tells the model what the main thread did since, and its rows are its own", { timeout: 30_000 }, async () => {
	const { bridge, send, lastUser, seen, texts } = await setup();
	await send("main", "Plan the release", "Here is the plan.");
	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "side", title: "Side chat", sideChat: true });
	await send("main", "Now write the changelog", "Changelog written.");

	const record = bridge.threadRecord("side")!;
	expect(record.lineage).toEqual({ parentThreadId: "main", relationshipToParent: "fork", rootThreadId: "main", sideChat: true });
	const before = (await bridge.projection("side")).projection;
	expect(before.thread.lineage.sideChat).toBe(true);
	expect(before.messages, "it shows none of what it inherited").toEqual([]);
	expect(new Orchestration(bridge, { info: () => {}, warn: () => {} }).list(undefined, {}).map((row) => row.threadId), "lists leave it out").toEqual(["main"]);

	await send("side", "What does the plan say?", "It says ship Friday.", { titleSeed: "What does the plan say?" });
	// The model has the history up to the fork, and the note about what happened on the main thread since.
	expect(texts(seen.at(-1)!)).toEqual(expect.arrayContaining(["Plan the release", "What does the plan say?"]));
	expect(texts(seen.at(-1)!)).not.toContain("Now write the changelog");
	const note = lastUser().find((block) => block.hidden === true)!;
	expect(note.shownAs).toEqual({ name: "side_chat", input: { threadId: "main", title: "Main" } });
	expect(note.text).toContain("You are in a side chat beside the main thread.");
	expect(note.text).toContain("- User: Now write the changelog\n- Assistant: Changelog written.");
	expect(note.text).not.toContain("Plan the release");
	expect(note.text).toContain("Use thread_read on thread main to see the main thread's live state.");

	const after = (await bridge.projection("side")).projection;
	expect(after.messages.map((message) => message.text)).toEqual(["What does the plan say?", "It says ship Friday."]);
	expect(after.turnItems.map((item) => item.type)).toEqual(["user_message", "dynamic_tool", "assistant_message"]);
	expect(after.thread.title, "its first message names it, as T3's empty side chat").toBe("What does the plan say?");

	await send("side", "And the date?", "Friday.");
	expect(lastUser().some((block) => block.hidden === true), "only the first message has the note").toBe(false);

	await expect(bridge.forkThread({ sourceThreadId: "side", targetThreadId: "side-2", sideChat: true })).rejects.toThrow("A side chat cannot start another side chat.");
});

it("a side chat opened before the main thread has finished a turn starts empty, with the whole main thread as its note", { timeout: 30_000 }, async () => {
	const { bridge, send, lastUser, seen, texts } = await setup();
	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "side", sideChat: true });
	expect(bridge.threadRecord("side")!.forkedFrom).toBeNull();
	await send("side", "Hello?", "Hi.");
	expect(texts(seen.at(-1)!)).toEqual(["Hello?"]);
	const note = lastUser().find((block) => block.hidden === true)!.text!;
	expect(note).not.toContain("Main thread activity");
	expect(note.split("\n\n")).toHaveLength(2);
});

it("Bring back gives the main thread's next message the side chat's conversation, once", { timeout: 30_000 }, async () => {
	const { bridge, send, lastUser } = await setup();
	await send("main", "Plan the release", "Here is the plan.");
	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "side", title: "Side chat", sideChat: true });
	await expect(bridge.mergeBack({ sourceThreadId: "side", targetThreadId: "main", sourcePoint: { type: "latest_stable" } }), "nothing of its own yet").rejects.toThrow(
		"No stable source run was found for merge-back source latest_stable.",
	);
	await expect(bridge.mergeBack({ sourceThreadId: "main", targetThreadId: "side", sourcePoint: { type: "latest_stable" } })).rejects.toThrow("Thread main is not a fork of side.");
	await send("side", "Is Friday too early?", "Yes; ship Monday.");
	const sideRun = (await bridge.projection("side")).projection.runs.at(-1)!;
	await bridge.mergeBack({ sourceThreadId: "side", targetThreadId: "main", sourcePoint: { type: "run", runId: sideRun.id as string } });
	expect(bridge.threadRecord("main")!.pendingContext).toEqual({ type: "merge_back", sourceThreadId: "side", runId: sideRun.id });

	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "other", title: "Other" });
	await send("other", "Hm", "Ok.");
	await expect(bridge.mergeBack({ sourceThreadId: "other", targetThreadId: "main", sourcePoint: { type: "latest_stable" } })).rejects.toThrow(
		"Thread main already has pending context from another side chat or fork. Send a message there first.",
	);

	await send("main", "Go ahead", "Moving it to Monday.");
	const brought = lastUser().find((block) => block.hidden === true)!;
	expect(brought.shownAs).toEqual({ name: "merge_back", input: { threadId: "side", title: "Side chat" } });
	expect(brought.text).toContain('Context brought back from the side chat "Side chat" (side) of this thread');
	expect(brought.text).toContain("[User]\nIs Friday too early?\n\n[Assistant]\nYes; ship Monday.");
	expect(brought.text).not.toContain("Plan the release");
	expect(bridge.threadRecord("main")!.pendingContext).toBeUndefined();
	const rows = (await bridge.projection("main")).projection.turnItems.filter((item) => item.type === "dynamic_tool");
	expect(rows.map((item) => (item as unknown as { toolName: string }).toolName)).toEqual(["merge_back"]);

	await send("main", "Thanks", "Sure.");
	expect(lastUser().some((block) => block.hidden === true)).toBe(false);
});

it("a side chat that never got a message is deleted only if still unused; deleting the main thread deletes its side chats", { timeout: 30_000 }, async () => {
	const { bridge, send } = await setup();
	await send("main", "Start", "Started.");
	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "empty", sideChat: true });
	await bridge.forkThread({ sourceThreadId: "main", targetThreadId: "used", sideChat: true });
	await send("used", "Question", "Answer.");
	await bridge.deleteThread("used", { onlyIfUnused: true });
	expect(bridge.hasThread("used"), "it has a message of its own").toBe(true);
	await bridge.deleteThread("empty", { onlyIfUnused: true });
	expect(bridge.hasThread("empty")).toBe(false);
	await bridge.deleteThread("main");
	expect(bridge.hasThread("main")).toBe(false);
	expect(bridge.hasThread("used"), "a side chat goes with its main thread").toBe(false);
});

it("the merge-back context keeps the last exchange and the first question when the conversation is long", () => {
	const turn = (n: number, size: number) => [
		{ id: `u${n}`, type: "user_message", runId: `r${n}`, text: `question ${n} ${"q".repeat(size)}` },
		{ id: `a${n}`, type: "assistant_message", runId: `r${n}`, text: `answer ${n} ${"a".repeat(size)}` },
	];
	const runs = Array.from({ length: 12 }, (_, n) => ({ id: `r${n}`, status: "completed" }));
	const projection = { runs, turnItems: runs.flatMap((_, n) => turn(n, 1_500)) } as never;
	const text = mergeBackContext({ threadId: "f", title: "F", sideChat: false }, projection, undefined, "r11");
	expect(text.length).toBeLessThanOrEqual(16_000);
	expect(text).toContain("question 0 ");
	expect(text).toContain("question 11 ");
	expect(text).toContain("answer 11 ");
	expect(text).toMatch(/\[\d+ earlier messages left out; read them with thread_read on thread f\.\]/);
	expect(text.indexOf("question 0 ")).toBeLessThan(text.indexOf("question 11 "));

	const huge = { runs: [{ id: "r0", status: "completed" }], turnItems: [{ id: "u", type: "user_message", runId: "r0", text: "q" }, { id: "a", type: "assistant_message", runId: "r0", text: "x".repeat(40_000) }] } as never;
	const cut = mergeBackContext({ threadId: "f", title: "F", sideChat: true }, huge, undefined, "r0");
	expect(cut.length).toBeLessThanOrEqual(16_000);
	expect(cut).toContain("[…cut]");

	const items = Array.from({ length: 200 }, (_, n) => ({ id: `u${n}`, type: "user_message", runId: "r1", text: `line ${n} ${"z".repeat(100)}` }));
	const note = sideChatNote("m", { runs: [{ id: "r0", status: "completed" }, { id: "r1", status: "running" }], turnItems: items } as never, "r0");
	expect(note.length).toBeLessThanOrEqual(8_000);
	expect(note).toContain("- Earlier items truncated.");
	expect(note).toContain("line 199 ");
});
