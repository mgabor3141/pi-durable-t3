// The facet's on-disk store (auth.json) and the host's instance file share this writer, so the format and the
// permissions are the contract: a value survives a write→read round-trip, the file is 0600 (secrets), a read never
// throws, and a write never inherits anything from a temp file it did not create. The last one is the 0600 case that
// matters: `open(2)` applies `mode` only when it CREATES, so a writer that reuses `<file>.tmp` publishes whatever mode
// a crashed writer's leftover temp file had. The writer's temp name is unique (`wx`) and chmod'ed before the rename.
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
		const litter = () => readdirSync(root).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock")).sort();
		const before = litter();
		writeJsonAtomic(file, { ok: true });
		expect(modeOf(file)).toBe(0o600); // the write's own mode, never the leftover temp file's
		expect(readFileSync(file, "utf8")).toContain("ok");
		// The writer used a name of its own, so it neither inherits the leftover's mode nor adds litter. A pre-existing
		// temp file is not the writer's to delete: it belongs to a writer that may still be running.
		expect(litter()).toEqual(before);
	});

	it("a corrupt file returns the fallback", async () => {
		const root = await tempRoot();
		const file = join(root, "store.json");
		writeFileSync(file, "{ not json", { mode: 0o600 });
		expect(readJson(file, { fallback: true })).toEqual({ fallback: true });
	});
});
