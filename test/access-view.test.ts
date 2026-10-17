// The Connections view layer (`src/t3/access.ts`): the store's rows projected onto T3's wire shapes, ordered as T3
// orders them, with `connected` and `current` computed. Pure — an in-memory store in a temp dir, no host, no network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthAccessReadScope, AuthAccessWriteScope, AuthClientSession, AuthOrchestrationReadScope, AuthPairingLink, AuthStandardClientScopes } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vitest";
import { accessSnapshot, bySessionPriority, listClientSessions, listPairingLinks, toClientSession } from "../src/t3/access.ts";
import { AuthStore, type IssuedSession } from "../src/t3/auth.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-t3-access-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const newStore = () => new AuthStore(mkdtempSync(join(dir, "store-")), { tokenTtlSeconds: 3600 });

/** Exchange a minted code that must succeed, throwing on a refusal (the tests mint a matching grant, so a refusal is a bug). */
function exchangeOk(auth: AuthStore, code: string, presented = {}, scopes?: string[]): IssuedSession {
	const result = auth.exchange(code, presented, scopes);
	if ("refused" in result) throw new Error(`exchange refused: ${result.refused}`);
	return result.session;
}

describe("pairing link projection", () => {
	it("is T3's `AuthPairingLink`: legacy scopes + full permissions, ISO timestamps, newest first", async () => {
		const auth = newStore();
		const minted = auth.createPairingLink({ scopes: [...AuthStandardClientScopes], label: "phone" });
		// A minted-pairing-link timestamp is millisecond-resolution; separate the two so "newest first" is deterministic.
		await new Promise((resolve) => setTimeout(resolve, 2));
		const later = auth.createPairingLink({ scopes: [AuthOrchestrationReadScope] });
		const links = listPairingLinks(auth);
		expect(links).toHaveLength(2);
		// newest first (T3's list order)
		expect(links[0]!.id).toBe(later.id);
		const withLabel = links.find((l) => l.id === minted.id)!;
		expect(withLabel.label).toBe("phone");
		expect(withLabel.subject).toBe("one-time-token");
		// authScopeResponse: the frozen legacy subset in `scopes`, the full grant in `permissions` (the UI reads it).
		expect(withLabel.permissions).toContain(AuthAccessWriteScope);
		expect(withLabel.scopes).not.toContain("filesystem:write"); // a non-legacy scope is absent from the legacy list
		expect(withLabel.scopes).toContain(AuthAccessReadScope);
		// Encodes against the contract (so the HttpApi client accepts it).
		expect(Schema.is(Schema.Array(AuthPairingLink))(links)).toBe(true);
	});

	it("revokes a minted link before it is spent", () => {
		const auth = newStore();
		const minted = auth.createPairingLink({ scopes: [...AuthStandardClientScopes] });
		expect(listPairingLinks(auth)).toHaveLength(1);
		expect(auth.revokePairingLink(minted.id)).toBe(true);
		expect(listPairingLinks(auth)).toHaveLength(0);
		// The credential is dead: the exchange refuses it.
		const after = auth.exchange(minted.credential, {});
		expect("refused" in after && after.refused === "invalid-credential").toBe(true);
	});
});

describe("client session projection", () => {
	it("maps the store row to T3's `AuthClientSession` (metadata, ISO times, null lastConnectedAt)", () => {
		const auth = newStore();
		const minted = auth.createPairingLink({ scopes: [...AuthStandardClientScopes], label: "laptop" });
		const exchanged = auth.exchange(minted.credential, { deviceType: "desktop", ipAddress: "10.0.0.5", userAgent: "UA", os: "Linux" });
		expect("session" in exchanged).toBe(true);
		if (!("session" in exchanged)) return;
		const session = exchanged.session.session;
		const wire = toClientSession(session, true, true);
		expect(wire.sessionId).toBe(session.id);
		expect(wire.method).toBe("bearer-access-token");
		expect(wire.client.deviceType).toBe("desktop");
		expect(wire.client.label).toBe("laptop"); // the link's label wins over the request's guess
		expect(wire.client.ipAddress).toBe("10.0.0.5");
		expect(wire.connected).toBe(true);
		expect(wire.current).toBe(true);
		expect(wire.lastConnectedAt).toBe(null);
		expect(Schema.is(AuthClientSession)(wire)).toBe(true);
	});

	it("orders by T3's priority: managers first, then connected, then newest issued", () => {
		const auth = newStore();
		// A manager (standard scopes) that is NOT connected, minted first.
		const manager = exchangeOk(auth, auth.createPairingLink({ scopes: [...AuthStandardClientScopes] }).credential);
		// A non-manager (read-only grant), minted later, and connected.
		const readOnlyLink = auth.createPairingLink({ scopes: [AuthOrchestrationReadScope, AuthAccessReadScope] });
		const readOnly = exchangeOk(auth, readOnlyLink.credential, {}, [AuthOrchestrationReadScope, AuthAccessReadScope]);
		auth.markConnected(readOnly.session.hash);

		const sessions = listClientSessions(auth, manager.session.id);
		expect(sessions.map((s) => s.sessionId)).toEqual([manager.session.id, readOnly.session.id]);
		// Manager outranks the connected read-only client, despite the read-only one being newer and connected.
		expect(sessions[0]!.scopes).toContain(AuthAccessWriteScope);
		expect(sessions[1]!.connected).toBe(true);
		expect(sessions[1]!.scopes).not.toContain(AuthAccessWriteScope);
		expect(sessions[0]!.current).toBe(true);
		expect(sessions[1]!.current).toBe(false);
	});

	it("bySessionPriority: connected outranks a newer disconnected peer of equal rank", () => {
		const a = { scopes: [AuthAccessWriteScope], connected: true, issuedAt: new Date(1000).toISOString() } as never;
		const b = { scopes: [AuthAccessWriteScope], connected: false, issuedAt: new Date(9000).toISOString() } as never;
		expect(bySessionPriority(a, b)).toBeLessThan(0);
	});
});

describe("access snapshot", () => {
	it("carries both lists for the subscribeAuthAccess snapshot", () => {
		const auth = newStore();
		auth.createPairingLink({ scopes: [...AuthStandardClientScopes] });
		const session = exchangeOk(auth, auth.createPairingLink({ scopes: [...AuthStandardClientScopes] }).credential, { deviceType: "mobile" });
		const snapshot = accessSnapshot(auth, session.session.id);
		expect(snapshot.pairingLinks.length).toBe(1); // the second link was spent by the exchange; one minted link remains
		expect(snapshot.clientSessions.map((s) => s.sessionId)).toEqual([session.session.id]);
		expect(snapshot.clientSessions[0]!.current).toBe(true);
	});
});

