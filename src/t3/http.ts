// HTTP surface (discovery, pairing, tickets, snapshots) and the `/ws` RPC endpoint.
import { type Server } from "node:http";
import { arch, platform } from "node:os";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
	AuthAccessTokenType,
	AuthStandardClientScopes,
	type ExecutionEnvironmentDescriptor,
	ORCHESTRATION_PROTOCOL_HEADER,
	ORCHESTRATION_PROTOCOL_QUERY_PARAM,
	ORCHESTRATION_PROTOCOL_VERSION,
	OrchestrationV2ShellSnapshot,
	OrchestrationV2ThreadDetailSnapshot,
	OrchestrationV2ThreadBoundedSnapshot,
	ProjectMutation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { WsRpcGroup } from "@t3tools/contracts";
import { ProjectConflict, ProjectIdConflict } from "../registry.ts";
import { type AuthStore, PairingRateLimit } from "./auth.ts";
import type { Bridge } from "./bridge.ts";
import type { ModelCatalog } from "./models.ts";
import type { Logger } from "./logging.ts";
import type { ProjectionResult } from "./projection.ts";
import { makeRpcLayer } from "./rpc.ts";

export const SERVER_VERSION = "0.0.45";

// biome-ignore lint/suspicious/noExplicitAny: wire values
type Any = any;

function makeDescriptor(bridge: Bridge, auth: AuthStore): () => ExecutionEnvironmentDescriptor {
	const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : platform() === "win32" ? "windows" : "unknown";
	const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : "other";
	return () =>
		({
			environmentId: auth.environmentId,
			label: bridge.config.label,
			platform: { os, arch: cpu, machine: "server" },
			serverVersion: SERVER_VERSION,
			orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
			capabilities: { repositoryIdentity: false, connectionProbe: true, serverResolvedCommandContext: true },
		}) as Any;
}

/**
 * The address a pairing attempt is counted against: the socket it arrived on, and nothing a client wrote.
 *
 * A rate limiter's bucket key has to be something the caller cannot choose. `x-forwarded-for` is a client-supplied
 * header, and on the default (loopback) bind every connection is loopback, so trusting it when the socket is loopback
 * — the previous rule — let any caller mint a fresh bucket per attempt by setting a header: ten thousand guesses at a
 * pairing code, ten thousand fresh counters, and the limiter existed only for callers that did not think of it. Per
 * review sec F7 / conc F4 the header is not consulted.
 *
 * The proxy case the header was there for (`tailscale serve` forwarding a tailnet client through loopback) is not
 * forgotten: it now shares one bucket per proxy, which fails CLOSED — a flood through the proxy locks out the proxy's
 * clients, instead of unlocking the limiter for everyone. Per-client accounting behind a proxy needs an explicit
 * "this deployment is behind a proxy" setting, so the operator, not the request, decides which header to believe.
 */
function clientAddress(remote: string): string {
	return remote;
}

/** `/api/auth/session` for a paired client: legacy `scopes` plus the full `permissions` list T3 gates actions on. */
function authenticatedSession(expiresAt: number) {
	const permissions = [...AuthStandardClientScopes];
	return {
		authenticated: true,
		auth: authDescriptor,
		scopes: permissions.filter((s) =>
			["orchestration:read", "orchestration:operate", "terminal:operate", "relay:read"].includes(s),
		),
		permissions,
		sessionMethod: "bearer-access-token",
		expiresAt: new Date(expiresAt).toISOString(),
	};
}

export const authDescriptor = {
	policy: "remote-reachable",
	bootstrapMethods: ["one-time-token"],
	sessionMethods: ["bearer-access-token"],
	sessionCookieName: "pi_durable_t3_session",
};

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });
const encode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.encodeUnknownSync(schema as Any)(value);

/** The commandId of a body that failed to decode, for the `commandId` the contract's error carries (an empty string when
 * the body has none — the field is required, and its absence is part of what the refusal says). */
const commandIdOf = (raw: unknown): string => (typeof raw === "object" && raw !== null && typeof (raw as Any).commandId === "string" ? String((raw as Any).commandId) : "");

/** A schema refusal in the route's shape: the contract's own error tree, flattened to one readable line. The full
 * structure is in the log; a client gets the first path that failed. */
function decodeMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Not a valid project mutation: ${detail.replace(/\s+/g, " ").slice(0, 400)}`;
}

export function makeServerLayer(deps: {
	bridge: Bridge;
	auth: AuthStore;
	catalog: ModelCatalog;
	log: Logger;
	httpServer: Server;
}) {
	const { bridge, auth, log, httpServer } = deps;
	const descriptor = makeDescriptor(bridge, auth);
	const rpcLayer = makeRpcLayer({ bridge, catalog: deps.catalog, descriptor, authDescriptor, log });
	const scopeList = [...AuthStandardClientScopes];
	const pairingLimit = new PairingRateLimit();

	// DNS-rebinding guard: when bound to loopback, serve only requests addressed to a loopback `Host`. A page that
	// rebinds its own hostname to 127.0.0.1 must not reach this host (its CORS/origin checks are bypassed as same-origin).
	// A non-loopback bind is left alone (it may legitimately serve real hostnames).
	const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
	const boundLoopback = LOOPBACK_HOSTS.has(bridge.config.host);
	const hostGuard = HttpRouter.middleware(
		(effect: Any) =>
			Effect.gen(function* () {
				if (!boundLoopback) return yield* effect;
				const request = yield* HttpServerRequest.HttpServerRequest;
				const hostname = String(request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
				if (LOOPBACK_HOSTS.has(hostname)) return yield* effect;
				return json({ code: "invalid_host", message: `Host "${hostname}" is not allowed on a loopback listener.` }, 421);
			}),
		{ global: true },
	);

	const authorized = <A, E, R>(
		handler: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			if (auth.verifyBearer(request.headers.authorization) === undefined) {
				return json({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", message: "Pair this client first." }, 401);
			}
			return yield* handler(request);
		});

	// The two `/api/orchestration/threads/:threadId*` routes share their whole preamble: read the route's threadId, await
	// its projection, and answer a thread this host does not know with the 404 T3 renders as a missing resource. They
	// differ only in the snapshot they encode.
	const withProjection = (render: (projection: ProjectionResult) => HttpServerResponse.HttpServerResponse) =>
		authorized(() =>
			Effect.gen(function* () {
				const { threadId } = yield* HttpRouter.params;
				const projected = yield* Effect.tryPromise(() => bridge.projection(threadId!)).pipe(Effect.option);
				if (Option.isNone(projected)) return json({ _tag: "EnvironmentResourceNotFoundError", reason: "thread_not_found", message: "Unknown thread" }, 404);
				return render(projected.value);
			}),
		);

	const routes = Layer.mergeAll(
		HttpRouter.add("GET", "/.well-known/t3/environment", Effect.sync(() => json(descriptor()))),
		// Printed pairing URLs point here; a desktop browser opening one gets a pairing screen instead of a 404.
		HttpRouter.add(
			"GET",
			"/pair",
			Effect.succeed(
				HttpServerResponse.html(
					`<!doctype html><title>pi-durable-t3 pairing</title><body style="font-family:sans-serif;max-width:40em;margin:3em auto"><h1>pi-durable-t3 pairing link</h1><p>This address is a pairing link for the T3 Code apps, not a web page. In the T3 mobile app choose <b>Add environment</b> and paste this URL (or scan its QR code). For the web app, open your T3 web build at <code>/pair?host=&lt;this server&gt;#token=&lt;code&gt;</code>.</p></body>`,
				),
			),
		),
		HttpRouter.add(
			"POST",
			"/oauth/token",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const address = clientAddress(Option.getOrElse(request.remoteAddress, () => "unknown"));
				if (pairingLimit.blocked(address)) {
					log.warn("pairing rate limited", { address });
					return json({ _tag: "EnvironmentAuthInvalidError", code: "rate_limited", message: "Too many pairing attempts; wait a minute." }, 429);
				}
				const body = yield* request.urlParamsBody.pipe(Effect.orElseSucceed(() => [] as Any));
				const params = new URLSearchParams(body as Any);
				const code = params.get("subject_token")?.trim() ?? "";
				const label = params.get("client_label") ?? params.get("client_device_type") ?? "T3 client";
				const issued = code.length > 0 ? auth.exchange(code, label) : undefined;
				if (issued === undefined) {
					pairingLimit.fail(address);
					log.warn("pairing rejected", { address });
					return json(
						{ _tag: "EnvironmentAuthInvalidError", code: "invalid_grant", message: "Invalid or expired pairing code." },
						401,
					);
				}
				log.info("client paired", { label });
				return json({
					access_token: issued.token,
					issued_token_type: AuthAccessTokenType,
					token_type: "Bearer",
					expires_in: issued.expiresIn,
					scope: scopeList.join(" "),
				});
			}),
		),
		HttpRouter.add(
			"GET",
			"/api/auth/session",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const token = auth.verifyBearer(request.headers.authorization);
				if (token === undefined) return json({ authenticated: false, auth: authDescriptor });
				return json(authenticatedSession(token.expiresAt));
			}),
		),
		HttpRouter.add(
			"POST",
			"/api/auth/websocket-ticket",
			authorized((request) =>
				Effect.sync(() => {
					const token = auth.verifyBearer(request.headers.authorization)!;
					const { ticket, expiresAt } = auth.issueTicket(token.hash);
					return json({ ticket, expiresAt: new Date(expiresAt).toISOString() });
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/orchestration/shell",
			authorized(() => Effect.sync(() => json(encode(OrchestrationV2ShellSnapshot, bridge.shellSnapshot())))),
		),
		HttpRouter.add(
			"GET",
			"/api/orchestration/threads/:threadId",
			withProjection((projection) =>
				json(encode(OrchestrationV2ThreadDetailSnapshot, { snapshotSequence: bridge.nextSequence(), projection: projection.projection })),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/orchestration/threads/:threadId/bounded",
			withProjection((projection) =>
				json(
					encode(OrchestrationV2ThreadBoundedSnapshot, {
						snapshotSequence: bridge.nextSequence(),
						projection: projection.projection,
						historyCursor: null,
						hasMoreHistory: false,
						latestLocalTurnOrdinal: projection.runs.at(-1)?.ordinal ?? null,
					}),
				),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/projects",
			authorized(() => Effect.sync(() => json({ projects: bridge.projects() }))),
		),
		// REST parity with the documented HTTP surface (`EnvironmentProjectsHttpApi`): the web client reaches projects
		// over `/ws`, but the same mutation is served here over the same bearer-token guard, sharing one store.
		HttpRouter.add(
			"POST",
			"/api/projects/mutate",
			authorized((request) =>
				Effect.gen(function* () {
					const raw = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
					// Parity with the RPC means parity of VALIDATION, not just of route: `projects.mutate` decodes its
					// payload with the contract's `ProjectMutation`, so the same JSON has to mean the same thing on both
					// transports. Passed through unchecked, a body the RPC refuses reached the bridge's switch — `{}` matched
					// no case and the route answered 200 with an empty body (a create that did nothing, reported as success),
					// and a `projectId` outside the contract's brand took a bridge-minted id, so one JSON made two projects.
					const decoded = yield* Effect.try({
						try: () => Schema.decodeUnknownSync(ProjectMutation)(raw),
						catch: (error) => decodeMessage(error),
					}).pipe(
						Effect.map((value) => ({ value } as const)),
						Effect.catch((message) => Effect.succeed({ message } as const)),
					);
					if ("message" in decoded) return json({ _tag: "ProjectMutationError", commandId: commandIdOf(raw), message: decoded.message }, 400);
					const mutation = decoded.value;
					return yield* Effect.tryPromise({
						try: () => bridge.mutateProject(mutation),
						catch: (error) => error as Error,
					}).pipe(
						Effect.map((project) => json(project)),
						Effect.catch((error) =>
							// A duplicate path (a workspace owned by another project) and a duplicate minted id are both
							// conflicts (409); classify by the error's `name` so it holds across module boundaries, not only
							// by `instanceof`.
							Effect.succeed(json({ _tag: "ProjectMutationError", commandId: mutation.commandId, message: error.message || String(error) }, error.name === ProjectConflict.name || error.name === ProjectIdConflict.name ? 409 : 400)),
						),
					);
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/ws",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const url = new URL(request.url, "http://bridge");
				if (url.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM) !== String(ORCHESTRATION_PROTOCOL_VERSION)) {
					return json(
						{
							code: "orchestration_protocol_incompatible",
							message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
							orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
						},
						426,
					);
				}
				const tokenHash = auth.consumeTicket(url.searchParams.get("wsTicket"));
				if (tokenHash === undefined) {
					return json({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", message: "Invalid WebSocket ticket." }, 401);
				}
				log.info("client connected");
				const httpEffect = yield* Effect.gen(function* () {
					const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
					yield* RpcServer.make(WsRpcGroup, { disableTracing: true, disableFatalDefects: true } as Any).pipe(
						Effect.provideService(RpcServer.Protocol, protocol),
						Effect.provide(rpcLayer),
						Effect.forkScoped,
					);
					return httpEffect;
				}).pipe(Effect.provide(RpcSerialization.layerJson));
				// If the client's bearer token stops being active — it expires, or `auth.json` is edited out — close this
				// connection, so a client cannot keep its live WebSocket after its token is gone.
				const revoked = Effect.gen(function* () {
					while (auth.isTokenActive(tokenHash)) yield* Effect.sleep("2 seconds");
					log.info("token no longer active; closing WebSocket");
				});
				return yield* Effect.raceFirst(httpEffect, revoked.pipe(Effect.as(HttpServerResponse.empty({ status: 401 }))));
			}),
		),
	);

	const cors = HttpRouter.cors({
		allowedOrigins: bridge.config.corsOrigins,
		allowedMethods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["authorization", "content-type", "dpop", "b3", "traceparent", ORCHESTRATION_PROTOCOL_HEADER],
		maxAge: 600,
	});

	return HttpRouter.serve(Layer.mergeAll(routes, cors, hostGuard) as Any, { disableLogger: true }).pipe(
		Layer.provide(NodeHttpServer.layer(() => httpServer, { host: bridge.config.host, port: bridge.config.port })),
	);
}
