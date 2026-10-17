// The Connections view layer: this host's pairing links and client sessions, projected onto T3's wire shapes
// (`./auth.ts` rows → `AuthPairingLink` / `AuthClientSession` / the `subscribeAuthAccess` stream), with the scoping,
// ordering, `connected` and `current` T3's Connections settings reads. Behaviour checked against the pinned T3
// (`apps/server/src/auth/{EnvironmentAuth,SessionStore}.ts` and `ws.ts`), not guessed.
//
// `authScopeResponse` is T3's own projection of a grant: the frozen legacy `scopes` (the vocabulary old clients
// decode) plus the full `permissions` list the UI gates actions on. The client reads `permissions ?? scopes`.
import {
	AuthAccessWriteScope,
	authScopeResponse,
	type AuthAccessSnapshot,
	type AuthAccessStreamEvent,
	type AuthClientSession,
	type AuthPairingLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { type AccessChange, type AuthStore, type StoredPairing, type StoredToken } from "./auth.ts";

// biome-ignore lint/suspicious/noExplicitAny: wire values carry branded ids (AuthSessionId)
type Any = any;

const time = (ms: number) => DateTime.makeUnsafe(ms);

/** A minted link, as the Connections list and the access stream show it (T3's `listPairingLinks` row). */
export function toPairingLink(pairing: StoredPairing): AuthPairingLink {
	return {
		id: pairing.id,
		...authScopeResponse(pairing.scopes as Any),
		subject: pairing.subject,
		...(pairing.label === undefined ? {} : { label: pairing.label }),
		createdAt: time(pairing.createdAt),
		expiresAt: time(pairing.expiresAt),
	} as Any;
}

/** A client session, as the Connections list and the access stream show it. `connected` is the live-socket count in
 * the store; `current` is per-connection (the client viewing the list is "this device"). T3's `AuthClientSession`. */
export function toClientSession(session: StoredToken, connected: boolean, current: boolean): AuthClientSession {
	return {
		sessionId: session.id,
		subject: session.subject,
		...authScopeResponse(session.scopes as Any),
		method: session.method,
		client: {
			...(session.label === undefined ? {} : { label: session.label }),
			...(session.ipAddress === undefined ? {} : { ipAddress: session.ipAddress }),
			...(session.userAgent === undefined ? {} : { userAgent: session.userAgent }),
			deviceType: session.deviceType,
			...(session.os === undefined ? {} : { os: session.os }),
			...(session.browser === undefined ? {} : { browser: session.browser }),
		},
		issuedAt: time(session.createdAt),
		expiresAt: time(session.expiresAt),
		lastConnectedAt: session.lastConnectedAt === undefined ? null : time(session.lastConnectedAt),
		connected,
		current,
	} as Any;
}

/** T3's ordering for the clients list (`bySessionPriority`): managers first, then connected, then newest issued. */
export function bySessionPriority(left: AuthClientSession, right: AuthClientSession): number {
	const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
	const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
	if (leftCanManage !== rightCanManage) return leftCanManage ? -1 : 1;
	if (left.connected !== right.connected) return left.connected ? -1 : 1;
	return DateTime.toEpochMillis(right.issuedAt as Any) - DateTime.toEpochMillis(left.issuedAt as Any);
}

/** The unexpired pairing links a user can mint/revoke, newest first (T3 excludes the host's startup subject). */
export function listPairingLinks(auth: AuthStore): AuthPairingLink[] {
	return auth.listPairingLinks().map(toPairingLink);
}

/** The live client sessions in T3's Connections order, with `connected` from the store and `current` for the caller. */
export function listClientSessions(auth: AuthStore, currentSessionId: string): AuthClientSession[] {
	return auth
		.listClientSessions()
		.map((session) => toClientSession(session, auth.isConnected(session.id), session.id === currentSessionId))
		.toSorted(bySessionPriority);
}

/** The `subscribeAuthAccess` stream's opening event payload: the links and the sessions, as the caller sees them. */
export function accessSnapshot(auth: AuthStore, currentSessionId: string): AuthAccessSnapshot {
	return { pairingLinks: listPairingLinks(auth), clientSessions: listClientSessions(auth, currentSessionId) };
}

/** One store change, projected as the stream's incremental event. The caller assigns the revision. `connected` and
 * `current` are read at emit time for this connection (the record rides along; the consumer never re-reads). */
export function accessChangeEvent(auth: AuthStore, change: AccessChange, currentSessionId: string): AuthAccessStreamEvent {
	switch (change.type) {
		case "pairingLinkUpserted":
			return { version: 1, type: "pairingLinkUpserted", payload: toPairingLink(change.pairing) } as Any;
		case "pairingLinkRemoved":
			return { version: 1, type: "pairingLinkRemoved", payload: { id: change.id } } as Any;
		case "clientUpserted":
			return {
				version: 1,
				type: "clientUpserted",
				payload: toClientSession(change.session, auth.isConnected(change.session.id), change.session.id === currentSessionId),
			} as Any;
		case "clientRemoved":
			return { version: 1, type: "clientRemoved", payload: { sessionId: change.sessionId } } as Any;
	}
}
