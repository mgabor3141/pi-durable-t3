// T3 0.1.11's limits on MCP OAuth (`McpOAuth`): up to ten redirect URIs, with the client id they make capped past the
// first five so the authorize URL fits Node's header limit; a `resource` with a fragment, even an empty one, is not
// this server's; and a peer link's session is extended when it is used (`EnvironmentAuth.renewPeerLinkSession`).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
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

it("extends a peer link's session to a full term when a use finds it a day short, and no other client's", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-durable-t3-peer-link-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00Z") });
	onTestFinished(() => void vi.useRealTimers());
	const store = new AuthStore(dir, { tokenTtlSeconds: 3600 });
	const day = 86_400_000;
	const issue = (peerLink: boolean) => store.issueMcpClientSession({ label: peerLink ? "link" : "agent", access: "read-only", peerLink, client: {} });
	const link = issue(true);
	const agent = issue(false);
	const issuedUntil = link.session.expiresAt;
	expect(issuedUntil).toBe(Date.now() + 30 * day);
	const upserted: string[] = [];
	store.onAccessChange((change) => void (change.type === "clientUpserted" && upserted.push(change.session.id)));
	// Less than a day short: left as it is, and nothing is written.
	vi.advanceTimersByTime(day - 1000);
	expect(store.verifyMcpClient(`Bearer ${link.token}`)?.expiresAt).toBe(issuedUntil);
	expect(upserted).toEqual([]);
	// A day short: back out to thirty days from now, kept, and shown to the device list.
	vi.advanceTimersByTime(2000);
	expect(store.verifyMcpClient(`Bearer ${link.token}`)?.expiresAt).toBe(Date.now() + 30 * day);
	expect(new AuthStore(dir, { tokenTtlSeconds: 3600 }).listClientSessions().find((session) => session.id === link.session.id)?.expiresAt).toBe(Date.now() + 30 * day);
	expect(upserted).toEqual([link.session.id]);
	// Any other MCP client's session keeps its term.
	expect(store.verifyMcpClient(`Bearer ${agent.token}`)?.expiresAt).toBe(agent.session.expiresAt);
});
