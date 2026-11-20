// A task bound to an existing thread that is due at boot (it came due while the host was off) used to fire before the
// bridge had loaded the thread list, fail with "Thread … was not found", and use up its run. The dispatch now waits for
// the directory's first load. This drives the real dispatch over a fresh host whose thread exists in storage.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { scheduledRunOutcome, scheduledTaskDispatch } from "../src/t3/scheduled-tasks.ts";
import { makeThreads, bridgeConfig } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

it("a bound task dispatched right at boot finds its thread", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	await fixture.threads.create({ threadId: "bound", projectId: "p" });
	// A slow first read of the thread list (a large or cold store): chord's `ready()` waits for the objects, not their loads.
	const list = fixture.threads.list.bind(fixture.threads);
	fixture.threads.list = async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		return list();
	};
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-boot-"));
	const bridge = new Bridge(
		bridgeConfig({ stateDir: scratch, registry: fixture.registry }),
		log,
		fixture.threads, fixture.model.models,
	);
	bridge.start();
	try {
		// The same moment facet.ts starts the scheduler: right after `bridge.start()`, before the list has loaded.
		await scheduledTaskDispatch(bridge).queue({ threadId: "bound", projectId: "p", commandId: "scheduled-task:t:1:scheduled", messageId: "scheduled-task-message:t:1:scheduled", text: "due at boot", provenance: { createdBy: "user", creationSource: "web" } });
		expect(bridge.threadProjectId("bound")).toBe("p");
	} finally {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	}
}, 30_000);

it("a bound task's message waiting in its thread's queue is a queued occurrence, held after a Stop (T3 0.1.11's queuedOccurrence)", { timeout: 30_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { createNamed, gated } = await import("./threads-harness.ts");
	await createNamed(f.threads, f.harness, f.model)({ threadId: "bound", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-occurrence-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), { info: () => {}, warn: () => {} }, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	try {
		const dispatch = scheduledTaskDispatch(bridge);
		expect(await dispatch.queuedOccurrence("t", "bound")).toBeNull();
		const held = gated("work");
		f.model.respond(held.step);
		await bridge.sendMessage({ threadId: "bound", commandId: "c1", messageId: "m1", text: "work", mode: "start" });
		await bridge.waitFor("bound", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
		await dispatch.queue({ threadId: "bound", projectId: "p", commandId: "scheduled-task:t:1:scheduled", messageId: "scheduled-task-message:t:1:scheduled", text: "hourly", provenance: { createdBy: "user", creationSource: "web" } });
		await bridge.waitFor("bound", (projection) => (projection.runs.some((run) => run.status === "queued") ? true : undefined), 10_000);
		expect(await dispatch.queuedOccurrence("t", "bound")).toBe("queued");
		expect(await dispatch.queuedOccurrence("other-task", "bound"), "another task's message is not this task's").toBeNull();
		await bridge.interrupt("bound");
		held.release();
		await bridge.waitFor("bound", (projection) => (projection.runs.some((run) => run.status === "queued" && run.queueHeld === true) ? true : undefined), 10_000);
		expect(await dispatch.queuedOccurrence("t", "bound")).toBe("held");
	} finally {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	}
});

it("a scheduled run is followed to its end by its message: completed, failed with the provider's error, stopped, removed from the queue, or sent as a steer (T3 0.1.11's recordRunOutcome)", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const { createNamed, gated, errored } = await import("./threads-harness.ts");
	const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	await createNamed(f.threads, f.harness, f.model)({ threadId: "bound", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-outcome-"));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	const signal = new AbortController().signal;
	const dispatch = scheduledTaskDispatch(bridge);
	let fire = 0;
	// What the service does: queue, then follow the run that carries the message.
	const send = async () => {
		const messageId = `scheduled-task-message:t:${++fire}:manual`;
		await dispatch.queue({ threadId: "bound", projectId: "p", commandId: `scheduled-task:t:${fire}:manual`, messageId, text: `run ${fire}`, provenance: { createdBy: "user", creationSource: "web" } });
		return { messageId, outcome: dispatch.runOutcome("bound", messageId, 20_000, signal) };
	};
	const running = () => bridge.waitFor("bound", (projection) => (projection.runs.some((run) => run.status === "running") ? true : undefined), 10_000);
	const queued = () => bridge.waitFor("bound", (projection) => projection.runs.find((run) => run.status === "queued")?.id, 10_000);
	try {
		f.model.respond(fauxAssistantMessage("done"));
		expect(await (await send()).outcome).toEqual({ status: "completed", error: null });

		f.model.respond(errored("Weekly usage limit reached"));
		expect(await (await send()).outcome).toEqual({ status: "failed", error: "Weekly usage limit reached" });

		const stopped = gated("never seen");
		f.model.respond(stopped.step);
		const interrupted = await send();
		await running();
		await bridge.interrupt("bound");
		stopped.release();
		expect(await interrupted.outcome).toEqual({ status: "interrupted", error: null });

		// Behind a working run: removed from the queue is T3's cancelled run; sent as a steer, it is in another run.
		const busy = gated("working");
		f.model.respond(busy.step, fauxAssistantMessage("steered"));
		await bridge.sendMessage({ threadId: "bound", commandId: "c-work", messageId: "m-work", text: "work", mode: "start" });
		await running();
		const removed = await send();
		await bridge.cancelQueued("bound", (await queued())!);
		expect(await removed.outcome).toEqual({ status: "cancelled", error: null });
		const promoted = await send();
		await bridge.promoteQueued("bound", (await queued())!);
		expect(await promoted.outcome, "a steer's run is the one it steers: nothing to record").toBeNull();
		expect(scheduledRunOutcome((await bridge.projection("bound")).projection, promoted.messageId), "the steer is in the working run").toBeNull();
		busy.release();

		// A message no run carries (a command the host answers itself) is not followed; nor is a thread that is gone.
		expect(await dispatch.runOutcome("bound", "scheduled-task-message:t:0:manual", 20_000, signal)).toBeNull();
		expect(await dispatch.runOutcome("gone", "scheduled-task-message:t:0:manual", 20_000, signal)).toBeNull();
	} finally {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	}
});
