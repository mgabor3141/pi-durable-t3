// The transfer scenario of `test/transfer-budget.test.ts` at other sizes: measured and printed, not asserted. The
// defaults are a thread after a long day's work (200 turns, 2,000 tool calls) and a sidebar of 170 threads.
// Run: TMPDIR=<exec-able dir> npx vitest run --config bench/vitest.config.ts bench/transfer.bench.test.ts
// Sizes: BENCH_TURNS, BENCH_TOOLS, BENCH_TOOL_BYTES, BENCH_WORDS, BENCH_SETTLED, BENCH_ACTIVE, BENCH_TPS; and
// BENCH_CONTEXT_MS for an integrator's `messageContext` hook that takes that long (a memory recall).
// BENCH_OUT names a file for the table.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { measureTransfer, transferReport, type TransferScenario } from "../test/transfer-scenario.ts";

const setting = (name: string, fallback: number): number => Number(process.env[name] ?? fallback);

it("transfer and waiting at a size", { timeout: 3_600_000 }, async () => {
	const scenario: TransferScenario = {
		port: 4994,
		historyTurns: setting("BENCH_TURNS", 200),
		historyToolsPerTurn: setting("BENCH_TOOLS", 10),
		historyToolBytes: setting("BENCH_TOOL_BYTES", 4_000),
		measuredTools: 2,
		measuredToolBytes: 8_192,
		measuredWords: setting("BENCH_WORDS", 3_000),
		fleetSettled: setting("BENCH_SETTLED", 150),
		fleetActive: setting("BENCH_ACTIVE", 20),
		tokensPerSecond: setting("BENCH_TPS", 1_500),
		messageContextMs: setting("BENCH_CONTEXT_MS", 0),
	};
	const result = await measureTransfer(scenario);
	const report = `${transferReport(scenario, result)}\nWritten in ${result.setupSeconds.toFixed(0)} s.\n`;
	console.log(report);
	const out = process.env["BENCH_OUT"];
	if (out !== undefined && out !== "") writeFileSync(out, report);
});
