// `/mcp` over HTTP, as an MCP client speaks it: sign in over OAuth (`mcp-oauth-client.ts`), initialize, list T3's
// orchestrator tools (T3's names, minus the link tools a host without links hides), call the thread tools as a client
// outside any thread, within the access the user approved, and get the contract's failure for a tool this host does
// not do. Only an MCP client's credential opens it, and that credential opens nothing else.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorMcpThreadListResult, OrchestratorMcpThreadReadResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, seedProjects, t3Dir } from "./host-process-harness.ts";
import { signInMcpClient } from "./mcp-oauth-client.ts";

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

it("serves T3's orchestrator tools to a signed-in MCP client, within its access", async () => {
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

	const origin = `http://127.0.0.1:${PORT}`;
	// Without an MCP client's credential: 401, pointing at where to sign in. A paired client's token is not one.
	for (const credential of [undefined, token]) {
		const refused = await fetch(`${origin}/mcp`, { method: "POST", headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` } });
		expect(refused.status).toBe(401);
		expect(refused.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
	}
	const full = await signInMcpClient(origin, { code: pairCode(root), access: "full-access" });
	expect(full.scope).toContain("orchestration:operate");
	// The client's token is for `/mcp` alone (T3's audience check).
	expect(await (await fetch(`${origin}/api/auth/session`, { headers: { authorization: `Bearer ${full.token}` } })).json()).toMatchObject({ authenticated: false });
	const reader = await signInMcpClient(origin, { code: pairCode(root), access: "read-only", name: "reader" });
	expect(reader.scope).toBe("orchestration:read");
	const approver = await signInMcpClient(origin, { code: pairCode(root), access: "approval-required", name: "approver" });
	{
		const token = full.token;

	const init = await rpc(token, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
	expect(init.status).toBe(200);
	expect((init.message?.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
	const session = init.session;
	await rpc(token, session, { jsonrpc: "2.0", method: "notifications/initialized" });

	const listed = await rpc(token, session, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
	const names = ((listed.message?.result as { tools: { name: string }[] }).tools ?? []).map((tool) => tool.name).sort();
	expect(names).toEqual(
		["create_threads", "delegate_task", "delete_scheduled_task", "list_scheduled_tasks", "request_secret", "schedule_task", "t3_background_wait", "t3_thread_interrupt", "t3_thread_list", "t3_thread_read", "t3_thread_send", "t3_thread_update", "t3_thread_wait", "t3_workflow_stop", "task_cancel", "task_status", "t3_project_list", "t3_project_read", "t3_project_create", "t3_project_update", "t3_project_delete"].sort(),
	);

	const call = async (id: number, name: string, args: unknown, meta?: unknown) =>
		(await rpc(token, session, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) } })).message?.result as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };

	const list = await call(3, "t3_thread_list", { projectId });
	expect(list.isError).toBe(false);
	Schema.decodeUnknownSync(Schema.toCodecJson(OrchestratorMcpThreadListResult))(list.structuredContent);
	expect(list.structuredContent).toMatchObject({ projectId, total: 2 });
	expect((list.structuredContent as { threads: { link: string }[] }).threads[0]!.link, "links open in this host's web app").toMatch(new RegExp(`^${origin}/`));

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

	// A client outside a thread cannot act as one; a full-access client may write to any thread.
	const created = await call(7, "create_threads", { threads: [{ prompt: "hi" }] });
	expect(JSON.parse(created.content![0]!.text)).toMatchObject({ code: "thread_credential_required" });
	const renamed = await call(8, "t3_thread_update", { threadId: "mcp-b", action: "rename", title: "Renamed by a client" });
	expect(renamed.isError).toBe(false);
	expect(renamed.structuredContent).toMatchObject({ threadId: "mcp-b", title: "Renamed by a client" });
	}

	// The access the user approved bounds what each client may do.
	const failureOf = async (credential: string, name: string, args: unknown) => {
		const init = await rpc(credential, undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
		await rpc(credential, init.session, { jsonrpc: "2.0", method: "notifications/initialized" });
		const result = (await rpc(credential, init.session, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })).message?.result as { isError?: boolean; content?: { text: string }[] };
		return result.isError === true ? (JSON.parse(result.content![0]!.text) as { code: string; message: string }) : undefined;
	};
	expect(await failureOf(reader.token, "t3_thread_read", { threadId: "mcp-a" }), "a reader reads").toBeUndefined();
	expect(await failureOf(reader.token, "t3_thread_send", { threadId: "mcp-a", message: "x" })).toMatchObject({ code: "capability_denied", message: expect.stringContaining("read-only") });
	// Scheduled tasks: a reader lists; only a writer schedules, and outside a thread it names a project, whose default
	// model it runs on (none here, so T3's refusal).
	expect(await failureOf(reader.token, "list_scheduled_tasks", {}), "a reader lists tasks").toBeUndefined();
	// Projects (T3's project toolkit): a reader lists and reads; only a writer changes one.
	expect(await failureOf(reader.token, "t3_project_list", {}), "a reader lists projects").toBeUndefined();
	expect(await failureOf(reader.token, "t3_project_update", { projectId, title: "x" })).toMatchObject({ code: "capability_denied" });
	expect(await failureOf(full.token, "t3_project_update", { projectId, title: "Renamed over MCP" }), "a writer renames").toBeUndefined();
	expect(await failureOf(full.token, "t3_project_read", { projectId: "nope" })).toMatchObject({ code: "invalid_request", message: "The project was not found." });
	expect(await failureOf(reader.token, "schedule_task", { prompt: "x", schedule: { type: "interval", everyMs: 3_600_000 } })).toMatchObject({ code: "capability_denied" });
	expect(await failureOf(full.token, "schedule_task", { prompt: "x", schedule: { type: "interval", everyMs: 3_600_000 } })).toMatchObject({ code: "target_required" });
	expect(await failureOf(full.token, "schedule_task", { projectId, prompt: "x", schedule: { type: "interval", everyMs: 3_600_000 } })).toMatchObject({
		code: "invalid_request",
		message: `Project ${projectId} has no default model, so this caller cannot pick one for it.`,
	});
	expect(await failureOf(approver.token, "t3_thread_update", { threadId: "mcp-a", action: "rename", title: "x" })).toMatchObject({
		code: "runtime_mode_escalation_denied",
		message: "Child runtime mode full-access is broader than parent mode approval-required.",
	});
}, 60_000);
