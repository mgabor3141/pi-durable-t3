// Pairing links, bearer tokens (client sessions) and WebSocket tickets. Codes and tokens are stored as SHA-256
// hashes in <dir>/auth.json (mode 0600); tickets and the live-connection counts live in memory. Codes are
// single-use; a host mints one with `mintPairingCode` (`../bridge.ts`), and a paired client mints, lists and
// revokes them over the Connections endpoints (`./http.ts`), which read and write this one store.
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-store.ts";

/** The subject T3 hides from the pairing-links list: the host's own startup credential. `mintPairingCode` mints a
 * link a *user* copies by hand, so it is a one-time token, and it shows — like `t3 auth pairing create`. */
export const ADMINISTRATIVE_BOOTSTRAP_SUBJECT = "administrative-bootstrap";
export const ONE_TIME_TOKEN_SUBJECT = "one-time-token";

type DeviceType = "desktop" | "mobile" | "tablet" | "bot" | "unknown";

/** What the exchange knows about the client asking (label, UA-derived device shape, socket address). */
export interface ClientMetadata {
	label?: string;
	ipAddress?: string;
	userAgent?: string;
	deviceType?: DeviceType;
	os?: string;
	browser?: string;
}

export interface StoredPairing {
	/** Stable id (the Connections list revokes by it). */
	id: string;
	hash: string;
	subject: string;
	scopes: string[];
	label?: string;
	createdAt: number;
	expiresAt: number;
}

export interface StoredToken {
	/** The session id the Clients list shows and revokes by. */
	id: string;
	hash: string;
	subject: string;
	scopes: string[];
	/** How the client presents this session: a bearer access token (the `/oauth/token` path), or the browser session
	 * cookie the same-origin web app sends (`./http.ts`). T3's `ServerAuthSessionMethod`. */
	method: "bearer-access-token" | "browser-session-cookie";
	label?: string;
	ipAddress?: string;
	userAgent?: string;
	deviceType: DeviceType;
	os?: string;
	browser?: string;
	createdAt: number;
	expiresAt: number;
	lastConnectedAt?: number;
}

interface AuthFile {
	environmentId: string;
	pairings: StoredPairing[];
	tokens: StoredToken[];
	/** The HMAC key (base64url, 32 bytes) that signs attachment-upload and asset-access tokens. Generated on first
	 * read and persisted here, so a minted link survives a restart (one host per dir). */
	assetKey?: string;
}

/** One change to the access state, as the `subscribeAuthAccess` stream projects it. The record rides along: a
 * consumer must not re-read the store and find the row already gone. */
export type AccessChange =
	| { type: "pairingLinkUpserted"; pairing: StoredPairing }
	| { type: "pairingLinkRemoved"; id: string }
	| { type: "clientUpserted"; session: StoredToken }
	| { type: "clientRemoved"; sessionId: string };

export interface IssuedPairing {
	id: string;
	credential: string;
	subject: string;
	scopes: string[];
	label?: string;
	createdAt: number;
	expiresAt: number;
}

export interface IssuedSession {
	token: string;
	expiresIn: number;
	scopes: string[];
	session: StoredToken;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newSecret = (bytes = 24) => randomBytes(bytes).toString("base64url");
const newAuthFile = (): AuthFile => ({ environmentId: `pi-${newSecret(9)}`, pairings: [], tokens: [], assetKey: newSecret(32) });
const standardScopes = () => [...AuthStandardClientScopes];

/** Entries written before links and sessions carried ids, scopes and client metadata get them once, on read, and
 * the file is rewritten (`#read`): a minted id must stay stable, so a migration is persisted, not re-derived.
 * A legacy pairing came from the host's `pair` command, so it is a one-time token with the standard grant; a
 * legacy token was exchanged from one, so it carries the same subject and scopes. */
function normalize(data: AuthFile): { file: AuthFile; migrated: boolean } {
	let migrated = false;
	const pairings = data.pairings.map((pairing) => {
		const raw = pairing as Partial<StoredPairing>;
		if (typeof raw.id === "string" && raw.id.length > 0 && Array.isArray(raw.scopes) && typeof raw.subject === "string") return pairing;
		migrated = true;
		return {
			id: randomUUID(),
			hash: pairing.hash,
			subject: ONE_TIME_TOKEN_SUBJECT,
			scopes: standardScopes(),
			createdAt: pairing.expiresAt - PAIRING_CODE_TTL_SECONDS * 1000,
			expiresAt: pairing.expiresAt,
		};
	});
	const tokens = data.tokens.map((token) => {
		const raw = token as Partial<StoredToken>;
		if (typeof raw.id === "string" && raw.id.length > 0 && Array.isArray(raw.scopes) && typeof raw.subject === "string") return token;
		migrated = true;
		return {
			id: randomUUID(),
			hash: token.hash,
			subject: ONE_TIME_TOKEN_SUBJECT,
			scopes: standardScopes(),
			method: "bearer-access-token" as const,
			deviceType: "unknown" as DeviceType,
			...(token.label === undefined ? {} : { label: token.label }),
			createdAt: token.createdAt,
			expiresAt: token.expiresAt,
			...(token.lastConnectedAt === undefined ? {} : { lastConnectedAt: token.lastConnectedAt }),
		};
	});
	return { file: { ...data, pairings, tokens }, migrated };
}

export class AuthStore {
	readonly #file: string;
	readonly #ttlMs: number;
	readonly #tickets = new Map<string, { expiresAt: number; tokenHash: string }>();
	/** Live WebSocket connections per session id (a session may hold more than one). */
	readonly #connected = new Map<string, number>();
	readonly #listeners = new Set<(change: AccessChange) => void>();

	constructor(dir: string, options: { tokenTtlSeconds: number }) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		// A pre-existing directory keeps whatever mode it had; tighten it (the files inside are 0600 anyway).
		chmodSync(dir, 0o700);
		this.#file = join(dir, "auth.json");
		this.#ttlMs = options.tokenTtlSeconds * 1000;
		// A first run persists a store, so the environmentId is stable from the start; an existing store survives.
		this.#read();
	}

	// A store that is missing (deleted after start) or unparseable starts over, persisted at once so the environmentId
	// does not change on every read. The UI's documents are parsed strictly (`json-store.ts`); this one is the facet's own.
	#read(): AuthFile {
		const stored = readJson<AuthFile | undefined>(this.#file, undefined);
		if (stored === undefined) {
			const fresh = newAuthFile();
			this.#write(fresh);
			return fresh;
		}
		const { file, migrated } = normalize(stored);
		// A store written before asset signing gets a key once, persisted: a minted link must not change across reads.
		if (typeof file.assetKey !== "string" || file.assetKey.length === 0) {
			file.assetKey = newSecret(32);
			this.#write(file);
			return file;
		}
		if (migrated) this.#write(file);
		return file;
	}

	#write(data: AuthFile): void {
		writeJsonAtomic(this.#file, data);
	}

	get environmentId(): string {
		return this.#read().environmentId;
	}

	/** Subscribe to access-state changes; returns the unsubscribe. The store is synchronous, and so are listeners. */
	onAccessChange(listener: (change: AccessChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(change: AccessChange): void {
		for (const listener of [...this.#listeners]) listener(change);
	}

	/** Mint a pairing link: a one-time code and the grant it carries. The code is returned once and stored hashed. */
	createPairingLink(input: { scopes: string[]; subject?: string; label?: string; ttlMs?: number }): IssuedPairing {
		const code = newSecret(12);
		const now = Date.now();
		const pairing: StoredPairing = {
			id: randomUUID(),
			hash: hash(code),
			subject: input.subject ?? ONE_TIME_TOKEN_SUBJECT,
			scopes: [...input.scopes],
			...(input.label === undefined ? {} : { label: input.label }),
			createdAt: now,
			expiresAt: now + (input.ttlMs ?? PAIRING_CODE_TTL_SECONDS * 1000),
		};
		const data = this.#read();
		this.#write({ ...data, pairings: [...data.pairings.filter((p) => p.expiresAt > now), pairing] });
		this.#emit({ type: "pairingLinkUpserted", pairing });
		return {
			id: pairing.id,
			credential: code,
			subject: pairing.subject,
			scopes: pairing.scopes,
			...(pairing.label === undefined ? {} : { label: pairing.label }),
			createdAt: pairing.createdAt,
			expiresAt: pairing.expiresAt,
		};
	}

	/** A one-time pairing code with the standard grant — the host's out-of-band `pair` path. */
	createPairingCode(): string {
		return this.createPairingLink({ scopes: standardScopes() }).credential;
	}

	/** The links a user can see and revoke: unexpired, host startup excluded, newest first (T3's list order). */
	listPairingLinks(): StoredPairing[] {
		const now = Date.now();
		return this.#read()
			.pairings.filter((pairing) => pairing.expiresAt > now && pairing.subject !== ADMINISTRATIVE_BOOTSTRAP_SUBJECT)
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	/** Burn a minted link before it is spent. True when a link with this id existed. */
	revokePairingLink(id: string): boolean {
		const now = Date.now();
		const data = this.#read();
		const target = data.pairings.find((pairing) => pairing.id === id);
		if (target === undefined) return false;
		this.#write({ ...data, pairings: data.pairings.filter((pairing) => pairing.id !== id) });
		this.#emit({ type: "pairingLinkRemoved", id: target.id });
		return true;
	}

	/** Exchange a pairing code for a bearer token. Stored codes are single-use: a grant is consumed before the
	 * requested scopes are intersected, so a code is spent even when the intersection is empty (the exchange then
	 * refuses, exactly as T3's does). */
	exchange(
		code: string,
		presented: ClientMetadata,
		requestedScopes?: string[],
	): { session: IssuedSession } | { refused: "invalid-credential" } | { refused: "scope-not-granted" } {
		const now = Date.now();
		const codeHash = hash(code);
		const data = this.#read();
		const index = data.pairings.findIndex((pairing) => pairing.expiresAt > now && sameHash(pairing.hash, codeHash));
		if (index < 0) return { refused: "invalid-credential" }; // refused: the file is left exactly as it was, codes included
		const grant = data.pairings[index]!;
		const scopes =
			requestedScopes === undefined
				? [...grant.scopes]
				: [...new Set(requestedScopes)].filter((scope) => grant.scopes.includes(scope));
		const token = newSecret(32);
		const session: StoredToken = {
			id: randomUUID(),
			hash: hash(token),
			subject: grant.subject,
			scopes,
			method: "bearer-access-token",
			// A labelled link labels the device it pairs: the link's name wins over the request's user-agent guess.
			...(grant.label !== undefined ? { label: grant.label } : presented.label === undefined ? {} : { label: presented.label }),
			...(presented.ipAddress === undefined ? {} : { ipAddress: presented.ipAddress }),
			...(presented.userAgent === undefined ? {} : { userAgent: presented.userAgent }),
			deviceType: presented.deviceType ?? "unknown",
			...(presented.os === undefined ? {} : { os: presented.os }),
			...(presented.browser === undefined ? {} : { browser: presented.browser }),
			createdAt: now,
			expiresAt: now + this.#ttlMs,
		};
		this.#write({
			...data,
			pairings: data.pairings.filter((_, at) => at !== index),
			tokens: [...data.tokens.filter((stored) => stored.expiresAt > now), session],
		});
		this.#emit({ type: "pairingLinkRemoved", id: grant.id });
		if (scopes.length === 0) return { refused: "scope-not-granted" };
		this.#emit({ type: "clientUpserted", session });
		return { session: { token, expiresIn: Math.floor(this.#ttlMs / 1000), scopes, session } };
	}

	/** Every live client session, newest first; the boundary sorts by T3's priority and marks `current`. */
	listClientSessions(): StoredToken[] {
		const now = Date.now();
		return this.#read().tokens.filter((token) => token.expiresAt > now).sort((left, right) => right.createdAt - left.createdAt);
	}

	/** Revoke one client session. Its live WebSocket closes on the bridge's next token check (`./http.ts`). */
	revokeClientSession(sessionId: string): boolean {
		const data = this.#read();
		if (!data.tokens.some((token) => token.id === sessionId)) return false;
		this.#write({ ...data, tokens: data.tokens.filter((token) => token.id !== sessionId) });
		this.#connected.delete(sessionId);
		this.#emit({ type: "clientRemoved", sessionId });
		return true;
	}

	/** Revoke every session but this one; the count the response carries. */
	revokeOtherClientSessions(currentSessionId: string): number {
		const now = Date.now();
		const data = this.#read();
		const removed = data.tokens.filter((token) => token.id !== currentSessionId && token.expiresAt > now);
		if (removed.length === 0) return 0;
		this.#write({ ...data, tokens: data.tokens.filter((token) => token.id === currentSessionId) });
		for (const token of removed) {
			this.#connected.delete(token.id);
			this.#emit({ type: "clientRemoved", sessionId: token.id });
		}
		return removed.length;
	}

	/** The session a live socket belongs to (its ticket carries only the token hash). */
	sessionOfTokenHash(tokenHash: string): StoredToken | undefined {
		return this.#read().tokens.find((token) => token.expiresAt > Date.now() && sameHash(token.hash, tokenHash));
	}

	/** A live socket opened for this token: count it, and record the first connection's moment. */
	markConnected(tokenHash: string): void {
		const session = this.sessionOfTokenHash(tokenHash);
		if (session === undefined) return;
		const wasConnected = this.#connected.has(session.id);
		this.#connected.set(session.id, (this.#connected.get(session.id) ?? 0) + 1);
		if (wasConnected) return;
		const data = this.#read();
		const stored = data.tokens.find((token) => token.id === session.id);
		if (stored === undefined) return;
		stored.lastConnectedAt = Date.now();
		this.#write(data);
		this.#emit({ type: "clientUpserted", session: stored });
	}

	markDisconnected(tokenHash: string): void {
		const session = this.sessionOfTokenHash(tokenHash);
		if (session === undefined) return;
		const count = (this.#connected.get(session.id) ?? 1) - 1;
		if (count > 0) {
			this.#connected.set(session.id, count);
			return;
		}
		this.#connected.delete(session.id);
		this.#emit({ type: "clientUpserted", session });
	}

	isConnected(sessionId: string): boolean {
		return this.#connected.has(sessionId);
	}

	verifyBearer(header: string | undefined): StoredToken | undefined {
		const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(header ?? "");
		if (!match) return undefined;
		return this.#findByToken(match[1]!.trim());
	}

	/** The session a browser session cookie carries, given the raw cookie value (its token, hashed against the store).
	 * The same-origin web app authenticates every call with this cookie, not a bearer. */
	verifySessionToken(token: string): StoredToken | undefined {
		return this.#findByToken(token);
	}

	#findByToken(token: string): StoredToken | undefined {
		const tokenHash = hash(token);
		return this.#read().tokens.find((t) => t.expiresAt > Date.now() && sameHash(t.hash, tokenHash));
	}

	/** Exchange a pairing credential for a BROWSER session: the same one-time exchange as `exchange`, but the session
	 * is a `browser-session-cookie` (the value the same-origin web app's cookie carries). Mirrors T3's
	 * `createBrowserSession`: the grant is consumed, and a previous browser session (the caller's own cookie) is
	 * replaced so a re-pair in one browser leaves one live session, not a pile. */
	createBrowserSession(code: string, presented: ClientMetadata, previousSessionId?: string): { session: IssuedSession } | { refused: "invalid-credential" } {
		const now = Date.now();
		const codeHash = hash(code);
		const data = this.#read();
		const index = data.pairings.findIndex((pairing) => pairing.expiresAt > now && sameHash(pairing.hash, codeHash));
		if (index < 0) return { refused: "invalid-credential" };
		const grant = data.pairings[index]!;
		const token = newSecret(32);
		const session: StoredToken = {
			id: randomUUID(),
			hash: hash(token),
			subject: grant.subject,
			scopes: [...grant.scopes],
			method: "browser-session-cookie",
			...(grant.label !== undefined ? { label: grant.label } : presented.label === undefined ? {} : { label: presented.label }),
			...(presented.ipAddress === undefined ? {} : { ipAddress: presented.ipAddress }),
			...(presented.userAgent === undefined ? {} : { userAgent: presented.userAgent }),
			deviceType: presented.deviceType ?? "unknown",
			...(presented.os === undefined ? {} : { os: presented.os }),
			...(presented.browser === undefined ? {} : { browser: presented.browser }),
			createdAt: now,
			expiresAt: now + this.#ttlMs,
		};
		const kept = previousSessionId === undefined ? data.tokens : data.tokens.filter((t) => t.id !== previousSessionId);
		this.#write({
			...data,
			pairings: data.pairings.filter((_, at) => at !== index),
			tokens: [...kept.filter((stored) => stored.expiresAt > now), session],
		});
		this.#emit({ type: "pairingLinkRemoved", id: grant.id });
		if (previousSessionId !== undefined) this.#emit({ type: "clientRemoved", sessionId: previousSessionId });
		this.#emit({ type: "clientUpserted", session });
		return { session: { token, expiresIn: Math.floor(this.#ttlMs / 1000), scopes: session.scopes, session } };
	}

	/** A one-shot WebSocket ticket for the bearer token with this hash. */
	issueTicket(tokenHash: string): { ticket: string; expiresAt: number } {
		const ticket = newSecret(24);
		const expiresAt = Date.now() + 60_000;
		this.#tickets.set(ticket, { expiresAt, tokenHash });
		return { ticket, expiresAt };
	}

	/** Consume a ticket; returns the hash of the token it was issued for, or undefined. */
	consumeTicket(ticket: string | null): string | undefined {
		if (ticket === null) return undefined;
		const entry = this.#tickets.get(ticket);
		this.#tickets.delete(ticket);
		for (const [key, value] of this.#tickets) if (value.expiresAt < Date.now()) this.#tickets.delete(key);
		if (entry === undefined || entry.expiresAt <= Date.now()) return undefined;
		return this.isTokenActive(entry.tokenHash) ? entry.tokenHash : undefined;
	}

	/** Whether the token with this hash is still stored and unexpired (revocation removes it). */
	isTokenActive(tokenHash: string): boolean {
		return this.#read().tokens.some((t) => t.expiresAt > Date.now() && sameHash(t.hash, tokenHash));
	}

	/** Sign a token payload with the store's asset key (HMAC-SHA256, base64url) — the `<payload>.<signature>`
	 * format T3 mints for attachment-upload and asset-access URLs (`auth/utils.ts` at the pin). */
	signPayload(payload: string): string {
		return createHmac("sha256", Buffer.from(this.#read().assetKey!, "base64url")).update(payload).digest("base64url");
	}

	/** Verify a token's signature, in constant time, against its canonical encoding: a signature that differs only
	 * in base64url padding bits is refused, not decoded to the same bytes. */
	verifySignature(payload: string, signature: string): boolean {
		const expected = Buffer.from(this.signPayload(payload));
		const given = Buffer.from(signature);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}
}

/** How long a minted pairing code stays exchangeable: long enough to copy by hand, short enough to be spent. */
const PAIRING_CODE_TTL_SECONDS = 15 * 60;

/** Failed pairing attempts per client address: at most 10 per minute, then 429 until the window passes. */
const ATTEMPT_LIMIT = 10;
const WINDOW_MS = 60_000;

export class PairingRateLimit {
	readonly #failures = new Map<string, number[]>();
	blocked(address: string): boolean {
		const now = Date.now();
		const recent = (this.#failures.get(address) ?? []).filter((at) => at > now - WINDOW_MS);
		this.#failures.set(address, recent);
		return recent.length >= ATTEMPT_LIMIT;
	}
	fail(address: string): void {
		this.#failures.set(address, [...(this.#failures.get(address) ?? []), Date.now()]);
	}
}
