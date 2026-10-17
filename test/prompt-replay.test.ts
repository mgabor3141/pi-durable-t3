// A RETRIED PROMPT runs exactly once. T3 retries a `message.dispatch` whose ack it never saw, and the dedup key is
// the command: `Bridge.sendMessage` passes the `commandId` as pi-durable's `requestId`, which keys the conversation's
// inbox, so the replay is absorbed and the turn runs once. A key derived per call (a timestamp, a random id) makes the
// retry a SECOND run — the user's text is in the transcript twice and the agent does the work twice, which is the
// failure a durable control plane may not have.
//
// Driven on the wire, on a real thread: one prompt to completion, the same command resent, then the projection is
// asked how many runs and how many user messages exist. Proven by breaking the key in `sendMessage`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const PORT = 4892;
let root: string;
let agentDir: string;
let host: Launched | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-replay-"));
	agentDir = join(root, "agent");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "reply with the single word ok\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: projectDir }] }), "utf8");
	host = launch(root, PORT, {}, agentDir);
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

type Projection = { runs: { status: string; userMessageId?: string }[]; messages: { role: string; content: unknown }[] };

it("the same command sent twice — across a reconnect — runs the turn once", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const token = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, token);
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((p) => p.models.length > 0);
		const modelSelection = { instanceId: provider!.instanceId, model: provider!.models[0]!.slug, options: [] };
		exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-replay-launch", threadId: "t-replay", projectId: "p-alpha", title: "Replay",
			modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
		}), "launchThread");

		let runs: Projection["runs"] = [];
		let messages: Projection["messages"] = [];
		const command = {
			commandId: "cmd-replay-dup", type: "message.dispatch", createdBy: "user", creationSource: "web",
			threadId: "t-replay", messageId: "msg-replay-1", text: "do the thing once", attachments: [],
			modelSelection, dispatchMode: { type: "start_immediately" },
		};
		const projection = async (): Promise<Projection> =>
			exitValue(await ws.call("orchestration.getThreadProjection", { threadId: "t-replay" }), "projection") as Projection;

		exitValue(await ws.call("orchestration.dispatchCommand", command), "the first send");
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await projection()).runs.some((run) => run.status === "completed")) await new Promise((r) => setTimeout(r, 200));
		expect((await projection()).runs.map((run) => run.status), "the turn ran").toContain("completed");

		// The retry, in the shape a drop produces: a NEW connection (the old socket's request ids are gone with it),
		// carrying the SAME command. The dedup key that survives a reconnect is the command's own identity — the
		// bridge sends it as pi-durable's `requestId`, which keys the conversation's inbox.
		ws.close();
		const again = await connectWs(PORT, token);
		try {
			exitValue(await again.call("orchestration.dispatchCommand", command), "the retry of the same command on a new connection");
			runs = (exitValue(await again.call("orchestration.getThreadProjection", { threadId: "t-replay" }), "projection") as Projection).runs;
			messages = (exitValue(await again.call("orchestration.getThreadProjection", { threadId: "t-replay" }), "projection") as Projection).messages;
		} finally {
			again.close();
		}

		expect(runs.length, `exactly one run for one command: ${JSON.stringify(runs.map((r) => [r.status, r.userMessageId]))}`).toBe(1);
		expect(messages.filter((message) => message.role === "user").length, "the user's text appears once in the transcript").toBe(1);
	} finally {
		ws.close();
		host?.child.kill("SIGKILL");
	}
}, 90_000);
