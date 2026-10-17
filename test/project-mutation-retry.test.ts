// A RETRIED project mutation gets the honest answer. `projects.mutate` carries a client-minted `commandId` and a
// client-minted `projectId`, and the create's commit is durable the moment the registry file lands. If the ack is lost
// (the socket dies a beat after the write), T3 resends the same command — and the registry, seeing the path taken,
// refuses a duplicate. A refusal is a LIE about a mutation that succeeded: the UI shows an error for a project that is
// already in its own sidebar, and a user who retries gets the same lie. `Bridge.#createProject` reads the state: an
// entry stored under the mutation's own minted id at the mutation's own path IS this command's first attempt, so the
// retry answers that project. The registry file is the dedup record, so this holds across a restart (a restart is the
// ack-loss shape a client cannot distinguish). A create that is NOT the replay — the same path under a different
// minted id — is a real conflict and stays refused.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const PORT_A = 4893;
const PORT_B = 4894;
const TOKEN = "project-mutate-token-0123456789";
let root: string;
let agentDir: string;
let hostA: Launched | undefined;
let hostB: Launched | undefined;
const projectDir = () => join(root, "work", "beta");

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-mutate-"));
	agentDir = join(root, "agent");
	await mkdir(join(root, "projects"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "reply with the single word ok\n", "utf8");
	// The registry starts with one project, so the shell is non-empty and the new one is distinguishable.
	await mkdir(join(root, "projects", "alpha"), { recursive: true });
	await writeFile(join(root, "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: join(root, "projects", "alpha") }] }), "utf8");
	// The two hosts take turns on ONE root (the restart shape): each binds its own port, so the config is rewritten
	// per launch.
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT_A}"\n`, "utf8");
}, 30_000);

afterAll(async () => {
	hostA?.child.kill("SIGKILL");
	hostB?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

type ProjectAnswer = { id: string; title: string; workspaceRoot: string; deletedAt: string | null };

const createMutation = (root2: string) => ({
	type: "project.create",
	commandId: "cmd-create-beta-once",
	projectId: "minted-beta-0001",
	title: "Beta",
	workspaceRoot: root2,
	createWorkspaceRootIfMissing: true,
});

it("a retried create answers the project it created — across a restart; a different mint at the same path is refused", async () => {
	// Host A, first attempt: the create lands and answers the project.
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT_A}"\n`, "utf8");
	hostA = launch(root, PORT_A, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	expect(await waitListening(PORT_A), hostA.out().slice(-2000)).toBe(true);
	const wsA = await connectWs(PORT_A, await pair(PORT_A, TOKEN));
	const firstFrame = await wsA.call("projects.mutate", createMutation(projectDir()));
	const first = exitValue(firstFrame, `the first create — frame: ${JSON.stringify(firstFrame).slice(0, 500)}`) as ProjectAnswer;
	expect(first.id, "the client's minted id is the project's id").toBe("minted-beta-0001");
	wsA.close();
	// The ack is lost: the connection dies with the write already in the registry file.
	hostA.child.kill("SIGKILL");
	await hostA.exited;

	// Host B: the same root, a new process, the same command resent.
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT_B}"\n`, "utf8");
	hostB = launch(root, PORT_B, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	expect(await waitListening(PORT_B), hostB.out().slice(-2000)).toBe(true);
	const wsB = await connectWs(PORT_B, await pair(PORT_B, TOKEN));
	try {
		const retry = exitValue(await wsB.call("projects.mutate", createMutation(projectDir())), "the retried create") as ProjectAnswer;
		// The project the first call created, named the same way: id, title, root. (Times are per-answer — `createdAt`
		// is the host's boot time, `updatedAt` the answer's — so identity is what a retry must repeat.)
		expect(
			{ id: retry.id, title: retry.title, workspaceRoot: retry.workspaceRoot, deletedAt: retry.deletedAt },
			`the retry answers the project the first create made: ${JSON.stringify(retry)}`,
		).toEqual({ id: first.id, title: first.title, workspaceRoot: first.workspaceRoot, deletedAt: first.deletedAt });

		// One entry, not two: the registry file is the state, and the retry must not have written a second one.
		const registryFile = JSON.parse(await readFile(join(root, "projects.json"), "utf8")) as { projects: { path: string }[] };
		expect(registryFile.projects.map((entry) => entry.path), "the retry stored nothing new").toEqual([
			join(root, "projects", "alpha"),
			projectDir(),
		]);

		// The boundary: the same PATH under a different minted id is a real conflict, not a replay.
		const conflict = exitError(
			await wsB.call("projects.mutate", { ...createMutation(projectDir()), projectId: "minted-beta-0002", commandId: "cmd-create-beta-two" }),
			"a second project at a path that is taken",
		);
		expect(String(conflict.message), `the real conflict is still refused: ${JSON.stringify(conflict)}`).toContain("already belongs");
	} finally {
		wsB.close();
		hostB?.child.kill("SIGKILL");
	}
}, 120_000);
