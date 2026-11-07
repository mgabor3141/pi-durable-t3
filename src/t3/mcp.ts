// `/mcp`: T3's orchestrator MCP server for this host's threads (T3's `McpHttpServer`, the orchestrator toolkit only).
// Streamable HTTP at protocol 2025-06-18, the toolkit T3 advertises (`mcp-toolkit.ts`, with T3's compacted input
// schemas), and handlers over `ThreadOps`. A tool this host does not do answers the contract's failure and is logged.
//
// Who calls: a paired client's bearer (or the same-origin session), whose scopes gate reads and writes as T3's tool
// access does. Which thread calls: the request's `_meta` — `"t3/threadId"`, or `"pi-durable/conversationId"` for an
// agent that knows only its own conversation (the thread whose head it is). Without either, the call has no thread.
import { randomUUID } from "node:crypto";
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, type AuthEnvironmentScope, OrchestratorMcpFailure } from "@t3tools/contracts";
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
import { OrchestratorToolkit } from "./mcp-toolkit.ts";
import { advertisedJsonSchema } from "./t3-server.ts";
import type { Caller, ThreadOps } from "./thread-ops.ts";

/** The session a request to `/mcp` authenticated with (provided per request by the auth middleware). */
class McpSession extends Context.Service<McpSession, { readonly scopes: readonly string[] }>()("pi-durable-t3/McpSession") {}

/** The tools this host answers; every other tool of the toolkit is refused. */
const SUPPORTED = new Set(["t3_thread_list", "t3_thread_read", "t3_thread_send", "t3_thread_wait", "t3_thread_interrupt", "create_threads", "t3_thread_update"]);
/** The tools that write (T3's `writesThreads` / `actsAsCaller`): they need `orchestration:operate`. */
const WRITES = new Set(["t3_thread_send", "t3_thread_interrupt", "create_threads", "t3_thread_update"]);

export interface McpDeps {
	readonly bridge: Bridge;
	readonly ops: ThreadOps;
	readonly log: Logger;
	readonly version: string;
	readonly resolveSession: (request: HttpServerRequest.HttpServerRequest) => StoredToken | undefined;
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

export function makeMcpLayer(deps: McpDeps) {
	const { bridge, ops, log } = deps;

	/** The calling thread, from the request's `_meta`. */
	const callerOf = Effect.gen(function* () {
		const context = yield* McpSchema.McpRequestContext;
		const meta = (context.requestMetadata ?? {}) as Record<string, unknown>;
		const threadId = meta["t3/threadId"];
		if (typeof threadId === "string") return { threadId } satisfies Caller;
		const conversationId = meta["pi-durable/conversationId"];
		if (typeof conversationId === "number") {
			const owner = yield* Effect.promise(() => bridge.threadIdForConversation(conversationId));
			return (owner === undefined ? {} : { threadId: owner }) satisfies Caller;
		}
		return {} satisfies Caller;
	});

	/** A tool call: the scope its access needs, then the operation; a thrown `OrchestratorMcpFailure` is its failure. */
	const call =
		<I, A>(name: string, run: (caller: Caller, input: I) => A | Promise<A>) =>
		(input: I) =>
			Effect.gen(function* () {
				const session = yield* McpSession;
				const scope: AuthEnvironmentScope = WRITES.has(name) ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
				if (!session.scopes.includes(scope)) return yield* Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message: `This client lacks the ${scope} scope ${name} needs.` }));
				const caller = yield* callerOf;
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
	for (const name of Object.keys(OrchestratorToolkit.tools)) if (!SUPPORTED.has(name)) handlers[name] = unsupported(name);
	Object.assign(handlers, {
		t3_thread_list: call("t3_thread_list", (caller, input) => ops.list(caller, input as never)),
		t3_thread_read: call("t3_thread_read", (caller, input) => ops.read(caller, input as never)),
		t3_thread_send: call("t3_thread_send", (caller, input) => ops.send(caller, input as never)),
		t3_thread_wait: call("t3_thread_wait", (caller, input) => ops.wait(caller, input as never)),
		t3_thread_interrupt: call("t3_thread_interrupt", (caller, input) => ops.interrupt(caller, input as never)),
		create_threads: call("create_threads", (caller, input) => ops.create(caller, input as never)),
		t3_thread_update: call("t3_thread_update", (caller, input) => ops.update(caller, input as never)),
	});
	const handlersLayer = OrchestratorToolkit.toLayer(handlers as never);

	// A request without a usable credential is refused before the protocol sees it, as T3's MCP auth does.
	const auth = HttpRouter.middleware<{ provides: McpSession }>()((httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const session = deps.resolveSession(request);
			if (session === undefined) {
				return HttpServerResponse.jsonUnsafe({ error: "invalid_token", error_description: "Pair this client first.", traceId: randomUUID() }, { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
			}
			return yield* httpEffect.pipe(Effect.provideService(McpSession, { scopes: session.scopes }));
		}),
	).layer;

	const transport = McpServer.layerHttp({ name: "pi-durable-t3", version: deps.version, path: "/mcp", protocols: [McpProtocol.v2025_06_18], allowSessionTermination: true }).pipe(Layer.provide(auth));
	const registration = Layer.effectDiscard(withAdvertisedSchemas(OrchestratorToolkit as never, McpServer.registerToolkit(decodeAsAdvertised(OrchestratorToolkit)))).pipe(Layer.provide(handlersLayer));
	return registration.pipe(Layer.provideMerge(transport));
}
