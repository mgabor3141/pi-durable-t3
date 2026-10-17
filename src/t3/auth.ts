// Pairing codes, bearer tokens and WebSocket tickets. Codes and tokens are stored as SHA-256 hashes in
// <dir>/auth.json (mode 0600); tickets live in memory for 60 s. Codes are single-use; a host mints one with
// `mintPairingCode` (`../bridge.ts`).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./json-store.ts";

interface StoredToken {
	hash: string;
	label: string;
	createdAt: number;
	expiresAt: number;
}
interface StoredPairing {
	hash: string;
	expiresAt: number;
}
interface AuthFile {
	environmentId: string;
	pairings: StoredPairing[];
	tokens: StoredToken[];
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newSecret = (bytes = 24) => randomBytes(bytes).toString("base64url");
const newAuthFile = (): AuthFile => ({ environmentId: `pi-${newSecret(9)}`, pairings: [], tokens: [] });

export class AuthStore {
	readonly #file: string;
	readonly #ttlMs: number;
	readonly #tickets = new Map<string, { expiresAt: number; tokenHash: string }>();

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
		if (stored !== undefined) return stored;
		const fresh = newAuthFile();
		this.#write(fresh);
		return fresh;
	}

	#write(data: AuthFile): void {
		writeJsonAtomic(this.#file, data);
	}

	get environmentId(): string {
		return this.#read().environmentId;
	}

	/** A one-time pairing code. */
	createPairingCode(): string {
		const code = newSecret(12);
		const now = Date.now();
		const data = this.#read();
		this.#write({
			...data,
			pairings: [...data.pairings.filter((pairing) => pairing.expiresAt > now), { hash: hash(code), expiresAt: now + PAIRING_CODE_TTL_SECONDS * 1000 }],
		});
		return code;
	}

	/** Exchange a pairing code for a bearer token. Stored codes are single-use. */
	exchange(code: string, label: string): { token: string; expiresIn: number } | undefined {
		const now = Date.now();
		const codeHash = hash(code);
		const data = this.#read();
		const index = data.pairings.findIndex((pairing) => pairing.expiresAt > now && sameHash(pairing.hash, codeHash));
		if (index < 0) return undefined; // refused: the file is left exactly as it was, codes included
		const token = newSecret(32);
		this.#write({
			...data,
			pairings: data.pairings.filter((_, at) => at !== index),
			tokens: [...data.tokens.filter((stored) => stored.expiresAt > now), { hash: hash(token), label, createdAt: now, expiresAt: now + this.#ttlMs }],
		});
		return { token, expiresIn: Math.floor(this.#ttlMs / 1000) };
	}

	verifyBearer(header: string | undefined): StoredToken | undefined {
		const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(header ?? "");
		if (!match) return undefined;
		const tokenHash = hash(match[1]!.trim());
		return this.#read().tokens.find((t) => t.expiresAt > Date.now() && sameHash(t.hash, tokenHash));
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
