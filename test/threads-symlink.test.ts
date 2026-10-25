// A project can be registered at a symlink. Environment-backed cwd checks must resolve the target before deciding
// whether it is a directory, the same way the file panel and project creation already do.
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Threads } from "../src/threads.ts";
import { makeThreads } from "./threads-harness.ts";
import { testRegistry } from "./test-registry.ts";

it("creates a thread in a project rooted at a symlink", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	const real = join(fixture.root, "real");
	const link = join(fixture.root, "link");
	await mkdir(real);
	await symlink(real, link);
	const threads = new Threads({ harness: fixture.harness, registry: testRegistry([{ id: "p", cwd: link }]), env: new NodeExecutionEnv({ cwd: "/" }) });
	await expect(threads.create({ threadId: "t", projectId: "p" })).resolves.toMatchObject({ threadId: "t", projectId: "p" });
});
