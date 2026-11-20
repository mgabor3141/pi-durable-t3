// Scheduled tasks (T3's ScheduledTaskService + Schedule.ts, replicated for interval and fixed time): the schedule math,
// upsert idempotence, a due task dispatching exactly once, runNow while running, restart recovery (webhooks: task-webhooks.test.ts)
// and the change signal. A fake clock drives every test; the poll loop is never started, `tick()` is called directly.
import { mkdtemp, rm } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTaskError, type ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt, parseTimeOfDay } from "../src/t3/schedule.ts";
import { FRESH_SESSION_UNSUPPORTED, INTERRUPTED_BY_RESTART, MISSED_RUN, HELD_OCCURRENCE, SCHEDULED_MESSAGE_ID, ScheduledTasks, type ScheduledRunOutcome, type ScheduledTaskDispatch, FULL_ACCESS_ONLY, NO_PLAN_MODE, WORKTREES_UNSUPPORTED } from "../src/t3/scheduled-tasks.ts";

describe("schedule math (T3's Schedule.ts)", () => {
	it("parses 24-hour times", () => {
		expect(parseTimeOfDay("09:30")).toEqual({ hour: 9, minute: 30 });
		expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
		expect(parseTimeOfDay("25:00")).toBeNull();
	});

	it("an interval runs from the given instant, never faster than one minute", () => {
		const from = new Date("2026-07-01T16:00:00.000Z");
		expect(nextScheduledRunAt({ type: "interval", everyMs: 5 * 60_000 }, from)?.toISOString()).toBe("2026-07-01T16:05:00.000Z");
		expect(nextScheduledRunAt({ type: "interval", everyMs: 1_000 }, from)?.toISOString()).toBe("2026-07-01T16:01:00.000Z");
	});

	it("a fixed time is the next local HH:MM on an allowed weekday", () => {
		// Friday 3 July 2026, 10:00 local: weekdays at 09:00 → Monday 6 July 09:00.
		const next = nextScheduledRunAt({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }, new Date(2026, 6, 3, 10, 0));
		expect(next?.getDay()).toBe(1);
		expect([next?.getDate(), next?.getHours(), next?.getMinutes()]).toEqual([6, 9, 0]);
		// Daily, before today's time: today. At the exact time: tomorrow (strictly after).
		expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "9:30" }, new Date(2026, 6, 3, 9, 0))?.getTime()).toBe(new Date(2026, 6, 3, 9, 30).getTime());
		expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "09:30" }, new Date(2026, 6, 3, 9, 30))?.getTime()).toBe(new Date(2026, 6, 4, 9, 30).getTime());
		// Only Sundays, from a Sunday after the time: next Sunday.
		expect(nextScheduledRunAt({ type: "fixed_time", timeOfDay: "08:00", weekdays: [0] }, new Date(2026, 6, 5, 9, 0))?.getTime()).toBe(new Date(2026, 6, 12, 8, 0).getTime());
		expect(nextScheduledRunAt({ type: "webhook", signature: null }, new Date())).toBeNull();
	});

	it("a fixed-time run more than 10 minutes late is missed; intervals never are", () => {
		const fixed = { type: "fixed_time", timeOfDay: "09:00" } as const;
		const due = new Date("2026-07-01T09:00:00.000Z");
		expect(isMissedFixedTimeRun(fixed, due, new Date("2026-07-01T09:10:00.000Z"))).toBe(false);
		expect(isMissedFixedTimeRun(fixed, due, new Date("2026-07-01T09:10:00.001Z"))).toBe(true);
		expect(isMissedFixedTimeRun({ type: "interval", everyMs: 60_000 }, due, new Date("2026-07-01T15:00:00.000Z"))).toBe(false);
	});

	it("compares schedules structurally", () => {
		expect(isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 })).toBe(true);
		expect(isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 })).toBe(false);
		expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] }, { type: "fixed_time", timeOfDay: "9:00", weekdays: [1, 5, 5] })).toBe(true);
		expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00" }, { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(true);
		expect(isSameSchedule({ type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] }, { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] })).toBe(false);
		expect(isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "fixed_time", timeOfDay: "09:00" })).toBe(false);
	});
});

// ---- the service ---------------------------------------------------------------------------------------------

const dirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(BACKGROUND_CONTEXT).catch(() => {});
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

type Call = { kind: "launch" | "queue"; commandId: string; messageId: string; text: string; threadId?: string };

async function fixture(options: { dir?: string; dispatch?: Partial<ScheduledTaskDispatch> } = {}) {
	const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-")));
	if (options.dir === undefined) dirs.push(dir);
	const clock = { now: new Date("2026-07-01T12:00:00.000Z") };
	const calls: Call[] = [];
	const dispatch: ScheduledTaskDispatch = {
		launch: options.dispatch?.launch ?? (async (input) => void calls.push({ kind: "launch", ...input })),
		queue: options.dispatch?.queue ?? (async (input) => void calls.push({ kind: "queue", ...input })),
		isScratchProject: options.dispatch?.isScratchProject ?? ((projectId) => projectId === "scratch"),
		// Every thread a test names exists in project "p", unarchived, unless the test says otherwise.
		thread: options.dispatch?.thread ?? (async () => ({ projectId: "p", archived: false })),
		queuedOccurrence: options.dispatch?.queuedOccurrence ?? (async () => null),
		runOutcome: options.dispatch?.runOutcome ?? (async () => null),
	};
	const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "durable.db")), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
	harnesses.push(harness);
	const tasks = new ScheduledTasks({ harness, dispatch, now: () => new Date(clock.now) });
	await tasks.load();
	const advance = (ms: number) => {
		clock.now = new Date(clock.now.getTime() + ms);
	};
	return { dir, clock, calls, tasks, advance, harness };
}

const input = (overrides: Partial<ScheduledTaskUpsertInput> = {}): ScheduledTaskUpsertInput =>
	({
		title: "Standup",
		prompt: "Summarize yesterday",
		enabled: true,
		schedule: { type: "interval", everyMs: 60_000 },
		projectId: "p",
		threadId: null,
		workspaceStrategy: { type: "root" },
		modelSelection: { instanceId: "pi", model: "faux/model" },
		runtimeMode: "full-access",
		interactionMode: "default",
		creationSource: "web",
		...overrides,
	}) as ScheduledTaskUpsertInput;

describe("scheduled tasks (T3's ScheduledTaskService)", () => {
	it("thread modes (T3 0.1.9): a one-thread task keeps the thread its first run made; a fresh session each run is refused", async () => {
		const launched: string[] = [];
		const threads = new Map<string, { projectId: string; archived: boolean }>([["t-made", { projectId: "p", archived: false }]]);
		const { tasks, advance, calls } = await fixture({
			dispatch: {
				launch: async (launch) => {
					launched.push(launch.commandId);
					return "t-made";
				},
				thread: async (threadId) => threads.get(threadId),
			},
		});
		// No mode named, no thread: a new thread each run, as before thread modes.
		const each = (await tasks.upsert(input({ commandId: "each" as never }))).task;
		expect(each).toMatchObject({ threadMode: "new_thread", threadId: null });
		// One thread, continuing, with no thread yet: the first run makes it and the task keeps it.
		const one = (await tasks.upsert(input({ commandId: "one" as never, threadMode: "continue" }))).task;
		expect(one).toMatchObject({ threadMode: "continue", threadId: null });
		advance(60_000);
		await tasks.tick();
		expect(launched).toHaveLength(2);
		const byId = () => Object.fromEntries(tasks.list().tasks.map((task) => [task.id, task]));
		expect(byId()[one.id]).toMatchObject({ threadId: "t-made", threadMode: "continue", runCount: 1 });
		expect(byId()[each.id], "a task of new threads stays unbound").toMatchObject({ threadId: null, runCount: 1 });
		// Its next run goes to that thread, and an edit that names no thread keeps it (an older client may not have it yet).
		advance(60_000);
		await tasks.tick();
		expect(calls.filter((call) => call.kind === "queue").map((call) => call.threadId)).toEqual(["t-made"]);
		expect((await tasks.upsert(input({ id: one.id, requireExisting: true, title: "Renamed" }))).task).toMatchObject({ threadId: "t-made", threadMode: "continue" });
		// Switching to new threads unbinds it; naming a thread on such a task continues that thread.
		expect((await tasks.upsert(input({ id: one.id, requireExisting: true, threadMode: "new_thread" }))).task).toMatchObject({ threadId: null, threadMode: "new_thread" });
		expect((await tasks.upsert(input({ id: one.id, requireExisting: true, threadId: "t-made" as never }))).task).toMatchObject({ threadId: "t-made", threadMode: "continue" });

		// A destination must be a live, unarchived thread of the task's project (T3's `requireDestinationThread`).
		threads.set("t-archived", { projectId: "p", archived: true });
		threads.set("t-other", { projectId: "q", archived: false });
		await expect(tasks.upsert(input({ threadId: "t-gone" as never }))).rejects.toThrow("That thread no longer exists.");
		await expect(tasks.upsert(input({ threadId: "t-archived" as never }))).rejects.toThrow("That thread is archived.");
		await expect(tasks.upsert(input({ threadId: "t-other" as never }))).rejects.toThrow("That thread belongs to a different project.");
		// An unchanged destination is not rechecked: a task on a thread archived since stays editable.
		threads.set("t-made", { projectId: "p", archived: true });
		expect((await tasks.upsert(input({ id: one.id, requireExisting: true, threadId: "t-made" as never, title: "Still editable" }))).task.title).toBe("Still editable");

		// A fresh session each run needs a thread that can drop its context, which none here can: refused on save.
		await expect(tasks.upsert(input({ threadMode: "fresh_session" }))).rejects.toThrow(FRESH_SESSION_UNSUPPORTED);
		// A thread deleted before its binding landed takes the task with it, as a later deletion would.
		threads.delete("t-made");
		const late = (await tasks.upsert(input({ commandId: "late" as never, threadMode: "continue" }))).task;
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks.map((task) => task.id)).not.toContain(late.id);
	});

	it("upsert: a commandId replay is the same task with its run history; a title edit keeps nextRunAt, a schedule edit moves it", async () => {
		const { tasks, advance } = await fixture();
		const first = (await tasks.upsert(input({ commandId: "cmd-1" as never }))).task;
		expect(first.id).toBe("scheduled-task:cmd-1");
		expect(first.nextRunAt).toBe("2026-07-01T12:01:00.000Z");
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]!.runCount).toBe(1);

		advance(10_000);
		const replay = (await tasks.upsert(input({ commandId: "cmd-1" as never }))).task;
		expect(tasks.list().tasks).toHaveLength(1);
		expect(replay.runCount, "a replayed save keeps the run state").toBe(1);
		expect(replay.createdAt).toBe(first.createdAt);

		const before = replay.nextRunAt;
		advance(10_000);
		const renamed = (await tasks.upsert(input({ id: first.id, requireExisting: true, title: "Renamed" }))).task;
		expect(renamed.title).toBe("Renamed");
		expect(renamed.nextRunAt, "a title edit does not postpone the run").toBe(before);

		const rescheduled = (await tasks.upsert(input({ id: first.id, requireExisting: true, schedule: { type: "interval", everyMs: 120_000 } }))).task;
		expect(rescheduled.nextRunAt).not.toBe(before);

		await expect(tasks.upsert(input({ id: "scheduled-task:gone" as never, requireExisting: true }))).rejects.toThrow("Schedule task not found.");
	});

	it("a due task with no thread launches a new thread exactly once, then reschedules from the dispatch", async () => {
		const { tasks, calls, advance } = await fixture();
		const task = (await tasks.upsert(input())).task;
		await tasks.tick();
		expect(calls, "not yet due").toHaveLength(0);
		advance(60_000);
		await Promise.all([tasks.tick(), tasks.tick()]);
		await tasks.tick();
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.kind).toBe("launch");
		expect(call.text).toBe("Summarize yesterday");
		expect(call.commandId).toBe(`scheduled-task:${task.id}:${Date.parse("2026-07-01T12:01:00.000Z")}:scheduled`);
		expect(call.messageId).toBe(`scheduled-task-message:${task.id}:${Date.parse("2026-07-01T12:01:00.000Z")}:scheduled`);
		expect(SCHEDULED_MESSAGE_ID.exec(call.messageId)?.[1], "the projection reads the task back out of the message id").toBe(task.id);
		const after = tasks.list().tasks[0]!;
		expect(after).toMatchObject({ lastRunStatus: "succeeded", lastRunError: null, runCount: 1, lastRunAt: "2026-07-01T12:01:00.000Z", nextRunAt: "2026-07-01T12:02:00.000Z" });
	});

	it("a one-time task runs once at its time; a manual run before it does not use it up; a past time is refused", async () => {
		const { tasks, calls, advance } = await fixture();
		// Stored as UTC ISO, as T3 stores it.
		const task = (await tasks.upsert(input({ schedule: { type: "once", runAt: "2026-07-01T14:30:00+02:00" } }))).task;
		expect(task.schedule).toEqual({ type: "once", runAt: "2026-07-01T12:30:00.000Z" });
		expect(task.nextRunAt).toBe("2026-07-01T12:30:00.000Z");

		// A manual run at 12:10 leaves the 12:30 run in place.
		advance(10 * 60_000);
		await tasks.runNow({ id: task.id });
		expect(tasks.list().tasks[0]).toMatchObject({ runCount: 1, nextRunAt: "2026-07-01T12:30:00.000Z" });
		advance(20 * 60_000);
		await tasks.tick();
		expect(calls).toHaveLength(2);
		expect(tasks.list().tasks[0]).toMatchObject({ runCount: 2, nextRunAt: null, enabled: true });
		advance(60 * 60_000);
		await tasks.tick();
		expect(calls, "never again").toHaveLength(2);

		// Its time has passed: saving it enabled with a new past time, or turning it back on, is refused.
		await expect(tasks.upsert(input({ id: task.id, requireExisting: true, schedule: { type: "once", runAt: "2026-07-01T11:00:00Z" } }))).rejects.toThrow("The run time has passed. Pick a time in the future.");
		await tasks.setEnabled({ id: task.id, enabled: false });
		await expect(tasks.setEnabled({ id: task.id, enabled: true })).rejects.toThrow("The run time has passed.");
		expect(nextScheduledRunAt({ type: "once", runAt: "2026-07-01T13:00:00Z" }, new Date("2026-07-01T12:00:00Z"))?.toISOString()).toBe("2026-07-01T13:00:00.000Z");
		expect(isSameSchedule({ type: "once", runAt: "2026-07-01T15:00:00+02:00" }, { type: "once", runAt: "2026-07-01T13:00:00Z" })).toBe(true);
	});

	/** A dispatch whose runs end when the test says: `end(messageId, outcome)`. */
	function followedRuns() {
		const waiting = new Map<string, (outcome: ScheduledRunOutcome | null) => void>();
		const runOutcome: ScheduledTaskDispatch["runOutcome"] = (_threadId, messageId, timeoutMs, signal) =>
			new Promise((resolve) => {
				expect(timeoutMs, "T3 follows a run for up to a day").toBe(24 * 60 * 60_000);
				waiting.set(messageId, resolve);
				signal.addEventListener("abort", () => resolve(null), { once: true });
			});
		const end = async (messageId: string, outcome: ScheduledRunOutcome | null) => {
			for (let i = 0; i < 200 && !waiting.has(messageId); i++) await new Promise((resolve) => setTimeout(resolve, 5));
			waiting.get(messageId)!(outcome);
			waiting.delete(messageId);
			// The outcome is written after the follow wakes.
			await new Promise((resolve) => setTimeout(resolve, 20));
		};
		return { runOutcome, end, waiting };
	}

	it("a one-time task is removed once its scheduled run completes; one run by hand before its time is kept (T3 0.1.11)", async () => {
		const runs = followedRuns();
		const { tasks, calls, advance } = await fixture({
			dispatch: {
				runOutcome: runs.runOutcome,
				launch: async (launch) => {
					calls.push({ kind: "launch", ...launch });
					return "t-once";
				},
			},
		});
		const task = (await tasks.upsert(input({ schedule: { type: "once", runAt: "2026-07-01T12:30:00Z" } }))).task;
		// By hand at 12:10: its run completes, and the 12:30 run is still to come.
		advance(10 * 60_000);
		await tasks.runNow({ id: task.id });
		await runs.end(calls[0]!.messageId, { status: "completed", error: null });
		expect(tasks.list().tasks[0]).toMatchObject({ id: task.id, nextRunAt: "2026-07-01T12:30:00.000Z" });
		// At 12:30: the dispatch alone keeps it (the turn can still fail); its completed run removes it.
		advance(20 * 60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]).toMatchObject({ id: task.id, lastRunStatus: "succeeded", nextRunAt: null });
		await runs.end(calls[1]!.messageId, { status: "completed", error: null });
		expect(tasks.list().tasks).toEqual([]);

		// Paused, run by hand before its time: its `nextRunAt` is null, but the run was early, so it is kept.
		const paused = (await tasks.upsert(input({ schedule: { type: "once", runAt: "2026-07-01T14:00:00Z" } }))).task;
		await tasks.setEnabled({ id: paused.id, enabled: false });
		await tasks.runNow({ id: paused.id });
		await runs.end(calls[2]!.messageId, { status: "completed", error: null });
		expect(tasks.list().tasks.map((kept) => kept.id)).toEqual([paused.id]);

		// A host that stops stops following: the wait ends with nothing recorded.
		advance(1_000);
		await tasks.runNow({ id: paused.id });
		expect(runs.waiting.size).toBe(1);
		await tasks.stop();
		expect(tasks.list().tasks[0]).toMatchObject({ id: paused.id, lastRunStatus: "succeeded", runCount: 2 });
	});

	it("a run that does not complete after its message was accepted fails the task, with its provider's error or T3's words (T3 0.1.11)", async () => {
		const runs = followedRuns();
		let occurrence: "queued" | "held" | null = null;
		const { tasks, calls, advance } = await fixture({ dispatch: { runOutcome: runs.runOutcome, queuedOccurrence: async () => occurrence } });
		const task = (await tasks.upsert(input({ threadId: "t1" as never }))).task;
		const cases: [ScheduledRunOutcome, string][] = [
			[{ status: "failed", error: "Weekly usage limit reached" }, "Weekly usage limit reached"],
			[{ status: "failed", error: null }, "The run failed."],
			[{ status: "interrupted", error: null }, "The run was stopped."],
			[{ status: "cancelled", error: null }, "The run was cancelled."],
			[{ status: "rolled_back", error: null }, "The run was rolled back."],
		];
		for (const [outcome, error] of cases) {
			advance(1_000);
			await tasks.runNow({ id: task.id });
			const before = tasks.list().tasks[0]!;
			expect(before).toMatchObject({ lastRunStatus: "succeeded", lastRunError: null });
			await runs.end(calls.at(-1)!.messageId, outcome);
			// Only the run's status and error: not its count, its time, or the task's place in the list.
			expect(tasks.list().tasks[0]).toEqual({ ...before, lastRunStatus: "failed", lastRunError: error });
		}
		// A held occurrence (#38906) is recorded over the run without changing its time: the run's end still replaces it.
		occurrence = null;
		advance(60_000);
		await tasks.tick();
		const scheduled = calls.at(-1)!.messageId;
		occurrence = "held";
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: HELD_OCCURRENCE });
		await runs.end(scheduled, { status: "failed", error: "Provider overloaded" });
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: "Provider overloaded" });
		occurrence = null;
		// A later run since: the earlier run's end is not this one's.
		advance(1_000);
		await tasks.runNow({ id: task.id });
		const earlier = calls.at(-1)!.messageId;
		advance(1_000);
		await tasks.runNow({ id: task.id });
		await runs.end(earlier, { status: "failed", error: "too late" });
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "succeeded", lastRunError: null });
		// Nothing to record (a message sent as a steer, a thread gone, a day passed): the dispatch's record stands.
		await runs.end(calls.at(-1)!.messageId, null);
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "succeeded", lastRunError: null });
	});

	it("a task bound to a thread queues the prompt there; a failed dispatch is a failed run", async () => {
		let fail = false;
		const queued: Call[] = [];
		const { tasks, advance } = await fixture({
			dispatch: {
				queue: async (call) => {
					if (fail) throw new Error("Thread t1 was not found in project p.");
					queued.push({ kind: "queue", ...call });
				},
			},
		});
		await tasks.upsert(input({ threadId: "t1" as never }));
		advance(60_000);
		await tasks.tick();
		expect(queued.map((call) => [call.kind, call.threadId])).toEqual([["queue", "t1"]]);
		expect(queued[0], "a bound run follows the thread's model (T3 passes none)").not.toHaveProperty("modelSelection");
		fail = true;
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: "Thread t1 was not found in project p.", runCount: 2 });
	});

	it("runNow while a run is in flight is refused; a paused task is not run by the poll", async () => {
		let release!: () => void;
		const { tasks, advance } = await fixture({ dispatch: { launch: () => new Promise<void>((resolve) => (release = resolve)) } });
		const task = (await tasks.upsert(input())).task;
		const first = tasks.runNow({ id: task.id });
		expect(tasks.list().tasks[0]!.lastRunStatus).toBe("running");
		const second = await tasks.runNow({ id: task.id }).catch((error: unknown) => error);
		expect(second).toBeInstanceOf(ScheduledTaskError);
		expect((second as ScheduledTaskError).message).toBe("Could not run schedule task.");
		expect(((second as ScheduledTaskError).cause as Error).message).toBe("Schedule task is already running.");
		// The dispatch starts once the run's mark is stored.
		while (typeof release !== "function") await new Promise((resolve) => setTimeout(resolve, 5));
		release();
		expect((await first).task.lastRunStatus).toBe("succeeded");

		await tasks.setEnabled({ id: task.id, enabled: false });
		expect(tasks.list().tasks[0]!.nextRunAt).toBeNull();
		advance(10 * 60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]!.runCount).toBe(1);
	});

	it("a missed fixed-time run (> 10 min late) is rescheduled, not run late, and recorded as failed", async () => {
		const { tasks, calls, clock } = await fixture();
		clock.now = new Date(2026, 6, 1, 8, 0);
		await tasks.upsert(input({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }));
		clock.now = new Date(2026, 6, 1, 9, 5);
		await tasks.tick();
		expect(calls, "within the grace window it runs").toHaveLength(1);
		clock.now = new Date(2026, 6, 2, 11, 0);
		await tasks.tick();
		expect(calls).toHaveLength(1);
		expect(tasks.list().tasks[0]).toMatchObject({ nextRunAt: new Date(2026, 6, 3, 9, 0).toISOString(), lastRunStatus: "failed", lastRunError: MISSED_RUN, runCount: 1 });
		// The list names the zone fixed times are in (T3 0.1.11): the host's.
		expect(tasks.list().timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	it("a recurring task bound to a thread does not queue another copy while one still waits; a held one fails the task (T3 #38906)", async () => {
		let occurrence: "queued" | "held" | null = null;
		const { tasks, calls, advance } = await fixture({ dispatch: { queuedOccurrence: async () => occurrence } });
		const task = (await tasks.upsert(input({ threadId: "t1" as never }))).task;
		advance(60 * 60_000);
		await tasks.tick();
		expect(calls.map((call) => call.kind)).toEqual(["queue"]);
		// The last copy still waits: this hour is skipped, the next one kept, and the task's last run is unchanged.
		occurrence = "queued";
		advance(60 * 60_000);
		await tasks.tick();
		expect(calls).toHaveLength(1);
		const skipped = tasks.list().tasks[0]!;
		expect(skipped).toMatchObject({ lastRunStatus: "succeeded", lastRunError: null, runCount: 1 });
		expect(Date.parse(skipped.nextRunAt!)).toBeGreaterThan(Date.parse(task.nextRunAt!) + 60 * 60_000);
		// Held behind a Stop: the task says so.
		occurrence = "held";
		advance(60 * 60_000);
		await tasks.tick();
		expect(calls).toHaveLength(1);
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: HELD_OCCURRENCE, runCount: 1 });
		// A manual run is not held back; and once the queue is empty the schedule queues again.
		await tasks.runNow({ id: task.id });
		occurrence = null;
		advance(60 * 60_000);
		await tasks.tick();
		expect(calls.map((call) => call.kind)).toEqual(["queue", "queue", "queue"]);
	});

	it("a skip waits on the queue read without undoing what happened meanwhile: a deleted task stays deleted, an edit stays", async () => {
		let release!: () => void;
		let gate = new Promise<void>((resolve) => (release = resolve));
		let reading = false;
		const { tasks, advance } = await fixture({
			dispatch: {
				queuedOccurrence: async () => {
					reading = true;
					await gate;
					return "held";
				},
			},
		});
		const waitReading = async () => {
			while (!reading) await new Promise((resolve) => setTimeout(resolve, 5));
			reading = false;
		};
		const deleted = (await tasks.upsert(input({ threadId: "t1" as never }))).task;
		advance(60 * 60_000);
		let tick = tasks.tick();
		await waitReading();
		await tasks.delete({ id: deleted.id });
		release();
		await tick;
		expect(tasks.list().tasks.map((task) => task.id), "the deleted task stays deleted").not.toContain(deleted.id);

		gate = new Promise<void>((resolve) => (release = resolve));
		const edited = (await tasks.upsert(input({ threadId: "t1" as never, title: "Other" }))).task;
		advance(60 * 60_000);
		tick = tasks.tick();
		await waitReading();
		await tasks.upsert(input({ id: edited.id, threadId: "t1" as never, title: "Renamed meanwhile" }));
		release();
		await tick;
		expect(tasks.list().tasks.find((task) => task.id === edited.id)).toMatchObject({ title: "Renamed meanwhile", lastRunStatus: "failed", lastRunError: HELD_OCCURRENCE });
	});

	it("restart: a task left running is recorded failed and rescheduled; the document round-trips", async () => {
		const { dir, tasks, harness } = await fixture({ dispatch: { launch: () => new Promise<void>(() => {}) } });
		const task = (await tasks.upsert(input())).task;
		void tasks.runNow({ id: task.id });
		// The run's mark is stored before its dispatch: the process dies there.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await harness.close(BACKGROUND_CONTEXT);

		const reopened = (await fixture({ dir })).tasks;
		expect(reopened.list().tasks[0]).toMatchObject({ id: task.id, lastRunStatus: "failed", lastRunError: INTERRUPTED_BY_RESTART, runCount: 1, nextRunAt: "2026-07-01T12:01:00.000Z" });
	});

	it("a worktree workspace is refused: every run is at the project root", async () => {
		const { tasks } = await fixture();
		await expect(tasks.upsert(input({ workspaceStrategy: { type: "worktree", baseRef: "main" } as never }))).rejects.toThrow(WORKTREES_UNSUPPORTED);
		expect(tasks.list().tasks).toHaveLength(0);
	});

	it("a worktree asked of the Scratch project is stored as the root, as T3 does", async () => {
		const { tasks } = await fixture();
		const { task } = await tasks.upsert(input({ projectId: "scratch" as never, workspaceStrategy: { type: "worktree", baseRef: "main" } as never }));
		expect(task.workspaceStrategy).toEqual({ type: "root" });
	});

	it("a mode pi does not have is refused, like the thread commands", async () => {
		const { tasks } = await fixture();
		await expect(tasks.upsert(input({ runtimeMode: "approval-required" }))).rejects.toThrow(FULL_ACCESS_ONLY);
		await expect(tasks.upsert(input({ interactionMode: "plan" }))).rejects.toThrow(NO_PLAN_MODE);
		expect(tasks.list().tasks).toHaveLength(0);
	});

	it("a delete whose commit fails keeps the task: memory follows the store", async () => {
		const { tasks, harness } = await fixture();
		const task = (await tasks.upsert(input())).task;
		await harness.close(BACKGROUND_CONTEXT);
		await expect(tasks.delete({ id: task.id })).rejects.toThrow("Could not delete schedule task.");
		expect(tasks.list().tasks.map((t) => t.id)).toEqual([task.id]);
	});

	it("every change signals subscribers: upsert, toggle, run, delete", async () => {
		const { tasks, advance } = await fixture();
		let changes = 0;
		const stop = tasks.onChange(() => changes++);
		const task = (await tasks.upsert(input())).task;
		expect(changes).toBe(1);
		await tasks.setEnabled({ id: task.id, enabled: false });
		await tasks.setEnabled({ id: task.id, enabled: false });
		expect(changes, "an unchanged toggle is a no-op").toBe(2);
		await tasks.setEnabled({ id: task.id, enabled: true });
		advance(60_000);
		await tasks.tick();
		expect(changes, "running, then the result").toBe(5);
		await tasks.delete({ id: task.id });
		expect(changes).toBe(6);
		expect(tasks.list().tasks).toHaveLength(0);
		stop();
	});
});
