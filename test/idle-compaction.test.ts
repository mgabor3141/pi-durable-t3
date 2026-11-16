// T3's idle compaction, "Before the cache expires": a thread left alone with a large context is compacted shortly
// before the provider drops its prompt cache, while the summary can still read the conversation from it. The provider
// says which lifetime a request's cache got, the model how long that is, and the bridge sends `/compact` as T3 does.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { IDLE_COMPACTION_LEAD_MS, IDLE_COMPACTION_MIN_TOKENS, IdleCompaction } from "../src/t3/idle-compaction.ts";
import { conversation, createNamed, idle, makeThreads, bridgeConfig } from "./threads-harness.ts";

afterEach(() => void (IdleCompaction.limits = { minTokens: IDLE_COMPACTION_MIN_TOKENS, leadMs: IDLE_COMPACTION_LEAD_MS }));

type Message = { id: string; text: string; role: string; createdBy: string; creationSource: string; idleCompaction?: string };
type Usage = { usedTokens: number; promptCacheTtlMs?: number; promptCacheExpiresAt?: string; updatedAt: string };

// Long enough that a compaction has something to cut (it keeps the last 20k tokens).
const long = "x".repeat(120_000);

async function setup(settings: object) {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	// The model says how long its provider keeps a cache entry (pi-ai's `Model.promptCache`), as Anthropic's do.
	(f.model.faux.models[0] as { promptCache?: object }).promptCache = { short: 300, long: 3600 };
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-idle-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const store = ServerSettingsStore.open(scratch);
	if (Object.keys(settings).length > 0) store.update(settings);
	const logged: string[] = [];
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, settings: store }), { info: (message: string, fields?: unknown) => void logged.push(`${message} ${JSON.stringify(fields ?? {})}`), warn: (message: string, fields?: unknown) => void logged.push(`WARN ${message} ${JSON.stringify(fields ?? {})}`), error: () => {}, debug: () => {} } as never, f.threads, f.model.models);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const turn = async (text: string, answer: string) => {
		const n = ++sent;
		f.model.append(fauxAssistantMessage(answer));
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text, mode: "start" });
		await idle(f.harness, thread.head);
	};
	const compactions = async () => (await (await conversation(f.harness, thread.head)).entries({ order: "ascending" }, 300, undefined, BACKGROUND_CONTEXT)).items.filter((entry) => entry.kind === "pi.compaction").length;
	return { f, bridge, thread, turn, compactions, logged, store };
}

it("compacts an idle thread shortly before its prompt cache expires, once, and says it did", { timeout: 60_000 }, async () => {
	// The cache lives 300 seconds from the request: start a second after it instead of two minutes before the end.
	IdleCompaction.limits = { minTokens: 1000, leadMs: 299_000 };
	const { f, bridge, thread, turn, compactions, logged } = await setup({ idleCompaction: "beforeCacheExpires" });
	await turn("one", "first" + long);
	await turn("two", "second" + long);
	// T3 is told when the cache of the run's last request expires: five minutes after it, the lifetime it was written with.
	const usage = (await bridge.projection("t")).projection.providerTurns.at(-1)!.tokenUsage as unknown as Usage;
	expect(usage.promptCacheTtlMs).toBe(300_000);
	const expires = Date.parse(usage.promptCacheExpiresAt!);
	expect(expires).toBeGreaterThan(Date.now() + 290_000);
	expect(expires).toBeLessThan(Date.now() + 300_000);
	expect(await compactions()).toBe(0);

	f.model.append(fauxAssistantMessage("## Goal\nsummarized"));
	await expect.poll(compactions, { timeout: 20_000 }).toBe(1);
	await idle(f.harness, thread.head);
	const messages = (await bridge.projection("t")).projection.messages as unknown as Message[];
	// The `/compact` is the host's own, marked as T3 marks its own.
	expect(messages.find((message) => message.text === "/compact")).toMatchObject({ role: "user", createdBy: "agent", creationSource: "server", idleCompaction: "beforeCacheExpires" });
	expect(logged.some((line) => line.startsWith("compacting an idle thread before its prompt cache expires"))).toBe(true);
	// A compaction is not compacted: one idle spell, one compaction.
	await sleep(2500);
	expect(await compactions()).toBe(1);
	expect(logged.filter((line) => line.startsWith("WARN"))).toEqual([]);
});

it("leaves a thread alone under T3's other settings, under the floor, and when the thread went on", { timeout: 60_000 }, async () => {
	IdleCompaction.limits = { minTokens: 1000, leadMs: 299_000 };
	// T3's default is "When you return", which its web app does for Claude threads only: nothing happens here.
	const off = await setup({});
	await off.turn("one", "first" + long);
	await off.turn("two", "second" + long);
	await sleep(2500);
	expect(await off.compactions()).toBe(0);

	// Under the floor (T3's 200,000 tokens) a cold re-read is cheap.
	IdleCompaction.limits = { minTokens: 10_000_000, leadMs: 299_000 };
	const small = await setup({ idleCompaction: "beforeCacheExpires" });
	await small.turn("one", "first" + long);
	await small.turn("two", "second" + long);
	await sleep(2500);
	expect(await small.compactions()).toBe(0);

	// A thread that is used again is not idle: the timer of the earlier run is replaced by the later run's.
	IdleCompaction.limits = { minTokens: 1000, leadMs: 297_500 };
	const busy = await setup({ idleCompaction: "beforeCacheExpires" });
	await busy.turn("one", "first" + long);
	await sleep(1200);
	await busy.turn("two", "second" + long);
	await sleep(1500);
	expect(await busy.compactions(), "2.5 seconds after the first run, 1.5 after the second").toBe(0);
	busy.f.model.append(fauxAssistantMessage("## Goal\nsummarized"));
	await expect.poll(busy.compactions, { timeout: 20_000 }).toBe(1);

	// A snoozed thread is left alone.
	IdleCompaction.limits = { minTokens: 1000, leadMs: 298_500 };
	const snoozed = await setup({ idleCompaction: "beforeCacheExpires" });
	await snoozed.turn("one", "first" + long);
	await snoozed.turn("two", "second" + long);
	await snoozed.bridge.sidebar.snooze("t", new Date(Date.now() + 3_600_000).toISOString());
	await sleep(3000);
	expect(await snoozed.compactions()).toBe(0);
	expect(snoozed.logged.some((line) => line.includes("the thread is snoozed"))).toBe(true);
});

it("turning the setting on covers a thread that is idle already, as a start of the bridge does", { timeout: 60_000 }, async () => {
	IdleCompaction.limits = { minTokens: 1000, leadMs: 299_000 };
	const { f, turn, compactions, store } = await setup({});
	await turn("one", "first" + long);
	await turn("two", "second" + long);
	await sleep(1500);
	expect(await compactions()).toBe(0);
	f.model.append(fauxAssistantMessage("## Goal\nsummarized"));
	// The same look the bridge takes when it starts: the threads whose latest run completed within the cache's lifetime.
	store.update({ idleCompaction: "beforeCacheExpires" });
	await expect.poll(compactions, { timeout: 20_000 }).toBe(1);
});
