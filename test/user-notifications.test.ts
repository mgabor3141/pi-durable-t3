// `notifyUser`: a user who is not looking is told once when a thread needs them or its run has ended. What is worth
// telling is T3's own choice (its state for phone alerts); whether the user is looking is what T3's clients report of
// themselves. Told at once with nobody near, after a wait otherwise, and never when the user proved to be there or the
// thread moved on. Nothing is kept: a process tells what happens while it runs.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, onTestFinished } from "vitest";
import { attachT3, mintPairingCode, type UserNotification } from "../src/bridge.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { UserNotifications } from "../src/t3/user-notifications.ts";
import { bridgeConfig, createNamed, makeThreads, quietLog } from "./threads-harness.ts";
import { until } from "./wait.ts";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";

const PORT = 4976;

/** A clock a test moves: timers run when their time has passed. It starts at the real time, as the shells' times do. */
function manualClock() {
	let now = Date.now();
	const timers = new Set<{ readonly at: number; readonly run: () => void }>();
	return {
		now: () => now,
		after: (wait: number, run: () => void) => {
			const timer = { at: now + wait, run };
			timers.add(timer);
			return () => void timers.delete(timer);
		},
		pass(wait: number): void {
			const until = now + wait;
			for (;;) {
				const due = [...timers].filter((timer) => timer.at <= until).sort((left, right) => left.at - right.at)[0];
				if (due === undefined) break;
				timers.delete(due);
				now = due.at;
				due.run();
			}
			now = until;
		},
	};
}

let clock: ReturnType<typeof manualClock>;
const realClock = UserNotifications.clock;
beforeEach(() => {
	clock = manualClock();
	UserNotifications.clock = clock;
});
afterEach(() => {
	UserNotifications.clock = realClock;
});

/** A notification is sent in a later microtask: let it be. */
const sent = () => new Promise((resolve) => setImmediate(resolve));
const time = (at: number) => DateTime.makeUnsafe(at);

type ShellFields = { readonly id: string } & { readonly [field: string]: unknown };
function shell(fields: ShellFields): OrchestrationV2ThreadShell {
	return {
		projectId: "p",
		title: "Fix the build",
		lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: fields.id },
		creationSource: "web",
		modelSelection: { instanceId: "pi", model: "faux/model", options: [] },
		status: "idle",
		activityRunStatus: null,
		latestRunId: null,
		latestRunCompletedAt: null,
		latestRunStopRequested: false,
		pendingRuntimeRequest: null,
		pendingBackgroundTasks: [],
		settledOverride: null,
		archivedAt: null,
		snoozedUntil: null,
		snoozedAt: null,
		updatedAt: time(clock.now()),
		...fields,
	} as unknown as OrchestrationV2ThreadShell;
}
const running = (id: string, run: string, more: Record<string, unknown> = {}) => shell({ id, status: "running", activityRunStatus: "running", latestRunId: run, ...more });
const completed = (id: string, run: string, more: Record<string, unknown> = {}) => shell({ id, status: "completed", latestRunId: run, latestRunCompletedAt: time(clock.now()), ...more });
const failed = (id: string, run: string) => shell({ id, status: "failed", latestRunId: run, latestRunCompletedAt: time(clock.now()) });
const approval = (requestId: string) => ({ id: requestId, kind: "permission", createdAt: time(clock.now()), blocking: true });
const question = (requestId: string) => ({ id: requestId, kind: "user_input", createdAt: time(clock.now()), blocking: true });

/** The notifications over a bridge that shows the shells a test gives it. */
function setup(options: { readonly settings?: Record<string, unknown>; readonly notify?: (notification: UserNotification) => Promise<void> } = {}) {
	const shells = new Map<string, OrchestrationV2ThreadShell>();
	let listener: (item: unknown) => void = () => {};
	const settings = { hideTaggedThreads: false, hiddenThreadTags: [] as string[], ...options.settings };
	const bridge = {
		onShell: (listen: (item: unknown) => void) => {
			listener = listen;
			return () => void (listener = () => {});
		},
		hasThread: (threadId: string) => shells.has(threadId),
		threadShell: (threadId: string) => shells.get(threadId)!,
		projects: () => [{ id: "p", title: "claw" }],
		config: { settings: { current: () => settings } },
	} as unknown as Bridge;
	const told: UserNotification[] = [];
	const logged: string[] = [];
	const log = { info: (message: string) => void logged.push(message), warn: (message: string) => void logged.push(message) };
	const notifications = new UserNotifications(bridge, "env-1", options.notify ?? (async (notification) => void told.push(notification)), log);
	// A moment after the host started: what happens from here on is this process's to tell.
	clock.pass(1_000);
	const show = (next: OrchestrationV2ThreadShell) => {
		shells.set(next.id, next);
		listener({ kind: "thread.updated", sequence: 0, location: "active", thread: next });
	};
	const remove = (threadId: string) => {
		shells.delete(threadId);
		listener({ kind: "thread.removed", sequence: 0, location: "active", threadId });
	};
	/** An archived thread leaves the live list, and is still there. */
	const archive = (threadId: string) => {
		shells.set(threadId, { ...shells.get(threadId)!, archivedAt: time(clock.now()) } as OrchestrationV2ThreadShell);
		listener({ kind: "thread.removed", sequence: 0, location: "active", threadId });
	};
	/** A client's report of itself: a window unless `clientKind` says otherwise. */
	const report = (connectionId: string, fields: { clientKind?: string; visible?: boolean; focused?: boolean; recentlyInteracted?: boolean } = {}) =>
		notifications.report(connectionId, { clientId: connectionId, clientKind: "desktop-renderer", visible: true, focused: true, recentlyInteracted: true, scopes: [], ttlMs: 45_000, observedAt: time(clock.now()), ...fields } as never);
	/** A client's visit of a thread: read up to `at` (now, by default), and whether it has just opened the thread. */
	const visit = (connectionId: string, threadId: string, options: { at?: number; opened?: boolean } = {}) =>
		notifications.command(connectionId, { commandId: "visit", type: "thread.visit", threadId, visitedAt: new Date(options.at ?? clock.now()).toISOString(), ...(options.opened === true ? { opened: true } : {}) } as never);
	/** A message someone sends in a thread from a client. */
	const write = (connectionId: string, threadId: string) => notifications.command(connectionId, { commandId: "write", type: "message.dispatch", threadId, messageId: "m", text: "and then?" } as never);
	return { notifications, told, logged, show, remove, archive, report, visit, write, settings };
}

/** Long enough since the start that it no longer counts as input: nobody is near. */
const AWAY = 121_000;
const kinds = (told: readonly UserNotification[]) => told.map((notification) => notification.kind);

it("with nobody near, a request and a failure are told at once, and a completion once T3's five seconds confirmed it", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	show(running("t", "r1"));
	show(completed("t", "r1"));
	clock.pass(4_999);
	await sent();
	expect(told).toEqual([]);
	clock.pass(1);
	await sent();
	expect(told).toEqual([{ kind: "completed", threadId: "t", environmentId: "env-1", threadTitle: "Fix the build", projectTitle: "claw", headline: "Agent finished" }]);

	show(running("t", "r2", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(told.at(-1)).toMatchObject({ kind: "approval", headline: "Approval needed" });
	show(running("t", "r2", { pendingRuntimeRequest: question("req-2") }));
	await sent();
	expect(told.at(-1)).toMatchObject({ kind: "input", headline: "Waiting for input" });
	show(running("t", "r2"));
	show(failed("t", "r2"));
	await sent();
	expect(kinds(told)).toEqual(["completed", "approval", "input", "failed"]);
	expect(told.at(-1)).toMatchObject({ headline: "Agent failed" });
});

it("each request and each run is told once, whatever else changes on the thread", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	const request = approval("req-1");
	show(running("t", "r1", { pendingRuntimeRequest: request }));
	show(running("t", "r1", { pendingRuntimeRequest: request, title: "Renamed" }));
	// A message queued behind the request becomes the latest run; the request is the same one.
	show(running("t", "r2", { pendingRuntimeRequest: request }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
	// Answered, and the same request asked again (a redo brings it back): the thread needs its user anew, as in T3.
	show(running("t", "r2"));
	show(running("t", "r2", { pendingRuntimeRequest: request }));
	await sent();
	expect(kinds(told)).toEqual(["approval", "approval"]);

	show(running("t", "r2"));
	const done = completed("t", "r2");
	show(done);
	clock.pass(5_000);
	await sent();
	show({ ...done, title: "Renamed again" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(kinds(told)).toEqual(["approval", "approval", "completed"]);
});

it("a completion that the next run follows within T3's five seconds is not told", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	show(running("t", "r1"));
	show(completed("t", "r1"));
	clock.pass(2_000);
	show(running("t", "r2"));
	clock.pass(60_000);
	await sent();
	expect(told).toEqual([]);
	show(completed("t", "r2"));
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("with a window in front, a notification waits 90 seconds and is told when no input follows", async () => {
	const { told, show, report, logged } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	// In front and focused, but nobody has touched it for a while: the user may have walked away from it.
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(told).toEqual([]);
	expect(logged).toContain("user notification held");
	clock.pass(25_000);
	report("desk", { recentlyInteracted: false });
	// The thread is shown again with the same request (renamed, say): the wait goes on, it does not start over.
	show(running("t", "r1", { pendingRuntimeRequest: { ...approval("req-1"), createdAt: time(clock.now() - 25_000) }, title: "Renamed" }));
	clock.pass(64_999);
	await sent();
	expect(told).toEqual([]);
	clock.pass(1);
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("input in a focused window after the event means the user saw it: nothing is told, then or later", async () => {
	const { told, show, report, logged } = setup();
	show(shell({ id: "t" }));
	report("desk");
	show(running("t", "r1"));
	show(completed("t", "r1"));
	expect(logged).toEqual(["user notification held"]);
	// "Input in the last 45 seconds" 20 seconds after the event may be input from before it.
	clock.pass(20_000);
	report("desk");
	expect(logged).not.toContain("user notification not needed");
	// 50 seconds after, with the report's own delay allowed for, it is input since the event.
	clock.pass(30_001);
	report("desk");
	expect(logged).toContain("user notification not needed");
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("input after a pause is reported at once, and counts at once", async () => {
	const { told, show, report, logged } = setup();
	show(shell({ id: "t" }));
	report("desk");
	show(running("t", "r1"));
	clock.pass(60_000);
	report("desk", { recentlyInteracted: false });
	show(completed("t", "r1"));
	expect(logged).toEqual(["user notification held"]);
	clock.pass(10_000);
	report("desk");
	expect(logged).toEqual(["user notification held", "user notification not needed"]);
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("input in a window that is not in front proves nothing: T3 showed nothing there", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { focused: false });
	show(running("t", "r1"));
	show(completed("t", "r1"));
	clock.pass(60_000);
	report("desk", { focused: false });
	clock.pass(30_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("the phone app in front covers the thread on its screen and no other", async () => {
	const { told, show, report, visit, logged } = setup();
	show(shell({ id: "a" }));
	show(shell({ id: "b" }));
	// Thread a is on the phone's screen, and works: the app visits it at each change.
	report("phone", { clientKind: "mobile" });
	show(running("a", "r1"));
	visit("phone", "a", { opened: true });
	clock.pass(1_000);
	show(running("b", "r2"));
	show(completed("b", "r2"));
	// A request dates the thread, and the app that shows it visits once more, within T3's ten seconds: a visit after
	// the event is on its way. What says so first is the app's own report, in front, once that visit has come.
	const asking = running("a", "r1", { pendingRuntimeRequest: approval("req-1") });
	show(asking);
	expect(logged).toEqual(["user notification held", "user notification held"]);
	clock.pass(5_000);
	report("phone", { clientKind: "mobile", visible: false, focused: false, recentlyInteracted: false });
	visit("phone", "a", { at: DateTime.toEpochMillis(asking.updatedAt) });
	expect(logged).toEqual(["user notification held", "user notification held"]);
	clock.pass(20_000);
	report("phone", { clientKind: "mobile" });
	expect(logged.filter((line) => line === "user notification not needed")).toHaveLength(1);
	// A window where thread b stands open proves nobody: T3 visits a thread that is shown whether anyone looks or not.
	report("desk", { recentlyInteracted: false });
	visit("desk", "b");
	clock.pass(65_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["b"]);
});

it("what a child asks is not taken as seen on the phone app: nothing says that its parent was shown since", async () => {
	const { told, show, report, visit } = setup();
	show(shell({ id: "top" }));
	const child = { id: "child", creationSource: "mcp", lineage: { parentThreadId: "top", relationshipToParent: "subagent", rootThreadId: "top" } };
	show(shell(child));
	report("phone", { clientKind: "mobile" });
	const working = running("top", "r1");
	show(working);
	visit("phone", "top", { opened: true });
	// An hour into the parent's run, with the app in front all along (on the thread, or anywhere else).
	for (let reports = 0; reports < 144; reports++) {
		clock.pass(25_000);
		report("phone", { clientKind: "mobile" });
	}
	show(running("child", "c1", { ...child, pendingRuntimeRequest: approval("req-1") }));
	for (let reports = 0; reports < 3; reports++) {
		clock.pass(25_000);
		report("phone", { clientKind: "mobile" });
		visit("phone", "top", { at: DateTime.toEpochMillis(working.updatedAt) });
	}
	clock.pass(15_000);
	await sent();
	expect(told).toMatchObject([{ kind: "approval", threadId: "top" }]);
});

it("a thread the phone app has left is not on its screen, however long the app stays in front", async () => {
	const { told, show, report, visit } = setup();
	show(shell({ id: "x" }));
	report("phone", { clientKind: "mobile" });
	show(running("x", "r1"));
	visit("phone", "x", { opened: true });
	// Back on the list, or in the app's settings: nothing says so. A thread that is shown is visited at each change,
	// so one that changes unvisited is not shown.
	clock.pass(20_000);
	show(completed("x", "r1"));
	for (let reports = 0; reports < 3; reports++) {
		clock.pass(25_000);
		report("phone", { clientKind: "mobile" });
	}
	clock.pass(15_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["x"]);
});

it("a visit from the phone app in front counts at once; from one that left the front, or went silent, it does not", async () => {
	const { told, show, report, visit, logged } = setup();
	for (const id of ["a", "b", "c", "d"]) show(shell({ id }));
	report("phone", { clientKind: "mobile" });
	report("another phone", { clientKind: "mobile" });
	for (const id of ["a", "b", "c", "d"]) show(running(id, `r-${id}`));
	const before = clock.now();
	// The other phone's last report runs out: nothing says it is still in front.
	clock.pass(46_000);
	report("phone", { clientKind: "mobile" });
	for (const id of ["a", "b", "c", "d"]) show(completed(id, `r-${id}`));
	// The app has thread a on its screen as it completes, and visits it. A visit that was on its way reads thread d
	// only up to before it completed.
	visit("phone", "d", { at: before });
	visit("phone", "a");
	expect(logged.filter((line) => line === "user notification not needed")).toHaveLength(1);
	visit("another phone", "c");
	// The app leaves the front; a visit it still sends says nothing of its user, nor does what it reports from there.
	report("phone", { clientKind: "mobile", visible: false, focused: false, recentlyInteracted: false });
	visit("phone", "b");
	clock.pass(25_000);
	report("phone", { clientKind: "mobile", visible: false, focused: false, recentlyInteracted: false });
	clock.pass(65_000);
	await sent();
	expect(told.map((notification) => notification.threadId).sort()).toEqual(["b", "c", "d"]);
});

it("a thread opened in a window in front is the user's doing; one that stands open there is not", async () => {
	const { told, show, report, visit, logged } = setup();
	for (const id of ["t", "u"]) show(shell({ id }));
	report("desk", { recentlyInteracted: false });
	report("behind", { focused: false });
	for (const id of ["t", "u"]) show(running(id, `r-${id}`));
	for (const id of ["t", "u"]) show(completed(id, `r-${id}`));
	visit("desk", "t");
	visit("behind", "t", { opened: true });
	expect(logged).toEqual(["user notification held", "user notification held"]);
	// A click in the sidebar, or the toast's "Open thread": whoever opened a thread saw what the window showed.
	visit("desk", "t", { opened: true });
	expect(logged.filter((line) => line === "user notification not needed")).toHaveLength(2);
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("a run's end that waits is still told when something else runs in the thread and ends silent", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	show(completed("t", "r1"));
	// A scheduled task's run in the same thread, 40 seconds on, which finds nothing and says so.
	clock.pass(40_000);
	show(running("t", "r2"));
	clock.pass(10_000);
	const silent = completed("t", "r2", { latestRunStopRequested: true });
	show(silent);
	clock.pass(39_999);
	await sent();
	expect(told).toEqual([]);
	clock.pass(1);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
	// The thread closes, and its shell loses the silent run's flag: nothing more to tell.
	show({ ...silent, latestRunStopRequested: false } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("a run's end is not told while its continuation works, and is told when that ends with nothing to tell", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	for (const id of ["silent", "stopped", "slow"]) show(shell({ id }));
	for (const id of ["silent", "stopped", "slow"]) show(running(id, "r1"));
	for (const id of ["silent", "stopped", "slow"]) show(completed(id, "r1"));
	// A scheduled task's prompt waited behind each run, and starts as the run ends.
	clock.pass(1_000);
	for (const id of ["silent", "stopped", "slow"]) show(running(id, "r2"));
	// The first run's time comes and goes: nothing is told of a thread that works on.
	clock.pass(20_000);
	await sent();
	expect(told).toEqual([]);
	// One check finds nothing and says so; one is stopped. What they followed is told now.
	show(completed("silent", "r2", { latestRunStopRequested: true }));
	show(shell({ id: "stopped", status: "interrupted", latestRunId: "r2", latestRunCompletedAt: time(clock.now()), latestRunStopRequested: true }));
	await sent();
	expect(told.map((notification) => `${notification.threadId} ${notification.kind}`).sort()).toEqual(["silent completed", "stopped completed"]);
	// One goes on for ten minutes and has an answer of its own: that is the one thing told of its thread.
	clock.pass(600_000);
	show(completed("slow", "r2"));
	clock.pass(5_000);
	await sent();
	expect(told.map((notification) => notification.threadId).sort()).toEqual(["silent", "slow", "stopped"]);
});

it("a continuation that ends silent before the first end's time has come does not hurry it", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	show(completed("t", "r1"));
	clock.pass(1_000);
	show(running("t", "r2"));
	clock.pass(19_000);
	show(completed("t", "r2", { latestRunStopRequested: true }));
	clock.pass(69_999);
	await sent();
	expect(told).toEqual([]);
	clock.pass(1);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("a run that starts later is not a continuation: the end before it is told at its time, though the thread works", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	show(completed("t", "r1"));
	// A scheduled task's long run, 40 seconds on.
	clock.pass(40_000);
	show(running("t", "r2"));
	clock.pass(50_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
	// Its own end, an hour later, is the thread's next word.
	clock.pass(3_600_000);
	show(completed("t", "r2"));
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["completed", "completed"]);
});

it("a run's end that waits gives way to what its thread has to tell next, and is not told later either", async () => {
	const { told, show, report } = setup();
	for (const id of ["ends", "asks"]) show(shell({ id }));
	report("desk", { recentlyInteracted: false });
	for (const id of ["ends", "asks"]) show(running(id, "r1"));
	const first = completed("asks", "r1");
	show(completed("ends", "r1"));
	show(first);
	clock.pass(40_000);
	for (const id of ["ends", "asks"]) show(running(id, "r2"));
	clock.pass(20_000);
	show(completed("ends", "r2"));
	show(running("asks", "r2", { pendingRuntimeRequest: approval("req-1") }));
	// The first runs' time comes: neither is told, each thread has its newer word waiting.
	clock.pass(30_000);
	await sent();
	expect(told).toEqual([]);
	// The second run is undone while its request waits: the thread shows its first run's end again, which gave way.
	show({ ...first, title: "Undone" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(told.map((notification) => `${notification.threadId} ${notification.kind}`)).toEqual(["ends completed"]);
});

it("a failure that is continued has not ended: it is not told", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	show(failed("t", "r1"));
	// "Continue", half a minute on: the same run goes on, and completes.
	clock.pass(30_000);
	show(running("t", "r1"));
	clock.pass(120_000);
	await sent();
	expect(told).toEqual([]);
	show(completed("t", "r1"));
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("whoever writes in a thread has seen where it stood", async () => {
	const { notifications, told, show, report, write, logged } = setup();
	for (const id of ["t", "other"]) show(shell({ id }));
	report("desk", { recentlyInteracted: false });
	for (const id of ["t", "other"]) show(running(id, "r1"));
	for (const id of ["t", "other"]) show(completed(id, "r1"));
	clock.pass(30_000);
	// A follow-up in thread t, from a client that has said nothing of itself: a long run starts. The other thread is
	// pinned from there, which is not writing in it.
	show(running("t", "r2"));
	write("somewhere", "t");
	notifications.command("somewhere", { commandId: "pin", type: "thread.pin", threadId: "other" } as never);
	expect(logged).toEqual(["user notification held", "user notification held", "user notification not needed"]);
	clock.pass(600_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["other"]);
});

it("is sent under the title the thread has by then", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t", title: "" }));
	show(running("t", "r1", { title: "" }));
	const done = completed("t", "r1", { title: "" });
	show(done);
	// The title is made while the thread's first run goes, and can arrive after its end.
	clock.pass(2_000);
	show({ ...done, title: "Fix the flaky test" } as OrchestrationV2ThreadShell);
	clock.pass(3_000);
	await sent();
	expect(told).toMatchObject([{ kind: "completed", threadTitle: "Fix the flaky test" }]);
});

it("a client that went away is near for two more minutes, then not", async () => {
	const { notifications, told, show, report } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	report("desk");
	notifications.disconnected("desk");
	clock.pass(119_000);
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(told, "held: input was reported two minutes ago").toEqual([]);
	show(running("t", "r1"));
	clock.pass(2_000);
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-2") }));
	await sent();
	expect(kinds(told), "told at once: nobody is near").toEqual(["approval"]);
});

it("a window that disconnects is no longer in front", async () => {
	const { notifications, told, show, report } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	// In front, with nobody touching it: its report would stand for 45 seconds.
	report("desk", { recentlyInteracted: false });
	notifications.disconnected("desk");
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("a report stands for its lease: a window that stops reporting is no longer in front", async () => {
	const { told, show, report } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	clock.pass(46_000);
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("what waits is dropped when the thread moves on, and told for what comes next", async () => {
	const { told, show, report, logged } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	expect(logged).toEqual(["user notification held"]);
	clock.pass(30_000);
	// Answered (from anywhere): the run goes on.
	show(running("t", "r1"));
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-2") }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("the threads T3 keeps quiet stay quiet, and what they said is not told later", async () => {
	const { told, show, settings } = setup();
	clock.pass(AWAY);
	for (const id of ["settled", "stopped", "snoozed", "tagged", "waiting", "side"]) show(shell({ id }));
	const child = { parentThreadId: "settled", relationshipToParent: "subagent", rootThreadId: "settled" };
	show(shell({ id: "child", lineage: child }));
	show(completed("child", "r0", { lineage: child }));
	show(completed("side", "r0", { lineage: { parentThreadId: "settled", relationshipToParent: null, rootThreadId: "settled", sideChat: true } }));

	// A thread that was settled before its run's end shows (while a child of it still worked, say).
	const settled = completed("settled", "r1", { settledOverride: "settled" });
	show(settled);
	// A run that was stopped, or ended silent, completes with T3's flag for it.
	const stopped = completed("stopped", "r2", { latestRunStopRequested: true });
	show(stopped);
	// Snoozed as its run completes, for three seconds more: quiet then is quiet for good.
	const snoozed = completed("snoozed", "r3", { snoozedAt: time(clock.now() - 1_000), snoozedUntil: time(clock.now() + 3_000) });
	show(snoozed);
	// Hidden by its tag as its run completes, and shown again a moment later.
	settings.hideTaggedThreads = true;
	settings.hiddenThreadTags = ["noise"];
	const tagged = completed("tagged", "r4", { tags: ["noise"] });
	show(tagged);
	settings.hideTaggedThreads = false;
	show({ ...tagged, title: "Shown" } as OrchestrationV2ThreadShell);
	// The run ended, but work it waits for goes on: T3 holds the completion until that ends.
	const task = { id: "task-1", kind: "subagent", title: "A child", runId: "r5", childThreadId: "child" };
	show(completed("waiting", "r5", { pendingBackgroundTasks: [task] }));
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);

	// Un-settled, closed (the flag is read from an open thread only), awake again: the same completions.
	show({ ...settled, settledOverride: null } as OrchestrationV2ThreadShell);
	show({ ...stopped, latestRunStopRequested: false } as OrchestrationV2ThreadShell);
	show({ ...snoozed, title: "Awake" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);

	// The awaited work ended: now the run's completion is told.
	show(completed("waiting", "r5"));
	clock.pass(5_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["waiting"]);
});

it("a quiet run's end is told at no later time either: a thread that closes loses the flag, not the silence", async () => {
	const { told, show, report, logged } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	const silent = completed("t", "r1", { latestRunStopRequested: true });
	show(silent);
	// Half a minute later the thread is closed, and its shell is made from its record, which keeps no flag.
	clock.pass(30_000);
	show({ ...silent, latestRunStopRequested: false } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(logged).toEqual([]);
	expect(told).toEqual([]);
});

it("tags hidden while a notification waits keep it from being told", async () => {
	const { told, show, report, settings } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1", { tags: ["noise"] }));
	show(completed("t", "r1", { tags: ["noise"] }));
	settings.hideTaggedThreads = true;
	settings.hiddenThreadTags = [" noise "];
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("a thread snoozed while its completion waits is not told, then or once it is awake", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	const done = completed("t", "r1");
	show(done);
	clock.pass(10_000);
	// Snoozed from somewhere that proves nobody (an agent's tool): whoever did it wants no word of the thread now.
	const snoozed = { ...done, snoozedAt: time(clock.now()), snoozedUntil: time(clock.now() + 3_600_000) } as OrchestrationV2ThreadShell;
	show(snoozed);
	clock.pass(3_600_000);
	show({ ...done, title: "Awake" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("a thread settled while its completion waits is told all the same, as T3 tells it", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	show(running("t", "r1"));
	const done = completed("t", "r1");
	show(done);
	// An agent that settles its own thread does it just after its run.
	clock.pass(200);
	show({ ...done, settledOverride: "settled" } as OrchestrationV2ThreadShell);
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("an undo back to an older run, or a run's end that moves, tells nothing new", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	show(running("t", "r1"));
	const first = completed("t", "r1");
	show(first);
	clock.pass(5_000);
	show(running("t", "r2"));
	clock.pass(60_000);
	const second = completed("t", "r2");
	show(second);
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["completed", "completed"]);
	// The same run, its end stamped later (an entry written after it).
	clock.pass(60_000);
	show({ ...second, latestRunCompletedAt: time(clock.now()) } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(kinds(told)).toEqual(["completed", "completed"]);
	// The thread is taken back to its first run, which ended before the one told last.
	show({ ...first, title: "Undone" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(kinds(told)).toEqual(["completed", "completed"]);
});

it("an undo while a run's end waits takes that end back with it", async () => {
	const { told, show, report } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	show(running("t", "r1"));
	const first = completed("t", "r1");
	show(first);
	clock.pass(5_000);
	show(running("t", "r2"));
	report("desk", { recentlyInteracted: false });
	clock.pass(30_000);
	show(completed("t", "r2"));
	// Half a minute into its wait the thread is taken back to its first run, whose end was told.
	clock.pass(30_000);
	show({ ...first, title: "Undone" } as OrchestrationV2ThreadShell);
	clock.pass(600_000);
	await sent();
	expect(kinds(told)).toEqual(["completed"]);
});

it("a thread taken back to its start while its first run's end waits has no run that ended", async () => {
	const { told, show, report } = setup();
	show(shell({ id: "t" }));
	report("desk", { recentlyInteracted: false });
	show(running("t", "r1"));
	show(completed("t", "r1"));
	clock.pass(30_000);
	show(shell({ id: "t" }));
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
});

it("a fault in here is logged and stays here", async () => {
	const { told, show, logged, notifications } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	// A shell, and a report, that cannot be read: neither the bridge showing a thread nor a client's call is stopped.
	expect(() => show({ ...running("t", "r1"), lineage: undefined } as never)).not.toThrow();
	expect(() => notifications.report("desk", null as never)).not.toThrow();
	expect(logged).toEqual(["user notifications failed", "user notifications failed"]);
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("a snoozed thread still tells of a request, as T3's does", async () => {
	const { told, show } = setup();
	clock.pass(AWAY);
	show(shell({ id: "t" }));
	const snooze = { snoozedAt: time(clock.now()), snoozedUntil: time(clock.now() + 3_600_000) };
	clock.pass(1_000);
	show(running("t", "r1", { ...snooze, pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("what a child asks of the user is told for its top-level thread, the newest wait first", async () => {
	const { told, show, remove, archive } = setup();
	clock.pass(AWAY);
	show(shell({ id: "top", title: "The parent" }));
	const below = (id: string, parent: string) => ({ id, creationSource: "mcp", lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: "top" } });
	show(shell(below("child", "top")));
	show(shell(below("grandchild", "child")));
	show(running("top", "r1", { title: "The parent" }));

	show(running("grandchild", "c1", { ...below("grandchild", "child"), pendingRuntimeRequest: approval("req-1") }));
	await sent();
	expect(told).toEqual([{ kind: "approval", threadId: "top", environmentId: "env-1", threadTitle: "The parent", projectTitle: "claw", headline: "Approval needed" }]);
	// A question a child asks is its parent agent's to answer, not the user's; a card only the user can fill is theirs.
	clock.pass(1_000);
	show(running("child", "c2", { ...below("child", "top"), pendingRuntimeRequest: question("req-2") }));
	await sent();
	expect(told).toHaveLength(1);
	show(running("child", "c2", { ...below("child", "top"), pendingRuntimeRequest: { ...question("req-3"), userOnly: true } }));
	await sent();
	expect(told.at(-1)).toMatchObject({ kind: "input", threadId: "top" });
	expect(told).toHaveLength(2);

	// The newer wait is answered: the older one is still there, and was told.
	show(running("child", "c2", below("child", "top")));
	await sent();
	expect(told).toHaveLength(2);
	// The parent's own run ends while a child still asks: the request is what the thread says.
	show(completed("top", "r1", { title: "The parent" }));
	clock.pass(600_000);
	await sent();
	expect(told).toHaveLength(2);
	// The child is gone: the parent's completion is what is left to say.
	remove("grandchild");
	clock.pass(5_000);
	await sent();
	expect(kinds(told)).toEqual(["approval", "input", "completed"]);
	// An archived thread tells nothing, whatever a child of it asks, the first time or the next.
	archive("top");
	show(running("child", "c3", { ...below("child", "top"), pendingRuntimeRequest: approval("req-4") }));
	show(running("child", "c3", below("child", "top")));
	show(running("child", "c3", { ...below("child", "top"), pendingRuntimeRequest: approval("req-5") }));
	clock.pass(600_000);
	await sent();
	expect(told).toHaveLength(3);
});

it("a thread's first sight tells nothing, nor does what happened before this process started", async () => {
	const startedAt = clock.now();
	const { told, show, remove } = setup();
	clock.pass(AWAY);
	// As a host that starts reads its threads: one that completed, one a fork just made with its source's run.
	show(completed("old", "r1"));
	show(completed("fork", "r1"));
	// A card that waited through the restart shows once its thread is open again: asked before, so told before.
	show(running("old", "r2", { pendingRuntimeRequest: { ...approval("req-1"), createdAt: time(startedAt - 60_000) } }));
	// A thread whose record kept no run shows the one it had once it is opened: ended before, so told before.
	show(shell({ id: "bare" }));
	show(completed("bare", "r1", { latestRunCompletedAt: time(startedAt - 60_000) }));
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
	// An archived thread leaves the list; back in it, what it says is not news.
	show(shell({ id: "kept" }));
	remove("kept");
	show(completed("kept", "r9"));
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
	// What happens from here on is.
	show(running("old", "r2"));
	show(completed("old", "r2"));
	clock.pass(5_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["old"]);
});

it("a start counts as input: nothing is told before the clients could come back and say the user is there", async () => {
	const { told, show } = setup();
	show(shell({ id: "t" }));
	show(running("t", "r1", { pendingRuntimeRequest: approval("req-1") }));
	clock.pass(89_999);
	await sent();
	expect(told).toEqual([]);
	clock.pass(1);
	await sent();
	expect(kinds(told)).toEqual(["approval"]);
});

it("flush sends what waits, and close does too; a sender that fails is logged and nothing more", async () => {
	const failing: UserNotification[] = [];
	const { notifications, show, report, logged } = setup({
		notify: async (notification) => {
			failing.push(notification);
			if (notification.threadId === "b") throw new Error("ntfy answered 502");
		},
	});
	for (const id of ["a", "b", "c"]) show(shell({ id }));
	report("desk", { recentlyInteracted: false });
	show(running("a", "r1", { pendingRuntimeRequest: approval("req-1") }));
	show(running("b", "r2", { pendingRuntimeRequest: approval("req-2") }));
	await notifications.flush();
	expect(failing.map((notification) => notification.threadId)).toEqual(["a", "b"]);
	expect(logged).toContain("user notified");
	expect(logged).toContain("a user notification was not sent");
	// Sent: not sent again when its time comes.
	clock.pass(600_000);
	show(running("c", "r3", { pendingRuntimeRequest: approval("req-3") }));
	report("desk", { recentlyInteracted: false });
	show(running("c", "r3"));
	show(running("c", "r3", { pendingRuntimeRequest: approval("req-4") }));
	await notifications.close();
	expect(failing.map((notification) => notification.threadId)).toEqual(["a", "b", "c", "c"]);
});

// A run ends silent when its answer's last line is the word SILENT (silent-run.test.ts): the shell carries T3's flag
// for a run nobody announces, and nothing is told.
it("a real run that ends silent tells nothing; the run after it does", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Watch the queue" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-notify-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	const told: UserNotification[] = [];
	const notifications = new UserNotifications(bridge, "env-1", async (notification) => void told.push(notification), quietLog);
	onTestFinished(async () => {
		await notifications.close();
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	bridge.start();
	await bridge.loaded();
	clock.pass(AWAY);
	const run = async (id: number, answer: string) => {
		f.model.respond(fauxAssistantMessage(answer));
		await bridge.sendMessage({ threadId: "t", commandId: `c${id}`, messageId: `m${id}`, text: `prompt ${id}`, mode: "start" });
		await bridge.waitFor("t", (projection) => (projection.runs.length === id && projection.runs.every((each) => each.status !== "running") ? true : undefined), 10_000);
	};
	await run(1, "Nothing new.\nSILENT");
	expect(bridge.threadShell("t")).toMatchObject({ status: "completed", latestRunStopRequested: true });
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);
	await run(2, "Two new items.");
	clock.pass(5_000);
	await sent();
	expect(told).toEqual([{ kind: "completed", threadId: "t", environmentId: "env-1", threadTitle: "Watch the queue", projectTitle: expect.any(String), headline: "Agent finished" }]);
});

// A request in the middle of a run moves the thread's `updatedAt` (as T3's does with every event), so a client that
// shows the thread visits it then: which is how a phone app says that its user has the request before them.
it("a real question is told as input, and dates the thread: a phone app that shows the thread has visited it since", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Set up storage" });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "u", projectId: "p", title: "Another" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-notify-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
	const told: UserNotification[] = [];
	const logged: string[] = [];
	const notifications = new UserNotifications(bridge, "env-1", async (notification) => void told.push(notification), { info: (message) => void logged.push(message), warn: (message) => void logged.push(message) });
	onTestFinished(async () => {
		await notifications.close();
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	f.tools.install(bridge.userInput.extension());
	bridge.start();
	await bridge.loaded();
	const asked = (threadId: string, callId: string) => {
		// The model takes a moment, as models do: the question comes after the run began.
		f.model.respond(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return fauxAssistantMessage([fauxToolCall("ask_user", { questions: [{ header: "Database", question: "Which database?" }] as never }, { id: callId })], { stopReason: "toolUse" });
		}, fauxAssistantMessage("Noted."));
		return bridge.sendMessage({ threadId, commandId: `c-${callId}`, messageId: `m-${callId}`, text: "Set up storage.", mode: "start" });
	};
	const pending = () => bridge.waitFor("t", (projection) => (projection.runtimeRequests.some((request) => request.status === "pending") ? true : undefined), 10_000);
	const at = (value: DateTime.Utc | null | undefined) => (value == null ? Number.NaN : DateTime.toEpochMillis(value));

	// The phone app has the thread on its screen from before the run, and stays in front.
	const report = () => notifications.report("phone", { clientId: "mobile-1", clientKind: "mobile", visible: true, focused: true, recentlyInteracted: true, scopes: [], ttlMs: 45_000, observedAt: time(clock.now()) } as never);
	const visit = (visitedAt: DateTime.Utc) => notifications.command("phone", { commandId: "visit", type: "thread.visit", threadId: "t", visitedAt: DateTime.formatIso(visitedAt) } as never);
	report();
	visit(bridge.threadShell("t").updatedAt);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await asked("t", "call-1");
	await pending();
	const waiting = bridge.threadShell("t");
	expect(waiting.pendingRuntimeRequest).toMatchObject({ kind: "user_input" });
	expect(at(waiting.updatedAt), "the question is the thread's latest activity").toBe(at(waiting.pendingRuntimeRequest!.createdAt));
	expect(at(waiting.updatedAt)).toBeGreaterThan(at(waiting.latestRunRequestedAt));
	expect(logged).toEqual(["user notification held"]);
	// A report from the app, in front: its last visit is from before the question, so the thread is not on its screen
	// (it would have visited). Then the visit a thread that is shown makes.
	clock.pass(25_000);
	report();
	expect(logged).toEqual(["user notification held"]);
	visit(waiting.updatedAt);
	expect(logged).toEqual(["user notification held", "user notification not needed"]);
	clock.pass(600_000);
	await sent();
	expect(told).toEqual([]);

	// Nobody near, in another thread: the question is told at once, as input.
	notifications.disconnected("phone");
	await asked("u", "call-2");
	await bridge.waitFor("u", (projection) => (projection.runtimeRequests.some((request) => request.status === "pending") ? true : undefined), 10_000);
	await sent();
	expect(told).toEqual([{ kind: "input", threadId: "u", environmentId: "env-1", threadTitle: "Another", projectTitle: expect.any(String), headline: "Waiting for input" }]);
});

it("over the wire: a client's reports and visits are its connection's, and a real run's completion is what is told", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const stateDir = join(f.root, "t3-state");
	const told: UserNotification[] = [];
	const logged: string[] = [];
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir,
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		notifyUser: async (notification) => void told.push(notification),
		log: { info: (message) => void logged.push(message), warn: (message) => void logged.push(message) },
	});
	onTestFinished(() => t3.close());
	f.harness.resume();
	expect(await waitListening(PORT)).toBe(true);
	const token = await pair(PORT, mintPairingCode(stateDir).code);
	const desk = await connectWs(PORT, token);
	const phone = await connectWs(PORT, token);
	onTestFinished(() => {
		desk.close();
		phone.close();
	});
	const providers = exitValue(await desk.call("server.refreshProviders", {}), "providers") as { providers: { instanceId: string; models: { slug: string }[] }[] };
	const provider = providers.providers.find((candidate) => candidate.models.length > 0)!;
	const modelSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug, options: [] };
	const launch = async (threadId: string, title: string) =>
		exitValue(await desk.call("orchestration.launchThread", { commandId: `launch-${threadId}`, threadId, projectId: "p", title, modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" } }), "launch");
	let commands = 0;
	const prompt = async (threadId: string, text: string) => {
		f.model.respond(fauxAssistantMessage(`answer to ${text}`));
		exitValue(
			await desk.call("orchestration.dispatchCommand", { commandId: `cmd-${++commands}`, type: "message.dispatch", createdBy: "user", creationSource: "web", threadId, messageId: `msg-${commands}`, text, attachments: [], modelSelection, dispatchMode: { type: "start_immediately" } }),
			"the prompt",
		);
		const deadline = Date.now() + 20_000;
		for (;;) {
			const projection = exitValue(await desk.call("orchestration.getThreadProjection", { threadId }), "projection") as { runs: { status: string }[]; thread: { updatedAt: string } };
			if (projection.runs.length > 0 && projection.runs.every((run) => run.status === "completed")) return projection.thread.updatedAt;
			if (Date.now() > deadline) throw new Error(`the run of ${threadId} did not complete`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	const activity = (fields: Record<string, unknown>) => ({ clientId: "client", clientKind: "desktop-renderer", visible: true, focused: true, recentlyInteracted: true, scopes: [], ttlMs: 45_000, observedAt: new Date().toISOString(), ...fields });
	await launch("seen", "Seen on the phone");
	await launch("missed", "Missed");

	// The phone app is in front, on the thread "seen"; a window is open and idle.
	exitValue(await phone.call("server.reportClientActivity", activity({ clientId: "mobile-1", clientKind: "mobile" })), "the phone's report");
	exitValue(await desk.call("server.reportClientActivity", activity({ recentlyInteracted: false })), "the window's report");
	const seenAt = await prompt("seen", "one");
	await prompt("missed", "two");
	// The window visits "missed" as it completes, the phone app "seen": only the phone's visit says a person saw it.
	exitValue(await desk.call("orchestration.dispatchCommand", { commandId: "visit-desk", type: "thread.visit", threadId: "missed", visitedAt: new Date().toISOString() }), "the window's visit");
	exitValue(await phone.call("orchestration.dispatchCommand", { commandId: "visit-phone", type: "thread.visit", threadId: "seen", visitedAt: seenAt }), "the phone's visit");
	clock.pass(90_000);
	await sent();
	expect(told).toEqual([{ kind: "completed", threadId: "missed", environmentId: expect.stringMatching(/^pi-/), threadTitle: "Missed", projectTitle: expect.any(String), headline: "Agent finished" }]);

	// Both clients leave, the window just after it said that it was in front: its word goes with its socket. Two
	// minutes after anyone's input (and 31 seconds after that report, which would have stood for 45) nobody is near,
	// and a completion is told once T3's five seconds confirmed it.
	exitValue(await desk.call("server.reportClientActivity", activity({ recentlyInteracted: false })), "the window's last report");
	desk.close();
	phone.close();
	await until("the sockets' end is seen", () => logged.filter((line) => line === "client disconnected").length === 2);
	const again = await connectWs(PORT, token);
	onTestFinished(() => again.close());
	clock.pass(31_000);
	f.model.respond(fauxAssistantMessage("more"));
	exitValue(
		await again.call("orchestration.dispatchCommand", { commandId: "cmd-again", type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: "seen", messageId: "msg-again", text: "three", attachments: [], modelSelection, dispatchMode: { type: "start_immediately" } }),
		"the next prompt",
	);
	for (const deadline = Date.now() + 20_000; ; ) {
		const projection = exitValue(await again.call("orchestration.getThreadProjection", { threadId: "seen" }), "projection") as { runs: { status: string }[] };
		if (projection.runs.length === 2 && projection.runs.every((run) => run.status === "completed")) break;
		if (Date.now() > deadline) throw new Error("the second run did not complete");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	clock.pass(5_000);
	await sent();
	expect(told.map((notification) => notification.threadId)).toEqual(["missed", "seen"]);

	// What waits when the host stops is sent as it closes.
	await again.call("server.reportClientActivity", activity({ recentlyInteracted: false }));
	f.model.respond(fauxAssistantMessage("last"));
	exitValue(
		await again.call("orchestration.dispatchCommand", { commandId: "cmd-last", type: "message.dispatch", createdBy: "user", creationSource: "web", threadId: "missed", messageId: "msg-last", text: "four", attachments: [], modelSelection, dispatchMode: { type: "start_immediately" } }),
		"the last prompt",
	);
	for (const deadline = Date.now() + 20_000; ; ) {
		const projection = exitValue(await again.call("orchestration.getThreadProjection", { threadId: "missed" }), "projection") as { runs: { status: string }[] };
		if (projection.runs.length === 2 && projection.runs.every((run) => run.status === "completed")) break;
		if (Date.now() > deadline) throw new Error("the last run did not complete");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(told).toHaveLength(2);
	await t3.flushNotifications();
	expect(told.map((notification) => notification.threadId)).toEqual(["missed", "seen", "missed"]);
});
