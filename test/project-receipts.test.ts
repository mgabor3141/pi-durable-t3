// A project mutation replays its receipt (review M4/M5, store + conc F5). `projects.mutate` had no command-id dedup,
// so the retry T3 sends after a lost response came back as a user-facing conflict: "Workspace … already belongs to
// project …" for a create, "Project … was not found" for a delete.
//
// T3's own server replays the receipt for a reused command id (`ProjectService.commit`): the first receipt — not the
// new plan — decides the outcome, so an accepted create returns the project it produced, a rejected create replays
// the same rejection, and a delete of a project that is already gone is IDEMPOTENT (the receipt), never "not found".
// A command id reused for a DIFFERENT command is T3's "was already used by" error.
//
// Probes: create with a commandId, drop the response, resend the same commandId → the same project, no conflict; a
// rename (title only) → a `project.updated` shell item arrives; delete + retry → the same deleted-project receipt.
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-receipts-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-receipts-0123456789";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Project = { id: string; title: string; workspaceRoot: string; deletedAt: string | null };
type ShellItem = { kind: string; projectId?: string; project?: { id: string; title: string } };

async function start(name: string, port: number) {
	const root = join(scratch, name);
	await mkdir(join(root, "projects/alpha"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [], defaults: {} }), "utf8");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind ${port}: ${host.out()}`);
	const ws = await connectWs(port, await pair(port, TOKEN));
	return { root, host, ws };
}

const shellItems = (chunks: Frame[]): ShellItem[] => chunks.flatMap((frame) => (frame.values ?? []) as ShellItem[]);

it("a retried project.create returns the receipt it produced — the same project, no conflict (M4)", async () => {
	const { host, ws } = await start("create", 4934);
	try {
		const target = join(scratch, "create", "projects", "added");
		const mutate = { type: "project.create", projectId: "11111111-2222-3333-4444-555555555555", title: "Added", workspaceRoot: target, createWorkspaceRootIfMissing: true };
		const first = exitValue(await ws.call("projects.mutate", { ...mutate, commandId: "cmd-create-1" }), "create #1") as Project;
		expect(first.title).toBe("Added");
		// The response was lost; the client resends the SAME commandId. Pre-fix: `already belongs to project`.
		const retry = await ws.call("projects.mutate", { ...mutate, commandId: "cmd-create-1" });
		const replayed = exitValue(retry, "create #2 (same commandId)") as Project;
		expect(replayed).toEqual(first);
		// The registry holds ONE entry for the path, under the id the client minted.
		const listed = exitValue(await ws.call("server.getConfig", {}), "getConfig") as unknown as { environment: unknown };
		expect(listed.environment).toBeDefined();
		const shell = exitValue(await ws.call("orchestration.getArchivedShellSnapshot", {}), "shell") as { projects: Project[] };
		const owned = shell.projects.filter((project) => project.workspaceRoot === target);
		expect(owned.length).toBe(1);
		expect(owned[0]!.id).toBe(mutate.projectId);
		// A DIFFERENT commandId for the same path is the real conflict, unchanged.
		const conflict = exitError(await ws.call("projects.mutate", { ...mutate, commandId: "cmd-create-2" }), "create with a new commandId");
		expect([conflict._tag, conflict.message]).toEqual(["ProjectMutationError", expect.stringMatching(/already belongs to project/)]);
		// A command id reused for a different command is T3's "was already used by" refusal.
		const reused = exitError(await ws.call("projects.mutate", { type: "project.delete", projectId: mutate.projectId, force: true, commandId: "cmd-create-1" }), "id reused for a delete");
		expect(reused.message).toMatch(/was already used by/);
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a retried project.delete is idempotent — the receipt, not `was not found` (M4, conc F5)", async () => {
	const { host, ws, root } = await start("delete", 4935);
	try {
		const target = join(root, "projects", "gone");
		const created = exitValue(await ws.call("projects.mutate", {
			type: "project.create",
			projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
			title: "Gone",
			workspaceRoot: target,
			createWorkspaceRootIfMissing: true,
			commandId: "cmd-del-create",
		}), "create") as Project;
		const mutateDelete = { type: "project.delete", projectId: created.id, force: true };
		const first = exitValue(await ws.call("projects.mutate", { ...mutateDelete, commandId: "cmd-del-1" }), "delete #1") as Project;
		expect(first.deletedAt, `the delete receipt carries deletedAt: ${JSON.stringify(first)}`).toEqual(expect.any(String));
		// The response was lost; the same commandId comes back. Pre-fix: "Project … was not found."
		const replay = await ws.call("projects.mutate", { ...mutateDelete, commandId: "cmd-del-1" });
		expect(exitValue(replay, "delete #2 (same commandId)") as Project).toEqual(first);
		// A NEW commandId for a project that is not registered stays the typed not-found (T3: any other id is refused).
		const unknown = exitError(await ws.call("projects.mutate", { ...mutateDelete, commandId: "cmd-del-2" }), "delete with a new commandId");
		expect(unknown.message).toMatch(/was not found/);
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a title-only project.update emits project.updated so the sidebar follows (M5)", async () => {
	const { host, ws, root } = await start("rename", 4936);
	try {
		const target = join(root, "projects", "named");
		const created = exitValue(await ws.call("projects.mutate", {
			type: "project.create",
			projectId: "cafe0000-0000-0000-0000-000000000001",
			title: "Before",
			workspaceRoot: target,
			createWorkspaceRootIfMissing: true,
			commandId: "cmd-rename-create",
		}), "create") as Project;
		const shellId = await ws.open("orchestration.subscribeShell", { requestCompletionMarker: true });
		await ws.call("server.probe", {}); // a barrier: the shell stream is subscribed before the rename
		const updated = exitValue(await ws.call("projects.mutate", {
			type: "project.update",
			projectId: created.id,
			title: "After",
			commandId: "cmd-rename-1",
		}), "rename") as Project;
		expect(updated.title).toBe("After");
		for (let i = 0; i < 60 && !shellItems(ws.chunks(shellId)).some((item) => item.kind === "project.updated"); i++) await sleep(50);
		const items = shellItems(ws.chunks(shellId));
		const renamed = items.filter((item) => item.kind === "project.updated");
		expect(renamed.length, `shell items after a rename: ${JSON.stringify(items.map((item) => item.kind))}`).toBeGreaterThan(0);
		expect(renamed.at(-1)!.project?.title).toBe("After");
		// The instance file holds the new title (the write and the notification are the same edit).
		const stored = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as { projects: { title?: string }[] };
		expect(stored.projects[0]?.title).toBe("After");
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);
