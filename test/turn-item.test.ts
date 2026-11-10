// T3's `orchestration.getTurnItem` (v0.1.7's lazy row detail): the shell and thread stream send a *wire* item, whose
// tool output is withheld (`outputOmitted: true`, as T3's `projectTurnItemForWire` withholds it). A row the user expands
// asks the server for the full item — and the web app showed "Couldn't load output: orchestration.getTurnItem is not
// supported" until this answered. The full item is bounded to 256 KiB, as T3 bounds an on-demand read. A row whose tool
// returned images carries T3's image markers, and `tool-output-image` serves the bytes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { projectThreadProjectionForWire, projectTurnItemForDetail } from "../src/t3/t3-server.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";
import { str } from "@earendil-works/pi-schema";
import { object } from "../src/t3/schema.ts";
import { WorkspaceAssets } from "../src/t3/workspace-assets.ts";
import { toolOutputImages } from "@t3tools/shared/toolOutput";

const log: Logger = { info: () => {}, warn: () => {} };

it("getTurnItem gives the full item behind a row whose output the wire withheld", { timeout: 60_000 }, async () => {
	// A codemode-named tool, the row the report came from: its output is the long text a script returns.
	const codemode = defineExtension({
		name: "test-codemode",
		tools: [
			defineTool({
				name: "codemode",
				description: "run a script",
				parameters: object({ code: str() }),
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
		fauxAssistantMessage([fauxToolCall("codemode", { code: "// @options: {\"timeout_ms\": 1000}\n\nconst list = await tools.read({ path: \"rows\" });\nreturn text(list);" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("read them"),
	);
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "list", mode: "start" });
	await idle(f.harness, thread.head);
	const { projection } = await bridge.projection("t");
	const item = (projection.turnItems as unknown as { id: string; type: string; toolName?: string }[]).find((candidate) => candidate.type === "dynamic_tool" && candidate.toolName === "js")!;
	// A script is T3's JavaScript row: a code icon, the script's first line as the label, the code highlighted.
	expect(item).toMatchObject({ title: 'const list = await tools.read({ path: "rows" });', input: { code: expect.stringContaining("return text(list);") } });

	const wire = projectThreadProjectionForWire(projection).turnItems.find((candidate) => String(candidate.id) === item.id)!;
	expect(wire).toMatchObject({ type: "dynamic_tool", outputOmitted: true });

	// What the client does when the row is expanded: ask for the item by id.
	const full = await bridge.turnItem("t", item.id);
	expect(full, "the thread has the item").not.toBeNull();
	expect(full).toMatchObject({ id: item.id, type: "dynamic_tool", toolName: "js" });
	expect((full as { outputOmitted?: boolean }).outputOmitted).toBeUndefined();
	// Bounded for the wire, as T3 bounds an on-demand read.
	expect(projectTurnItemForDetail(full!)).toMatchObject({ id: item.id, type: "dynamic_tool" });

	// An item the thread does not have is null, not an error; an unknown thread is an error.
	expect(await bridge.turnItem("t", "ti-nope")).toBeNull();
	await expect(bridge.turnItem("nope", item.id)).rejects.toThrow(/Unknown thread/);
});

it("a tool row shows the images its result holds, and the asset route serves each as the model was given it", { timeout: 60_000 }, async () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
	const gif = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
	const codemode = defineExtension({
		name: "test-codemode",
		tools: [
			defineTool({
				name: "codemode",
				description: "run a script",
				parameters: object({ code: str() }),
				// Two images T3 previews, and an SVG it does not (T3 serves raster types only).
				execute: async () => ({
					output: [
						{ type: "text" as const, text: "two charts" },
						{ type: "image" as const, data: png, mimeType: "image/png" },
						{ type: "image" as const, data: "PHN2Zy8+", mimeType: "image/svg+xml" },
						{ type: "image" as const, data: gif, mimeType: "image/gif" },
					],
				}),
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
	f.model.respond(fauxAssistantMessage([fauxToolCall("codemode", { code: "image(chart)" }, { id: "call-img" })], { stopReason: "toolUse" }), fauxAssistantMessage("here"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "chart it", mode: "start" });
	await idle(f.harness, thread.head);

	// The row's output is T3's content blocks: the text, then a marker per image T3 shows. The data stays in the transcript.
	const full = (await bridge.turnItem("t", "ti-tcall-img")) as unknown as { output: unknown };
	expect(full.output).toEqual([
		{ type: "text", text: "two charts" },
		{ type: "image", mimeType: "image/png" },
		{ type: "image", mimeType: "image/gif" },
	]);
	// What the web app reads from the expanded row: the text, and two images by index.
	const detail = projectTurnItemForDetail(full as never) as unknown as { output: unknown };
	expect(toolOutputImages(detail.output)).toEqual([{ mimeType: "image/png" }, { mimeType: "image/gif" }]);

	// `assets.createUrl` signs a URL for each; the asset route resolves it to the image's bytes.
	const signer = { signPayload: (payload: string) => `sig-${payload.length}`, verifySignature: (payload: string, signature: string) => signature === `sig-${payload.length}` };
	const assets = new WorkspaceAssets({ env: {} as never, roots: () => [], signer: signer as never, toolImage: (threadId, itemId, index) => bridge.toolOutputImage(threadId, itemId, index) });
	const minted = await assets.issue({ _tag: "tool-output-image", threadId: "t", itemId: "ti-tcall-img", index: 1 } as never);
	const [, token, fileName] = /^\/api\/assets\/([^/]+)\/(.+)$/.exec(minted.relativeUrl)!;
	expect(fileName).toBe("image-2.gif");
	const served = await assets.resolve(token!, fileName!);
	expect(served?.mimeType).toBe("image/gif");
	expect(Buffer.from(served!.bytes).toString("base64")).toBe(gif);
	expect(await assets.resolve(`${token!.split(".")[0]}.forged`, fileName!)).toBeNull();
	// An image the row does not show, or a row with none, is T3's not-found.
	await expect(assets.issue({ _tag: "tool-output-image", threadId: "t", itemId: "ti-tcall-img", index: 2 } as never)).rejects.toMatchObject({ _tag: "AssetWorkspaceAssetNotFoundError" });
	await expect(assets.issue({ _tag: "tool-output-image", threadId: "nope", itemId: "ti-tcall-img", index: 0 } as never)).rejects.toMatchObject({ _tag: "AssetWorkspaceAssetNotFoundError" });
});

it("a script's headline is its first line that says something", async () => {
	const { scriptHeadline } = await import("../src/t3/projection.ts");
	expect(scriptHeadline("// @options: {}\n\n  // Compare the sizes\nconst a = 1;")).toBe("// Compare the sizes");
	expect(scriptHeadline("\n \n")).toBeNull();
	expect(scriptHeadline("x".repeat(500))).toHaveLength(200);
});
