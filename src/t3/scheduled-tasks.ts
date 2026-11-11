// T3's scheduled tasks (apps/server/src/scheduledTasks/ScheduledTaskService.ts + scheduling/Scheduler.ts), replicated
// for the interval and fixed-time triggers. Webhook triggers are refused (capabilities.md). The tasks live in one
// document in the Harness's storage (`pi-durable-t3.scheduled-tasks`), beside the threads they bind to, as T3 keeps them
// in its database; a run is a dispatch — a new thread with the prompt as its first message, or the prompt queued on
// the task's thread — never the turn's completion.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { ScheduledTask, ScheduledTaskError, type ScheduledTaskId, type ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { Bridge } from "./bridge.ts";
import type { Provenance } from "../threads.ts";
import type { Logger } from "./logging.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./schedule.ts";

type Task = typeof ScheduledTask.Type;

export const WEBHOOKS_UNSUPPORTED = "Webhook triggers are not supported by pi-durable-t3 yet.";
export const FULL_ACCESS_ONLY = "pi runs tools without approvals; full-access is the only mode.";
export const NO_PLAN_MODE = "Plan mode is not supported by pi-durable-t3.";
export const WORKTREES_UNSUPPORTED = 'Worktrees are not supported by pi-durable-t3: choose "Use the project checkout" as the workspace.';
export const INTERRUPTED_BY_RESTART = "Run was interrupted by a server restart.";
/** T3's Scheduler cadence. */
export const POLL_INTERVAL_MS = 5_000;

/** The two dispatch paths a run takes (T3's `threadLaunch.launch` and `threadManagement.sendToThread(mode: "queue")`). */
export interface ScheduledTaskDispatch {
	/** Resolves with the new thread's id (a test's dispatch may resolve with nothing). */
	launch(input: { commandId: string; messageId: string; projectId: string; title: string; text: string; modelSelection: Task["modelSelection"]; provenance: Provenance }): Promise<string | void>;
	/** T3 passes no model to a bound run: it follows the thread's current selection (ScheduledTaskService). */
	queue(input: { commandId: string; messageId: string; projectId: string; threadId: string; text: string; provenance: Provenance }): Promise<void>;
	/** T3's `ManagedProjectFolders.isScratchProject`. */
	isScratchProject(projectId: string): boolean;
}

/** The message id T3 mints for a fire; the projection reads the task id back out of it. */
export const SCHEDULED_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const encodeTask = Schema.encodeSync(ScheduledTask);

/** Every task, encoded with T3's schema. One document: a host has few tasks. */
const ScheduledTasksDoc = defineDoc<{ tasks: JsonValue[] }>({
	kind: "pi-durable-t3.scheduled-tasks",
	version: 1,
	scope: "session",
	initial: () => ({ tasks: [] }),
	checkpointWhen: () => true,
});

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

/** T3's `nextRunAfterRun`: a one-time task counts from the run's start (`lastRunAt`), so a manual run that began before its
 * time does not use it up. */
function nextRunAfterRun(task: Pick<Task, "enabled" | "schedule" | "lastRunAt">, now: Date): string | null {
	const startedAt = task.schedule.type === "once" && task.lastRunAt !== null ? new Date(task.lastRunAt) : now;
	return nextRunAt(task, Number.isFinite(startedAt.getTime()) ? startedAt : now);
}

/** T3's `requireFutureOnce`: an enabled one-time task whose time has passed would never run, so saving it is refused. */
function requireFutureOnce(task: Pick<Task, "enabled" | "schedule">, now: Date, taskId: string): void {
	if (task.enabled && task.schedule.type === "once" && nextRunAt(task, now) === null) throw taskError("The run time has passed. Pick a time in the future.", taskId);
}

export class ScheduledTasks {
	readonly #harness: Harness;
	readonly #tasks = new Map<string, Task>();
	readonly #listeners = new Set<() => void>();
	readonly #activeRuns = new Set<string>();
	readonly #dispatch: ScheduledTaskDispatch;
	readonly #now: () => Date;
	readonly #log: Logger | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#tick: Promise<void> | undefined;
	#loading: Promise<void> | undefined;
	/** Set once loaded, so a call after that runs to its first write without yielding. */
	#ready = false;

	constructor(options: { harness: Harness; dispatch: ScheduledTaskDispatch; now?: () => Date; log?: Logger }) {
		this.#harness = options.harness;
		this.#dispatch = options.dispatch;
		this.#now = options.now ?? (() => new Date());
		this.#log = options.log;
	}

	/** Read the tasks, once, strictly: a task this version cannot decode stops the host (design.md). A task left
	 * `running` by a crash is recorded failed and rescheduled (T3's startup recovery). */
	load(): Promise<void> {
		this.#loading ??= (async () => {
			const stored = await this.#harness.snapshot(ScheduledTasksDoc, BACKGROUND_CONTEXT);
			for (const entry of stored?.tasks ?? []) {
				let task: Task;
				try {
					task = decodeTask(entry);
				} catch (error) {
					throw new Error(`Cannot read the scheduled tasks: ${errorMessage(error)}`, { cause: error });
				}
				this.#tasks.set(task.id, task);
			}
			const now = this.#now();
			for (const task of [...this.#tasks.values()]) {
				if (task.lastRunStatus !== "running") continue;
				await this.#write({ ...task, lastRunStatus: "failed", lastRunError: INTERRUPTED_BY_RESTART, nextRunAt: nextRunAfterRun(task, now), updatedAt: now.toISOString(), runCount: task.runCount + 1 });
			}
			this.#ready = true;
		})();
		return this.#loading;
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
		if (!this.#ready) await this.load();
		const now = this.#now();
		const due = [...this.#tasks.values()]
			.filter((task) => task.enabled && task.nextRunAt !== null && task.lastRunStatus !== "running" && Date.parse(task.nextRunAt) <= now.getTime())
			.sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!) || a.id.localeCompare(b.id));
		for (const task of due) {
			try {
				if (isMissedFixedTimeRun(task.schedule, new Date(task.nextRunAt!), now)) await this.#rescheduleMissedRun(task, now);
				else await this.#runTask(task, "scheduled");
			} catch (error) {
				this.#log?.warn("scheduled task run failed", { taskId: task.id, error: errorMessage(error) });
			}
		}
	}

	async #rescheduleMissedRun(task: Task, now: Date): Promise<void> {
		const next = nextRunAt(task, now);
		this.#log?.info("skipping missed scheduled task run", { taskId: task.id, missedRunAt: task.nextRunAt, rescheduledTo: next });
		await this.#write({ ...task, nextRunAt: next, updatedAt: now.toISOString() });
	}

	/** Run `task`: the task as the run left it, and the thread the run went to (null when none started). */
	async #runTask(task: Task, trigger: "scheduled" | "manual"): Promise<{ task: Task; threadId: string | null }> {
		if (this.#activeRuns.has(task.id)) {
			if (trigger !== "scheduled") throw taskError("Schedule task is already running.", task.id);
			return { task, threadId: null };
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
				return { task, threadId: null };
			}
			if (trigger === "scheduled" && (!active.enabled || active.nextRunAt === null || Date.parse(active.nextRunAt) > startedAt.getTime())) return { task: active, threadId: null };

			await this.#write({ ...active, updatedAt: startedAtIso, lastRunAt: startedAtIso, lastRunStatus: "running", lastRunError: null });

			const fireKey = `${active.id}:${startedAt.getTime()}:${trigger}`;
			const commandId = `scheduled-task:${fireKey}`;
			const messageId = `scheduled-task-message:${fireKey}`;
			let lastRunError: string | null = null;
			let threadId: string | null = null;
			try {
				if (active.threadId === null) {
					// A run carries the task's provenance, as T3's `ScheduledTaskService` dispatches it.
					const launched = await this.#dispatch.launch({ commandId, messageId, projectId: active.projectId, title: active.title, text: active.prompt, modelSelection: active.modelSelection, provenance: { createdBy: active.createdBy, creationSource: active.creationSource } });
					threadId = typeof launched === "string" ? launched : null;
				} else {
					await this.#dispatch.queue({ commandId, messageId, projectId: active.projectId, threadId: active.threadId, text: active.prompt, provenance: { createdBy: active.createdBy, creationSource: active.creationSource } });
					threadId = active.threadId;
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
				// A manual run that starts before a one-time run must not use it up.
				nextRunAt: nextRunAt(source, source.schedule.type === "once" ? new Date(startedAtIso) : completedAt),
				lastRunStatus: lastRunError === null ? "succeeded" : "failed",
				lastRunError,
				runCount: source.runCount + 1,
			};
			// Only the row this run marked: a task deleted (and recreated) mid-run is not stamped.
			if (current !== undefined && current.lastRunStatus === "running" && current.lastRunAt === startedAtIso) await this.#write(completed);
			return { task: completed, threadId: lastRunError === null ? threadId : null };
		} catch (error) {
			// Anything failing after the mark leaves the task `running`, which the poll skips forever: record the attempt.
			const current = this.#tasks.get(task.id);
			if (current !== undefined && current.lastRunStatus === "running" && current.lastRunAt === startedAtIso) {
				try {
					const now = this.#now();
					await this.#write({ ...current, lastRunStatus: "failed", lastRunError: errorMessage(error), nextRunAt: nextRunAfterRun(current, now), updatedAt: now.toISOString(), runCount: current.runCount + 1 });
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

	async upsert(input: ScheduledTaskUpsertInput): Promise<{ task: Task }> {
		if (!this.#ready) await this.load();
		if (input.schedule.type === "webhook") throw taskError(WEBHOOKS_UNSUPPORTED, input.id);
		// T3 stores a Scratch project's worktree request as the root (ScheduledTaskService.upsert). Any other worktree
		// request is refused: every run here is at the project root, so it would silently run somewhere else.
		const workspaceStrategy: Task["workspaceStrategy"] =
			input.workspaceStrategy.type === "worktree" && this.#dispatch.isScratchProject(input.projectId) ? { type: "root" } : input.workspaceStrategy;
		if (workspaceStrategy.type !== "root") throw taskError(WORKTREES_UNSUPPORTED, input.id);
		// pi's only modes, as the thread commands answer them (rpc.ts): a task must not run in a mode it did not ask for.
		if (input.runtimeMode !== "full-access") throw taskError(FULL_ACCESS_ONLY, input.id);
		if (input.interactionMode !== "default") throw taskError(NO_PLAN_MODE, input.id);
		const now = this.#now();
		const id = input.id ?? `scheduled-task:${input.commandId ?? randomUUID()}`;
		const existing = this.#tasks.get(id);
		if (input.requireExisting === true && existing === undefined) throw taskError("Schedule task not found.", id);
		// A one-time run's time is stored as UTC ISO, as T3 stores it.
		const schedule: Task["schedule"] = input.schedule.type === "once" ? { type: "once", runAt: new Date(Date.parse(input.schedule.runAt)).toISOString() } : input.schedule;
		// Editing a title or prompt must not postpone (or resurrect) a due run: only schedule/enabled changes restart it.
		const scheduleUnchanged = existing !== undefined && existing.enabled === input.enabled && isSameSchedule(existing.schedule, schedule);
		if (!scheduleUnchanged) requireFutureOnce({ enabled: input.enabled, schedule }, now, id);
		const task: Task = {
			id: id as Task["id"],
			title: input.title,
			prompt: input.prompt,
			enabled: input.enabled,
			schedule,
			projectId: input.projectId,
			threadId: input.threadId ?? null,
			workspaceStrategy,
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
		await this.#write(task);
		return { task };
	}

	async setEnabled(input: { id: string; enabled: boolean }): Promise<{ task: Task }> {
		if (!this.#ready) await this.load();
		const existing = this.#load(input.id);
		if (existing.enabled === input.enabled) return { task: existing };
		const now = this.#now();
		requireFutureOnce({ enabled: input.enabled, schedule: existing.schedule }, now, input.id);
		const task = { ...existing, enabled: input.enabled, nextRunAt: nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now), updatedAt: now.toISOString() };
		await this.#write(task);
		return { task };
	}

	/** T3's `ScheduledTaskService.deleteForThread` (run by a thread deletion's `scheduled-tasks.cleanup` effect): the
	 * tasks bound to the deleted thread go with it, rather than failing on every run. */
	async deleteForThread(threadId: string): Promise<void> {
		if (!this.#ready) await this.load();
		const removed = [...this.#tasks.values()].filter((task) => task.threadId === threadId);
		if (removed.length === 0) return;
		await this.#remove(removed.map((task) => task.id), "Could not delete thread's schedule tasks.");
	}

	async delete(input: { id: ScheduledTaskId }): Promise<{ id: ScheduledTaskId }> {
		if (!this.#ready) await this.load();
		if (this.#tasks.has(input.id)) await this.#remove([input.id], "Could not delete schedule task.");
		return { id: input.id };
	}

	/** Run a task now: the task as the run left it, and the thread it went to (T3's `runTask`; the RPC answers the task). */
	async runNow(input: { id: string }): Promise<{ task: Task; threadId: string | null }> {
		if (!this.#ready) await this.load();
		const task = this.#load(input.id);
		try {
			return await this.#runTask(task, "manual");
		} catch (cause) {
			throw taskError("Could not run schedule task.", input.id, cause);
		}
	}

	#load(id: string): Task {
		const task = this.#tasks.get(id);
		if (task === undefined) throw taskError("Schedule task not found.", id);
		return task;
	}

	/** Store one task. Memory changes first, so a read right after the call sees it; a commit that fails puts the
	 * previous task back (memory follows the store) and is refused with the typed error. */
	async #write(task: Task): Promise<void> {
		const previous = this.#tasks.get(task.id);
		this.#tasks.set(task.id, task);
		this.#notify();
		const encoded = encodeTask(task) as unknown as JsonValue;
		try {
			await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(ScheduledTasksDoc);
				const index = doc.tasks.findIndex((entry) => (entry as { id?: unknown }).id === task.id);
				if (index < 0) doc.tasks.push(encoded);
				else doc.tasks[index] = encoded;
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			if (this.#tasks.get(task.id) === task) {
				if (previous === undefined) this.#tasks.delete(task.id);
				else this.#tasks.set(task.id, previous);
				this.#notify();
			}
			throw taskError("Could not save schedule task.", task.id, error);
		}
	}

	/** Drop tasks, the same way: memory first, put back if the commit fails. */
	async #remove(ids: readonly string[], refusal: string): Promise<void> {
		const removed = ids.flatMap((id) => {
			const task = this.#tasks.get(id);
			return task === undefined ? [] : [task];
		});
		for (const task of removed) this.#tasks.delete(task.id);
		this.#notify();
		try {
			await this.#harness.commit(async (tx) => {
				const doc = await tx.doc(ScheduledTasksDoc);
				doc.tasks = doc.tasks.filter((entry) => !ids.includes((entry as { id?: string }).id ?? ""));
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			for (const task of removed) if (!this.#tasks.has(task.id)) this.#tasks.set(task.id, task);
			this.#notify();
			throw taskError(refusal, ids.length === 1 ? ids[0] : undefined, error);
		}
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

/** The two dispatch paths over the bridge: T3's `threadLaunch.launch` is our launch (root workspace — the only one this
 * host has), `sendToThread(mode: "queue")` is `message.dispatch` with `queue_after_active`. */
export function scheduledTaskDispatch(bridge: Bridge): ScheduledTaskDispatch {
	return {
		launch: async (input) =>
			bridge.launchThread({
				commandId: input.commandId,
				projectId: input.projectId,
				title: input.title,
				modelSelection: input.modelSelection,
				workspaceStrategy: { type: "root" },
				initialMessage: { messageId: input.messageId, text: input.text },
				provenance: input.provenance,
			}),
		queue: async (input) => {
			// T3's sendToThread refuses a thread that is gone or belongs to another project; at boot, once the list is in.
			await bridge.loaded();
			if (bridge.threadProjectId(input.threadId) !== input.projectId) throw new Error(`Thread ${input.threadId} was not found in project ${input.projectId}.`);
			// The commandId is the message's request id: pi-durable queues a retried run's message once.
			await bridge.sendMessage({ threadId: input.threadId, commandId: input.commandId, messageId: input.messageId, text: input.text, mode: "queue", provenance: input.provenance });
		},
		isScratchProject: (projectId) => bridge.isScratchProject(projectId),
	};
}
