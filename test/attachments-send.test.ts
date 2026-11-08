// Sending attachments through the bridge: each upload is kept in the environment under a deterministic id, the model
// is told where ("Attachments:" and a path per line, hidden in T3's display), and an image also goes inline. The
// stored entry is what the model is sent, so this reads it back.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { AuthStore } from "../src/t3/auth.ts";
import { Attachments } from "../src/t3/attachments.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { conversation, createNamed, gated, idle, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const PDF = Buffer.from("%PDF-1.4\nnot really a PDF\n");

it("an image and a file: both kept in the environment and named by path; the image also inline", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const create = createNamed(f.threads, f.harness, f.model);
	const thread = await create({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-send-att-"));
	const home = join(scratch, "workspace", "attachments");
	const attachments = new Attachments({ stateDir: join(scratch, "state"), signer: new AuthStore(join(scratch, "state"), { tokenTtlSeconds: 60 }), env: new NodeExecutionEnv({ cwd: "/" }), dir: home, context: BACKGROUND_CONTEXT });
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models, attachments);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});

	const send = (type: "image" | "file", name: string, mimeType: string, bytes: Buffer) => {
		const minted = attachments.mintUpload({ type, name, mimeType, sizeBytes: bytes.byteLength });
		expect(attachments.storeUpload(minted.relativeUrl.slice("/api/attachments/upload/".length), bytes)).toEqual({ ok: true });
		return { type, id: minted.attachmentId, name, mimeType, sizeBytes: bytes.byteLength };
	};
	f.model.respond(fauxAssistantMessage("seen"));
	await bridge.sendMessage({
		threadId: "t",
		commandId: "c1",
		messageId: "m1",
		text: "look at these",
		mode: "start",
		attachments: [send("image", "shot.png", "image/png", PNG), send("file", "spec.pdf", "application/pdf", PDF)],
	});
	await idle(f.harness, thread.head);

	const entries = (await (await conversation(f.harness, thread.head)).context(BACKGROUND_CONTEXT)).entries;
	const user = entries.find((entry) => (entry.data as { messageId?: string } | undefined)?.messageId === "m1")!;
	const records = (user.data as { attachments: { type: string; id: string; name: string }[] }).attachments;
	expect(records.map((record) => record.id)).toEqual([expect.stringMatching(/^t-[0-9a-f-]{36}-png$/), expect.stringMatching(/^t-[0-9a-f-]{36}-pdf$/)]);
	const [image, file] = records;
	const imagePath = join(home, `${image!.id}.png`);
	const filePath = join(home, `${file!.id}.pdf`);
	expect((await readFile(imagePath)).equals(PNG)).toBe(true);
	expect((await readFile(filePath)).equals(PDF)).toBe(true);

	const content = user.model![0]!.content as { type: string; text?: string; data?: string; hidden?: boolean }[];
	const line = content.find((block) => block.type === "text" && block.hidden === true);
	expect(line?.text).toBe(`Attachments:\n- ${imagePath}\n- ${filePath}`);
	const inline = content.filter((block) => block.type === "image");
	// The faux model takes images, so the image also goes inline.
	expect(inline.map((block) => block.data)).toEqual([PNG.toString("base64")]);
});

it("a steer carries its attachments into the running turn (activeSteeringAcceptsAttachments)", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-steer-att-"));
	const home = join(scratch, "workspace", "attachments");
	const attachments = new Attachments({ stateDir: join(scratch, "state"), signer: new AuthStore(join(scratch, "state"), { tokenTtlSeconds: 60 }), env: new NodeExecutionEnv({ cwd: "/" }), dir: home, context: BACKGROUND_CONTEXT });
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models, attachments);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	const slow = gated("first");
	f.model.respond(slow.step, fauxAssistantMessage("saw it"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "start", mode: "start" });
	for (let i = 0; i < 200 && bridge.threadShell("t").status !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
	const minted = attachments.mintUpload({ type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: PNG.byteLength });
	expect(attachments.storeUpload(minted.relativeUrl.slice("/api/attachments/upload/".length), PNG)).toEqual({ ok: true });
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "look", mode: "steer", attachments: [{ type: "image", id: minted.attachmentId, name: "shot.png", mimeType: "image/png", sizeBytes: PNG.byteLength }] });
	slow.release();
	await idle(f.harness, thread.head);
	const entries = (await (await conversation(f.harness, thread.head)).context(BACKGROUND_CONTEXT)).entries;
	const steer = entries.find((entry) => (entry.data as { messageId?: string } | undefined)?.messageId === "m2")!;
	const content = steer.model![0]!.content as { type: string; data?: string }[];
	expect(content.filter((block) => block.type === "image").map((block) => block.data)).toEqual([PNG.toString("base64")]);
});
