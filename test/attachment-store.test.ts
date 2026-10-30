// The attachment store, in isolation: persistence (deterministic, idempotent), the signed-asset round trip, and the
// path/mime helpers. No facet, no harness — the disk and the HMAC are the whole world here.
import { mkdtempSync } from "node:fs";
import { AuthStore } from "../src/t3/auth.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttachmentStore, inferImageExtension, parseBase64DataUrl, resolveAttachmentRelativePath, type Signer } from "../src/t3/attachment-store.ts";

// A real 1×1 PNG (75 bytes) and a 1×1 GIF, so the persisted bytes and extension are real.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAEA//8DAAAGAAVXv6vUAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

/** The production signer: an `AuthStore` (its HMAC key lives in `auth.json`) in a dir of its own. */
const makeSigner = (): Signer => new AuthStore(mkdtempSync(join(dir, "key-")), { tokenTtlSeconds: 3600 });

let dir: string;
let store: AttachmentStore;
let signer: Signer;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-att-"));
	signer = makeSigner();
	store = new AttachmentStore(dir, signer);
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("persist", () => {
	it("writes the bytes and answers a persisted image record", () => {
		const [record] = store.persist("thread-a", "msg-1", [{ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/png;base64,${PNG_B64}` }]);
		expect(record).toMatchObject({ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });
		expect(record.id).toMatch(/thread-a-[0-9a-f-]{36}-png$/i);
		const path = store.resolvePath(record.id);
		expect(path).not.toBeNull();
		return readFile(path!).then((bytes) => expect(bytes.equals(PNG_BYTES)).toBe(true));
	});

	it("is idempotent: the same message + index + bytes re-persist to the same id", () => {
		const upload = [{ type: "image" as const, name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/png;base64,${PNG_B64}` }];
		const first = store.persist("thread-b", "msg-1", upload);
		const second = store.persist("thread-b", "msg-1", upload);
		expect(second[0]!.id).toBe(first[0]!.id);
		// A different message mints a different id (the id is keyed by message + index + bytes).
		const other = store.persist("thread-b", "msg-2", upload);
		expect(other[0]!.id).not.toBe(first[0]!.id);
	});

	it("refuses a payload whose mime type does not match, and whose size does not match", () => {
		// The client declared image/png; the data URL says image/jpeg.
		expect(() => store.persist("t", "m", [{ type: "image", name: "x.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/jpeg;base64,${PNG_B64}` }])).toThrow(/invalid image payload/);
		// The declared size is not the payload's byte length.
		expect(() => store.persist("t", "m", [{ type: "image", name: "x.png", mimeType: "image/png", sizeBytes: 9999, dataUrl: `data:image/png;base64,${PNG_B64}` }])).toThrow(/size does not match/);
	});
});

describe("asset URLs", () => {
	it("mints a signed URL whose bytes round-trip through resolveAsset", () => {
		const [record] = store.persist("thread-c", "msg-1", [{ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/png;base64,${PNG_B64}` }]);
		const minted = store.mintAssetUrl({ attachmentId: record.id, mimeType: "image/png" });
		expect(minted).not.toBeNull();
		expect(minted!.relativeUrl.startsWith("/api/assets/")).toBe(true);
		// The URL is `<prefix>/<token>/<file>`: recover the token and resolve.
		const token = minted!.relativeUrl.slice("/api/assets/".length).split("/")[0]!;
		const asset = store.resolveAsset(token, "pic.png");
		expect(asset).not.toBeNull();
		expect(asset!.bytes.equals(PNG_BYTES)).toBe(true);
		expect(asset!.mimeType).toBe("image/png");
	});

	it("refuses a tampered signature and a foreign key", () => {
		const [record] = store.persist("thread-d", "msg-1", [{ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/png;base64,${PNG_B64}` }]);
		const minted = store.mintAssetUrl({ attachmentId: record.id })!;
		const token = minted.relativeUrl.slice("/api/assets/".length).split("/")[0]!;
		// Any change to the signature is refused, including the last character, whose low bits are base64url padding.
		for (const last of ["A", "B", "C", "D"]) {
			const tampered = `${token.slice(0, -1)}${last}`;
			if (tampered !== token) expect(store.resolveAsset(tampered, "f")).toBeNull();
		}
		// A token minted by one key is not honored by a store with a different key.
		const otherStore = new AttachmentStore(dir, makeSigner());
		expect(otherStore.resolveAsset(token, "pic.png")).toBeNull();
	});

	it("answers a missing attachment with null on mint", () => {
		expect(store.mintAssetUrl({ attachmentId: "ghost-00000000-0000-4000-8000-000000000000" })).toBeNull();
	});
});

describe("helpers", () => {
	it("resolveAttachmentRelativePath confines every read to the store dir", () => {
		expect(resolveAttachmentRelativePath(dir, "../secret")).toBeNull();
		expect(resolveAttachmentRelativePath(dir, "a/b.png")).not.toBeNull();
		expect(store.resolvePath("../../etc/passwd")).toBeNull();
	});

	it("parseBase64DataUrl reads a data URL and rejects the malformed", () => {
		expect(parseBase64DataUrl(`data:image/png;base64,${PNG_B64}`)).toEqual({ mimeType: "image/png", base64: PNG_B64 });
		// Whitespace/newlines inside the payload are tolerated (base64 allows them).
		expect(parseBase64DataUrl(`data:image/png;base64,${PNG_B64.slice(0, 20)}\n${PNG_B64.slice(20)}`)?.base64).toBe(PNG_B64);
		expect(parseBase64DataUrl("not a data url")).toBeNull();
		expect(parseBase64DataUrl("data:image/png,rawtext")).toBeNull(); // not base64
		expect(parseBase64DataUrl(`data:image/png;base64,${PNG_B64}!!!`)).toBeNull(); // non-alphabet
	});

	it("inferImageExtension prefers the mime type, then a safe extension, then .bin", () => {
		expect(inferImageExtension({ mimeType: "image/png" })).toBe(".png");
		expect(inferImageExtension({ mimeType: "application/octet-stream", fileName: "x.webp" })).toBe(".webp");
		expect(inferImageExtension({ mimeType: "application/octet-stream", fileName: "x.xyz" })).toBe(".bin");
	});
});

describe("upload URLs", () => {
	it("mints a signed upload URL, stores its exact bytes, serves the attachment, and deletes it", () => {
		const minted = store.mintUpload({ name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });
		expect(minted.relativeUrl.startsWith("/api/attachments/upload/")).toBe(true);
		const token = minted.relativeUrl.slice("/api/attachments/upload/".length);
		expect(store.storeUpload(token, PNG_BYTES)).toEqual({ ok: true });
		expect(store.readForModel(minted.attachmentId)?.mimeType).toBe("image/png");
		const asset = store.mintAssetUrl({ attachmentId: minted.attachmentId })!;
		const assetToken = asset.relativeUrl.slice("/api/assets/".length).split("/")[0]!;
		expect(store.resolveAsset(assetToken, "pic.png")?.bytes.equals(PNG_BYTES)).toBe(true);
		store.deleteUpload(minted.attachmentId);
		expect(store.resolvePath(minted.attachmentId)).toBeNull();
	});

	it("refuses a wrong size, a tampered token, and a second upload of different bytes", () => {
		const minted = store.mintUpload({ name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });
		const token = minted.relativeUrl.slice("/api/attachments/upload/".length);
		expect(store.storeUpload(token, Buffer.from("short"))).toMatchObject({ ok: false, status: 400 });
		expect(store.storeUpload(`${token.slice(0, -1)}A`, PNG_BYTES)).toMatchObject({ ok: false, status: 401 });
		expect(store.storeUpload(token, PNG_BYTES)).toEqual({ ok: true });
		expect(store.storeUpload(token, Buffer.alloc(PNG_BYTES.byteLength))).toMatchObject({ ok: false });
	});
});
