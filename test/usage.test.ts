// `server.getUsageSummary`'s answer, as the pure function that builds it. The buckets, cost source, de-duplication and
// window rules are T3's (`usageAggregation.ts` at the pin); the input is pi's own per-turn `Usage`. This test pins the
// mapping the usage page renders — pi-reported cost (`providerReported`), zero-cost turns (`unpriced`), the field
// split, forks counted once, and the day/hour window — without a host.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageReadError, type UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import type { EntryRecord, PiUsage } from "../src/t3/model-types.ts";
import { piUsagePricing, summarizeUsage, usageRecordsOf } from "../src/t3/usage.ts";

const DAY = 86_400_000;
// A fixed 2026 day so the day-bucket tests are independent of the clock.
const D1 = Date.parse("2026-03-10T12:00:00Z");
const D2 = Date.parse("2026-03-11T09:30:00Z");

const usage = (over: Partial<PiUsage> = {}): PiUsage => ({
	input: 100,
	output: 50,
	cacheRead: 20,
	cacheWrite: 10,
	totalTokens: 180,
	cost: { input: 0.3, output: 0.2, cacheRead: 0.02, cacheWrite: 0.05, total: 0.57 },
	...over,
});

const assistant = (
	id: number,
	over: { timestamp: number; provider?: string; model?: string; responseModel?: string; usage?: PiUsage },
): EntryRecord => ({
	id,
	kind: "pi.assistant",
	model: [
		{
			role: "assistant",
			content: [],
			provider: over.provider ?? "anthropic",
			model: over.model ?? "claude-sonnet-4-5",
			...(over.responseModel === undefined ? {} : { responseModel: over.responseModel }),
			usage: over.usage ?? usage(),
			timestamp: over.timestamp,
		},
	],
});

const toolResult = (id: number, over: { timestamp: number; usage: PiUsage }): EntryRecord => ({
	id,
	kind: "pi.tool-result",
	model: [{ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false, usage: over.usage, timestamp: over.timestamp }],
});

const window = (over: Partial<UsageSummaryInput> = {}): UsageSummaryInput => ({
	sinceDay: "2026-03-01" as UsageDay,
	untilDay: "2026-03-31" as UsageDay,
	timeZone: "UTC",
	...over,
});

const stateDir = tmpdir(); // a directory that exists, so `readVolumeId` yields a real `device:inode`.

describe("pi usage records (T3's pi reader mapping)", () => {
	it("attributes an assistant turn to provider/model, splits pi's disjoint counters, and clamps reasoning to output", () => {
		const records = usageRecordsOf(7, [
			assistant(1, { timestamp: D1, provider: "openai", model: "gpt-5", responseModel: "gpt-5-2026", usage: usage({ reasoning: 999 }) }),
		]);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			model: "openai/gpt-5-2026", // responseModel wins (T3's pi reader).
			sessionId: "7",
			reportedCostUsd: 0.57,
			totals: { uncachedInputTokens: 100, cachedInputTokens: 20, cacheCreationTokens: 10, outputTokens: 50, reasoningTokens: 50 },
		});
		expect(records[0]!.dedupeKey).toBe("1");
	});

	it("groups an unattributed tool result under Tools/summaries and drops a zero-token, zero-cost turn", () => {
		const records = usageRecordsOf(3, [
			toolResult(11, { timestamp: D1, usage: usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } }) }),
			assistant(12, { timestamp: D2, usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) }),
		]);
		expect(records.map((record) => record.model)).toEqual(["Tools/summaries"]); // the 0-token, 0-cost turn is dropped
	});
});

describe("getUsageSummary (buckets, cost source, dedupe, window)", () => {
	it("buckets by day in the client's zone, marks pi-reported cost, and reports the pi source", async () => {
		const summary = await summarizeUsage(
			window(),
			[
				{ conversationId: 100, entries: [assistant(1, { timestamp: D1 }), assistant(2, { timestamp: D2 })] },
				{ conversationId: 101, entries: [assistant(3, { timestamp: D2 })] },
			],
			stateDir,
		);
		expect(summary.sinceDay).toBe("2026-03-01");
		// One cell per day: every turn shares a model, so the two 03-11 turns collapse into one bucket.
		expect(summary.buckets.map((bucket) => bucket.day)).toEqual(["2026-03-10", "2026-03-11"]);
		// Two turns on 03-11 land in one cell; the cell spans two conversations, so it reports two sessions.
		const mar11 = summary.buckets.filter((bucket) => bucket.day === "2026-03-11");
		expect(mar11).toHaveLength(1);
		expect(mar11[0]).toMatchObject({ provider: "pi", records: 2, sessions: 2, costSource: "providerReported", costUsd: 1.14 });
		expect(mar11[0]!.categoryCostUsd).toMatchObject({ input: 0.6, output: 0.4, cacheRead: 0.04, cacheWrite: 0.1 });
		expect(summary.sources).toHaveLength(1);
		expect(summary.sources[0]).toMatchObject({ status: "ok", distinctSessions: 2, scannedFiles: 2, skippedFiles: 0 });
		expect(summary.sources[0]!.fingerprint.provider).toBe("pi");
		expect(summary.sources[0]!.fingerprint.volumeId).toMatch(/^\d+:\d+$/);
	});

	it("marks a zero-cost model as unpriced, with no category cost and the token split intact", async () => {
		const free = usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const summary = await summarizeUsage(window(), [{ conversationId: 1, entries: [assistant(1, { timestamp: D1, usage: free })] }], stateDir);
		expect(summary.buckets[0]).toMatchObject({ costSource: "unpriced", records: 1, unpricedRecords: 1, costUsd: 0 });
		expect(summary.buckets[0]!.categoryCostUsd).toBeUndefined();
		expect(summary.buckets[0]!.totals).toMatchObject({ uncachedInputTokens: 100, outputTokens: 50 });
	});

	it("counts a forked entry once across two conversations that share it", async () => {
		// Both threads' head views contain entry 5 (a fork shares its ancestor entries); dedupe keys on the entry id.
		const summary = await summarizeUsage(
			window(),
			[
				{ conversationId: 1, entries: [assistant(5, { timestamp: D1 })] },
				{ conversationId: 2, entries: [assistant(5, { timestamp: D1 }), assistant(6, { timestamp: D1 })] },
			],
			stateDir,
		);
		expect(summary.buckets[0]).toMatchObject({ records: 2 }); // entries 5 and 6, entry 5 not double-counted
	});

	it("filters by the requested day window", async () => {
		const summary = await summarizeUsage(
			window({ sinceDay: "2026-03-11" as UsageDay, untilDay: "2026-03-11" as UsageDay }),
			[{ conversationId: 1, entries: [assistant(1, { timestamp: D1 }), assistant(2, { timestamp: D2 })] }],
			stateDir,
		);
		expect(summary.buckets.map((bucket) => bucket.day)).toEqual(["2026-03-11"]);
	});

	it("buckets by hour over a 24-hour window and refuses an out-of-window instant", async () => {
		const sinceTime = "2026-03-10T00:00:00.000Z";
		const untilTime = "2026-03-11T00:00:00.000Z";
		const summary = await summarizeUsage(
			window({ resolution: "hour", sinceDay: "2026-03-10" as UsageDay, untilDay: "2026-03-11" as UsageDay, sinceTime, untilTime }),
			[
				{ conversationId: 1, entries: [assistant(1, { timestamp: Date.parse("2026-03-10T05:15:00Z") }), assistant(2, { timestamp: Date.parse("2026-03-12T05:15:00Z") })] },
			],
			stateDir,
		);
		// 05:15 lands in the 05:00 hour; the 03-12 turn is outside the 24-hour window.
		expect(summary.buckets).toHaveLength(1);
		expect(summary.buckets[0]).toMatchObject({ day: "2026-03-10", hourStart: "2026-03-10T05:00:00.000Z", records: 1 });
	});

	it("refuses an hourly window without instants, and an inverted day window, with the typed UsageReadError", async () => {
		await expect(summarizeUsage(window({ resolution: "hour" }), [], stateDir)).rejects.toBeInstanceOf(UsageReadError);
		await expect(
			summarizeUsage(window({ sinceDay: "2026-03-20" as UsageDay, untilDay: "2026-03-10" as UsageDay }), [], stateDir),
		).rejects.toBeInstanceOf(UsageReadError);
	});

	it("answers pricing truthfully: no rate table, because pi prices its own turns", () => {
		expect(piUsagePricing()).toMatchObject({ status: "unavailable", knownModels: 0, fetchedAt: null });
	});
});
