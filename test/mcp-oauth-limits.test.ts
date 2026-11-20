// T3 0.1.11's limits on MCP OAuth (`McpOAuth`): up to ten redirect URIs, with the client id they make capped past the
// first five so the authorize URL fits Node's header limit; and a `resource` with a fragment, even an empty one, is
// not this server's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { AuthStore } from "../src/t3/auth.ts";
import { McpOAuth, urlsFor } from "../src/t3/mcp-oauth.ts";

const oauth = () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-durable-t3-mcp-oauth-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	return new McpOAuth(new AuthStore(dir, { tokenTtlSeconds: 3600 }), { linksEnabled: () => false });
};
const uris = (count: number, length = 30, char = "c") => Array.from({ length: count }, (_, index) => `http://127.0.0.1:${4000 + index}/${char.repeat(length)}`);

it("registers up to ten redirect URIs, and refuses more, or a client id too long for the authorize URL", () => {
	const server = oauth();
	expect(server.register({ redirect_uris: uris(10) }).redirectUris).toHaveLength(10);
	expect(() => server.register({ redirect_uris: uris(11) })).toThrow("Register between 1 and 10 redirect URIs.");
	// A URI is at most 512 characters, so only wide ones (three UTF-8 bytes a character) make the id that long.
	expect(server.register({ redirect_uris: uris(5, 480, "€") }).redirectUris).toHaveLength(5);
	expect(() => server.register({ redirect_uris: uris(6, 480, "€") })).toThrow("Redirect URIs are too long to fit in an authorization request.");
});

it("refuses a resource with a fragment, an empty one included", () => {
	const server = oauth();
	const urls = urlsFor("http://127.0.0.1:5299");
	const { clientId } = server.register({ redirect_uris: ["http://127.0.0.1:4000/cb"] });
	const request = (resource: string) => () =>
		server.validateAuthorization(urls, { response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:4000/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s", resource });
	expect(request(urls.resource)).not.toThrow();
	expect(request(`${urls.resource}#`)).toThrow(`This server only issues tokens for ${urls.resource}.`);
});
