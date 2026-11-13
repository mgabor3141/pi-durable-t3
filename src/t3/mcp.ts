// `/mcp`: T3's orchestrator MCP server for this host's threads (T3's `McpHttpServer`: its orchestrator, project and thread toolkits).
// Streamable HTTP at protocol 2025-06-18, the toolkit T3 advertises (`mcp-toolkit.ts`, with T3's compacted input
// schemas), and handlers over `ThreadOps`. A tool this host does not do answers the contract's failure and is logged.
//
// Who calls: an MCP client that signed in over OAuth (`mcp-oauth.ts`), with the bearer session `/mcp` alone accepts and
// the access the user approved; no other credential works here, and a request without one is told where to sign in
// (T3's `resource_metadata` challenge). Such a client has no calling thread: it reads, and writes as far as its access
// allows. An agent inside this host acts as its own thread through `T3Attachment.threadTools` instead.
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, type AuthEnvironmentScope, type AuthMcpClientAccess, OrchestratorMcpFailure } from "@t3tools/contracts";
import { McpProtocol, McpSchema, McpServer, type Tool, Toolkit } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { StoredToken } from "./auth.ts";
import type { Bridge } from "./bridge.ts";
import type { Logger } from "./logging.ts";
import { OrchestratorToolkit, ProjectToolkit, ThreadToolkit } from "./mcp-toolkit.ts";
import { advertisedJsonSchema } from "./t3-server.ts";
import type { Caller, ThreadOps } from "./thread-ops.ts";

/** The MCP client a request to `/mcp` authenticated as (provided per request by the auth middleware). */
class McpSession extends Context.Service<
	McpSession,
	{ readonly sessionId: string; readonly scopes: readonly string[]; readonly access: AuthMcpClientAccess; readonly webOrigin: string | undefined }
>()("pi-durable-t3/McpSession") {}

/** The tools this host answers; every other tool of the toolkit is refused. */
const SUPPORTED = new Set([
	"t3_thread_list",
	"t3_thread_read",
	"t3_thread_send",
	"t3_thread_wait",
	"t3_thread_interrupt",
	"create_threads",
	"t3_thread_update",
	"schedule_task",
	"list_scheduled_tasks",
	"delete_scheduled_task",
	"t3_project_list",
	"t3_project_read",
	"t3_project_create",
	"t3_project_update",
	"t3_project_delete",
	"t3_thread_organize",
	"t3_queue",
	"run_scheduled_task_now",
]);
/** The tools that write (T3's `writesThreads` / `actsAsCaller`): they need `orchestration:operate`. */
const WRITES = new Set(["t3_thread_send", "t3_thread_interrupt", "create_threads", "t3_thread_update", "schedule_task", "delete_scheduled_task", "t3_project_create", "t3_project_update", "t3_project_delete", "t3_thread_organize", "run_scheduled_task_now"]);

/** What `/mcp` serves: T3's orchestrator, project and thread toolkits, as T3 registers them (each as far as this host
 * goes, `mcp-toolkit.ts`). */
const ServedToolkit = Toolkit.merge(OrchestratorToolkit, ProjectToolkit, ThreadToolkit);

export interface McpDeps {
	readonly bridge: Bridge;
	readonly ops: ThreadOps;
	readonly log: Logger;
	readonly version: string;
	/** The MCP client session the request's bearer carries (`AuthStore.verifyMcpClient`). */
	readonly resolveClient: (request: HttpServerRequest.HttpServerRequest) => StoredToken | undefined;
	/** The request's origin (where its links open, and where the challenge points). */
	readonly originOf: (request: HttpServerRequest.HttpServerRequest) => string;
}

/** T3's `decodeAsAdvertised`: calls are decoded with the JSON codec of each tool's parameters. */
const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<Tools>): Toolkit.Toolkit<Tools> =>
	Toolkit.make(...Object.values(toolkit.tools).map((tool) => tool.setParameters(Schema.toCodecJson(tool.parametersSchema)))) as unknown as Toolkit.Toolkit<Tools>;

/** T3's `withAdvertisedSchemas`: each tool is listed with T3's compacted input schema. */
const withAdvertisedSchemas = <A, E, R>(toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>, registration: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const server = yield* McpServer.McpServer;
		const tools: Record<string, Tool.Any> = toolkit.tools;
		const advertising = McpServer.McpServer.of({
			...server,
			addTool: (options) => {
				const tool = tools[options.tool.name];
				return server.addTool(tool === undefined ? options : { ...options, tool: new McpSchema.Tool({ ...options.tool, inputSchema: advertisedJsonSchema(tool) as never }) });
			},
		});
		return yield* registration.pipe(Effect.provideService(McpServer.McpServer, advertising));
	});

/** @internal */
export function makeMcpLayer(deps: McpDeps) {
	const { ops, log } = deps;

	/** A tool call: the scope its access needs, then the operation; a thrown `OrchestratorMcpFailure` is its failure. */
	const call =
		<I, A>(name: string, run: (caller: Caller, input: I) => A | Promise<A>) =>
		(input: I) =>
			Effect.gen(function* () {
				const session = yield* McpSession;
				const scope: AuthEnvironmentScope = WRITES.has(name) ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
				if (WRITES.has(name) && session.access === "read-only") {
					return yield* Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: "This tool changes the environment, and this MCP client was approved for read-only access." }));
				}
				if (!session.scopes.includes(scope)) return yield* Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: `This client lacks the ${scope} scope ${name} needs.` }));
				const caller: Caller = { client: { sessionId: session.sessionId, access: session.access }, ...(session.webOrigin === undefined ? {} : { webOrigin: session.webOrigin }) };
				return yield* Effect.tryPromise({
					try: async () => run(caller, input),
					catch: (error) => (error instanceof OrchestratorMcpFailure ? error : new OrchestratorMcpFailure({ code: "orchestration_error", message: (error as Error).message || String(error) })),
				});
			});

	const unsupported = (name: string) => () =>
		Effect.sync(() => log.info("unsupported MCP tool", { tool: name })).pipe(
			Effect.andThen(Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message: `${name} is not supported by pi-durable-t3.` }))),
		);

	const handlers: Record<string, unknown> = {};
	for (const name of Object.keys(ServedToolkit.tools)) if (!SUPPORTED.has(name)) handlers[name] = unsupported(name);
	Object.assign(handlers, {
		t3_thread_list: call("t3_thread_list", (caller, input) => ops.list(caller, input as never)),
		t3_thread_read: call("t3_thread_read", (caller, input) => ops.read(caller, input as never)),
		t3_thread_send: call("t3_thread_send", (caller, input) => ops.send(caller, input as never)),
		t3_thread_wait: call("t3_thread_wait", (caller, input) => ops.wait(caller, input as never)),
		t3_thread_interrupt: call("t3_thread_interrupt", (caller, input) => ops.interrupt(caller, input as never)),
		create_threads: call("create_threads", (caller, input) => ops.create(caller, input as never)),
		t3_thread_update: call("t3_thread_update", (caller, input) => ops.update(caller, input as never)),
		schedule_task: call("schedule_task", (caller, input) => ops.scheduleTask(caller, input as never)),
		list_scheduled_tasks: call("list_scheduled_tasks", (caller, input) => ops.listScheduledTasks(caller, input as never)),
		delete_scheduled_task: call("delete_scheduled_task", (caller, input) => ops.deleteScheduledTask(caller, input as never)),
		t3_project_list: call("t3_project_list", (caller, input) => ops.projectList(caller, input as never)),
		t3_project_read: call("t3_project_read", (caller, input) => ops.projectRead(caller, input as never)),
		t3_project_create: call("t3_project_create", (caller, input) => ops.projectCreate(caller, input as never)),
		t3_project_update: call("t3_project_update", (caller, input) => ops.projectUpdate(caller, input as never)),
		t3_project_delete: call("t3_project_delete", (caller, input) => ops.projectDelete(caller, input as never)),
		t3_thread_organize: call("t3_thread_organize", (caller, input) => ops.organize(caller, input as never)),
		t3_queue: call("t3_queue", (caller, input) => ops.queue(caller, input as never)),
		run_scheduled_task_now: call("run_scheduled_task_now", (caller, input) => ops.runScheduledTaskNow(caller, input as never)),
	});
	const handlersLayer = ServedToolkit.toLayer(handlers as never);

	// A request without an MCP client credential is refused before the protocol sees it, and told where to sign in
	// (T3's `unauthorized`, with OAuth offered).
	const auth = HttpRouter.middleware<{ provides: McpSession }>()((httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const session = deps.resolveClient(request);
			if (session === undefined) {
				const presented = request.headers.authorization !== undefined;
				const challenge = `Bearer resource_metadata="${deps.originOf(request)}/.well-known/oauth-protected-resource/mcp"${presented ? ', error="invalid_token"' : ""}`;
				return HttpServerResponse.jsonUnsafe(
					{ error: "invalid_mcp_credential", message: "A valid T3 Code MCP credential is required." },
					{ status: 401, headers: { "cache-control": "no-store", "www-authenticate": challenge } },
				);
			}
			const access: AuthMcpClientAccess = session.access ?? (session.scopes.includes(AuthOrchestrationOperateScope) ? "approval-required" : "read-only");
			// A peer link's links open in its own environment; any other client's, in this host's web app.
			const webOrigin = session.peerLink === true ? undefined : deps.originOf(request);
			return yield* httpEffect.pipe(Effect.provideService(McpSession, { sessionId: session.id, scopes: session.scopes, access, webOrigin }));
		}),
	).layer;

	const transport = McpServer.layerHttp({ name: "pi-durable-t3", version: deps.version, path: "/mcp", protocols: [McpProtocol.v2025_06_18], allowSessionTermination: true }).pipe(Layer.provide(auth));
	const registration = Layer.effectDiscard(withAdvertisedSchemas(ServedToolkit as never, McpServer.registerToolkit(decodeAsAdvertised(ServedToolkit)))).pipe(Layer.provide(handlersLayer));
	return registration.pipe(Layer.provideMerge(transport));
}
