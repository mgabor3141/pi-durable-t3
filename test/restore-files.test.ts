// A rewind that asks to restore files is refused with the honest answer. A T3 rewind here is a pure history overlay
// (the child thread forks the head; the parent's conversation keeps every entry), so there is no "run N's files"
// snapshot to restore to: the working tree pi-durable has IS the tree the next turn sees. `bridge.rollback` refuses
// `restoreFiles: true` and the refusal rides the projection as `rollbackFailure`, which is what the client renders —
// naming the operation and the option that DOES exist ("Revert and keep changes"), so the UI is not left on a
// spinner. Proven by breaking it: with the guard removed the rollback runs and the projection reports success.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const PORT = 4891;
const TOKEN = "restore-files-token";
let root: string;
let agentDir: string;
let host: Launched | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-restore-"));
	agentDir = join(root, "agent");
	const projectDir = join(root, "projects", "real");
	await mkdir(projectDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "reply with the single word ok\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p-real", title: "Real", path: projectDir }] }), "utf8");
	host = launch(root, PORT, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

it("a rewind with restoreFiles is refused on the projection, naming the option that exists", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const ws = await connectWs(PORT, await pair(PORT, TOKEN));
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((p) => p.models.length > 0);
		expect(provider, `the host's catalog has a model: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const modelSelection = { instanceId: provider!.instanceId, model: provider!.models[0]!.slug, options: [] };

		const launched = exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-restore", threadId: "t-restore", projectId: "p-real", title: "Restore",
			modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
		}), "launchThread") as { threadId: string };

		// One completed turn, so there is a checkpoint to revert to (checkpoints are `cp<userEntryId>`). Ask for the
		// FILES of that turn to come back.
		exitValue(await ws.call("orchestration.dispatchCommand", {
			commandId: "cmd-restore-prompt", type: "message.dispatch", createdBy: "user", creationSource: "web",
			threadId: launched.threadId, messageId: "msg-restore-1", text: "first", attachments: [],
			modelSelection, dispatchMode: { type: "start_immediately" }, serverResolvedCommandContext: true,
		}), "message.dispatch");
		const afterTurn = exitValue(await ws.call("orchestration.getThreadProjection", { threadId: launched.threadId }), "projection") as { runs: { status: string }[]; checkpoints: Record<string, string>[]; checkpointScopes: Record<string, string>[] };
		expect(afterTurn.runs.map((run) => run.status), "the turn ran and settled").toContain("completed");
		const last = afterTurn.checkpoints.at(-1)!;
		const checkpointId = last.id;
		const scopeId = last.scopeId ?? afterTurn.checkpointScopes[0]?.id;
		expect(scopeId, `a checkpoint scope to roll back within: ${JSON.stringify(afterTurn.checkpointScopes).slice(0, 200)}`).toBeDefined();

		const rollbackFrame: unknown = await ws.call("orchestration.dispatchCommand", {
			commandId: "cmd-restore-files", type: "checkpoint.rollback", threadId: launched.threadId,
			checkpointId, scopeId, restoreFiles: true,
		});
		expect(JSON.stringify(rollbackFrame as object).slice(0, 300), "the rollback command is accepted (its refusal lands on the projection)").not.toContain("Defect");

		// The refusal is what the client sees: the projection's `rollbackFailure`, naming the option that works.
		const projection = exitValue(await ws.call("orchestration.getThreadProjection", { threadId: launched.threadId }), "getThreadProjection") as { thread: { rollbackFailure?: { message: string } } };
		const message = projection.thread.rollbackFailure?.message;
		expect(message, `the rewind refusal reaches the projection: ${JSON.stringify(projection.thread).slice(0, 600)}`).toContain("does not restore files");
		expect(message).toContain("Revert and keep changes");
	} finally {
		ws.close();
		host?.child.kill("SIGKILL");
	}
}, 90_000);
