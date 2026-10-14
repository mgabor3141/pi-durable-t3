// store M4 (MEDIUM): a refusal is not a receipt. The bridge stored the FIRST attempt's outcome for refusals as well as
// successes, so a refusal whose CAUSE was the filesystem at that instant (a parent that is a file, a path a peer holds)
// became permanent for the client's command id: the operator fixes the filesystem, the client retries the SAME commandId
// (obeying the contract's dedup rule), and the old refusal is replayed — only a FRESH command id gets through. That is
// the exact case the receipt store was written for (the lost response + retry).
//
// T3's ProjectService (`apps/server/src/project/ProjectService.ts`) replays a reused command id against its receipt:
// an ACCEPTED receipt returns idempotently (lines 278-280) — that is the idempotency we KEEP — and a REJECTED receipt
// is committed (`commitRejectedProjectCommand`, lines 245-252) and replayed on retry (lines 281-294). The rule here is
// the M4 fix: ONLY a successful result is kept as a receipt; a refusal records nothing durable, so a retry re-plans
// against the current state. A success for a commandId reused by a DIFFERENT command is still T3's "was already used by".
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-m4-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-m4-0123456789abcd";
type Project = { id: string; title: string; workspaceRoot: string; deletedAt?: string | null };

async function start(name: string, port: number) {
	const root = join(scratch, name);
	await mkdir(join(root, "projects"), { recursive: true });
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(join(root, "settings.json"), JSON.stringify({ projects: [], defaults: {} }), "utf8");
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	if (!(await waitListening(port))) throw new Error(`host did not bind ${port}: ${host.out()}`);
	const ws = await connectWs(port, await pair(port, TOKEN));
	return { root, host, ws };
}

it("a create refused by a transient filesystem cause is NOT replayed — the SAME commandId re-plans once the cause is gone (M4)", async () => {
	const { host, ws, root } = await start("transient", 4978);
	try {
		// The parent `<root>/mid` is a FILE, so `<root>/mid/new` cannot be created → the create is refused.
		const mid = join(root, "mid");
		await writeFile(mid, "i am a file, not a folder", "utf8");
		const mutate = { type: "project.create", projectId: "44444444-1111-2222-3333-999999999999", title: "Transient", workspaceRoot: join(mid, "new"), createWorkspaceRootIfMissing: true };
		const first = exitError(await ws.call("projects.mutate", { ...mutate, commandId: "m4-transient-1" }), "create over a file parent");
		expect([first._tag, first.message]).toEqual(["ProjectMutationError", expect.stringMatching(/Failed to create workspace root/i)]);
		// The operator fixes the filesystem: the file becomes the folder the create asked to make.
		await rm(mid, { recursive: true, force: true });
		await mkdir(join(mid, "new"), { recursive: true });
		// Pre-fix (a refusal is a receipt): the SAME commandId replays the "Failed to create workspace root" refusal.
		// The M4 rule: the refusal recorded nothing durable, so the retry re-plans and now SUCCEEDS.
		const retry = exitValue(await ws.call("projects.mutate", { ...mutate, commandId: "m4-transient-1" }), "retry the same commandId after the fix") as Project;
		expect(retry.id).toBe(mutate.projectId);
		expect(retry.title).toBe("Transient");
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a create refused as a path CONFLICT is NOT replayed — once the path frees up, the SAME commandId re-plans (M4)", async () => {
	const { host, ws, root } = await start("freed", 4979);
	try {
		const target = join(root, "projects", "shared");
		// idA takes the path.
		const a = exitValue(await ws.call("projects.mutate", { type: "project.create", projectId: "aaaa1111-0000-0000-0000-000000000000", title: "A", workspaceRoot: target, createWorkspaceRootIfMissing: true, commandId: "m4-a-create" }), "create A") as Project;
		expect(a.id).toBe("aaaa1111-0000-0000-0000-000000000000");
		// idB for the SAME path, its own commandId → refused (a conflict). The refusal records nothing.
		const b = { type: "project.create", projectId: "bbbb2222-0000-0000-0000-000000000000", title: "B", workspaceRoot: target, createWorkspaceRootIfMissing: true };
		const conflict = exitError(await ws.call("projects.mutate", { ...b, commandId: "m4-b-conflict" }), "create B on a taken path");
		expect(conflict.message).toMatch(/already belongs to project/);
		// The path frees up: A is deleted (a distinct commandId, so its success receipt does not cover B's id).
		const removed = exitValue(await ws.call("projects.mutate", { type: "project.delete", projectId: a.id, force: true, commandId: "m4-a-delete" }), "delete A") as Project;
		expect(removed.deletedAt).toEqual(expect.any(String));
		// Pre-fix: the SAME commandId (m4-b-conflict) replays "already belongs". M4: it re-plans and SUCCEEDS.
		const freed = exitValue(await ws.call("projects.mutate", { ...b, commandId: "m4-b-conflict" }), "retry B after the path freed") as Project;
		expect(freed.id).toBe("bbbb2222-0000-0000-0000-000000000000");
		expect(freed.title).toBe("B");
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);

it("a SUCCESS is still a receipt: a retried create replays, and its commandId reused for a different command is 'was already used by' (regression)", async () => {
	const { host, ws, root } = await start("success", 4980);
	try {
		const target = join(root, "projects", "kept");
		const mutate = { type: "project.create", projectId: "cccc3333-0000-0000-0000-000000000000", title: "Kept", workspaceRoot: target, createWorkspaceRootIfMissing: true };
		const first = exitValue(await ws.call("projects.mutate", { ...mutate, commandId: "m4-kept-1" }), "create") as Project;
		expect(first.id).toBe(mutate.projectId);
		// A lost response, the SAME commandId returns the SAME project (no re-plan, no conflict).
		const replay = exitValue(await ws.call("projects.mutate", { ...mutate, commandId: "m4-kept-1" }), "replay the success") as Project;
		expect(replay).toEqual(first);
		// A SUCCEEDED commandId reused for a DIFFERENT command is T3's "was already used by" (kept receipts carry the guard).
		const reused = exitError(await ws.call("projects.mutate", { type: "project.delete", projectId: mutate.projectId, force: true, commandId: "m4-kept-1" }), "reuse the success id for a delete");
		expect(reused.message).toMatch(/was already used by/);
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
		await host.exited;
	}
}, 60_000);
