// Boot repair after a crash: a conversation that had a run admitted but was never promoted to a thread (the crash sat
// between the admit commit and the promote commit) is promoted on reopen. Load-bearing proof of `Threads.repair()`.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { tempRoot } from "./temp-root.ts";
import { createScriptedModel } from "./fake-model.ts";
import { testRegistry } from "./test-registry.ts";
import { Threads } from "../src/threads.ts";

const childScript = new URL("./repair-child.ts", import.meta.url).pathname;

function runChild(args: readonly string[]): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", childScript, ...args], { stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => resolve(code));
	});
}

describe("boot repair", () => {
	it("promotes a crashed conversation that was admitted but never promoted", async () => {
		const dir = await tempRoot();
		const storage = join(dir, "durable.db");
		const outFile = join(dir, "id.txt");
		const work = join(dir, "proj");
		await mkdir(work, { recursive: true });

		// The child admits a run on a fresh, untracked conversation, then SIGKILLs itself.
		await runChild([storage, work, outFile]);
		const crashed = Number(readFileSync(outFile, "utf8"));
		expect(crashed).toBeTypeOf("number");

		// Reopen without resuming scheduling, then repair: the owed, untracked conversation becomes a thread.
		const storageHandle = await openNodeSqliteStorage(storage);
		const harness = await Harness.open(storageHandle, { models: createScriptedModel([]).models, registry: createRegistry() }, BACKGROUND_CONTEXT);
		const threads = new Threads({ harness, registry: testRegistry([{ id: "p", cwd: work }]) });
		await threads.repair();

		const promoted = (await threads.list()).find((thread) => thread.head === crashed);
		expect(promoted, "the crashed conversation is now a thread").toBeDefined();
		expect(promoted?.projectId).toBe("p");
		// A second repair adds nothing: it is idempotent (the conversation is already a head).
		await threads.repair();
		expect((await threads.list()).filter((thread) => thread.head === crashed)).toHaveLength(1);

		await harness.close(BACKGROUND_CONTEXT);
	}, 30_000);
});
