// A thread's priority on the wire: the reference host with pi's own OpenAI-compatible provider (models.json), against
// a server that records each request's body. The "Priority" option shows only on a model whose provider sets
// `compat.vllmPriority`; a thread's choice is the `priority` the request carries, Inherit sends models.json's value,
// and a model without the setting gets no field while the thread keeps its choice for when it is back.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { sleep } from "./wait.ts";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, seedProjects, t3Dir } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-priority-"));
const launched: Launched[] = [];
let server: Server | undefined;
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await new Promise((resolve) => (server === undefined ? resolve(undefined) : server.close(resolve)));
	await rm(scratch, { recursive: true, force: true });
});

const read = (request: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let body = "";
		request.on("data", (chunk: Buffer) => (body += chunk.toString()));
		request.on("end", () => resolve(body));
	});

/** A chat completions server that answers every request "ok" (streamed) and keeps the bodies it got. */
async function chatServer(): Promise<{ port: number; bodies: Record<string, unknown>[] }> {
	const bodies: Record<string, unknown>[] = [];
	server = createServer(async (request, response) => {
		bodies.push(JSON.parse(await read(request)) as Record<string, unknown>);
		response.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.end(`${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as { port: number }).port, bodies };
}

type ProviderModel = { slug: string; capabilities: { optionDescriptors?: { id: string; label: string; options?: { id: string; label: string }[] }[] } | null };

it("a thread's priority is the request's priority field, only for a provider with compat.vllmPriority", { timeout: 90_000 }, async () => {
	const chat = await chatServer();
	const agentDir = join(scratch, "agent");
	await mkdir(agentDir, { recursive: true });
	const provider = (compat: object) => ({ baseUrl: `http://127.0.0.1:${chat.port}/v1`, api: "openai-completions", apiKey: "test", compat, models: [{ id: "m" }] });
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { gateway: provider({ vllmPriority: 3 }), plain: provider({}) } }), "utf8");

	const port = 4962;
	const root = join(scratch, "host");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await seedProjects(root, [{ id: "p-alpha", title: "alpha", path: projectDir }]);
	const host = launch(root, port, { PI_DURABLE_T3_FAKE: "0", PI_OFFLINE: "1" }, agentDir);
	launched.push(host);
	expect(await waitListening(port), `the host booted: ${host.out()}`).toBe(true);

	const ws = await connectWs(port, await pair(port, pairCode(root)));
	const projection = async (threadId: string) => exitValue(await ws.call("orchestration.getThreadProjection", { threadId }), "getThreadProjection") as { thread: { modelSelection: { options?: unknown[] } }; runs: { status: string }[] };
	const completed = async (threadId: string, count: number) => {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && (await projection(threadId)).runs.filter((run) => run.status === "completed").length < count) await sleep(200);
		expect((await projection(threadId)).runs.filter((run) => run.status === "completed"), `${count} turns ran: ${host.out().slice(-2000)}`).toHaveLength(count);
	};
	/** The newest request that carried `text` (a title request carries it too, so the last one: the turn's). */
	const sent = (text: string) => chat.bodies.filter((body) => JSON.stringify(body.messages).includes(text)).at(-1);

	try {
		// The option, on the provider that takes it only.
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: ProviderModel[] }[] };
		const pi = providers.providers.find((entry) => entry.models.length > 0)!;
		const gateway = pi.models.find((model) => model.slug === "gateway/m")!;
		const plain = pi.models.find((model) => model.slug === "plain/m")!;
		expect(gateway.capabilities?.optionDescriptors?.find((option) => option.id === "priority")).toEqual({
			id: "priority",
			label: "Priority",
			type: "select",
			options: [
				{ id: "inherit", label: "Inherit", isDefault: true },
				{ id: "high", label: "High" },
				{ id: "normal", label: "Normal" },
				{ id: "low", label: "Low" },
			],
		});
		expect(plain.capabilities?.optionDescriptors?.find((option) => option.id === "priority")).toBeUndefined();

		// A thread launched at High: its request says -5, and the thread reports its choice.
		const threadId = "prio";
		exitValue(
			await ws.call("orchestration.launchThread", {
				commandId: "cmd-launch",
				threadId,
				projectId: "p-alpha",
				title: "Priority",
				modelSelection: { instanceId: pi.instanceId, model: gateway.slug, options: [{ id: "priority", value: "high" }] },
				runtimeMode: "full-access",
				interactionMode: "default",
				workspaceStrategy: { type: "root" },
				initialMessage: { messageId: "msg-1", text: "first", attachments: [] },
			}),
			"launchThread at High",
		);
		await completed(threadId, 1);
		expect(sent("first")?.priority).toBe(-5);
		expect((await projection(threadId)).thread.modelSelection.options).toContainEqual({ id: "priority", value: "high" });

		const message = async (text: string, model: string, options?: unknown[]) =>
			exitValue(
				await ws.call("orchestration.dispatchCommand", {
					commandId: `cmd-${text}`,
					type: "message.dispatch",
					createdBy: "user",
					creationSource: "web",
					threadId,
					messageId: `msg-${text}`,
					text,
					attachments: [],
					modelSelection: { instanceId: pi.instanceId, model, ...(options === undefined ? {} : { options }) },
					dispatchMode: { type: "start_immediately" },
				}),
				`message.dispatch ${text}`,
			);

		// On a model without the setting, no field; the thread keeps High, and back on the gateway it is sent again.
		await message("second", plain.slug);
		await completed(threadId, 2);
		expect(sent("second")).toBeDefined();
		expect(sent("second")).not.toHaveProperty("priority");
		// Reported only where the model offers the option, as T3's client keeps only a model's own options.
		expect((await projection(threadId)).thread.modelSelection.options ?? []).not.toContainEqual(expect.objectContaining({ id: "priority" }));
		await message("third", gateway.slug);
		await completed(threadId, 3);
		expect(sent("third")?.priority).toBe(-5);
		expect((await projection(threadId)).thread.modelSelection.options).toContainEqual({ id: "priority", value: "high" });

		// Low, then Inherit: models.json's value.
		await message("fourth", gateway.slug, [{ id: "priority", value: "low" }]);
		await completed(threadId, 4);
		expect(sent("fourth")?.priority).toBe(5);
		await message("fifth", gateway.slug, [{ id: "priority", value: "inherit" }]);
		await completed(threadId, 5);
		expect(sent("fifth")?.priority).toBe(3);
		expect((await projection(threadId)).thread.modelSelection.options ?? []).not.toContainEqual(expect.objectContaining({ id: "priority" }));
	} finally {
		ws.close();
	}
});
