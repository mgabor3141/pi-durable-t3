// Model SELECTION is T3's, and the thinking level rides with it (`modelSelection.options`, the `thinking` option
// T3's pi driver declares). One test, on the wire: the picker declares pi's ladder for a reasoning model, a level
// carried on a launch reaches the conversation and is reported back by the projection, `thread.model-selection.set`
// moves it, and a model the catalog does not have is refused BY NAME.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-selection-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-select-0123456789ab";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ProviderModel = { slug: string; capabilities: { optionDescriptors?: { id: string; type: string; options?: { id: string }[] }[] } | null };

it("the picker declares the model's thinking levels; a chosen level reaches the conversation and comes back; a model the catalog lacks is refused by name", async () => {
	const port = 4946;
	const root = join(scratch, "host");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: projectDir }] }), "utf8");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	expect(await waitListening(port), `the host booted: ${host.out()}`).toBe(true);

	const ws = await connectWs(port, await pair(port, TOKEN));
	const projection = async (threadId: string): Promise<Record<string, unknown>> =>
		exitValue(await ws.call("orchestration.getThreadProjection", { threadId }), "getThreadProjection") as Record<string, unknown>;
	const selectionOf = async (threadId: string): Promise<{ model: string; options?: { id: string; value: string }[] }> =>
		((await projection(threadId)).thread as { modelSelection: { model: string; options?: { id: string; value: string }[] } }).modelSelection;
	const settledRuns = async (threadId: string): Promise<string[]> => ((await projection(threadId)).runs as { status: string }[]).map((run) => run.status);

	try {
		// 1. The picker list: pi's own ladder for the levels this model supports.
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: ProviderModel[] }[] };
		const provider = providers.providers.find((entry) => entry.models.length > 0);
		expect(provider, `the host's catalog has a model: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const model = provider!.models[0]!;
		const descriptor = model.capabilities?.optionDescriptors?.find((option) => option.id === "thinking");
		expect(descriptor, `the reasoning model declares a thinking option: ${JSON.stringify(model).slice(0, 400)}`).toBeDefined();
		expect(descriptor!.type).toBe("select");
		expect(descriptor!.options!.map((choice) => choice.id)).toEqual(["off", "minimal", "low", "medium", "high"]);

		// 2. A launch that names a level: the level lands in the conversation, and the projection reports it back.
		const threadId = "sel-high";
		const launchFrame: Frame = await ws.call("orchestration.launchThread", {
			commandId: "cmd-sel-high",
			threadId,
			projectId: "p-alpha",
			title: "Thinking",
			modelSelection: { instanceId: provider!.instanceId, model: model.slug, options: [{ id: "thinking", value: "high" }] },
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
			initialMessage: { messageId: "msg-sel-high", text: "think about this", attachments: [] },
		});
		exitValue(launchFrame, "launchThread with a thinking level");
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await settledRuns(threadId)).includes("completed")) await sleep(250);
		expect(await settledRuns(threadId), "the turn ran at the chosen level").toContain("completed");
		const launchedSelection = await selectionOf(threadId);
		expect(launchedSelection.model, "the model the client named is the model the thread carries").toBe(model.slug);
		expect(launchedSelection.options, "the level the client named is the level the conversation carries").toEqual([{ id: "thinking", value: "high" }]);

		// 3. `thread.model-selection.set` moves the level on an existing thread.
		exitValue(
			await ws.call("orchestration.dispatchCommand", {
				commandId: "cmd-sel-low",
				type: "thread.model-selection.set",
				threadId,
				modelSelection: { instanceId: provider!.instanceId, model: model.slug, options: [{ id: "thinking", value: "low" }] },
			}),
			"thread.model-selection.set with a lower level",
		);
		const moved = await selectionOf(threadId);
		expect(moved.options, "the level the client set is the level the thread reports").toEqual([{ id: "thinking", value: "low" }]);

		// 4. Availability is the Harness's: a model the catalog does not have is refused by name, and the message is not run.
		const failure = exitError(
			await ws.call("orchestration.dispatchCommand", {
				commandId: "cmd-sel-ghost",
				type: "message.dispatch",
				createdBy: "user",
				creationSource: "web",
				threadId,
				messageId: "msg-sel-ghost",
				text: "a model that is not here",
				attachments: [],
				modelSelection: { instanceId: provider!.instanceId, model: "ghost/not-a-model" },
				dispatchMode: { type: "start_immediately" },
			}),
			"message.dispatch naming a model the catalog does not have",
		);
		expect(String(failure.message), "the refusal names the model").toContain("ghost/not-a-model");
		expect(await settledRuns(threadId), "the refused prompt did not run").toHaveLength(1);

		// 5. The client's choice is the thread's model — the bridge defaults to nothing. The catalog is the host's
		//    list IN ORDER, so the picker's default is its FIRST entry; select a NON-first model and the projection
		//    must report that one. A bridge that adopted its own default (the host's model, the first catalog entry,
		//    a remembered last choice) reports the catalog's FIRST slug here.
		const slugs = provider!.models.map((entry) => entry.slug);
		expect(slugs.length, `the host offers more than one model: ${JSON.stringify(slugs)}`).toBeGreaterThan(1);
		const second = provider!.models[1]!;
		const plainThread = "sel-second";
		exitValue(
			await ws.call("orchestration.launchThread", {
				commandId: "cmd-sel-second",
				threadId: plainThread,
				projectId: "p-alpha",
				title: "Second model",
				modelSelection: { instanceId: provider!.instanceId, model: second.slug, options: [] },
				runtimeMode: "full-access",
				interactionMode: "default",
				workspaceStrategy: { type: "root" },
			}),
			"launchThread naming the catalog's second model",
		);
		expect((await selectionOf(plainThread)).model, "the model the client named, not the catalog's first").toBe(second.slug);
		expect((await selectionOf(threadId)).model, "the first thread keeps the model it was given").toBe(model.slug);

		// 6. Availability is per model: the non-reasoning model declares no thinking control (pi-ai answers `["off"]`
		//    for it, and a control with one choice is not a choice).
		const plain = provider!.models.find((entry) => entry.slug === second.slug)!;
		expect(
			plain.capabilities?.optionDescriptors?.find((option) => option.id === "thinking"),
			`a model with no reasoning declares nothing: ${JSON.stringify(plain).slice(0, 300)}`,
		).toBeUndefined();
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
	}
}, 90_000);
