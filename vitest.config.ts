import { defineConfig } from "vitest/config";

// Tests resolve the published pi packages from `node_modules` (default conditions). We deliberately do NOT use the
// `source` condition or alias into package internals: the Harness keys its view registry on the `chord` module by
// identity, so a second copy of `chord` would break it. One `chord` is loaded when the packages stay external.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
