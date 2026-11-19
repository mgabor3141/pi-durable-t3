// The facet's on-disk store (auth.json) and the host's instance file share this writer, so the format and the
// permissions are the contract: a value survives a write→read round-trip, the file is 0600 (secrets), and a write
// never inherits anything from a temp file it did not create. The last one is the 0600 case that
// matters: `open(2)` applies `mode` only when it CREATES, so a writer that reuses `<file>.tmp` publishes whatever mode
// a crashed writer's leftover temp file had. The writer's temp name is unique (`wx`) and chmod'ed before the rename.
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.ts";
import { AuthStore } from "../src/t3/auth.ts";
import { writeJsonAtomic } from "../src/t3/json-store.ts";
import { tempRoot } from "./temp-root.ts";

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("json-store", () => {
	it("round-trips a value and leaves the file at mode 0600", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		const value = { list: [1, 2, 3], nested: { text: "héllo" } };
		writeJsonAtomic(file, value);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(value);
		expect(modeOf(file)).toBe(0o600);
	});

	it("a pre-existing loose .tmp does not survive as the file's mode", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		const temporary = `${file}.tmp`;
		writeFileSync(temporary, "stale\n", { mode: 0o644 });
		chmodSync(temporary, 0o644);
		expect(modeOf(temporary)).toBe(0o644);
		const litter = () => readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")).sort();
		const before = litter();
		writeJsonAtomic(file, { ok: true });
		expect(modeOf(file)).toBe(0o600); // the write's own mode, never the leftover temp file's
		expect(readFileSync(file, "utf8")).toContain("ok");
		// The writer used a name of its own, so it neither inherits the leftover's mode nor adds litter. A pre-existing
		// temp file is not the writer's to delete: it belongs to a writer that may still be running.
		expect(litter()).toEqual(before);
	});

});

// auth.json is strict (design.md, Strict files and Migrations): a missing file is a first run, and anything else the
// store cannot read stops it, naming the file, and is left as it is. Starting over would unpair every device and give
// T3 a new environment id.
describe("auth.json", () => {
	const open = (dir: string) => new AuthStore(dir, { tokenTtlSeconds: 60 });

	it("a missing file is created, and the next store reads the same environment", async () => {
		const root = await tempRoot();
		const first = open(root);
		expect(first.environmentId).toMatch(/^pi-/);
		expect(open(root).environmentId).toBe(first.environmentId);
	});

	it("a file that does not parse is refused with a ConfigError naming it, and left as it was", async () => {
		const root = await tempRoot();
		const file = join(root, "auth.json");
		writeFileSync(file, '{ "environmentId": "pi-keepme", "pairi', { mode: 0o600 });
		expect(() => open(root)).toThrow(ConfigError);
		expect(() => open(root)).toThrow(file);
		expect(readFileSync(file, "utf8")).toBe('{ "environmentId": "pi-keepme", "pairi');
	});

	it("a file without a required field is refused, not filled in", async () => {
		const root = await tempRoot();
		const file = join(root, "auth.json");
		const valid = JSON.parse(readFileSync((open(root), file), "utf8")) as Record<string, unknown>;
		const pairing = { id: "p1", hash: "h", subject: "one-time-token", scopes: [], createdAt: 1, expiresAt: 2 };
		const token = { id: "t1", hash: "h", subject: "one-time-token", scopes: [], method: "bearer-access-token", deviceType: "unknown", createdAt: 1, expiresAt: 2 };
		writeJsonAtomic(file, { ...valid, pairings: [pairing], tokens: [token] });
		expect(() => open(root)).not.toThrow();
		const { assetKey: _, ...noAssetKey } = valid;
		const { id: __, ...pairingWithoutId } = pairing;
		const { method: ___, ...tokenWithoutMethod } = token;
		for (const [broken, named] of [
			[noAssetKey, "assetKey"],
			[{ ...valid, pairings: [pairingWithoutId] }, "pairings[0].id"],
			[{ ...valid, tokens: [tokenWithoutMethod] }, "tokens[0].method"],
			[{ ...valid, tokens: {} }, "tokens"],
		] as const) {
			writeJsonAtomic(file, broken);
			const text = readFileSync(file, "utf8");
			expect(() => open(root)).toThrow(ConfigError);
			expect(() => open(root)).toThrow(`${file}: ${named}`);
			expect(readFileSync(file, "utf8")).toBe(text);
		}
	});
});
