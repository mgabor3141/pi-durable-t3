// T3's scheduled tasks (apps/server/src/scheduledTasks/ScheduledTaskService.ts + scheduling/Scheduler.ts), replicated
// for the interval and fixed-time triggers. Webhook triggers are refused (capabilities.md). The tasks live in one JSON
// document in the state dir (`scheduled-tasks.json`); a run is a dispatch — a new thread with the prompt as its first
// message, or the prompt queued on the task's thread — never the turn's completion.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ScheduledTask, ScheduledTaskError, type ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Bridge } from "./bridge.ts";
import { writeJsonAtomic } from "./json-store.ts";
import type { Logger } from "./logging.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./schedule.ts";

type Task = typeof ScheduledTask.Type;

export const WEBHOOKS_UNSUPPORTED = "Webhook triggers are not supported by pi-durable-t3 yet.";
export const INTERRUPTED_BY_RESTART = "Run was interrupted by a server restart.";
/** T3's Scheduler cadence. */
export const POLL_INTERVAL_MS = 5_000;

/** The two dispatch paths a run takes (T3's `threadLaunch.launch` and `threadManagement.sendToThread(mode: "queue")`). */
export interface ScheduledTaskDispatch {
	launch(input: { commandId: string; messageId: string; projectId: string; title: string; text: string; modelSelection: Task["modelSelection"] }): Promise<void>;
	queue(input: { commandId: string; messageId: string; projectId: string; threadId: string; text: string; modelSelection: Task["modelSelection"] }): Promise<void>;
}

/** The message id T3 mints for a fire; the projection reads the task id back out of it. */
export const SCHEDULED_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);

function taskError(message: string, taskId?: string, cause?: unknown): ScheduledTaskError {
	return new ScheduledTaskError({
		message,
		...(taskId === undefined ? {} : { taskId: taskId as Task["id"] }),
		...(cause === undefined ? {} : { cause }),
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message || String(error) : String(error);
}

function nextRunAt(task: Pick<Task, "enabled" | "schedule">, from: Date): string | null {
	if (!task.enabled) return null;
	const next = nextScheduledRunAt(task.schedule, from);
	return next !== null && Number.isFinite(next.getTime()) ? next.toISOString() : null;
}

export class ScheduledTasks {
	readonly path: string;
	readonly #tasks = new Map<string, Task>();
	readonly #listeners = new Set<() => void>();
	readonly #activeRuns = new Set<string>();
	readonly #dispatch: ScheduledTaskDispatch;
	readonly #now: () => Date;
	readonly #log: Logger | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#tick: Promise<void> | undefined;

	/** Opens the document strictly: a file that does not parse or decode stops the host, naming it (design.md). A task
	 * left `running` by a crash is recorded failed and rescheduled (T3's startup recovery). */
	constructor(options: { stateDir: string; dispatch: ScheduledTaskDispatch; now?: () => Date; log?: Logger }) {
		this.path = join(options.stateDir, "scheduled-tasks.json");
		this.#dispatch = options.dispatch;
		this.#now = options.now ?? (() => new Date());
		this.#log = options.log;
		let raw: string | undefined;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read ${this.path}: ${errorMessage(error)}`);
		}
		if (raw !== undefined) {
			try {
				const document = JSON.parse(raw) as { tasks?: unknown };
				if (!Array.isArray(document.tasks)) throw new Error("expected { tasks: [...] }");
				for (const entry of document.tasks) {
					const task = decodeTask(entry);
					this.#tasks.set(task.id, task);
				}
			} catch (error) {
				throw new Error(`Cannot read ${this.path}: ${errorMessage(error)}`);
			}
		}
		const now = this.#now();
		let recovered = false;
		for (const task of this.#tasks.values()) {
			if (task.lastRunStatus !== "running") continue;
			this.#tasks.set(task.id, { ...task, lastRunStatus: "failed", lastRunError: INTERRUPTED_BY_RESTART, nextRunAt: nextRunAt(task, now), updatedAt: now.toISOString(), runCount: task.runCount + 1 });
			recovered = true;
		}
		if (recovered) this.#save();
	}

	// ---- the poll loop ----------------------------------------------------------------------------------------

	/** One loop at T3's 5 s cadence, first tick now. Unref'd: it never keeps the process alive. */
	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
		this.#timer.unref();
		void this.tick();
	}

	/** Stops the loop and waits for a tick in flight. */
	async stop(): Promise<void> {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		await this.#tick;
	}

	/** One poll; a poll still running makes this a no-op (T3's one-permit scheduler). */
	tick(): Promise<void> {
		if (this.#tick !== undefined) return this.#tick;
		this.#tick = this.#runDueTasks()
			.catch((error) => this.#log?.warn("scheduled tasks poll failed", { error: errorMessage(error) }))
			.finally(() => {
				this.#tick = undefined;
			});
		return this.#tick;
	}

	async #runDueTasks(): Promise<void> {
		const now = this.#now();
		const due = [...this.#tasks.values()]
			.filter((task) => task.enabled && task.nextRunAt !== null && task.lastRunStatus !== "running" && Date.parse(task.nextRunAt) <= now.getTime())
			.sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!) || a.id.localeCompare(b.id));
		for (const task of due) {
			try {
				if (isMissedFixedTimeRun(task.schedule, new Date(task.nextRunAt!), now)) this.#rescheduleMissedRun(task, now);
				else await this.#runTask(task, "scheduled");
			} catch (error) {
				this.#log?.warn("scheduled task run failed", { taskId: task.id, error: errorMessage(error) });
			}
		}
	}

	#rescheduleMissedRun(task: Task, now: Date): void {
		const next = nextRunAt(task, now);
		this.#log?.info("skipping missed scheduled task run", { taskId: task.id, missedRunAt: task.nextRunAt, rescheduledTo: next });
		this.#write({ ...task, nextRunAt: next, updatedAt: now.toISOString() });
	}

	async #runTask(task: Task, trigger: "scheduled" | "manual"): Promise<Task> {
		if (this.#activeRuns.has(task.id)) {
			if (trigger !== "scheduled") throw taskError("Schedule task is already running.", task.id);
			return task;
		}
		this.#activeRuns.add(task.id);
		let startedAtIso: string | undefined;
		try {
			const startedAt = this.#now();
			startedAtIso = startedAt.toISOString();
			// Re-read: the task may have been deleted, paused or postponed since the poll loaded it.
			const active = this.#tasks.get(task.id);
			if (active === undefined) {
				if (trigger !== "scheduled") throw taskError("Schedule task not found.", task.id);
				return task;
			}
			if (trigger === "scheduled" && (!active.enabled || active.nextRunAt === null || Date.parse(active.nextRunAt) > startedAt.getTime())) return active;

			this.#write({ ...active, updatedAt: startedAtIso, lastRunAt: startedAtIso, lastRunStatus: "running", lastRunError: null });

			const fireKey = `${active.id}:${startedAt.getTime()}:${trigger}`;
			const commandId = `scheduled-task:${fireKey}`;
			const messageId = `scheduled-task-message:${fireKey}`;
			let lastRunError: string | null = null;
			try {
				if (active.threadId === null) {
					await this.#dispatch.launch({ commandId, messageId, projectId: active.projectId, title: active.title, text: active.prompt, modelSelection: active.modelSelection });
				} else {
					await this.#dispatch.queue({ commandId, messageId, projectId: active.projectId, threadId: active.threadId, text: active.prompt, modelSelection: active.modelSelection });
				}
			} catch (error) {
				lastRunError = errorMessage(error);
			}

			const completedAt = this.#now();
			const current = this.#tasks.get(task.id);
			const source = current ?? active;
			const completed: Task = {
				...source,
				updatedAt: completedAt.toISOString(),
				lastRunAt: startedAtIso,
				nextRunAt: nextRunAt(source, completedAt),
				lastRunStatus: lastRunError === null ? "succeeded" : "failed",
				lastRunError,
				runCount: source.runCount + 1,
			};
			// Only the row this run marked: a task deleted (and recreated) mid-run is not stamped.
			if (current !== undefined && current.lastRunStatus === "running" && current.lastRunAt === startedAtIso) this.#write(completed);
			return completed;
		} catch (error) {
			// Anything failing after the mark leaves the task `running`, which the poll skips forever: record the attempt.
			const current = this.#tasks.get(task.id);
			if (current !== undefined && current.lastRunStatus === "running" && current.lastRunAt === startedAtIso) {
				try {
					const now = this.#now();
					this.#write({ ...current, lastRunStatus: "failed", lastRunError: errorMessage(error), nextRunAt: nextRunAt(current, now), updatedAt: now.toISOString(), runCount: current.runCount + 1 });
				} catch (releaseError) {
					this.#log?.warn("could not release a stuck scheduled task run", { taskId: task.id, error: errorMessage(releaseError) });
				}
			}
			throw error;
		} finally {
			this.#activeRuns.delete(task.id);
		}
	}

	// ---- the RPCs ---------------------------------------------------------------------------------------------

	/** T3's order: most recently updated first, then id. */
	list(): { tasks: Task[] } {
		return { tasks: [...this.#tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) };
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	upsert(input: ScheduledTaskUpsertInput): { task: Task } {
		if (input.schedule.type === "webhook") throw taskError(WEBHOOKS_UNSUPPORTED, input.id);
		const now = this.#now();
		const id = input.id ?? `scheduled-task:${input.commandId ?? randomUUID()}`;
		const existing = this.#tasks.get(id);
		if (input.requireExisting === true && existing === undefined) throw taskError("Schedule task not found.", id);
		const schedule = input.schedule;
		// Editing a title or prompt must not postpone (or resurrect) a due run: only schedule/enabled changes restart it.
		const scheduleUnchanged = existing !== undefined && existing.enabled === input.enabled && isSameSchedule(existing.schedule, schedule);
		const task: Task = {
			id: id as Task["id"],
			title: input.title,
			prompt: input.prompt,
			enabled: input.enabled,
			schedule,
			projectId: input.projectId,
			threadId: input.threadId ?? null,
			workspaceStrategy: input.workspaceStrategy,
			modelSelection: input.modelSelection,
			runtimeMode: input.runtimeMode,
			interactionMode: input.interactionMode,
			createdBy: existing?.createdBy ?? input.createdBy ?? "user",
			creationSource: input.creationSource ?? "web",
			createdAt: existing?.createdAt ?? now.toISOString(),
			updatedAt: now.toISOString(),
			nextRunAt: scheduleUnchanged ? existing.nextRunAt : nextRunAt({ enabled: input.enabled, schedule }, now),
			// Run state is the run's: a save never overwrites it.
			lastRunAt: existing?.lastRunAt ?? null,
			lastRunStatus: existing?.lastRunStatus ?? "never",
			lastRunError: existing?.lastRunError ?? null,
			runCount: existing?.runCount ?? 0,
		};
		this.#write(task);
		return { task };
	}

	setEnabled(input: { id: string; enabled: boolean }): { task: Task } {
		const existing = this.#load(input.id);
		if (existing.enabled === input.enabled) return { task: existing };
		const now = this.#now();
		const task = { ...existing, enabled: input.enabled, nextRunAt: nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now), updatedAt: now.toISOString() };
		this.#write(task);
		return { task };
	}

	delete(input: { id: string }): { id: string } {
		if (this.#tasks.delete(input.id)) {
			this.#save();
			this.#notify();
		}
		return { id: input.id };
	}

	async runNow(input: { id: string }): Promise<{ task: Task }> {
		const task = this.#load(input.id);
		try {
			return { task: await this.#runTask(task, "manual") };
		} catch (cause) {
			throw taskError("Could not run schedule task.", input.id, cause);
		}
	}

	#load(id: string): Task {
		const task = this.#tasks.get(id);
		if (task === undefined) throw taskError("Schedule task not found.", id);
		return task;
	}

	/** Memory follows the file: a failed write leaves the previous task in place. */
	#write(task: Task): void {
		const previous = this.#tasks.get(task.id);
		this.#tasks.set(task.id, task);
		try {
			this.#save();
		} catch (error) {
			if (previous === undefined) this.#tasks.delete(task.id);
			else this.#tasks.set(task.id, previous);
			throw taskError("Could not save schedule task.", task.id, error);
		}
		this.#notify();
	}

	#save(): void {
		writeJsonAtomic(this.path, { tasks: [...this.#tasks.values()] });
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				this.#log?.warn("scheduled tasks listener failed", { error: errorMessage(error) });
			}
		}
	}
}

/** A launch's thread id, derived from its commandId: a replayed fire lands on the thread the first attempt made. */
export function launchThreadId(commandId: string): string {
	const hex = createHash("sha256").update(commandId).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** The two dispatch paths over the bridge: T3's `threadLaunch.launch` is our launch (root workspace — the only one this
 * host has), `sendToThread(mode: "queue")` is `message.dispatch` with `queue_after_active`. */
export function scheduledTaskDispatch(bridge: Bridge): ScheduledTaskDispatch {
	return {
		launch: async (input) => {
			await bridge.launchThread({
				commandId: input.commandId,
				threadId: launchThreadId(input.commandId),
				projectId: input.projectId,
				title: input.title,
				modelSelection: input.modelSelection,
				workspaceStrategy: { type: "root" },
				initialMessage: { messageId: input.messageId, text: input.text },
			});
		},
		queue: async (input) => {
			// T3's sendToThread refuses a thread that is gone or belongs to another project.
			if (bridge.threadProjectId(input.threadId) !== input.projectId) throw new Error(`Thread ${input.threadId} was not found in project ${input.projectId}.`);
			await bridge.idempotent(input.commandId, async () => {
				await bridge.applySelection(input.threadId, input.modelSelection);
				await bridge.sendMessage({ threadId: input.threadId, commandId: input.commandId, messageId: input.messageId, text: input.text, mode: "queue" });
				return bridge.nextSequence();
			});
		},
	};
}
