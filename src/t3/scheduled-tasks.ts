// T3's scheduled tasks (apps/server/src/scheduledTasks/ScheduledTaskService.ts + scheduling/Scheduler.ts), replicated
// for the interval, fixed-time, one-time and webhook triggers (a webhook's own state is `task-webhooks.ts`). The tasks live in one
// document in the Harness's storage (`pi-durable-t3.scheduled-tasks`), beside the threads they bind to, as T3 keeps them
// in its database. A run is recorded when it is dispatched — a new thread with the prompt as its first message, or the
// prompt queued on the task's thread — and then followed to its end, which can fail the task or use up a one-time one.
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { type OrchestrationV2ThreadProjection, ScheduledTask, ScheduledTaskError, type ScheduledTaskId, type ScheduledTaskThreadMode, type ScheduledTaskUpsertInput, scheduledTaskThreadMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { Bridge } from "./bridge.ts";
import type { Provenance } from "../threads.ts";
import type { Logger } from "./logging.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./schedule.ts";
import { TaskWebhooks, type WebhookTriggerRequest, type WebhookTriggerResult } from "./task-webhooks.ts";

type Task = typeof ScheduledTask.Type;

export const SECRET_REF_UNSUPPORTED = "secretRef is not supported by pi-durable-t3: its request_secret saves a secret under a name, not as a one-use reference. Pass the signing secret as `secret`.";
export const FULL_ACCESS_ONLY = "pi runs tools without approvals; full-access is the only mode.";
export const NO_PLAN_MODE = "Plan mode is not supported by pi-durable-t3.";
export const WORKTREES_UNSUPPORTED = 'Worktrees are not supported by pi-durable-t3: choose "Use the project checkout" as the workspace.';
export const FRESH_SESSION_UNSUPPORTED = "A fresh session each run is not supported by pi-durable-t3: a thread keeps its context. Choose a new thread each run, or one thread that continues.";
export const INTERRUPTED_BY_RESTART = "Run was interrupted by a server restart.";
export const MISSED_RUN = "Missed a scheduled run because the server was not running at that time.";
export const HELD_OCCURRENCE = "A previous occurrence is held in the thread queue. Resume or remove it to run this task again.";
/** T3's words for a run that did not complete and left no provider failure to quote (`UNSUCCESSFUL_RUN_ERRORS`). */
const UNSUCCESSFUL_RUN_ERRORS = {
	failed: "The run failed.",
	interrupted: "The run was stopped.",
	cancelled: "The run was cancelled.",
	rolled_back: "The run was rolled back.",
} as const;
/** T3's Scheduler cadence. */
const POLL_INTERVAL_MS = 5_000;
/** T3's `RUN_OUTCOME_WAIT_MS`: how long a dispatched run is followed to its end. */
const RUN_OUTCOME_WAIT_MS = 24 * 60 * 60 * 1_000;

/** How a dispatched run ended, and the message of its provider's failure when it left one. */
export type ScheduledRunOutcome = { readonly status: "completed" | keyof typeof UNSUCCESSFUL_RUN_ERRORS; readonly error: string | null };

/** The two dispatch paths a run takes (T3's `threadLaunch.launch` and `threadManagement.sendToThread(mode: "queue")`). */
export interface ScheduledTaskDispatch {
	/** Resolves with the new thread's id (a test's dispatch may resolve with nothing). */
	launch(input: { commandId: string; messageId: string; projectId: string; title: string; text: string; modelSelection: Task["modelSelection"]; provenance: Provenance }): Promise<string | void>;
	/** T3 passes no model to a bound run: it follows the thread's current selection (ScheduledTaskService). */
	queue(input: { commandId: string; messageId: string; projectId: string; threadId: string; text: string; provenance: Provenance }): Promise<void>;
	/** T3's `ManagedProjectFolders.isScratchProject`. */
	isScratchProject(projectId: string): boolean;
	/** A live thread's project and whether it is archived (T3's `threadManagement.getThreadShell`); none when it is gone. */
	thread(threadId: string): Promise<{ projectId: string; archived: boolean } | undefined>;
	/** T3's `queuedOccurrence`: whether a message of this task still waits in the thread's queue (`"queued"`), in a queue
	 * that is held (`"held"`), or not at all (`null`). */
	queuedOccurrence(taskId: string, threadId: string): Promise<"queued" | "held" | null>;
	/** T3's `waitForThread` on the run that carries `messageId`: how it ended, or `null` when there is nothing to record
	 * (the thread is gone, no run carries the message, it did not end within `timeoutMs`, `signal` aborted, or the message
	 * moved into another run). */
	runOutcome(threadId: string, messageId: string, timeoutMs: number, signal: AbortSignal): Promise<ScheduledRunOutcome | null>;
	/** T3's `ThreadLaunchService.isNonGitProject`: the project's folder is known and is not in a Git repository. */
	isNonGitProject(projectId: string): Promise<boolean>;
}

/**
 * T3's `resolveThreadMode`: clients that predate thread modes send none, and may send a thread loaded before the first
 * run bound one. An edit keeps the stored mode; binding a thread to a new-thread task continues it.
 */
function resolveThreadMode(input: Pick<ScheduledTaskUpsertInput, "threadId" | "threadMode">, existing: Pick<Task, "threadId" | "threadMode"> | undefined): ScheduledTaskThreadMode {
	if (input.threadMode !== undefined) return input.threadMode;
	const stored = existing === undefined ? "new_thread" : scheduledTaskThreadMode(existing);
	return stored === "new_thread" && input.threadId != null ? "continue" : stored;
}

/** The message id T3 mints for a fire; the projection reads the task id back out of it. */
export const SCHEDULED_MESSAGE_ID = /^scheduled-task-message:(.+):(?:\d+:(?:scheduled|manual)|webhook:delivery:[^:]+)$/;

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
	/** The runs being followed to their end (T3's `recordRunOutcome` fibers), and what stops them. In memory, as T3's
	 * are: a restart forgets them, and the task keeps what its dispatch recorded. */
	readonly #following = new Set<Promise<void>>();
	readonly #stopFollowing = new AbortController();
	readonly #dispatch: ScheduledTaskDispatch;
	readonly #now: () => Date;
	readonly #log: Logger | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;
	#tick: Promise<void> | undefined;
	#loading: Promise<void> | undefined;
	/** Set once loaded, so a call after that runs to its first write without yielding. */
	#ready = false;

	/** The webhook tasks' URLs, secrets and deliveries. */
	readonly #webhooks: TaskWebhooks;

	/** `webhookOrigin`: where a webhook's sender reaches this host (`https://host`), for the URL a task shows. */
	constructor(options: { harness: Harness; dispatch: ScheduledTaskDispatch; now?: () => Date; log?: Logger; webhookOrigin?: () => string | undefined }) {
		this.#harness = options.harness;
		this.#dispatch = options.dispatch;
		this.#now = options.now ?? (() => new Date());
		this.#log = options.log;
		this.#webhooks = new TaskWebhooks({ harness: options.harness, now: this.#now, log: options.log, origin: options.webhookOrigin });
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
			await this.#webhooks.load([...this.#tasks.values()].filter((task) => task.schedule.type === "webhook").map((task) => task.id));
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

	/** Stops the loop and the runs being followed, and waits for a tick in flight. */
	async stop(): Promise<void> {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		this.#stopFollowing.abort();
		await this.#tick;
		await Promise.all(this.#following);
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
				if (isMissedFixedTimeRun(task.schedule, new Date(task.nextRunAt!), now)) await this.#reschedule(task, now, "missed", MISSED_RUN);
				else await this.#runTask(task, "scheduled");
			} catch (error) {
				this.#log?.warn("scheduled task run failed", { taskId: task.id, error: errorMessage(error) });
			}
		}
		// A webhook's coalescing windows that have closed.
		await this.#webhooks.runDue((taskId) => this.#tasks.get(taskId), (task, deliveryId, prompt) => this.#runWebhook(task, deliveryId, prompt));
	}

	/** One webhook delivery's run: after any run of the task that is under way (T3 runs a task's deliveries one at a time). */
	async #runWebhook(task: Task, deliveryId: string, prompt: string): Promise<void> {
		while (this.#activeRuns.has(task.id)) await new Promise((resolve) => setTimeout(resolve, 25));
		const ran = await this.#runTask(task, "webhook", { deliveryId, prompt });
		if (ran.task.lastRunStatus === "failed" && ran.task.lastRunError !== null) throw new Error(ran.task.lastRunError);
	}

	/** A request to a task's webhook URL (T3's `triggerWebhook`): the route answers what this returns. */
	async triggerWebhook(request: WebhookTriggerRequest): Promise<WebhookTriggerResult> {
		if (!this.#ready) await this.load();
		return this.#webhooks.trigger(this.#tasks.get(request.hookId), request, (task, deliveryId, prompt) => this.#runWebhook(task, deliveryId, prompt));
	}

	/** T3's `rotateWebhookToken`. */
	async rotateWebhookToken(input: { id: string }): Promise<{ task: Task }> {
		if (!this.#ready) await this.load();
		const task = this.#load(input.id);
		if (task.schedule.type !== "webhook") throw taskError("Only webhook tasks have a URL token.", input.id);
		try {
			await this.#webhooks.rotate(task.id);
		} catch (cause) {
			throw taskError("Could not rotate webhook token.", input.id, cause);
		}
		const updated = { ...task, updatedAt: this.#now().toISOString() };
		await this.#write(updated);
		return { task: this.#shown(updated) };
	}

	/** T3's `listWebhookDeliveries` and `getWebhookDelivery`: the task's last deliveries, newest first, and one in full. */
	listWebhookDeliveries(input: { id: string }): { deliveries: ReturnType<TaskWebhooks["deliveries"]> } {
		this.#load(input.id);
		return { deliveries: this.#webhooks.deliveries(input.id) };
	}

	getWebhookDelivery(input: { id: string; deliveryId: string }): { delivery: NonNullable<ReturnType<TaskWebhooks["delivery"]>> } {
		this.#load(input.id);
		const delivery = this.#webhooks.delivery(input.id, input.deliveryId);
		if (delivery === undefined) throw taskError("Webhook delivery not found.", input.id);
		return { delivery };
	}

	/** A task as T3 is shown it: a webhook task with its URL. */
	#shown(task: Task): Task {
		const webhook = this.#webhooks.endpoint(task);
		return webhook === undefined ? task : { ...task, webhook };
	}

	/** T3's `rescheduleMissedRun`: skip this run and move to the next. With `runError` (0.1.10) the skipped run is the task's
	 * last run, failed, so the task says why it did not run. `task` can be a stale copy (the queue read before a skip
	 * waits on a projection): as T3's conditional UPDATE, a task deleted, run or rescheduled since is left alone, the write
	 * starts from the task as it is now, and the failure is recorded only over the status `task` saw. */
	async #reschedule(task: Task, now: Date, reason: string, runError?: string): Promise<void> {
		const current = this.#tasks.get(task.id);
		if (current === undefined || current.nextRunAt !== task.nextRunAt || current.lastRunAt !== task.lastRunAt) return;
		const next = nextRunAt(current, now);
		this.#log?.info("skipping scheduled task run", { taskId: task.id, reason, missedRunAt: task.nextRunAt, rescheduledTo: next });
		const unchanged = current.lastRunStatus === task.lastRunStatus && current.lastRunError === task.lastRunError;
		await this.#write({ ...current, nextRunAt: next, ...(runError === undefined || !unchanged ? {} : { lastRunStatus: "failed" as const, lastRunError: runError }), updatedAt: now.toISOString() });
	}

	/** Run `task`: the task as the run left it, and the thread the run went to (null when none started). */
	async #runTask(task: Task, trigger: "scheduled" | "manual" | "webhook", webhook?: { readonly deliveryId: string; readonly prompt: string }): Promise<{ task: Task; threadId: string | null }> {
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
			// T3 0.1.11 (#38906): a thread that stays busy would otherwise collect one copy of a recurring task's prompt per
			// interval. While one still waits in its queue this run is skipped; in a held queue (after a Stop) the task also
			// says so. A failed read falls through to the normal send.
			if (trigger === "scheduled" && active.schedule.type !== "once" && active.threadId !== null) {
				const occurrence = await this.#dispatch.queuedOccurrence(active.id, active.threadId).catch(() => null);
				if (occurrence !== null) {
					await this.#reschedule(active, startedAt, "previous occurrence still queued", occurrence === "held" ? HELD_OCCURRENCE : undefined);
					return { task: this.#tasks.get(task.id) ?? active, threadId: null };
				}
			}

			await this.#write({ ...active, updatedAt: startedAtIso, lastRunAt: startedAtIso, lastRunStatus: "running", lastRunError: null });

			// A delivery runs the task as it is now, if it is still a webhook task that is on (T3's `WebhookDeliverySkipped`).
			if (webhook !== undefined && (!active.enabled || active.schedule.type !== "webhook")) throw taskError(active.enabled ? "Task is no longer a webhook task." : "Task is disabled.", task.id);
			const fireKey = webhook === undefined ? `${active.id}:${startedAt.getTime()}:${trigger}` : `${active.id}:webhook:${webhook.deliveryId}`;
			const prompt = webhook?.prompt ?? active.prompt;
			const commandId = `scheduled-task:${fireKey}`;
			const messageId = `scheduled-task-message:${fireKey}`;
			let lastRunError: string | null = null;
			let threadId: string | null = null;
			try {
				if (active.threadId === null) {
					// A run carries the task's provenance, as T3's `ScheduledTaskService` dispatches it.
					const launched = await this.#dispatch.launch({ commandId, messageId, projectId: active.projectId, title: active.title, text: prompt, modelSelection: active.modelSelection, provenance: { createdBy: active.createdBy, creationSource: active.creationSource } });
					threadId = typeof launched === "string" ? launched : null;
					// A one-thread task keeps the thread its first run made (T3's `bindThread`).
					if (threadId !== null && scheduledTaskThreadMode(active) !== "new_thread") await this.#bindThread(active, threadId);
				} else {
					await this.#dispatch.queue({ commandId, messageId, projectId: active.projectId, threadId: active.threadId, text: prompt, provenance: { createdBy: active.createdBy, creationSource: active.creationSource } });
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
			const written = current !== undefined && current.lastRunStatus === "running" && current.lastRunAt === startedAtIso;
			if (written) await this.#write(completed);
			if (written && lastRunError === null && threadId !== null) this.#followRun(active.id, startedAtIso, threadId, messageId);
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

	/**
	 * T3's `recordRunOutcome`, started once a run's dispatch is recorded: the provider can still fail the turn after its
	 * message was accepted, so the run is followed to its end, for up to a day. A one-time task whose run completed at or
	 * after its time is spent and removed (its thread stays); a paused one's `nextRunAt` is null too, so the time is what
	 * tells a manual run before it. A run that did not complete fails the task with its provider's error or T3's words for
	 * how it ended. Either applies only while the task still shows this run, as succeeded or held behind a Stop.
	 */
	#followRun(taskId: string, startedAtIso: string, threadId: string, messageId: string): void {
		const following = (async () => {
			const outcome = await this.#dispatch.runOutcome(threadId, messageId, RUN_OUTCOME_WAIT_MS, this.#stopFollowing.signal);
			const current = this.#tasks.get(taskId);
			if (outcome === null || current === undefined || current.lastRunAt !== startedAtIso) return;
			if (outcome.status === "completed") {
				if (current.lastRunStatus === "succeeded" && current.nextRunAt === null && current.schedule.type === "once" && Date.parse(startedAtIso) >= Date.parse(current.schedule.runAt)) {
					await this.#remove([taskId], "Could not delete schedule task.");
				}
				return;
			}
			if (current.lastRunStatus !== "succeeded" && !(current.lastRunStatus === "failed" && current.lastRunError === HELD_OCCURRENCE)) return;
			await this.#write({ ...current, lastRunStatus: "failed", lastRunError: outcome.error ?? UNSUCCESSFUL_RUN_ERRORS[outcome.status] });
		})().catch((error: unknown) => this.#log?.warn("could not record scheduled run outcome", { taskId, error: errorMessage(error) }));
		this.#following.add(following);
		void following.finally(() => this.#following.delete(following));
	}

	/**
	 * T3's `bindThread`: the task as it is now takes `threadId`, unless it was replaced, moved to another project,
	 * bound, or switched to new threads meanwhile. The run already started the thread, so a failed write only costs
	 * the binding. A thread deleted before the binding landed already ran its task cleanup, so that cleanup runs here.
	 */
	async #bindThread(task: Task, threadId: string): Promise<void> {
		try {
			const current = this.#tasks.get(task.id);
			if (current !== undefined && current.createdAt === task.createdAt && current.projectId === task.projectId && current.threadId === null && scheduledTaskThreadMode(current) !== "new_thread") {
				await this.#write({ ...current, threadId: threadId as Task["threadId"] });
			}
			if ((await this.#dispatch.thread(threadId)) === undefined) await this.deleteForThread(threadId);
		} catch (error) {
			this.#log?.warn("could not bind a scheduled task to its first thread", { taskId: task.id, threadId, error: errorMessage(error) });
		}
	}

	/** T3's `requireDestinationThread`: a task is pointed only at a live, unarchived thread of its project. */
	async #requireDestinationThread(threadId: string, projectId: string, taskId: string): Promise<void> {
		const thread = await this.#dispatch.thread(threadId);
		if (thread === undefined) throw taskError("That thread no longer exists.", taskId);
		if (thread.archived) throw taskError("That thread is archived. Unarchive it or pick another destination.", taskId);
		if (thread.projectId !== projectId) throw taskError("That thread belongs to a different project.", taskId);
	}

	// ---- the RPCs ---------------------------------------------------------------------------------------------

	/** T3's order: most recently updated first, then id. */
	/** The tasks, newest change first, and (T3 0.1.11) the zone fixed-time schedules run in: the host's, which T3 shows
	 * in a schedule's label. */
	list(): { tasks: Task[]; timeZone: string } {
		return {
			tasks: [...this.#tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map((task) => this.#shown(task)),
			timeZone: DateTime.zoneToString(DateTime.zoneMakeLocal()),
		};
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async upsert(input: ScheduledTaskUpsertInput): Promise<{ task: Task }> {
		if (!this.#ready) await this.load();
		// This host's `request_secret` gives a name, not T3's one-use reference: refused by name, before anything is saved.
		if (input.schedule.type === "webhook" && input.schedule.signature?.secretRef !== undefined) throw taskError(SECRET_REF_UNSUPPORTED, input.id);
		// T3 stores a worktree request on a folder that cannot hold a worktree, Scratch or one that is not a Git
		// repository, as the root (ScheduledTaskService.upsert). Any other worktree request is refused: every run here is
		// at the project root, so it would silently run somewhere else.
		const workspaceStrategy: Task["workspaceStrategy"] =
			input.workspaceStrategy.type === "worktree" && (this.#dispatch.isScratchProject(input.projectId) || (await this.#dispatch.isNonGitProject(input.projectId))) ? { type: "root" } : input.workspaceStrategy;
		if (workspaceStrategy.type !== "root") throw taskError(WORKTREES_UNSUPPORTED, input.id);
		// pi's only modes, as the thread commands answer them (rpc.ts): a task must not run in a mode it did not ask for.
		if (input.runtimeMode !== "full-access") throw taskError(FULL_ACCESS_ONLY, input.id);
		if (input.interactionMode !== "default") throw taskError(NO_PLAN_MODE, input.id);
		const now = this.#now();
		const id = input.id ?? `scheduled-task:${input.commandId ?? randomUUID()}`;
		const existing = this.#tasks.get(id);
		if (input.requireExisting === true && existing === undefined) throw taskError("Schedule task not found.", id);
		// T3's thread modes (0.1.9). `fresh_session` starts each run without the thread's earlier context, which no
		// thread here can do (`freshContext`, dispatch.ts): refused on save, not run as something else.
		const threadMode = resolveThreadMode(input, existing);
		if (threadMode === "fresh_session") throw taskError(FRESH_SESSION_UNSUPPORTED, id);
		const keptThreadId = input.threadId ?? existing?.threadId ?? null;
		// A bound thread belongs to its project, so moving the task leaves it for a new one.
		const movedOffThread = existing !== undefined && existing.projectId !== input.projectId && keptThreadId === existing.threadId;
		const threadId = threadMode === "new_thread" || movedOffThread ? null : keptThreadId;
		// An unchanged destination is not rechecked, so a task on an archived thread stays editable.
		if (threadId !== null && threadId !== existing?.threadId) await this.#requireDestinationThread(threadId, input.projectId, id);
		// A one-time run's time is stored as UTC ISO, as T3 stores it.
		const stored = existing?.schedule.type === "webhook" ? existing.schedule : undefined;
		const schedule: Task["schedule"] =
			input.schedule.type === "once"
				? { type: "once", runAt: new Date(Date.parse(input.schedule.runAt)).toISOString() }
				: input.schedule.type === "webhook"
					? // T3's rule: the signature check as given (its secret is kept apart), and a client that names no dedupe or
						// filters keeps the stored ones; an empty filter list clears them.
						{
							type: "webhook",
							signature: input.schedule.signature == null ? null : { header: input.schedule.signature.header.toLowerCase(), encoding: input.schedule.signature.encoding, prefix: input.schedule.signature.prefix },
							maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
							...((input.schedule.dedupe ?? stored?.dedupe) === undefined ? {} : { dedupe: input.schedule.dedupe ?? stored?.dedupe }),
							...(((input.schedule.filters ?? stored?.filters)?.length ?? 0) === 0 ? {} : { filters: input.schedule.filters ?? stored?.filters }),
						}
					: input.schedule;
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
			threadId,
			threadMode,
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
		// A webhook task's URL and secret, before the task that shows them; a task that stops being one loses them.
		if (input.schedule.type === "webhook") {
			try {
				await this.#webhooks.save(task, input.schedule.signature);
			} catch (cause) {
				throw taskError(errorMessage(cause), id);
			}
		} else if (existing?.schedule.type === "webhook") await this.#webhooks.remove(id);
		await this.#write(task);
		return { task: this.#shown(task) };
	}

	async setEnabled(input: { id: string; enabled: boolean }): Promise<{ task: Task }> {
		if (!this.#ready) await this.load();
		const existing = this.#load(input.id);
		if (existing.enabled === input.enabled) return { task: this.#shown(existing) };
		const now = this.#now();
		requireFutureOnce({ enabled: input.enabled, schedule: existing.schedule }, now, input.id);
		const task = { ...existing, enabled: input.enabled, nextRunAt: nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now), updatedAt: now.toISOString() };
		await this.#write(task);
		return { task: this.#shown(task) };
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
			const ran = await this.#runTask(task, "manual");
			return { ...ran, task: this.#shown(ran.task) };
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
			for (const task of removed) await this.#webhooks.remove(task.id).catch((error) => this.#log?.warn("a deleted task's webhook was not removed", { taskId: task.id, error: errorMessage(error) }));
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
		thread: async (threadId) => {
			await bridge.loaded();
			const thread = bridge.threadRecord(threadId);
			return thread === undefined ? undefined : { projectId: thread.projectId, archived: thread.archivedAt !== undefined };
		},
		// The queued runs' messages name their task (`SCHEDULED_MESSAGE_ID`, read by the projection).
		queuedOccurrence: async (taskId, threadId) => {
			if (!bridge.hasThread(threadId)) return null;
			const { projection } = await bridge.projection(threadId);
			const ofTask = new Set(projection.messages.filter((message) => message.scheduledTaskId === taskId).map((message) => message.id));
			const occurrences = projection.runs.filter((run) => run.status === "queued" && ofTask.has(run.userMessageId));
			return occurrences.some((run) => run.queueHeld === true) ? "held" : occurrences.length > 0 ? "queued" : null;
		},
		runOutcome: async (threadId, messageId, timeoutMs, signal) => {
			if (!bridge.hasThread(threadId)) return null;
			// T3 follows a run its first read finds; a slash command this host answers on the spot starts none.
			if (!(await bridge.projection(threadId)).projection.runs.some((run) => run.userMessageId === messageId)) return null;
			try {
				return (await bridge.waitFor(threadId, (projection) => scheduledRunOutcome(projection, messageId), timeoutMs, signal)) ?? null;
			} catch (error) {
				// A Stop of the host, or the thread deleted meanwhile. T3 cancels a deleted thread's active runs first, so its task
				// records "The run was cancelled."; here the deletion stops the run, which this wait reads as stopped (or, for a
				// message still queued, cancelled) when the thread shows it before it is gone, and as nothing otherwise.
				if (signal.aborted || !bridge.hasThread(threadId)) return null;
				throw error;
			}
		},
		isNonGitProject: async (projectId) => {
			const project = bridge.config.registry.list().find((candidate) => candidate.id === projectId);
			return project !== undefined && !(await isGitRepository(bridge.config.env, project.cwd, bridge.config.context ?? BACKGROUND_CONTEXT));
		},
	};
}

/**
 * How the run that carries `messageId` ended, read from its thread's projection for T3's `recordRunOutcome`: `undefined`
 * while it has not, `null` when there is nothing to record. A run is found by its message, not its id: a queued
 * message's run is renamed when pi places it. A queued message gone with no run of its own was removed from the queue
 * (T3 cancels its run) or sent as a steer, into the run it steers (T3 passes over the cancel that leaves).
 */
export function scheduledRunOutcome(projection: OrchestrationV2ThreadProjection, messageId: string): ScheduledRunOutcome | null | undefined {
	const runs = projection.runs.filter((run) => run.userMessageId === messageId);
	const run = runs.find((candidate) => candidate.status !== "rolled_back") ?? runs[0];
	if (run === undefined) return projection.messages.some((message) => message.id === messageId) ? null : { status: "cancelled", error: null };
	if (run.status === "completed") return { status: "completed", error: null };
	if (run.status !== "failed" && run.status !== "interrupted" && run.status !== "cancelled" && run.status !== "rolled_back") return undefined;
	return { status: run.status, error: latestRootProviderFailure(run, projection.turnItems)?.message ?? null };
}

/**
 * T3's `CheckpointStore.isGitRepository` (GitVcsDriver's work-tree probe), through the environment: a folder in a work
 * tree is one. Git missing, a folder that is not there, "not a git repository", a bare repository or the inside of a
 * `.git` are not; any other failure is not an answer, and reads as a repository, as T3's caller reads it.
 */
async function isGitRepository(env: ExecutionEnv, cwd: string, context: Context): Promise<boolean> {
	let stdout = "";
	let stderr = "";
	const run = await env.exec(
		["git", "rev-parse", "--is-inside-work-tree"],
		{ cwd, env: { LC_ALL: "C" }, timeout: 5_000, onOutput: (text, _context, info) => void (info.stream === "stdout" ? (stdout += text) : (stderr += text)) },
		context,
	);
	if (!run.ok) return run.error.code !== "spawn_error";
	if (run.value.exitCode === 0) return stdout.trim() === "true";
	const missing = await env.exists(cwd, context);
	return !(stdout.startsWith("false") || /^fatal: (?:not a git repository|cannot use bare repository)/m.test(stderr) || (missing.ok && !missing.value));
}
