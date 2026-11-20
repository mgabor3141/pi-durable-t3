// T3's request_secret on this host: the agent's call is T3's secret card in the thread, the user's answer goes to the
// integrator's store under the agent's name for it, and the value appears nowhere in the thread.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { SecretRequestError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vitest";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { SecretRequests } from "../src/t3/secret-requests.ts";
import { createNamed, makeThreads, bridgeConfig, restart } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

/** Is call `callId` of thread "t" parked (its slot `sleeping`), once it had the time to park? */
async function parked(f: Awaited<ReturnType<typeof makeThreads>>, callId: string): Promise<boolean> {
	const head = (await f.threads.list()).find((thread) => thread.threadId === "t")!.head as ConversationId;
	for (let tries = 0; tries < 200; tries++) {
		if ((await f.harness.snapshot(LiveDoc, head, BACKGROUND_CONTEXT))?.tools?.find((each) => each.callId === callId)?.status === "sleeping") return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return false;
}
const SECRET = "ghp_supersecretvalue123";

it("asks with T3's card, saves the answer by name, and keeps the value out of the thread", { timeout: 60_000 }, async () => {
	let bridge: Bridge | undefined;
	const saved = new Map<string, string>();
	let f: Awaited<ReturnType<typeof makeThreads>> | undefined;
	const requests = new SecretRequests(
		{ harness: () => f!.harness, liveCall: (threadId, callId) => bridge!.liveCall(threadId, callId), hasThread: (threadId) => bridge!.hasThread(threadId) },
		{ onSaved: (threadId) => bridge!.sidebar.wakeForSavedSecret(threadId) },
	);
	const extension = requests.extension({ save: async (name, value) => void saved.set(name, value) });
	f = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Secrets" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-secret-"));
	bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge!.close();
		await rm(scratch, { recursive: true, force: true });
	});

	const ask = (callId: string, name: string) =>
		fauxAssistantMessage([fauxToolCall("request_secret", { name, label: "GitHub token", reason: "To read your repos.", url: " https://github.com/settings/tokens ", placeholder: "ghp_…" }, { id: callId })], { stopReason: "toolUse" });
	f.model.respond(ask("call-1", "GITHUB_TOKEN"), fauxAssistantMessage("Saved, thanks."), ask("call-2", "OTHER_TOKEN"), fauxAssistantMessage("Fine."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Connect GitHub.", mode: "start" });

	const card = await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.type === "secret_request" && item.secretStatus === "pending"), 10_000);
	// The call is parked while the card waits: it holds no process.
	expect(await parked(f, "call-1")).toBe(true);
	// The card's button (T3 0.1.9) opens the page the agent named.
	expect(card).toMatchObject({ id: "ti-tcall-1", label: "GitHub token", reason: "To read your repos.", url: "https://github.com/settings/tokens", placeholder: "ghp_…", delivery: "file" });
	// The waiting card is the thread's pending request, as T3's shell has it: "Needs your input" in the sidebar, and one
	// only the user answers (`userOnly`), so a parent shows it for its child.
	expect(bridge.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: "ti-tcall-1", kind: "user_input", blocking: true, userOnly: true });
	// An answer through a secret provider (T3 0.1.9) is refused: this host has none, and does not say it has.
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "reference", reference: { provider: "op", reference: "op://vault/item" } } } as never)).rejects.toMatchObject({ reason: "reference_unreadable" });
	// The thread was snoozed while its agent waited: the saved secret wakes it (T3 0.1.9), and only that.
	await bridge.sidebar.snooze("t", new Date(Date.now() + 3_600_000).toISOString());
	expect(bridge.threadRecord("t")!.snoozedUntil).toBeDefined();

	// An answer for another thread, or for no waiting card, is refused with T3's reasons.
	await expect(requests.answer({ threadId: ThreadId.make("other"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "save", secret: SECRET } })).rejects.toMatchObject({ reason: "not_found" });
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tnope"), answer: { type: "decline" } })).rejects.toBeInstanceOf(SecretRequestError);

	await requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "save", secret: SECRET } });
	expect(saved.get("GITHUB_TOKEN")).toBe(SECRET);
	const woken = bridge.threadRecord("t")!;
	expect([woken.snoozedUntil, woken.snoozedAt, woken.lastSnoozeWakeAt]).toEqual([undefined, undefined, undefined]);
	// Answered once: a second answer is refused, while the call goes on (T3's `already_answered`) or once it ended.
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "decline" } })).rejects.toMatchObject({ reason: expect.stringMatching(/^(already_answered|agent_stopped)$/) });

	const done = await bridge.waitFor("t", (projection) => (projection.turnItems.some((item) => item.type === "secret_request" && item.secretStatus === "saved") ? projection : undefined), 10_000);
	expect(JSON.stringify(done)).not.toContain(SECRET);
	expect(bridge.threadShell("t").pendingRuntimeRequest, "answered, it no longer waits").toBeNull();

	// A second ask, declined.
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "Another.", mode: "start" });
	await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.id === "ti-tcall-2" && item.type === "secret_request" && item.secretStatus === "pending"), 10_000);
	await requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-2"), answer: { type: "decline" } });
	const declined = await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.id === "ti-tcall-2" && item.type === "secret_request" && item.secretStatus === "declined"), 10_000);
	expect(declined).toBeDefined();
	// A card that ends without a secret tells the agent what to do next (T3's note).
	const { entries: afterDecline } = await (await f.harness.conversation((await f.threads.list()).find((thread) => thread.threadId === "t")!.head as never, {} as never))!.context({} as never);
	expect(JSON.stringify(afterDecline)).toContain("The user declined. Don't ask for it in chat or another way");
	expect(saved.has("OTHER_TOKEN")).toBe(false);

	// The agent got the name back, never the value.
	const { entries } = await (await f.harness.conversation((await f.threads.list()).find((thread) => thread.threadId === "t")!.head as never, {} as never))!.context({} as never);
	expect(JSON.stringify(entries)).toContain('"name\\":\\"GITHUB_TOKEN\\"');
	expect(JSON.stringify(entries)).not.toContain(SECRET);
});

it("a card that waits through a restart is answered after it: saved, and the call goes on with the name", { timeout: 60_000 }, async () => {
	const saved = new Map<string, string>();
	const sink = { save: async (name: string, value: string) => void saved.set(name, value) };
	let bridge: Bridge | undefined;
	let harness: (() => Awaited<ReturnType<typeof makeThreads>>["harness"]) | undefined;
	const requests = new SecretRequests({ harness: () => harness!(), liveCall: (threadId, callId) => bridge!.liveCall(threadId, callId), hasThread: (threadId) => bridge!.hasThread(threadId) });
	const extension = requests.extension(sink);
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
	harness = () => f.harness;
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Secrets" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-secret-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry }), log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	f.model.respond(fauxAssistantMessage([fauxToolCall("request_secret", { name: "API_KEY", label: "API key", reason: "To call the API." }, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("Saved."));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Use the API.", mode: "start" });
	await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.id === "ti-tcall-1" && item.type === "secret_request" && item.secretStatus === "pending"), 10_000);
	expect(await parked(f, "call-1")).toBe(true);
	await bridge.close();

	const up = await restart(f);
	harness = () => up.harness;
	bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: up.registry }), log, up.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge!.close());
	await bridge.loaded();
	// The same card, waiting, and the thread's request.
	await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.id === "ti-tcall-1" && item.type === "secret_request" && item.secretStatus === "pending"), 10_000);
	expect(bridge.threadShell("t").pendingRuntimeRequest).toMatchObject({ id: "ti-tcall-1", kind: "user_input" });
	await requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "save", secret: SECRET } });
	expect(saved.get("API_KEY")).toBe(SECRET);
	await bridge.waitFor("t", (projection) => projection.turnItems.find((item) => item.id === "ti-tcall-1" && item.type === "secret_request" && item.secretStatus === "saved"), 10_000);
	const head = (await up.threads.list()).find((thread) => thread.threadId === "t")!.head as ConversationId;
	const { entries } = await (await up.harness.conversation(head, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT);
	expect(JSON.stringify(entries)).toContain('"name\\":\\"API_KEY\\"');
	expect(JSON.stringify(entries)).not.toContain(SECRET);
});
