// The bridge's image-attachment store: T3's `assets.persistChatAttachments` and asset-URL minting/serving, over
// `stateDir/attachments/`. It replicates the pieces of T3's attachment layer the data-URL image path uses (design.md:
// faithfully, and only what the client calls): deterministic ids so a retried persist is idempotent, the
// `<payload>.<hmac>` signed token format T3 mints for asset URLs, and containment of every read to this one dir.
// The upload-URL path (a streaming endpoint + pending→thread claim) is out of scope: the bridge does not advertise
// `attachmentUploads`, so the client sends images as data URLs and never calls `attachments.*` (capabilities.md).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

/** The prefix of a minted asset URL, exactly T3's (`ASSET_ROUTE_PREFIX`); the client resolves it against the facet. */
export const ASSET_ROUTE_PREFIX = "/api/assets";
/** An asset URL's lifetime (T3's `ASSET_TOKEN_TTL_MS`): a signed URL is good for an hour; the client re-mints. */
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** A persisted image, shaped as T3's `ChatImageAttachment` (the record `assets.persistChatAttachments` answers, and
 * the projection carries on the message; it rides in the pi entry's data, so it survives a restart). */
export type AttachmentRecord = {
	readonly type: "image";
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

/** The signature side, supplied by the auth store (the durable HMAC key lives in `auth.json`). */
export type Signer = {
	signPayload(payload: string): string;
	verifySignature(payload: string, signature: string): boolean;
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

/** The relative filename for a record: `<id><.ext>`, the id's suffix extension when it carries one. */
function recordRelativePath(record: AttachmentRecord): string {
	const suffix = attachmentExtension(record.id);
	return `${record.id}${suffix === null ? inferImageExtension({ mimeType: record.mimeType, fileName: record.name }) : `.${suffix}`}`;
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

// ── The store ───────────────────────────────────────────────────────────────────────────────────────────────────

export class AttachmentStore {
	readonly #dir: string;
	readonly #signer: Signer;

	constructor(dir: string, signer: Signer) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.#dir = dir;
		this.#signer = signer;
	}

	/** Persist one message's image uploads: validate each data URL, mint a deterministic id, write the bytes, and
	 * answer the persisted records. Idempotent per (thread, message, index, bytes) — a retried persist rewrites the
	 * same id. Throws on any invalid payload (the caller maps it to T3's `PersistChatAttachmentsError`). */
	persist(threadId: string, messageId: string, uploads: readonly ImageUpload[]): AttachmentRecord[] {
		return uploads.map((upload, index) => {
			const parsed = parseBase64DataUrl(upload.dataUrl);
			if (parsed === null || parsed.mimeType !== upload.mimeType.toLowerCase()) {
				throw new Error(`Attachment ${upload.name} has an invalid image payload.`);
			}
			const bytes = Buffer.from(parsed.base64, "base64");
			if (bytes.byteLength !== upload.sizeBytes) {
				throw new Error(`Attachment ${upload.name} size does not match its payload.`);
			}
			const extension = inferImageExtension({ mimeType: upload.mimeType, fileName: upload.name });
			const stableKey = `${messageId}:${index}:${createHash("sha256").update(bytes).digest("hex")}`;
			const id = createDeterministicAttachmentId(threadId, stableKey, extension);
			if (id === null) throw new Error("Could not allocate an attachment identifier.");
			const path = resolveAttachmentRelativePath(this.#dir, `${id}${extension}`);
			if (path === null) throw new Error("Could not allocate an attachment path.");
			writeFileSync(path, bytes, { mode: 0o600 });
			return { type: "image", id, name: upload.name, mimeType: upload.mimeType, sizeBytes: upload.sizeBytes };
		});
	}

	/** The stored path of a persisted image, by its id; null when it is missing (a removed/expired attachment). */
	resolvePath(attachmentId: string): string | null {
		const normalized = normalizeRelative(attachmentId);
		if (normalized === null || normalized.includes("/")) return null;
		const suffix = attachmentExtension(attachmentId);
		if (suffix !== null) {
			const path = resolveAttachmentRelativePath(this.#dir, `${normalized}.${suffix}`);
			return path !== null && existsSync(path) ? path : null;
		}
		// No suffix on the id: probe the known image extensions (T3's `resolveAttachmentPathById`).
		for (const extension of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bin"]) {
			const path = resolveAttachmentRelativePath(this.#dir, `${normalized}${extension}`);
			if (path !== null && existsSync(path)) return path;
		}
		return null;
	}

	/** Mint a signed asset URL for a persisted attachment (the `attachment` resource of `assets.createUrl`). The bytes
	 * must exist; null answers a missing attachment (the client's `verifyPersistedAttachmentUpload` maps it). */
	mintAssetUrl(input: { attachmentId: string; fileName?: string; mimeType?: string }): { relativeUrl: string; expiresAt: number } | null {
		if (this.resolvePath(input.attachmentId) === null) return null;
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
		const token = `${payload}.${this.#signer.signPayload(payload)}`;
		const fileName = basename(input.fileName ?? recordRelativePath({ type: "image", id: input.attachmentId, name: "", mimeType: input.mimeType ?? "", sizeBytes: 0 }));
		return { relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`, expiresAt };
	}

	/** Resolve a signed asset token to bytes for serving: verify the signature, the expiry, and that the file exists.
	 * Returns the bytes, a content type, and a download hint; null on any failure (the route answers 404). */
	resolveAsset(token: string, filename: string): { bytes: Buffer; mimeType: string; fileName?: string } | null {
		const dot = token.indexOf(".");
		if (dot <= 0) return null;
		const payload = token.slice(0, dot);
		const signature = token.slice(dot + 1);
		if (!this.#signer.verifySignature(payload, signature)) return null;
		const claims = decodeClaims(payload);
		if (claims === null || claims.expiresAt <= Date.now()) return null;
		const path = this.resolvePath(claims.attachmentId);
		if (path === null) return null;
		let bytes: Buffer;
		try {
			bytes = readFileSync(path);
		} catch {
			return null;
		}
		// The stored file's extension decides the content type, never a client-declared mime: this origin is the API's.
		const mimeType = mediaTypeFromPath(path);
		return { bytes, mimeType, fileName: claims.fileName ?? filename };
	}

	/** Read a persisted image's bytes as base64 for the model (the prompt content block); null when it is missing. */
	readForModel(attachmentId: string): { data: string; mimeType: string } | null {
		const path = this.resolvePath(attachmentId);
		if (path === null) return null;
		try {
			return { data: readFileSync(path).toString("base64"), mimeType: mediaTypeFromPath(path) };
		} catch {
			return null;
		}
	}

	/** The stored byte size of an attachment (the send-time size check); undefined when it is missing. */
	sizeOf(attachmentId: string): number | undefined {
		const path = this.resolvePath(attachmentId);
		if (path === null) return undefined;
		try {
			return statSync(path).size;
		} catch {
			return undefined;
		}
	}
}

/** Media type from a stored file's extension (the id's suffix, not a client-supplied mime). */
function mediaTypeFromPath(path: string): string {
	const ext = extname(path).toLowerCase();
	const byExt: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
	return byExt[ext] ?? "application/octet-stream";
}
