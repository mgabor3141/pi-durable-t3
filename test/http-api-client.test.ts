// The HTTP surface through the client the web app uses: Effect's `HttpApiClient` over the contract's
// `EnvironmentHttpApi`. Every answer must decode with the contract's success schema and every refusal with one of
// the endpoint's declared errors, as it does in the browser — a body the client cannot read fails here.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentHttpApi, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, seedProjects, t3Dir } from "./host-process-harness.ts";

const PORT = 4961;
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-httpapi-"));
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: the client's per-endpoint argument types are checked by the contract at run time
type Any = any;
const run = (effect: Any): Promise<Any> => Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer) as Effect.Effect<Any>);
/** The typed failure of a call, as the client decoded it. */
const failure = (effect: Any): Promise<Any> => run(Effect.flip(effect));

it("every supported endpoint answers what the contract's client decodes, and refuses with a declared error", async () => {
	const root = join(scratch, "host");
	const projectId = "c0ffee00-2222-4222-8222-222222222222";
	const projectDir = join(root, "projects", "api");
	await mkdir(projectDir, { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await seedProjects(root, [{ id: projectId, title: "Api", path: projectDir }]);
	const host = launch(root, PORT, {}, join(scratch, "agent"));
	launched.push(host);
	expect(await waitListening(PORT), `the host booted: ${host.out()}`).toBe(true);
	const token = await pair(PORT, pairCode(root));

	// A thread, created the way the web app creates one.
	const ws = await connectWs(PORT, token);
	const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
	const provider = providers.providers.find((entry) => entry.models.length > 0)!;
	const threadId = "api-thread-1";
	exitValue(
		await ws.call("orchestration.dispatchCommand", {
			type: "thread.create",
			commandId: "cmd-api-thread",
			threadId,
			projectId,
			title: "Api thread",
			modelSelection: { instanceId: provider.instanceId, model: provider.models[0]!.slug },
			runtimeMode: "full-access",
			interactionMode: "default",
			branch: null,
			worktreePath: null,
			createdBy: "user",
			creationSource: "web",
		}),
		"thread.create",
	);
	ws.close();

	const client: Any = await run(HttpApiClient.make(EnvironmentHttpApi, { baseUrl: `http://127.0.0.1:${PORT}` }));
	const bearer = { authorization: `Bearer ${token}` };
	const orchestration = { ...bearer, "x-t3-orchestration-protocol": "2" };

	// metadata and auth
	const descriptor = await run(client.metadata.descriptor());
	expect(descriptor.serverVersion).toBe("0.1.6");
	expect((await run(client.auth.session({ headers: {} }))).authenticated).toBe(false);
	const session = await run(client.auth.session({ headers: bearer }));
	expect(session).toMatchObject({ authenticated: true, sessionMethod: "bearer-access-token" });
	expect(Redacted.value((await run(client.auth.webSocketTicket({ headers: bearer }))).ticket as Redacted.Redacted<string>).length).toBeGreaterThan(0);
	expect(Redacted.value((await run(client.auth.webSocketTicketFor({ headers: bearer, params: { use: "media" } }))).ticket as Redacted.Redacted<string>).length).toBeGreaterThan(0);
	const link = await run(client.auth.pairingCredential({ headers: bearer, payload: { label: "api" } }));
	expect(link.label).toBe("api");
	expect(await run(client.auth.revokePairingLink({ headers: bearer, payload: { id: link.id } }))).toEqual({ revoked: true });
	expect(await run(client.auth.revokeOtherClients({ headers: bearer }))).toEqual({ revokedCount: 0 });
	const badCode = await failure(client.auth.token({ headers: {}, payload: { grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", subject_token: "wrong", subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap", requested_token_type: "urn:ietf:params:oauth:token-type:access_token" } }));
	expect(badCode).toMatchObject({ _tag: "EnvironmentAuthInvalidError", reason: "invalid_credential" });

	// The middleware's refusal, decoded as the contract's error.
	expect(await failure(client.orchestration.shellSnapshot({ headers: { "x-t3-orchestration-protocol": "2" }, query: {} }))).toMatchObject({ _tag: "EnvironmentAuthInvalidError", reason: "missing_credential" });
	expect(await failure(client.orchestration.shellSnapshot({ headers: { authorization: "Bearer nope", "x-t3-orchestration-protocol": "2" }, query: {} }))).toMatchObject({ _tag: "EnvironmentAuthInvalidError", reason: "invalid_credential" });

	// orchestration
	const shell = await run(client.orchestration.shellSnapshot({ headers: orchestration, query: {} }));
	expect(shell.threads.map((thread: { id: string }) => thread.id)).toContain(threadId);
	const snapshot = await run(client.orchestration.threadSnapshot({ headers: orchestration, params: { threadId: ThreadId.make(threadId) } }));
	expect(snapshot.projection.thread.id).toBe(threadId);
	const transcript = await run(client.orchestration.threadTranscript({ headers: orchestration, params: { threadId: ThreadId.make(threadId) } }));
	expect(transcript).toMatchObject({ threadId, title: "Api thread" });
	const bounded = await run(client.orchestration.threadBoundedSnapshot({ headers: orchestration, params: { threadId: ThreadId.make(threadId) }, query: { deferWork: "1", compactTurnItems: "1", dedupeBodies: "1", compactIds: "1" } }));
	expect(bounded.snapshotSequence).toBe(snapshot.snapshotSequence);
	expect(await failure(client.orchestration.threadHistoryPage({ headers: orchestration, params: { threadId: ThreadId.make(threadId) }, query: { cursor: "not-a-cursor" } }))).toMatchObject({
		_tag: "EnvironmentRequestInvalidError",
		reason: "invalid_history_cursor",
	});
	expect(await failure(client.orchestration.threadSnapshot({ headers: orchestration, params: { threadId: ThreadId.make("no-such-thread") } }))).toMatchObject({
		_tag: "EnvironmentResourceNotFoundError",
		reason: "thread_not_found",
	});

	// projects
	const projects = await run(client.projects.snapshot({ headers: bearer }));
	expect(projects.projects.map((project: { id: string }) => project.id)).toContain(projectId);
	const created = await run(
		client.projects.mutate({
			headers: bearer,
			payload: { type: "project.create", commandId: "cmd-api-project", projectId: "c0ffee00-3333-4333-8333-333333333333", title: "Second", workspaceRoot: join(root, "projects", "second"), createWorkspaceRootIfMissing: true },
		}),
	);
	expect(created.title).toBe("Second");
	expect(
		await failure(client.projects.mutate({ headers: bearer, payload: { type: "project.delete", commandId: "cmd-api-delete", projectId } })),
		"a project with threads is not deleted without force",
	).toMatchObject({ _tag: "EnvironmentRequestInvalidError", reason: "invalid_command" });

	// What this host does not do: pull requests refuse with the contract's error; the rest is a plain 404.
	expect(await failure(client.pullRequests.diff({ headers: bearer, payload: { projectId, repository: "o/r", number: 1 } }))).toMatchObject({ _tag: "PullRequestUnavailableError" });
	for (const path of ["/api/connect/link-state", "/api/hooks/h/t"]) {
		expect((await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: bearer })).status, path).toBe(404);
	}
	expect(host.out(), "the unsupported calls are logged").toContain("unsupported HTTP endpoint");

	// MCP OAuth, as the web app's `/connect-agent` page and an agent call it: metadata, registration, the approval
	// details, the decision (a pairing code, one click from a browser session, or a denial), and the code exchange.
	const origin = `http://127.0.0.1:${PORT}`;
	expect(await run(client.mcpOAuth.mcpProtectedResource({}))).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
	expect(await run(client.mcpOAuth.authorizationServer({}))).toMatchObject({ issuer: origin, token_endpoint: `${origin}/oauth/mcp/token`, code_challenge_methods_supported: ["S256"] });
	expect(await failure(client.mcpOAuth.register({ payload: { redirect_uris: ["http://example.com/cb"] } }))).toMatchObject({ name: "AuthMcpRegistrationError", error: "invalid_redirect_uri" });
	const registered = await run(client.mcpOAuth.register({ payload: { client_name: "Api agent", redirect_uris: ["http://127.0.0.1:9/cb"] } }));
	expect(registered).toMatchObject({ client_name: "Api agent", token_endpoint_auth_method: "none" });
	const { createHash } = await import("node:crypto");
	const verifier = "v".repeat(43);
	const authorization = {
		response_type: "code",
		client_id: registered.client_id,
		redirect_uri: "http://127.0.0.1:9/cb",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		state: Redacted.make("s1"),
	};
	const details = await run(client.mcpOAuth.approval({ payload: authorization }));
	expect(details).toEqual({ clientName: "Api agent", redirectHost: "127.0.0.1:9", environmentHost: `127.0.0.1:${PORT}` });
	expect(await run(client.mcpOAuth.approval({ payload: { ...authorization, code_challenge_method: "plain" } })), "a verified client hears of its own mistakes").toMatchObject({
		redirectTo: expect.stringContaining("error=invalid_request"),
	});
	expect(await failure(client.mcpOAuth.approval({ payload: { ...authorization, client_id: "forged.sig" } }))).toMatchObject({ _tag: "AuthMcpApprovalError", message: expect.stringContaining("unknown app") });
	const page = await fetch(`${origin}/oauth/mcp/authorize?client_id=forged.sig`, { redirect: "manual" });
	expect(page.status, "an unknown client sees a page, not a redirect").toBe(400);
	expect(await page.text()).toContain("This sign-in cannot continue");
	expect((await fetch(`${origin}/oauth/mcp/authorize?${new URLSearchParams({ ...authorization, state: "s1" })}`, { redirect: "manual" })).headers.get("location")).toMatch(/^\/connect-agent\?/);
	expect(await failure(client.mcpOAuth.register({ payload: { software_id: "t3code-peer-link", redirect_uris: ["http://127.0.0.1:9/cb"] } })), "peer links wait for the setting").toMatchObject({ error: "invalid_client_metadata" });
	const decide = (decision: Any) => client.mcpOAuth.decision({ payload: { authorization, decision } });
	expect(await failure(decide({ _tag: "pairing-code", access: "read-only", code: "nope" }))).toMatchObject({ _tag: "AuthMcpApprovalError", message: "That pairing code is unknown, expired, or already used." });
	expect((await run(decide({ _tag: "deny" }))).redirectTo).toBe("http://127.0.0.1:9/cb?error=access_denied&state=s1&iss=" + encodeURIComponent(origin));
	const approved = new URL((await run(decide({ _tag: "pairing-code", access: "read-only", code: pairCode(root) }))).redirectTo);
	expect(approved.searchParams.get("state")).toBe("s1");
	const exchange = (code: string, codeVerifier: string) =>
		client.mcpOAuth.token({ payload: { grant_type: "authorization_code", code: Redacted.make(code), redirect_uri: "http://127.0.0.1:9/cb", client_id: registered.client_id, code_verifier: Redacted.make(codeVerifier) } });
	const issued = await run(exchange(approved.searchParams.get("code")!, verifier));
	expect(issued).toMatchObject({ token_type: "Bearer", scope: "orchestration:read" });
	expect(await failure(exchange(approved.searchParams.get("code")!, verifier)), "a code is used once").toMatchObject({ name: "AuthMcpTokenError", error: "invalid_grant" });
	const wrongVerifier = new URL((await run(decide({ _tag: "pairing-code", access: "read-only", code: pairCode(root) }))).redirectTo).searchParams.get("code")!;
	expect(await failure(exchange(wrongVerifier, "w".repeat(43)))).toMatchObject({ name: "AuthMcpTokenError", error: "invalid_grant" });
	expect(await failure(exchange(wrongVerifier, verifier)), "and spent even when the check failed").toMatchObject({ error: "invalid_grant" });
	// One click from a signed-in browser: its session offers the access it holds and approves with a CSRF token.
	const browser = await fetch(`${origin}/api/auth/browser-session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: pairCode(root) }) });
	const cookie = browser.headers.get("set-cookie")!.split(";")[0]!;
	const withCookie = (await fetch(`${origin}/oauth/mcp/approval`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ ...authorization, state: "s1" }) }).then((response) => response.json())) as Any;
	expect(withCookie.oneClickAccess).toEqual(["read-only", "approval-required", "auto-accept-edits", "auto", "full-access"]);
	const click = (csrfToken: string) =>
		fetch(`${origin}/oauth/mcp/decision`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ authorization: { ...authorization, state: "s1" }, decision: { _tag: "browser-session", access: "full-access", csrfToken } }),
		}).then((response) => response.json()) as Promise<Any>;
	expect(await click("forged")).toMatchObject({ message: "Your session cannot approve this request. Enter a pairing code instead." });
	expect((await click(withCookie.csrfToken)).redirectTo).toContain("code=");

	// The web app's trace upload: authenticated, then dropped (T3 with no OTLP endpoint configured).
	const traces = (headers: Record<string, string>) => fetch(`http://127.0.0.1:${PORT}/api/observability/v1/traces`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
	expect((await traces({})).status).toBe(401);
	expect((await traces(bearer)).status).toBe(204);
}, 60_000);
