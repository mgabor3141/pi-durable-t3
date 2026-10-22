import { defineConfig } from "tsdown";

// tsdown (rolldown) over plain tsc: the one thing tsc can't do is bundle T3's contracts (not on npm, a TS-source
// package) into the output; here that is a single `noExternal`. Declarations come from tsc (build.sh): TypeScript 7
// has no JS API for tsdown's dts plugin.
export default defineConfig({
	entry: ["../src/bridge.ts"],
	outDir: "../dist",
	format: "esm",
	platform: "node",
	target: "node22",
	dts: false,
	clean: true,
	fixedExtension: false,
	sourcemap: false,
	// Bundle T3's contracts (vendor/contracts, symlinked as node_modules/@t3tools/contracts by setup:t3). Everything else in `dependencies` /
	// `peerDependencies` stays external: `effect` must be ONE copy shared by the bridge and the contracts.
	deps: { alwaysBundle: [/^@t3tools\/contracts/], onlyBundle: false },
});
