// The first message on a freshly created thread used to reach `sendMessage` before its transcript resolved, so it read a
// not-yet-loaded head and threw "still loading" — the message was lost. It worked only when an earlier `selectModel` had
// happened to warm the thread. Now every write awaits the loaded head (S2). This drives a real `Bridge` over the chord
// objects in-process (no server): create a thread, then send as the FIRST write, and prove the user turn is not lost.
import { mkdtemp, rm } from "node:fs/promises";
import { ServerSettingsStore } from "../src/settings.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId } from "@earendil-works/pi-durable";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { USER_ENTRY_KINDS } from "../src/t3/runs.ts";
import type { Logger } from "../src/t3/logging.ts";
import { makeThreads } from "./threads-harness.ts";

const ctx = BACKGROUND_CONTEXT;
const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("sends the first message on a cold thread with no prior warming (S2)", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-bridge-"));
	const host = createHost({ name: "server" });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	fixture.model.respond(fauxAssistantMessage("pong"));

	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry },
		log,
		host,
	);
	bridge.start();
	try {
		const threadId = await bridge.createThread({ threadId: "cold", projectId: "p" });
		// The FIRST write for this thread is a send — no selectModel, no projection first. Pre-fix this threw.
		await bridge.sendMessage({ threadId, commandId: "c1", messageId: "m1", text: "ping", mode: "start" });

		// The message was not lost: a user turn landed on the conversation.
		const head = (await fixture.threads.thread("cold"))?.head;
		expect(head).toBeTypeOf("number");
		const deadline = Date.now() + 8000;
		for (;;) {
			const conversation = await fixture.harness.conversation(head as ConversationId, ctx);
			const entries = (await conversation?.context(ctx))?.entries ?? [];
			if (entries.some((entry) => USER_ENTRY_KINDS.has(entry.kind))) break;
			if (Date.now() > deadline) throw new Error("the first message never produced a user turn (message was lost)");
			await sleep(50);
		}
	} finally {
		await bridge.close();
		await host.close();
		await rm(scratch, { recursive: true, force: true });
	}
}, 30_000);
