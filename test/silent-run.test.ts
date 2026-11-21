// A run ends silent when its answer's last line is the word SILENT: the agent's way to say that the run left nothing
// the user needs to see. The run completes like any other, and the thread's shell presents it as T3 presents a run that
// was stopped: no client announces it (`latestRunStopRequested`, the flag T3's notification gate and its phone alerts
// read). Nor does it make the thread unread: as the run ends, the read watermark moves over it, unless the thread was
// unread before. A scheduled task's prompt says so to the agent that answers it (scheduled-tasks-boot.test.ts).
import { sleep, until } from "./wait.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime } from "effect";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Bridge } from "../src/t3/bridge.ts";
import { endsSilent } from "../src/t3/projection.ts";
import { bridgeConfig, createNamed, makeThreads, quietLog } from "./threads-harness.ts";

afterEach(() => vi.restoreAllMocks());

/** The bridge's 30 s idle release, shortened to 20 ms. */
function shortIdle(): void {
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 30_000 ? 20 : ms)) as typeof setTimeout);
}

const at = (value: DateTime.Utc | null | undefined): number => (value == null ? Number.NaN : DateTime.toEpochMillis(value));
/** T3's `hasUnseenCompletion`: what its sidebar marks unread. */
const unread = (shell: ReturnType<Bridge["threadShell"]>): boolean =>
	shell.latestRunCompletedAt != null && shell.status !== "interrupted" && shell.status !== "cancelled" && shell.lastVisitedAt != null && at(shell.latestRunCompletedAt) > at(shell.lastVisitedAt);

async function fixture() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-silent-"));
	const bridges: Bridge[] = [];
	const open = async (): Promise<Bridge> => {
		const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), quietLog, f.threads, f.model.models);
		bridges.push(bridge);
		bridge.start();
		await bridge.loaded();
		return bridge;
	};
	onTestFinished(async () => {
		for (const bridge of bridges) await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	let sent = 0;
	/** One prompt answered with `answer`, to its end. */
	const run = async (bridge: Bridge, answer: string) => {
		const runs = (await bridge.projection("t")).projection.runs.length;
		f.model.respond(fauxAssistantMessage(answer));
		await bridge.sendMessage({ threadId: "t", commandId: `c${++sent}`, messageId: `m${sent}`, text: `prompt ${sent}`, mode: "start" });
		await bridge.waitFor("t", (projection) => (projection.runs.length === runs + 1 && projection.runs.every((each) => each.status !== "running") ? true : undefined), 10_000);
		return bridge.threadShell("t");
	};
	return { ...f, open, run };
}

it("reads SILENT as the answer's last line and nothing else", () => {
	expect(endsSilent("SILENT")).toBe(true);
	expect(endsSilent("Checked the inbox: nothing new.\n\nSILENT\n")).toBe(true);
	expect(endsSilent("Nothing new.\n  SILENT  ")).toBe(true);
	expect(endsSilent(undefined)).toBe(false);
	expect(endsSilent("")).toBe(false);
	expect(endsSilent("SILENT\nBut there is one thing.")).toBe(false);
	expect(endsSilent("I will stay SILENT")).toBe(false);
	expect(endsSilent("SILENT.")).toBe(false);
	expect(endsSilent("silent")).toBe(false);
});

it("a run that ends silent completes unannounced and leaves a read thread read, open or closed", { timeout: 60_000 }, async () => {
	shortIdle();
	const f = await fixture();
	const bridge = await f.open();

	// An answer like any other is announced (no flag) and unread until someone opens the thread.
	const first = await f.run(bridge, "pong");
	expect(first).toMatchObject({ status: "completed", latestRunStopRequested: false });
	expect(unread(first)).toBe(true);
	await bridge.sidebar.visit("t", DateTime.formatIso(first.updatedAt), false, undefined);
	expect(unread(bridge.threadShell("t"))).toBe(false);

	const silent = await f.run(bridge, "Looked at the queue: nothing new.\nSILENT");
	expect(silent).toMatchObject({ status: "completed", latestRunStopRequested: true });
	expect(silent.latestRunId).not.toBe(first.latestRunId);
	// The watermark moves over the run as it ends, so the thread reads as read: open, closed, and after a restart.
	await until("the watermark moved", () => (bridge.threadRecord("t")?.lastVisitedAt ?? 0) >= at(silent.latestRunCompletedAt));
	expect(unread(bridge.threadShell("t"))).toBe(false);
	await sleep(300); // released
	const closed = bridge.threadShell("t");
	expect(closed.latestRunId).toBe(silent.latestRunId);
	expect(unread(closed)).toBe(false);
	const fresh = await f.open();
	expect(unread(fresh.threadShell("t"))).toBe(false);

	// Someone marks it unread all the same: that stands, open and closed.
	await bridge.sidebar.markUnread("t");
	await bridge.projection("t");
	expect(unread(bridge.threadShell("t"))).toBe(true);
	await sleep(300); // released
	expect(unread(bridge.threadShell("t"))).toBe(true);
	await bridge.sidebar.visit("t", DateTime.formatIso(bridge.threadShell("t").updatedAt), false, undefined);

	// The next answer is announced and unread again.
	const next = await f.run(bridge, "There is one new item.");
	expect(next).toMatchObject({ status: "completed", latestRunStopRequested: false });
	expect(unread(next)).toBe(true);
});

it("a thread that was unread stays unread through a silent run, and a first run may be silent", { timeout: 60_000 }, async () => {
	const f = await fixture();
	const bridge = await f.open();
	// The first run of a thread nobody opened: T3 stamps the watermark just before it, so its end would show unread.
	const first = await f.run(bridge, "SILENT");
	expect(first).toMatchObject({ status: "completed", latestRunStopRequested: true });
	await until("the watermark moved", () => bridge.threadRecord("t")?.lastVisitedAt === at(first.latestRunCompletedAt));
	expect(unread(bridge.threadShell("t"))).toBe(false);

	const answered = await f.run(bridge, "Something to read.");
	expect(unread(answered)).toBe(true);
	const silent = await f.run(bridge, "SILENT");
	expect(silent.latestRunStopRequested).toBe(true);
	// The answer before it was not read yet: the watermark stays where it was, before that answer.
	await sleep(200);
	expect(bridge.threadRecord("t")?.lastVisitedAt).toBe(at(first.latestRunCompletedAt));
	expect(unread(bridge.threadShell("t"))).toBe(true);
});
