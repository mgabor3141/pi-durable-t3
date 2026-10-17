// `server.getUsageSummary` / `server.refreshUsageRates`, answered from what pi-durable records per turn.
//
// T3's UsageService scans provider transcript directories and prices them against a fetched LiteLLM rate table
// (`apps/server/src/usage/UsageService.ts`). This host has neither a transcript directory of that shape nor model
// rates: pi-durable records the tokens and the cost of every turn on the assistant message it stores. So the
// day/hour bucketing, de-duplication, window checks and `costSource` resolution are replicated faithfully from
// T3's `usageAggregation.ts`; the pricing is not — pi reports cost itself, so a bucket is `providerReported` when pi
// gave a positive cost and `unpriced` when it did not (never a LiteLLM estimate we cannot compute). The field
// mapping from pi's `Usage` to T3's totals mirrors T3's own pi reader (`packages/provider-pi/src/server/usage.ts`).
// Fields pi has no value for (cache savings, fast/ultrafast speed tiers) are omitted per the contract, not invented.
import { hostname } from "node:os";
import { stat } from "node:fs/promises";
import {
	USAGE_CONTRACT_VERSION,
	UsageReadError,
	type UsageBucket,
	type UsageCategoryCost,
	type UsageDay,
	type UsagePricing,
	type UsageSource,
	type UsageSummary,
	type UsageSummaryInput,
	type UsageTokenTotals,
} from "@t3tools/contracts";
import type { EntryRecord, PiUsage } from "./model-types.ts";
import { firstMessage } from "./runs.ts";

/** T3's pricing source (`UsageService.ts`, `LITELLM_RATES_URL`). We never fetch it: pi prices its own turns, so this
 * host reports no model rate table (status `unavailable`, zero known models), and every priced record is
 * `providerReported`. The string is kept as T3's so the field is a real source id, not an invented one. */
export const PRICING_SOURCE = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** The host's own pi-reported cost, in USD, for a turn: pi defaults missing catalog rates to zero, so a non-positive
 * cost is `null` (T3's pi reader: `reportedCostUsd`). */
function reportedCostUsd(usage: PiUsage): number | null {
	const total = usage.cost?.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
}

/** pi's counters are already disjoint; `reasoning` is a subset of `output` and is clamped to it (T3's pi reader). */
function totalsOf(usage: PiUsage): UsageTokenTotals {
	const output = usage.output;
	return {
		uncachedInputTokens: usage.input,
		cachedInputTokens: usage.cacheRead,
		cacheCreationTokens: usage.cacheWrite,
		outputTokens: output,
		reasoningTokens: Math.min(output, usage.reasoning ?? 0),
	};
}

const tokenTotal = (t: UsageTokenTotals): number =>
	t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;

/** One turn's usage, as T3's aggregator consumes it (`UsageRecord` in provider-core, minus the fields this host has
 * no source for). `reportedCostUsd === null` marks a turn pi recorded no positive cost for: it is `unpriced`. */
export interface UsageRecord {
	readonly timestampMs: number;
	/** `provider/model` for a turn, or T3's `Tools/summaries` label for an unattributed tool/summary record. */
	readonly model: string;
	readonly sessionId: string;
	readonly totals: UsageTokenTotals;
	readonly reportedCostUsd: number | null;
	/** pi's own per-category cost (input/cacheRead/cacheWrite/output), present only when it reported a cost. */
	readonly categoryCostUsd: UsageCategoryCost | null;
	/** Globally unique (a pi-durable entry id), so a fork that shares an entry with its parent is counted once. */
	readonly dedupeKey: string;
}

/** pi's per-category cost, read straight off the reported `cost` breakdown (never a rate estimate). */
function categoryCostOf(usage: PiUsage): UsageCategoryCost | null {
	const c = usage.cost;
	if (c === undefined) return null;
	const pick = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return { input: pick(c.input), cacheRead: pick(c.cacheRead), cacheWrite: pick(c.cacheWrite), output: pick(c.output) };
}

/**
 * The usage records of one conversation. An assistant turn is attributed to `provider/model` (pi's `responseModel`
 * when it set one, matching T3's pi reader); a tool result that carries usage is unattributed and lands under
 * `Tools/summaries`, exactly as T3 groups pi's auxiliary records. A record with no tokens and no reported cost is
 * dropped (T3's pi reader skips it).
 */
export function usageRecordsOf(conversationId: number, entries: readonly EntryRecord[]): UsageRecord[] {
	const sessionId = String(conversationId);
	const records: UsageRecord[] = [];
	for (const entry of entries) {
		const message = firstMessage(entry);
		if (message === undefined || message.timestamp === undefined) continue;
		const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
		if (usage === undefined) continue;
		const model =
			message.role === "assistant" && message.provider !== undefined && message.model !== undefined
				? `${message.provider}/${message.responseModel ?? message.model}`
				: "Tools/summaries";
		const totals = totalsOf(usage);
		const reported = reportedCostUsd(usage);
		if (tokenTotal(totals) === 0 && reported === null) continue;
		records.push({
			timestampMs: message.timestamp,
			model,
			sessionId,
			totals,
			reportedCostUsd: reported,
			categoryCostUsd: reported === null ? null : categoryCostOf(usage),
			dedupeKey: String(entry.id),
		});
	}
	return records;
}

interface MutableBucket {
	totals: { -readonly [K in keyof UsageTokenTotals]: number };
	costUsd: number;
	categoryCostUsd: UsageCategoryCost | null;
	records: number;
	unpricedRecords: number;
	providerReportedRecords: number;
	sessions: Set<string>;
}

/**
 * Days in the client's zone, in ISO order — T3's exact formatter (en-CA parts, cached per quarter-hour slot so a
 * named zone formats once and a split slot formats per record). Ported from `usageAggregation.ts`.
 */
function makeDayFormatter(timeZone: string): (timestampMs: number) => string {
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
	} catch {
		format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
	}
	const days = new Map<number, string | null>();
	return (timestampMs) => {
		const slot = Math.floor(timestampMs / QUARTER_HOUR_MS);
		let day = days.get(slot);
		if (day === undefined) {
			const first = format.format(new Date(slot * QUARTER_HOUR_MS));
			const last = format.format(new Date((slot + 1) * QUARTER_HOUR_MS - 1));
			day = first === last ? first : null;
			days.set(slot, day);
		}
		return day ?? format.format(new Date(timestampMs));
	};
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** T3's hourly cap (`MAX_HOURLY_WINDOW_MS`). */
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

const invalidWindow = (detail: string): UsageReadError => new UsageReadError({ reason: "invalidWindow", detail });

/** Validate the window and resolve the exact hourly bounds, exactly as T3's `scanSummary` decides them. */
function resolveWindow(input: UsageSummaryInput): { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null {
	if (input.sinceDay > input.untilDay) {
		throw invalidWindow(`sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`);
	}
	if (input.resolution !== "hour") return null;
	const sinceTimeMs = input.sinceTime === undefined ? Number.NaN : Date.parse(input.sinceTime);
	const untilTimeMs = input.untilTime === undefined ? Number.NaN : Date.parse(input.untilTime);
	if (Number.isNaN(sinceTimeMs) || Number.isNaN(untilTimeMs)) {
		throw invalidWindow("Hourly usage requires valid sinceTime and untilTime instants");
	}
	const durationMs = untilTimeMs - sinceTimeMs;
	if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
		throw invalidWindow("Hourly usage window must be greater than zero and at most 24 hours");
	}
	return { sinceTimeMs, untilTimeMs };
}

function roundUsd(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function resolveCostSource(bucket: MutableBucket): UsageBucket["costSource"] {
	if (bucket.unpricedRecords === bucket.records) return "unpriced";
	if (bucket.providerReportedRecords === bucket.records) return "providerReported";
	return "modelPriced";
}

/** The buckets for a window — T3's `UsageAggregator`, with pi's reported cost in place of rate-table pricing. */
function aggregate(records: readonly UsageRecord[], input: UsageSummaryInput): readonly UsageBucket[] {
	const hourly = resolveWindow(input);
	if (hourly === null && Number.isNaN(Date.parse(`${input.sinceDay}T00:00:00Z`))) {
		throw invalidWindow(`sinceDay '${input.sinceDay}' is not a valid date`);
	}
	const toDay = makeDayFormatter(input.timeZone);
	const buckets = new Map<string, MutableBucket>();
	const seen = new Set<string>();

	for (const record of records) {
		if (record.dedupeKey.length > 0) {
			if (seen.has(record.dedupeKey)) continue;
			seen.add(record.dedupeKey);
		}
		if (hourly !== null && (record.timestampMs < hourly.sinceTimeMs || record.timestampMs >= hourly.untilTimeMs)) {
			continue;
		}
		const day = toDay(record.timestampMs);
		if (hourly === null && (day < input.sinceDay || day > input.untilDay)) continue;

		const hourIndex = hourly === null ? -1 : Math.floor((record.timestampMs - hourly.sinceTimeMs) / HOUR_MS);
		const hourStart = hourly === null ? "" : new Date(hourly.sinceTimeMs + hourIndex * HOUR_MS).toISOString();
		const key = `${day}\u0000${hourStart}\u0000${record.model}`;

		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = {
				totals: { uncachedInputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0 },
				costUsd: 0,
				categoryCostUsd: null,
				records: 0,
				unpricedRecords: 0,
				providerReportedRecords: 0,
				sessions: new Set<string>(),
			};
			buckets.set(key, bucket);
		}
		const totals = bucket.totals;
		totals.uncachedInputTokens += record.totals.uncachedInputTokens;
		totals.cachedInputTokens += record.totals.cachedInputTokens;
		totals.cacheCreationTokens += record.totals.cacheCreationTokens;
		totals.outputTokens += record.totals.outputTokens;
		totals.reasoningTokens += record.totals.reasoningTokens;
		bucket.costUsd += record.reportedCostUsd ?? 0;
		const add = record.categoryCostUsd;
		if (add !== null) {
			const sum = bucket.categoryCostUsd;
			bucket.categoryCostUsd = sum === null
				? { ...add }
				: {
						input: sum.input + add.input,
						cacheRead: sum.cacheRead + add.cacheRead,
						cacheWrite: sum.cacheWrite + add.cacheWrite,
						output: sum.output + add.output,
					};
		}
		bucket.records += 1;
		if (record.reportedCostUsd === null) bucket.unpricedRecords += 1;
		else bucket.providerReportedRecords += 1;
		if (record.sessionId.length > 0) bucket.sessions.add(record.sessionId);
	}

	const out: UsageBucket[] = [];
	for (const [key, bucket] of buckets) {
		const [day = "", hourStart = "", model = ""] = key.split("\u0000");
		const category = bucket.categoryCostUsd;
		out.push({
			day: day as UsageDay,
			...(hourStart === "" ? {} : { hourStart }),
			provider: "pi",
			model,
			totals: { ...bucket.totals },
			costUsd: bucket.costUsd,
			// pi reports no cache-savings figure and this host prices nothing: it is genuinely zero, not a missing value.
			cacheSavingsUsd: 0,
			...(category === null
				? {}
				: {
						categoryCostUsd: {
							input: roundUsd(category.input),
							cacheRead: roundUsd(category.cacheRead),
							cacheWrite: roundUsd(category.cacheWrite),
							output: roundUsd(category.output),
						},
					}),
			costSource: resolveCostSource(bucket),
			records: bucket.records,
			unpricedRecords: bucket.unpricedRecords,
			sessions: bucket.sessions.size,
		});
	}
	out.sort(
		(a, b) =>
			a.day.localeCompare(b.day) ||
			(a.hourStart ?? "").localeCompare(b.hourStart ?? "") ||
			a.model.localeCompare(b.model),
	);
	return out;
}

/** The filesystem identity of a directory as `device:inode` (T3's `readDirectoryVolumeId`); `""` when it cannot be read. */
export async function readVolumeId(path: string): Promise<string> {
	try {
		const info = await stat(path);
		return `${info.dev}:${info.ino}`;
	} catch {
		return "";
	}
}

/** This host's single usage source: pi, rooted at the bridge's state dir (where its conversations are stored). */
function piSource(stateDir: string, volumeId: string, sessions: number, scannedFiles: number, skippedFiles: number): UsageSource {
	return {
		fingerprint: { hostId: hostname(), provider: "pi", resolvedHomePath: stateDir, volumeId },
		status: "ok",
		scannedFiles,
		skippedFiles,
		malformedRecords: 0,
		distinctSessions: sessions,
		message: null,
	};
}

/** The pricing this host reports: no model rate table, because pi prices its own turns (see `PRICING_SOURCE`). */
export function piUsagePricing(): UsagePricing {
	return { status: "unavailable", source: PRICING_SOURCE, fetchedAt: null, knownModels: 0 };
}

/**
 * `server.getUsageSummary`, answered from pi-durable's per-turn records. One `pi` source; buckets by day (client's
 * zone) or by hour. Fails with T3's typed `UsageReadError` for an invalid window (the client shows it); a scan that
 * throws while reading threads surfaces as `scanFailed`.
 */
export async function summarizeUsage(
	input: UsageSummaryInput,
	conversations: readonly { readonly conversationId: number; readonly entries: readonly EntryRecord[] }[],
	stateDir: string,
): Promise<UsageSummary> {
	const startedAt = Date.now();
	const readAt = new Date(startedAt).toISOString();
	// Every conversation contributes a source session; a conversation with usage is a scanned "file", one without is skipped.
	const records: UsageRecord[] = [];
	const sessions = new Set<string>();
	let scannedFiles = 0;
	let skippedFiles = 0;
	for (const conversation of conversations) {
		const conversationRecords = usageRecordsOf(conversation.conversationId, conversation.entries);
		if (conversationRecords.length === 0) skippedFiles += 1;
		else {
			scannedFiles += 1;
			sessions.add(String(conversation.conversationId));
			records.push(...conversationRecords);
		}
	}
	const volumeId = await readVolumeId(stateDir);
	return {
		contractVersion: USAGE_CONTRACT_VERSION,
		readAt,
		timeZone: input.timeZone,
		sinceDay: input.sinceDay,
		untilDay: input.untilDay,
		buckets: aggregate(records, input),
		sources: [piSource(stateDir, volumeId, sessions.size, scannedFiles, skippedFiles)],
		pricing: piUsagePricing(),
		scanDurationMs: Math.max(0, Date.now() - startedAt),
	};
}
