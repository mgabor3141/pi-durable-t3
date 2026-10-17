// Shutdown child: the example's EXACT host wiring — `openCodingHarness` + `attachT3` — plus `installShutdown` (the
// real handler under test). It runs one turn whose tool IGNORES its abort signal, so a mid-turn SIGINT reproduces the
// stall a real provider's lingering HTTP stream causes, and the bounded shutdown is what makes the process exit fast.
// Hermetic: a scripted faux model, a temp root, no network, no `~/.pi`.
//
// Run: node --experimental-strip-types test/shutdown-child.ts <root> <project> <port> [tool-sleep-ms]
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { attachT3 } from "../src/bridge.ts";
import { Threads } from "../src/threads.ts";
import { FileProjectRegistry } from "../src/registry.ts";
import { nullLogger } from "../src/t3/logging.ts";
import { openCodingHarness } from "../examples/coding-agent/host-runtime.ts";
import { parseConfigToml } from "../examples/coding-agent/config.ts";
import { installShutdown } from "../examples/coding-agent/shutdown.ts";
import { createScriptedModel } from "./fake-model.ts";

const [root, project, portArg, sleepArg] = process.argv.slice(2);
if (root === undefined || project === undefined || portArg === undefined) throw new Error("usage: shutdown-child.ts <root> <project> <port> [tool-sleep-ms]");
const port = Number(portArg);
const toolSleepMs = Number(sleepArg ?? 60_000);

// A tool whose execute sleeps for `toolSleepMs` and never inspects `context.abortSignal`: exactly a non-abortable
// in-flight invocation, so the graceful close's `join()` blocks on it and the process can only leave via the force exit.
const slowTool = defineTool({
	name: "slow",
	description: "Sleep, ignoring the run's abort signal.",
	parameters: Type.Object({}),
	async execute() {
		await new Promise((resolve) => setTimeout(resolve, toolSleepMs));
		return { structuredOutput: { output: "done" } };
	},
});

const config = parseConfigToml(`listen = "127.0.0.1:${port}"\n`, root);
// The instance file the host edits on the UI's behalf: a project at `<root>/p` (its id is derived from that path).
writeFileSync(join(root, "projects.json"), JSON.stringify({ projects: [{ path: join(root, "p"), title: project }] }) + "\n");
const registry = FileProjectRegistry.open(root);
// Generation 1 is a `tool_use` for `slow`; nothing is queued after, so the run sits inside the tool until the signal.
const model = createScriptedModel([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" })]);
const runtime = await openCodingHarness(config, registry, model.models, { extensions: [defineExtension({ name: "slow", tools: [slowTool] })] });
const attach = await attachT3(runtime.harness, {
	models: model.models,
	projects: registry,
	dataDir: root,
	listen: config.listen,
	stateDir: join(root, "t3-auth"),
	log: nullLogger,
});
await attach.ready;

const threads = new Threads({ harness: runtime.harness, registry });
const thread = await threads.create({ threadId: "shutdown", projectId: registry.list()[0]!.id });
const head = await runtime.harness.conversation(thread.head as ConversationId, BACKGROUND_CONTEXT);
await head?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
await threads.submit({ threadId: "shutdown", conversationId: thread.head, requestId: "shutdown-1", message: "go" }, undefined);
process.stdout.write(`ADMITTED ${thread.head}\n`);

// The same shutdown the example host installs. The servers' handles keep the process alive until a signal fires it.
installShutdown(async () => {
	await attach.close();
	await runtime.close();
});
