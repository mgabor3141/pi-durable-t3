// T3's thread tools on this host (`thread-ops.ts`), as `/mcp` calls them: for an MCP client outside any thread. Every
// answer encodes with the contract's result schema, and the behaviour is T3's: a project or thread must be named, a retry
// is answered with the same ids, and `create_threads` is refused (it acts as the calling thread).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
	OrchestratorMcpFailure,
	OrchestratorMcpThreadInterruptResult,
	OrchestratorMcpThreadListResult,
	OrchestratorMcpThreadReadResult,
	OrchestratorMcpThreadSendResult,
	OrchestratorMcpThreadWaitResult,
	ThreadId,
	ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { ThreadOps } from "../src/t3/thread-ops.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// biome-ignore lint/suspicious/noExplicitAny: a schema of any shape
const encodes = (schema: any, value: unknown) => Schema.encodeUnknownSync(schema)(value);
const tid = (value: string) => ThreadId.make(value);

async function setup(options: { tokensPerSecond?: number } = {}) {
	const f = await makeThreads({ projects: [{ id: "p" }, { id: "q" }], ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	const create = createNamed(f.threads, f.harness, f.model);
	await create({ threadId: "a", projectId: "p", title: "Caller" });
	await create({ threadId: "b", projectId: "p", title: "Worker" });
	await create({ threadId: "c", projectId: "q", title: "Elsewhere" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-ops-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return { f, bridge, ops: new ThreadOps(bridge, "env-1", log) };
}

const failureOf = async (run: () => unknown) => {
	try {
		await run();
	} catch (error) {
		if (error instanceof OrchestratorMcpFailure) return error.code;
		throw error;
	}
	throw new Error("expected a failure");
};

const client = { client: { sessionId: "s1", access: "full-access" as const } };

it("lists a named project, refuses without one, and reads a thread a client wrote to", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup();
	const caller = client;
	const listed = ops.list(caller, { projectId: "p" as never });
	encodes(OrchestratorMcpThreadListResult, listed);
	expect(listed.projectId).toBe("p");
	expect(listed.currentThreadId).toBeNull();
	expect(listed.threads.map((thread) => thread.threadId).sort()).toEqual(["a", "b"]);
	// T3's own link format (`formatThreadLink`), so an agent can name the thread verbatim.
	expect(listed.threads[0]?.link).toBe(`<t3-thread://v2/env-1/${listed.threads[0]?.threadId}>`);
	expect(ops.list({}, { allProjects: true }).total).toBe(3);
	expect(await failureOf(() => ops.list({}, {}))).toBe("target_required");

	f.model.respond(fauxAssistantMessage("hello from b"));
	const sent = await ops.send(caller, { threadId: tid("b"), message: "hi b", clientRequestId: "req-1" });
	encodes(OrchestratorMcpThreadSendResult, sent);
	expect(sent.delivery).toBe("started");
	const waited = await ops.wait(caller, { threadId: tid("b") });
	encodes(OrchestratorMcpThreadWaitResult, waited);
	expect(waited).toMatchObject({ runId: sent.runId, status: "completed", timedOut: false });

	const read = await ops.read(caller, { threadId: tid("b") });
	encodes(OrchestratorMcpThreadReadResult, read);
	expect(read.items.map((item) => [item.type, item.text])).toEqual([
		["user_message", "hi b"],
		["assistant_message", "hello from b"],
	]);
	expect(read.items[0]).toMatchObject({ createdBy: "agent", creationSource: "mcp", messageId: sent.messageId });
	expect(read.items[0]).not.toHaveProperty("senderThreadId");
	expect(read.thread).toMatchObject({ threadId: "b", status: "completed", runCount: 1 });

	// A long item is cut, and continues from its offset.
	const short = await ops.read(caller, { threadId: tid("b"), maxCharsPerItem: 5 });
	expect(short.items[1]).toMatchObject({ text: "hello", textTruncated: true, nextTextOffset: 5 });
	const rest = await ops.read(caller, { threadId: tid("b"), itemId: short.items[1]!.itemId, textOffset: 5, maxCharsPerItem: 50 });
	expect(rest.items).toHaveLength(1);
	expect(rest.items[0]?.text).toBe(" from b");

	// A retry of the same request is the same message, sent once.
	const again = await ops.send(caller, { threadId: tid("b"), message: "hi b", clientRequestId: "req-1" });
	expect(again.messageId).toBe(sent.messageId);
	expect((await ops.read(caller, { threadId: tid("b") })).items.filter((item) => item.type === "user_message")).toHaveLength(1);

	expect(await failureOf(() => ops.read(caller, { threadId: tid("nope") }))).toBe("thread_not_found");

	// Rename: the thread must be named, outside a thread.
	const renamed = await ops.update(caller, { threadId: tid("b"), action: "rename", title: "Worker renamed" });
	encodes(ThreadMetadataMcpUpdateResult, renamed);
	expect(renamed.title).toBe("Worker renamed");
	expect(await failureOf(() => ops.update(caller, { action: "rename", title: "Me" }))).toBe("target_required");
});

it("waits with a timeout, interrupts a running turn, and refuses to steer an idle one", { timeout: 60_000 }, async () => {
	const { f, ops } = await setup({ tokensPerSecond: 20 });
	const caller = client;
	expect(await failureOf(() => ops.send(caller, { threadId: tid("b"), message: "x", mode: "steer" }))).toBe("thread_not_sendable");
	f.model.respond(fauxAssistantMessage("slow ".repeat(200)));
	const sent = await ops.send(caller, { threadId: tid("b"), message: "long task" });
	const early = await ops.wait(caller, { threadId: tid("b"), timeoutMs: 200 });
	expect(early).toMatchObject({ runId: sent.runId, timedOut: true });
	const interrupted = await ops.interrupt(caller, { threadId: tid("b") });
	encodes(OrchestratorMcpThreadInterruptResult, interrupted);
	expect(interrupted).toMatchObject({ runId: sent.runId, status: "interrupt_requested" });
	const ended = await ops.wait(caller, { threadId: tid("b"), timeoutMs: 10_000 });
	expect(ended).toMatchObject({ timedOut: false, status: "interrupted" });
	expect(await ops.interrupt(caller, { threadId: tid("b") })).toMatchObject({ status: "no_active_run", runId: null });
});

it("refuses create_threads: it acts as the calling thread, and a client has none", async () => {
	const { ops } = await setup();
	expect(await failureOf(() => ops.create(client, { threads: [{ prompt: "x" }] }))).toBe("thread_credential_required");
});
