// Crash child for boot repair: create a conversation that is NOT any thread's head, admit a run on it, record its id,
// then SIGKILL — the crash-between-admit-and-promote gap. The parent reopens and runs `Threads.repair()` to promote it.
// Run: node --experimental-strip-types src/testing/repair-child.ts <storage-path> <cwd-dir> <out-file>
import { writeFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createScriptedModel } from "./fake-model.ts";

const [storagePath, cwdDir, outFile] = process.argv.slice(2);
if (storagePath === undefined || cwdDir === undefined || outFile === undefined) {
	throw new Error("usage: repair-child.ts <storage-path> <cwd-dir> <out-file>");
}

// A slow, long turn so the run is still in flight when we kill (the admit is durable either way).
const model = createScriptedModel([fauxAssistantMessage("x".repeat(4000))], { tokensPerSecond: 8 });
const harness = await Harness.open(await openNodeSqliteStorage(storagePath), { models: model.models, registry: createRegistry() }, BACKGROUND_CONTEXT);

const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
await conversation.configure({ cwd: cwdDir, model: model.modelRef }, BACKGROUND_CONTEXT);
await conversation.submit({ type: "input", requestId: "crash-1", content: "go" }, BACKGROUND_CONTEXT);

// The run is admitted (LiveDoc.run set) and persists; crash before any promote could record it as a thread.
writeFileSync(outFile, String(conversation.id));
process.kill(process.pid, "SIGKILL");
