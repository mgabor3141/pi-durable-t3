// Shared test harness for the threads layer: an isolated temp env (never `~/.pi`), a Harness on sqlite storage with the
// scripted faux model, and helpers to await a turn and find a head's first user entry.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createRegistry, type ConversationId, type Conversation, type EnvTarget, Harness, UserEntry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Project } from "../src/config.ts";
import { Threads } from "../src/threads.ts";
import { createScriptedModel, type ScriptedModel } from "../src/testing/fake-model.ts";

const ctx = BACKGROUND_CONTEXT;

export type ThreadsFixture = {
	readonly threads: Threads;
	readonly harness: Harness;
	readonly model: ScriptedModel;
	readonly root: string;
	readonly projects: readonly Project[];
};

export async function makeThreads(
	options: {
		readonly projects: readonly { id: string; cwd?: string }[];
		readonly responses?: FauxResponseStep[];
		readonly tokensPerSecond?: number;
		readonly coding?: boolean;
	} = { projects: [{ id: "p" }] },
): Promise<ThreadsFixture> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-threads-"));
	if (dir.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
	const projects: Project[] = options.projects.map((project) => ({
		id: project.id,
		name: project.id,
		cwd: project.cwd ?? join(dir, project.id),
	}));
	for (const project of projects) await mkdir(project.cwd, { recursive: true });

	const model = createScriptedModel(options.responses ?? [], options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond });
	const registry = createRegistry();
	if (options.coding === true) registry.install(CodingTools);
	const storage = await openNodeSqliteStorage(join(dir, "durable.db"));
	const harness = await Harness.open(storage, {
		models: model.models,
		registry,
		...(options.coding === true ? { env: (target: EnvTarget) => new NodeExecutionEnv({ cwd: target.cwd ?? dir }) } : {}),
	}, ctx);
	onTestFinished(async () => {
		await harness.close(ctx).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	});
	const threads = new Threads({ harness, projects, defaultModel: model.modelRef });
	return { threads, harness, model, root: dir, projects };
}

export async function conversation(harness: Harness, id: number): Promise<Conversation> {
	const found = await harness.conversation(id as ConversationId, ctx);
	if (found === undefined) throw new Error(`no conversation ${id}`);
	return found;
}

/** Wait until the conversation's ownership scope has no live task. */
export async function idle(harness: Harness, id: number): Promise<void> {
	await (await conversation(harness, id)).waitForIdle(ctx);
}

/** The first user-turn entry id in a conversation's active context (the fork point an undo targets). */
export async function firstUserEntry(harness: Harness, id: number): Promise<number> {
	const entries = (await (await conversation(harness, id)).context(ctx)).entries;
	const user = entries.find((entry) => entry.kind === UserEntry.kind);
	if (user === undefined) throw new Error(`no user entry in conversation ${id}`);
	return user.id;
}

/** A model step that starts a run and holds it open until the test releases the returned gate. */
export function gated(text: string): { readonly step: FauxResponseStep; readonly release: () => void } {
	let release = (): void => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const step: FauxResponseStep = async () => {
		await gate;
		return fauxAssistantMessage(text);
	};
	return { step, release };
}

/** An errored assistant message: a run that fails via the model error path (`endRun` without draining the inbox). */
export function errored(message: string): FauxResponseStep {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage: message });
}

/**
 * Model steps that answer each user turn with a `bash` call writing the turn's text into `marker.txt` (executed in the
 * conversation's env cwd), then a final "done". Context-driven, so it is order-safe across concurrent conversations.
 */
export function markerSteps(count = 8): FauxResponseStep[] {
	const step: FauxResponseStep = async (context) => {
		const last = context.messages.at(-1) as { role: string; content: unknown } | undefined;
		if (last?.role === "user") {
			const content = last.content;
			const text = typeof content === "string" ? content : textOf(content) ?? "x";
			return fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${text} > marker.txt` })], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("done");
	};
	return Array.from({ length: count }, () => step);
}

function textOf(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const block = content.find((candidate) => (candidate as { type?: string }).type === "text") as { text?: string } | undefined;
	return block?.text;
}
