// The example's prompt: the `CodingExtension` (a pi-durable extension with a `base` section, plus the optional
// instructions file as an `instructions` section). Drives the real `openCodingHarness` path with the faux model and
// inspects the SYSTEM messages the model actually receives (via a response factory that captures `context.messages`).
// Temp roots only; never `~/.pi`.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import { type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { Threads } from "../../src/threads.ts";
import { CodingExtension } from "./base-prompt.ts";
import { loadConfig, parseConfigToml } from "./config.ts";
import { openCodingHarness } from "./host-runtime.ts";
import { createScriptedModel } from "../../test/fake-model.ts";
import { testRegistry } from "../../test/test-registry.ts";
import { firstUserEntry, idle } from "../../test/threads-harness.ts";

type SysSection = { content: unknown; sections?: Record<string, string | null> };

/** Flatten one request's system messages to text: the base content plus every rendered section. */
function sysText(messages: readonly SysSection[]): string {
	return messages
		.map((m) => (typeof m.content === "string" ? m.content : "") + Object.values(m.sections ?? {}).map((v) => v ?? "").join("\n"))
		.join("\n");
}

/** A faux step that records the system messages it receives (per request) and replies with a fixed line. */
function recorder() {
	const structured: SysSection[][] = [];
	const texts: string[] = [];
	const step: FauxResponseStep = async (context) => {
		const sys = context.messages.filter((m) => m.role === "system") as unknown as SysSection[];
		structured.push(sys);
		texts.push(sysText(sys));
		return fauxAssistantMessage("ok");
	};
	// The same closure backs every generation, so all requests append to the shared captures.
	return { step, responses: Array.from({ length: 8 }, () => step), structured, texts };
}

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-prompt-"));
	if (dir.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
	return dir;
}

describe("base prompt + instructions", () => {
	it("a new thread's prompt carries its own project cwd and the instructions file text (two projects → two cwds)", async () => {
		const root = await tempRoot();
		try {
			const marker = "REPO-MARKER-42 follow these rules";
			await writeFile(join(root, "notes.md"), marker);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const registry = testRegistry([{ id: "alpha", cwd: join(root, "projects/alpha") }, { id: "beta", cwd: join(root, "projects/beta") }]);
			const runtime = await openCodingHarness({ dataDir: root }, registry, model.models, { extensions: [CodingExtension(join(root, "notes.md"))] });
			const threads = new Threads({ harness: runtime.harness, registry });
			try {
				await threads.create({ threadId: "a", projectId: "alpha" });
				await (await runtime.harness.conversation((await threads.thread("a"))!.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
				await threads.submit({ threadId: "a", conversationId: (await threads.thread("a"))!.head, requestId: "r1", message: "x" }, undefined);
				await idle(runtime.harness, (await threads.thread("a"))!.head);

				await threads.create({ threadId: "b", projectId: "beta" });
				await (await runtime.harness.conversation((await threads.thread("b"))!.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
				await threads.submit({ threadId: "b", conversationId: (await threads.thread("b"))!.head, requestId: "r2", message: "y" }, undefined);
				await idle(runtime.harness, (await threads.thread("b"))!.head);

				const alpha = rec.texts[0]!;
				const beta = rec.texts[1]!;
				// Each carries its own project cwd and the shared instructions; neither carries the other's cwd.
				expect(alpha).toContain(join(root, "projects/alpha"));
				expect(alpha).not.toContain(join(root, "projects/beta"));
				expect(beta).toContain(join(root, "projects/beta"));
				expect(beta).not.toContain(join(root, "projects/alpha"));
				// Both carry the instructions text and a base-prompt orientation.
				expect(alpha).toContain(marker);
				expect(beta).toContain(marker);
				expect(alpha).toMatch(/coding agent/i);
				expect(alpha).not.toMatch(/Tools:/); // tools describe themselves as tool definitions
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("no instructions file → base prompt only, no instructions section", async () => {
		const root = await tempRoot();
		try {
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const registry = testRegistry([{ id: "alpha", cwd: join(root, "projects/alpha") }]);
			const runtime = await openCodingHarness({ dataDir: root }, registry, model.models, { extensions: [CodingExtension()] });
			const threads = new Threads({ harness: runtime.harness, registry });
			try {
				await threads.create({ threadId: "a", projectId: "alpha" });
				await (await runtime.harness.conversation((await threads.thread("a"))!.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
				await threads.submit({ threadId: "a", conversationId: (await threads.thread("a"))!.head, requestId: "r1", message: "x" }, undefined);
				await idle(runtime.harness, (await threads.thread("a"))!.head);

				expect(rec.texts[0]).toContain(join(root, "projects/alpha"));
				expect(rec.texts[0]).toMatch(/coding agent/i);
				// No `instructions` section is rendered when no file is configured.
				const sections = rec.structured[0]!.flatMap((m) => Object.keys(m.sections ?? {}));
				expect(sections).not.toContain("repo-instructions");
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("a fork/undo copy carries the same prompt extension (instructions included)", async () => {
		const root = await tempRoot();
		try {
			const marker = "FORK-Keeper rules";
			await writeFile(join(root, "notes.md"), marker);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const registry = testRegistry([{ id: "alpha", cwd: join(root, "p") }]);
			const runtime = await openCodingHarness({ dataDir: root }, registry, model.models, { extensions: [CodingExtension(join(root, "notes.md"))] });
			const threads = new Threads({ harness: runtime.harness, registry });
			try {
				const t = await threads.create({ threadId: "a", projectId: "alpha" });
				await (await runtime.harness.conversation(t.head as ConversationId, BACKGROUND_CONTEXT))?.configure({ model: model.modelRef }, BACKGROUND_CONTEXT);
				await threads.submit({ threadId: "a", conversationId: t.head, requestId: "r1", message: "hello" }, undefined);
				await idle(runtime.harness, t.head);
				await threads.submit({ threadId: "a", conversationId: t.head, requestId: "r1b", message: "again" }, undefined);
				await idle(runtime.harness, t.head);
				// Prompt-cache stable: the system messages of one conversation never change between requests.
				expect(rec.structured[0], "two requests of one conversation carry identical system messages").toEqual(rec.structured[1]);

				const entryId = await firstUserEntry(runtime.harness, t.head);
				const forked = await threads.rewind({ threadId: "a", expectedHead: t.head, entryId, requestId: "u1" });

				const head = (await threads.thread("a"))!;
				expect(head.head).toBe(forked); // the thread moved to the copy
				await threads.submit({ threadId: "a", conversationId: forked, requestId: "r2", message: "again" }, undefined);
				await idle(runtime.harness, forked);

				expect(rec.texts.at(-1)).toContain(marker); // the fork/undo copy renders the same instructions section
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("instructions file path (config)", () => {
	it("resolves relative to the root, keeps absolute, expands ~ (no read at parse); a missing file is a ConfigError at start", async () => {
		const base = "/srv/root";
		expect(parseConfigToml(`instructions = "docs/instructions.md"\n`, base).instructionsPath).toBe(join(base, "docs/instructions.md"));
		expect(parseConfigToml(`instructions = "/etc/rules.md"\n`, base).instructionsPath).toBe("/etc/rules.md");
		expect(parseConfigToml(`instructions = "~/rules.md"\n`, base).instructionsPath).toBe(join(homedir(), "rules.md"));
		expect(parseConfigToml(``, base).instructionsPath).toBeUndefined();
		const root = await tempRoot();
		try {
			await writeFile(join(root, "config.toml"), `instructions = "nope.md"\n`);
			await expect(loadConfig(join(root, "config.toml"), root)).rejects.toThrow(/instructions file .* is not readable/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
