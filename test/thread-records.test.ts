// The thread record (`threads.ts`): one record and one summary per thread, a directory of ids and heads, and T3's
// creation fields and lineage carried from the write to the wire. Checked on a real SQLite store.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { defineDoc, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Threads } from "../src/threads.ts";
import { projectThread } from "../src/t3/projection.ts";
import { conversation, createNamed, idle, makeThreads, restart } from "./threads-harness.ts";
import { createScriptedModel } from "./fake-model.ts";

const ctx = BACKGROUND_CONTEXT;

/** Stored revision rows per document kind: `{ documents, rows }`. */
function storedRows(root: string): Map<string, { documents: number; rows: number }> {
	const db = new DatabaseSync(join(root, "durable.db"), { readOnly: true });
	try {
		const out = new Map<string, { documents: number; rows: number }>();
		for (const row of db.prepare("SELECT id, kind FROM documents").all() as { id: number; kind: string }[]) {
			const kind = JSON.parse(row.kind) as string;
			if (!kind.startsWith("pi-durable-t3.")) continue;
			const rows = (db.prepare("SELECT count(*) c FROM document_revisions WHERE document_id = ?").get(row.id) as { c: number }).c;
			const current = out.get(kind) ?? { documents: 0, rows: 0 };
			out.set(kind, { documents: current.documents + 1, rows: current.rows + rows });
		}
		return out;
	} finally {
		db.close();
	}
}

it("stores one record and one summary per thread, each a single row however often it is written", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	for (const id of ["a", "b", "c"]) await f.threads.create({ threadId: id, projectId: "p" });
	for (let i = 0; i < 20; i++) {
		await f.threads.remember("a", { updatedAt: 1_000 + i, itemCount: i, visibleItemCount: i });
		await f.threads.rename("b", `title ${i}`);
	}
	const rows = storedRows(f.root);
	expect(rows.get("pi-durable-t3.thread"), "one record per thread, one row each").toEqual({ documents: 3, rows: 3 });
	expect(rows.get("pi-durable-t3.thread-summary"), "only the remembered thread has a summary").toEqual({ documents: 1, rows: 1 });
	expect(rows.get("pi-durable-t3.threads"), "one directory").toEqual({ documents: 1, rows: 1 });
}, 30_000);

it("announces a change to the threads it touched, before the write returns", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await f.threads.create({ threadId: "a", projectId: "p" });
	await f.threads.create({ threadId: "b", projectId: "p" });
	const seen: string[][] = [];
	f.threads.onChange((ids) => seen.push([...ids].sort()));
	await f.threads.remember("a", { updatedAt: 5 });
	expect(seen, "a summary write names its thread only").toEqual([["a"]]);
	expect(f.threads.snapshot().find((thread) => thread.threadId === "a")?.summary?.updatedAt, "memory is current when the write returns").toBe(5);
	await f.threads.remove("b");
	expect(seen.at(-1), "a removal names the removed thread").toEqual(["b"]);
}, 30_000);

it("carries a thread's creation fields and lineage, and a message's sender, to the projection", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { threads, harness, model } = f;
	const created = await threads.create({ threadId: "agent-made", projectId: "p", provenance: { createdBy: "agent", creationSource: "mcp" } });
	await (await conversation(harness, created.head)).configure({ model: model.modelRef }, ctx);
	model.respond(fauxAssistantMessage("ok"));
	await threads.submit({ threadId: "agent-made", conversationId: created.head, requestId: "r1", messageId: "m1", message: "from another thread", provenance: { createdBy: "agent", creationSource: "mcp" } }, undefined);
	await idle(harness, created.head);
	const record = (await threads.list()).find((thread) => thread.threadId === "agent-made")!;
	const view = await (await conversation(harness, created.head)).viewState(ctx);
	const { projection, shell } = projectThread(
		{
			threadId: record.threadId,
			projectId: record.projectId,
			title: record.title,
			cwd: f.projects[0]!.cwd,
			createdAt: record.createdAt,
			updatedAt: record.createdAt,
			model: null,
			running: false,
			createdBy: record.createdBy,
			creationSource: record.creationSource,
			lineage: record.lineage,
			forkedFrom: record.forkedFrom,
		},
		view.value as never,
		{ rolledBack: [] },
	);
	expect({ createdBy: shell.createdBy, creationSource: shell.creationSource }).toEqual({ createdBy: "agent", creationSource: "mcp" });
	const message = projection.messages.find((candidate) => (candidate.id as string) === "m1");
	expect({ createdBy: message?.createdBy, creationSource: message?.creationSource }, "the message names its sender").toEqual({ createdBy: "agent", creationSource: "mcp" });
}, 30_000);

it("forks as T3 does: the source's root, the run it forked from, and the source's title with \" fork\"", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { threads, harness, model } = f;
	const source = await createNamed(threads, harness, model)({ threadId: "source", projectId: "p", title: "Plan" });
	model.respond(fauxAssistantMessage("answer"));
	await threads.submit({ threadId: "source", conversationId: source.head, requestId: "s1", message: "question" }, undefined);
	await idle(harness, source.head);
	const last = (await (await conversation(harness, source.head)).context(ctx)).entries.at(-1)!;
	const first = await threads.fork({ sourceThreadId: "source", targetThreadId: "f1", entryId: last.id, runId: "r1" });
	expect(first).toMatchObject({ title: "Plan fork", lineage: { parentThreadId: "source", relationshipToParent: "fork", rootThreadId: "source" }, forkedFrom: { type: "run", threadId: "source", runId: "r1" } });
	const second = await threads.fork({ sourceThreadId: "f1", targetThreadId: "f2", entryId: last.id });
	expect(second.lineage, "a fork of a fork keeps the first root").toEqual({ parentThreadId: "f1", relationshipToParent: "fork", rootThreadId: "source" });
}, 30_000);

it("keeps a deleted thread's record as its tombstone, across a restart", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const made = await f.threads.create({ threadId: "gone", projectId: "p" });
	await f.threads.remove("gone");
	const reopened = await restart(f);
	expect(await reopened.threads.list(), "not listed").toEqual([]);
	await reopened.threads.promote("gone", made.head);
	expect(await reopened.threads.list(), "its head is not promoted back").toEqual([]);
	await expect(reopened.threads.create({ threadId: "gone", projectId: "p" }), "its id is not reused").rejects.toThrow(/was deleted/);
	await reopened.harness.close(ctx);
}, 30_000);

it("refuses a store written with the version-1 threads document (no migration)", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await f.harness.close(ctx);
	// Write the old single document at the directory's kind, as a version-1 store has it.
	const legacy = defineDoc<{ threads: { threadId: string }[] }>({ kind: "pi-durable-t3.threads", version: 1, scope: "session", initial: () => ({ threads: [] }), checkpointWhen: () => true });
	const model = createScriptedModel([]);
	const old = await Harness.open(await openNodeSqliteStorage(join(f.root, "durable.db")), { models: model.models, registry: createRegistry() }, ctx);
	await old.commit(async (tx) => {
		(await tx.doc(legacy)).threads.push({ threadId: "t" });
	}, ctx);
	await old.close(ctx);
	const harness = await Harness.open(await openNodeSqliteStorage(join(f.root, "durable.db")), { models: model.models, registry: createRegistry() }, ctx);
	try {
		await expect(new Threads({ harness, registry: f.registry }).list()).rejects.toThrow(/requires migration from version 1/);
	} finally {
		await harness.close(ctx);
	}
}, 30_000);
