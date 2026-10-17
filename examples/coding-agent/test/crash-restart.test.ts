// A turn in flight when the host is SIGKILLed must finish after a restart, driven by the restart's own scheduler —
// no new submit, no duplicated user turn. The restart calls `harness.resume()` itself, AFTER `attachT3` resolves —
// the contract's (the bridge never resumes; the caller does). The wait loop uses READ-ONLY calls on purpose:
// `waitForIdle` and `Submission.wait` enable task scheduling themselves and would hide a missing `harness.resume()`.
// This is the only test that drives the example's wiring (`openCodingHarness` + `attachT3`) across a process boundary.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, type EntryRecord, UserEntry } from "@earendil-works/pi-durable";
import { attachT3 } from "../../../src/bridge.ts";
import { Threads } from "../../../src/threads.ts";
import { FileProjectRegistry } from "../../../src/registry.ts";
import { nullLogger } from "../../../src/t3/logging.ts";
import { openCodingHarness } from "../src/host-runtime.ts";
import { createScriptedModel } from "../../../test/fake-model.ts";

const childScript = new URL("../../../test/crash-child.ts", import.meta.url).pathname;
const PORT = 4951; // its own port, clear of the host-process tests (4901-4905) and the smoke (4911/4920).
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (entry: EntryRecord): string => {
	const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((b) => ((b as { type?: string }).type === "text" ? [(b as { text: string }).text] : [])).join("");
};

/** Run the child until it reports its admitted run, then SIGKILL it mid-turn. Returns the crashed head's id. */
function crashMidTurn(root: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", childScript, root, "alpha", join(root, "head.txt")], { stdio: ["ignore", "pipe", "inherit"] });
		let buffer = "";
		let killed = false;
		child.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			if (!killed && buffer.includes("ADMITTED")) {
				killed = true;
				child.kill("SIGKILL");
			}
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal !== "SIGKILL") return reject(new Error(`child exited ${code}/${signal} before being killed:\n${buffer}`));
			const match = /ADMITTED (\d+)/.exec(buffer);
			return match === null ? reject(new Error(`no admitted run in output:\n${buffer}`)) : resolve(Number(match[1]));
		});
	});
}

describe("crash and restart (the example wiring)", () => {
	it("finishes the interrupted turn after the restart, with no new submit", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-durable-t3-crash-restart-"));
		try {
			const head = await crashMidTurn(root);

			// The restart: the same wiring, the same root, and nothing submitted here.
			const model = createScriptedModel([fauxAssistantMessage("RESUMED-REPLY")]);
			const registry = FileProjectRegistry.open(root);
			const runtime = await openCodingHarness({ dataDir: root }, model.models);
			const attach = await attachT3(runtime.harness, {
				models: model.models,
				stateDir: root,
				listen: { host: "127.0.0.1", port: PORT },
				log: nullLogger,
			});
			runtime.harness.resume(); // the caller's, after the attach resolves (the contract).
			const threads = new Threads({ harness: runtime.harness, registry });
			try {
				const entriesAt = async (): Promise<readonly EntryRecord[]> => {
					const conversation = await runtime.harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
					if (conversation === undefined) throw new Error(`conversation ${head} is gone`);
					return (await conversation.context(BACKGROUND_CONTEXT)).entries;
				};

				const deadline = Date.now() + 25_000;
				let entries: readonly EntryRecord[] = [];
				for (;;) {
					entries = await entriesAt();
					if (entries.some((entry) => entry.kind === "pi.assistant" && textOf(entry).includes("RESUMED-REPLY"))) break;
					if (Date.now() > deadline) throw new Error(`the unfinished turn never resumed: ${entries.map((e) => e.kind).join(",") || "(no entries)"}`);
					await sleep(250);
				}

				// Resumed, not re-asked: one user message, and this process's own model call produced the reply.
				expect(entries.filter((entry) => entry.kind === UserEntry.kind)).toHaveLength(1);
				expect(model.faux.state.callCount).toBeGreaterThanOrEqual(1);
				// The threads doc is unchanged by the restart: one thread, still pointing at the crashed head.
				expect((await threads.list()).filter((thread) => thread.head === head)).toHaveLength(1);
			} finally {
				await attach.close();
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 90_000);
});
