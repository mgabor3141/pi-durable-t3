// `orchestration.searchThreads` on the wire: launch a thread, send a prompt to completion, then search — the RPC answers
// T3's shape (`{ matches: [{ threadId, projectId, source, snippet, messageCreatedAt }] }`), matching the message text,
// a thread with no match absent, and the input validated by the contract (a 1-char query fails, an over-long one fails).
// Proves the wiring bridge → pi.threads.search → the threads layer, over the real `/ws` protocol.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const PORT = 4893;
let root: string;
let agentDir: string;
let host: Launched | undefined;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-search-"));
	agentDir = join(root, "agent");
	const projectDir = join(root, "projects", "alpha");
	await mkdir(projectDir, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: projectDir }] }), "utf8");
	host = launch(root, PORT, {}, agentDir);
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

type Match = { threadId: string; projectId: string; source: string; snippet: string; messageCreatedAt: string | null };
type Result = { matches: Match[] };

it("searches a thread's committed message text and answers T3's shape", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const token = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, token);
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((p) => p.models.length > 0)!;
		const modelSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug, options: [] };
		exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-search-launch", threadId: "t-search", projectId: "p-alpha", title: "Search",
			modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
		}), "launchThread");

		// A thread with no matching text, to prove a non-match is absent.
		exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-search-launch2", threadId: "t-nothing", projectId: "p-alpha", title: "Nothing",
			modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
		}), "launchThread 2");

		const command = {
			commandId: "cmd-search-msg", type: "message.dispatch", createdBy: "user", creationSource: "web",
			threadId: "t-search", messageId: "msg-search-1", text: "the quick pangolin", attachments: [],
			modelSelection, dispatchMode: { type: "start_immediately" },
		};
		exitValue(await ws.call("orchestration.dispatchCommand", command), "the prompt");

		const projection = async (): Promise<{ runs: { status: string }[] }> =>
			exitValue(await ws.call("orchestration.getThreadProjection", { threadId: "t-search" }), "projection") as { runs: { status: string }[] };
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !(await projection()).runs.some((run) => run.status === "completed")) await new Promise((r) => setTimeout(r, 200));

		const result = exitValue(await ws.call("orchestration.searchThreads", { query: "pangolin" }), "searchThreads") as Result;
		expect(result.matches, "exactly the thread whose text matches").toHaveLength(1);
		const [match] = result.matches;
		expect(match!.threadId).toBe("t-search");
		expect(match!.projectId).toBe("p-alpha");
		expect(match!.source).toBe("user");
		expect(match!.snippet).toContain("pangolin");
		expect(match!.messageCreatedAt, "an ISO timestamp").toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// A query nothing matches returns an empty list, not an error.
		expect((exitValue(await ws.call("orchestration.searchThreads", { query: "nonexistentterm" }), "searchThreads: empty") as Result).matches).toEqual([]);
	} finally {
		ws.close();
	}
}, 90_000);

it("the contract validates the query: too short is refused, a long limit is clamped", async () => {
	expect(await waitListening(PORT), host?.out().slice(-2000)).toBe(true);
	const token = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, token);
	try {
		const isRefused = async (payload: unknown): Promise<boolean> => {
			const frame = await ws.call("orchestration.searchThreads", payload);
			// A contract decode failure surfaces as a Defect or a typed Failure — either way, not a Success.
			return !(frame._tag === "Exit" && frame.exit?._tag === "Success");
		};
		// query min length is 2 (TrimmedString min 2): a 1-char query is refused, not a crash.
		expect(await isRefused({ query: "x" }), "a 1-char query is refused").toBe(true);
		// The limit must be 1..50; 51 and 0 are refused.
		expect(await isRefused({ query: "needle", limit: 51 }), "limit 51 refused").toBe(true);
		expect(await isRefused({ query: "needle", limit: 0 }), "limit 0 refused").toBe(true);
		// A well-formed query succeeds (empty matches is fine here).
		expect(exitValue(await ws.call("orchestration.searchThreads", { query: "needle", limit: 50 }), "a valid query succeeds"), "valid").toBeTruthy();
	} finally {
		ws.close();
	}
}, 60_000);
