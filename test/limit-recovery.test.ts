// A provider's limit: the request fails and says how long to wait ("Server requested 6514s retry delay (max: 60s). 429 …",
// pi-ai's words when it will not wait that long inside the request). The harness's own retries know nothing of that
// wait: 64 of them, five minutes apart, each certain to fail. So the run ends at the first such failure, the thread
// records when the limit resets, and a reset within five hours is waited for: the run is continued then, with no
// message written. T3 shows it as its usage limit ("Resumes 9:40 PM"); messages sent meanwhile wait their turn; and
// whoever waits for the thread (a parent, `thread_wait`) waits for the reset, and is not told it failed.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import { isBusy, report } from "../src/t3/reports.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

type Item = { id: string; type: string; runId: string | null; text?: string; status: string; failure?: { class: string; resetAt?: string }; retry?: unknown };
type Run = { id: string; status: string; userMessageId: string; queueHeld?: boolean };
type Recovery = { runId: string; resetAt: string; autoResume: boolean; snooze: boolean } | null;

afterEach(() => void (Bridge.limitResumeMarginMs = 30_000));
const limit = (seconds: number) =>
	fauxAssistantMessage("", { stopReason: "error", errorMessage: `Server requested ${seconds}s retry delay (max: 60s). 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit. Please try again later."}}` });

async function setup() {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-limit-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, { info: () => {}, warn: () => {} }, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const send = async (text: string, mode: "start" | "steer" = "start") => {
		const n = ++sent;
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode });
	};
	const shown = async (wanted: readonly string[]) => {
		const projection = await bridge.waitFor("t", (candidate) => (JSON.stringify(candidate.runs.map((run) => run.status)) === JSON.stringify(wanted) && !("retry" in ((candidate.turnItems as unknown as Item[]).findLast((item) => item.type === "error") ?? {})) ? candidate : undefined), 15_000);
		if (projection === undefined) throw new Error(`the thread never showed ${wanted.join(", ")}: ${JSON.stringify((await bridge.projection("t")).projection.runs.map((run) => run.status))}`);
		return { projection, runs: projection.runs as unknown as Run[], items: projection.turnItems as unknown as Item[], recovery: (projection.thread as unknown as { limitRecovery: Recovery }).limitRecovery };
	};
	const update = (limitRecovery: object | null) => dispatchCommand(bridge, { type: "thread.metadata.update", commandId: `u${++sent}`, threadId: "t", limitRecovery } as never, { createdBy: "user", creationSource: "web" }, { info: () => {}, warn: () => {} });
	return { f, bridge, send, shown, update };
}

it("a limit that resets soon ends the run at once, and the run is continued when it has reset; messages sent meanwhile wait", { timeout: 60_000 }, async () => {
	// The reset is 61 seconds off; continue a second after the limit was reached instead of 30 seconds after the reset.
	Bridge.limitResumeMarginMs = -60_000;
	const { f, bridge, send, shown } = await setup();
	const seen: string[] = [];
	const answer = (text: string) => (request: { messages: unknown }) => {
		seen.push(JSON.stringify(request.messages));
		return fauxAssistantMessage(text);
	};
	f.model.respond(limit(61), answer("the answer"), answer("to the one that waited"));
	const before = Date.now();
	await send("go");
	// One request, no retry: the run has failed, and the thread says when the limit resets and that it resumes then.
	const waiting = await shown(["failed"]);
	const error = waiting.items.find((item) => item.type === "error")!;
	expect(error).toMatchObject({ status: "failed", failure: { class: "usage_limit" } });
	expect(error.retry).toBeUndefined();
	expect(waiting.recovery).toEqual({ runId: waiting.runs[0]!.id, resetAt: error.failure!.resetAt, autoResume: true, snooze: false });
	// The sidebar's row says "limited" with the reset, not "failed".
	expect((await bridge.projection("t")).shell).toMatchObject({ status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: error.failure!.resetAt, limitRecovery: waiting.recovery });
	const reset = Date.parse(waiting.recovery!.resetAt);
	expect(reset - before).toBeGreaterThan(60_000);
	expect(reset - before).toBeLessThan(63_000);
	// To whoever waits for it, the thread is still working.
	expect(isBusy(waiting.projection)).toBe(true);
	expect(report(waiting.projection).verdict).toBe("active");

	// A message sent meanwhile starts nothing: it waits, as behind a run.
	await send("and then this");
	const queued = await shown(["failed", "queued"]);
	expect(seen).toEqual([]);
	expect(queued.runs[1]).toMatchObject({ userMessageId: "m2", status: "queued", queueHeld: true });
	// The thread's latest run is still the one the limit ended (T3's `latestUnheldRun`), so its banner stays.
	expect((await bridge.projection("t")).shell).toMatchObject({ status: "failed", latestRunId: waiting.runs[0]!.id });

	// The reset: the same run goes on with no message written, and the one that waited follows as its own turn.
	const done = await bridge.waitFor("t", (candidate) => (candidate.runs.length === 2 && candidate.runs.every((run) => run.status === "completed") ? candidate : undefined), 15_000);
	expect(done, "continued at the reset").toBeDefined();
	await idle(f.harness, (await f.threads.thread("t"))!.head);
	expect((done!.runs as unknown as Run[])[0]!.id).toBe(waiting.runs[0]!.id);
	expect(seen).toHaveLength(2);
	expect(seen[0]).not.toContain("and then this");
	expect(seen[1]).toContain("and then this");
	expect((done!.turnItems as unknown as Item[]).filter((item) => item.type === "assistant_message").map((item) => item.text)).toEqual(["the answer", "to the one that waited"]);
	expect((await f.threads.thread("t"))!.limitRecovery, "the recovery is over").toBeUndefined();
	expect((done!.thread as unknown as { limitRecovery: Recovery }).limitRecovery).toBeNull();
});

it("a limit that resets in more than five hours ends the run and is not waited for, unless T3's Resume at reset asks", { timeout: 60_000 }, async () => {
	const { f, bridge, send, shown, update } = await setup();
	f.model.respond(limit(6 * 3600), fauxAssistantMessage("another answer"));
	await send("go");
	const stopped = await shown(["failed"]);
	expect(stopped.recovery).toMatchObject({ runId: stopped.runs[0]!.id, autoResume: false });
	expect(isBusy(stopped.projection), "nobody waits for it").toBe(false);
	expect(report(stopped.projection).verdict).toBe("failed");
	const { runId, resetAt } = stopped.recovery!;

	// T3's "Resume at reset" and "Cancel auto-resume"; a limit that is not the thread's is refused in T3's words.
	await expect(update({ runId, resetAt: new Date(Date.parse(resetAt) + 1).toISOString(), autoResume: true })).rejects.toThrow("The provider limit changed before recovery could be configured.");
	await update({ runId, resetAt, autoResume: true });
	expect((await shown(["failed"])).recovery).toMatchObject({ autoResume: true });
	expect(isBusy((await bridge.projection("t")).projection)).toBe(true);
	await update({ runId, resetAt, autoResume: false });
	expect((await shown(["failed"])).recovery).toMatchObject({ autoResume: false });

	// Not waited for: a message starts its turn at once, and the limit is no longer the thread's last word.
	await send("try again");
	const after = await shown(["failed", "completed"]);
	expect(after.recovery).toBeNull();
});
