// Attachments, in isolation: uploads wait in the state dir, a sent message keeps them in the environment under
// deterministic ids, and asset URLs serve them from there. A real local environment over temp dirs; no facet, no harness.
import { existsSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthStore } from "../src/t3/auth.ts";
import { Attachments, inferImageExtension, parseBase64DataUrl, resolveAttachmentRelativePath, type Signer } from "../src/t3/attachments.ts";

// A real 1×1 PNG (75 bytes), so the kept bytes and extension are real.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const DATA_URL = `data:image/png;base64,${PNG_B64}`;

let root: string;
let stateDir: string;
let home: string;
let attachments: Attachments;
const makeSigner = (): Signer => new AuthStore(mkdtempSync(join(root, "key-")), { tokenTtlSeconds: 3600 });
const make = (signer: Signer) => new Attachments({ stateDir, signer, env: new NodeExecutionEnv({ cwd: "/" }), dir: home, context: BACKGROUND_CONTEXT });

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-att-"));
	stateDir = join(root, "state");
	home = join(root, "workspace", "attachments");
	attachments = make(makeSigner());
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Upload bytes the way the client does: mint a URL, POST the bytes. */
function upload(input: { type?: "image" | "file"; name: string; mimeType: string; bytes: Buffer }): string {
	const minted = attachments.mintUpload({ ...(input.type === undefined ? {} : { type: input.type }), name: input.name, mimeType: input.mimeType, sizeBytes: input.bytes.byteLength });
	expect(attachments.storeUpload(minted.relativeUrl.slice("/api/attachments/upload/".length), input.bytes)).toEqual({ ok: true });
	return minted.attachmentId;
}

const tokenOf = (relativeUrl: string) => relativeUrl.slice("/api/assets/".length).split("/")[0]!;

describe("keeping a message's attachments", () => {
	it("moves an upload into the environment under a deterministic id, with its bytes for the model", async () => {
		const id = upload({ name: "pic.png", mimeType: "image/png", bytes: PNG_BYTES });
		const [kept] = await attachments.keep("thread-a", "msg-1", [{ type: "image", id, name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength }]);
		expect(kept!.record.id).toMatch(/^thread-a-[0-9a-f-]{36}-png$/);
		expect(kept!.path).toBe(join(home, `${kept!.record.id}.png`));
		expect((await readFile(kept!.path)).equals(PNG_BYTES)).toBe(true);
		expect(Buffer.from(kept!.bytes!).equals(PNG_BYTES)).toBe(true);
		expect(readdirSync(join(stateDir, "uploads")).some((name) => name.startsWith(id)), "the staged upload is gone").toBe(false);
	});

	it("keeps a file too, named by path, without reading it back", async () => {
		const pdf = Buffer.from("%PDF-1.4\nnot really a PDF\n");
		const id = upload({ type: "file", name: "spec.pdf", mimeType: "application/pdf", bytes: pdf });
		const [kept] = await attachments.keep("thread-a", "msg-2", [{ type: "file", id, name: "spec.pdf", mimeType: "application/pdf", sizeBytes: pdf.byteLength }]);
		expect(kept!.path.endsWith("-pdf.pdf")).toBe(true);
		expect(kept!.bytes).toBeUndefined();
		expect((await readFile(kept!.path)).equals(pdf)).toBe(true);
	});

	it("leaves an attachment already kept where it is (a retried send), and refuses one that is missing", async () => {
		const id = upload({ name: "pic.png", mimeType: "image/png", bytes: PNG_BYTES });
		const record = { type: "image" as const, id, name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength };
		const [first] = await attachments.keep("thread-b", "msg-1", [record]);
		const [again] = await attachments.keep("thread-b", "msg-1", [first!.record]);
		expect(again!.record).toEqual(first!.record);
		expect(Buffer.from(again!.bytes!).equals(PNG_BYTES)).toBe(true);
		const ghost = { ...record, id: "thread-b-00000000-0000-4000-8000-000000000000-png" };
		await expect(attachments.keep("thread-b", "msg-2", [ghost])).rejects.toThrow(/pic\.png is missing/);
	});
});

describe("persist (T3's data-URL path)", () => {
	it("keeps the image in the environment at once, idempotently, and refuses a mismatched payload", async () => {
		const image = [{ type: "image" as const, name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: DATA_URL }];
		const [record] = await attachments.persist("thread-c", "msg-1", image);
		expect(record).toMatchObject({ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });
		expect((await readFile(attachments.pathOf(record!))).equals(PNG_BYTES)).toBe(true);
		expect((await attachments.persist("thread-c", "msg-1", image))[0]!.id).toBe(record!.id);
		expect((await attachments.persist("thread-c", "msg-2", image))[0]!.id).not.toBe(record!.id);
		await expect(attachments.persist("t", "m", [{ ...image[0]!, dataUrl: `data:image/jpeg;base64,${PNG_B64}` }])).rejects.toThrow(/invalid image payload/);
		await expect(attachments.persist("t", "m", [{ ...image[0]!, sizeBytes: 9999 }])).rejects.toThrow(/size does not match/);
	});
});

describe("asset URLs", () => {
	it("serves a kept attachment from the environment, and refuses a tampered or foreign token", async () => {
		const [record] = await attachments.persist("thread-d", "msg-1", [{ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: DATA_URL }]);
		const minted = await attachments.mintAssetUrl({ attachmentId: record!.id, mimeType: "image/png" });
		expect(minted!.relativeUrl.startsWith("/api/assets/")).toBe(true);
		const token = tokenOf(minted!.relativeUrl);
		const asset = await attachments.resolveAsset(token, "pic.png");
		expect(Buffer.from(asset!.bytes).equals(PNG_BYTES)).toBe(true);
		expect(asset!.mimeType).toBe("image/png");
		for (const last of ["A", "B", "C", "D"]) {
			const tampered = `${token.slice(0, -1)}${last}`;
			if (tampered !== token) expect(await attachments.resolveAsset(tampered, "f")).toBeNull();
		}
		expect(await make(makeSigner()).resolveAsset(token, "pic.png"), "another key's token is refused").toBeNull();
	});

	it("answers null for an attachment that is not in the environment, or an id that is a path", async () => {
		expect(await attachments.mintAssetUrl({ attachmentId: "ghost-00000000-0000-4000-8000-000000000000-png" })).toBeNull();
		expect(await attachments.mintAssetUrl({ attachmentId: "../../etc/passwd" })).toBeNull();
	});
});

describe("uploads", () => {
	it("refuses a wrong size, a tampered token, and a second upload of different bytes; deletes a dropped one", () => {
		const minted = attachments.mintUpload({ name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });
		const token = minted.relativeUrl.slice("/api/attachments/upload/".length);
		expect(attachments.storeUpload(token, Buffer.from("short"))).toMatchObject({ ok: false, status: 400 });
		const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
		expect(attachments.storeUpload(tampered, PNG_BYTES)).toMatchObject({ ok: false, status: 401 });
		expect(attachments.storeUpload(token, PNG_BYTES)).toEqual({ ok: true });
		expect(attachments.storeUpload(token, Buffer.alloc(PNG_BYTES.byteLength))).toMatchObject({ ok: false });
		attachments.deleteUpload(minted.attachmentId);
		expect(readdirSync(join(stateDir, "uploads")).some((name) => name.startsWith(minted.attachmentId))).toBe(false);
	});

	it("removes an upload nobody sent within a week, at the next mint", () => {
		const id = upload({ name: "old.png", mimeType: "image/png", bytes: PNG_BYTES });
		const path = join(stateDir, "uploads", `${id}.png`);
		const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(path, longAgo, longAgo);
		attachments.mintUpload({ name: "new.png", mimeType: "image/png", sizeBytes: 1 });
		expect(existsSync(path)).toBe(false);
	});
});

describe("helpers", () => {
	it("resolveAttachmentRelativePath confines a path to its dir", () => {
		expect(resolveAttachmentRelativePath(root, "../secret")).toBeNull();
		expect(resolveAttachmentRelativePath(root, "a/b.png")).not.toBeNull();
	});

	it("parseBase64DataUrl reads a data URL and rejects the malformed", () => {
		expect(parseBase64DataUrl(DATA_URL)).toEqual({ mimeType: "image/png", base64: PNG_B64 });
		expect(parseBase64DataUrl(`data:image/png;base64,${PNG_B64.slice(0, 20)}\n${PNG_B64.slice(20)}`)?.base64).toBe(PNG_B64);
		expect(parseBase64DataUrl("not a data url")).toBeNull();
		expect(parseBase64DataUrl("data:image/png,rawtext")).toBeNull();
		expect(parseBase64DataUrl(`${DATA_URL}!!!`)).toBeNull();
	});

	it("inferImageExtension prefers the mime type, then a safe extension, then .bin", () => {
		expect(inferImageExtension({ mimeType: "image/png" })).toBe(".png");
		expect(inferImageExtension({ mimeType: "application/octet-stream", fileName: "x.webp" })).toBe(".webp");
		expect(inferImageExtension({ mimeType: "application/octet-stream", fileName: "x.xyz" })).toBe(".bin");
	});
});
