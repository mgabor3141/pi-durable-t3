// Scheduled tasks (T3's ScheduledTaskService + Schedule.ts, replicated for interval and fixed time): the schedule math,
// upsert idempotence, a due task dispatching exactly once, runNow while running, restart recovery, the webhook refusal
// and the change signal. A fake clock drives every test; the poll loop is never started, `tick()` is called directly.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTaskError, type ScheduledTaskUpsertInput } from "@t3tools/contracts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt, parseTimeOfDay } from "../src/t3/schedule.ts";
import { INTERRUPTED_BY_RESTART, SCHEDULED_MESSAGE_ID, ScheduledTasks, type ScheduledTaskDispatch, FULL_ACCESS_ONLY, NO_PLAN_MODE, WEBHOOKS_UNSUPPORTED, WORKTREES_UNSUPPORTED } from "../src/t3/scheduled-tasks.ts";

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
afterEach(async () => {
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
	};
	const tasks = new ScheduledTasks({ stateDir: dir, dispatch, now: () => new Date(clock.now) });
	const advance = (ms: number) => {
		clock.now = new Date(clock.now.getTime() + ms);
	};
	return { dir, clock, calls, tasks, advance };
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
	it("upsert: a commandId replay is the same task with its run history; a title edit keeps nextRunAt, a schedule edit moves it", async () => {
		const { tasks, advance } = await fixture();
		const first = tasks.upsert(input({ commandId: "cmd-1" as never })).task;
		expect(first.id).toBe("scheduled-task:cmd-1");
		expect(first.nextRunAt).toBe("2026-07-01T12:01:00.000Z");
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]!.runCount).toBe(1);

		advance(10_000);
		const replay = tasks.upsert(input({ commandId: "cmd-1" as never })).task;
		expect(tasks.list().tasks).toHaveLength(1);
		expect(replay.runCount, "a replayed save keeps the run state").toBe(1);
		expect(replay.createdAt).toBe(first.createdAt);

		const before = replay.nextRunAt;
		advance(10_000);
		const renamed = tasks.upsert(input({ id: first.id, requireExisting: true, title: "Renamed" })).task;
		expect(renamed.title).toBe("Renamed");
		expect(renamed.nextRunAt, "a title edit does not postpone the run").toBe(before);

		const rescheduled = tasks.upsert(input({ id: first.id, requireExisting: true, schedule: { type: "interval", everyMs: 120_000 } })).task;
		expect(rescheduled.nextRunAt).not.toBe(before);

		expect(() => tasks.upsert(input({ id: "scheduled-task:gone" as never, requireExisting: true }))).toThrow("Schedule task not found.");
	});

	it("a due task with no thread launches a new thread exactly once, then reschedules from the dispatch", async () => {
		const { tasks, calls, advance } = await fixture();
		const task = tasks.upsert(input()).task;
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
		tasks.upsert(input({ threadId: "t1" as never }));
		advance(60_000);
		await tasks.tick();
		expect(queued.map((call) => [call.kind, call.threadId])).toEqual([["queue", "t1"]]);
		fail = true;
		advance(60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]).toMatchObject({ lastRunStatus: "failed", lastRunError: "Thread t1 was not found in project p.", runCount: 2 });
	});

	it("runNow while a run is in flight is refused; a paused task is not run by the poll", async () => {
		let release!: () => void;
		const { tasks, advance } = await fixture({ dispatch: { launch: () => new Promise<void>((resolve) => (release = resolve)) } });
		const task = tasks.upsert(input()).task;
		const first = tasks.runNow({ id: task.id });
		expect(tasks.list().tasks[0]!.lastRunStatus).toBe("running");
		const second = await tasks.runNow({ id: task.id }).catch((error: unknown) => error);
		expect(second).toBeInstanceOf(ScheduledTaskError);
		expect((second as ScheduledTaskError).message).toBe("Could not run schedule task.");
		expect(((second as ScheduledTaskError).cause as Error).message).toBe("Schedule task is already running.");
		release();
		expect((await first).task.lastRunStatus).toBe("succeeded");

		tasks.setEnabled({ id: task.id, enabled: false });
		expect(tasks.list().tasks[0]!.nextRunAt).toBeNull();
		advance(10 * 60_000);
		await tasks.tick();
		expect(tasks.list().tasks[0]!.runCount).toBe(1);
	});

	it("a missed fixed-time run (> 10 min late) is rescheduled, not run late", async () => {
		const { tasks, calls, clock } = await fixture();
		clock.now = new Date(2026, 6, 1, 8, 0);
		tasks.upsert(input({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }));
		clock.now = new Date(2026, 6, 1, 9, 5);
		await tasks.tick();
		expect(calls, "within the grace window it runs").toHaveLength(1);
		clock.now = new Date(2026, 6, 2, 11, 0);
		await tasks.tick();
		expect(calls).toHaveLength(1);
		expect(tasks.list().tasks[0]!.nextRunAt).toBe(new Date(2026, 6, 3, 9, 0).toISOString());
	});

	it("restart: a task left running is recorded failed and rescheduled; the document round-trips", async () => {
		const { dir, tasks } = await fixture({ dispatch: { launch: () => new Promise<void>(() => {}) } });
		const task = tasks.upsert(input()).task;
		void tasks.runNow({ id: task.id });
		const stored = JSON.parse(await readFile(tasks.path, "utf8")) as { tasks: { lastRunStatus: string }[] };
		expect(stored.tasks[0]!.lastRunStatus).toBe("running");

		const reopened = (await fixture({ dir })).tasks;
		expect(reopened.list().tasks[0]).toMatchObject({ id: task.id, lastRunStatus: "failed", lastRunError: INTERRUPTED_BY_RESTART, runCount: 1, nextRunAt: "2026-07-01T12:01:00.000Z" });
	});

	it("an unreadable document stops the boot, naming the file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-"));
		dirs.push(dir);
		await writeFile(join(dir, "scheduled-tasks.json"), "{ not json", "utf8");
		await expect(fixture({ dir })).rejects.toThrow(join(dir, "scheduled-tasks.json"));
	});

	it("a webhook trigger is refused with the typed error", async () => {
		const { tasks } = await fixture();
		let error: unknown;
		try {
			tasks.upsert(input({ schedule: { type: "webhook", signature: null } as never }));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ScheduledTaskError);
		expect((error as ScheduledTaskError).message).toBe(WEBHOOKS_UNSUPPORTED);
		expect(tasks.list().tasks).toHaveLength(0);
	});

	it("a worktree workspace is refused: every run is at the project root", async () => {
		const { tasks } = await fixture();
		expect(() => tasks.upsert(input({ workspaceStrategy: { type: "worktree", baseRef: "main" } as never }))).toThrow(WORKTREES_UNSUPPORTED);
		expect(tasks.list().tasks).toHaveLength(0);
	});

	it("a mode pi does not have is refused, like the thread commands", async () => {
		const { tasks } = await fixture();
		expect(() => tasks.upsert(input({ runtimeMode: "approval-required" }))).toThrow(FULL_ACCESS_ONLY);
		expect(() => tasks.upsert(input({ interactionMode: "plan" }))).toThrow(NO_PLAN_MODE);
		expect(tasks.list().tasks).toHaveLength(0);
	});

	it("a delete whose save fails keeps the task, in memory as on disk", async () => {
		const { dir, tasks } = await fixture();
		const task = tasks.upsert(input()).task;
		await chmod(dir, 0o555);
		try {
			expect(() => tasks.delete({ id: task.id })).toThrow("Could not delete schedule task.");
		} finally {
			await chmod(dir, 0o755);
		}
		expect(tasks.list().tasks.map((t) => t.id)).toEqual([task.id]);
	});

	it("every change signals subscribers: upsert, toggle, run, delete", async () => {
		const { tasks, advance } = await fixture();
		let changes = 0;
		const stop = tasks.onChange(() => changes++);
		const task = tasks.upsert(input()).task;
		expect(changes).toBe(1);
		tasks.setEnabled({ id: task.id, enabled: false });
		tasks.setEnabled({ id: task.id, enabled: false });
		expect(changes, "an unchanged toggle is a no-op").toBe(2);
		tasks.setEnabled({ id: task.id, enabled: true });
		advance(60_000);
		await tasks.tick();
		expect(changes, "running, then the result").toBe(5);
		tasks.delete({ id: task.id });
		expect(changes).toBe(6);
		expect(tasks.list().tasks).toHaveLength(0);
		stop();
	});
});
