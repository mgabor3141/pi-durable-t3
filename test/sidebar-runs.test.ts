// The sidebar shows a thread's latest run whether or not the thread is open, and the bridge sees every run end — one
// that outlives the client's view of it, and one started without the bridge (an agent's prompt, a run resumed after a
// restart). T3's sidebar sorts by those run times, and its notifications fire on that end.
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

const runFields = (shell: any) => ({
	status: shell.status,
	latestRunId: shell.latestRunId,
	requestedAt: iso(shell.latestRunRequestedAt),
	startedAt: iso(shell.latestRunStartedAt),
	completedAt: iso(shell.latestRunCompletedAt),
});

it("a closed thread keeps its latest run: its shell and the page-load snapshot match the open thread's", { timeout: 30_000 }, async () => {
	shortIdle();
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();

	f.model.respond(fauxAssistantMessage("pong"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "one", mode: "start" });
	await until("the reply", () => bridge.threadShell("t").status === "completed");
	const open = runFields(bridge.threadShell("t"));
	expect(open.latestRunId).not.toBeNull();
	expect(open.completedAt! >= open.requestedAt!).toBe(true);

	await sleep(300); // released
	expect(runFields(bridge.threadShell("t"))).toEqual(open);
	expect(runFields((bridge.shellSnapshot() as any).threads[0])).toEqual(open);
	// A new bridge (a restart) has nothing open, and shows the same.
	const fresh = f.bridge();
	fresh.start();
	await fresh.loaded();
	expect(runFields(fresh.threadShell("t"))).toEqual(open);
});

it("a run that outlives its view still reaches the sidebar when it ends", { timeout: 30_000 }, async () => {
	shortIdle();
	const f = await fixture();
	await f.create({ threadId: "t", projectId: "p" });
	const bridge = f.bridge();
	bridge.start();
	await bridge.loaded();
	const pushed: any[] = [];
	bridge.onShell((item) => pushed.push(item));

	const slow = gated("slow");
	f.model.respond(slow.step);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "one", mode: "start" });
	await until("the run starts", () => bridge.threadShell("t").status === "running");
	await sleep(300); // nobody holds the thread: the idle release would have closed it
	slow.release();
	await until("the end is pushed", () => pushed.some((item) => item.kind === "thread.updated" && item.thread.status === "completed"));
	const shell = bridge.threadShell("t");
	expect(shell.status).toBe("completed");
	expect(shell.activeRunId).toBeNull();
	expect(shell.latestRunCompletedAt).not.toBeNull();
	expect(shell.latestVisibleMessage?.text).toBe("slow");
});

it("a run started without the bridge, before it starts (a restart's resumed run), is followed to its end", { timeout: 30_000 }, async () => {
	shortIdle();
	const f = await fixture();
	const thread = await f.create({ threadId: "t", projectId: "p" });
	const slow = gated("from an agent");
	f.model.respond(slow.step);
	await f.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r1", message: "work" }, undefined);

	const bridge = f.bridge();
	const pushed: any[] = [];
	bridge.onShell((item) => pushed.push(item));
	bridge.start();
	await bridge.loaded();
	await until("it shows running", () => bridge.threadShell("t").status === "running");
	await sleep(300);
	slow.release();
	await until("the end is pushed", () => pushed.some((item) => item.kind === "thread.updated" && item.thread.status === "completed"));
	expect(bridge.threadShell("t").latestVisibleMessage?.text).toBe("from an agent");
	// And a later one, while it is closed.
	await sleep(300);
	const next = gated("again");
	f.model.respond(next.step);
	await f.threads.submit({ threadId: "t", conversationId: thread.head, requestId: "r2", message: "more" }, undefined);
	await until("the second run shows", () => bridge.threadShell("t").status === "running");
	next.release();
	await until("the second end", () => bridge.threadShell("t").status === "completed" && bridge.threadShell("t").latestVisibleMessage?.text === "again");
});
