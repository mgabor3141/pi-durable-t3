// The base system prompt (a pi-durable extension section installed by host-runtime) and the `instructions` file.
// Drives the real `openHostRuntime` path with the faux model and inspects the SYSTEM messages the model actually
// receives (via a response factory that captures `context.messages`). Temp roots only; never `~/.pi`.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { loadConfig, parseConfigToml } from "../src/config.ts";
import { openHostRuntime } from "../src/host-runtime.ts";
import { createScriptedModel } from "../src/testing/fake-model.ts";
import { firstUserEntry, idle } from "./threads-harness.ts";

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
			const config = parseConfigToml(`instructions = "notes.md"\n\n[[projects]]\nname = "alpha"\npath = "projects/alpha"\n\n[[projects]]\nname = "beta"\npath = "projects/beta"\n`, root);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const runtime = await openHostRuntime(config, model.models, model.modelRef);
			try {
				await runtime.threads.create({ threadId: "a", projectId: "alpha" });
				await runtime.threads.submit({ threadId: "a", conversationId: (await runtime.threads.thread("a"))!.head, requestId: "r1", message: "x" }, undefined);
				await idle(runtime.harness, (await runtime.threads.thread("a"))!.head);

				await runtime.threads.create({ threadId: "b", projectId: "beta" });
				await runtime.threads.submit({ threadId: "b", conversationId: (await runtime.threads.thread("b"))!.head, requestId: "r2", message: "y" }, undefined);
				await idle(runtime.harness, (await runtime.threads.thread("b"))!.head);

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

	it("no instructions key → base prompt only, no instructions section", async () => {
		const root = await tempRoot();
		try {
			const config = parseConfigToml(`[[projects]]\nname = "alpha"\npath = "projects/alpha"\n`, root);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const runtime = await openHostRuntime(config, model.models, model.modelRef);
			try {
				await runtime.threads.create({ threadId: "a", projectId: "alpha" });
				await runtime.threads.submit({ threadId: "a", conversationId: (await runtime.threads.thread("a"))!.head, requestId: "r1", message: "x" }, undefined);
				await idle(runtime.harness, (await runtime.threads.thread("a"))!.head);

				expect(rec.texts[0]).toContain(join(root, "projects/alpha"));
				expect(rec.texts[0]).toMatch(/coding agent/i);
				// No `instructions` section is rendered when none is configured.
				const sections = rec.structured[0]!.flatMap((m) => Object.keys(m.sections ?? {}));
				expect(sections).not.toContain("instructions");
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("the system prompt is identical across two requests of one conversation (prompt-cache stable)", async () => {
		const root = await tempRoot();
		try {
			await writeFile(join(root, "notes.md"), "stable rules");
			const config = parseConfigToml(`instructions = "notes.md"\n\n[[projects]]\nname = "alpha"\npath = "p"\n`, root);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const runtime = await openHostRuntime(config, model.models, model.modelRef);
			try {
				const t = await runtime.threads.create({ threadId: "a", projectId: "alpha" });
				await runtime.threads.submit({ threadId: "a", conversationId: t.head, requestId: "r1", message: "first" }, undefined);
				await idle(runtime.harness, t.head);
				await runtime.threads.submit({ threadId: "a", conversationId: t.head, requestId: "r2", message: "second" }, undefined);
				await idle(runtime.harness, t.head);

				expect(rec.structured.length).toBeGreaterThanOrEqual(2);
				expect(rec.structured[0]).toEqual(rec.structured[1]); // the same system entries, unchanged
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("a fork/undo copy inherits the conversation's instructions", async () => {
		const root = await tempRoot();
		try {
			const marker = "FORK-Keeper rules";
			await writeFile(join(root, "notes.md"), marker);
			const config = parseConfigToml(`instructions = "notes.md"\n\n[[projects]]\nname = "alpha"\npath = "p"\n`, root);
			const rec = recorder();
			const model = createScriptedModel(rec.responses);
			const runtime = await openHostRuntime(config, model.models, model.modelRef);
			try {
				const t = await runtime.threads.create({ threadId: "a", projectId: "alpha" });
				await runtime.threads.submit({ threadId: "a", conversationId: t.head, requestId: "r1", message: "hello" }, undefined);
				await idle(runtime.harness, t.head);

				const entryId = await firstUserEntry(runtime.harness, t.head);
				const forked = await runtime.threads.rewind({ threadId: "a", expectedHead: t.head, entryId, requestId: "u1" });

				const head = (await runtime.threads.thread("a"))!;
				expect(head.head).toBe(forked); // the thread moved to the copy
				await runtime.threads.submit({ threadId: "a", conversationId: forked, requestId: "r2", message: "again" }, undefined);
				await idle(runtime.harness, forked);

				expect(rec.texts.at(-1)).toContain(marker); // the copy still carries the instructions
			} finally {
				await runtime.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("instructions file path (config)", () => {
	it("missing instructions file is a ConfigError at start", async () => {
		const root = await tempRoot();
		try {
			await writeFile(join(root, "config.toml"), `instructions = "nope.md"\n\n[[projects]]\nname = "a"\npath = "a"\n`);
			await expect(loadConfig(join(root, "config.toml"), root)).rejects.toThrow(/instructions file .* is not readable/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("resolves relative to the root, keeps absolute, and expands ~ (no read at parse)", () => {
		const base = "/srv/root";
		expect(parseConfigToml(`instructions = "docs/instructions.md"\n`, base).instructionsPath).toBe(join(base, "docs/instructions.md"));
		expect(parseConfigToml(`instructions = "/etc/rules.md"\n`, base).instructionsPath).toBe("/etc/rules.md");
		expect(parseConfigToml(`instructions = "~"\n`, base).instructionsPath).toBe(homedir());
		expect(parseConfigToml(`instructions = "~/rules.md"\n`, base).instructionsPath).toBe(join(homedir(), "rules.md"));
		expect(parseConfigToml(``, base).instructionsPath).toBeUndefined();
	});
});
