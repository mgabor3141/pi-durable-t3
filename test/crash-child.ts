// Crash child: the example's EXACT wiring — the projects file + `openCodingHarness` (storage under
// the root, coding tools, env builder) + a `Threads` layer. It creates a thread, submits a turn whose generation
// streams for minutes, prints the conversation id once the submit is committed, and parks until the parent SIGKILLs
// it, so the run is in flight at crash time. The parent restarts the bridge over the same storage and the turn
// finishes (boot repair + resume, see test/crash-restart.test.ts).
//
// Run: node --experimental-strip-types test/crash-child.ts <root> <project-title> <out-file>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Threads } from "../src/threads.ts";
import { FileProjectRegistry } from "../src/registry.ts";
import { openCodingHarness } from "../examples/coding-agent/host-runtime.ts";
import { createScriptedModel } from "./fake-model.ts";

const [root, project, outFile] = process.argv.slice(2);
if (root === undefined || project === undefined || outFile === undefined) throw new Error("usage: crash-child.ts <root> <project> <out-file>");

// The instance file the host edits on the UI's behalf: a project at `<root>/p` (its id is derived from that path).
writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ path: join(root, "p"), title: project }] }) + "\n");
const registry = FileProjectRegistry.open(root);
// ~5 minutes of streaming at this rate: the generation is unmistakably mid-flight when the parent kills us.
const model = createScriptedModel([fauxAssistantMessage("token ".repeat(2000))], { tokensPerSecond: 6 });
const runtime = await openCodingHarness({ dataDir: root }, registry, model.models);
const threads = new Threads({ harness: runtime.harness, registry });
const projectId = registry.list()[0]!.id;
const thread = await threads.create({ threadId: "crash", projectId });
// The client names the model (the bridge stores what the client sends): configure the fresh head before submitting.
const head = await runtime.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
await head?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
await threads.submit({ threadId: "crash", conversationId: thread.head, requestId: "crash-1", message: "go" }, undefined);
writeFileSync(outFile, String(thread.head));
process.stdout.write(`ADMITTED ${thread.head}\n`);
// Park: the scheduler keeps streaming until the process dies.
await new Promise(() => {});
