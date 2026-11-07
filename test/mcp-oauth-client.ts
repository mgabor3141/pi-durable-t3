// An MCP client's OAuth sign-in to a host's `/mcp`, over plain HTTP as a real client does it: discovery from the 401
// challenge, dynamic registration, the authorize redirect into `/connect-agent`, the page's decision with a pairing
// code at an access level, and the PKCE code exchange.
import { createHash, randomBytes } from "node:crypto";

export interface SignedIn {
	readonly token: string;
	readonly scope: string;
	readonly clientId: string;
}

export const REDIRECT_URI = "http://127.0.0.1:9/callback";

export async function signInMcpClient(origin: string, options: { code: string; access: string; name?: string }): Promise<SignedIn> {
	const challenge = (await fetch(`${origin}/mcp`, { method: "POST" })).headers.get("www-authenticate") ?? "";
	const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
	if (metadataUrl === undefined) throw new Error(`no resource_metadata in ${challenge}`);
	const resource = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
	const server = (await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as {
		authorization_endpoint: string;
		token_endpoint: string;
		registration_endpoint: string;
	};
	const registered = (await (
		await fetch(server.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: options.name ?? "test agent", redirect_uris: [REDIRECT_URI] }) })
	).json()) as { client_id: string };
	const verifier = randomBytes(32).toString("base64url");
	const authorization = {
		response_type: "code",
		client_id: registered.client_id,
		redirect_uri: REDIRECT_URI,
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		state: "state-1",
		resource: resource.resource,
	};
	const authorize = await fetch(`${server.authorization_endpoint}?${new URLSearchParams(authorization)}`, { redirect: "manual" });
	if (!authorize.headers.get("location")?.startsWith("/connect-agent?")) throw new Error(`authorize went to ${authorize.headers.get("location")}`);
	const decided = (await (
		await fetch(`${origin}/oauth/mcp/decision`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ authorization, decision: { _tag: "pairing-code", access: options.access, code: options.code } }),
		})
	).json()) as { redirectTo?: string; message?: string };
	if (decided.redirectTo === undefined) throw new Error(`decision refused: ${decided.message}`);
	const back = new URL(decided.redirectTo);
	const code = back.searchParams.get("code");
	if (code === null) throw new Error(`no code in ${decided.redirectTo}`);
	const exchanged = (await (
		await fetch(server.token_endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: registered.client_id, code_verifier: verifier, resource: resource.resource }),
		})
	).json()) as { access_token: string; scope: string };
	return { token: exchanged.access_token, scope: exchanged.scope, clientId: registered.client_id };
}
