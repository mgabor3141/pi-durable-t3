// T3's sidebar rules that its server applies, for the thread state this host keeps (`threads.ts`): how an open is
// counted for the command palette (`@t3tools/shared/paletteSearch`'s `recordThreadOpen`, which the package does not
// export), and when a thread settles by itself (`ThreadSettlementService.ts`'s `resolveAutoSettlementAt`). Pull
// requests and snoozes, which settle or hold threads in T3, do not exist here.
import { DateTime } from "effect";
import type { OrchestrationV2ThreadShell, ServerSettings } from "@t3tools/contracts";
import type { ThreadOpens } from "../threads.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** An open counts half as much after two weeks (`SEARCH_RECENCY_HALF_LIFE_MS`). */
const OPEN_HALF_LIFE_MS = 14 * DAY_MS;
/** Opens closer together than this count once (`THREAD_OPEN_DEDUPE_MS`). */
const OPEN_DEDUPE_MS = 10 * 60 * 1000;
/** Picked queries are kept this long, at most this many, each this long (`PICK_WINDOW_MS` and its neighbours). */
const PICK_WINDOW_MS = 21 * DAY_MS;
const PICK_LIMIT = 3;
const PICK_MAX_LENGTH = 32;

const COMBINING_MARKS = /\p{M}/gu;
const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;

/** T3's `foldInPlace`: case and accents folded one UTF-16 unit at a time. */
function fold(text: string): string {
	return text
		.replace(/[\u0080-\uffff]/g, (character) => {
			const folded = character.normalize("NFKD").replace(COMBINING_MARKS, "").toLowerCase().replace("ς", "σ").replace(/[‘’]/, "'");
			return folded.length === 1 ? folded : character;
		})
		.toLowerCase();
}

/** T3's `pickedQuery`: the query folded, cut to the stored length without splitting a surrogate pair. */
function pickedQuery(query: string): string {
	const folded = fold(query.replace(WRAPPING_QUOTES, "").normalize("NFC"))
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.join(" ");
	const cut = folded.slice(0, PICK_MAX_LENGTH);
	return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

/** T3's `recordThreadOpen`: one more open at `at` (server clock), and the palette query that picked the thread. */
export function recordThreadOpen(previous: ThreadOpens | undefined, at: number, query: string | undefined): ThreadOpens {
	const pick = pickedQuery(query ?? "");
	const earlier = (previous?.picks ?? []).filter((entry) => at - entry.at <= PICK_WINDOW_MS);
	const picks = pick ? [{ query: pick, at }, ...earlier.filter((entry) => entry.query !== pick)].slice(0, PICK_LIMIT) : earlier;
	if (previous !== undefined && at - previous.openedAt < OPEN_DEDUPE_MS) return { ...previous, picks };
	const score = previous === undefined ? 1 : previous.score * 2 ** (-Math.max(0, at - previous.openedAt) / OPEN_HALF_LIFE_MS) + 1;
	return { openedAt: at, score, picks };
}

/** `sidebarAutoSettleAfterDays` for a project: its override when it sets one (`null` turns it off), else the server's. */
export function autoSettleDays(settings: ServerSettings, projectId: string): number | null {
	const override = (settings.projectSettingsOverrides as Record<string, { sidebarAutoSettleAfterDays?: number | null } | undefined>)[projectId]?.sidebarAutoSettleAfterDays;
	return override !== undefined ? override : settings.sidebarAutoSettleAfterDays;
}

const ms = (value: DateTime.Utc | null | undefined): number | null => (value == null ? null : DateTime.toEpochMillis(value));

/**
 * When a thread settles by itself (T3's `resolveAutoSettlementAt` without pull requests and snoozes): a thread nobody
 * settled, pinned or kept active, with no run going, whose last activity is more than `days` old. It settles as of that
 * activity, not as of now, so it sorts among the settled by when it went quiet. `null`: it does not settle.
 */
export function autoSettleAt(shell: OrchestrationV2ThreadShell, days: number, now: number): number | null {
	if (shell.archivedAt !== null || shell.settledOverride !== null) return null;
	if (shell.pinnedAt != null || shell.autoSettleDisabledAt != null) return null;
	if (shell.pendingRuntimeRequest !== null || shell.activityRunStatus != null || shell.status === "running") return null;
	const times = [shell.latestUserMessageAt, shell.latestRunRequestedAt, shell.latestRunStartedAt, shell.latestRunCompletedAt].map(ms).filter((value) => value !== null);
	const activityAt = times.length === 0 ? DateTime.toEpochMillis(shell.createdAt) : Math.max(...times);
	return activityAt < now - days * DAY_MS ? activityAt : null;
}
