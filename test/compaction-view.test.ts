import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
// A compacted thread through the bridge's view: pi-durable's view lists the whole transcript with the compaction summary
// where it was written (after the entries it keeps); the bridge shows every turn in order and the card where the summary
// landed, as T3 shows a provider's compaction: here in the `/compact` run, which T3 folds into one compaction row. The
// cut fell inside turn 3, and nothing marks it in the timeline. The same projection after a restart.
const shape = (items: readonly { type: string; text?: string }[]) => items.map((item) => [item.type, (item.text ?? "").slice(0, 12)]);

it("a compacted thread shows its turns in order and the card where the summary landed, after a restart too", async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "probe-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	const long = "x".repeat(40_000);
	for (const n of [1, 2, 3, 4]) {
		f.model.respond(fauxAssistantMessage(`answer ${n} ${long}`));
		await bridge.sendMessage({ threadId: "t", commandId: `c${n}`, messageId: `m${n}`, text: `question ${n}`, mode: "start" });
		await idle(f.harness, thread.head);
	}
	f.model.respond(fauxAssistantMessage("SUMMARY"));
	await bridge.sendMessage({ threadId: "t", commandId: "c-compact", messageId: "m-compact", text: "/compact", mode: "start" });
	await idle(f.harness, thread.head);
	for (let i = 0; i < 100 && !(await bridge.projection("t")).projection.turnItems.some((item) => item.type === "compaction"); i++) await new Promise((r) => setTimeout(r, 30));
	f.model.respond(fauxAssistantMessage("answer 5"));
	await bridge.sendMessage({ threadId: "t", commandId: "c5", messageId: "m5", text: "question 5", mode: "start" });
	await idle(f.harness, thread.head);
	await new Promise((r) => setTimeout(r, 200));
	const { projection } = await bridge.projection("t");
	const items = projection.turnItems as unknown as { type: string; text?: string; runId: string }[];
	const command = items.find((item) => item.type === "user_message" && item.text === "/compact")!;
	expect(items.find((item) => item.type === "compaction")!.runId, "the card is in the /compact run").toBe(command.runId);
	expect(shape(items)).toEqual([
		["user_message", "question 1"],
		["assistant_message", "answer 1 xxx"],
		["user_message", "question 2"],
		["assistant_message", "answer 2 xxx"],
		["user_message", "question 3"],
		["assistant_message", "answer 3 xxx"],
		["user_message", "question 4"],
		["assistant_message", "answer 4 xxx"],
		["user_message", "/compact"],
		["compaction", ""],
		["user_message", "question 5"],
		["assistant_message", "answer 5"],
	]);
	const fresh = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	fresh.start(); await fresh.loaded();
	const again = (await fresh.projection("t")).projection.turnItems as unknown as { type: string; text?: string; runId: string }[];
	expect(shape(again)).toEqual(shape(items));
	await bridge.close(); await fresh.close(); await rm(scratch, { recursive: true, force: true });
}, 60_000);
