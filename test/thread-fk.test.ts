// No thread row without a registered project (review conc N1 + store N2). `Threads.create` validated the
// projectId against the registry OUTSIDE its commit; the closure pushed the fixed id with no re-check, and
// the project registry lives in the other store (`settings.json`, mutated synchronously), so
// `thread.create ∥ project.delete` lands a thread row whose `projectId` exists nowhere — fully operable
// (prompts run, projections serve), durable across a restart, and with no project to group it under.
// The invariant is enforced where rows are written: at COMMIT time, the project must exist in the
// registry, else the commit is refused. Commits serialize on the one storage, so a closure that runs after
// `registry.remove` has landed sees the removal. The delete side closes the complementary interleaving:
// the cascade's target list is a snapshot taken before the entry is removed, so after `registry.remove`
// the delete sweeps by foreign key (the registry is gone, so the commit-time check means no new row can
// land under it). On the serve side, a row with an unknown `projectId` must never be published as a
// project — the shell lists registered projects and nothing else (closed by the identity cluster; pinned
// here as a regression guard).
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { HostError } from "../src/host-errors.ts";
import { createServerFacet } from "../src/objects.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a thread row is written only for a registered project", () => {
	it("(a) a create whose commit lands after the project is removed is refused (conc N1)", async () => {
		const f = await makeThreads({ projects: [{ id: "p" }] });
		// The race, made one tick wide: the create is in flight (its pre-commit check passed) when the
		// project registration is dropped. Pre-fix the closure pushed the stale id and the row landed.
		const creating = f.threads.create({ threadId: "late", projectId: "p" });
		f.registry.remove("p");
		const failure = await creating.then(() => undefined, (error: unknown) => error as Error);
		expect(failure, "the create is refused once its project is gone").toBeInstanceOf(HostError);
		expect((failure as HostError).code).toBe("unknown_project");

		// Nothing durable survives: no row, no FK to a project that exists nowhere.
		const rows = await f.threads.list();
		expect(rows.filter((row) => row.projectId === "p"), `no row under the removed project: ${JSON.stringify(rows)}`).toHaveLength(0);

		// A create for a project that IS registered still works (the check refuses, it does not disable).
		f.registry.add("p", join(f.root, "p"));
		const t = await f.threads.create({ threadId: "ok", projectId: "p" });
		expect(t.projectId).toBe("p");
	}, 30_000);

	it("(b) project.delete racing thread.create leaves no row with an unregistered projectId (store N2)", async () => {
		const f = await makeThreads({ projects: [] });
		const host = createHost({ name: "server" });
		await host.load([createServerFacet(f.threads, f.model.models)]);
		await host.ready();
		const bridge = new Bridge(
			{ host: "127.0.0.1", port: 0, label: "t", stateDir: join(f.root, "state"), pairingToken: undefined, tokenTtlSeconds: 60, corsOrigins: [], registry: f.registry },
			log,
			host,
		);
		bridge.start();
		try {
			// 20 rounds of the dialog's race: create a project, then in the same tick launch a thread in
			// it and delete the project with force. Both answers are success; the promise is that the
			// project's threads go with it — a row surviving under the removed id is the dangling FK.
			for (let round = 1; round <= 20; round++) {
				const id = `p-r${round}`;
				f.registry.add(id, join(f.root, id));
				const launching = bridge.createThread({ threadId: `thr-r${round}`, projectId: id });
				const deleting = bridge.mutateProject({ type: "project.delete", projectId: id, commandId: `cmd-del-r${round}`, force: true });
				const launchResult = await launching.then(() => "ok", (error: unknown) => (error as Error).message);
				const deleteResult = await deleting.then(() => "ok", (error: unknown) => (error as Error).message);
				await sleep(25); // let any late promote/commit land
				const rows = (await f.threads.list()).filter((row) => row.projectId === id);
				expect(rows, `round ${round}: launch=${launchResult} delete=${deleteResult} left rows ${JSON.stringify(rows)}`).toHaveLength(0);
			}
		} finally {
			await bridge.close();
			await host.close();
		}
	}, 120_000);

	it("(c) a row with an unknown projectId is served with its FK and never as a project (conc N1, boot shape)", async () => {
		// The doc-only shape a crash between the cascade steps can leave: a thread row whose project is
		// gone. The shell must not invent a project for the id — it lists registered projects and nothing
		// else, and the thread keeps its FK (a lost registry costs names, not work).
		const f = await makeThreads({ projects: [{ id: "ghost" }] });
		const host = createHost({ name: "server" });
		await host.load([createServerFacet(f.threads, f.model.models)]);
		await host.ready();
		const bridge = new Bridge(
			{ host: "127.0.0.1", port: 0, label: "t", stateDir: join(f.root, "state"), pairingToken: undefined, tokenTtlSeconds: 60, corsOrigins: [], registry: f.registry },
			log,
			host,
		);
		bridge.start();
		try {
			await bridge.createThread({ threadId: "orphan", projectId: "ghost" });
			// Drop the registration WITHOUT the cascade (the hand-edited / crashed shape).
			f.registry.remove("ghost");
			const snapshot = bridge.shellSnapshot();
			const projects = snapshot.projects as unknown as { id: string }[];
			expect(projects.map((project) => project.id), `no project for the dangling FK: ${JSON.stringify(projects)}`).not.toContain("ghost");
			expect(projects, "the shell invents no project at all").toHaveLength(0);
			const threads = snapshot.threads as unknown as { id: string; projectId: string }[];
			expect(threads.find((thread) => thread.id === "orphan")?.projectId, "the thread keeps the id its row carries").toBe("ghost");
		} finally {
			await bridge.close();
			await host.close();
		}
	}, 30_000);
});
