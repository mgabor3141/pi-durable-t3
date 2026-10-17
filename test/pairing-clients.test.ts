// T3's Settings → Connections, server side, end to end over a real host: mint a pairing link, exchange it for a
// client session, list the devices, revoke them, and watch the `subscribeAuthAccess` stream. Every response is
// checked against the contract's schema (the web app's HttpApi client decodes the same bytes). One flow per host.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthAccessReadScope, AuthAccessWriteScope, AuthClientSession, AuthPairingCredentialResult, AuthPairingLink, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, expect, it } from "vitest";
import { connectWs, getJson, pair, postJson, waitListening, type WsRpc } from "./ws-rpc.ts";
import { launch, pairCode, t3Dir, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-conn-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

async function start(name: string, port: number) {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [] }), "utf8");
	const host = launch(root, port, {}, agentDir);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind ${port}: ${host.out()}`);
	const token = await pair(port, pairCode(root));
	return { host, token };
}

/** POST a form body (the pairing exchange), with the client's own label/device fields. */
async function formPost(port: number, path: string, form: Record<string, string>) {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(8000),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const mint = (port: number, token: string, body: unknown) => postJson(port, "/api/auth/pairing-token", body, auth(token));
const listLinks = (port: number, token: string) => getJson(port, "/api/auth/pairing-links", auth(token));
const listClients = (port: number, token: string) => getJson(port, "/api/auth/clients", auth(token));
const revokeLink = (port: number, token: string, id: string) => postJson(port, "/api/auth/pairing-links/revoke", { id }, auth(token));
const revokeClient = (port: number, token: string, sessionId: string) => postJson(port, "/api/auth/clients/revoke", { sessionId }, auth(token));
const revokeOthers = (port: number, token: string) => postJson(port, "/api/auth/clients/revoke-others", {}, auth(token));
const asArray = (body: Record<string, unknown>) => (Array.isArray(body) ? body : (body["value"] ?? body));
/** The wire bytes decode against the contract (the web app's HttpApi client accepts the same bytes). `Schema.is` checks
 * the decoded form; the wire is the JSON codec (ISO strings, etc.), so decode with the JSON codec. */
// biome-ignore lint/suspicious/noExplicitAny: a schema of any shape, fed to the JSON codec
const decodes = (schema: any, body: unknown): boolean => {
	try {
		Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never)(body);
		return true;
	} catch {
		return false;
	}
};
type AccessEvent = { type: string; revision: number; payload: Record<string, unknown> };
/** Stream events ride in `Chunk.values` (the RPC server's flow-controlled array frame). */
const accessEvents = (ws: WsRpc, requestId: number): AccessEvent[] => ws.chunks(requestId).flatMap((frame) => (frame.values ?? []) as AccessEvent[]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, deadline: number, poll: () => Promise<boolean>): Promise<void> {
	while (Date.now() < deadline) {
		if (await poll()) return;
		await sleep(150);
	}
	throw new Error(`timed out: ${what}`);
}
const sessionIdOf = (client: Record<string, unknown>) => String(client["sessionId"]);

it("Connections over HTTP: mint a link, exchange it, list devices, scope-gate the mint", async () => {
	const { host, token } = await start("conn-http", 4940);
	const port = 4940;
	try {
		// An unpaired caller is refused, and a paired one starts with no live links (the `pair` code was single-use).
		expect((await getJson(port, "/api/auth/pairing-links")).status).toBe(401);
		expect((await listLinks(port, token)).status).toBe(200);
		expect(asArray((await listLinks(port, token)).body)).toHaveLength(0);

		// Mint a labelled link.
		const minted = await mint(port, token, { label: "phone" });
		expect(minted.status).toBe(200);
		expect(decodes(AuthPairingCredentialResult, minted.body)).toBe(true);
		const credential = String(minted.body["credential"]);
		expect(credential.length).toBeGreaterThan(0);
		expect(minted.body["label"]).toBe("phone");

		// It shows in the list, scoped as T3 scopes a standard grant, decodable as the contract's link.
		const links = asArray((await listLinks(port, token)).body) as Record<string, unknown>[];
		expect(links).toHaveLength(1);
		expect(decodes(Schema.Array(AuthPairingLink), links)).toBe(true);
		expect(links[0]!["permissions"]).toContain(AuthAccessWriteScope);

		// Scope-gating mirrors T3: a link cannot out-grant the caller, and a grant must be non-empty and a set.
		expect((await mint(port, token, { scopes: ["review:write"] })).status).toBe(403); // a scope the caller lacks
		expect((await mint(port, token, { scopes: [] })).status).toBe(400); // empty grant
		expect((await mint(port, token, { scopes: [AuthOrchestrationReadScope, AuthOrchestrationReadScope] })).status).toBe(400); // a scope twice
		// A subset of the caller's scopes is a valid, narrower link.
		const narrow = await mint(port, token, { scopes: [AuthAccessReadScope] });
		expect(narrow.status).toBe(200);

		// Exchange the labelled link for a client session, presenting the device.
		const exchanged = await formPost(port, "/oauth/token", {
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: credential,
			subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
			client_label: "Device X",
			client_device_type: "mobile",
		});
		expect(exchanged.status).toBe(200);
		const tokenB = String(exchanged.body["access_token"]);
		expect(tokenB.length).toBeGreaterThan(0);

		// The device list (as caller A): both sessions, the exchange's device shape, the LINK's label winning the
		// request's guess, and `current` marking the caller.
		const clients = asArray((await listClients(port, token)).body) as Record<string, unknown>[];
		expect(decodes(Schema.Array(AuthClientSession), clients)).toBe(true);
		expect(clients).toHaveLength(2);
		const b = clients.find((c) => (c["client"] as Record<string, unknown>)["deviceType"] === "mobile")!;
		expect(b).toBeDefined();
		expect((b["client"] as Record<string, unknown>)["label"]).toBe("phone"); // the link's label wins over "Device X"
		expect(b["current"]).toBe(false);
		expect(clients.find((c) => c["current"] === true)).toBeDefined(); // A is current
		expect(clients.find((c) => c["current"] === true)!["subject"]).toBe("one-time-token");

		// The minted link that was exchanged is spent: it is gone from the list; the narrow link (unspent) remains.
		const afterExchange = asArray((await listLinks(port, token)).body) as Record<string, unknown>[];
		expect(afterExchange).toHaveLength(1);
		expect(afterExchange[0]!["permissions"]).not.toContain(AuthAccessWriteScope); // the narrow (access:read only) link

		// Revoke the device: it is removed, and its bearer token stops authenticating.
		const revoked = await revokeClient(port, token, sessionIdOf(b));
		expect(revoked.status).toBe(200);
		expect(revoked.body["revoked"]).toBe(true);
		expect(asArray((await listClients(port, token)).body)).toHaveLength(1);
		expect((await getJson(port, "/api/auth/session", auth(tokenB))).body["authenticated"]).toBe(false);

		// A client cannot revoke the session it is calling with.
		const sessionA = sessionIdOf((asArray((await listClients(port, token)).body) as Record<string, unknown>[]).find((c) => c["current"] === true)!);
		const selfRevoke = await revokeClient(port, token, sessionA);
		expect(selfRevoke.status).toBe(403);
		expect(selfRevoke.body["reason"]).toBe("current_session_revoke_not_allowed");

		// Revoke a minted link before it is spent: it disappears, and its credential is dead.
		const linkId = String(afterExchange[0]!["id"]);
		expect((await revokeLink(port, token, linkId)).body["revoked"]).toBe(true);
		expect(asArray((await listLinks(port, token)).body)).toHaveLength(0);
		const deadExchange = await formPost(port, "/oauth/token", { subject_token: String(narrow.body["credential"]) });
		expect(deadExchange.status).toBe(401);

		// "Revoke others": two more devices, then sweep every session except the caller. The caller survives; they die.
		const peerB = String((await formPost(port, "/oauth/token", { subject_token: (await mint(port, token, { label: "b" })).body["credential"] as string })).body["access_token"]);
		const peerC = String((await formPost(port, "/oauth/token", { subject_token: (await mint(port, token, { label: "c" })).body["credential"] as string })).body["access_token"]);
		expect((await listClients(port, token)).body && asArray((await listClients(port, token)).body)).toHaveLength(3); // A, b, c
		const swept = await revokeOthers(port, token);
		expect(swept.status).toBe(200);
		expect(swept.body["revokedCount"]).toBe(2);
		expect(asArray((await listClients(port, token)).body)).toHaveLength(1); // only A remains, and it is current
		expect((asArray((await listClients(port, token)).body) as Record<string, unknown>[])[0]!["current"]).toBe(true);
		expect((await getJson(port, "/api/auth/session", auth(token))).body["authenticated"]).toBe(true); // A survives
		expect((await getJson(port, "/api/auth/session", auth(peerB))).body["authenticated"]).toBe(false);
		expect((await getJson(port, "/api/auth/session", auth(peerC))).body["authenticated"]).toBe(false);
	} finally {
		host.child.kill("SIGKILL");
	}
}, 30000);

it("subscribeAuthAccess: snapshot first, then live mint / revoke events", async () => {
	const { host, token } = await start("conn-stream", 4941);
	const port = 4941;
	let ws: WsRpc | undefined;
	try {
		ws = await connectWs(port, token);
		const streamId = await ws.open("subscribeAuthAccess", {});
		// The opening event is a snapshot carrying both lists (the reducer seeds from it).
		await until("snapshot event", Date.now() + 8000, async () => accessEvents(ws!, streamId).some((e) => e.type === "snapshot"));
		const snapshot = accessEvents(ws, streamId).find((e) => e.type === "snapshot")!;
		expect(snapshot.revision).toBe(1);
		const snapPayload = snapshot.payload as { pairingLinks: unknown[]; clientSessions: Record<string, unknown>[] };
		expect(snapPayload.clientSessions).toHaveLength(1); // caller A, from the initial pair
		expect(snapPayload.clientSessions[0]!["current"]).toBe(true);

		// Minting from the caller pushes a `pairingLinkUpserted` at the next revision.
		await mint(port, token, { label: "watched-link" });
		await until("pairingLinkUpserted", Date.now() + 8000, async () => accessEvents(ws!, streamId).some((e) => e.type === "pairingLinkUpserted"));
		const upsert = accessEvents(ws, streamId).find((e) => e.type === "pairingLinkUpserted")!;
		expect((upsert.payload as Record<string, unknown>)["label"]).toBe("watched-link");
		expect(upsert.revision).toBeGreaterThan(1);

		// A second client pairing pushes a `clientUpserted`, not `current` for A.
		const exchanged = await formPost(port, "/oauth/token", { subject_token: (await mint(port, token, { label: "peer" })).body["credential"] as string, client_device_type: "bot" });
		const tokenC = String(exchanged.body["access_token"]);
		void tokenC;
		await until("clientUpserted (peer)", Date.now() + 8000, async () => accessEvents(ws!, streamId).some((e) => e.type === "clientUpserted" && (e.payload as Record<string, unknown>)["current"] === false));

		// Revoking the peer pushes a `clientRemoved` keyed by its session id.
		const peers = (asArray((await listClients(port, token)).body) as Record<string, unknown>[]).filter((c) => c["current"] !== true);
		const peerId = sessionIdOf(peers[0]!);
		await revokeClient(port, token, peerId);
		await until("clientRemoved (peer)", Date.now() + 8000, async () => accessEvents(ws!, streamId).some((e) => e.type === "clientRemoved" && (e.payload as Record<string, unknown>)["sessionId"] === peerId));
	} finally {
		ws?.close();
		host.child.kill("SIGKILL");
	}
}, 30000);

it("revoking a client cuts its live WebSocket", async () => {
	const { host, token } = await start("conn-cutws", 4942);
	const port = 4942;
	// A second device, with its own live socket.
	const link = await mint(port, token, { label: "victim" });
	const exchanged = await formPost(port, "/oauth/token", { subject_token: link.body["credential"] as string, client_device_type: "desktop" });
	const tokenB = String(exchanged.body["access_token"]);
	const wsB = await connectWs(port, tokenB);
	const peer = (asArray((await listClients(port, token)).body) as Record<string, unknown>[]).find((c) => c["current"] !== true)!;
	const peerId = sessionIdOf(peer);
	expect(peer["connected"]).toBe(true);
	const revoked = await revokeClient(port, token, peerId);
	expect(revoked.body["revoked"]).toBe(true);
	await until("the revoked client's session is gone from the list", Date.now() + 8000, async () =>
		!((asArray((await listClients(port, token)).body) as Record<string, unknown>[]).some((c) => sessionIdOf(c) === peerId)));
	// The bearer is dead immediately, and the live WebSocket is reaped by the token-activity check (a 2 s poll window).
	await until("the revoked client's live WebSocket closes", Date.now() + 8000, async () => wsB.isClosed());
	expect((await getJson(port, "/api/auth/session", auth(tokenB))).body["authenticated"]).toBe(false);
	host.child.kill("SIGKILL");
}, 30000);
