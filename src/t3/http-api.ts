// T3's HTTP API (`EnvironmentHttpApi` in the contracts), implemented group by group the way T3's server does
// (apps/server/src/{http,auth/http,orchestration-v2/http,project/http}.ts). The contract decodes every request and
// encodes every answer and every error, so a route here cannot drift from the HttpApi client the web app calls it with.
// An endpoint this host does not serve answers 404, as an unregistered route would, and is logged.
import { randomUUID } from "node:crypto";
import {
	AuthAccessTokenType,
	AuthAccessWriteScope,
	AuthMcpApprovalError,
	type AuthMcpAuthorizationRequest,
	AuthMcpClientAccess,
	AuthMcpRegistrationError,
	AuthMcpTokenError,
	mcpClientScopes,
	AuthOrchestrationReadScope,
	AuthSessionId,
	AuthStandardClientScopes,
	authScopeRequiredResponse,
	authScopeResponse,
	type AuthEnvironmentScope,
	EnvironmentAuthenticatedAuth,
	EnvironmentAuthenticatedPrincipal,
	EnvironmentAuthInvalidError,
	EnvironmentHttpApi,
	EnvironmentId,
	EnvironmentInternalError,
	type EnvironmentInternalErrorReason,
	EnvironmentOperationForbiddenError,
	EnvironmentRequestInvalidError,
	type EnvironmentRequestInvalidReason,
	EnvironmentResourceNotFoundError,
	EnvironmentScopeRequiredError,
	type ExecutionEnvironmentDescriptor,
	PROVIDER_SEND_TURN_MAX_FILE_BYTES,
	PullRequestUnavailableError,
	requiredScopesForProjectMutation,
	type ServerConfig,
	ThreadId,
} from "@t3tools/contracts";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import {
	type AuthorizationParams,
	authorizationServerMetadata,
	type McpOAuth,
	type McpOAuthClient,
	McpOAuthRedirectError,
	type McpRegistrationRefusal,
	McpTokenRefusal,
	protectedResourceMetadata,
	redirectForError,
	urlsFor,
} from "./mcp-oauth.ts";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ProjectConflict, ProjectIdConflict } from "../registry.ts";
import type { AuthStore, ClientMetadata, PairingRateLimit, StoredToken } from "./auth.ts";
import { type Bridge, CommandError } from "./bridge.ts";
import type { Logger } from "./logging.ts";
import { InvalidThreadHistoryCursorError, decodeThreadHistoryCursor, projectThreadProjectionForWire, projectedRowEncodedBytes, renderMcpOAuthErrorPage } from "./t3-server.ts";
import { boundedSnapshot, historyPage } from "./thread-stream.ts";

export interface HttpApiDeps {
	readonly bridge: Bridge;
	readonly auth: AuthStore;
	readonly log: Logger;
	readonly descriptor: () => ExecutionEnvironmentDescriptor;
	readonly authDescriptor: ServerConfig["auth"];
	readonly pairingLimit: PairingRateLimit;
	/** The request's session: a bearer token, else the same-origin browser session cookie. */
	readonly resolveSession: (request: HttpServerRequest.HttpServerRequest) => StoredToken | undefined;
	/** The browser session cookie for a session token. */
	readonly sessionCookie: (token: string, expiresAtMs: number) => string;
	readonly sessionCookieName: string;
	/** The same-origin browser session cookie's session alone (T3's `authenticateBrowserSession`): what may approve an
	 * MCP client with one click. */
	readonly resolveBrowserSession: (request: HttpServerRequest.HttpServerRequest) => StoredToken | undefined;
	readonly mcpOAuth: McpOAuth;
}

/** The web app's page that asks the user to approve an MCP client. */
const APPROVAL_PAGE_PATH = "/connect-agent";
/** T3's headers for the sign-in error page. */
const OAUTH_PAGE_HEADERS = {
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
	"x-frame-options": "DENY",
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};

/** The request's origin, as T3's `requestUrls` reads it (`HttpServerRequest.toURL`). */
export const requestOrigin = (request: HttpServerRequest.HttpServerRequest): string =>
	Option.match(HttpServerRequest.toURL(request), { onNone: () => "http://localhost", onSome: (url) => url.origin });

// T3 stamps its errors with the request's trace id; this host has no tracing, so each error gets a fresh id to quote.
const traceId = () => randomUUID();
const authInvalid = (reason: "missing_credential" | "invalid_credential") => Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId: traceId() }));
const invalidRequest = (reason: EnvironmentRequestInvalidReason) => Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId: traceId() }));
const scopeRequired = (scope: AuthEnvironmentScope) => Effect.fail(new EnvironmentScopeRequiredError({ code: "insufficient_scope", ...authScopeRequiredResponse(scope), traceId: traceId() }));
const notFound = () => Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason: "thread_not_found", traceId: traceId() }));

/** T3's credential response headers: an answer that carries a credential is never cached. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) => Effect.succeed(HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" })));

/** The scope check every authenticated handler starts with (T3's `requireEnvironmentScope`). */
const requireScope = (scope: AuthEnvironmentScope) =>
	Effect.flatMap(EnvironmentAuthenticatedPrincipal, (principal) => (principal.scopes.has(scope) ? Effect.succeed(principal) : scopeRequired(scope)));

export function makeHttpApiLayer(deps: HttpApiDeps) {
	const { bridge, auth, log } = deps;

	const internal = (reason: EnvironmentInternalErrorReason, cause: unknown): Effect.Effect<never, EnvironmentInternalError> =>
		Effect.sync(() => log.warn("environment api operation failed", { reason, error: cause instanceof Error ? cause.message : String(cause) })).pipe(
			Effect.andThen(Effect.fail(new EnvironmentInternalError({ code: "internal_error", reason, traceId: traceId() }))),
		);

	/** An endpoint this host does not serve: the 404 an unregistered route would answer, and a log line saying which. */
	const unsupported = (endpoint: string) =>
		Effect.sync(() => {
			log.info("unsupported HTTP endpoint", { endpoint });
			return HttpServerResponse.text("Not Found", { status: 404 });
		});

	// T3's `layerAuthenticatedAuth`: the session or the contract's 401, and the principal for the handler.
	const authenticatedAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			const token = deps.resolveSession(request);
			if (token === undefined) {
				const presented = request.headers.authorization !== undefined || request.cookies[deps.sessionCookieName] !== undefined;
				return yield* authInvalid(presented ? "invalid_credential" : "missing_credential");
			}
			return yield* httpEffect.pipe(
				Effect.provideService(EnvironmentAuthenticatedPrincipal, {
					sessionId: AuthSessionId.make(token.id),
					subject: token.subject,
					method: token.method,
					scopes: new Set(token.scopes as AuthEnvironmentScope[]),
					expiresAt: DateTime.makeUnsafe(token.expiresAt),
				}),
			);
		}),
	);

	/** The socket's address keys the pairing limiter, never a header (design.md). A blocked address never reaches these
	 * handlers (`pairingRateLimit` in http.ts); a failed attempt is counted here. */
	const addressOf = (request: HttpServerRequest.HttpServerRequest) => Option.getOrElse(request.remoteAddress, () => "unknown");

	const metadata = HttpApiBuilder.group(EnvironmentHttpApi, "metadata", (handlers) => handlers.handle("descriptor", () => Effect.sync(deps.descriptor)));

	const authGroup = HttpApiBuilder.group(EnvironmentHttpApi, "auth", (handlers) =>
		handlers
			.handle("session", () =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const token = deps.resolveSession(request);
					if (token === undefined) return { authenticated: false, auth: deps.authDescriptor, permissions: [] };
					return {
						authenticated: true,
						auth: deps.authDescriptor,
						...authScopeResponse(token.scopes as AuthEnvironmentScope[]),
						sessionMethod: token.method,
						expiresAt: DateTime.makeUnsafe(token.expiresAt),
					};
				}),
			)
			.handle("browserSession", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const address = addressOf(request);
					// A re-pair in one browser replaces the session it is calling with (its own cookie), not a new row.
					const cookie = request.cookies[deps.sessionCookieName];
					const previous = cookie === undefined ? undefined : auth.verifySessionToken(cookie);
					const userAgent = request.headers["user-agent"];
					const presented: ClientMetadata = { ipAddress: address, label: "browser", ...(userAgent ? { userAgent } : {}), deviceType: "desktop" };
					const exchanged = auth.createBrowserSession(payload.credential, presented, previous?.id);
					if (!("session" in exchanged)) {
						deps.pairingLimit.fail(address);
						log.warn("pairing rejected", { address, refused: exchanged.refused });
						return yield* authInvalid("invalid_credential");
					}
					const issued = exchanged.session;
					log.info("browser session paired", { label: issued.session.label ?? issued.session.deviceType });
					yield* HttpEffect.appendPreResponseHandler((_request, response) =>
						Effect.succeed(HttpServerResponse.setHeader(response, "set-cookie", deps.sessionCookie(issued.token, issued.session.expiresAt))),
					);
					yield* noStore;
					return {
						authenticated: true as const,
						...authScopeResponse(issued.scopes as AuthEnvironmentScope[]),
						sessionMethod: "browser-session-cookie" as const,
						expiresAt: DateTime.makeUnsafe(issued.session.expiresAt),
					};
				}),
			)
			.handle("token", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const address = addressOf(request);
					const requested = payload.scope === undefined ? undefined : parseOAuthScope(payload.scope);
					if (requested === null || requested?.length === 0) return yield* invalidRequest("invalid_scope");
					const userAgent = request.headers["user-agent"];
					const presented: ClientMetadata = {
						ipAddress: address,
						...(payload.client_label === undefined ? {} : { label: payload.client_label }),
						...(userAgent ? { userAgent } : {}),
						...(payload.client_device_type === undefined ? {} : { deviceType: payload.client_device_type }),
						...(payload.client_os === undefined ? {} : { os: payload.client_os }),
					};
					const exchanged = auth.exchange(payload.subject_token, presented, requested === undefined ? undefined : [...requested]);
					if (!("session" in exchanged)) {
						deps.pairingLimit.fail(address);
						log.warn("pairing rejected", { address, refused: exchanged.refused });
						return yield* exchanged.refused === "scope-not-granted" ? invalidRequest("scope_not_granted") : authInvalid("invalid_credential");
					}
					const issued = exchanged.session;
					log.info("client paired", { label: issued.session.label ?? issued.session.deviceType });
					yield* noStore;
					return { access_token: issued.token, issued_token_type: AuthAccessTokenType, token_type: "Bearer" as const, expires_in: issued.expiresIn, scope: issued.scopes.join(" ") };
				}),
			)
			// The bare path is what clients before ticket audiences call; `/:use` names the audience. Both mint the same
			// one-shot ticket: this host's tickets are short-lived and serve either use.
			.handle("webSocketTicket", () => issueTicket)
			.handle("webSocketTicketFor", () => issueTicket)
			.handle("pairingCredential", ({ payload }) =>
				Effect.gen(function* () {
					const principal = yield* requireScope(AuthAccessWriteScope);
					const delegated = payload.scopes ?? AuthStandardClientScopes;
					if (delegated.length === 0 || new Set<string>(delegated).size !== delegated.length) return yield* invalidRequest("invalid_scope");
					for (const scope of delegated) if (!principal.scopes.has(scope)) return yield* scopeRequired(scope);
					const issued = auth.createPairingLink({ scopes: [...delegated], ...(payload.label === undefined ? {} : { label: payload.label }) });
					return { id: issued.id, credential: issued.credential, ...(payload.label === undefined ? {} : { label: payload.label }), expiresAt: DateTime.makeUnsafe(issued.expiresAt) };
				}),
			)
			.handle("revokePairingLink", ({ payload }) => Effect.map(requireScope(AuthAccessWriteScope), () => ({ revoked: auth.revokePairingLink(payload.id) })))
			.handle("revokeClient", ({ payload }) =>
				Effect.gen(function* () {
					const principal = yield* requireScope(AuthAccessWriteScope);
					// A client cannot revoke the session it is calling with: the UI hides that row, and T3 refuses it.
					if (payload.sessionId === principal.sessionId) {
						return yield* Effect.fail(new EnvironmentOperationForbiddenError({ code: "operation_forbidden", reason: "current_session_revoke_not_allowed", traceId: traceId() }));
					}
					return { revoked: auth.revokeClientSession(payload.sessionId) };
				}),
			)
			.handle("revokeOtherClients", () => Effect.map(requireScope(AuthAccessWriteScope), (principal) => ({ revokedCount: auth.revokeOtherClientSessions(principal.sessionId) }))),
	);

	const issueTicket = Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const token = deps.resolveSession(request);
		if (token === undefined) return yield* internal("websocket_ticket_issuance_failed", new Error("the authenticated session went away"));
		const { ticket, expiresAt } = auth.issueTicket(token.hash);
		yield* noStore;
		return { ticket: Redacted.make(ticket), expiresAt: DateTime.makeUnsafe(expiresAt) };
	});

	// The thread routes bring the thread's stream up to date and answer at its sequence, so a subscription that resumes
	// after it is replayed exactly what it missed. An unknown thread is the contract's not-found.
	const streamOf = (threadId: ThreadId, reason: EnvironmentInternalErrorReason) =>
		Effect.gen(function* () {
			yield* requireScope(AuthOrchestrationReadScope);
			if (!bridge.hasThread(threadId)) return yield* notFound();
			return yield* Effect.tryPromise(() => bridge.streamSnapshot(threadId)).pipe(Effect.catch((error): Effect.Effect<never, EnvironmentInternalError | EnvironmentResourceNotFoundError> => (bridge.hasThread(threadId) ? internal(reason, error) : notFound())));
		});

	const orchestration = HttpApiBuilder.group(EnvironmentHttpApi, "orchestration", (handlers) =>
		handlers
			// `omitIdleSubagents` and `omitOlderSettled` only ever narrow the snapshot; this host sends it whole, which every
			// client accepts (the WS shell stream does the same).
			.handle("shellSnapshot", () => Effect.map(requireScope(AuthOrchestrationReadScope), () => bridge.shellSnapshot()))
			.handle("threadSnapshot", ({ params }) =>
				Effect.map(streamOf(params.threadId, "orchestration_thread_snapshot_failed"), (stream) => ({ snapshotSequence: stream.sequence, projection: projectThreadProjectionForWire(stream.projection) })),
			)
			.handle("threadTranscript", ({ params }) =>
				Effect.gen(function* () {
					const stream = yield* streamOf(params.threadId, "orchestration_thread_snapshot_failed");
					const projection = stream.projection;
					const transcript = { threadId: projection.thread.id, title: projection.thread.title, updatedAt: projection.updatedAt, items: projection.visibleTurnItems };
					// T3's bound: the transcript is attached to a prompt as a file, so it may not exceed a file attachment.
					let sizeBytes = Buffer.byteLength(threadTranscriptHeader(EnvironmentId.make(auth.environmentId), transcript), "utf8");
					for (const row of transcript.items) {
						if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) break;
						sizeBytes += projectedRowEncodedBytes(row) + 1;
					}
					if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return yield* invalidRequest("thread_transcript_too_large");
					return transcript;
				}),
			)
			.handle("threadBoundedSnapshot", ({ params, query }) =>
				Effect.map(streamOf(params.threadId, "orchestration_thread_bounded_snapshot_failed"), (stream) =>
					boundedSnapshot(stream.sequence, stream.projection, {
						deferWork: query.deferWork === "1",
						compactTurnItems: query.compactTurnItems === "1",
						dedupeBodies: query.dedupeBodies === "1",
						compactIds: query.compactIds === "1",
					}),
				),
			)
			.handle("threadHistoryPage", ({ params, query }) =>
				Effect.gen(function* () {
					yield* requireScope(AuthOrchestrationReadScope);
					const cursor = yield* Effect.try(() => decodeThreadHistoryCursor(query.cursor)).pipe(Effect.option);
					if (Option.isNone(cursor)) return yield* invalidRequest("invalid_history_cursor");
					const stream = yield* streamOf(params.threadId, "orchestration_thread_history_failed");
					const page = yield* Effect.try({
						try: () => historyPage({ projection: stream.projection, snapshotSequence: stream.sequence, cursor: query.cursor, throughEntryId: query.throughEntryId, view: query.view, deferWork: query.deferWork === "1" }),
						catch: (error) => error,
					}).pipe(Effect.catch((error): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> => (error instanceof InvalidThreadHistoryCursorError ? invalidRequest("invalid_history_cursor") : internal("orchestration_thread_history_failed", error))));
					return query.compactIds === "1" ? { ...page, idTable: true as const } : page;
				}),
			),
	);

	const projects = HttpApiBuilder.group(EnvironmentHttpApi, "projects", (handlers) =>
		handlers
			.handle("snapshot", () => Effect.map(requireScope(AuthOrchestrationReadScope), () => ({ projects: bridge.projectRecords(), updatedAt: new Date().toISOString() })))
			.handle("mutate", ({ payload }) =>
				Effect.gen(function* () {
					for (const scope of requiredScopesForProjectMutation(payload)) yield* requireScope(scope);
					return yield* Effect.tryPromise({ try: () => bridge.mutateProject(payload), catch: (error) => error as Error }).pipe(
						// T3 answers a missing, conflicting or non-empty project as an invalid command, anything else as internal.
						Effect.catch((error): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> => (isRefusal(error) ? invalidRequest("invalid_command") : internal("project_mutation_failed", error))),
					);
				}),
			),
	);

	// Pull requests need a source-control provider this host does not have: the contract's own refusal.
	const pullRequests = HttpApiBuilder.group(EnvironmentHttpApi, "pullRequests", (handlers) =>
		handlers.handle("diff", () => Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }))),
	);

	// MCP OAuth (T3's `mcpOAuthHttp` over `./mcp-oauth.ts`): the metadata, registration, the authorize redirect into the
	// web app's `/connect-agent` page, the page's approval and decision calls, and the code exchange.
	const oauth = deps.mcpOAuth;
	const urls = Effect.map(HttpServerRequest.HttpServerRequest, (request) => urlsFor(requestOrigin(request)));
	const reveal = ({ state, ...request }: AuthMcpAuthorizationRequest): AuthorizationParams => ({
		...request,
		...(state === undefined ? {} : { state: Redacted.value(state) }),
	});
	/** An unverified client or redirect is reported, never redirected; any other problem goes back through the
	 * (verified) redirect URI. */
	const forwardedAuthorization = (request: AuthMcpAuthorizationRequest) =>
		Effect.gen(function* () {
			const { issuer, resource } = yield* urls;
			try {
				return oauth.validateAuthorization({ issuer, resource }, reveal(request));
			} catch (error) {
				if (error instanceof McpOAuthRedirectError) return { redirectTo: redirectForError(error, issuer) };
				return yield* Effect.fail(new AuthMcpApprovalError({ message: (error as Error).message }));
			}
		});
	const mcpOAuth = HttpApiBuilder.group(EnvironmentHttpApi, "mcpOAuth", (handlers) =>
		handlers
			.handle("protectedResource", () => Effect.map(urls, protectedResourceMetadata))
			.handle("mcpProtectedResource", () => Effect.map(urls, protectedResourceMetadata))
			.handle("authorizationServer", () => Effect.map(urls, authorizationServerMetadata))
			.handle("register", ({ payload }) =>
				Effect.gen(function* () {
					let client: McpOAuthClient;
					try {
						client = oauth.register(payload);
					} catch (error) {
						const refusal = error as McpRegistrationRefusal;
						return yield* Effect.fail(new AuthMcpRegistrationError({ error: refusal.error, error_description: refusal.description }));
					}
					yield* noStore;
					log.info("MCP client registered", { client: client.name, peerLink: client.peerLink });
					return {
						client_id: client.clientId,
						client_name: client.name,
						redirect_uris: client.redirectUris,
						grant_types: ["authorization_code" as const],
						response_types: ["code" as const],
						token_endpoint_auth_method: "none" as const,
					};
				}),
			)
			.handleRaw("authorize", ({ request }) =>
				Effect.gen(function* () {
					const { issuer, resource } = yield* urls;
					const url = new URL(request.url, issuer);
					const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
					try {
						oauth.validateAuthorization({ issuer, resource }, Object.fromEntries(url.searchParams) as AuthorizationParams);
						return HttpServerResponse.redirect(`${APPROVAL_PAGE_PATH}${url.search}`, { headers });
					} catch (error) {
						if (error instanceof McpOAuthRedirectError) return HttpServerResponse.redirect(redirectForError(error, issuer), { headers });
						return HttpServerResponse.text(renderMcpOAuthErrorPage((error as Error).message), { status: 400, contentType: "text/html; charset=utf-8", headers: OAUTH_PAGE_HEADERS });
					}
				}),
			)
			.handle("approval", ({ payload, request }) =>
				Effect.gen(function* () {
					const resolved = yield* forwardedAuthorization(payload);
					if ("redirectTo" in resolved) return resolved;
					const { issuer } = yield* urls;
					const session = oauth.approvingBrowserSession(deps.resolveBrowserSession(request), resolved);
					yield* noStore;
					return {
						clientName: resolved.client.name,
						redirectHost: new URL(resolved.redirectUri).host,
						environmentHost: new URL(issuer).host,
						...(session === undefined
							? {}
							: {
									csrfToken: session.csrfToken,
									oneClickAccess: AuthMcpClientAccess.literals.filter((access) => mcpClientScopes(access).every((scope) => session.scopes.includes(scope))),
								}),
					};
				}),
			)
			.handle("decision", ({ payload, request }) =>
				Effect.gen(function* () {
					const resolved = yield* forwardedAuthorization(payload.authorization);
					if ("redirectTo" in resolved) return resolved;
					yield* noStore;
					const { decision } = payload;
					if (decision._tag === "deny") {
						log.info("MCP client sign-in denied", { client: resolved.client.name });
						return { redirectTo: oauth.deny(resolved) };
					}
					try {
						const redirectTo = oauth.approve({ browserSession: deps.resolveBrowserSession(request), authorization: resolved, decision });
						log.info("MCP client sign-in approved", { client: resolved.client.name, access: decision.access, method: decision._tag });
						return { redirectTo };
					} catch (error) {
						return yield* Effect.fail(new AuthMcpApprovalError({ message: (error as Error).message }));
					}
				}),
			)
			.handle("token", ({ payload, request }) =>
				Effect.gen(function* () {
					yield* noStore;
					const userAgent = request.headers["user-agent"];
					const { code, code_verifier: verifier, ...token } = payload;
					try {
						const { session: _session, ...result } = oauth.exchangeCode({
							urls: yield* urls,
							client: { ipAddress: addressOf(request), ...(userAgent ? { userAgent } : {}) },
							token: {
								...token,
								...(code === undefined ? {} : { code: Redacted.value(code) }),
								...(verifier === undefined ? {} : { code_verifier: Redacted.value(verifier) }),
							},
						});
						return result;
					} catch (error) {
						if (!(error instanceof McpTokenRefusal)) throw error;
						return yield* Effect.fail(new AuthMcpTokenError({ error: error.error, error_description: error.description }));
					}
				}),
			),
	);
	// T3 Connect and webhooks are not served by this host.
	const connect = HttpApiBuilder.group(EnvironmentHttpApi, "connect", (handlers) =>
		handlers
			.handleRaw("linkProof", () => unsupported("connect.linkProof"))
			.handleRaw("relayConfig", () => unsupported("connect.relayConfig"))
			.handleRaw("linkState", () => unsupported("connect.linkState"))
			.handleRaw("checkReachability", () => unsupported("connect.checkReachability"))
			.handleRaw("unlink", () => unsupported("connect.unlink"))
			.handleRaw("preferences", () => unsupported("connect.preferences"))
			.handleRaw("health", () => unsupported("connect.health"))
			.handleRaw("t3MintCredential", () => unsupported("connect.t3MintCredential")),
	);
	const webhooks = HttpApiBuilder.group(EnvironmentHttpApi, "webhooks", (handlers) =>
		handlers
			.handleRaw("webhookPost", () => unsupported("webhooks.webhookPost"))
			.handleRaw("webhookPut", () => unsupported("webhooks.webhookPut"))
			.handleRaw("webhookPatch", () => unsupported("webhooks.webhookPatch"))
			.handleRaw("webhookGet", () => unsupported("webhooks.webhookGet")),
	);

	return HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
		Layer.provide([metadata, authGroup, orchestration, projects, pullRequests, mcpOAuth, connect, webhooks]),
		Layer.provide(authenticatedAuth),
	);
}

/** A refusal of the mutation itself (T3's `ProjectNotFoundError`, `ProjectConflictError`, `ProjectNotEmptyError`). */
function isRefusal(error: Error): boolean {
	return error instanceof CommandError || error.name === ProjectConflict.name || error.name === ProjectIdConflict.name;
}
