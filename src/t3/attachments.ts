// Attachments: T3's `assets.persistChatAttachments`, upload URLs and asset URLs, with every sent attachment kept in the
// environment the agent works in. T3 points its agents at its own attachment store, which they can read on the same
// machine; here the agent's machine is the environment, so that is where an attachment lives: `<dir>/<id>.<ext>`,
// named to the model by path. The bridge's state dir holds only uploads not yet sent (`uploads/`), and the message
// entry holds the record. Every read and write of a sent attachment goes through the environment, as the workspace
// previews' do (`workspace-assets.ts`). Nothing deletes a sent attachment: storage only grows (design.md).
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** The prefix of a minted asset URL, exactly T3's (`ASSET_ROUTE_PREFIX`); the client resolves it against the facet. */
export const ASSET_ROUTE_PREFIX = "/api/assets";
/** An asset URL's lifetime (T3's `ASSET_TOKEN_TTL_MS`): a signed URL is good for an hour; the client re-mints. */
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
/** The largest attachment served back (as the workspace previews'). */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
/** An upload never sent is removed after this long (the client deletes the ones it drops; this catches the rest). */
const STALE_UPLOAD_MS = 7 * 24 * 60 * 60 * 1000;

/** A persisted image or file, shaped as T3's `ChatAttachment` (the record the projection carries on the message;
 * it rides in the pi entry's data, so it survives a restart). Legacy records had no type and were images. */
export type AttachmentRecord = {
	readonly type?: "image" | "file";
	readonly id: string;
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
};

/** One upload the client sends: an image with its bytes inline as a data URL (the data-URL path). */
export type ImageUpload = {
	readonly type: "image";
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
	readonly dataUrl: string;
};

/** One upload URL the client mints before sending the bytes. */
export type AttachmentUploadInput = {
	readonly type?: "image" | "file";
	readonly name: string;
	readonly mimeType: string;
	readonly sizeBytes: number;
};

export type AttachmentUploadResult = {
	readonly attachmentId: string;
	readonly relativeUrl: string;
	readonly expiresAt: number;
};

/** The signature side, supplied by the auth store (the durable HMAC key lives in `auth.json`). */
export type Signer = {
	signPayload(payload: string): string;
	verifySignature(payload: string, signature: string): boolean;
};


// ── T3's upload-URL path (`/api/attachments/upload`): a short-lived signed URL, then the bytes ─────────────────────

/** T3's `ATTACHMENT_UPLOAD_ROUTE_PREFIX`: a same-origin POST endpoint authenticated by the URL's signature. */
export const ATTACHMENT_UPLOAD_ROUTE_PREFIX = "/api/attachments/upload";
/** T3's `ATTACHMENT_UPLOAD_URL_TTL_MS`: ten minutes to send the bytes. */
const ATTACHMENT_UPLOAD_TTL_MS = 10 * 60_000;

type UploadClaims = {
	version: 1;
	kind: "attachment-upload";
	type: "image" | "file";
	attachmentId: string;
	name: string;
	mimeType: string;
	sizeBytes: number;
	expiresAt: number;
};

const decodeUploadClaims = (payload: string): UploadClaims | null => {
	try {
		const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<UploadClaims>;
		if (value.version !== 1 || value.kind !== "attachment-upload" || typeof value.attachmentId !== "string") return null;
		if (value.type !== "image" && value.type !== "file") return null;
		if (typeof value.name !== "string" || typeof value.mimeType !== "string" || typeof value.sizeBytes !== "number" || typeof value.expiresAt !== "number") return null;
		return value as UploadClaims;
	} catch {
		return null;
	}
};

// ── T3's image-mime / path pieces (apps/server/src/imageMime.ts, attachmentStore.ts, attachmentPaths.ts) ──────────

const IMAGE_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
	"image/gif": ".gif",
	"image/jpeg": ".jpg",
	"image/jpg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
};

const SAFE_IMAGE_FILE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);

/** The extension for an image's mime type, falling back to a safe extension from the file name, else `.bin`. */
export function inferImageExtension(input: { mimeType: string; fileName?: string }): string {
	const fromMime = IMAGE_EXTENSION_BY_MIME_TYPE[input.mimeType.toLowerCase()];
	if (fromMime !== undefined) return fromMime;
	const extension = extname((input.fileName ?? "").trim()).toLowerCase();
	return SAFE_IMAGE_FILE_EXTENSIONS.has(extension) ? extension : ".bin";
}

/** Parse a base64 data URL without ever running a regex across the (multi-MB) payload — T3's parser's whole point. */
export function parseBase64DataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
	const trimmed = dataUrl.trim();
	if (trimmed.slice(0, 5).toLowerCase() !== "data:") return null;
	const comma = trimmed.indexOf(",");
	if (comma === -1) return null;
	const parts = trimmed.slice(5, comma).split(";").map((part) => part.trim()).filter((part) => part.length > 0);
	if (parts.length < 2) return null;
	if (parts.at(-1)?.toLowerCase() !== "base64") return null;
	const mimeType = parts[0]?.toLowerCase();
	if (mimeType === undefined || mimeType.length === 0) return null;
	const payload = trimmed.slice(comma + 1);
	// Strip the base64 alphabet's whitespace; anything else is not base64.
	const base64 = payload.replace(/[\r\n ]/g, "");
	if (/[^A-Za-z0-9+/=]/.test(base64)) return null;
	if (base64.length === 0 || base64.length % 4 !== 0) return null;
	const firstPad = base64.indexOf("=");
	if (firstPad !== -1) {
		// '=' is valid only as one or two trailing pad characters; Node truncates at the first '=' silently.
		if (base64.length - firstPad > 2) return null;
		for (let at = firstPad; at < base64.length; at++) if (base64[at] !== "=") return null;
	}
	return { mimeType, base64 };
}

/** Lowercase, alphanumeric thread segment for an attachment id; the pending segment maps to `_pending` (unused here). */
export function toSafeThreadSegment(threadId: string): string | null {
	const segment = threadId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gi, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 80)
		.replace(/[-_]+$/g, "");
	return segment.length === 0 ? null : segment;
}

/** A deterministic id from the thread and a stable key: the same message + index + bytes re-persist to the same id
 * (T3's `createDeterministicAttachmentId`), so a retried persist is a rewrite, not a new attachment. */
export function createDeterministicAttachmentId(threadId: string, stableKey: string, extension: string): string | null {
	const segment = toSafeThreadSegment(threadId);
	if (segment === null) return null;
	const hash = createHash("sha256").update(JSON.stringify([threadId, stableKey])).digest("hex").slice(0, 32);
	const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
	const suffix = extension.replace(/^\./, "").toLowerCase();
	return `${segment}-${uuid}${/^[a-z0-9]{1,10}$/.test(suffix) ? `-${suffix}` : "-bin"}`;
}

/** The id's file-extension suffix (`…-png`), lowercased, if present (T3's `parseAttachmentFileExtension`). */
export function attachmentExtension(attachmentId: string): string | null {
	const match = /^[a-z0-9_]+(?:-[a-z0-9_]+)*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-([a-z0-9]{1,10})$/i.exec(attachmentId);
	const suffix = match?.[1]?.toLowerCase();
	return suffix === undefined ? null : suffix;
}

/** Normalize a relative path, rejecting traversal; null when unsafe (T3's `normalizeAttachmentRelativePath`). */
function normalizeRelative(value: string): string | null {
	const normalized = normalize(value).replace(/^[/\\]+/, "");
	if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) return null;
	return normalized.replace(/\\/g, "/");
}

/** Resolve a relative path inside `dir`, refusing anything that escapes it (T3's `resolveAttachmentRelativePath`). */
export function resolveAttachmentRelativePath(dir: string, relativePath: string): string | null {
	const normalized = normalizeRelative(relativePath);
	if (normalized === null) return null;
	const root = resolve(dir);
	const filePath = resolve(join(root, normalized));
	return filePath.startsWith(`${root}${sep}`) ? filePath : null;
}


// ── The signed asset claims (T3's `attachment` claim, subset; assets/AssetAccess.ts) ─────────────────────────────

type AssetClaims = {
	version: 1;
	kind: "attachment";
	attachmentId: string;
	fileName?: string;
	mimeType?: string;
	expiresAt: number;
};

const decodeClaims = (payload: string): AssetClaims | null => {
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AssetClaims;
		return claims && claims.kind === "attachment" && typeof claims.attachmentId === "string" ? claims : null;
	} catch {
		return null;
	}
};


/** A sent attachment's file name in the environment's dir: `<id>.<ext>`, the id's suffix extension when it has one. */
function fileNameOf(attachmentId: string, record?: { readonly mimeType: string; readonly name: string }): string {
	const suffix = attachmentExtension(attachmentId);
	return `${attachmentId}${suffix === null ? inferImageExtension({ mimeType: record?.mimeType ?? "", fileName: record?.name ?? "" }) : `.${suffix}`}`;
}

/** The extension suffix an id carries for a record's type and name (`png`, `pdf`, else `bin`). */
function suffixFor(type: "image" | "file", name: string, mimeType: string): string {
	const extension = type === "file" ? extname(name).toLowerCase().replace(/^\./, "") : inferImageExtension({ mimeType, fileName: name }).replace(/^\./, "");
	return /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin";
}

/** One attachment of a message, kept: its record (the deterministic id), where the agent finds it, and its bytes when
 * they are at hand (an image the model may see). */
export type KeptAttachment = { readonly record: AttachmentRecord; readonly path: string; readonly bytes?: Uint8Array };

// ── Attachments ─────────────────────────────────────────────────────────────────────────────────────────────────

export class Attachments {
	readonly #uploads: string;
	readonly #signer: Signer;
	readonly #env: ExecutionEnv;
	readonly #dir: string;
	readonly #context: Context;

	/** `stateDir`: the bridge's dir (uploads not yet sent go in its `uploads/`). `dir`: where sent attachments live in
	 * `env`. */
	constructor(options: { readonly stateDir: string; readonly signer: Signer; readonly env: ExecutionEnv; readonly dir: string; readonly context: Context }) {
		this.#uploads = join(options.stateDir, "uploads");
		mkdirSync(this.#uploads, { recursive: true, mode: 0o700 });
		this.#signer = options.signer;
		this.#env = options.env;
		this.#dir = options.dir.replace(/\/+$/, "");
		this.#context = options.context;
	}

	/** Where a sent attachment lives in the environment. */
	pathOf(record: Pick<AttachmentRecord, "id" | "mimeType" | "name">): string {
		return `${this.#dir}/${fileNameOf(record.id, record)}`;
	}

	/** Mint a one-use upload URL for an image or file, with a fresh attachment id. The token carries the size and
	 * mime type the later POST must match, so an upload cannot write arbitrary bytes under another id. */
	mintUpload(input: AttachmentUploadInput): AttachmentUploadResult {
		this.#sweepUploads();
		const type = input.type === "file" ? "file" : "image";
		const attachmentId = `att-${randomUUID()}-${suffixFor(type, input.name, input.mimeType)}`;
		const expiresAt = Date.now() + ATTACHMENT_UPLOAD_TTL_MS;
		const claims: UploadClaims = { version: 1, kind: "attachment-upload", type, attachmentId, name: input.name, mimeType: input.mimeType, sizeBytes: input.sizeBytes, expiresAt };
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		return { attachmentId, relativeUrl: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/${payload}.${this.#signer.signPayload(payload)}`, expiresAt };
	}

	/** Store the bytes an upload URL names, until the message that sends them: verify the signature and expiry, require
	 * the claimed body size, then write `uploads/<id>.<ext>`. A retry of the same token is idempotent. */
	storeUpload(token: string, bytes: Buffer): { readonly ok: true } | { readonly ok: false; readonly status: number; readonly detail: string } {
		const dot = token.indexOf(".");
		if (dot <= 0) return { ok: false, status: 400, detail: "Invalid upload URL." };
		const payload = token.slice(0, dot);
		const signature = token.slice(dot + 1);
		if (!this.#signer.verifySignature(payload, signature)) return { ok: false, status: 401, detail: "Invalid upload URL." };
		const claims = decodeUploadClaims(payload);
		if (claims === null || claims.expiresAt <= Date.now()) return { ok: false, status: 401, detail: "Upload URL expired." };
		if (bytes.byteLength !== claims.sizeBytes) return { ok: false, status: 400, detail: `Body was ${bytes.byteLength} bytes, expected ${claims.sizeBytes}.` };
		const path = resolveAttachmentRelativePath(this.#uploads, `${claims.attachmentId}.${suffixFor(claims.type, claims.name, claims.mimeType)}`);
		if (path === null) return { ok: false, status: 500, detail: "Could not resolve the upload path." };
		try {
			writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
		} catch (error) {
			// A retried upload of the same token is harmless if the first attempt already wrote the same bytes.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !existsSync(path)) return { ok: false, status: 500, detail: "Could not store the upload." };
			try {
				if (!readFileSync(path).equals(bytes)) return { ok: false, status: 409, detail: "That upload token already names different bytes." };
			} catch {
				return { ok: false, status: 500, detail: "Could not read the stored upload." };
			}
		}
		return { ok: true };
	}

	/** Drop an upload that will not be sent (`attachments.delete`). A sent attachment is not an upload: nothing here
	 * removes one. */
	deleteUpload(attachmentId: string): void {
		const path = this.#uploadPath(attachmentId);
		if (path !== null) unlinkSync(path);
	}

	/** T3's data-URL path: validate each image, give it the deterministic id of (thread, message, index, bytes), and keep
	 * it in the environment. A retried persist rewrites the same file. Throws on an invalid payload. */
	async persist(threadId: string, messageId: string, uploads: readonly ImageUpload[]): Promise<(AttachmentRecord & { readonly type: "image" })[]> {
		const records: (AttachmentRecord & { readonly type: "image" })[] = [];
		for (const [index, upload] of uploads.entries()) {
			const parsed = parseBase64DataUrl(upload.dataUrl);
			if (parsed === null || parsed.mimeType !== upload.mimeType.toLowerCase()) throw new Error(`Attachment ${upload.name} has an invalid image payload.`);
			const bytes = Buffer.from(parsed.base64, "base64");
			if (bytes.byteLength !== upload.sizeBytes) throw new Error(`Attachment ${upload.name} size does not match its payload.`);
			const id = deterministicId(threadId, messageId, index, bytes, "image", upload.name, upload.mimeType);
			const record = { type: "image" as const, id, name: upload.name, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes };
			await this.#write(record, bytes);
			records.push(record);
		}
		return records;
	}

	/**
	 * Keep a message's attachments before the message names them. An upload not yet sent moves into the environment
	 * under the deterministic id of (thread, message, index, bytes), and its staged copy goes. An attachment already
	 * kept (a retried send, a queued message sent later) stays where it is. A missing one is an error: the message would
	 * name a file that is not there.
	 */
	async keep(threadId: string, messageId: string, records: readonly AttachmentRecord[]): Promise<KeptAttachment[]> {
		const kept: KeptAttachment[] = [];
		for (const [index, record] of records.entries()) {
			const type = record.type ?? "image";
			const staged = this.#uploadPath(record.id);
			if (staged !== null) {
				const bytes = readFileSync(staged);
				const id = deterministicId(threadId, messageId, index, bytes, type, record.name, record.mimeType);
				const moved = { ...record, type, id, sizeBytes: bytes.byteLength };
				await this.#write(moved, bytes);
				unlinkSync(staged);
				kept.push({ record: moved, path: this.pathOf(moved), ...(type === "image" ? { bytes } : {}) });
				continue;
			}
			const path = this.pathOf(record);
			const info = await this.#env.fileInfo(path, this.#context);
			if (!info.ok || info.value.kind !== "file") throw new Error(`Attachment ${record.name} is missing (${path}).`);
			if (type === "image") {
				const read = await this.#env.readBinaryFile(path, this.#context);
				if (!read.ok) throw new Error(`Attachment ${record.name} cannot be read: ${read.error.message}`);
				kept.push({ record: { ...record, type }, path, bytes: read.value });
			} else {
				kept.push({ record: { ...record, type }, path });
			}
		}
		return kept;
	}

	/** Mint a signed asset URL for a sent attachment (the `attachment` resource of `assets.createUrl`); null when it is
	 * not in the environment (the client shows it missing). */
	async mintAssetUrl(input: { attachmentId: string; fileName?: string; mimeType?: string }): Promise<{ relativeUrl: string; expiresAt: number } | null> {
		if (normalizeRelative(input.attachmentId) !== input.attachmentId || input.attachmentId.includes("/")) return null;
		const info = await this.#env.fileInfo(this.pathOf({ id: input.attachmentId, mimeType: input.mimeType ?? "", name: input.fileName ?? "" }), this.#context);
		if (!info.ok || info.value.kind !== "file") return null;
		const expiresAt = Date.now() + ASSET_TOKEN_TTL_MS;
		const claims: AssetClaims = {
			version: 1,
			kind: "attachment",
			attachmentId: input.attachmentId,
			...(input.fileName === undefined ? {} : { fileName: input.fileName }),
			...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
			expiresAt,
		};
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const fileName = basename(input.fileName ?? fileNameOf(input.attachmentId));
		return { relativeUrl: `${ASSET_ROUTE_PREFIX}/${payload}.${this.#signer.signPayload(payload)}/${encodeURIComponent(fileName)}`, expiresAt };
	}

	/** Serve a signed asset token: verify the signature and expiry, then read the attachment from the environment. The
	 * content type comes from the file's extension, never a client-declared mime. Null on any failure (404). */
	async resolveAsset(token: string, filename: string): Promise<{ bytes: Uint8Array; mimeType: string; fileName?: string } | null> {
		const dot = token.indexOf(".");
		if (dot <= 0) return null;
		const payload = token.slice(0, dot);
		if (!this.#signer.verifySignature(payload, token.slice(dot + 1))) return null;
		const claims = decodeClaims(payload);
		if (claims === null || claims.expiresAt <= Date.now()) return null;
		const path = this.pathOf({ id: claims.attachmentId, mimeType: claims.mimeType ?? "", name: claims.fileName ?? "" });
		const info = await this.#env.fileInfo(path, this.#context);
		if (!info.ok || info.value.kind !== "file" || info.value.size > MAX_ASSET_BYTES) return null;
		const read = await this.#env.readBinaryFile(path, this.#context);
		if (!read.ok) return null;
		return { bytes: read.value, mimeType: mediaTypeFromPath(path), fileName: claims.fileName ?? filename };
	}

	/** Keep a file the host made (an `html_render` page) under its attachment id, as a sent attachment is kept; returns its
	 * path. The id's suffix names its type, as T3's ids do (`…-html`). */
	async writeGenerated(attachmentId: string, bytes: Uint8Array): Promise<string> {
		const record = { id: attachmentId, mimeType: "", name: "" } as AttachmentRecord;
		await this.#write(record, bytes);
		return this.pathOf(record);
	}

	async #write(record: AttachmentRecord, bytes: Uint8Array): Promise<void> {
		const made = await this.#env.createDir(this.#dir, { recursive: true }, this.#context);
		if (!made.ok) throw new Error(`Cannot create the attachment directory ${this.#dir}: ${made.error.message}`);
		const written = await this.#env.writeFile(this.pathOf(record), bytes, this.#context);
		if (!written.ok) throw new Error(`Cannot save attachment ${record.name}: ${written.error.message}`);
	}

	/** A staged upload's path, by its id; null when there is none. */
	#uploadPath(attachmentId: string): string | null {
		if (!attachmentId.startsWith("att-")) return null;
		const suffix = attachmentExtension(attachmentId) ?? /-([a-z0-9]{1,10})$/i.exec(attachmentId)?.[1]?.toLowerCase();
		if (suffix === undefined) return null;
		const path = resolveAttachmentRelativePath(this.#uploads, `${attachmentId}.${suffix}`);
		return path !== null && existsSync(path) ? path : null;
	}

	/** Remove uploads nobody sent within a week. */
	#sweepUploads(): void {
		const cutoff = Date.now() - STALE_UPLOAD_MS;
		for (const name of readdirSync(this.#uploads)) {
			const path = join(this.#uploads, name);
			try {
				if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
			} catch {
				// Gone meanwhile, or not ours to remove: the next sweep sees it again.
			}
		}
	}
}

/** The deterministic id of a message's attachment: the same message, index and bytes give the same id
 * (T3's `createDeterministicAttachmentId`), so a retried send rewrites the same file. */
function deterministicId(threadId: string, messageId: string, index: number, bytes: Uint8Array, type: "image" | "file", name: string, mimeType: string): string {
	const stableKey = `${messageId}:${index}:${createHash("sha256").update(bytes).digest("hex")}`;
	const id = createDeterministicAttachmentId(threadId, stableKey, suffixFor(type, name, mimeType));
	if (id === null) throw new Error("Could not allocate an attachment identifier.");
	return id;
}

/** Media type from a file's extension (the id's suffix, not a client-supplied mime). */
function mediaTypeFromPath(path: string): string {
	const ext = extname(path).toLowerCase();
	// Images, and the documents and media T3 serves inline (HTML and SVG sandboxed by the asset route); the rest downloads.
	const byExt: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".svg": "image/svg+xml",
		".html": "text/html",
		".htm": "text/html",
		".pdf": "application/pdf",
		".mp3": "audio/mpeg",
		".wav": "audio/wav",
		".ogg": "audio/ogg",
		".mp4": "video/mp4",
		".webm": "video/webm",
	};
	return byExt[ext] ?? "application/octet-stream";
}
