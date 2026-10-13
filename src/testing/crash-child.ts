// Crash child: the EXACT host wiring `main.ts` runs — `openHostRuntime` (storage under the root, coding tools, env
// builder, Threads, boot repair, resume). It creates a thread, submits a turn whose generation streams for minutes,
// prints the conversation id once the submit is committed, and parks until the parent SIGKILLs it, so the run is
// in flight at crash time.
//
// Run: node --experimental-strip-types src/testing/crash-child.ts <root> <project-name> <out-file>
import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { parseHostToml } from "../config.ts";
import { openHostRuntime } from "../host-runtime.ts";
import { createScriptedModel } from "./fake-model.ts";

const [root, project, outFile] = process.argv.slice(2);
if (root === undefined || project === undefined || outFile === undefined) throw new Error("usage: crash-child.ts <root> <project> <out-file>");

const config = parseHostToml(`listen = "127.0.0.1:1"\n\n[[projects]]\nname = "${project}"\npath = "p"\n`, root);
// ~5 minutes of streaming at this rate: the generation is unmistakably mid-flight when the parent kills us.
const model = createScriptedModel([fauxAssistantMessage("token ".repeat(2000))], { tokensPerSecond: 6 });
const runtime = await openHostRuntime(config, model.models, model.modelRef);
const thread = await runtime.threads.create({ threadId: "crash", projectId: project });
await runtime.threads.submit({ threadId: "crash", conversationId: thread.head, requestId: "crash-1", message: "go" }, undefined);
writeFileSync(outFile, String(thread.head));
process.stdout.write(`ADMITTED ${thread.head}\n`);
// Park: the scheduler keeps streaming until the process dies.
await new Promise(() => {});
