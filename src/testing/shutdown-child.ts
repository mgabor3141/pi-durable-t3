// Shutdown child: the EXACT host wiring `main.ts` runs — `openHostRuntime`, a chord host over the server facet, and the
// T3 facet — plus `installShutdown` (the real handler under test). It runs one turn whose tool IGNORES its abort signal,
// so a mid-turn SIGINT reproduces the stall a real provider's lingering HTTP stream causes, and the bounded shutdown is
// what makes the process exit fast. Hermetic: a scripted faux model, a temp root, no network, no `~/.pi`.
//
// Run: node --experimental-strip-types src/testing/shutdown-child.ts <root> <project> <port> [tool-sleep-ms]
import { join } from "node:path";
import { Type } from "typebox";
import { createHost } from "@earendil-works/chord";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { parseConfigToml } from "../config.ts";
import { openHostRuntime } from "../host-runtime.ts";
import { FileProjectRegistry } from "../registry.ts";
import { writeInstanceFile } from "../settings.ts";
import { installShutdown } from "../shutdown.ts";
import { createServerFacet } from "../objects.ts";
import { ModelCatalog } from "../t3/models.ts";
import { startFacet } from "../t3/facet.ts";
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
await writeInstanceFile(root, { projects: [{ path: join(root, "p"), title: project }], defaults: {} });
const registry = await FileProjectRegistry.open(root);
// Generation 1 is a `tool_use` for `slow`; nothing is queued after, so the run sits inside the tool until the signal.
const model = createScriptedModel([fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" })]);
const runtime = await openHostRuntime(config, registry, model.models, model.modelRef, { extensions: [defineExtension({ name: "slow", tools: [slowTool] })] });

const server = createHost({ name: "server" });
await server.load([createServerFacet(runtime.threads, model.models)]);
await server.ready();
const catalog = new ModelCatalog(async () => []);
await catalog.refresh();
const facet = startFacet({ host: server, catalog, log: { info: () => {}, warn: () => {} }, config: { ...config.bridge, registry } });
await facet.ready;

const thread = await runtime.threads.create({ threadId: "shutdown", projectId: registry.list()[0]!.id });
await runtime.threads.submit({ threadId: "shutdown", conversationId: thread.head, requestId: "shutdown-1", message: "go" }, undefined);
process.stdout.write(`ADMITTED ${thread.head}\n`);

// The same shutdown the reference host installs. The servers' handles keep the process alive until a signal fires it.
installShutdown(async () => {
	await facet.close();
	await server.close();
	await runtime.close();
});
