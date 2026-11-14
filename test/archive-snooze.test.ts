// T3's archive and snooze, kept on the thread as T3's server keeps them: an archived thread leaves the live sidebar for
// the archive, and refuses sidebar changes until unarchived; a snoozed thread hides until its time, a message someone
// sends wakes it (an automatic one does not), and the settlement sweep leaves it alone while it sleeps.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "effect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, gated, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const iso = (value: DateTime.Utc | null | undefined): string | null => (value == null ? null : DateTime.formatIso(value));
async function until(what: string, test: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 300; i++) {
		if (await test()) return;
		await sleep(20);
	}
	throw new Error(`timed out: ${what}`);
}

afterEach(() => vi.restoreAllMocks());

/** The bridge's 30 s idle release, shortened to 20 ms. */
function shortIdle(): void {
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 30_000 ? 20 : ms)) as typeof setTimeout);
}

async function fixture() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const create = createNamed(f.threads, f.harness, f.model);
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sidebar-"));
	const settings = ServerSettingsStore.open(scratch);
	const bridges: Bridge[] = [];
	const bridge = (): Bridge => {
		const made = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings, corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
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
const day = 24 * 60 * 60 * 1000;

it("archive: out of the live sidebar and into the archive, refusing sidebar changes, until unarchived", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	await f.create({ threadId: "other", projectId: "p" });
	const bridge = f.bridge();
	const pushed: any[] = [];
	bridge.onShell((item) => pushed.push(item));
	bridge.start();
	await bridge.loaded();
	bridge.shellSnapshot();

	await dispatch(bridge, { type: "thread.archive", threadId: "t" });
	expect(pushed.at(-1)).toMatchObject({ kind: "thread.removed", location: "active", threadId: "t" });
	expect((bridge.shellSnapshot() as any).threads.map((thread: any) => thread.id)).toEqual(["other"]);
	const archived = bridge.archivedShellSnapshot();
	expect(archived.threads.map((thread) => thread.id)).toEqual(["t"]);
	expect(archived.threads[0]!.archivedAt).not.toBeNull();
	expect(archived.projects.map((project) => project.id)).toContain("p");

	await expect(dispatch(bridge, { type: "thread.archive", threadId: "t" })).rejects.toThrow(/already archived/);
	for (const command of [{ type: "thread.pin" }, { type: "thread.settle" }, { type: "thread.snooze", snoozedUntil: new Date(Date.now() + day).toISOString() }, { type: "thread.active.reorder", orderKey: "m" }]) {
		await expect(dispatch(bridge, { ...command, threadId: "t" })).rejects.toThrow(/is archived/);
	}
	// A restart keeps it archived.
	const fresh = f.bridge();
	fresh.start();
	await fresh.loaded();
	expect(fresh.archivedShellSnapshot().threads.map((thread) => thread.id)).toEqual(["t"]);

	await dispatch(bridge, { type: "thread.unarchive", threadId: "t" });
	expect(pushed.at(-1)).toMatchObject({ kind: "thread.updated", location: "active", thread: { id: "t", archivedAt: null } });
	expect((bridge.shellSnapshot() as any).threads.map((thread: any) => thread.id).sort()).toEqual(["other", "t"]);
	expect(bridge.archivedShellSnapshot().threads).toEqual([]);
	await expect(dispatch(bridge, { type: "thread.unarchive", threadId: "t" })).rejects.toThrow(/not archived/);
});

it("snooze: until a future time; a message someone sends wakes it, an automatic one does not; pin and settle end it", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const wakeAt = new Date(Date.now() + day).toISOString();
	const snooze = () => dispatch(bridge, { type: "thread.snooze", threadId: "t", snoozedUntil: wakeAt });

	await expect(dispatch(bridge, { type: "thread.snooze", threadId: "t", snoozedUntil: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow(/not in the future/);
	await snooze();
	let shell = bridge.threadShell("t");
	expect(iso(shell.snoozedUntil)).toBe(wakeAt);
	expect(shell.snoozedAt).not.toBeNull();

	// Unsnooze: awake, and stamped.
	await dispatch(bridge, { type: "thread.unsnooze", threadId: "t" });
	shell = bridge.threadShell("t");
	expect([shell.snoozedUntil, shell.snoozedAt]).toEqual([null, null]);
	expect((await bridge.projection("t")).projection.thread.lastSnoozeWakeAt).not.toBeNull();

	// A child's report (automatic) leaves it snoozed; a message someone sends wakes it.
	await snooze();
	f.model.respond(fauxAssistantMessage("noted"), fauxAssistantMessage("hi"));
	await bridge.sendMessage({ threadId: "t", commandId: "c-report", messageId: "m-report", text: "A child finished.", mode: "queue", automatic: true });
	await until("the report's run", () => bridge.threadShell("t").status === "completed");
	expect(iso(bridge.threadShell("t").snoozedUntil)).toBe(wakeAt);
	await bridge.sendMessage({ threadId: "t", commandId: "c-note", messageId: "m-note", text: "fyi", mode: "queue", note: true });
	expect(iso(bridge.threadShell("t").snoozedUntil)).toBe(wakeAt);
	await bridge.sendMessage({ threadId: "t", commandId: "c-user", messageId: "m-user", text: "hello", mode: "start" });
	expect(bridge.threadShell("t").snoozedUntil).toBeNull();
	await until("the reply", () => bridge.threadShell("t").status === "completed" && bridge.threadShell("t").latestVisibleMessage?.text === "hi");

	// Pinning wakes it; settling clears it.
	await snooze();
	await dispatch(bridge, { type: "thread.pin", threadId: "t" });
	expect(bridge.threadShell("t").snoozedUntil).toBeNull();
	await dispatch(bridge, { type: "thread.unpin", threadId: "t" });
	await snooze();
	await dispatch(bridge, { type: "thread.settle", threadId: "t" });
	expect([bridge.threadShell("t").settledOverride, bridge.threadShell("t").snoozedUntil]).toEqual(["settled", null]);
});

it("a thread with a message waiting in its queue cannot be snoozed", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const slow = gated("slow");
	f.model.respond(slow.step, fauxAssistantMessage("next"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "one", mode: "start" });
	await until("running", () => bridge.threadShell("t").status === "running");
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "two", mode: "queue" });
	await expect(dispatch(bridge, { type: "thread.snooze", threadId: "t", snoozedUntil: new Date(Date.now() + day).toISOString() })).rejects.toThrow(/queued run/);
	slow.release();
	await until("both ran", () => bridge.threadShell("t").latestVisibleMessage?.text === "next");
});

it("the settlement sweep leaves a snoozed thread alone, and counts its wake as activity", { timeout: 30_000 }, async () => {
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const until = Date.now() + 10 * day;
	await dispatch(bridge, { type: "thread.snooze", threadId: "t", snoozedUntil: new Date(until).toISOString() });
	await bridge.sweepSettlement(Date.now() + 5 * day);
	expect(bridge.threadShell("t").settledOverride).toBeNull();
	// The snooze ran out at `until`: quiet since then, so not yet settled six days later, settled eight days later
	// (T3's default is seven days).
	await bridge.sweepSettlement(until + 6 * day);
	expect(bridge.threadShell("t").settledOverride).toBeNull();
	await bridge.sweepSettlement(until + 8 * day);
	expect(bridge.threadShell("t").settledOverride).toBe("settled");
	expect(DateTime.toEpochMillis(bridge.threadShell("t").settledAt!)).toBe(until);
});
