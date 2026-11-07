// HTTP surface (discovery, pairing, tickets, snapshots, Connections), the `/ws` RPC endpoint, and — when a web app
// is configured — the static client with T3's SPA fallback.
import { randomUUID } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { type Server } from "node:http";
import { arch, platform } from "node:os";
import { extname, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
	type ExecutionEnvironmentDescriptor,
	AuthOrchestrationOperateScope,
	authScopeRequiredResponse,
	EnvironmentAuthInvalidError,
	EnvironmentScopeRequiredError,
	EnvironmentId,
	type ServerConfig,
	PROVIDER_SEND_TURN_MAX_FILE_BYTES,
	ORCHESTRATION_PROTOCOL_HEADER,
	ORCHESTRATION_PROTOCOL_QUERY_PARAM,
	ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Mime from "effect/http/Mime";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { WsRpcGroup } from "@t3tools/contracts";
import { type AuthStore, PairingRateLimit } from "./auth.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX, type AttachmentStore } from "./attachment-store.ts";
import type { WorkspaceAssets } from "./workspace-assets.ts";
import type { Bridge } from "./bridge.ts";
import type { ModelCatalog } from "./models.ts";
import type { Logger } from "./logging.ts";
import { makeRpcLayer } from "./rpc.ts";
import { makeHttpApiLayer } from "./http-api.ts";
import { makeMcpLayer } from "./mcp.ts";
import type { SecretRequests } from "./secret-requests.ts";
import { ThreadOps } from "./thread-ops.ts";
import type { WorkspaceFiles } from "./files.ts";
import type { ScheduledTasks } from "./scheduled-tasks.ts";
import { CurrentAuthSession } from "./session-context.ts";
import type { TailscaleCli } from "./tailscale.ts";
import type { PreviewSessions } from "./preview.ts";
import { makePreviewStreamHandler } from "./preview-http.ts";

/** The T3 release at our pin (`T3_TAG` in dev/t3-pin.sh). Never the client's version: T3's update banner then says
 * truthfully how far the pin is behind the app. */
export const SERVER_VERSION = "0.1.6";

// biome-ignore lint/suspicious/noExplicitAny: wire values
type Any = any;

function makeDescriptor(bridge: Bridge, auth: AuthStore, preview: PreviewSessions | undefined): () => ExecutionEnvironmentDescriptor {
	const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : platform() === "win32" ? "windows" : "unknown";
	const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "x64" : "other";
	return (): ExecutionEnvironmentDescriptor => ({
			environmentId: EnvironmentId.make(auth.environmentId),
			label: bridge.config.label,
			platform: { os, arch: cpu, machine: "server" },
			serverVersion: SERVER_VERSION,
			orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
			capabilities: {
				repositoryIdentity: false,
				connectionProbe: true,
				serverResolvedCommandContext: true,
				// The web app offers "Regenerate title" only when this is true: only with the integrator's generator.
				threadTitleRegeneration: bridge.config.titleThread !== undefined,
				// T3's sidebar settlement: manual settle/un-settle is durable on the thread row.
				threadSettlement: true,
				// T3's preview panel uses the server browser when this is true; the stream route is below.
				serverBrowser: preview !== undefined,
				attachmentUploads: true,
				fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
			},
		});
}


/** The browser session cookie's name (T3's `SessionStore.cookieName`): the same-origin web app authenticates every
 * call — HTTP and the WS ticket — with it, since a page served from this origin sends cookies, not a bearer. */
export const SESSION_COOKIE_NAME = "pi_durable_t3_session";

export const authDescriptor: ServerConfig["auth"] = {
	policy: "remote-reachable",
	bootstrapMethods: ["one-time-token"],
	sessionMethods: ["bearer-access-token", "browser-session-cookie"],
	sessionCookieName: SESSION_COOKIE_NAME,
};

/** A browser session cookie: `HttpOnly`, `Path=/`, `SameSite=Lax`, and the session's expiry — exactly the cookie
 * T3 sets (`Cookies.set` with those options), so a re-pair replaces it in place. No `Secure`: the cookie arrives over
 * the loopback http listener — behind Serve too, since Serve terminates TLS and forwards plain http. */
function sessionCookieHeader(token: string, expiresAtMs: number): string {
	return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAtMs).toUTCString()}`;
}

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

// ── Static web app (T3's `layerStaticAndDevRoute`, faithful for a built client with no dev server): a built T3 web
// app served at `/`, with the SPA fallback to `index.html` for app routes. The API, `/ws`, `/.well-known`, `/oauth`,
// `/api` routes are registered more specifically, so the router's specificity makes them win — exactly
// how T3 layers its `GET *` static route behind the API. Caching, the `W/` ETag and `If-None-Match`/`If-Modified-Since` revalidation are replicated from `apps/server/src/http.ts`.

/** T3's `openStaticFile`: a real file → its stats; a directory or a miss → `undefined` (the caller falls back). */
function openStaticFile(filePath: string) {
	try {
		const info = statSync(filePath);
		return info.isFile() ? info : undefined;
	} catch {
		return undefined;
	}
}

function makeStaticHandler(staticDir: string) {
	const staticRoot = resolve(staticDir);
	const isWithinStaticRoot = (candidate: string) =>
		candidate === staticRoot ||
		candidate.startsWith(staticRoot.endsWith(sep) ? staticRoot : `${staticRoot}${sep}`);
	return (request: HttpServerRequest.HttpServerRequest): HttpServerResponse.HttpServerResponse => {
		const pathname = decodeURIComponent(new URL(request.url, "http://bridge").pathname);
		const staticRequestPath = pathname === "/" ? "/index.html" : pathname;
		const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
		const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
		const staticRelativePath = normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
		const hasPathTraversalSegment = staticRelativePath.startsWith("..");
		if (staticRelativePath.length === 0 || hasRawLeadingParentSegment || hasPathTraversalSegment || staticRelativePath.includes("\0") ) {
			return HttpServerResponse.text("Invalid static file path", { status: 400 });
		}

		let filePath = resolve(staticRoot, staticRelativePath);
		if (!isWithinStaticRoot(filePath))
			return HttpServerResponse.text("Invalid static file path", { status: 400 });

		// An extension-less path names a directory route ("/settings") → serve that directory's index.html.
		if (!extname(filePath)) {
			filePath = resolve(filePath, "index.html");
			if (!isWithinStaticRoot(filePath))
				return HttpServerResponse.text("Invalid static file path", { status: 400 });
		}

		// A miss falls back to the app shell (the SPA renders the route client-side); a missing shell is a plain 404.
		let info = openStaticFile(filePath);
		if (info === undefined) {
			filePath = resolve(staticRoot, "index.html");
			info = openStaticFile(filePath);
			if (info === undefined)
				return HttpServerResponse.text("Not Found", { status: 404 });
		}

		const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
		const isHtml = mimeType === "text/html";

		// T3's immutable-asset rule keys on the build's `.vite/manifest.json`, which T3's released client does not ship, so
		// T3 serves it all `no-cache` with validators; so does this host.
		const headers: Record<string, string> = { "cache-control": "no-cache" };
		// Deployments can preserve HTML size and mtime while changing its bundle URLs, so HTML carries no validator.
		const modifiedAt = isHtml ? undefined : info.mtime;
		const etag = modifiedAt
			? `W/"${info.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
			: undefined;
		if (etag !== undefined && modifiedAt !== undefined) {
			headers.etag = etag;
			headers["last-modified"] = modifiedAt.toUTCString();
		}

		// `If-None-Match` (weak comparison) takes precedence over dates; only non-HTML (which carries a validator) revalidates.
		const ifNoneMatch = request.headers["if-none-match"];
		const ifModifiedSince = request.headers["if-modified-since"];
		const unchanged =
			ifNoneMatch !== undefined
				? ifNoneMatch.split(",").some((value) => {
						const candidate = value.trim();
						return (candidate === "*" || (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2)) );
					})
				: ifModifiedSince !== undefined &&
					modifiedAt !== undefined &&
					Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
		if (!isHtml && unchanged) {
			return HttpServerResponse.empty({ status: 304, headers: { ...headers, vary: "Accept-Encoding" } });
		}

		const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
		return HttpServerResponse.stream(Stream.fromReadableStream({ evaluate: () => Readable.toWeb(createReadStream(filePath)), onError: (error) => error }), { headers, contentType, contentLength: info.size });
	};
}

export function makeServerLayer(deps: {
	bridge: Bridge;
	auth: AuthStore;
	catalog: ModelCatalog;
	log: Logger;
	httpServer: Server;
	attachments: AttachmentStore;
	assets: WorkspaceAssets;
	scheduledTasks: ScheduledTasks;
	tailscale: TailscaleCli;
	files: WorkspaceFiles;
	preview: PreviewSessions | undefined;
	secretRequests: SecretRequests;
}) {
	const { bridge, auth, log, httpServer, attachments, assets, preview } = deps;
	const descriptor = makeDescriptor(bridge, auth, preview);
	const rpcLayer = makeRpcLayer({ bridge, files: deps.files, catalog: deps.catalog, descriptor, authDescriptor, auth, log, attachments, assets, scheduledTasks: deps.scheduledTasks, tailscale: deps.tailscale, preview, secretRequests: deps.secretRequests });
	const pairingLimit = new PairingRateLimit();
	// The built web app, when configured.
	const staticHandler = bridge.config.staticDir === undefined ? undefined : makeStaticHandler(bridge.config.staticDir);

	// No `Host` check, like T3 (its server reads `request.headers.host` nowhere in a guard: the only `Host` use is the
	// cookie's same-origin rule below). Auth is the boundary: every route that is not public needs a credential, so a
	// page that rebinds a hostname onto this listener reaches only the public surface and the pairing rate limit.

	// A browser session cookie is a credential a page can ride, so — like T3 (`EnvironmentAuth.isBrowserOriginAllowed`) —
	// it authenticates ONLY a same-origin request: an absent `Origin` (a same-origin GET, a non-browser client), a
	// `Sec-Fetch-Site: same-origin`, or an `Origin` whose host is this request's host (directly or behind a proxy).
	const cookieOriginAllowed = (request: HttpServerRequest.HttpServerRequest): boolean => {
		const origin = request.headers.origin;
		if (origin === undefined) return true;
		if (request.headers["sec-fetch-site"] === "same-origin") return true;
		let originHost: string;
		try {
			originHost = new URL(origin).host.toLowerCase();
		} catch {
			return false;
		}
		if (originHost === "") return false;
		const firstHost = (value: string | undefined) =>
			value === undefined
				? undefined
				: value.split(",")[0]!.trim().toLowerCase();
		return (originHost === firstHost(request.headers.host) || originHost === firstHost(request.headers["x-forwarded-host"]) );
	};

	// A request's session: a bearer/DPoP access token, else the browser session cookie (same-origin only). The web app
	// served from this origin sends the cookie on every call; a foreign client (the desktop app) sends the bearer.
	const resolveSession = (request: HttpServerRequest.HttpServerRequest) => {
		const bearer = auth.verifyBearer(request.headers.authorization);
		if (bearer !== undefined) return bearer;
		const cookie = request.cookies[SESSION_COOKIE_NAME];
		if (cookie === undefined || !cookieOriginAllowed(request)) return undefined;
		return auth.verifySessionToken(cookie);
	};

	// A media request (WebSocket or `<img>`) authenticates like the `/ws` upgrade: a one-shot ticket, else the
	// bearer/cookie session. T3's preview stream uses a ticket minted over authenticated HTTP.
	const resolveMediaSession = (request: HttpServerRequest.HttpServerRequest): ReturnType<typeof resolveSession> => {
		const url = new URL(request.url, "http://bridge");
		const ticketHash = auth.consumeTicket(url.searchParams.get("wsTicket"));
		if (ticketHash !== undefined) {
			const session = auth.sessionOfTokenHash(ticketHash);
			return session;
		}
		return resolveSession(request);
	};

	const apiLayer = makeHttpApiLayer({
		bridge,
		auth,
		log,
		descriptor,
		authDescriptor,
		pairingLimit,
		resolveSession,
		sessionCookie: sessionCookieHeader,
		sessionCookieName: SESSION_COOKIE_NAME,
	});

	// T3's orchestrator MCP server over this host's threads (`mcp.ts`).
	const mcpLayer = makeMcpLayer({ bridge, ops: new ThreadOps(bridge, auth.environmentId, log), log, version: SERVER_VERSION, resolveSession });

	const routes = Layer.mergeAll(
		// The web app sends its traces here (T3's `layerOtlpTracesProxyRoute`). This host exports no traces, which is T3's
		// answer with no OTLP endpoint configured: the caller must hold `orchestration:operate`, and the batch is dropped.
		HttpRouter.add(
			"POST",
			"/api/observability/v1/traces",
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const session = resolveSession(request);
				if (session === undefined) {
					const presented = request.headers.authorization !== undefined || request.cookies[SESSION_COOKIE_NAME] !== undefined;
					return yield* HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(
						new EnvironmentAuthInvalidError({ code: "auth_invalid", reason: presented ? "invalid_credential" : "missing_credential", traceId: randomUUID() }),
						{ status: 401 },
					).pipe(Effect.orDie);
				}
				if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
					return yield* HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(
						new EnvironmentScopeRequiredError({ code: "insufficient_scope", ...authScopeRequiredResponse(AuthOrchestrationOperateScope), traceId: randomUUID() }),
						{ status: 403 },
					).pipe(Effect.orDie);
				}
				return HttpServerResponse.empty({ status: 204 });
			}),
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
				const attachment = attachments.resolveAsset(token, filename);
				const asset = attachment ?? (yield* Effect.promise(() => assets.resolve(token, filename).catch(() => null)));
				if (asset === null) return HttpServerResponse.text("Not Found", { status: 404 });
				return HttpServerResponse.uint8Array(asset.bytes, {
					contentType: asset.mimeType,
					headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
				});
			}),
		),
		// The upload route (T3's `AttachmentUpload`): the signed URL is the credential, and the POST body is the file's
		// exact bytes. The minted claims fix the id, mime type, and size, so this cannot write arbitrary content.
		HttpRouter.add(
			"POST",
			`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const path = new URL(request.url, "http://bridge").pathname;
				const token = path.slice(ATTACHMENT_UPLOAD_ROUTE_PREFIX.length + 1);
				const body = yield* request.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))));
				const stored = attachments.storeUpload(token, Buffer.from(new Uint8Array(body)));
				return stored.ok ? HttpServerResponse.empty({ status: 204 }) : HttpServerResponse.text(stored.detail, { status: stored.status });
			}),
		),
		...(preview === undefined ? [] : [HttpRouter.add("GET", "/api/preview-stream/*", makePreviewStreamHandler({ auth, preview, resolveSession: resolveMediaSession, log }))]),
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
				// A session for the upgrade: a one-shot ticket (a bearer client that cannot set WS headers), else the
				// session credential (the same-origin web app upgrades directly, sending its cookie) — T3's
				// `authenticateWebSocketUpgrade`, which accepts a cookie as well as a bearer/ticket.
				const tokenHash = auth.consumeTicket(url.searchParams.get("wsTicket")) ?? resolveSession(request)?.hash;
				if (tokenHash === undefined) {
					const presented = url.searchParams.has("wsTicket") || request.headers.authorization !== undefined || request.cookies[SESSION_COOKIE_NAME] !== undefined;
					return yield* HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(
						new EnvironmentAuthInvalidError({ code: "auth_invalid", reason: presented ? "invalid_credential" : "missing_credential", traceId: randomUUID() }),
						{ status: 401 },
					).pipe(Effect.orDie);
				}
				const connectedAt = Date.now();
				// The socket's session: the Connections list marks this client `current`, and the access stream filters by it.
				const session = auth.sessionOfTokenHash(tokenHash);
				const sessionId = session?.id ?? "";
				// The client fields make a disconnect attributable: mobile crashes and reconnects otherwise look identical.
				const client = {
					sessionId,
					...(session?.label === undefined ? {} : { label: session.label }),
					...(session?.deviceType === undefined ? {} : { deviceType: session.deviceType }),
					...(session?.os === undefined ? {} : { os: session.os }),
					...(session?.browser === undefined ? {} : { browser: session.browser }),
				};
				log.info("client connected", client);
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
									Effect.provideService(CurrentAuthSession, { sessionId, scopes: session?.scopes ?? [] }),
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
					() => Effect.sync(() => {
						auth.markDisconnected(tokenHash);
						const memory = process.memoryUsage();
						log.info("client disconnected", { ...client, durationMs: Date.now() - connectedAt, heapUsed: memory.heapUsed, rss: memory.rss });
					}),
				);
				return connection;
			}),
		),
		// The integrator's own routes (`HostRoute`): web-standard handlers, public, checked by themselves.
		...(bridge.config.routes ?? []).map((route) =>
			HttpRouter.add(
				route.method,
				route.path,
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const web = yield* HttpServerRequest.toWeb(request).pipe(Effect.orDie);
					const response = yield* Effect.promise(() =>
						route.handle(web).catch((error: unknown) => {
							log.warn("host route failed", { path: route.path, error: error instanceof Error ? error.message : String(error) });
							return new Response("Internal error", { status: 500 });
						}),
					);
					return HttpServerResponse.fromWeb(response);
				}),
			),
		),
		// The built web app, added last: the router's specificity makes every route above win, so this `GET *` is reached
		// only for app routes and asset files. Present only when a web app is configured.
		...(staticHandler === undefined ? [] : [ HttpRouter.add("GET", "*", Effect.map(HttpServerRequest.HttpServerRequest, (request) => staticHandler(request))), ]),
	);

	// The pairing endpoints are reachable by anyone who can reach the host, so failed codes are rate limited per socket
	// address (T3 has no limiter; the contract has no answer for it, so a blocked address gets a plain 429).
	const pairingRateLimit = HttpRouter.middleware(
		(httpEffect) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const path = new URL(request.url, "http://bridge").pathname;
				if (request.method === "POST" && (path === "/oauth/token" || path === "/api/auth/browser-session")) {
					const address = Option.getOrElse(request.remoteAddress, () => "unknown");
					if (pairingLimit.blocked(address)) {
						log.warn("pairing rate limited", { address });
						return HttpServerResponse.text("Too many pairing attempts; wait a minute.", { status: 429 });
					}
				}
				return yield* httpEffect;
			}),
		{ global: true },
	);

	const cors = HttpRouter.cors({
		allowedOrigins: bridge.config.corsOrigins,
		allowedMethods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["authorization", "content-type", "dpop", "b3", "traceparent", ORCHESTRATION_PROTOCOL_HEADER],
		maxAge: 600,
	});

	return HttpRouter.serve(Layer.mergeAll(routes, apiLayer, mcpLayer, pairingRateLimit, cors) as Any, { disableLogger: true }).pipe(
		Layer.provide(NodeHttpServer.layer(() => httpServer, { host: bridge.config.host, port: bridge.config.port })),
	);
}
