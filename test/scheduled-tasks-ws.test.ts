// Scheduled tasks on the wire, against the real host: `subscribe` answers a snapshot then a fresh list per change,
// `runNow` of a thread-less task launches a thread whose first user message carries `scheduledTaskId` (what T3's
// timeline renders as an automation), a second task bound to that thread queues its prompt there, and webhook triggers
// and the webhook-only calls are refused with the contract's `ScheduledTaskError`, decodable as such.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Schema } from "effect";
import { ScheduledTaskError, ScheduledTaskListResult } from "@t3tools/contracts";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const PORT = 4986;
let root: string;
let host: Launched | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-ws-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: projectDir }] }), "utf8");
	host = launch(root, PORT, {}, agentDir);
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await host?.exited;
	await rm(root, { recursive: true, force: true });
}, 30_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Task = { id: string; threadId: string | null; lastRunStatus: string; runCount: number; lastRunAt: string | null };

it("subscribe, runNow (launch, then queue on the thread), and the webhook refusals", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const ws = await connectWs(PORT, await pair(PORT, pairCode(root)));
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((p) => p.models.length > 0)!;
		const modelSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug };
		const base = { enabled: true, projectId: "p-alpha", workspaceStrategy: { type: "root" }, modelSelection, runtimeMode: "full-access", interactionMode: "default", creationSource: "web" };

		const stream = await ws.open("scheduledTasks.subscribe", {});
		const snapshots = () => ws.chunks(stream).flatMap((frame) => (frame as { values: unknown[] }).values) as { tasks: Task[] }[];
		const until = async (what: string, test: () => boolean) => {
			for (let i = 0; i < 200 && !test(); i++) await sleep(25);
			expect(test(), what).toBe(true);
		};
		await until("the snapshot", () => snapshots().length >= 1);
		expect(snapshots()[0]).toEqual({ tasks: [] });

		const created = exitValue(await ws.call("scheduledTasks.upsert", { ...base, title: "Launcher", prompt: "scheduled hello", schedule: { type: "interval", everyMs: 3_600_000 }, threadId: null }), "upsert") as { task: Task };
		await until("a fresh list after the save", () => snapshots().some((s) => s.tasks.some((t) => t.id === created.task.id)));
		Schema.decodeUnknownSync(Schema.toCodecJson(ScheduledTaskListResult))(snapshots().at(-1));

		const ran = exitValue(await ws.call("scheduledTasks.runNow", { id: created.task.id }, 30_000), "runNow") as { task: Task };
		expect(ran.task).toMatchObject({ lastRunStatus: "succeeded", runCount: 1 });
		// The launched thread: the only one in the shell snapshot.
		const shell = await ws.open("orchestration.subscribeShell", { requestCompletionMarker: true });
		let threadId = "";
		await until("the launched thread in the shell", () => {
			const snapshot = ws.chunks(shell).flatMap((frame) => (frame as { values?: { kind?: string; snapshot?: { threads?: { id: string }[] } }[] }).values ?? []).find((v) => v.kind === "snapshot");
			threadId = snapshot?.snapshot?.threads?.[0]?.id ?? "";
			return threadId !== "";
		});
		const projection = exitValue(await ws.call("orchestration.getThreadProjection", { threadId }), "getThreadProjection") as { messages: { role: string; text: string; scheduledTaskId?: string }[] };
		const first = projection.messages.find((message) => message.role === "user");
		expect(first).toMatchObject({ text: "scheduled hello", scheduledTaskId: created.task.id });

		// A second task bound to the launched thread queues its prompt there.
		const bound = exitValue(await ws.call("scheduledTasks.upsert", { ...base, title: "Follow-up", prompt: "scheduled again", schedule: { type: "fixed_time", timeOfDay: "09:00" }, threadId }), "upsert bound") as { task: Task };
		expect((exitValue(await ws.call("scheduledTasks.runNow", { id: bound.task.id }, 30_000), "runNow bound") as { task: Task }).task.lastRunStatus).toBe("succeeded");
		for (let i = 0; i < 200; i++) {
			const view = exitValue(await ws.call("orchestration.getThreadProjection", { threadId }), "projection") as { messages: { role: string; text: string; scheduledTaskId?: string }[] };
			if (view.messages.some((m) => m.text === "scheduled again")) {
				expect(view.messages.find((m) => m.text === "scheduled again")?.scheduledTaskId).toBe(bound.task.id);
				break;
			}
			if (i === 199) throw new Error(`the queued prompt never landed: ${JSON.stringify(view.messages).slice(0, 600)}`);
			await sleep(50);
		}

		// Webhooks: refused, typed.
		const decode = Schema.decodeUnknownSync(Schema.toCodecJson(ScheduledTaskError));
		const refusedUpsert = decode(exitError(await ws.call("scheduledTasks.upsert", { ...base, title: "Hook", prompt: "p", schedule: { type: "webhook", signature: null }, threadId: null }), "upsert webhook"));
		expect(refusedUpsert.message).toBe("Webhook triggers are not supported by pi-durable-t3 yet.");
		for (const tag of ["scheduledTasks.rotateWebhookToken", "scheduledTasks.listWebhookDeliveries"]) {
			expect(decode(exitError(await ws.call(tag, { id: created.task.id }), tag)).message).toBe("Webhook triggers are not supported by pi-durable-t3 yet.");
		}

		exitValue(await ws.call("scheduledTasks.delete", { id: created.task.id }), "delete");
		await until("the delete reaches subscribers", () => !snapshots().at(-1)!.tasks.some((t) => t.id === created.task.id));
	} finally {
		ws.close();
	}
}, 90_000);
