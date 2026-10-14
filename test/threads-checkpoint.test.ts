// `ThreadsDoc` sets `checkpointWhen: () => true`, so every write to the threads document is stored as a base that
// supersedes (and, for a current-only session document, deletes) the deltas it replaces. Without that policy the doc
// appends a delta row per create/remove/undo and `document_revisions` grows one row per write, forever — the exact
// "storage only grows" note this fix removes. This runs real create/remove cycles on a real SQLite store and asserts the
// threads document keeps ZERO delta rows (a bounded, checkpointed doc), which the pre-fix code (1 base + N deltas) fails.
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Threads } from "../src/threads.ts";
import { createScriptedModel } from "../src/testing/fake-model.ts";

const ctx = BACKGROUND_CONTEXT;
const THREADS_KIND = "pi-durable-t3.threads";
const CYCLES = 20;

describe("threads document checkpoints", () => {
	it("create/remove cycles do not append a revision row per write", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-checkpoint-"));
		if (dir.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
		const dbPath = join(dir, "durable.db");
		const storage = await openNodeSqliteStorage(dbPath);
		const model = createScriptedModel([]);
		const harness = await Harness.open(storage, { models: model.models, registry: createRegistry() }, ctx);
		try {
			const threads = new Threads({ harness, projects: [{ id: "p", name: "p", cwd: dir }], defaultModel: model.modelRef });
			for (let i = 0; i < CYCLES; i++) {
				await threads.create({ threadId: `t${i}`, projectId: "p" });
				await threads.remove(`t${i}`);
			}

			const revisions = () => {
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					// The `kind` column stores the JSON-encoded kind string; decode to match, not a hand-quoted literal.
					const doc = db
						.prepare("SELECT id, kind FROM documents")
						.all()
						.find((row) => JSON.parse((row as { kind: string }).kind) === THREADS_KIND) as { id: number } | undefined;
					if (doc === undefined) return { base: -1, delta: -1, total: -1 };
					const group = (kind: string) =>
						(db.prepare("SELECT count(*) c FROM document_revisions WHERE document_id = ? AND kind = ?").get(doc.id, kind) as { c: number }).c;
					return { base: group("base"), delta: group("delta"), total: group("base") + group("delta") };
				} finally {
					db.close();
				}
			};

			const { base, delta, total } = revisions();
			// A checkpointed current-only doc: one base, no accumulated deltas. (Pre-fix: 1 base + ~2·CYCLES deltas.)
			expect(base).toBe(1);
			expect(delta).toBe(0);
			expect(total).toBeLessThanOrEqual(2);
			expect(total).toBeLessThan(2 * CYCLES);
		} finally {
			await harness.close(ctx);
			await storage.close(ctx);
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
