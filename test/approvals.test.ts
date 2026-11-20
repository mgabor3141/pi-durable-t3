// A host's gate asks the user to approve a call (`approvals.ts`): the call parks, the thread shows T3's approval card in
// the run (an `approval_request` item, a pending `permission` request, "Needs approval" in the sidebar), and T3's
// decision (`runtime-request.respond`) is the signal that wakes the gate. A message typed meanwhile declines with
// feedback; Stop ends it; a restart keeps it. And the integrator's own slash commands (`HostCommand`), answered as
// `/context` is.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineExtension, defineTool, type Extension, type Harness, hook, LiveDoc, ToolTask } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, onTestFinished } from "vitest";
import type { ApprovalOutcome } from "../src/t3/approvals.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { dispatchCommand } from "../src/t3/dispatch.ts";
import type { HostCommand } from "../src/t3/host-command.ts";
import { snapshotItem } from "../src/t3/thread-stream.ts";
import { object } from "../src/t3/schema.ts";
import { bridgeConfig, conversation, createNamed, idle, makeThreads, quietLog, restart } from "./threads-harness.ts";

type Request = { id: string; kind: string; status: string; createdAt: unknown; responseCapability: { type: string; supportsFeedback?: boolean }; decision?: string; feedback?: string };
type Card = { id: string; type: string; status: string; runId: string; requestId: string; requestKind: string; prompt: string; reason?: string; appName?: string; fullAccessOverride?: string; options: { decision: string; label: string }[] };

/** An integrator's tool, `guarded`, and its gate, which asks the bridge in use (`bridge.current`) for each call and
 * records what it decided. */
function guarded(bridge: { current: Bridge | undefined }, decided: ApprovalOutcome[]): Extension {
	return defineExtension({
		name: "test-guarded",
		tools: [defineTool({ name: "guarded", description: "Asks first.", parameters: object({}), execute: async () => ({ output: [{ type: "text", text: "ran" }] }) })],
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					if (call.name !== "guarded") return undefined;
					const answer = await bridge.current!.approvals.ask(
						api,
						{
							key: "nas",
							prompt: "ssh max@nas.lan",
							reason: "The agent wants to use nas.",
							appName: "nas",
							options: [
								{ decision: "decline", label: "Deny" },
								{ decision: "accept", label: "Allow for 1 hour" },
								{ decision: "acceptForSession", label: "Allow in this thread" },
							],
						},
						context,
					);
					if ("sleep" in answer) return { sleep: answer.sleep };
					decided.push(answer);
					return answer.decision === "decline" ? { block: `declined${answer.feedback === undefined ? "" : `: ${answer.feedback}`}` } : undefined;
				},
			}),
		],
	});
}

/** Does the Harness come to need no running process (`wake().active`), once the call's last step ended? */
async function idleProcess(harness: Harness): Promise<boolean> {
	for (let tries = 0; tries < 200; tries++) {
		if (!harness.wake().active) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

/** Is call `callId` parked (its slot `sleeping`), once it had the time to park? */
async function parked(harness: Harness, head: number, callId: string): Promise<boolean> {
	for (let tries = 0; tries < 200; tries++) {
		if ((await harness.snapshot(LiveDoc, head as ConversationId, BACKGROUND_CONTEXT))?.tools?.find((each) => each.callId === callId)?.status === "sleeping") return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}

async function setup(commands?: readonly HostCommand[]) {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-approvals-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, ...(commands === undefined ? {} : { commands }) }), quietLog, f.threads, f.model.models);
	const current = { current: bridge as Bridge | undefined };
	const decided: ApprovalOutcome[] = [];
	const extension = guarded(current, decided);
	f.tools.install(extension);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const command = (fields: Record<string, unknown>, on: Bridge = bridge) => dispatchCommand(on, { commandId: `cmd-${++sent}`, threadId: "t", ...fields } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	const card = (status: string, on: Bridge = bridge) =>
		on.waitFor("t", (projection) => {
			const request = (projection.runtimeRequests as unknown as Request[]).find((candidate) => candidate.kind === "permission" && candidate.status === status);
			const item = (projection.turnItems as unknown as Card[]).find((candidate) => candidate.type === "approval_request" && candidate.requestId === request?.id);
			return request === undefined || item === undefined ? undefined : { request, item, projection };
		}, 10_000);
	const result = async (callId: string, harness: Harness = f.harness) => {
		const entries = (await (await conversation(harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
		const message = entries.flatMap((entry) => entry.model ?? []).find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === callId);
		return message?.role === "toolResult" ? message.content.map((block) => (block.type === "text" ? block.text : "")).join("") : undefined;
	};
	return { f, bridge, thread, command, card, result, decided, current, extension, scratch };
}

const call = (...callIds: string[]) => fauxAssistantMessage(callIds.map((callId) => fauxToolCall("guarded", {}, { id: callId })), { stopReason: "toolUse" });

it("shows T3's approval card in the run while the call is parked, and the decision lets the gate pass", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result, decided } = await setup();
	f.model.respond(call("call-1"), fauxAssistantMessage("Done on nas."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Check the disks on nas.", mode: "start" });

	const waiting = await card("pending");
	expect(waiting!.request).toMatchObject({ kind: "permission", responseCapability: { type: "live", supportsFeedback: true } });
	expect(waiting!.item).toMatchObject({
		status: "waiting",
		requestKind: "permission",
		prompt: "ssh max@nas.lan",
		reason: "The agent wants to use nas.",
		appName: "nas",
		// Every thread is full-access: T3 explains the card as a check of the host's own.
		fullAccessOverride: "provider_check",
		options: [
			{ decision: "decline", label: "Deny" },
			{ decision: "accept", label: "Allow for 1 hour" },
			{ decision: "acceptForSession", label: "Allow in this thread" },
		],
	});
	// The call is parked at its gate: it holds no process while the card waits.
	expect(await parked(f.harness, thread.head, "call-1")).toBe(true);
	expect(await idleProcess(f.harness), "nothing needs a process").toBe(true);
	const run = waiting!.projection.runs.at(-1)!;
	expect(waiting!.item.runId).toBe(run.id);
	expect(bridge.threadShell("t")).toMatchObject({ status: "running" });
	// The sidebar's "Needs approval": the shell names the waiting request.
	expect(bridge.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: waiting!.request.id, kind: "permission", blocking: true });
	const stream = await bridge.streamSnapshot("t");
	Schema.encodeSync(OrchestrationV2ThreadStreamItem)(snapshotItem(stream.sequence, stream.projection, { bounded: false, deferWork: false, compactTurnItems: false, dedupeBodies: false, compactIds: false }) as never);

	// A decision the card did not offer, or from another thread, is refused.
	await expect(command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "acceptAlways" })).rejects.toThrow("not one this request offers");
	await expect(command({ type: "runtime-request.respond", threadId: "other", requestId: waiting!.request.id, decision: "accept" })).rejects.toThrow(/no longer pending|Unknown thread/);

	await command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "acceptForSession" });
	await idle(f.harness, thread.head);
	expect(decided).toEqual([{ decision: "acceptForSession" }]);
	expect(await result("call-1")).toBe("ran");
	const decidedCard = await card("resolved");
	expect(decidedCard!.request).toMatchObject({ id: waiting!.request.id, decision: "acceptForSession" });
	expect(decidedCard!.item.status).toBe("completed");
	expect(bridge.threadShell("t").pendingRuntimeRequest).toBeNull();
	await expect(command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "accept" })).rejects.toThrow("is no longer pending");
});

it("takes a message typed meanwhile as a decline with its text, and ends unanswered on Stop", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result, decided } = await setup();
	f.model.respond(call("call-1"), fauxAssistantMessage("Fine."), call("call-2"), fauxAssistantMessage("Stopped."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Go.", mode: "start" });
	const first = await card("pending");
	// T3's web app sends what the user types while an approval waits as its feedback (`sendApprovalFeedback`).
	await command({ type: "runtime-request.respond", requestId: first!.request.id, decision: "decline", feedback: "  use the pi instead " });
	await idle(f.harness, thread.head);
	expect(decided).toEqual([{ decision: "decline", feedback: "use the pi instead" }]);
	expect(await result("call-1")).toContain("declined: use the pi instead");

	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "Again.", mode: "start" });
	const second = await bridge.waitFor("t", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.status === "pending" && request.id !== first!.request.id), 10_000);
	expect(await parked(f.harness, thread.head, "call-2"), "Stop finds the call parked").toBe(true);
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	const ended = await bridge.waitFor("t", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.id === second!.id && request.status === "cancelled"), 10_000);
	expect(ended).toBeDefined();
	expect(bridge.threadShell("t").pendingRuntimeRequest).toBeNull();
	await expect(command({ type: "runtime-request.respond", requestId: second!.id, decision: "accept" })).rejects.toThrow("is no longer pending");
	expect(decided).toHaveLength(1);
});

it("asks calls of one thread that ask the same question on one card, whose decision answers them all", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result, decided } = await setup();
	f.model.respond(call("call-1", "call-2"), fauxAssistantMessage("Both done."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Twice.", mode: "start" });
	expect(await parked(f.harness, thread.head, "call-1")).toBe(true);
	expect(await parked(f.harness, thread.head, "call-2")).toBe(true);
	const waiting = await card("pending");
	await bridge.waitFor("t", () => (bridge.approvals.shown("t")?.length === 1 ? true : undefined), 10_000);
	expect((waiting!.projection.runtimeRequests as unknown as Request[]).filter((request) => request.kind === "permission")).toHaveLength(1);
	await command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "accept" });
	await idle(f.harness, thread.head);
	expect(decided).toEqual([{ decision: "accept" }, { decision: "accept" }]);
	expect([await result("call-1"), await result("call-2")]).toEqual(["ran", "ran"]);
	const after = await card("resolved");
	expect((after!.projection.runtimeRequests as unknown as Request[]).filter((request) => request.kind === "permission")).toEqual([expect.objectContaining({ id: waiting!.request.id, status: "resolved" })]);
});

it("keeps a card waiting through a restart: the same request, answered after it", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, card, result, decided, current, extension, scratch, command } = await setup();
	f.model.respond(call("call-1"), fauxAssistantMessage("Done."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Go.", mode: "start" });
	const before = await card("pending");
	expect(await parked(f.harness, thread.head, "call-1")).toBe(true);
	await bridge.close();

	const up = await restart({ ...f, extensions: [extension] });
	const again = new Bridge(bridgeConfig({ stateDir: scratch, registry: up.registry }), quietLog, up.threads, f.model.models);
	current.current = again;
	again.start();
	onTestFinished(() => again.close());
	await again.loaded();
	const after = await card("pending", again);
	expect(after!.request).toMatchObject({ id: before!.request.id, createdAt: before!.request.createdAt });
	expect(after!.item).toMatchObject({ prompt: "ssh max@nas.lan", status: "waiting" });
	expect(again.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: before!.request.id, kind: "permission" });
	expect(decided).toEqual([]);

	await command({ type: "runtime-request.respond", requestId: before!.request.id, decision: "accept" }, again);
	await idle(up.harness, thread.head);
	expect(decided).toEqual([{ decision: "accept" }]);
	expect(await result("call-1", up.harness)).toBe("ran");
});

it("forgets a card still waiting when its thread is deleted, and does not open the deleted thread again", { timeout: 60_000 }, async () => {
	const { f, bridge } = await setup();
	f.model.respond(call("call-1"), fauxAssistantMessage("Never."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Go.", mode: "start" });
	await bridge.waitFor("t", () => (bridge.approvals.shown("t")?.length === 1 ? true : undefined), 10_000);
	await bridge.deleteThread("t");
	expect(bridge.approvals.shown("t")).toBeUndefined();
	expect(bridge.memory()).toMatchObject({ views: 0 });
});

it("answers the integrator's slash commands in the thread, shown only, and lists them for T3's composer", { timeout: 60_000 }, async () => {
	const seen: unknown[] = [];
	const { bridge } = await setup([
		{
			name: "machines",
			description: "The machines",
			hint: "allow <name>",
			async run(input) {
				seen.push(input);
				if (input.argument === "boom") throw new Error("No machine named boom.");
				return `| Machine |\n| --- |\n| nas (${input.argument}) |`;
			},
		},
	]);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "/machines  allow nas ", mode: "start" });
	const answered = await bridge.waitFor("t", (projection) => projection.messages.find((message) => message.role === "assistant" && message.text.includes("nas (allow nas)")), 10_000);
	expect(answered).toBeDefined();
	expect(seen).toEqual([{ threadId: "t", argument: "allow nas" }]);
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "/machines boom", mode: "start" });
	expect(await bridge.waitFor("t", (projection) => projection.messages.find((message) => message.text === "No machine named boom."), 10_000)).toBeDefined();
});
