#!/usr/bin/env node
// One-off migration from the single version-1 T3 threads document to the version-2 directory plus
// per-thread records, summaries, projects, and deletion tombstones.
//
// Usage:
//   node scripts/migrate-threads-v2.mjs --db <durable.db> --projects <projects.json> [--dry-run]
//
// The database must be offline: the harness is the only writer. The script refuses a store that
// already has the new documents, so a failed run changes nothing and can be retried from the backup.
// It prints only counts and never conversation text.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const dbPath = option("--db");
const projectsPath = option("--projects");
const dryRun = args.includes("--dry-run");
if (!dbPath || !projectsPath) {
  console.error("usage: node scripts/migrate-threads-v2.mjs --db <durable.db> --projects <projects.json> [--dry-run]");
  process.exit(2);
}

const projectIdForPath = (path) => `p-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
const titleFor = (path) => path.replace(/\/+$/, "").split("/").pop() || path;

const storage = await openNodeSqliteStorage(dbPath);
try {
  const scan = (kind) => storage.scanDocuments({ scope: { kind: "session" }, at: "current", kind }, 1000, undefined, BACKGROUND_CONTEXT);
  const oldDocs = await scan("pi-durable-t3.threads");
  if (oldDocs.items.length === 0) {
    console.log("no pi-durable-t3.threads document; nothing to migrate");
    process.exit(0);
  }
  if (oldDocs.items.length !== 1) throw new Error(`expected one pi-durable-t3.threads document, found ${oldDocs.items.length}`);
  const oldId = oldDocs.items[0].id;
  const old = await storage.document(oldId, "current", BACKGROUND_CONTEXT);
  if (old === undefined) throw new Error("the threads document could not be read");
  if (old.version === 2) {
    console.log("threads document is already version 2; nothing to migrate");
    process.exit(0);
  }
  if (old.version !== 1) throw new Error(`unsupported threads document version ${old.version}`);
  for (const kind of ["pi-durable-t3.thread", "pi-durable-t3.thread-summary", "pi-durable-t3.projects", "pi-durable-t3.command-receipts"]) {
    const existing = await scan(kind);
    if (existing.items.length > 0) throw new Error(`refusing to migrate: ${kind} documents already exist`);
  }

  const oldState = old.value;
  const oldThreads = Array.isArray(oldState.threads) ? oldState.threads : [];
  const removed = Array.isArray(oldState.removed) ? oldState.removed : [];
  const projectsFile = JSON.parse(await readFile(projectsPath, "utf8"));
  const oldProjects = Array.isArray(projectsFile.projects) ? projectsFile.projects : [];

  const projects = [];
  const projectIds = new Set();
  for (const entry of oldProjects) {
    if (typeof entry?.path !== "string" || entry.path.trim() === "") throw new Error("a project has no path");
    const path = resolve(entry.path);
    const id = typeof entry.id === "string" && entry.id.trim() !== "" ? entry.id.trim() : projectIdForPath(path);
    if (projectIds.has(id)) throw new Error(`duplicate project id: ${id}`);
    projectIds.add(id);
    projects.push({ id, path, title: typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title : titleFor(path) });
  }
  const fallbackProject = projects[0]?.id;
  const threadIds = new Set();
  const headOwner = new Map();
  const byThreadId = new Map();

  for (const thread of oldThreads) {
    if (typeof thread?.threadId !== "string" || thread.threadId === "") throw new Error("a thread has no id");
    if (threadIds.has(thread.threadId)) throw new Error(`duplicate thread id: ${thread.threadId}`);
    if (typeof thread.head !== "number") throw new Error(`thread ${thread.threadId} has no numeric head`);
    if (typeof thread.projectId !== "string" || !projectIds.has(thread.projectId)) throw new Error(`thread ${thread.threadId} points at an unknown project`);
    if (headOwner.has(thread.head)) throw new Error(`two threads point at conversation head ${thread.head}`);
    threadIds.add(thread.threadId);
    headOwner.set(thread.head, thread.threadId);
    byThreadId.set(thread.threadId, thread);
  }
  if (fallbackProject === undefined) throw new Error("there are no projects to anchor tombstones");

  const rootOf = (threadId) => {
    const seen = new Set();
    let current = byThreadId.get(threadId);
    while (typeof current?.parent?.threadId === "string" && byThreadId.has(current.parent.threadId) && !seen.has(current.parent.threadId)) {
      seen.add(current.parent.threadId);
      current = byThreadId.get(current.parent.threadId);
    }
    return current?.threadId ?? threadId;
  };

  const records = [];
  const summaries = [];
  const live = [];
  const heads = {};
  const ignoredUndos = Array.isArray(oldState.undos) ? oldState.undos.length : 0;
  for (const thread of oldThreads) {
    const parentId = typeof thread.parent?.threadId === "string" ? thread.parent.threadId : null;
    const lineage = parentId === null
      ? { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.threadId }
      : { parentThreadId: parentId, relationshipToParent: "fork", rootThreadId: rootOf(thread.threadId) };
    const record = {
      threadId: thread.threadId,
      projectId: thread.projectId,
      head: thread.head,
      title: typeof thread.title === "string" ? thread.title : "",
      createdAt: typeof thread.createdAt === "number" ? thread.createdAt : Date.now(),
      createdBy: "user",
      creationSource: "web",
      lineage,
      forkedFrom: null,
      ...(thread.settledOverride === "settled" || thread.settledOverride === "active" ? { settledOverride: thread.settledOverride } : {}),
      ...(typeof thread.settledAt === "number" ? { settledAt: thread.settledAt } : {}),
      ...(typeof thread.unsettledAt === "number" ? { unsettledAt: thread.unsettledAt } : {}),
      deletedAt: null,
      undos: [],
      revision: 0,
    };
    records.push({ kind: "pi-durable-t3.thread", key: thread.threadId, value: record });
    live.push(thread.threadId);
    heads[String(thread.head)] = thread.threadId;
    if (thread.summary !== undefined && thread.summary !== null) {
      if (typeof thread.summary !== "object" || Array.isArray(thread.summary)) throw new Error(`thread ${thread.threadId} has a malformed summary`);
      summaries.push({ kind: "pi-durable-t3.thread-summary", key: thread.threadId, value: { ...thread.summary, revision: 1 } });
    }
  }

  for (const head of removed) {
    if (typeof head !== "number") throw new Error("a removed entry is not a conversation head");
    if (heads[String(head)] !== undefined) continue;
    const threadId = `removed-${head}`;
    if (threadIds.has(threadId)) throw new Error(`tombstone id collides with a live thread: ${threadId}`);
    records.push({
      kind: "pi-durable-t3.thread",
      key: threadId,
      value: {
        threadId,
        projectId: fallbackProject,
        head,
        title: "",
        createdAt: Date.now(),
        createdBy: "user",
        creationSource: "web",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        deletedAt: Date.now(),
        undos: [],
        revision: 0,
      },
    });
    heads[String(head)] = threadId;
  }

  const directory = { threads: live, heads, revision: 1 };
  const projectState = { projects, revision: 1 };
  console.log(JSON.stringify({
    oldId,
    threads: live.length,
    summaries: summaries.length,
    tombstones: records.length - live.length,
    projects: projects.length,
    ignoredUndos,
    removedHeads: removed.length,
  }));
  if (dryRun) {
    console.log("dry run: no writes");
    process.exit(0);
  }

  const created = async (kind, value, key) => ({
    type: "document.create",
    record: { id: await storage.mintId(), kind, scope: { kind: "session" }, ...(key === undefined ? {} : { key }) },
    content: { version: 1, kind: "base", value },
  });
  const writes = [];
  for (const record of records) writes.push(await created(record.kind, record.value, record.key));
  for (const summary of summaries) writes.push(await created(summary.kind, summary.value, summary.key));
  writes.push(await created("pi-durable-t3.projects", projectState));
  writes.push({ type: "document.change", id: oldId, content: { version: 2, kind: "base", value: directory } });
  const result = await storage.commit([writes], () => {}, BACKGROUND_CONTEXT);
  if (result?.refused !== undefined) throw result.refused instanceof Error ? result.refused : new Error(String(result.refused));
  if (result?.stored !== 1) throw new Error(`expected one stored batch, got ${result?.stored}`);
  console.log(`migrated ${live.length} threads and ${projects.length} projects; ${records.length - live.length} tombstones`);
} finally {
  await storage.close(BACKGROUND_CONTEXT);
}
