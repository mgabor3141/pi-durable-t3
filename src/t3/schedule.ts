// T3's schedule math (apps/server/src/scheduledTasks/Schedule.ts), ported to `Date` on the host's local wall clock —
// T3 evaluates it in the server's local zone too (`DateTime.withCurrentZoneLocal`).
import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
	const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
	if (!match) return null;
	return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** The next occurrence strictly after `from`: interval = `from + max(everyMs, 1 min)`; fixed time = the first local
 * HH:MM after `from` (today through a week out) on an allowed weekday (0 = Sunday). Webhooks have none. */
export function nextScheduledRunAt(schedule: ScheduledTaskSchedule, from: Date): Date | null {
	if (schedule.type === "webhook") return null;
	if (schedule.type === "interval") {
		// Stored rows from before the one-minute floor stay readable but never run faster than it.
		return new Date(from.getTime() + Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
	}
	const time = parseTimeOfDay(schedule.timeOfDay);
	if (time === null) return null;
	const weekdays = schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
	for (let offset = 0; offset <= 7; offset += 1) {
		const candidate = new Date(from.getTime());
		candidate.setDate(candidate.getDate() + offset);
		candidate.setHours(time.hour, time.minute, 0, 0);
		if (candidate.getTime() <= from.getTime()) continue;
		if (weekdays !== null && !weekdays.has(candidate.getDay())) continue;
		return candidate;
	}
	return null;
}

function weekdayKey(weekdays: readonly number[] | undefined): string {
	const unique = [...new Set(weekdays ?? [])].sort((x, y) => x - y);
	if (unique.length === 0 || unique.length === 7) return "daily";
	return unique.join(",");
}

/** Structural equality: parsed time ("9:00" = "09:00") and weekday set (none = all seven = daily). */
export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
	if (a.type === "interval") return b.type === "interval" && a.everyMs === b.everyMs;
	if (a.type === "webhook") return b.type === "webhook";
	if (b.type !== "fixed_time") return false;
	const aTime = parseTimeOfDay(a.timeOfDay);
	const bTime = parseTimeOfDay(b.timeOfDay);
	return aTime !== null && bTime !== null && aTime.hour === bTime.hour && aTime.minute === bTime.minute && weekdayKey(a.weekdays) === weekdayKey(b.weekdays);
}

/** A fixed-time run more than 10 minutes overdue is skipped and rescheduled, never run late. */
export function isMissedFixedTimeRun(schedule: ScheduledTaskSchedule, dueAt: Date, now: Date): boolean {
	if (schedule.type !== "fixed_time") return false;
	return now.getTime() - dueAt.getTime() > MISSED_FIXED_TIME_GRACE_MS;
}
