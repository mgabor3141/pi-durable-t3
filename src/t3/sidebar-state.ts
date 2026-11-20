// Sidebar state (T3's server keeps it on the thread row): settled, archived, snoozed, pinned, tagged, visited; and
// T3's settlement sweep (`ThreadSettlementService`: every minute, and when the settings change).
import { DateTime } from "effect";
import { messageOf } from "../host-errors.ts";
import type { ThreadRecord } from "../threads.ts";
import type { BridgeCore } from "./bridge-core.ts";
import { CommandError } from "./errors.ts";
import { autoSettleAt, autoSettleDays, recordThreadOpen } from "./sidebar.ts";
import type { ThreadTitles } from "./thread-titles.ts";

/** How often T3 sweeps for threads to settle. */
const SETTLE_SWEEP_MS = 60_000;

type Core = Pick<BridgeCore, "config" | "log" | "store" | "closed" | "thread" | "threads" | "acquire" | "view" | "shell" | "republish" | "hasThread" | "projection">;

export class SidebarState {
	readonly #bridge: Core;
	readonly #titles: ThreadTitles;
	#sweeping = false;
	#timer: NodeJS.Timeout | undefined;
	#settingsStop: (() => void) | undefined;

	constructor(bridge: Core, titles: ThreadTitles) {
		this.#bridge = bridge;
		this.#titles = titles;
	}

	/** Start the sweep: every minute, and when the settings change. */
	start(): void {
		this.#timer = setInterval(() => void this.sweep(), SETTLE_SWEEP_MS);
		this.#timer.unref();
		this.#settingsStop = this.#bridge.config.settings.subscribe(() => void this.sweep());
	}

	close(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#settingsStop?.();
	}

	/** T3's refusal of sidebar changes to an archived thread. */
	#notArchived(threadId: string): void {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		if (this.#bridge.thread(threadId)?.archivedAt !== undefined) throw new CommandError(`Thread ${threadId} is archived.`);
	}

	/** T3's `thread.settle`: a durable sidebar settlement, reflected in the shell immediately. */
	async settle(threadId: string, expectedLatestRunId?: string): Promise<void> {
		this.#notArchived(threadId);
		// T3's guards (`Orchestrator`): a settle that names the run it saw last is refused when another has started since,
		// and a thread that works, or holds a message someone queued, is not settled. (T3 also removes the queued
		// notes and reports of a thread it settles; here they stay and wake the thread when they run.)
		const { projection } = await this.#bridge.projection(threadId);
		const latest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>((found, run) => (found === undefined || run.ordinal > found.ordinal ? run : found), undefined);
		if (expectedLatestRunId !== undefined && latest?.id !== expectedLatestRunId) throw new CommandError("The thread received another run before settlement.");
		if (projection.runs.some((run) => ["preparing", "starting", "running", "waiting"].includes(run.status))) throw new CommandError(`Thread ${threadId} is still running. Stop it before settling.`);
		// A message an agent, a report or (0.1.11) a scheduled task queued does not hold the thread; one a person did.
		const written = new Set(projection.messages.filter((message) => message.role === "user" && message.createdBy === "user" && message.scheduledTaskId === undefined).map((message) => message.id));
		if (projection.runs.some((run) => run.status === "queued" && written.has(run.userMessageId))) throw new CommandError(`Thread ${threadId} has a queued message. Send it or remove it from the queue before settling.`);
		await this.#bridge.store.settle(threadId);
		this.#bridge.republish(threadId);
	}

	/** T3's `thread.unsettle`: put the thread back in the active section, durably. `restoreUnsettledAt` (an ISO time, or
	 * null) is the stamp an undone settle cleared (`Threads.unsettle`); one that is not a time is refused in T3's words. */
	async unsettle(threadId: string, restoreUnsettledAt?: string | null): Promise<void> {
		this.#notArchived(threadId);
		const restore = restoreUnsettledAt == null ? restoreUnsettledAt : Date.parse(restoreUnsettledAt);
		if (Number.isNaN(restore)) throw new CommandError(`Thread ${threadId} unsettle anchor ${restoreUnsettledAt} is not a valid time.`);
		await this.#bridge.store.unsettle(threadId, restore);
		this.#bridge.republish(threadId);
	}

	#change(threadId: string, change: (record: ThreadRecord) => boolean | void): Promise<ThreadRecord> {
		this.#notArchived(threadId);
		return this.#bridge.store.updateRecord(threadId, change);
	}

	/** T3's `thread.tag.set`: add a tag (once) or remove it. Tags are not sidebar state T3 refuses on an archived thread. */
	async setTag(threadId: string, tag: string, tagged: boolean): Promise<void> {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		await this.#bridge.store.updateRecord(threadId, (record) => {
			const current = record.tags ?? [];
			const next = tagged ? (current.includes(tag) ? current : [...current, tag]) : current.filter((existing) => existing !== tag);
			if (next.length === current.length && next.every((value, index) => value === current[index])) return false;
			if (next.length === 0) delete record.tags;
			else record.tags = next;
		});
	}

	/** The live side chats opened from `threadId`, which follow it into the archive and out. */
	#sideChats(threadId: string): string[] {
		return this.#bridge
			.threads()
			.filter((thread) => thread.deletedAt === null && thread.lineage.sideChat === true && thread.lineage.parentThreadId === threadId)
			.map((thread) => thread.threadId);
	}

	/** T3's `hasRunningDelegatedTasks` (0.1.11): a child the thread started (`thread_prompt`, T3's app-owned subagent)
	 * still works. */
	async #delegating(threadId: string): Promise<boolean> {
		const { projection } = await this.#bridge.projection(threadId);
		return projection.subagents.some((task) => task.origin === "app_owned" && task.childThreadId !== null && ["pending", "running", "waiting"].includes(task.status));
	}

	/** T3's `thread.archive`: out of the sidebar and into the archive; a title being generated is dropped. Refused while a
	 * child it started still works (0.1.11). */
	async archive(threadId: string): Promise<void> {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		if (this.#bridge.thread(threadId)?.archivedAt !== undefined) throw new CommandError(`Thread ${threadId} is already archived.`);
		if (await this.#delegating(threadId)) throw new CommandError(`Thread ${threadId} has running delegated tasks. Wait for them or cancel them before archiving.`);
		const now = Date.now();
		// Since 0.1.10 its side chats are archived with it (those not archived already), except one whose children still
		// work, which stays active.
		const sideChats: string[] = [];
		for (const sideChat of this.#sideChats(threadId)) if (this.#bridge.thread(sideChat)?.archivedAt === undefined && !(await this.#delegating(sideChat))) sideChats.push(sideChat);
		for (const id of [threadId, ...sideChats]) {
			this.#titles.cancel(id);
			await this.#bridge.store.updateRecord(id, (record) => {
				record.archivedAt = now;
			});
		}
	}

	/** T3's `thread.unarchive`: with the side chats its archive took (archived when it was or later), not older ones. */
	async unarchive(threadId: string): Promise<void> {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const archivedAt = this.#bridge.thread(threadId)?.archivedAt;
		if (archivedAt === undefined) throw new CommandError(`Thread ${threadId} is not archived.`);
		const sideChats = this.#sideChats(threadId).filter((sideChat) => (this.#bridge.thread(sideChat)?.archivedAt ?? -Infinity) >= archivedAt);
		for (const id of [threadId, ...sideChats]) {
			await this.#bridge.store.updateRecord(id, (record) => {
				delete record.archivedAt;
			});
		}
	}

	/** T3's `thread.snooze`: hidden until a time in the future; refused while an approval card waits, and while a message
	 * waits in its queue (T3 refuses a queued run someone sent) unless the queue is held behind a provider's limit (0.1.11:
	 * that work cannot start before the reset anyway, and "Snooze until reset" is for exactly that thread). */
	async snooze(threadId: string, snoozedUntil: string): Promise<void> {
		this.#notArchived(threadId);
		const until = Date.parse(snoozedUntil);
		const now = Date.now();
		if (Number.isNaN(until) || until <= now) throw new CommandError(`Thread ${threadId} snooze wake time ${snoozedUntil} is not in the future.`);
		const release = this.#bridge.acquire(threadId);
		try {
			const { projection } = await this.#bridge.view(threadId).projection(15_000);
			if (projection.runtimeRequests.some((request) => request.status === "pending" && request.kind !== "user_input")) throw new CommandError(`Thread ${threadId} has a pending approval and cannot be snoozed.`);
			// T3's `usageLimitHoldsQueue`: the limit holds the queue while it stands, i.e. while the limited run is still the last that
			// ran (the projection's `limitRecovery`); the record keeps its recovery after a later run, which no longer holds it.
			const heldBehindLimit = projection.thread.limitRecovery != null;
			if (!heldBehindLimit && projection.runs.some((run) => run.status === "queued")) throw new CommandError(`Thread ${threadId} has a queued run and cannot be snoozed.`);
		} finally {
			release();
		}
		await this.#bridge.store.updateRecord(threadId, (record) => {
			record.snoozedUntil = until;
			record.snoozedAt = now;
		});
	}

	/** T3's wake on a saved secret (`secret_request.record`, 0.1.9): a snoozed thread whose agent just got what it
	 * waited for shows again. Only the snooze is cleared: no wake stamp, and a settle override stays. */
	async wakeForSavedSecret(threadId: string): Promise<void> {
		if (this.#bridge.thread(threadId)?.snoozedUntil === undefined) return;
		await this.#bridge.store.updateRecord(threadId, (record) => {
			delete record.snoozedUntil;
			delete record.snoozedAt;
		});
	}

	/** T3's `thread.unsnooze`: awake now, stamped unless it already was. */
	async unsnooze(threadId: string): Promise<void> {
		const now = Date.now();
		await this.#change(threadId, (record) => {
			const awake = record.snoozedUntil === undefined;
			delete record.snoozedUntil;
			delete record.snoozedAt;
			if (!awake) record.lastSnoozeWakeAt = now;
			if (awake && record.snoozedAt === undefined) return false;
		});
	}

	/** T3's `thread.visit`: the read watermark moves forward only (by the client's clock); an open (`opened`) is counted for
	 * the command palette by the server's clock, with the query that picked the thread. */
	async visit(threadId: string, visitedAt: string, opened: boolean, searchQuery: string | undefined): Promise<void> {
		const at = Date.parse(visitedAt);
		if (Number.isNaN(at)) throw new CommandError(`Thread ${threadId} visit time ${visitedAt} is not a valid timestamp.`);
		const now = Date.now();
		await this.#change(threadId, (record) => {
			const forward = record.lastVisitedAt === undefined || at > record.lastVisitedAt;
			if (!forward && !opened) return false;
			if (forward) record.lastVisitedAt = at;
			if (opened) record.opens = recordThreadOpen(record.opens, now, searchQuery);
		});
	}

	/** T3's `thread.mark-unread`: the watermark goes back to just before the latest run's end. */
	async markUnread(threadId: string): Promise<void> {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const completedAt = this.#bridge.shell(threadId).latestRunCompletedAt;
		if (completedAt == null) throw new CommandError(`Thread ${threadId} has no completed run to mark unread.`);
		const at = DateTime.toEpochMillis(completedAt) - 1;
		const now = Date.now();
		await this.#change(threadId, (record) => {
			record.lastVisitedAt = at;
			// T3 retires a snooze that already ran out, keeping when it woke.
			if (record.snoozedUntil !== undefined && record.snoozedUntil <= now) {
				record.lastSnoozeWakeAt = record.snoozedUntil;
				delete record.snoozedUntil;
				delete record.snoozedAt;
			}
		});
	}

	/** T3's `thread.pin`: pinned once (a later pin keeps its time and place); pinning a settled thread makes it active. */
	async pin(threadId: string, orderKey: string | undefined): Promise<void> {
		const now = Date.now();
		await this.#change(threadId, (record) => {
			const already = record.pinnedAt !== undefined;
			if (!already) {
				record.pinnedAt = now;
				if (orderKey !== undefined) record.pinOrderKey = orderKey;
			}
			if (record.settledOverride === "settled") {
				record.settledOverride = "active";
				delete record.settledAt;
				// T3 v0.1.7: the un-settle is stamped, as any other.
				record.unsettledAt = now;
			}
			// A pinned thread is not snoozed (T3's pin wakes it, stamped).
			if (record.snoozedUntil !== undefined) record.lastSnoozeWakeAt = now;
			delete record.snoozedUntil;
			delete record.snoozedAt;
		});
	}

	/** T3's `thread.unpin`. */
	async unpin(threadId: string): Promise<void> {
		await this.#change(threadId, (record) => {
			if (record.pinnedAt === undefined && record.pinOrderKey === undefined) return false;
			delete record.pinnedAt;
			delete record.pinOrderKey;
		});
	}

	/** T3's `thread.pin.reorder` and `thread.active.reorder`: the thread's place among the pins, or in the active section. */
	async reorder(threadId: string, section: "pinned" | "active", orderKey: string): Promise<void> {
		await this.#change(threadId, (record) => {
			const field = section === "pinned" ? "pinOrderKey" : "activeOrderKey";
			if (record[field] === orderKey) return false;
			record[field] = orderKey;
		});
	}

	/** T3's `thread.auto-settle.set`: turn automatic settlement off for this thread (stamped once), or back on. */
	async setAutoSettle(threadId: string, enabled: boolean): Promise<void> {
		const now = Date.now();
		await this.#change(threadId, (record) => {
			if (enabled === (record.autoSettleDisabledAt === undefined)) return false;
			if (enabled) delete record.autoSettleDisabledAt;
			else record.autoSettleDisabledAt = now;
		});
	}

	/** T3's `thread.auto-settle`: settle a thread nobody settled or kept active, unless it changed after `snapshotAt`. */
	async autoSettle(threadId: string, snapshotAt: number, settledAt: number | undefined): Promise<void> {
		if (!this.#bridge.hasThread(threadId)) throw new CommandError(`Unknown thread: ${threadId}`);
		const shell = this.#bridge.shell(threadId);
		if (shell.settledOverride !== null || DateTime.toEpochMillis(shell.updatedAt) > snapshotAt) {
			throw new CommandError(`Thread ${threadId} changed before automatic settlement.`);
		}
		await this.#bridge.store.settle(threadId, settledAt);
	}

	/** A subagent's parent no longer holds it active: settled, archived or gone. */
	#parentDone(parentThreadId: string | null): boolean {
		const parent = parentThreadId === null ? undefined : this.#bridge.thread(parentThreadId);
		return parent === undefined || parent.deletedAt !== null || parent.archivedAt !== undefined || parent.settledOverride === "settled";
	}

	/**
	 * T3's settlement sweep (`ThreadSettlementService`): settle every thread that has been quiet for longer than its
	 * project's `sidebarAutoSettleAfterDays` (T3's default: 7 days; `null` turns it off), as of when it went quiet. Pinned
	 * threads, threads kept active, threads with automatic settlement turned off, and running threads stay.
	 *
	 * A subagent thread (a `thread_prompt` child) has no days of its own since 0.1.11: it stays while its parent is live
	 * and active, and settles as of now once the parent is settled, archived or deleted, whatever the setting.
	 */
	async sweep(now = Date.now()): Promise<void> {
		if (this.#bridge.closed() || this.#sweeping) return;
		this.#sweeping = true;
		try {
			const settings = this.#bridge.config.settings.current();
			for (const thread of this.#bridge.threads()) {
				if (this.#bridge.closed()) return;
				const subagent = thread.lineage.relationshipToParent === "subagent";
				const days = subagent ? (this.#parentDone(thread.lineage.parentThreadId) ? 0 : null) : autoSettleDays(settings, thread.projectId);
				if (days === null || !this.#bridge.hasThread(thread.threadId)) continue;
				const shell = this.#bridge.shell(thread.threadId);
				const settledAt = autoSettleAt(shell, days, now, thread.lastSnoozeWakeAt);
				if (settledAt === null) continue;
				try {
					await this.autoSettle(thread.threadId, DateTime.toEpochMillis(shell.updatedAt), subagent ? undefined : settledAt);
				} catch (error) {
					this.#bridge.log.warn("automatic thread settlement skipped", { threadId: thread.threadId, error: messageOf(error) });
				}
			}
		} finally {
			this.#sweeping = false;
		}
	}
}
