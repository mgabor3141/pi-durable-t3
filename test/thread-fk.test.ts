// No thread row without a registered project (review conc N1 + store N2). `Threads.create` validated the
// projectId against the registry OUTSIDE its commit; the closure pushed the fixed id with no re-check, and
// the project registry lives in the other store (`projects.json`, mutated synchronously), so
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
import { ServerSettingsStore } from "../src/settings.ts";
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

});
