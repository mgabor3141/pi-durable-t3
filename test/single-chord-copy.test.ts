// Guards two load-bearing single-copy invariants. (1) The Harness keys its conversation-view registry on the `chord`
// module by identity, so the process must load exactly one copy of `chord`. (2) The README's stated invariant is about
// Effect: the facet and the vendored contracts must share ONE Effect copy — two instances break the schema brand encode.
// That is why the contracts are vendored locally (not linked into the T3 tree). If a check fails, the runner resolved a
// second copy (e.g. by bundling an extra one) and the tests cannot be trusted. Resolution only — nothing is imported.
import { test } from "vitest";

function realPath(url: string): string {
	return new globalThis.URL(url).pathname;
}

test("chord resolves to one file for the host and the durable package", async () => {
	const chord = "@earendil-works/chord";
	const fromHost = import.meta.resolve(chord, import.meta.url);
	const fromDurable = import.meta.resolve(chord, import.meta.resolve("@earendil-works/pi-durable"));
	if (realPath(fromHost) !== realPath(fromDurable)) {
		throw new Error(`chord resolved twice:\n  host: ${fromHost}\n  durable: ${fromDurable}`);
	}
});

test("effect resolves to one file for the host and the vendored contracts", async () => {
	const fromHost = import.meta.resolve("effect", import.meta.url);
	const fromContracts = import.meta.resolve("effect", import.meta.resolve("@t3tools/contracts"));
	if (realPath(fromHost) !== realPath(fromContracts)) {
		throw new Error(`effect resolved twice:\n  host: ${fromHost}\n  contracts: ${fromContracts}`);
	}
});
