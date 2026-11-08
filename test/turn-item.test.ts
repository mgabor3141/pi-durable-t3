// T3's `orchestration.getTurnItem` (v0.1.7's lazy row detail): the shell and thread stream send a *wire* item, whose
// tool output is withheld (`outputOmitted: true`, as T3's `projectTurnItemForWire` withholds it). A row the user expands
// asks the server for the full item — and the web app showed "Couldn't load output: orchestration.getTurnItem is not
// supported" until this answered. The full item is bounded to 256 KiB, as T3 bounds an on-demand read.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { projectThreadProjectionForWire, projectTurnItemForDetail } from "../src/t3/t3-server.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };

it("getTurnItem gives the full item behind a row whose output the wire withheld", { timeout: 60_000 }, async () => {
	// A codemode-named tool, the row the report came from: its output is the long text a script returns.
	const codemode = defineExtension({
		name: "test-codemode",
		tools: [
			defineTool({
				name: "codemode",
				description: "run a script",
				parameters: Type.Object({ code: Type.String() }),
				execute: async () => ({ output: [{ type: "text" as const, text: "rows: 1, 2, 3" }] }),
			}),
		],
	} as never);
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [codemode] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-turn-item-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});

	f.model.respond(
		fauxAssistantMessage([fauxToolCall("codemode", { code: "return text(list)" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("read them"),
	);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "list", mode: "start" });
	await idle(f.harness, thread.head);
	const { projection } = await bridge.projection("t");
	const item = (projection.turnItems as unknown as { id: string; type: string; toolName?: string }[]).find((candidate) => candidate.type === "dynamic_tool" && candidate.toolName === "codemode")!;
	expect(item).toBeDefined();

	const wire = projectThreadProjectionForWire(projection).turnItems.find((candidate) => String(candidate.id) === item.id)!;
	expect(wire).toMatchObject({ type: "dynamic_tool", outputOmitted: true });

	// What the client does when the row is expanded: ask for the item by id.
	const full = await bridge.turnItem("t", item.id);
	expect(full, "the thread has the item").not.toBeNull();
	expect(full).toMatchObject({ id: item.id, type: "dynamic_tool", toolName: "codemode" });
	expect((full as { outputOmitted?: boolean }).outputOmitted).toBeUndefined();
	// Bounded for the wire, as T3 bounds an on-demand read.
	expect(projectTurnItemForDetail(full!)).toMatchObject({ id: item.id, type: "dynamic_tool" });

	// An item the thread does not have is null, not an error; an unknown thread is an error.
	expect(await bridge.turnItem("t", "ti-nope")).toBeNull();
	await expect(bridge.turnItem("nope", item.id)).rejects.toThrow(/Unknown thread/);
});
