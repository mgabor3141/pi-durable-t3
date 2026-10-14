// Pairing codes, bearer tokens and WebSocket tickets. Codes and tokens are stored as SHA-256 hashes in
// <stateDir>/auth.json (mode 0600); tickets live in memory for 60 s.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export class AuthStore {
	readonly #file: string;
	readonly #fixedPairing: string | undefined;
	readonly #ttlMs: number;
	readonly #tickets = new Map<string, { expiresAt: number; tokenHash: string }>();

	constructor(stateDir: string, options: { pairingToken?: string | undefined; tokenTtlSeconds: number }) {
		mkdirSync(stateDir, { recursive: true, mode: 0o700 });
		// A pre-existing directory keeps whatever mode it had; tighten it (the files inside are 0600 anyway).
		chmodSync(stateDir, 0o700);
		this.#file = join(stateDir, "auth.json");
		this.#fixedPairing = options.pairingToken;
		this.#ttlMs = options.tokenTtlSeconds * 1000;
		if (!existsSync(this.#file)) {
			this.#write({ environmentId: `pi-${newSecret(9)}`, pairings: [], tokens: [] });
		}
	}

	#read(): AuthFile {
		return JSON.parse(readFileSync(this.#file, "utf8")) as AuthFile;
	}

	#write(data: AuthFile): void {
		const temporary = `${this.#file}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		chmodSync(temporary, 0o600);
		renameSync(temporary, this.#file);
	}

	get environmentId(): string {
		return this.#read().environmentId;
	}

	/** A one-time pairing code valid for `ttlSeconds`. */
	createPairingCode(ttlSeconds = 15 * 60): string {
		const code = newSecret(12);
		const data = this.#read();
		const now = Date.now();
		data.pairings = data.pairings.filter((p) => p.expiresAt > now);
		data.pairings.push({ hash: hash(code), expiresAt: now + ttlSeconds * 1000 });
		this.#write(data);
		return code;
	}

	/** Exchange a pairing code for a bearer token. Stored codes are single-use; the configured fixed token is reusable. */
	exchange(code: string, label: string): { token: string; expiresIn: number } | undefined {
		const data = this.#read();
		const now = Date.now();
		const codeHash = hash(code);
		const fixed = this.#fixedPairing !== undefined && sameHash(hash(this.#fixedPairing), codeHash);
		const index = data.pairings.findIndex((p) => p.expiresAt > now && sameHash(p.hash, codeHash));
		if (!fixed && index < 0) return undefined;
		if (index >= 0) data.pairings.splice(index, 1);
		const token = newSecret(32);
		data.tokens = data.tokens.filter((t) => t.expiresAt > now);
		data.tokens.push({ hash: hash(token), label, createdAt: now, expiresAt: now + this.#ttlMs });
		this.#write(data);
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

/** Failed pairing attempts per client address: at most `limit` per `windowMs`, then 429 until the window passes. */
export class PairingRateLimit {
	readonly #failures = new Map<string, number[]>();
	readonly limit: number;
	readonly windowMs: number;
	constructor(limit = 10, windowMs = 60_000) {
		this.limit = limit;
		this.windowMs = windowMs;
	}
	blocked(address: string): boolean {
		const now = Date.now();
		const recent = (this.#failures.get(address) ?? []).filter((at) => at > now - this.windowMs);
		this.#failures.set(address, recent);
		return recent.length >= this.limit;
	}
	fail(address: string): void {
		this.#failures.set(address, [...(this.#failures.get(address) ?? []), Date.now()]);
	}
}
