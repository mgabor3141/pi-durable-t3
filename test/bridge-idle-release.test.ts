// An idle thread releases its chord references, so the objects behind it are disposed instead of piling up per open
// (each reopen used to take two more references and never give them back). Reopening re-creates them from durable state:
// the transcript is all there, and the thread takes the next message.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createHost } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => vi.restoreAllMocks());

it("an idle thread's objects are disposed, and a reopen rebuilds them with the whole transcript", async () => {
	// The bridge's 30 s idle release, shortened.
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => realSetTimeout(fn, ms === 30_000 ? 20 : ms)) as typeof setTimeout);

	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(fixture.threads, fixture.harness, fixture.model)({ threadId: "t", projectId: "p" });
	// Each transcript object opens its head conversation once, when it is created.
	let opens = 0;
	const conversation = fixture.harness.conversation.bind(fixture.harness);
	fixture.harness.conversation = ((...args: Parameters<typeof conversation>) => {
		opens++;
		return conversation(...args);
	}) as typeof conversation;

	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-idle-"));
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry },
		log,
		host,
	);
	bridge.start();
	const texts = async () => (await bridge.projection("t")).projection.messages.map((message) => message.text);
	const until = async (what: string, test: () => Promise<boolean>) => {
		for (let i = 0; i < 200; i++) if (await test()) return;
		throw new Error(`timed out: ${what}`);
	};
	try {
		fixture.model.respond(fauxAssistantMessage("pong one"));
		await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "one", mode: "start" });
		await until("the first reply", async () => (await texts()).includes("pong one") || (await sleep(50), false));

		// Idle: the references are released, so the objects go. A reopen creates the transcript object anew.
		await sleep(300);
		const before = opens;
		expect(await texts()).toEqual(["one", "pong one"]);
		expect(opens).toBeGreaterThan(before);

		fixture.model.respond(fauxAssistantMessage("pong two"));
		await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "two", mode: "start" });
		await until("the second reply", async () => (await texts()).includes("pong two") || (await sleep(50), false));
		expect(await texts()).toEqual(["one", "pong one", "two", "pong two"]);
	} finally {
		await bridge.close();
		await host.close();
		await rm(scratch, { recursive: true, force: true });
	}
}, 60_000);
