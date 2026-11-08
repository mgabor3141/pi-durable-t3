// Every image the model is sent must be one a provider can read. A truncated screenshot (a PNG copied while still being
// written) went into a codemode result as it was; the provider refused every request after it ("the image could not be
// read (image file is truncated)"), and the thread could not continue. The check (`image-check.ts`) reads only the
// bytes: complete PNG, JPEG, GIF or WebP, the declared type corrected. A broken image becomes a text saying why, in the
// tool result (the agent sees it in the same turn) and in each request (a transcript that holds one already).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import { Bridge } from "../src/t3/bridge.ts";
import type { Logger } from "../src/t3/logging.ts";
import { selectImageBlocks } from "../src/t3/bridge.ts";
import { checkImage, checkImageData, checkToolResult, imageCheckExtension } from "../src/t3/image-check.ts";
import { object } from "../src/t3/schema.ts";
import { createNamed, idle, makeThreads, restart } from "./threads-harness.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/images", name)));

/** A real PNG of noise (xorshift), which does not compress, so its size follows its dimensions. */
function png(width = 64, height = 48): Uint8Array {
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let state = 2463534242;
	for (let i = 0; i < raw.length; i++) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		raw[i] = i % (width * 3 + 1) === 0 ? 0 : state & 255;
	}
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (bytes: Buffer) => {
		let c = 0xffffffff;
		for (const byte of bytes) c = table[(c ^ byte) & 255]! ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

/** A WebP container: the check reads its RIFF length. */
function webp(): Uint8Array {
	const payload = Buffer.concat([Buffer.from("VP8L"), Buffer.from([5, 0, 0, 0]), Buffer.from([0x2f, 0, 0, 0, 0x10]), Buffer.alloc(1)]);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0);
	head.writeUInt32LE(4 + payload.length, 4);
	head.write("WEBP", 8);
	return new Uint8Array(Buffer.concat([head, payload]));
}

const log: Logger = { info: () => {}, warn: () => {} };
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("checkImage", () => {
	const images: Record<string, [Uint8Array, string]> = {
		png: [png(), "image/png"],
		jpeg: [fixture("photo.jpg"), "image/jpeg"],
		gif: [fixture("equation.gif"), "image/gif"],
		webp: [webp(), "image/webp"],
	};
	for (const [name, [bytes, mimeType]] of Object.entries(images)) {
		it(`a whole ${name} passes, and every shorter cut of it is refused as incomplete`, () => {
			expect(checkImage(bytes)).toEqual({ ok: true, mimeType });
			for (let cut = 0; cut < bytes.length; cut++) expect(checkImage(bytes.subarray(0, cut)).ok, `cut at ${cut}`).toBe(false);
			expect(checkImage(bytes.subarray(0, Math.floor(bytes.length / 2)))).toMatchObject({ ok: false, reason: expect.stringContaining("ends early") });
		});
	}

	it("refuses what is not an image, and data that is not base64", () => {
		expect(checkImage(new TextEncoder().encode("<svg/>"))).toMatchObject({ ok: false, reason: expect.stringContaining("not a PNG, JPEG, GIF or WebP") });
		expect(checkImageData("")).toMatchObject({ ok: false, reason: "it is empty" });
		expect(checkImageData("not base64!")).toMatchObject({ ok: false, reason: expect.stringContaining("not valid base64") });
	});
});

describe("checkToolResult", () => {
	const whole = base64(png());
	const cut = base64(png().subarray(0, 300));
	it("leaves a result with readable images alone, and corrects a declared type the bytes contradict", () => {
		expect(checkToolResult({ output: [{ type: "text", text: "shot" }, { type: "image", data: whole, mimeType: "image/png" }] })).toBeUndefined();
		const corrected = checkToolResult({ output: [{ type: "image", data: whole, mimeType: "image/jpeg" }] });
		expect(corrected!.output).toEqual([{ type: "image", data: whole, mimeType: "image/png" }]);
	});

	it("a broken image in the model's output becomes a text saying why; the rest of the output stays", () => {
		const checked = checkToolResult({ output: [{ type: "text", text: "shot size 400" }, { type: "image", data: cut, mimeType: "image/png" }] });
		expect(checked!.isError).toBeUndefined();
		expect(checked!.output).toEqual([
			{ type: "text", text: "shot size 400" },
			{ type: "text", text: expect.stringMatching(/^\[Image not shown to the model: the PNG ends early, at 300 bytes: the file is incomplete/) },
		]);
	});

	it("a broken image a program would get makes the call an error, so the script's call rejects with the reason", () => {
		const checked = checkToolResult({ output: [{ type: "image", data: cut, mimeType: "image/png" }], structuredOutput: { type: "image", data: cut, mimeType: "image/png" } });
		expect(checked).toMatchObject({ isError: true, diagnostics: [{ severity: "error", code: "unusable_image", message: expect.stringContaining("ends early") }] });
		expect(checked!.structuredOutput).toBeUndefined();
	});
});

it("a model's attachment goes inline only when it is readable; a broken one is named instead", () => {
	const catalog = [{ provider: "p", modelId: "m", input: ["text", "image"] }];
	const records = [
		{ type: "image" as const, id: "a", name: "shot.png", mimeType: "image/png", sizeBytes: 1 },
		{ type: "image" as const, id: "b", name: "photo.png", mimeType: "image/png", sizeBytes: 1 },
	];
	const data: Record<string, string> = { a: base64(png().subarray(0, 200)), b: base64(fixture("photo.jpg")) };
	const blocks = selectImageBlocks(catalog, { provider: "p", modelId: "m" }, records, (id) => ({ data: data[id]!, mimeType: "" }));
	expect(blocks).toEqual([
		{ type: "text", text: expect.stringContaining("shot.png: the PNG ends early"), hidden: true },
		{ type: "image", data: data.b, mimeType: "image/jpeg" },
	]);
});

/** A tool returning a screenshot cut short, as the copied PNG was. */
const truncatedShot: Extension = defineExtension({
	name: "shots",
	tools: [
		defineTool({
			name: "shot",
			description: "a screenshot",
			parameters: object({}),
			execute: async () => ({ output: [{ type: "text" as const, text: "shot taken" }, { type: "image" as const, data: base64(png(400, 300).subarray(0, 4096)), mimeType: "image/png" }] }),
		}),
	],
});

type Msg = { role: string; content: string | { type: string; text?: string; data?: string }[] };
const imagesIn = (messages: readonly Msg[]) => messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "image")));
const textIn = (messages: readonly Msg[]) => messages.flatMap((message) => (typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])))).join("\n");

/** A bridge over `threads`, to send messages as the web app does. */
async function bridgeOver(f: Awaited<ReturnType<typeof makeThreads>>, threads = f.threads, registry = f.registry): Promise<Bridge> {
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-image-check-"));
	const bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: scratch, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(scratch), corsOrigins: [], staticDir: undefined, registry }, log, threads, f.model.models);
	bridge.start();
	await bridge.loaded();
	onTestFinished(async () => {
		await bridge.close();
		await rm(scratch, { recursive: true, force: true });
	});
	return bridge;
}

const recording = (seen: Msg[][], text: string) => (context: { messages: unknown }) => {
	seen.push(context.messages as Msg[]);
	return fauxAssistantMessage(text);
};

it("a tool's broken image reaches the model as the reason, in the same turn, and the thread goes on", { timeout: 60_000 }, async () => {
	const seen: Msg[][] = [];
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [truncatedShot, imageCheckExtension()] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const bridge = await bridgeOver(f);
	f.model.respond(fauxAssistantMessage([fauxToolCall("shot", {}, { id: "call-1" })], { stopReason: "toolUse" }), recording(seen, "It was incomplete; taking it again."), recording(seen, "fine"));
	await bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "take a screenshot", mode: "start" });
	await idle(f.harness, thread.head);
	expect(imagesIn(seen[0]!), "the model is never sent the broken image").toEqual([]);
	expect(textIn(seen[0]!)).toContain("[Image not shown to the model: the PNG ends early, at 4,096 bytes");
	expect(textIn(seen[0]!)).toContain("shot taken");
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "go on", mode: "start" });
	await idle(f.harness, thread.head);
	expect((await bridge.projection("t")).projection.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
});

it("a transcript that holds a broken image already goes on once the check is installed", { timeout: 60_000 }, async () => {
	const seen: Msg[][] = [];
	// Before the check: the broken image is stored in the tool result, and the next request carries it.
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [truncatedShot] });
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const before = await bridgeOver(f);
	f.model.respond(fauxAssistantMessage([fauxToolCall("shot", {}, { id: "call-1" })], { stopReason: "toolUse" }), recording(seen, "saw it"));
	await before.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "take a screenshot", mode: "start" });
	await idle(f.harness, thread.head);
	expect(imagesIn(seen[0]!), "without the check the provider would be sent it").toHaveLength(1);
	await before.close();

	// With it: every request carries the reason instead; the transcript itself is unchanged.
	const after = await restart({ ...f, extensions: [truncatedShot, imageCheckExtension()] });
	const bridge = await bridgeOver(f, after.threads, after.registry);
	f.model.respond(recording(seen, "going on"));
	await bridge.sendMessage({ threadId: "t", commandId: "c2", messageId: "m2", text: "continue", mode: "start" });
	await idle(after.harness, thread.head);
	expect(imagesIn(seen[1]!)).toEqual([]);
	expect(textIn(seen[1]!)).toContain("[Image not shown to the model: the PNG ends early");
	expect((await bridge.projection("t")).projection.runs.at(-1)!.status).toBe("completed");
});
