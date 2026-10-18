// Removing a project takes its threads with it, and never touches a file (review tests F2).
//
// design.md states the invariant — "Removing a project takes its threads with it … files on disk are never touched" —
// and `Bridge.mutateProject` implements it as a loop that deletes each of the project's threads before dropping the
// entry. The existing tests deleted a project with NO threads, so the loop was a no-op in every test: deleting the
// loop left the suite green and produced a host where the sidebar keeps threads pointed at a project that no longer
// resolves.
//
// This test drives the real path a client drives: create a thread in the project over `/ws`, watch the shell, then
// delete the project. The cascade has to answer on the shell (`thread.removed` per thread), the entry has to go, the
// non-empty project has to refuse an unforced delete, and the workspace's files and the durable store have to survive.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, getJson, pair, waitListening, type Frame } from "./ws-rpc.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";
import { createHost } from "@earendil-works/chord";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { makeThreads } from "./threads-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-cascade-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	const { rm } = await import("node:fs/promises");
	await rm(scratch, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shellItems = (chunks: Frame[]): ShellItem[] => chunks.flatMap((frame) => (frame.values ?? []) as ShellItem[]);

type ShellItem = { kind: string; threadId?: string; projectId?: string; thread?: { id?: string; title?: string } };

it("project.delete removes the project's threads, refuses an unforced delete, and leaves files alone (F2)", async () => {
	const port = 4939;
	const root = join(scratch, "host");
	const projectDir = join(root, "projects", "busy");
	const marker = join(projectDir, "keep-me.txt");
	await mkdir(projectDir, { recursive: true });
	await writeFile(marker, "the user's file\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "c0ffee00-1111-4111-8111-111111111111", title: "Busy", path: projectDir }] }), "utf8");
	const host = launch(root, port, {}, agentDir);
	launched.push(host);
	expect(await waitListening(port), `the host booted: ${host.out()}`).toBe(true);

	const bearer = await pair(port, pairCode(root));
	const ws = await connectWs(port, bearer);
	try {
		const projectId = "c0ffee00-1111-4111-8111-111111111111";
		const threadId = "cascade-thread-1";
		// Watch the shell BEFORE the thread exists, so its arrival and its removal are both observed, not inferred.
		const shellId = await ws.open("orchestration.subscribeShell", { requestCompletionMarker: true });
		await ws.call("server.probe", {}); // a barrier: the subscription is live

		// The command exactly as the web app sends it (the contract's `thread.create` fields, including the actor fields the
		// schema requires). The model comes from the host's own catalog, so the test does not hard-code the demo model's slug.
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((entry) => entry.models.length > 0);
		expect(provider, `the host's catalog has a model to select: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const first = { instanceId: provider!.instanceId, model: provider!.models[0]!.slug };
		const created = await ws.call("orchestration.dispatchCommand", {
			type: "thread.create",
			commandId: "cmd-thread-create",
			threadId,
			projectId,
			title: "Busy work",
			modelSelection: { instanceId: first.instanceId, model: first.model },
			runtimeMode: "full-access",
			interactionMode: "default",
			branch: null,
			worktreePath: null,
			createdBy: "user",
			creationSource: "web",
		});
		exitValue(created, "thread.create");
		for (let i = 0; i < 60 && !shellItems(ws.chunks(shellId)).some((item) => item.kind === "thread.updated"); i++) await sleep(50);
		expect(shellItems(ws.chunks(shellId)).map((item) => item.kind), "the thread appeared in the shell").toContain("thread.updated");

		// A non-empty project refuses an unforced delete (T3's dialog: removing a project says what it takes).
		const unforced = exitError(await ws.call("projects.mutate", { type: "project.delete", commandId: "cmd-delete-unforced", projectId, force: false }), "an unforced delete of a project with threads");
		expect(unforced._tag, JSON.stringify(unforced)).toBe("ProjectMutationError");
		expect(unforced.message, JSON.stringify(unforced)).toMatch(/not empty/);
		// The refusal changed nothing: the project is listed and the thread is still in the shell.
		const listed = await getJson(port, "/api/projects", { authorization: `Bearer ${bearer}` });
		expect((listed.body as { projects: { id: string }[] }).projects.map((project) => project.id)).toContain(projectId);

		// The forced delete: T3's dialog promises the threads go with it.
		const removed = exitValue(await ws.call("projects.mutate", { type: "project.delete", commandId: "cmd-delete-forced", projectId, force: true }), "the forced delete");
		expect(removed).toMatchObject({ id: projectId, deletedAt: expect.any(String) });

		for (let i = 0; i < 60 && !shellItems(ws.chunks(shellId)).some((item) => item.kind === "thread.removed"); i++) await sleep(50);
		const kinds = shellItems(ws.chunks(shellId)).map((item) => item.kind);
		expect(kinds, `the cascade published the thread's removal: ${JSON.stringify(kinds)}`).toContain("thread.removed");
		const gone = shellItems(ws.chunks(shellId)).filter((item) => item.kind === "thread.removed");
		expect(gone.at(-1)!.threadId, "the removed shell item names the cascaded thread").toBe(threadId);

		// The project is gone from the list the client renders.
		const after = await getJson(port, "/api/projects", { authorization: `Bearer ${bearer}` });
		expect((after.body as { projects: { id: string }[] }).projects.map((project) => project.id), "the project entry is gone").not.toContain(projectId);

		// Files on disk are never part of this operation: the workspace's own file, and the durable store that holds the
		// deleted thread's conversation, both survive.
		expect(await readFile(marker, "utf8"), "the project's files are untouched").toBe("the user's file\n");
		const store = join(root, "durable.db");
		const { statSync } = await import("node:fs");
		expect(statSync(store).size, `the durable store is untouched: ${store}`).toBeGreaterThan(0);

		// The thread is gone from the host, not just from the shell: its projection is a typed not-found.
		const projection = exitError(await ws.call("orchestration.getThreadProjection", { threadId }), "the projection of a cascaded thread");
		expect([projection._tag, JSON.stringify(projection)]).toEqual(["OrchestrationV2GetThreadProjectionError", expect.stringContaining(threadId)]);
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 120_000);

it("a project with no threads deletes without force (the guard is about threads, not about the entry)", async () => {
	const port = 4969;
	const root = join(scratch, "empty");
	const projectDir = join(root, "projects", "quiet");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "deadbeef-1111-4111-8111-111111111111", title: "Quiet", path: projectDir }] }), "utf8");
	const host = launch(root, port, {}, agentDir);
	launched.push(host);
	expect(await waitListening(port)).toBe(true);
	const bearer = await pair(port, pairCode(root));
	const ws = await connectWs(port, bearer);
	try {
		const projectId = "deadbeef-1111-4111-8111-111111111111";
		const removed = exitValue(await ws.call("projects.mutate", { type: "project.delete", commandId: "cmd-delete-empty", projectId }), "a delete of an empty project, no force");
		expect(removed).toMatchObject({ id: projectId, deletedAt: expect.any(String) });
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 90_000);

// The late-arrival window, closed by ONE sweep pass (the delete) + the commit-time FK check (the create). The
// cascade's target list is a snapshot taken before `registry.remove` lands; a create whose commit lands INSIDE that
// window is invisible to the snapshot. One pass after the removal drains what landed; anything landing after the
// removal is refused by the FK check (thread-fk.test.ts pins that half). This probe forces the window: an existing
// thread gives the delete loop an await, and a second create is raced into it.
it("a thread.create racing the forced delete leaves no row under the removed project (one-pass sweep + FK)", async () => {
	for (let round = 0; round < 10; round++) {
		const f = await makeThreads({ projects: [{ id: "racy" }] });
		const host = createHost({ name: "server" });
		await host.load([createServerFacet(f.threads, f.model.models)]);
		await host.ready();
		const bridge = new Bridge(
			{ host: "127.0.0.1", port: 0, label: "t", stateDir: f.root, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(f.root), corsOrigins: [], staticDir: undefined, registry: f.registry },
			{ info: () => {}, warn: () => {} },
			host,
		);
		bridge.start();
		const existing = await bridge.createThread({ projectId: "racy" });
		expect(existing, "the project has a thread to force-delete").toBeTruthy();

		// The race: the second create is in flight while the forced delete snapshots, deletes, and removes.
		const racing = bridge.createThread({ threadId: `late-${round}`, projectId: "racy" }).then(() => "landed", () => "refused");
		const removed = await bridge.mutateProject({ type: "project.delete", commandId: `cmd-race-${round}`, projectId: "racy", force: true });
		expect(removed).toMatchObject({ id: "racy" });
		const outcome = await racing;
		expect(["landed", "refused"], `the racing create answered one way or the other: ${outcome}`).toContain(outcome);

		// The invariant, in both outcomes: no row survives under a project that is gone.
		const rows = (await f.threads.list()).filter((thread) => thread.projectId === "racy");
		expect(rows.map((thread) => thread.threadId), `round ${round} (${outcome}): the cascade left no thread under the removed project`).toEqual([]);
		expect(f.registry.list().map((project) => project.id)).not.toContain("racy");
	}
}, 120_000);
