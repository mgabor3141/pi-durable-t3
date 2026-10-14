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
import { type AuthStore, PairingRateLimit } from "./auth.ts";
import type { Bridge } from "./bridge.ts";
import type { ModelCatalog } from "./models.ts";
import type { Logger } from "./logging.ts";
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
 * The address pairing attempts are counted against. Behind a local reverse proxy (`tailscale serve`) every request
 * comes from loopback, so the proxy's X-Forwarded-For (the tailnet client) is used instead; it is trusted only when
 * the connection itself is from loopback.
 */
function clientAddress(remote: string, forwarded: string | undefined): string {
	const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
	const first = forwarded?.split(",")[0]?.trim();
	return loopback && first ? first : remote;
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

	const routes = Layer.mergeAll(
		HttpRouter.add("GET", "/.well-known/t3/environment", Effect.sync(() => json(descriptor()))),
		// Printed pairing URLs point here; a desktop browser opening one gets instructions instead of a 404.
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
				const address = clientAddress(
					Option.getOrElse(request.remoteAddress, () => "unknown"),
					request.headers["x-forwarded-for"],
				);
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
			authorized(() =>
				Effect.gen(function* () {
					const { threadId } = yield* HttpRouter.params;
					const result = yield* Effect.tryPromise(() => bridge.projection(threadId!)).pipe(Effect.option);
					if (result._tag === "None") return json({ _tag: "EnvironmentResourceNotFoundError", message: "Unknown thread" }, 404);
					return json(
						encode(OrchestrationV2ThreadDetailSnapshot, {
							snapshotSequence: bridge.nextSequence(),
							projection: result.value.projection,
						}),
					);
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/orchestration/threads/:threadId/bounded",
			authorized(() =>
				Effect.gen(function* () {
					const { threadId } = yield* HttpRouter.params;
					const result = yield* Effect.tryPromise(() => bridge.projection(threadId!)).pipe(Effect.option);
					if (result._tag === "None") return json({ _tag: "EnvironmentResourceNotFoundError", message: "Unknown thread" }, 404);
					return json(
						encode(OrchestrationV2ThreadBoundedSnapshot, {
							snapshotSequence: bridge.nextSequence(),
							projection: result.value.projection,
							historyCursor: null,
							hasMoreHistory: false,
							latestLocalTurnOrdinal: result.value.runs.at(-1)?.ordinal ?? null,
						}),
					);
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/projects",
			authorized(() => Effect.sync(() => json({ projects: bridge.projects() }))),
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
