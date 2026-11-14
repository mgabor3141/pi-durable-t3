// OAuth for `/mcp`: T3's `McpOAuth` (apps/server/src/auth/McpOAuth.ts) over this host's `AuthStore`. An MCP client —
// another agent, or another T3 environment's peer link — registers, the user approves it in T3's `/connect-agent` page
// (with a pairing code, or one click from a signed-in browser), and it exchanges the code for a bearer session that
// `/mcp` alone accepts, at the access level the user chose.
//
// As T3: registration is stateless (the client id is signed metadata), every client is public and uses PKCE (S256),
// codes are single-use and live 60 s, redirects are https or loopback http, and an unverified client or redirect is
// shown an error page, never redirected to. The signing key is the store's HMAC key, with a domain per use.
import { createHash, randomBytes } from "node:crypto";
import {
	AuthAccessWriteScope,
	type AuthMcpAuthorizationServerMetadata,
	type AuthMcpClientAccess,
	type AuthMcpProtectedResourceMetadata,
	type AuthMcpTokenResult,
	AuthOrchestrationOperateScope,
	AuthOrchestrationReadScope,
	MCP_PEER_LINK_SOFTWARE_ID,
	mcpClientScopes,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import type { AuthStore, ClientMetadata, McpApprovalCodeRefusal, StoredToken } from "./auth.ts";

const AUTHORIZATION_CODE_TTL_MS = 60_000;
const MAX_CLIENT_NAME_LENGTH = 100;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 512;
const DEFAULT_CLIENT_NAME = "MCP client";
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const MCP_OAUTH_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];

export interface McpOAuthUrls {
	readonly issuer: string;
	readonly resource: string;
}

/** The issuer and resource, from the request's own origin (T3's `requestUrls`: loopback, Tailscale and tunnels). */
export const urlsFor = (origin: string): McpOAuthUrls => ({ issuer: origin, resource: `${origin}/mcp` });

export const protectedResourceMetadata = (urls: McpOAuthUrls): AuthMcpProtectedResourceMetadata => ({
	resource: urls.resource,
	authorization_servers: [urls.issuer],
	scopes_supported: MCP_OAUTH_SCOPES,
	bearer_methods_supported: ["header"],
	resource_name: "T3 Code",
});

export const authorizationServerMetadata = (urls: McpOAuthUrls): AuthMcpAuthorizationServerMetadata => ({
	issuer: urls.issuer,
	authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
	token_endpoint: `${urls.issuer}/oauth/mcp/token`,
	registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
	response_types_supported: ["code"],
	grant_types_supported: ["authorization_code"],
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: ["none"],
	scopes_supported: MCP_OAUTH_SCOPES,
	authorization_response_iss_parameter_supported: true,
});

const parseRedirect = (value: string): URL | undefined => {
	// URL.hash misses empty fragments, which RFC 6749 `3.1.2 also forbids.
	if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined;
	try {
		const url = new URL(value);
		const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname));
		return allowed && url.username === "" && url.password === "" ? url : undefined;
	} catch {
		return undefined;
	}
};

/** Loopback redirects ignore port (RFC 8252 `7.3); HTTPS redirects match exactly. */
export const redirectMatches = (registered: string, presented: string): boolean => {
	const left = parseRedirect(registered);
	const right = parseRedirect(presented);
	if (left === undefined || right === undefined) return false;
	if (left.protocol === "https:" || right.protocol === "https:") return left.href === right.href;
	return left.hostname === right.hostname && left.pathname === right.pathname && left.search === right.search;
};

const sameResource = (urls: McpOAuthUrls, presented: string | undefined): boolean => {
	if (presented === undefined) return true;
	try {
		const url = new URL(presented);
		return url.hash === "" && `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource;
	} catch {
		return false;
	}
};

export interface McpOAuthClient {
	readonly clientId: string;
	readonly name: string;
	readonly redirectUris: readonly string[];
	readonly peerLink: boolean;
}

/** The authorization request's fields, as the contract's `AuthMcpAuthorizationRequest` with `state` revealed. */
export interface AuthorizationParams {
	readonly response_type?: string;
	readonly client_id?: string;
	readonly redirect_uri?: string;
	readonly code_challenge?: string;
	readonly code_challenge_method?: string;
	readonly state?: string;
	readonly resource?: string;
}

export interface AuthorizationRequest {
	readonly client: McpOAuthClient;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly state: string | undefined;
	readonly resource: string;
	readonly issuer: string;
}

/** A problem shown on the page: the client or its redirect is not verified, so nothing is sent back to it. */
export class McpOAuthPageError extends Error {}
/** A problem sent back to the (verified) client through its redirect URI. */
export class McpOAuthRedirectError extends Error {
	readonly error: "invalid_request" | "unsupported_response_type" | "invalid_target";
	readonly description: string;
	readonly redirectUri: string;
	readonly state: string | undefined;
	constructor(error: McpOAuthRedirectError["error"], description: string, redirectUri: string, state: string | undefined) {
		super(description);
		this.error = error;
		this.description = description;
		this.redirectUri = redirectUri;
		this.state = state;
	}
}
export class McpRegistrationRefusal extends Error {
	readonly error: "invalid_client_metadata" | "invalid_redirect_uri";
	readonly description: string;
	constructor(error: McpRegistrationRefusal["error"], description: string) {
		super(description);
		this.error = error;
		this.description = description;
	}
}
export class McpTokenRefusal extends Error {
	readonly error: "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type";
	readonly description: string;
	constructor(error: McpTokenRefusal["error"], description: string) {
		super(description);
		this.error = error;
		this.description = description;
	}
}

/** T3's messages for a refused approval code (`ServerAuthMcpApprovalCodeError`). */
const APPROVAL_CODE_MESSAGES: Record<McpApprovalCodeRefusal, string> = {
	insufficient_scope: "That pairing code cannot grant this access. It has not been used, so choose an access level it grants, or create a code with the standard scopes.",
	not_a_pairing_code: "That is not a one-time pairing code.",
	unknown_or_used: "That pairing code is unknown, expired, or already used.",
};

export type ApprovalDecision =
	| { readonly _tag: "pairing-code"; readonly access: AuthMcpClientAccess; readonly code: string }
	| { readonly _tag: "browser-session"; readonly access: AuthMcpClientAccess; readonly csrfToken: string };

interface PendingCode {
	readonly clientId: string;
	readonly clientName: string;
	readonly peerLink: boolean;
	readonly redirectUri: string;
	readonly codeChallenge: string;
	readonly resource: string;
	readonly access: AuthMcpClientAccess;
	readonly expiresAtMs: number;
}

const base64Url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

const redirectWith = (redirectUri: string, params: Record<string, string | undefined>) => {
	const url = new URL(redirectUri);
	for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
	return url.toString();
};

export const redirectForError = (error: McpOAuthRedirectError, issuer: string) =>
	redirectWith(error.redirectUri, { error: error.error, error_description: error.description, state: error.state, iss: issuer });

export class McpOAuth {
	readonly #auth: AuthStore;
	readonly #linksEnabled: () => boolean;
	readonly #codes = new Map<string, PendingCode>();
	readonly #now: () => number;

	constructor(auth: AuthStore, options: { linksEnabled: () => boolean; now?: () => number }) {
		this.#auth = auth;
		this.#linksEnabled = options.linksEnabled;
		this.#now = options.now ?? Date.now;
	}

	#sign(domain: string, payload: string): string {
		return this.#auth.signPayload(`${domain}.${payload}`);
	}

	#verify(domain: string, payload: string, signature: string): boolean {
		return this.#auth.verifySignature(`${domain}.${payload}`, signature);
	}

	#parseClientId(clientId: string): McpOAuthClient | undefined {
		const [body, signature, extra] = clientId.split(".");
		if (!body || !signature || extra !== undefined) return undefined;
		if (!this.#verify("mcp-client-id", body, signature)) return undefined;
		try {
			const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { v?: unknown; n?: unknown; r?: unknown; p?: unknown };
			if (payload.v !== 1 || typeof payload.n !== "string" || !Array.isArray(payload.r) || !payload.r.every((uri) => typeof uri === "string")) return undefined;
			if (payload.p !== undefined && payload.p !== 1) return undefined;
			return { clientId, name: payload.n, redirectUris: payload.r as string[], peerLink: payload.p === 1 };
		} catch {
			return undefined;
		}
	}

	#csrfToken(sessionId: string, authorization: AuthorizationRequest): string {
		return this.#sign("mcp-csrf", JSON.stringify([sessionId, authorization.client.clientId, authorization.redirectUri, authorization.codeChallenge]));
	}

	register(metadata: { client_name?: string; software_id?: string; redirect_uris?: readonly string[] }): McpOAuthClient {
		const rawName = metadata.client_name?.trim() ?? "";
		const name = (rawName.length > 0 ? rawName : DEFAULT_CLIENT_NAME).slice(0, MAX_CLIENT_NAME_LENGTH);
		const redirectUris = metadata.redirect_uris ?? [];
		if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
			throw new McpRegistrationRefusal("invalid_redirect_uri", `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`);
		}
		if (!redirectUris.every((uri) => parseRedirect(uri) !== undefined)) {
			throw new McpRegistrationRefusal("invalid_redirect_uri", "Redirect URIs must be https, or http on localhost, 127.0.0.1 or [::1].");
		}
		// RFC 7591 allows ignoring unsupported registration options; all clients use public PKCE.
		const peerLink = metadata.software_id === MCP_PEER_LINK_SOFTWARE_ID;
		if (peerLink && !this.#linksEnabled()) {
			throw new McpRegistrationRefusal("invalid_client_metadata", "Linked environments is off on that machine. Turn it on in its Settings → Labs.");
		}
		const body = base64Url(JSON.stringify({ v: 1, n: name, r: redirectUris, ...(peerLink ? { p: 1 } : {}) }));
		return { clientId: `${body}.${this.#sign("mcp-client-id", body)}`, name, redirectUris: [...redirectUris], peerLink };
	}

	/** Throws `McpOAuthPageError` (show it; never redirect) or `McpOAuthRedirectError` (send it back to the client). */
	validateAuthorization(urls: McpOAuthUrls, request: AuthorizationParams): AuthorizationRequest {
		const client = this.#parseClientId(request.client_id ?? "");
		if (client === undefined) throw new McpOAuthPageError("This sign-in link names an unknown app. Start the sign-in again from it.");
		const redirectUri = request.redirect_uri;
		if (redirectUri === undefined || !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
			throw new McpOAuthPageError("This sign-in link sends you to an address the app did not register.");
		}
		const state = request.state;
		const fail = (error: McpOAuthRedirectError["error"], description: string) => new McpOAuthRedirectError(error, description, redirectUri, state);
		if (request.response_type !== "code") throw fail("unsupported_response_type", "Only response_type=code is supported.");
		const codeChallenge = request.code_challenge;
		if (request.code_challenge_method !== "S256" || codeChallenge === undefined || !CODE_CHALLENGE_PATTERN.test(codeChallenge)) {
			throw fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
		}
		if (!sameResource(urls, request.resource)) throw fail("invalid_target", `This server only issues tokens for ${urls.resource}.`);
		return { client, redirectUri, codeChallenge, state, resource: urls.resource, issuer: urls.issuer };
	}

	/** One-click approval for a signed-in client (T3's `approvingSession`; until 0.1.9 the browser cookie's session
	 * only): its CSRF token and scopes, if its session may approve at all (approving manages access, and a session may
	 * only hand out scopes it holds). */
	approvingSession(session: StoredToken | undefined, authorization: AuthorizationRequest): { csrfToken: string; scopes: readonly string[] } | undefined {
		if (session === undefined) return undefined;
		if (!session.scopes.includes(AuthAccessWriteScope) || !session.scopes.includes(AuthOrchestrationReadScope)) return undefined;
		return { csrfToken: this.#csrfToken(session.id, authorization), scopes: session.scopes };
	}

	/** The redirect that carries a fresh code. Throws `McpOAuthPageError` with the message to show. */
	approve(input: { session: StoredToken | undefined; authorization: AuthorizationRequest; decision: ApprovalDecision }): string {
		const { decision, authorization } = input;
		if (decision._tag === "pairing-code") {
			const refused = this.#auth.consumeMcpApprovalCode(decision.code, decision.access);
			if (refused !== undefined) throw new McpOAuthPageError(APPROVAL_CODE_MESSAGES[refused]);
		} else {
			const session = this.approvingSession(input.session, authorization);
			const expected = session === undefined ? undefined : Buffer.from(session.csrfToken);
			const given = Buffer.from(decision.csrfToken);
			if (
				session === undefined ||
				expected === undefined ||
				expected.length !== given.length ||
				!timingSafe(expected, given) ||
				!mcpClientScopes(decision.access).every((scope) => session.scopes.includes(scope))
			) {
				throw new McpOAuthPageError("Your session cannot approve this request. Enter a pairing code instead.");
			}
		}
		const now = this.#now();
		const code = randomBytes(32).toString("base64url");
		for (const [key, pending] of this.#codes) if (pending.expiresAtMs <= now) this.#codes.delete(key);
		this.#codes.set(code, {
			clientId: authorization.client.clientId,
			clientName: authorization.client.name,
			peerLink: authorization.client.peerLink,
			redirectUri: authorization.redirectUri,
			codeChallenge: authorization.codeChallenge,
			resource: authorization.resource,
			access: decision.access,
			expiresAtMs: now + AUTHORIZATION_CODE_TTL_MS,
		});
		return redirectWith(authorization.redirectUri, { code, state: authorization.state, iss: authorization.issuer });
	}

	deny(authorization: AuthorizationRequest): string {
		return redirectWith(authorization.redirectUri, { error: "access_denied", state: authorization.state, iss: authorization.issuer });
	}

	/** The token for a code. Throws `McpTokenRefusal`. */
	exchangeCode(input: {
		urls: McpOAuthUrls;
		client: ClientMetadata;
		token: { grant_type?: string; code?: string; redirect_uri?: string; client_id?: string; code_verifier?: string; resource?: string };
	}): AuthMcpTokenResult & { readonly session: StoredToken } {
		const { token, urls } = input;
		if (token.grant_type !== "authorization_code") throw new McpTokenRefusal("unsupported_grant_type", "Only authorization_code is supported.");
		const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier } = token;
		if (!code || !redirectUri || !clientId || !verifier) throw new McpTokenRefusal("invalid_request", "code, redirect_uri, client_id and code_verifier are required.");
		if (this.#parseClientId(clientId) === undefined) throw new McpTokenRefusal("invalid_client", "The client is unknown.");
		// A presented code is spent even when a later check fails (RFC 6749 `4.1.2).
		const pending = this.#codes.get(code);
		this.#codes.delete(code);
		const now = this.#now();
		if (
			pending === undefined ||
			pending.expiresAtMs <= now ||
			pending.clientId !== clientId ||
			pending.redirectUri !== redirectUri ||
			pending.resource !== urls.resource ||
			!sameResource(urls, token.resource) ||
			!pkceVerifies(verifier, pending.codeChallenge)
		) {
			throw new McpTokenRefusal("invalid_grant", "The authorization code is invalid or expired.");
		}
		const issued = this.#auth.issueMcpClientSession({ label: pending.clientName, access: pending.access, peerLink: pending.peerLink, client: input.client });
		return {
			access_token: issued.token,
			token_type: "Bearer",
			expires_in: Math.max(0, Math.floor((issued.session.expiresAt - now) / 1000)),
			scope: encodeOAuthScope(mcpClientScopes(pending.access)),
			session: issued.session,
		};
	}
}

function pkceVerifies(verifier: string, challenge: string): boolean {
	if (!CODE_VERIFIER_PATTERN.test(verifier)) return false;
	const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
	const given = Buffer.from(challenge);
	return expected.length === given.length && timingSafe(expected, given);
}

function timingSafe(left: Buffer, right: Buffer): boolean {
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
	return difference === 0;
}
