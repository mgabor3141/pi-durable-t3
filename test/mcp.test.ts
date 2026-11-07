// `/mcp` over HTTP, as an MCP client speaks it: initialize, list T3's orchestrator tools (T3's names, minus the link
// tools a host without links hides), call the thread tools with a calling thread in `_meta`, and get the contract's
// failure for a tool this host does not do. Without a credential the endpoint refuses.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorMcpThreadListResult, OrchestratorMcpThreadReadResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, seedProjects, t3Dir } from "./host-process-harness.ts";

const PORT = 4963;
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-mcp-"));
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

/** One JSON-RPC exchange; the answer may come as JSON or as one SSE event. */
async function rpc(token: string | undefined, session: string | undefined, body: unknown): Promise<{ status: number; session: string | undefined; message: Record<string, unknown> | undefined }> {
	const response = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2025-06-18",
			...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
			...(session === undefined ? {} : { "mcp-session-id": session }),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const data = text.startsWith("{") ? text : text.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
	return { status: response.status, session: response.headers.get("mcp-session-id") ?? session, message: data ? (JSON.parse(data) as Record<string, unknown>) : undefined };
}

it("serves T3's orchestrator tools to an MCP client, with the caller from _meta", async () => {
	const root = join(scratch, "host");
	const projectId = "c0ffee00-4444-4444-8444-444444444444";
	await mkdir(join(root, "projects", "m"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await seedProjects(root, [{ id: projectId, title: "M", path: join(root, "projects", "m") }]);
	const host = launch(root, PORT, {}, join(scratch, "agent"));
	launched.push(host);
	expect(await waitListening(PORT), `the host booted: ${host.out()}`).toBe(true);
	const token = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, token);
	const providers = exitValue(await ws.call("server.refreshProviders", {}), "providers") as { providers: { instanceId: string; models: { slug: string }[] }[] };
	const model = providers.providers.find((entry) => entry.models.length > 0)!;
	for (const threadId of ["mcp-a", "mcp-b"]) {
		exitValue(
			await ws.call("orchestration.dispatchCommand", { type: "thread.create", commandId: `c-${threadId}`, threadId, projectId, title: threadId, modelSelection: { instanceId: model.instanceId, model: model.models[0]!.slug }, runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, createdBy: "user", creationSource: "web" }),
			"create",
		);
	}
	ws.close();

	expect((await rpc(undefined, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).status).toBe(401);

	const init = await rpc(token, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
	expect(init.status).toBe(200);
	expect((init.message?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
	const session = init.session;
	await rpc(token, session, { jsonrpc: "2.0", method: "notifications/initialized" });

	const listed = await rpc(token, session, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	const names = ((listed.message?.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name).sort();
	expect(names).toEqual(
		["create_threads", "delegate_task", "delete_scheduled_task", "list_scheduled_tasks", "orchestrator_capabilities", "request_secret", "schedule_task", "t3_background_wait", "t3_thread_interrupt", "t3_thread_list", "t3_thread_read", "t3_thread_send", "t3_thread_update", "t3_thread_wait", "t3_workflow_stop", "task_cancel", "task_status"].sort(),
	);

	const call = async (id: number, name: string, args: unknown, meta?: unknown) =>
		(await rpc(token, session, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) } })).message?.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };

	const list = await call(3, "t3_thread_list", {}, { "t3/threadId": "mcp-a" });
	expect(list.isError).toBe(false);
	Schema.decodeUnknownSync(Schema.toCodecJson(OrchestratorMcpThreadListResult))(list.structuredContent);
	expect(list.structuredContent).toMatchObject({ projectId, currentThreadId: "mcp-a", total: 2 });

	const read = await call(4, "t3_thread_read", { threadId: "mcp-b" });
	expect(read.isError).toBe(false);
	Schema.decodeUnknownSync(Schema.toCodecJson(OrchestratorMcpThreadReadResult))(read.structuredContent);

	// Outside a thread, a project must be named: the contract's failure, as a tool error (encoded as its text, as
	// Effect's MCP server renders a returned failure for T3 too).
	const noProject = await call(5, "t3_thread_list", {});
	expect(noProject.isError).toBe(true);
	expect(JSON.parse(noProject.content![0]!.text)).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "target_required" });

	const delegated = await call(6, "delegate_task", { task: "x" });
	expect(delegated.isError).toBe(true);
	expect(host.out()).toContain("unsupported MCP tool");
}, 60_000);
