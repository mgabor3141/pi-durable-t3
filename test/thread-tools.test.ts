// The thread tools as an agent's own tools (`T3Attachment.threadTools`): a model in thread a calls `t3_thread_send`,
// and thread b receives the message from a — the caller is the thread whose head ran the call, with no credential.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { ThreadOps } from "../src/t3/thread-ops.ts";
import { threadToolsExtension } from "../src/t3/thread-tools.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

it("an agent's t3_thread_send reaches another thread as a message from its own thread", { timeout: 60_000 }, async () => {
	// The extension is installed before the Harness opens; the bridge it acts through exists only after.
	let bridge: Bridge | undefined;
	const late = new Proxy({} as Bridge, { get: (_target, key) => (bridge as unknown as Record<string | symbol, unknown>)[key] instanceof Function ? (bridge as never as Record<string | symbol, (...args: unknown[]) => unknown>)[key]!.bind(bridge) : (bridge as unknown as Record<string | symbol, unknown>)[key] });
	const extension = threadToolsExtension(late, new ThreadOps(late, "env-1", log));
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Sender" });
	await create({ threadId: "b", projectId: "p", title: "Receiver" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-tools-"));
	bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge!.close();
		await rm(scratch, { recursive: true, force: true });
	});

	f.model.respond(
		fauxAssistantMessage([fauxToolCall("t3_thread_send", { threadId: "b", message: "hello from a" }, { id: "call-send" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("I told b."),
		fauxAssistantMessage("Thanks, a."),
	);
	await bridge.sendMessage({ threadId: "a", commandId: "c-a", messageId: "m-a", text: "Tell b hello.", mode: "start" });
	const received = await bridge.waitFor("b", (projection) => (projection.runs.some((run) => run.status === "completed") ? projection : undefined), 20_000);
	expect(received, "b ran a turn for the message").toBeDefined();
	const message = received!.messages.find((candidate) => candidate.role === "user");
	expect(message).toMatchObject({ text: "hello from a", createdBy: "agent", creationSource: "mcp", senderThreadId: "a" });

	const sender = await bridge.waitFor("a", (projection) => (projection.runs.every((run) => run.status === "completed") ? projection : undefined), 20_000);
	const result = sender!.turnItems.find((item) => item.type === "dynamic_tool") as { output?: unknown } | undefined;
	expect(JSON.stringify(result?.output)).toContain("started");
});
