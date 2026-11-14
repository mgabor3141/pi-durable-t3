// T3's sidebar state, kept on the thread as T3's server keeps it: pins and their order, the dragged order of the active
// section, the read watermark and opens, automatic settlement switched off, and the settlement sweep.
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
	await bridge.sweepSettlement(Date.now() + 6 * day);
	expect(bridge.threadShell("quiet").settledOverride).toBeNull();
	await bridge.sweepSettlement(wentQuiet + 7 * day + 1);
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
	await bridge.sweepSettlement(Date.now() + 30 * day);
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	f.settings.update({ projectSettingsOverrides: { p: { sidebarAutoSettleAfterDays: 10 } } } as never);
	await bridge.sweepSettlement(Date.now() + 5 * day);
	expect(bridge.threadShell("off").settledOverride).toBeNull();
	await bridge.sweepSettlement(Date.now() + 11 * day);
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
