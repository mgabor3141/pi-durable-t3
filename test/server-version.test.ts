// The facet reports `SERVER_VERSION` to T3, a constant hand-copied to match the vendored T3 contracts' version (they must
// agree, or the web app's version handshake is meaningless). Nothing links them, so this guards the copy: if the pinned
// contracts version moves, this fails and SERVER_VERSION must move with it. Skipped when `vendor/` is absent (so
// `pnpm test` needs no setup); it runs on any tree that has been through `pnpm setup:t3`.
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const SERVER_VERSION = "0.0.45"; // keep in sync with src/t3/http.ts
const file = new URL("../vendor/contracts/package.json", import.meta.url);
const present = existsSync(file);
const vendored = present ? (JSON.parse(readFileSync(file, "utf8")) as { version?: string }) : undefined;

it.skipIf(!present)("SERVER_VERSION matches the vendored T3 contracts version", () => {
	expect(vendored?.version).toBe(SERVER_VERSION);
});
