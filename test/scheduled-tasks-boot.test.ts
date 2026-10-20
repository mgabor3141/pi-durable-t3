// A task bound to an existing thread that is due at boot (it came due while the host was off) used to fire before the
// bridge had loaded the thread list, fail with "Thread … was not found", and use up its run. The dispatch now waits for
// the directory's first load. This drives the real dispatch over a fresh host whose thread exists in storage.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createHost } from "@earendil-works/chord";
import { createServerFacet, HOST_PRINCIPAL } from "../src/objects.ts";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { scheduledTaskDispatch } from "../src/t3/scheduled-tasks.ts";
import { makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

it("a bound task dispatched right at boot finds its thread", async () => {
	const fixture = await makeThreads({ projects: [{ id: "p" }] });
	await fixture.threads.create({ threadId: "bound", projectId: "p" });
	// A slow first read of the thread list (a large or cold store): chord's `ready()` waits for the objects, not their loads.
	const list = fixture.threads.list.bind(fixture.threads);
	fixture.threads.list = async () => {
		await new Promise((resolve) => setTimeout(resolve, 300));
		return list();
	};
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-sched-boot-"));
	const host = createHost({ name: "server", self: HOST_PRINCIPAL });
	await host.load([createServerFacet(fixture.threads, fixture.model.models)]);
	await host.ready();
	const bridge = new Bridge(
		{ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: fixture.registry },
		log,
		host,
	);
	bridge.start();
	try {
		// The same moment facet.ts starts the scheduler: right after `bridge.start()`, before the list has loaded.
		await scheduledTaskDispatch(bridge).queue({ threadId: "bound", projectId: "p", commandId: "scheduled-task:t:1:scheduled", messageId: "scheduled-task-message:t:1:scheduled", text: "due at boot" });
		expect(bridge.threadProjectId("bound")).toBe("p");
	} finally {
		await bridge.close();
		await host.close();
		await rm(scratch, { recursive: true, force: true });
	}
}, 30_000);
