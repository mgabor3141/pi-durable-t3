// HTTP surface (discovery, pairing, tickets, snapshots, Connections) and the `/ws` RPC endpoint.
import { type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { arch, platform } from "node:os";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
	AuthAccessReadScope,
	AuthAccessWriteScope,
	AuthAccessTokenType,
	AuthClientSessionRevokeResult,
	AuthClientSession,
	authScopeResponse,
	AuthOtherClientSessionsRevokeResult,
	AuthPairingCredentialResult,
	AuthPairingLinkRevokeResult,
	AuthPairingLink,
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
import * as DateTime from "effect/DateTime";
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
import { listClientSessions, listPairingLinks } from "./access.ts";
import { type AuthStore, type ClientMetadata, PairingRateLimit } from "./auth.ts";
import type { AttachmentStore } from "./attachment-store.ts";
import type { Bridge } from "./bridge.ts";
import type { ModelCatalog } from "./models.ts";
import type { Logger } from "./logging.ts";
import type { ProjectionResult } from "./projection.ts";
import { makeRpcLayer } from "./rpc.ts";
import { CurrentAuthSession } from "./session-context.ts";

/** The T3 release at our pin (`T3_TAG` in dev/setup-t3.sh). Never the client's version: T3's update banner then says
 * truthfully how far the pin is behind the app. */
export const SERVER_VERSION = "0.1.1-nightly.20261017.3238";

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


/** `/api/auth/session` for a paired client: the contract's own projection of a grant — legacy `scopes` (the frozen
 * vocabulary) plus the full `permissions` list T3 gates actions on. */
function authenticatedSession(expiresAt: number) {
	return {
		authenticated: true,
		auth: authDescriptor,
		...authScopeResponse([...AuthStandardClientScopes]),
		permissions: [...AuthStandardClientScopes],
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
const text = (body: string) => HttpServerResponse.text(body);
const encode = <S extends Schema.Top>(schema: S, value: unknown) => Schema.encodeUnknownSync(schema as Any)(value);

/** The commandId of a body that failed to decode, for the `commandId` the contract's error carries (an empty string when
 * the body has none; the field is required, and its absence is part of what the refusal says). */
const commandIdOf = (raw: unknown): string => (typeof raw === "object" && raw !== null && typeof (raw as Any).commandId === "string" ? String((raw as Any).commandId) : "");

/** A schema refusal in the route's shape: the contract's own error tree, flattened to one readable line. */
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
	attachments: AttachmentStore;
}) {
	const { bridge, auth, log, httpServer, attachments } = deps;
	const descriptor = makeDescriptor(bridge, auth);
	const rpcLayer = makeRpcLayer({ bridge, catalog: deps.catalog, descriptor, authDescriptor, auth, log, attachments });
	const pairingLimit = new PairingRateLimit();

	// DNS-rebinding guard on a loopback bind: serve only requests addressed to a loopback `Host` (the bind/`Host`/CORS
	// story is the README's); a non-loopback bind may legitimately serve real hostnames.
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

	// The Connections endpoints are gated on a scope, not just a bearer. T3's handler shape: a missing credential is
	// `auth_invalid`; a token without the scope is `insufficient_scope`. Both carry a traceId (a UUID we mint: the
	// contract requires the field and the client surfaces it). Every standard grant holds access:read/write, so a
	// paired browser passes; a scope-narrowed grant does not.
	const traceId = () => randomUUID();
	const scopeOf = (header: string | undefined) => auth.verifyBearer(header);
	const authorizedScope =
		(scope: string, handler: (request: HttpServerRequest.HttpServerRequest, token: NonNullable<ReturnType<AuthStore["verifyBearer"]>>) => Any) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const token = scopeOf(request.headers.authorization);
				if (token === undefined) {
					return json({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", reason: "missing_credential", traceId: traceId(), message: "Pair this client first." }, 401);
				}
				if (!token.scopes.includes(scope)) {
					return json({ _tag: "EnvironmentScopeRequiredError", code: "insufficient_scope", requiredScope: scope, requiredPermission: scope, traceId: traceId(), message: `This request needs the ${scope} scope, which this client does not have.` }, 403);
				}
				return yield* handler(request, token);
			});

	// The two `/api/orchestration/threads/:threadId*` routes share their preamble: read the route's threadId, await its
	// projection, and answer an unknown thread with the 404 T3 renders as a missing resource (design.md, Invariants).
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
		// Printed pairing URLs point here: the pairing endpoint takes a POST, so a browser opening one needs a pairing
		// screen, not a 404. The token rides in the hash, never the query string.
		HttpRouter.add("GET", "/pair", Effect.sync(() => text(
			`<!doctype html><meta charset=utf-8><title>Pair with ${"pi"} coding-agent</title>
<style>body{font:16px system-ui;max-width:38rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:2px 4px;border-radius:4px}</style>
<h3>Pair this browser with the bridge</h3>
<p id=s>Checking the pairing code…</p>
<script>
const token = new URL(location.href).hash.replace(/^#/, "");
fetch("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ subject_token: token, client_label: "browser pairing screen" }) })
  .then((r) => r.json())
  .then((j) => { document.getElementById("s").textContent = j.access_token
    ? "Pairing code accepted. Open the T3 app and sign in with this environment — it is now paired."
    : "Pairing failed: the code was already used or has expired. Mint a new pairing code with the host's pair command."; });
</script>`,
		))),
		HttpRouter.add(
			"POST",
			"/oauth/token",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				// The limiter keys on the SOCKET, never on a header (design.md): a proxy behind loopback shares one bucket,
				// which fails CLOSED.
				const address = Option.getOrElse(request.remoteAddress, () => "unknown");
				if (pairingLimit.blocked(address)) {
					log.warn("pairing rate limited", { address });
					return json({ _tag: "EnvironmentAuthInvalidError", code: "rate_limited", message: "Too many pairing attempts; wait a minute." }, 429);
				}
				const body = yield* request.urlParamsBody.pipe(Effect.orElseSucceed(() => [] as Any));
				const params = new URLSearchParams(body as Any);
				const code = params.get("subject_token")?.trim() ?? "";
				// What the exchange knows about the client asking (T3 records it on the session): a label, a UA-derived device
				// shape, and the SOCKET address (never a header — design.md). The label is the client's own; the device type is
				// only accepted when it is one of the contract's literals.
				const clientLabel = params.get("client_label")?.trim();
				const deviceType = params.get("client_device_type");
				const clientOs = params.get("client_os")?.trim();
				const userAgentHeader = request.headers["user-agent"];
				const scopeParam = params.get("scope")?.trim();
				const requestedScopes = scopeParam === undefined || scopeParam === "" ? undefined : scopeParam.split(/\s+/).filter(Boolean);
				// A device type is accepted only when it is one of the contract's literals; anything else is left unset (the
				// store defaults the session to "unknown").
				const isDeviceType = (value: string | null): value is NonNullable<ClientMetadata["deviceType"]> =>
					value === "desktop" || value === "mobile" || value === "tablet" || value === "bot" || value === "unknown";
				const presented = {
					ipAddress: address,
					...(clientLabel === undefined || clientLabel === "" ? {} : { label: clientLabel }),
					...(typeof userAgentHeader === "string" && userAgentHeader !== "" ? { userAgent: userAgentHeader } : {}),
					...(isDeviceType(deviceType) ? { deviceType } : {}),
					...(clientOs === undefined || clientOs === "" ? {} : { os: clientOs }),
				};
				const exchanged = code.length > 0 ? auth.exchange(code, presented, requestedScopes) : { refused: "invalid-credential" as const };
				if ("session" in exchanged === false) {
					pairingLimit.fail(address);
					log.warn("pairing rejected", { address, refused: exchanged.refused });
					return exchanged.refused === "scope-not-granted"
						? json({ _tag: "EnvironmentRequestInvalidError", code: "invalid_request", reason: "scope_not_granted", traceId: traceId(), message: "The pairing code does not grant the requested scopes." }, 400)
						: json({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", reason: "invalid_credential", message: "Invalid or expired pairing code." }, 401);
				}
				const issued = exchanged.session;
				log.info("client paired", { label: issued.session.label ?? issued.session.deviceType });
				return json({
					access_token: issued.token,
					issued_token_type: AuthAccessTokenType,
					token_type: "Bearer",
					expires_in: issued.expiresIn,
					scope: issued.scopes.join(" "),
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
		// ── Connections (Settings → Connections). T3's owner mints a pairing link, lists paired devices and revokes
		// them. Each handler mirrors `apps/server/src/auth/http.ts`: the scope it requires, the request-validity checks,
		// the contract's own success shape (encoded, so one JSON means one thing here and over `/ws`).
		HttpRouter.add(
			"POST",
			"/api/auth/pairing-token",
			authorizedScope(AuthAccessWriteScope, (request, token) =>
				Effect.gen(function* () {
					const raw = (yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)))) as Any;
					const label = typeof raw?.label === "string" && raw.label.trim() !== "" ? raw.label.trim() : undefined;
					const delegated: string[] = Array.isArray(raw?.scopes) ? [...raw.scopes] : [...AuthStandardClientScopes];
					// T3's mint: an empty grant is invalid, and a repeated scope is invalid (the client sends a set; a hand-built
					// request that repeats one is refused, not silently de-duplicated).
					if (delegated.length === 0 || new Set(delegated).size !== delegated.length) {
						return json({ _tag: "EnvironmentRequestInvalidError", code: "invalid_request", reason: "invalid_scope", traceId: traceId(), message: "A pairing link needs at least one scope, and no scope twice." }, 400);
					}
					const missing = delegated.find((scope) => !token.scopes.includes(scope));
					if (missing !== undefined) {
						return json({ _tag: "EnvironmentScopeRequiredError", code: "insufficient_scope", requiredScope: missing, requiredPermission: missing, traceId: traceId(), message: `This client cannot delegate the ${missing} scope, which it does not have.` }, 403);
					}
					const issued = auth.createPairingLink({ scopes: delegated, ...(label === undefined ? {} : { label }) });
					return json(encode(AuthPairingCredentialResult, { id: issued.id, credential: issued.credential, ...(label === undefined ? {} : { label }), expiresAt: DateTime.makeUnsafe(issued.expiresAt) }));
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/auth/pairing-links",
			authorizedScope(AuthAccessReadScope, () => Effect.sync(() => json(encode(Schema.Array(AuthPairingLink), listPairingLinks(auth))))),
		),
		HttpRouter.add(
			"POST",
			"/api/auth/pairing-links/revoke",
			authorizedScope(AuthAccessWriteScope, (request) =>
				Effect.gen(function* () {
					const raw = (yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)))) as Any;
					const revoked = auth.revokePairingLink(typeof raw?.id === "string" ? raw.id : "");
					return json(encode(AuthPairingLinkRevokeResult, { revoked }));
				}),
			),
		),
		HttpRouter.add(
			"GET",
			"/api/auth/clients",
			authorizedScope(AuthAccessReadScope, (request, token) => Effect.sync(() => json(encode(Schema.Array(AuthClientSession), listClientSessions(auth, token.id))))),
		),
		HttpRouter.add(
			"POST",
			"/api/auth/clients/revoke",
			authorizedScope(AuthAccessWriteScope, (request, token) =>
				Effect.gen(function* () {
					const raw = (yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)))) as Any;
					const sessionId = typeof raw?.sessionId === "string" ? raw.sessionId : "";
					// A client cannot revoke the very session it is calling with — the UI hides that row; T3 refuses it (403).
					if (sessionId === token.id) {
						return json({ _tag: "EnvironmentOperationForbiddenError", code: "operation_forbidden", reason: "current_session_revoke_not_allowed", traceId: traceId(), message: "The environment refused this operation (current_session_revoke_not_allowed)." }, 403);
					}
					return json(encode(AuthClientSessionRevokeResult, { revoked: auth.revokeClientSession(sessionId) }));
				}),
			),
		),
		HttpRouter.add(
			"POST",
			"/api/auth/clients/revoke-others",
			authorizedScope(AuthAccessWriteScope, (request, token) => Effect.sync(() => json(encode(AuthOtherClientSessionsRevokeResult, { revokedCount: auth.revokeOtherClientSessions(token.id) })))),
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
		// REST parity with the documented HTTP surface (`EnvironmentProjectsHttpApi`): the same mutation, the same bearer
		// guard, one store.
		HttpRouter.add(
			"POST",
			"/api/projects/mutate",
			authorized((request) =>
				Effect.gen(function* () {
					const raw = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
					// Parity is parity of VALIDATION, not just of URL: decode with the contract's `ProjectMutation`, so one JSON
					// means one thing on `/ws` and over REST (design.md, T3 facet).
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
							// A duplicate path and a duplicate minted id are both conflicts (409); classify by the error's `name`,
							// which holds across module boundaries where `instanceof` may not.
							Effect.succeed(json({ _tag: "ProjectMutationError", commandId: mutation.commandId, message: error.message || String(error) }, error.name === ProjectConflict.name || error.name === ProjectIdConflict.name ? 409 : 400)),
						),
					);
				}),
			),
		),
		// The asset route (T3's `layerAssetRoute`): serve a signed attachment URL's bytes. The signature in the URL is
		// the credential — no bearer — so a browser `<img>` (which sends no auth header) loads it. Resolve verifies
		// signature + expiry, and that the file exists; anything else is the 404 T3 answers for a missing asset.
		HttpRouter.add(
			"GET",
			"/api/assets/*",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const path = new URL(request.url, "http://bridge").pathname;
				const suffix = path.slice("/api/assets/".length);
				const slash = suffix.indexOf("/");
				if (slash <= 0) return HttpServerResponse.text("Not Found", { status: 404 });
				const token = suffix.slice(0, slash);
				const filename = decodeURIComponent(suffix.slice(slash + 1));
				const asset = attachments.resolveAsset(token, filename);
				if (asset === null) return HttpServerResponse.text("Not Found", { status: 404 });
				return HttpServerResponse.uint8Array(asset.bytes, {
					contentType: asset.mimeType,
					headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
				});
			}),
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
				// The socket's session: the Connections list marks this client `current`, and the access stream filters by it.
				const session = auth.sessionOfTokenHash(tokenHash);
				const sessionId = session?.id ?? "";
				// `connected` is the live-socket count in the store: mark this one on acquire, drop it on release (the stream
				// pushes the connect/disconnect so the Connections list updates without a re-poll).
				const connection = yield* Effect.acquireUseRelease(
					Effect.sync(() => auth.markConnected(tokenHash)),
					() =>
						Effect.gen(function* () {
							const httpEffect = yield* Effect.gen(function* () {
								const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
								// `CurrentAuthSession` is provided OUTSIDE `Effect.provide(rpcLayer)`: the rpc layer's handlers
								// (the access stream) require it, so the layer must launch with it in context — not have it injected
								// downstream of where the layer is built.
								yield* RpcServer.make(WsRpcGroup, { disableTracing: true, disableFatalDefects: true } as Any).pipe(
									Effect.provideService(RpcServer.Protocol, protocol),
									Effect.provide(rpcLayer),
									Effect.provideService(CurrentAuthSession, { sessionId }),
									Effect.forkScoped,
								);
								return httpEffect;
							}).pipe(Effect.provide(RpcSerialization.layerJson));
							// A client whose bearer token stops being active — it expires, is revoked from the Connections list, or
							// has `auth.json` edited out — loses its live WebSocket: a token cannot buy a connection after it is gone.
							const revoked = Effect.gen(function* () {
								while (auth.isTokenActive(tokenHash)) yield* Effect.sleep("2 seconds");
								log.info("token no longer active; closing WebSocket");
							});
							return yield* Effect.raceFirst(httpEffect, revoked.pipe(Effect.as(HttpServerResponse.empty({ status: 401 }))));
						}),
					() => Effect.sync(() => auth.markDisconnected(tokenHash)),
				);
				return connection;
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
