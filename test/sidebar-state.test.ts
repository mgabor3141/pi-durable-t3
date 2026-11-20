// T3's sidebar state, kept on the thread as T3's server keeps it: pins and their order, the dragged order of the active
// section, the read watermark and opens, automatic settlement switched off, and the settlement sweep.
import { until } from "./wait.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "effect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { autoSettleAt } from "../src/t3/sidebar.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, makeThreads, bridgeConfig, gated } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const iso = (value: DateTime.Utc | null | undefined): string | null => (value == null ? null : DateTime.formatIso(value));

afterEach(() => vi.restoreAllMocks());

async function fixture() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const create = createNamed(f.threads, f.harness, f.model);
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sidebar-"));
	const settings = ServerSettingsStore.open(scratch);
	const bridges: Bridge[] = [];
	const bridge = (): Bridge => {
		const made = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, settings }), log, f.threads, f.model.models);
		bridges.push(made);
		return made;
	};
	onTestFinished(async () => {
		for (const made of bridges) await made.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return { ...f, create, settings, bridge };
}

import { dispatchCommand } from "../src/t3/dispatch.ts";

const user = { createdBy: "user", creationSource: "web" } as const;
let commands = 0;
const dispatch = (bridge: Bridge, command: Record<string, unknown>) => dispatchCommand(bridge, { commandId: `cmd-${++commands}`, ...command } as never, user, log);

it("pin, reorder, visit, mark unread and the auto-settle switch are kept on the thread and shown in its shell", { timeout: 30_000 }, async () => {
	const f = await fixture();
	const thread = await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();

	// A first prompt sets the read watermark just before it, so its completion reads as unread.
	expect(bridge.threadShell("t").lastVisitedAt).toBeNull();
	const before = Date.now();
	f.model.respond(fauxAssistantMessage("pong"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "one", mode: "start" });
	await until("the reply", () => bridge.threadShell("t").status === "completed");
	const watermark = DateTime.toEpochMillis(bridge.threadShell("t").lastVisitedAt!);
	expect(watermark).toBeGreaterThanOrEqual(before - 1);
	expect(watermark).toBeLessThan(DateTime.toEpochMillis(bridge.threadShell("t").latestRunCompletedAt!));

	// A settled thread that is pinned comes back as active.
	await dispatch(bridge, { type: "thread.settle", threadId: "t" });
	expect(bridge.threadShell("t").settledOverride).toBe("settled");
	await dispatch(bridge, { type: "thread.pin", threadId: "t", orderKey: "m" });
	let shell = bridge.threadShell("t");
	expect(shell.pinnedAt).not.toBeNull();
	expect(shell.pinOrderKey).toBe("m");
	expect(shell.settledOverride).toBe("active");
	expect(shell.settledAt).toBeNull();
	await dispatch(bridge, { type: "thread.pin.reorder", threadId: "t", orderKey: "q" });
	await dispatch(bridge, { type: "thread.active.reorder", threadId: "t", orderKey: "c" });
	await dispatch(bridge, { type: "thread.auto-settle.set", threadId: "t", enabled: false });

	// The watermark moves forward only; an open is counted with the query that found the thread.
	const visited = new Date(Date.now() + 1000).toISOString();
	await dispatch(bridge, { type: "thread.visit", threadId: "t", visitedAt: visited, opened: true, searchQuery: "  Pöng " });
	await dispatch(bridge, { type: "thread.visit", threadId: "t", visitedAt: new Date(0).toISOString() });
	shell = bridge.threadShell("t");
	expect(iso(shell.lastVisitedAt)).toBe(visited);
	expect(shell.opens).toMatchObject({ score: 1, picks: [{ query: "pong" }] });
	expect(shell.pinOrderKey).toBe("q");
	expect(shell.activeOrderKey).toBe("c");
	expect(shell.autoSettleDisabledAt).not.toBeNull();

	// Mark unread: just before the latest run's end.
	await dispatch(bridge, { type: "thread.mark-unread", threadId: "t" });
	expect(DateTime.toEpochMillis(bridge.threadShell("t").lastVisitedAt!)).toBe(DateTime.toEpochMillis(bridge.threadShell("t").latestRunCompletedAt!) - 1);

	// All of it is the thread's, not the bridge's memory: a restart shows the same.
	const fresh = f.bridge();
	fresh.start();
	await fresh.loaded();
	const kept = fresh.threadShell("t");
	expect([kept.pinOrderKey, kept.activeOrderKey, iso(kept.lastVisitedAt), kept.opens?.score]).toEqual(["q", "c", iso(bridge.threadShell("t").lastVisitedAt), 1]);

	// Unpin, switch auto-settle back on; settling drops the pin and the dragged place, as T3's settle does.
	await dispatch(bridge, { type: "thread.unpin", threadId: "t" });
	await dispatch(bridge, { type: "thread.auto-settle.set", threadId: "t", enabled: true });
	expect([bridge.threadShell("t").pinnedAt, bridge.threadShell("t").autoSettleDisabledAt]).toEqual([null, null]);
	await dispatch(bridge, { type: "thread.pin", threadId: "t" });
	await dispatch(bridge, { type: "thread.settle", threadId: "t" });
	shell = bridge.threadShell("t");
	expect([shell.settledOverride, shell.pinnedAt, shell.pinOrderKey, shell.activeOrderKey]).toEqual(["settled", null, null, null]);
	expect(thread.threadId).toBe("t");
});

it("a thread with no completed run cannot be marked unread", async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	await expect(dispatch(bridge, { type: "thread.mark-unread", threadId: "t" })).rejects.toThrow(/no completed run/);
});

it("a settle that names the run it saw is refused once another run exists; a message asking for a fresh context is refused by name", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "off", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	f.model.respond(fauxAssistantMessage("pong"));
	await bridge.sendMessage({ threadId: "off", commandId: "c-off", messageId: "m-off", text: "hi", mode: "start" });
	await until("it replies", () => bridge.threadShell("off").status === "completed");
	// T3 0.1.9: a settle that names the run it saw last is refused when that is no longer the latest run.
	const { projection } = await bridge.projection("off");
	const latest = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0]!.id;
	await expect(dispatch(bridge, { type: "thread.settle", threadId: "off", expectedLatestRunId: "r-some-earlier-run" })).rejects.toThrow("The thread received another run before settlement.");
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	await dispatch(bridge, { type: "thread.settle", threadId: "off", expectedLatestRunId: latest });
	expect(bridge.threadShell("off").settledOverride).toBe("settled");
	// And a message that asks for a fresh context is refused by name, not sent with the old one.
	await expect(dispatch(bridge, { type: "message.dispatch", threadId: "off", messageId: "m-fresh", text: "start over", attachments: [], freshContext: true })).rejects.toThrow(/freshContext is not supported/);
});

it("a thread that works, or holds a message someone queued, is not settled (T3's refusals)", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "busy", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const held = gated("done");
	f.model.respond(held.step, fauxAssistantMessage("and the queued one"));
	await bridge.sendMessage({ threadId: "busy", commandId: "c1", messageId: "m1", text: "work", mode: "start" });
	await until("it runs", () => bridge.threadShell("busy").status === "running");
	await expect(dispatch(bridge, { type: "thread.settle", threadId: "busy" })).rejects.toThrow("Thread busy is still running. Stop it before settling.");
	// Stopped, with a message waiting in its queue: still someone's unanswered message.
	await bridge.sendMessage({ threadId: "busy", commandId: "c2", messageId: "m2", text: "then this", mode: "queue" });
	await bridge.interrupt("busy");
	held.release();
	await until("it stopped", () => bridge.threadShell("busy").status !== "running");
	await expect(dispatch(bridge, { type: "thread.settle", threadId: "busy" })).rejects.toThrow("Thread busy has a queued message. Send it or remove it from the queue before settling.");
	expect(bridge.threadShell("busy").settledOverride).toBeNull();

	// A message a scheduled task queued does not hold it (T3 0.1.11), as an agent's or a report's does not.
	await f.create({ threadId: "auto", projectId: "p" });
	const held2 = gated("done2");
	f.model.respond(held2.step);
	await bridge.sendMessage({ threadId: "auto", commandId: "c3", messageId: "m3", text: "work", mode: "start" });
	await until("it runs", () => bridge.threadShell("auto").status === "running");
	await bridge.sendMessage({ threadId: "auto", commandId: "c4", messageId: "scheduled-task-message:task-1:1:scheduled", text: "scheduled", mode: "queue" });
	await bridge.interrupt("auto");
	held2.release();
	await until("it stopped", () => bridge.threadShell("auto").status !== "running");
	await dispatch(bridge, { type: "thread.settle", threadId: "auto" });
	expect(bridge.threadShell("auto").settledOverride).toBe("settled");
});

it("the settlement sweep settles quiet threads as of when they went quiet, and leaves pinned, switched-off and recent ones", { timeout: 30_000 }, async () => {
	const f = await fixture();
	for (const threadId of ["quiet", "pinned", "off", "recent"]) await f.create({ threadId, projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	for (const threadId of ["quiet", "pinned", "off"]) {
		f.model.respond(fauxAssistantMessage(`pong ${threadId}`));
		await bridge.sendMessage({ threadId, commandId: `c-${threadId}`, messageId: `m-${threadId}`, text: "hi", mode: "start" });
		await until(`${threadId} replies`, () => bridge.threadShell(threadId).status === "completed");
	}
	await dispatch(bridge, { type: "thread.pin", threadId: "pinned" });
	await dispatch(bridge, { type: "thread.auto-settle.set", threadId: "off", enabled: false });
	const quiet = bridge.threadShell("quiet");
	const wentQuiet = Math.max(...[quiet.latestUserMessageAt, quiet.latestRunRequestedAt, quiet.latestRunStartedAt, quiet.latestRunCompletedAt].map((value) => DateTime.toEpochMillis(value!)));
	const day = 24 * 60 * 60 * 1000;

	// T3's default is seven days (three until 0.1.9).
	await bridge.sidebar.sweep(Date.now() + 6 * day);
	expect(bridge.threadShell("quiet").settledOverride).toBeNull();
	await bridge.sidebar.sweep(wentQuiet + 7 * day + 1);
	expect(bridge.threadShell("quiet").settledOverride).toBe("settled");
	expect(DateTime.toEpochMillis(bridge.threadShell("quiet").settledAt!)).toBe(wentQuiet);
	expect(bridge.threadShell("pinned").settledOverride).toBeNull();
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	// A thread that never ran counts from its creation.
	expect(bridge.threadShell("recent").settledOverride).toBe("settled");


	// Off for the server, on for the project.
	await dispatch(bridge, { type: "thread.unsettle", threadId: "quiet" });
	await dispatch(bridge, { type: "thread.auto-settle.set", threadId: "off", enabled: true });
	f.settings.update({ sidebarAutoSettleAfterDays: null } as never);
	await bridge.sidebar.sweep(Date.now() + 30 * day);
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	f.settings.update({ projectSettingsOverrides: { p: { sidebarAutoSettleAfterDays: 10 } } } as never);
	await bridge.sidebar.sweep(Date.now() + 5 * day);
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	await bridge.sidebar.sweep(Date.now() + 11 * day);
	expect(bridge.threadShell("off").settledOverride).toBe("settled");
	// A thread someone un-settled stays active.
	expect(bridge.threadShell("quiet").settledOverride).toBe("active");
});

it("tags: added once, in order, removed; in the shell only when there are some; kept across a restart; fine on an archived thread", async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	expect("tags" in bridge.threadShell("t")).toBe(false);
	for (const [tag, tagged] of [["work", true], ["Urgent", true], ["work", true]] as const) await dispatch(bridge, { type: "thread.tag.set", threadId: "t", tag, tagged });
	expect(bridge.threadShell("t").tags).toEqual(["work", "Urgent"]);
	const fresh = f.bridge();
	fresh.start();
	await fresh.loaded();
	expect(fresh.threadShell("t").tags).toEqual(["work", "Urgent"]);
	await dispatch(bridge, { type: "thread.archive", threadId: "t" });
	await dispatch(bridge, { type: "thread.tag.set", threadId: "t", tag: "work", tagged: false });
	await dispatch(bridge, { type: "thread.tag.set", threadId: "t", tag: "Urgent", tagged: false });
	expect("tags" in bridge.archivedShellSnapshot().threads[0]!).toBe(false);
});

// A fork starts on its source's turns: its newest message and run are as old as they were there. Being made is what
// was last done with it, so it is not settled the minute it is made, and it goes quiet as of then.
it("a thread made from old turns counts as active from when it was made", () => {
	const day = 24 * 60 * 60 * 1000;
	const now = Date.UTC(2026, 10, 17);
	const at = (ms: number) => DateTime.makeUnsafe(ms);
	const old = at(now - 30 * day);
	const fork = (createdAt: number) =>
		({ archivedAt: null, settledOverride: null, pendingRuntimeRequest: null, status: "completed", createdAt: at(createdAt), latestUserMessageAt: old, latestRunRequestedAt: old, latestRunStartedAt: old, latestRunCompletedAt: old }) as unknown as Parameters<typeof autoSettleAt>[0];
	expect(autoSettleAt(fork(now - 60_000), 7, now)).toBeNull();
	expect(autoSettleAt(fork(now - 8 * day), 7, now)).toBe(now - 8 * day);
	// A thread older than its messages is as before: quiet since the newest of them.
	expect(autoSettleAt(fork(now - 60 * day), 7, now)).toBe(now - 30 * day);
});

it("undoing a settle puts back the stamp it cleared, so the thread returns to its place (T3 0.1.10's restoreUnsettledAt)", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	await f.create({ threadId: "u", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const anchor = "2026-01-02T03:04:05.000Z";
	await dispatch(bridge, { type: "thread.settle", threadId: "t" });
	await dispatch(bridge, { type: "thread.unsettle", threadId: "t", restoreUnsettledAt: anchor });
	expect(bridge.threadShell("t").settledOverride).toBe("active");
	expect(iso(bridge.threadShell("t").unsettledAt)).toBe(anchor);
	await dispatch(bridge, { type: "thread.settle", threadId: "u" });
	await dispatch(bridge, { type: "thread.unsettle", threadId: "u", restoreUnsettledAt: null });
	expect(bridge.threadShell("u").settledOverride).toBe("active");
	expect(bridge.threadShell("u").unsettledAt ?? null).toBeNull();
	// Already kept active, a thread keeps what it has, none included (T3's `?? null`): it does not move to the top.
	await dispatch(bridge, { type: "thread.unsettle", threadId: "u" });
	expect(bridge.threadShell("u").unsettledAt ?? null).toBeNull();
	await dispatch(bridge, { type: "thread.unsettle", threadId: "t" });
	expect(iso(bridge.threadShell("t").unsettledAt)).toBe(anchor);
	// Without one, as before: stamped now.
	await dispatch(bridge, { type: "thread.settle", threadId: "u" });
	const before = Date.now();
	await dispatch(bridge, { type: "thread.unsettle", threadId: "u" });
	expect(DateTime.toEpochMillis(bridge.threadShell("u").unsettledAt!)).toBeGreaterThanOrEqual(before);
});


it("a metadata update that moves a worktree, or queues a message with one (0.1.10's continuation), is refused: no git here", async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	await expect(dispatch(bridge, { type: "thread.metadata.update", threadId: "t", continuation: { messageId: "m1", text: "go on" } })).rejects.toThrow(
		"Updating continuation is not supported by pi-durable-t3 (no git here).",
	);
});

it("a subagent thread settles with its parent, not on its own days, whatever the setting (T3 0.1.11)", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "parent", projectId: "p" });
	const child = await f.threads.create({ threadId: "child", projectId: "p", lineage: { parentThreadId: "parent", relationshipToParent: "subagent", rootThreadId: "parent" } });
	void child;
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const day = 24 * 60 * 60 * 1000;
	// Long quiet, its parent active (pinned): the child stays.
	await dispatch(bridge, { type: "thread.pin", threadId: "parent", orderKey: "a0" });
	await bridge.sidebar.sweep(Date.now() + 30 * day);
	expect(bridge.threadShell("parent").settledOverride).toBeNull();
	expect(bridge.threadShell("child").settledOverride).toBeNull();
	// The parent settled: the next sweep settles the child as of then, even with automatic settlement off.
	await dispatch(bridge, { type: "thread.settle", threadId: "parent" });
	f.settings.update({ sidebarAutoSettleAfterDays: null } as never);
	const before = Date.now();
	// (The settings change starts a sweep of its own; this one may find it running and return.)
	for (let i = 0; i < 40 && bridge.threadShell("child").settledOverride === null; i++) {
		await bridge.sidebar.sweep();
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(bridge.threadShell("child").settledOverride).toBe("settled");
	expect(DateTime.toEpochMillis(bridge.threadShell("child").settledAt!)).toBeGreaterThanOrEqual(before);
});
