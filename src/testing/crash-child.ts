// Crash child: the EXACT host wiring `main.ts` runs — the instance file (settings.json) + `openHostRuntime` (storage
// under the root, coding tools, env builder, Threads, boot repair, resume). It creates a thread, submits a turn whose
// generation streams for minutes, prints the conversation id once the submit is committed, and parks until the parent
// SIGKILLs it, so the run is in flight at crash time.
//
// Run: node --experimental-strip-types src/testing/crash-child.ts <root> <project-title> <out-file>
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseConfigToml } from "../config.ts";
import { openHostRuntime } from "../host-runtime.ts";
import { FileProjectRegistry } from "../registry.ts";
import { writeInstanceFile } from "../settings.ts";
import { createScriptedModel } from "./fake-model.ts";

const [root, project, outFile] = process.argv.slice(2);
if (root === undefined || project === undefined || outFile === undefined) throw new Error("usage: crash-child.ts <root> <project> <out-file>");

// The instance file the host edits on the UI's behalf: a project at `<root>/p` (its id is derived from that path).
await writeInstanceFile(root, { projects: [{ path: join(root, "p"), title: project }], defaults: {} });
const config = parseConfigToml(`listen = "127.0.0.1:1"\n`, root);
const registry = await FileProjectRegistry.open(root);
// ~5 minutes of streaming at this rate: the generation is unmistakably mid-flight when the parent kills us.
const model = createScriptedModel([fauxAssistantMessage("token ".repeat(2000))], { tokensPerSecond: 6 });
const runtime = await openHostRuntime(config, registry, model.models, model.modelRef);
const projectId = registry.list()[0]!.id;
const thread = await runtime.threads.create({ threadId: "crash", projectId });
await runtime.threads.submit({ threadId: "crash", conversationId: thread.head, requestId: "crash-1", message: "go" }, undefined);
writeFileSync(outFile, String(thread.head));
process.stdout.write(`ADMITTED ${thread.head}\n`);
// Park: the scheduler keeps streaming until the process dies.
await new Promise(() => {});
