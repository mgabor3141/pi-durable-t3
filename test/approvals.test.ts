// A host's own tool asks the user to approve something (`approvals.ts`): the thread shows T3's approval card in the
// run (an `approval_request` item, a pending `permission` request, "Needs approval" in the sidebar), and T3's decision
// (`runtime-request.respond`) is what the tool gets. A message typed meanwhile declines with feedback; Stop ends it.
// And the integrator's own slash commands (`HostCommand`), answered as `/context` is.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
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
import { bridgeConfig, conversation, createNamed, idle, makeThreads, quietLog } from "./threads-harness.ts";

type Request = { id: string; kind: string; status: string; responseCapability: { type: string; supportsFeedback?: boolean }; decision?: string; feedback?: string };
type Card = { id: string; type: string; status: string; runId: string; requestId: string; requestKind: string; prompt: string; reason?: string; appName?: string; fullAccessOverride?: string; options: { decision: string; label: string }[] };

async function setup(commands?: readonly HostCommand[]) {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-approvals-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, ...(commands === undefined ? {} : { commands }) }), quietLog, f.threads, f.model.models);
	// A tool of the integrator's that stops for the user's approval, and returns what it got.
	f.tools.install(
		defineExtension({
			name: "test-guarded",
			tools: [
				defineTool({
					name: "guarded",
					description: "Asks first.",
					parameters: object({}),
					async execute(_args, api, context) {
						const outcome: ApprovalOutcome = await bridge.approvals.request(
							{
								conversationId: api.conversationId,
								prompt: "ssh max@nas.lan",
								reason: "The agent wants to use nas.",
								appName: "nas",
								options: [
									{ decision: "decline", label: "Deny" },
									{ decision: "accept", label: "Allow for 1 hour" },
									{ decision: "acceptForSession", label: "Allow in this thread" },
								],
							},
							context.abortSignal,
						);
						return { output: [{ type: "text", text: JSON.stringify(outcome) }] };
					},
				}),
			],
		}),
	);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const command = (fields: Record<string, unknown>) => dispatchCommand(bridge, { commandId: `cmd-${++sent}`, threadId: "t", ...fields } as never, { createdBy: "user", creationSource: "web" }, quietLog);
	const card = (status: string) =>
		bridge.waitFor("t", (projection) => {
			const request = (projection.runtimeRequests as unknown as Request[]).find((candidate) => candidate.kind === "permission" && candidate.status === status);
			const item = (projection.turnItems as unknown as Card[]).find((candidate) => candidate.type === "approval_request" && candidate.requestId === request?.id);
			return request === undefined || item === undefined ? undefined : { request, item, projection };
		}, 10_000);
	const result = async (callId: string) => {
		const entries = (await (await conversation(f.harness, thread.head)).entries({ order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items;
		const message = entries.flatMap((entry) => entry.model ?? []).find((candidate) => candidate.role === "toolResult" && candidate.toolCallId === callId);
		return message?.role === "toolResult" ? JSON.parse(message.content.map((block) => (block.type === "text" ? block.text : "")).join("")) : undefined;
	};
	return { f, bridge, thread, command, card, result };
}

const call = (callId: string) => fauxAssistantMessage([fauxToolCall("guarded", {}, { id: callId })], { stopReason: "toolUse" });

it("shows T3's approval card in the run, and the decision is what the tool gets", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result } = await setup();
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
	const run = waiting!.projection.runs.at(-1)!;
	expect(waiting!.item.runId).toBe(run.id);
	// The sidebar's "Needs approval": the shell names the waiting request.
	expect(bridge.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: waiting!.request.id, kind: "permission", blocking: true });
	const stream = await bridge.streamSnapshot("t");
	Schema.encodeSync(OrchestrationV2ThreadStreamItem)(snapshotItem(stream.sequence, stream.projection, { bounded: false, deferWork: false, compactTurnItems: false, dedupeBodies: false, compactIds: false }) as never);

	// A decision the card did not offer, or from another thread, is refused.
	await expect(command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "acceptAlways" })).rejects.toThrow("not one this request offers");
	await expect(command({ type: "runtime-request.respond", threadId: "other", requestId: waiting!.request.id, decision: "accept" })).rejects.toThrow(/no longer pending|Unknown thread/);

	await command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "acceptForSession" });
	await idle(f.harness, thread.head);
	expect(await result("call-1")).toEqual({ status: "decided", decision: "acceptForSession" });
	const decided = await card("resolved");
	expect(decided!.request).toMatchObject({ decision: "acceptForSession" });
	expect(decided!.item.status).toBe("completed");
	expect(bridge.threadShell("t").pendingRuntimeRequest).toBeNull();
	await expect(command({ type: "runtime-request.respond", requestId: waiting!.request.id, decision: "accept" })).rejects.toThrow("is no longer pending");
});

it("takes a message typed meanwhile as a decline with its text, and ends unanswered on Stop", { timeout: 60_000 }, async () => {
	const { f, bridge, thread, command, card, result } = await setup();
	f.model.respond(call("call-1"), fauxAssistantMessage("Fine."), call("call-2"), fauxAssistantMessage("Stopped."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Go.", mode: "start" });
	const first = await card("pending");
	// T3's web app sends what the user types while an approval waits as its feedback (`sendApprovalFeedback`).
	await command({ type: "runtime-request.respond", requestId: first!.request.id, decision: "decline", feedback: "  use the pi instead " });
	await idle(f.harness, thread.head);
	expect(await result("call-1")).toEqual({ status: "decided", decision: "decline", feedback: "use the pi instead" });

	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "Again.", mode: "start" });
	const second = await bridge.waitFor("t", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.status === "pending" && request.id !== first!.request.id), 10_000);
	await bridge.interrupt("t");
	await idle(f.harness, thread.head);
	const ended = await bridge.waitFor("t", (projection) => (projection.runtimeRequests as unknown as Request[]).find((request) => request.id === second!.id && request.status === "cancelled"), 10_000);
	expect(ended).toBeDefined();
	expect(bridge.threadShell("t").pendingRuntimeRequest).toBeNull();
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
