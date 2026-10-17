// A promoted conversation gets its project from its own cwd, never from list order (H3). The old code attached a
// promoted thread to `via?.projectId ?? this.projects[0]?.id ?? ""` — the FIRST registered project, and the empty
// string when there were none: a prompt racing a `project.delete` resurrected threads under an unrelated project,
// and `thread.create` racing a delete stranded rows with a dangling FK. Promotion resolves the
// project for a conversation from its own recorded `pi.agent.cwd` through the registry; if no project covers it, the
// conversation is NOT promoted — it stays ownerless and the log names it. A thread never carries an empty `projectId`.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Threads, scanConversations } from "../src/threads.ts";
import { createNamed, firstUserEntry, idle, makeThreads } from "./threads-harness.ts";

const seed = fauxAssistantMessage("seed");

it("(a) a conversation whose cwd matches no project is NOT promoted, and the log names it", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }, { id: "q" }] });
	const { harness, model } = f;
	const warnings: string[] = [];
	const threads = new Threads({ harness, registry: f.registry, onWarn: (m) => warnings.push(m) });
	const create = createNamed(threads, harness, model);

	// A fresh conversation whose cwd belongs to no registered project (the registry lost it, or it was hand-made).
	const conversationId = await harness.commit(async (tx) => {
		const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, created.id, { cwd: join(f.root, "nowhere") });
		return created.id;
	}, BACKGROUND_CONTEXT);

	await threads.promote("nobody", conversationId);
	expect(await threads.list(), "no thread was promoted for the uncovered conversation").toEqual([]);
	expect(warnings.join("\n"), `the log names the conversation: ${JSON.stringify(warnings)}`).toContain(String(conversationId));
}, 30_000);

it("a promoted conversation lands in the project that covers ITS cwd — never the first registered one", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }, { id: "q" }] });
	const { threads, harness, model } = f;
	const create = createNamed(threads, harness, model);
	// Registry order is [p, q]; the conversation lives in q. List-order attribution would say `p`.
	const t = await create({ threadId: "t", projectId: "q" });
	const head = t.head;
	model.respond(seed);
	await threads.submit({ threadId: "t", conversationId: head, requestId: "seed", message: "hi" }, undefined);
	await idle(harness, head);
	const entry = await firstUserEntry(harness, head);
	// Move the thread off `head` (undo), so `head` is nobody's head — then promote it naming a thread the document
	// does not have: the old code fell back to `projects[0]` (p); the conversation's own cwd says q.
	await threads.rewind({ threadId: "t", expectedHead: head, entryId: entry, requestId: "undo" });
	expect((await threads.list()).some((candidate) => candidate.head === head)).toBe(false);

	await threads.promote("ghost", head);
	const promoted = (await threads.list()).find((candidate) => candidate.head === head);
	expect(promoted, "the conversation is promoted").toBeDefined();
	expect(promoted?.projectId, "its project is the one covering its own cwd (q), not projects[0] (p)").toBe("q");
}, 30_000);

it("(b) after creates, prompts, promotes and an undo whose cwd is uncovered, NO thread carries an unknown or empty projectId", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }, { id: "q" }] });
	const { threads, harness, model } = f;
	const create = createNamed(threads, harness, model);
	const warnings: string[] = [];
	const layer = new Threads({ harness, registry: f.registry, onWarn: (m) => warnings.push(m) });

	// Creates and prompts in both projects.
	const a = await create({ threadId: "a", projectId: "p" });
	const b = await create({ threadId: "b", projectId: "q" });
	model.respond(seed);
	model.respond(seed);
	await threads.submit({ threadId: "a", conversationId: a.head, requestId: "a1", message: "one" }, undefined);
	await idle(harness, a.head);
	await threads.submit({ threadId: "b", conversationId: b.head, requestId: "b1", message: "two" }, undefined);
	await idle(harness, b.head);

	// An undo on `a` whose head has moved on: the fork is added as a child thread (project from the conversation).
	const entryA = await firstUserEntry(harness, a.head);
	await threads.rewind({ threadId: "a", expectedHead: a.head, entryId: entryA, requestId: "u1" }); // moves a's head
	await threads.rewind({ threadId: "a", expectedHead: a.head, entryId: entryA, requestId: "u2" }); // fork becomes a child
	// A promote of `a`'s old head (nobody's head now) lands in the project covering its cwd.
	await threads.promote("a", a.head);

	// Every row written while both projects were registered carries a known, non-empty projectId.
	const knownAll = new Set(["p", "q"]);
	for (const row of await layer.list()) {
		expect(knownAll.has(row.projectId), `row ${row.threadId} carries a known project: ${row.projectId}`).toBe(true);
		expect(row.projectId, "never the empty string").not.toBe("");
	}

	// The project-removal cascade (the bridge's order): drop the threads, then the entry. `b`'s conversation cwd
	// (q's folder) then covers NO project: a promote of its head is refused (ownerless, logged) — never attached to
	// the first registered project, never written with "". And an undo naming the removed thread adds NO ghost row.
	const entryB = await firstUserEntry(harness, b.head);
	await threads.remove("b");
	f.registry.remove("q");
	await layer.promote("b", b.head);
	const forked = await layer.rewind({ threadId: "b", expectedHead: b.head, entryId: entryB, requestId: "u3" });

	const known = new Set(f.registry.list().map((project) => project.id));
	const rows = await layer.list();
	expect(rows.length, "the surviving sequence produced rows").toBeGreaterThan(0);
	for (const row of rows) {
		expect([row.threadId, known.has(row.projectId)], `thread ${row.threadId} carries the known project ${row.projectId}`).toEqual([row.threadId, true]);
		expect(row.projectId, "never the empty string").not.toBe("");
	}
	// `b`'s head stayed ownerless (its promote is tombstoned — removed threads stay removed, silently), its late
	// undo added no ghost, and the log names the fork refusal by conversation id.
	expect(rows.some((row) => row.head === b.head), "b's uncovered conversation was not promoted").toBe(false);
	expect(rows.some((row) => row.head === forked), "the undo of the removed thread's head added no ghost row").toBe(false);
	expect(warnings.join("\n"), `the refusal names the conversation: ${JSON.stringify(warnings)}`).toContain(String(forked));

	// A promote naming b's head follows the same rule: the tombstone outranks it — nothing is added.
	await layer.promote("b", b.head);
	const after = await layer.list();
	expect(after.map((row) => row.threadId).sort()).toEqual(rows.map((row) => row.threadId).sort());
	const conversations = await harness.commit((tx) => scanConversations(tx), BACKGROUND_CONTEXT);
	expect(conversations.length).toBeGreaterThanOrEqual(rows.length);
}, 30_000);
