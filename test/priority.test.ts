// A thread's request priority (`priority.ts`): which choice a thread runs at, what reaches the request, and what a
// fork takes. The wire (the option on the picker, the field in a real request) is `request-priority.test.ts`.
import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { GenerationTask } from "@earendil-works/pi-durable";
import { priorityChoice, priorityExtension, type PriorityNode, threadPriority } from "../src/t3/priority.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { conversation, createNamed, firstUserEntry, idle, makeThreads } from "./threads-harness.ts";

const node = (relationship: "fork" | "subagent" | null, parent: string | null, priority?: PriorityNode["priority"], sideChat = false): PriorityNode => ({
	...(priority === undefined ? {} : { priority }),
	lineage: { parentThreadId: parent, relationshipToParent: relationship, ...(sideChat ? { sideChat: true as const } : {}) },
});

it("a thread runs at its own priority, else its parent's; past a fork, only what the fork's origin inherits", () => {
	const threads: Record<string, PriorityNode> = {
		root: node(null, null, "low"),
		child: node("subagent", "root"),
		grandchild: node("subagent", "child"),
		side: node("fork", "root", undefined, true),
		own: node("subagent", "root", "high"),
		// A fork of `root` that took Inherited: `root`'s own Low is not read, and `root` inherits nothing.
		fork: node("fork", "root"),
		// A fork of `own` (a subagent of `root`) that took Inherited: past `own`, `root`'s Low.
		forkOfChild: node("fork", "own"),
		forkOfFork: node("fork", "fork"),
		forkKept: node("fork", "root", "normal"),
		loopA: node("subagent", "loopB"),
		loopB: node("subagent", "loopA"),
	};
	const at = (threadId: string) => threadPriority(threadId, (id) => threads[id]);
	expect(at("root")).toBe("low");
	expect(at("child")).toBe("low");
	expect(at("grandchild")).toBe("low");
	expect(at("side")).toBe("low");
	expect(at("own")).toBe("high");
	expect(at("fork")).toBeUndefined();
	expect(at("forkOfChild")).toBe("low");
	expect(at("forkOfFork")).toBeUndefined();
	expect(at("forkKept")).toBe("normal");
	expect(at("loopA")).toBeUndefined();
	expect(at("unknown")).toBeUndefined();
});

it("a selection names a choice, Inherited, or nothing; another value is an error that names it", () => {
	expect(priorityChoice([{ id: "thinking", value: "high" }])).toBeUndefined();
	expect(priorityChoice(undefined)).toBeUndefined();
	expect(priorityChoice([{ id: "priority", value: "high" }])).toBe("high");
	expect(priorityChoice([{ id: "priority", value: "inherit" }])).toBeNull();
	expect(() => priorityChoice([{ id: "priority", value: "-5" }])).toThrow("Unknown priority: -5");
});

it("a request gets the thread's priority only where pi gave it the field", async () => {
	const values: Record<number, number | undefined> = { 1: -5, 2: undefined };
	const extension = priorityExtension({ priorityOf: (conversationId) => values[conversationId as number] });
	const handler = extension.hooks!.find((installed) => installed.task === GenerationTask.definition.name)!.handlers as {
		beforeProviderRequest: (request: { model: unknown; payload: unknown }, api: { conversationId: number }) => unknown;
	};
	const run = (payload: unknown, conversationId: number) => handler.beforeProviderRequest({ model: {}, payload }, { conversationId });
	expect(run({ model: "m", priority: 3 }, 1)).toEqual({ payload: { model: "m", priority: -5 } });
	// Inherited all the way up: models.json's value stands.
	expect(run({ model: "m", priority: 3 }, 2)).toBeUndefined();
	// No field: a provider without `compat.vllmPriority`, or another API's request.
	expect(run({ model: "m" }, 1)).toBeUndefined();
	expect(run("text", 1)).toBeUndefined();
});

it("a fork takes its source's priority as it is when made; a side chat takes none of its own", async () => {
	const { threads, harness, model } = await makeThreads({ projects: [{ id: "p" }] });
	const create = createNamed(threads, harness, model);
	const source = await create({ threadId: "source", projectId: "p", title: "Source" });
	await threads.updateRecord("source", (record) => {
		record.priority = "low";
	});
	model.respond(fauxAssistantMessage("answer"));
	await threads.submit({ threadId: "source", conversationId: source.head, requestId: "s1", message: "question" }, undefined);
	await idle(harness, source.head);
	const entryId = (await (await conversation(harness, source.head)).context(BACKGROUND_CONTEXT)).entries.at(-1)!.id;
	const fork = await threads.fork({ sourceThreadId: "source", targetThreadId: "fork", entryId, title: "Fork" });
	const side = await threads.fork({ sourceThreadId: "source", targetThreadId: "side", entryId, title: "Side", sideChat: true });
	expect(fork.priority).toBe("low");
	expect(side.priority).toBeUndefined();
	await threads.updateRecord("source", (record) => {
		record.priority = "high";
	});
	expect((await threads.thread("fork"))?.priority, "the fork keeps what it took").toBe("low");
});

it("an undo's fork that a late prompt makes a thread of takes the thread's priority", async () => {
	const { threads, harness, model } = await makeThreads();
	const create = createNamed(threads, harness, model);
	const thread = await create({ threadId: "t", projectId: "p" });
	await threads.updateRecord("t", (record) => {
		record.priority = "high";
	});
	const oldHead = thread.head;
	model.respond(fauxAssistantMessage("seed"));
	await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "seed", message: "hi" }, undefined);
	await idle(harness, oldHead);
	await threads.rewind({ threadId: "t", expectedHead: oldHead, entryId: await firstUserEntry(harness, oldHead), requestId: "undo" });
	model.respond(fauxAssistantMessage("after"));
	await threads.submit({ threadId: "t", conversationId: oldHead, requestId: "late", message: "still here" }, undefined);
	await idle(harness, oldHead);
	const child = (await threads.list()).find((candidate) => candidate.head === oldHead);
	expect(child?.lineage.relationshipToParent).toBe("fork");
	expect(child?.priority).toBe("high");
});
