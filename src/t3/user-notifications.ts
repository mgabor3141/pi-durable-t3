// Telling a user who is not looking. When a thread needs its user or its run has ended, and no T3 client has shown them
// so, the integrator's `notifyUser` is called for it, once (attachT3's option: a push to a phone, say).
//
// What is worth telling is T3's own choice: the state its server publishes for its phone alerts
// (`projectThreadAwarenessV2`, which T3's AgentAwarenessRelay.ts sends through T3 Connect), read from each thread's
// shell as it changes. So the same threads stay quiet as in T3: a child or a side chat, an archived thread, a completion
// while the thread is snoozed or its awaited work still runs, and a run that was stopped or ended silent. A thread
// hidden by its tags (T3's Settings) stays quiet too, as in T3's own clients.
//
// Whether the user is looking is what T3's clients report (`server.reportClientActivity`: every 25 seconds, and at once
// when a window is shown, hidden, focused or left, or touched after a pause). T3 uses the reports to pace its
// background polling; nothing else in T3 reads them.
//
//   - No sign of the user (no client in front, no input lately): told at once, a completion once T3's few seconds have
//     confirmed it.
//   - Otherwise the notification waits `HOLD_MS`, and is dropped for good when the user turns out to be there.
//     A web or desktop window in front is where T3 shows what happens to any thread (the thread, its sidebar row, a
//     toast when the client has those on): input there since the event, or a thread opened there, is the user.
//     The phone app alerts to nothing by itself: T3's own push still shows while it is open, except for the thread
//     on its screen. So there it is the thread on its screen: the one the app has visited up to the event, while it
//     is in front. And whoever writes in a thread, from any client, has seen where it stood.
//   - A request that is answered is not told. A run's end gives way to what its thread has to tell next: a request, a
//     later run's end. While its continuation works (the thread goes on within T3's few seconds: a queued message)
//     it is not told, and when that ends with nothing of its own to tell (a scheduled check that ended silent, a
//     stop), it is told after all: silence says nothing of the run before it. A run that starts later is no
//     continuation, and leaves the end before it to be told at its time.
//
// Nothing is kept on disk. Each request and each run's end is told once per process (`#told`); what happened before
// this process started was the last process's to tell, which sends what still waits as it closes (`flush`). A thread's
// first sight tells nothing, as in T3's clients.
import { DateTime } from "effect";
import { isListedThreadLineage, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { projectThreadAwarenessV2, subagentAwaitsUser, type SubagentRequestAwareness } from "@t3tools/shared/agentAwareness";
import type { Bridge } from "./bridge.ts";
import type { Logger } from "./logging.ts";
import type { NotifyUser, UserNotification } from "./notify-user.ts";
import { isSnoozed } from "./sidebar.ts";
import type { WsItem, WsPayload } from "./ws-types.ts";
import { messageOf } from "../host-errors.ts";

/** How long a notification waits for a user who was near to show that they are there. T3's clients report "input in
 * the last 45 seconds" every 25: a report says so of the time since an event once it comes 50 seconds after it, which
 * the third report does. */
const HOLD_MS = 90_000;
/** T3's wait before it tells a phone that a run completed: a run can end moments before the next one starts. */
const CONFIRM_MS = 5_000;
/** How long after the last report of input the user still counts as near. */
const RECENT_MS = 120_000;
/** T3's `RECENT_INTERACTION_WINDOW_MS`: how far back a client's `recentlyInteracted` looks. */
const INTERACTION_WINDOW_MS = 45_000;
/** How long a report is taken to be on its way at most (T3's clients give one up after 15 seconds). */
const REPORT_DELAY_MS = 5_000;
/** T3's lease times (`BackgroundPolicy.ts`): how long a report stands without the next one. */
const DEFAULT_LEASE_MS = 45_000;
const MAX_LEASE_MS = 120_000;

const KINDS: { readonly [phase: string]: UserNotification["kind"] } = { waiting_for_approval: "approval", waiting_for_input: "input", completed: "completed", failed: "failed" };

const ms = (value: DateTime.Utc): number => DateTime.toEpochMillis(value);

/** What a client last reported of itself, by its connection. */
type Client = { readonly phone: boolean; readonly visible: boolean; readonly focused: boolean; readonly interacted: boolean; readonly until: number };

/** What a thread has to tell: a request of the user (`asks`), or its run's end. */
type ThreadEvent = {
	/** The request's id, or the run's with how it ended: the same while the thread says the same. */
	readonly key: string;
	readonly asks: boolean;
	/** T3 keeps this one quiet: it counts as told. */
	readonly quiet: boolean;
	/** When it happened: the request was made, the run ended. */
	readonly at: number;
	/** The thread's `updatedAt` with it: a client that has visited the thread up to then has it on its screen. */
	readonly updatedAt: number;
	/** The run that ended. */
	readonly run?: string;
	readonly notification: UserNotification;
};

type Waiting = ThreadEvent & {
	readonly since: number;
	cancel: () => void;
	/** The thread went on within T3's few seconds of this run's end: its continuation, which works still. */
	continues: boolean;
	/** Its time came while its continuation worked. */
	due: boolean;
};

/** What a thread has told, or kept quiet on purpose. As T3's clients keep it (`createThreadNotificationGate`): the
 * requests since the thread last had none, and the newest run end with when it was, so that an undo back to an older
 * run tells nothing. */
type Told = { readonly asked: Set<string>; ended?: string; endedAt: number };

/** T3's `snoozedCompletion` (AgentAwarenessRelay.ts): the run completed while the thread was snoozed. Read at the
 * completion's time, so that it stays quiet once the snooze has ended. */
function snoozedCompletion(shell: OrchestrationV2ThreadShell): boolean {
	if (shell.latestRunCompletedAt == null) return false;
	const completedAt = ms(shell.latestRunCompletedAt);
	if (shell.snoozedAt != null && completedAt < ms(shell.snoozedAt)) return false;
	return isSnoozed(shell, completedAt);
}

export class UserNotifications {
	/** The clock and its timers: a test's own, to let the minutes pass. */
	static clock: { now(): number; after(ms: number, run: () => void): () => void } = {
		now: () => Date.now(),
		after: (wait, run) => {
			const timer = setTimeout(run, wait);
			timer.unref();
			return () => clearTimeout(timer);
		},
	};

	readonly #bridge: Bridge;
	readonly #environmentId: string;
	readonly #notify: NotifyUser;
	readonly #log: Logger;
	readonly #startedAt = UserNotifications.clock.now();
	readonly #clients = new Map<string, Client>();
	/** The thread each connection visited last, and up to when. A thread that is shown is visited at each change of its
	 * `updatedAt` (T3's `threadVisits.ts`), so a phone app that still shows it has visited it up to what happens. */
	readonly #open = new Map<string, { readonly threadId: string; readonly visitedAt: number }>();
	/** When a client last reported input. A process that starts knows of none, and takes its start for one: clients
	 * are still on their way back, so nothing is told before they could say that the user is there. */
	#inputAt = this.#startedAt;
	/** By thread, from its first sight. */
	readonly #told = new Map<string, Told>();
	readonly #waiting = new Map<string, Waiting>();
	/** Children that wait for the user, each shown on its top-level thread (T3's `subagentAwaitsUser`). */
	readonly #asking = new Map<string, { readonly top: string; readonly at: number; readonly request: SubagentRequestAwareness }>();
	readonly #sending = new Set<Promise<void>>();
	readonly #stop: () => void;

	constructor(bridge: Bridge, environmentId: string, notify: NotifyUser, log: Logger) {
		this.#bridge = bridge;
		this.#environmentId = environmentId;
		this.#notify = notify;
		this.#log = log;
		this.#stop = bridge.onShell((item) => this.#safely(() => this.#shell(item)));
	}

	/** A fault in here must not reach its caller, whose own work it would stop (the bridge showing a thread, a client's
	 * command, a timer): it is logged. */
	#safely(run: () => void): void {
		try {
			run();
		} catch (error) {
			this.#log.warn("user notifications failed", { error: messageOf(error) });
		}
	}

	/** T3's `server.reportClientActivity`, from the connection it came on. */
	report(connectionId: string, report: WsPayload<"server.reportClientActivity">): void {
		this.#safely(() => this.#report(connectionId, report));
	}

	#report(connectionId: string, report: WsPayload<"server.reportClientActivity">): void {
		const now = UserNotifications.clock.now();
		const before = this.#clients.get(connectionId);
		const client: Client = {
			phone: report.clientKind === "mobile",
			visible: report.visible,
			focused: report.focused,
			interacted: report.recentlyInteracted,
			until: now + Math.min(Math.max(report.ttlMs ?? DEFAULT_LEASE_MS, 1_000), MAX_LEASE_MS),
		};
		this.#clients.set(connectionId, client);
		if (client.interacted) this.#inputAt = now;
		if (client.phone) {
			// The phone app says "interacted" for as long as it is in front, which is all it knows: still in front after
			// an event, its user has the thread on its screen before them.
			if (client.visible) this.#onScreen(connectionId);
			return;
		}
		// A window says "interacted" of the last 45 seconds, and at once when input follows a pause.
		if (!client.interacted || !client.visible || !client.focused) return;
		const inputSince = now - REPORT_DELAY_MS - (before?.interacted === false ? 0 : INTERACTION_WINDOW_MS);
		for (const [threadId, waiting] of [...this.#waiting]) if (inputSince >= waiting.since) this.#seen(threadId, waiting, "input in a window in front");
	}

	/** A command a client sent (`orchestration.dispatchCommand`), from the connection it came on. */
	command(connectionId: string, command: WsPayload<"orchestration.dispatchCommand">): void {
		this.#safely(() => {
			if (command.type === "thread.visit") return this.#visited(connectionId, command.threadId, command.visitedAt, command.opened === true);
			if (command.type !== "message.dispatch") return;
			// Whoever writes in a thread has seen where it stood.
			const waiting = this.#waiting.get(command.threadId);
			if (waiting !== undefined) this.#seen(command.threadId, waiting, "the user wrote in the thread");
		});
	}

	/** T3's `thread.visit`: its client has the thread open and has read it up to `visitedAt` (`opened`: has just opened it). */
	#visited(connectionId: string, threadId: string, visitedAt: string, opened: boolean): void {
		this.#open.set(connectionId, { threadId, visitedAt: Date.parse(visitedAt) });
		const client = this.#clients.get(connectionId);
		if (client === undefined || !client.visible || client.until <= UserNotifications.clock.now()) return;
		if (client.phone) this.#onScreen(connectionId);
		else if (opened && client.focused) {
			// A thread that stands open in a window proves nobody: T3 visits it whether or not anyone looks. One that
			// is opened there was opened by someone, who has the window before them.
			for (const [id, waiting] of [...this.#waiting]) this.#seen(id, waiting, "a thread opened in a window in front");
		}
	}

	/** A phone app in front: what waits for the thread on its screen, its user has seen. On its screen: visited up to
	 * what happened. What a child asks does not move its parent's `updatedAt` (nor in T3), so no visit says that the
	 * parent was shown since: such a request is not taken as seen there. */
	#onScreen(connectionId: string): void {
		const open = this.#open.get(connectionId);
		const waiting = open === undefined ? undefined : this.#waiting.get(open.threadId);
		if (open !== undefined && waiting !== undefined && open.visitedAt >= Math.max(waiting.updatedAt, waiting.at)) this.#seen(open.threadId, waiting, "on the phone app's screen");
	}

	disconnected(connectionId: string): void {
		this.#clients.delete(connectionId);
		this.#open.delete(connectionId);
	}

	/** Send now what waits for the user to come back: a process that closes has nobody left to send it. */
	async flush(): Promise<void> {
		for (const [threadId, waiting] of [...this.#waiting]) this.#safely(() => this.#tell(threadId, waiting));
		await Promise.all(this.#sending);
	}

	async close(): Promise<void> {
		this.#stop();
		await this.flush();
	}

	#shell(item: WsItem<"orchestration.subscribeShell">): void {
		if (item.kind === "thread.removed") {
			const threadId = item.threadId as string;
			const waiting = this.#waiting.get(threadId);
			if (waiting !== undefined) this.#drop(threadId, waiting);
			this.#told.delete(threadId);
			const asked = this.#asking.get(threadId);
			if (asked !== undefined) {
				this.#asking.delete(threadId);
				this.#again(asked.top);
			}
		} else if (item.kind === "thread.updated") {
			if (isListedThreadLineage(item.thread.lineage)) this.#observe(item.thread);
			else this.#child(item.thread);
		}
	}

	#observe(shell: OrchestrationV2ThreadShell): void {
		const threadId = shell.id as string;
		const state = this.#state(shell);
		const event = typeof state === "object" ? state : undefined;
		const now = UserNotifications.clock.now();
		const first = !this.#told.has(threadId);
		const told = this.#told.get(threadId) ?? { asked: new Set<string>(), endedAt: 0 };
		this.#told.set(threadId, told);
		if (event?.asks !== true) told.asked.clear();
		let waiting = this.#waiting.get(threadId);
		if (waiting !== undefined && event?.key !== waiting.key) {
			// A request that is gone was answered. A run that had ended and goes on (a failure continued) has not ended,
			// and one that the thread no longer has (it was taken back to its start) never did.
			if (waiting.asks || shell.latestRunId === null || (state === "working" && shell.latestRunId === waiting.run)) waiting = this.#drop(threadId, waiting);
			// A run's end gives way to what its thread has to tell next, and counts as told with it.
			else if (event !== undefined && !event.quiet) {
				this.#mark(told, waiting);
				waiting = this.#drop(threadId, waiting);
			}
			// The thread goes on within T3's few seconds of the run's end: its continuation, as a message queued behind
			// the run is. Until that work ends, the end is not told.
			else if (state === "working" && now - waiting.since < CONFIRM_MS) waiting.continues = true;
		}
		if (event !== undefined && event.key !== waiting?.key && (event.asks ? !told.asked.has(event.key) : event.key !== told.ended && event.at > told.endedAt)) {
			// Not to tell: what a thread says at its first sight, what T3 keeps quiet, and what happened before this
			// process started (the last process told it, or sent it as it closed).
			if (first || event.quiet || event.at < this.#startedAt) this.#mark(told, event);
			else this.#hold(threadId, event, now);
		}
		// The continuation is over, and had nothing of its own to tell (it ended silent, or was stopped): the end that
		// waited is told as soon as its time has come.
		if (waiting?.continues === true && state !== "working") {
			waiting.continues = false;
			if (waiting.due) this.#tell(threadId, waiting);
		}
	}

	#hold(threadId: string, event: ThreadEvent, now: number): void {
		const wait = this.#near(now) ? HOLD_MS : event.notification.kind === "completed" ? CONFIRM_MS : 0;
		const held: Waiting = { ...event, since: now, cancel: () => {}, continues: false, due: false };
		this.#waiting.set(threadId, held);
		if (wait === 0) return this.#tell(threadId, held);
		held.cancel = UserNotifications.clock.after(wait, () =>
			this.#safely(() => {
				if (held.continues) held.due = true;
				else this.#tell(threadId, held);
			}),
		);
		this.#log.info("user notification held", { threadId, kind: event.notification.kind, forMs: wait });
	}

	/** What a thread's shell shows: something to tell, work going on, or neither. T3's phase for its phone alerts, read
	 * once as the thread says it and once with nothing keeping it quiet, so that a quiet event still has its name. */
	#state(shell: OrchestrationV2ThreadShell): ThreadEvent | "working" | undefined {
		if (shell.archivedAt !== null) return undefined;
		const threadId = shell.id as string;
		const asked = this.#below(threadId);
		const project = { title: this.#bridge.projects().find((candidate) => candidate.id === shell.projectId)?.title ?? "" };
		const input = { environmentId: this.#environmentId as never, project, pendingSubagentRequest: asked?.request ?? null };
		const loud = projectThreadAwarenessV2({ ...input, thread: { ...shell, latestRunStopRequested: false, settledOverride: null } });
		if (loud === null) return undefined;
		const kind = KINDS[loud.phase];
		if (kind === undefined) return "working";
		const own = shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.kind !== "auth_refresh" ? shell.pendingRuntimeRequest : undefined;
		const request = kind === "approval" || kind === "input";
		if (request && own === undefined && asked === undefined) return undefined;
		// Quiet as it happens: a run that was stopped or ended silent, the end of a run in a thread that was settled
		// before it, a completion in a snoozed thread, a thread hidden by its tags.
		const quiet =
			projectThreadAwarenessV2({ ...input, thread: shell })?.phase !== loud.phase ||
			(kind === "completed" && snoozedCompletion(shell)) ||
			this.#hidden(shell);
		return {
			key: request ? `${own?.id ?? asked?.request.requestId}` : `${shell.latestRunId} ${kind}`,
			asks: request,
			quiet,
			at: request ? (own === undefined ? asked!.at : ms(own.createdAt)) : ms(shell.latestRunCompletedAt ?? shell.updatedAt),
			updatedAt: ms(shell.updatedAt),
			...(request || shell.latestRunId === null ? {} : { run: shell.latestRunId }),
			notification: { kind, threadId, environmentId: this.#environmentId, threadTitle: loud.threadTitle || "New thread", projectTitle: loud.projectTitle, headline: loud.headline },
		};
	}

	/** T3's clients hide the threads that carry a tag the settings name (`hiddenThreadTags` with `hideTaggedThreads`),
	 * and tell nothing about them. */
	#hidden(shell: OrchestrationV2ThreadShell): boolean {
		const settings = this.#bridge.config.settings.current();
		if (settings.hideTaggedThreads !== true || shell.tags === undefined) return false;
		const hidden = new Set(settings.hiddenThreadTags.map((tag) => tag.trim()));
		return shell.tags.some((tag) => hidden.has(tag));
	}

	/** A child's shell: its wait for the user, if it has one, is its top-level thread's to tell. */
	#child(shell: OrchestrationV2ThreadShell): void {
		const childId = shell.id as string;
		const before = this.#asking.get(childId);
		const request = shell.archivedAt === null && subagentAwaitsUser(shell) ? shell.pendingRuntimeRequest : null;
		if (request === null) {
			if (before === undefined) return;
			this.#asking.delete(childId);
			this.#again(before.top);
			return;
		}
		const top = before?.top ?? this.#top(shell);
		if (top === undefined) return;
		this.#asking.set(childId, { top, at: ms(request.createdAt), request: { requestId: request.id, updatedAt: shell.updatedAt, waitsForInput: request.kind === "user_input" } });
		this.#again(top);
	}

	/** T3's `findTopLevelThreadId`: the thread a child's request shows on. */
	#top(child: OrchestrationV2ThreadShell): string | undefined {
		const seen = new Set<string>([child.id]);
		let current = child;
		while (current.lineage.relationshipToParent === "subagent" || current.lineage.sideChat === true) {
			const parentId = current.lineage.parentThreadId as string | null;
			if (parentId === null || seen.has(parentId) || !this.#bridge.hasThread(parentId)) return undefined;
			seen.add(parentId);
			current = this.#bridge.threadShell(parentId);
		}
		return current.id;
	}

	/** The newest wait among a thread's children, as T3 announces it. */
	#below(threadId: string) {
		let newest: { readonly at: number; readonly request: SubagentRequestAwareness } | undefined;
		for (const asked of this.#asking.values()) {
			if (asked.top === threadId && (newest === undefined || DateTime.isGreaterThan(asked.request.updatedAt, newest.request.updatedAt))) newest = asked;
		}
		return newest;
	}

	#again(threadId: string): void {
		if (this.#bridge.hasThread(threadId)) this.#observe(this.#bridge.threadShell(threadId));
	}

	/** A sign of the user: a client in front (T3's `isForegroundLease`), or input not long ago. */
	#near(now: number): boolean {
		if (now - this.#inputAt <= RECENT_MS) return true;
		for (const client of this.#clients.values()) if (client.until > now && client.visible && (client.focused || client.interacted)) return true;
		return false;
	}

	#mark(told: Told, event: ThreadEvent): void {
		if (event.asks) return void told.asked.add(event.key);
		told.ended = event.key;
		told.endedAt = Math.max(told.endedAt, event.at);
	}

	#tell(threadId: string, waiting: Waiting): void {
		const told = this.#told.get(threadId);
		if (this.#waiting.get(threadId) !== waiting || told === undefined) return;
		this.#drop(threadId, waiting);
		this.#mark(told, waiting);
		// The thread may have been made quiet while this waited: its tags hidden, or, for a completion, snoozed (T3's
		// clients keep a completion quiet in a thread that is snoozed now). Not by a settle: T3's relay still tells a
		// completion whose thread was settled while it waited, as an agent that settles its own thread does after its run.
		if (!this.#bridge.hasThread(threadId)) return;
		const shell = this.#bridge.threadShell(threadId);
		const { kind } = waiting.notification;
		if (this.#hidden(shell) || (kind === "completed" && isSnoozed(shell, UserNotifications.clock.now()))) return;
		// Under the title the thread has now: a new thread's is made while its first run goes.
		const notification = { ...waiting.notification, threadTitle: shell.title || "New thread" };
		const sending = Promise.resolve()
			.then(() => this.#notify(notification))
			.then(
				() => this.#log.info("user notified", { threadId, kind, waitedMs: UserNotifications.clock.now() - waiting.since }),
				(error: unknown) => this.#log.warn("a user notification was not sent", { threadId, kind, error: messageOf(error) }),
			);
		this.#sending.add(sending);
		void sending.finally(() => this.#sending.delete(sending));
	}

	/** The user is there, and a client showed them: nothing to send, now or later. */
	#seen(threadId: string, waiting: Waiting, how: string): void {
		const told = this.#told.get(threadId);
		this.#drop(threadId, waiting);
		if (told !== undefined) this.#mark(told, waiting);
		this.#log.info("user notification not needed", { threadId, kind: waiting.notification.kind, how });
	}

	#drop(threadId: string, waiting: Waiting): undefined {
		waiting.cancel();
		if (this.#waiting.get(threadId) === waiting) this.#waiting.delete(threadId);
	}
}
