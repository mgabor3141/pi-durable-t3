// The facet's on-disk store (auth.json) uses `readJson`/`writeJsonAtomic`, so the format and the
// permissions are the contract: a value survives a write→read round-trip, the file is 0600 (secrets), and a read
// never throws. The 0600 case that matters is a leftover `*.tmp` from a crashed write at a looser mode: `open(2)`
// applies `mode` only when it creates, so the writer chmods the temp explicitly.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJsonAtomic } from "../src/t3/json-store.ts";
import { tempRoot } from "./temp-root.ts";

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe("json-store", () => {
	it("round-trips a value and leaves the file at mode 0600", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		const value = { list: [1, 2, 3], nested: { text: "héllo" } };
		writeJsonAtomic(file, value);
		expect(readJson(file, null)).toEqual(value);
		expect(modeOf(file)).toBe(0o600);
	});

	it("a pre-existing loose .tmp does not survive as the file's mode", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		const temporary = `${file}.tmp`;
		writeFileSync(temporary, "stale\n", { mode: 0o644 });
		chmodSync(temporary, 0o644);
		expect(modeOf(temporary)).toBe(0o644);
		writeJsonAtomic(file, { ok: true });
		expect(modeOf(file)).toBe(0o600);
		expect(existsSync(temporary)).toBe(false); // the rename consumed it
		expect(readFileSync(file, "utf8")).toContain("ok");
	});

	it("a missing file returns the fallback", async () => {
		const root = await tempRoot();
		expect(readJson(join(root, "absent.json"), { fallback: true })).toEqual({ fallback: true });
	});

	it("a corrupt file returns the fallback", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		writeFileSync(file, "{ not json", { mode: 0o600 });
		expect(readJson(file, { fallback: true })).toEqual({ fallback: true });
	});
});
