// Threads without a project ("No project"), answered the way T3's server answers them (design.md, replication rule).
// T3's client offers the entry only on an environment whose `server.getConfig` carries `scratchWorkspaceRoot`
// (`client-runtime/operations/projects.ts: availableScratchWorkspaceRoot`), and starts the thread by calling
// `projects.ensureScratch`, whose reply it waits for in its own store (`client-runtime/state/projectCommands.ts:
// openScratch`). Server side that is `ManagedProjectFolders.ensureScratchProject`: re-make `<baseDir>/scratch`, find
// or create the project rooted there, answer its id — and, for a thread launched there, `folderForThread` claims a
// folder of its own under that root. This test drives a real host over `/ws` and pins all of it, including the two
// properties the UI relies on: a retried ensure answers the SAME project, and a deleted folder comes back.
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { connectWs, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { makeThreads } from "./threads-harness.ts";
import { launch, type Launched, pairCode, t3Dir } from "./host-process-harness.ts";

const PORT = 4947;
const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-scratch-"));
const root = join(scratch, "host");
const agentDir = join(scratch, "agent");
const scratchRoot = join(root, "scratch");
let host: Launched | undefined;

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(scratch, { recursive: true, force: true });
}, 30_000);

const exists = async (path: string): Promise<boolean> => {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
};

it("the config advertises the Scratch root; ensureScratch finds-or-creates its project; a Scratch launch gets a folder of its own", async () => {
	await mkdir(join(root, "projects", "alpha"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "reply with the single word ok\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true }); // the bridge dir (the host creates it; the registry is the documented hand-edit)
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: join(root, "projects", "alpha") }] }), "utf8");
	host = launch(root, PORT, {}, agentDir);
	expect(await waitListening(PORT), host.out().slice(-2000)).toBe(true);

	const ws = await connectWs(PORT, await pair(PORT, pairCode(root)));
	try {
		// 1. The advertisement: T3's client reads the folder off the server config, and offers the entry only when it is there.
		const config = exitValue(await ws.call("server.getConfig", {}), "server.getConfig") as { scratchWorkspaceRoot?: string };
		expect(config.scratchWorkspaceRoot, "the host advertises its Scratch folder under the data dir").toBe(scratchRoot);

		// 2. `projects.ensureScratch`: the folder is made, and the project rooted at it is created and answered.
		const ensured = exitValue(await ws.call("projects.ensureScratch", {}), "projects.ensureScratch") as { projectId: string };
		expect(ensured.projectId, "the reply is the project's id (ProjectEnsureScratchResult)").toMatch(/^[0-9a-f-]{36}$/);
		expect(await exists(scratchRoot), "the Scratch folder exists after the ensure").toBe(true);
		const registry = JSON.parse(await readFile(join(t3Dir(root), "projects.json"), "utf8")) as { projects: { id?: string; title?: string; path: string }[] };
		const entry = registry.projects.find((project) => project.path === scratchRoot);
		expect(entry, `the project is registered at the Scratch root: ${JSON.stringify(registry.projects)}`).toBeDefined();
		expect(entry!.id).toBe(ensured.projectId);
		expect(entry!.title, "T3 titles it \"No project\"").toBe("No project");

		// 3. The shell carries it (the client's `openScratch` waits for the project in its own store) with T3's icon, set
		//    at create so the row shows the dashed bubble and not a letter monogram.
		const shellProject = (await waitForShellProject(ws, ensured.projectId)) as { title: string; workspaceRoot: string; projectIcon?: { kind: string; name: string; color: string } };
		expect(shellProject.title).toBe("No project");
		expect(shellProject.workspaceRoot).toBe(scratchRoot);
		expect(shellProject.projectIcon, "the Scratch project carries T3's icon").toEqual({ kind: "lucide", name: "message-square-dashed", color: "gray" });

		// 4. Idempotence, twice over: a retried ensure answers the SAME project and registers nothing new, and a deleted
		//    folder is re-made (T3's "Re-made on every call, so a deleted Scratch folder still runs threads").
		const again = exitValue(await ws.call("projects.ensureScratch", {}), "the retried ensureScratch") as { projectId: string };
		expect(again.projectId, "a retry answers the project the first ensure created").toBe(ensured.projectId);
		await rm(scratchRoot, { recursive: true, force: true });
		expect(await exists(scratchRoot)).toBe(false);
		const afterDelete = exitValue(await ws.call("projects.ensureScratch", {}), "the ensure after the folder was deleted") as { projectId: string };
		expect(afterDelete.projectId).toBe(ensured.projectId);
		expect(await exists(scratchRoot), "the folder is re-made on every call").toBe(true);
		const registryAfter = JSON.parse(await readFile(join(t3Dir(root), "projects.json"), "utf8")) as { projects: { path: string }[] };
		expect(registryAfter.projects.filter((project) => project.path === scratchRoot), "one Scratch project, not one per ensure").toHaveLength(1);

		// 5. A thread launched there runs in a folder of its own, claimed under the Scratch root (T3's `folderForThread`,
		//    named from the date, the first message's words, and the thread id).
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((entry) => entry.models.length > 0);
		expect(provider, `the host's catalog has a model: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const launchText = `scratch smoke ${Date.now()}`;
		const launched = exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-launch-scratch",
			threadId: "thread-scratch-1",
			projectId: ensured.projectId,
			title: "scratch smoke",
			modelSelection: { instanceId: provider!.instanceId, model: provider!.models[0]!.slug },
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
			initialMessage: { messageId: "msg-scratch-1", text: launchText, attachments: [] },
		}), "launchThread in the Scratch project") as { threadId: string; projection: { thread: { worktreePath: string | null } } };
		const worktree = launched.projection.thread.worktreePath;
		expect(worktree, "a Scratch thread is reported with the folder it claimed").toBeTruthy();
		expect(worktree!.startsWith(`${scratchRoot}/`), `the folder lives under the Scratch root: ${worktree}`).toBe(true);
		expect(await exists(worktree!), `the claimed folder exists on disk: ${worktree}`).toBe(true);
		expect(worktree!.slice(scratchRoot.length + 1), "named from the date, the message's words, and the thread id").toMatch(/^\d{4}-\d{2}-\d{2}-scratch-smoke-\d+-/);

		// 6. A thread in an ordinary project is unchanged: no folder, `worktreePath: null`.
		const inAlpha = exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-launch-alpha",
			threadId: "thread-alpha-1",
			projectId: "p-alpha",
			title: "alpha thread",
			modelSelection: { instanceId: provider!.instanceId, model: provider!.models[0]!.slug },
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
			initialMessage: { messageId: "msg-alpha-1", text: "alpha thread", attachments: [] },
		}), "launchThread in a registered project") as { projection: { thread: { worktreePath: string | null } } };
		expect(inAlpha.projection.thread.worktreePath, "an ordinary thread runs at its project's root").toBeNull();
	} finally {
		ws.close();
	}
}, 120_000);

/** Poll the shell stream for the snapshot item that carries this project. */
async function waitForShellProject(ws: Awaited<ReturnType<typeof connectWs>>, projectId: string): Promise<unknown> {
	const id = await ws.open("orchestration.subscribeShell", { requestCompletionMarker: true });
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		for (const chunk of ws.chunks(id)) {
			for (const value of (chunk.values ?? []) as Record<string, unknown>[]) {
				const items = (value as { snapshot?: { projects?: Record<string, unknown>[] } }).snapshot?.projects;
				const inSnapshot = items?.find((project) => project.id === projectId);
				if (inSnapshot !== undefined) return inSnapshot;
				const updated = value as { kind?: string; projectId?: string; project?: Record<string, unknown> };
				if (updated.kind === "project.updated" && updated.project?.id === projectId) return updated.project;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`the Scratch project ${projectId} never reached the shell stream`);
}

// The OFF switch (the integrator's): `attachT3` without a `scratchDir` — no root advertised, `projects.ensureScratch`
// refused with a message the UI shows. The example host always configures one; the bridge owns the switch.
it("no scratch dir: ensureScratch is refused, and the config carries no scratchWorkspaceRoot (the feature is off)", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	const host = createHost({ name: "server" });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: fixture.root, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(fixture.root), corsOrigins: [], registry: fixture.registry },
		{ info: () => {}, warn: () => {} },
		host,
	);
	bridge.start();
	try {
		expect(bridge.scratchRoot, "no root, nothing to advertise").toBeUndefined();
		const refusal = await Promise.resolve().then(() => bridge.ensureScratch()).then(() => undefined, (error: unknown) => error as Error);
		expect(refusal, "ensureScratch is refused").toBeInstanceOf(Error);
		expect((refusal as Error).message).toMatch(/no Scratch folder/i);
	} finally {
		await bridge.close();
		await host.close();
	}
});
