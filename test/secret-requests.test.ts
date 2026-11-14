// T3's request_secret on this host: the agent's call is T3's secret card in the thread, the user's answer goes to the
// integrator's store under the agent's name for it, and the value appears nowhere in the thread.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SecretRequestError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { SecretRequests } from "../src/t3/secret-requests.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const SECRET = "ghp_supersecretvalue123";

it("asks with T3's card, saves the answer by name, and keeps the value out of the thread", { timeout: 60_000 }, async () => {
	let bridge: Bridge | undefined;
	const saved = new Map<string, string>();
	const requests = new SecretRequests((conversationId) => bridge!.threadIdForConversation(conversationId), { arrivalMs: 200, onSaved: (threadId) => bridge!.wakeForSavedSecret(threadId) });
	const extension = requests.extension({ save: async (name, value) => void saved.set(name, value) });
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p", title: "Secrets" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-secret-"));
	bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
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
	// The card's button (T3 0.1.9) opens the page the agent named.
	expect(card).toMatchObject({ id: "ti-tcall-1", label: "GitHub token", reason: "To read your repos.", url: "https://github.com/settings/tokens", placeholder: "ghp_…", delivery: "file" });
	// An answer through a secret provider (T3 0.1.9) is refused: this host has none, and does not say it has.
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "reference", reference: { provider: "op", reference: "op://vault/item" } } } as never)).rejects.toMatchObject({ reason: "reference_unreadable" });
	// The thread was snoozed while its agent waited: the saved secret wakes it (T3 0.1.9), and only that.
	await bridge.snoozeThread("t", new Date(Date.now() + 3_600_000).toISOString());
	expect(bridge.threadRecord("t")!.snoozedUntil).toBeDefined();

	// An answer for another thread, or for no waiting card, is refused with T3's reasons.
	await expect(requests.answer({ threadId: ThreadId.make("other"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "save", secret: SECRET } })).rejects.toMatchObject({ reason: "not_found" });
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tnope"), answer: { type: "decline" } })).rejects.toBeInstanceOf(SecretRequestError);

	await requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "save", secret: SECRET } });
	expect(saved.get("GITHUB_TOKEN")).toBe(SECRET);
	const woken = bridge.threadRecord("t")!;
	expect([woken.snoozedUntil, woken.snoozedAt, woken.lastSnoozeWakeAt]).toEqual([undefined, undefined, undefined]);
	await expect(requests.answer({ threadId: ThreadId.make("t"), turnItemId: TurnItemId.make("ti-tcall-1"), answer: { type: "decline" } })).rejects.toMatchObject({ reason: "agent_stopped" });

	const done = await bridge.waitFor("t", (projection) => (projection.turnItems.some((item) => item.type === "secret_request" && item.secretStatus === "saved") ? projection : undefined), 10_000);
	expect(JSON.stringify(done)).not.toContain(SECRET);

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
