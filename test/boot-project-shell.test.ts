// store finding #5 (MEDIUM): a rename/move of a project that was in the file AT BOOT emitted no shell item, so a
// connected sidebar kept the old title/path. `#onRegistryChange` emits a change to an already-known project only when it
// can diff the new shell against the last SHOWN one (`shown !== undefined`), and `#shownProjects` was seeded only by an
// `#emitShell` of a create — so a project the boot read loaded had `shown === undefined` and the change was silent. The
// author's create-path probe created the project in-session (seeding the map), which is why it did not see the gap.
//
// The fix seeds `#shownProjects` at `start()` with the boot registry (the shell snapshot is the connect baseline; seeding
// is silent). This test uses a project loaded from the FILE, not one the session created — the shape the fix is for.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-shell5-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type ShellItem = { kind: string; projectId?: string; project?: { id: string; title: string; workspaceRoot?: string } };
const shellItems = (chunks: Frame[]): ShellItem[] => chunks.flatMap((frame) => (frame.values ?? []) as ShellItem[]);
type ShellSnapshot = { projects: { id: string; title: string }[] };
/** The stream's opening `snapshot` frame (the baseline), waiting for it to arrive. */
async function untilSnapshot(chunks: Frame[]): Promise<{ kind: string; snapshot: ShellSnapshot }> {
	for (let i = 0; i < 60; i++) {
		const frame = chunks.find((f) => (f.values as { kind?: string }[] | undefined)?.some((v) => v.kind === "snapshot"));
		const found = (frame?.values as { kind: string; snapshot: ShellSnapshot }[] | undefined)?.find((v) => v.kind === "snapshot");
		if (found !== undefined) return found;
		await sleep(50);
	}
	throw new Error(`no shell snapshot frame in ${JSON.stringify(chunks).slice(0, 400)}`);
}

it("a rename and a move of a BOOT-loaded project emit project.updated so a connected sidebar follows (store #5)", async () => {
	const port = 4984;
	const root = join(scratch, "host");
	const alpha = join(root, "projects", "alpha");
	const alpha2 = join(root, "projects", "alpha2");
	await mkdir(alpha, { recursive: true });
	await mkdir(alpha2, { recursive: true });
	// The project is in the FILE at boot (no session create → #shownProjects is unseeded by the old code).
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ path: alpha, title: "Alpha" }] }), "utf8");
	const host = launch(root, port, {}, agentDir);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind: ${host.out()}`);
	const ws = await connectWs(port, await pair(port, pairCode(root)));
	try {
		// The shell snapshot is the surface projects ride on, and the baseline a client renders at connect: the
		// boot-loaded project is in it, under a path-derived id. (Archived shells are a typed refusal — archive is
		// 🔜 in capabilities.md — so this reads the live stream, which is also the stream the edits must reach.)
		const shellId = await ws.open("orchestration.subscribeShell", { requestCompletionMarker: true });
		await ws.call("server.probe", {}); // barrier: the shell stream is subscribed before the rename
		const snapshot = (await untilSnapshot(ws.chunks(shellId))).snapshot;
		expect(snapshot.projects.map((p) => p.title), "the boot project is present").toEqual(["Alpha"]);
		const projectId = snapshot.projects[0]!.id;

		// Rename (title only) — the old code emitted nothing for a boot project.
		const renamed = exitValue(await ws.call("projects.mutate", { type: "project.update", projectId, title: "Renamed", commandId: "sh5-rename" }), "rename") as { title: string };
		expect(renamed.title).toBe("Renamed");
		for (let i = 0; i < 60 && !shellItems(ws.chunks(shellId)).some((item) => item.kind === "project.updated" && item.project?.title === "Renamed"); i++) await sleep(50);
		const renameItems = shellItems(ws.chunks(shellId)).filter((item) => item.kind === "project.updated");
		expect(renameItems.length, `rename shell items for a boot project: ${JSON.stringify(shellItems(ws.chunks(shellId)).map((i) => i.kind))}`).toBeGreaterThan(0);
		expect(renameItems.at(-1)!.project?.title).toBe("Renamed");

		// Move (workspaceRoot) — keeps the id, changes the path; the sidebar must follow.
		const moved = exitValue(await ws.call("projects.mutate", { type: "project.update", projectId, workspaceRoot: alpha2, commandId: "sh5-move" }), "move") as { id: string; workspaceRoot: string };
		expect(moved.id, "a move keeps the id").toBe(projectId);
		for (let i = 0; i < 60 && !shellItems(ws.chunks(shellId)).some((item) => item.kind === "project.updated" && item.project?.workspaceRoot === alpha2); i++) await sleep(50);
		const moveItems = shellItems(ws.chunks(shellId)).filter((item) => item.kind === "project.updated" && item.project?.workspaceRoot === alpha2);
		expect(moveItems.length, "a move of a boot project emits a shell item naming the new root").toBeGreaterThan(0);
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);
