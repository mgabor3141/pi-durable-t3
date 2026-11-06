import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["bench/**/*.bench.test.ts"],
		fileParallelism: false,
		maxWorkers: 1,
	},
});
