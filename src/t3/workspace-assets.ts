// T3's workspace asset URLs: `assets.createUrl` for a file the file panel or a markdown preview wants to show, and the
// `/api/assets/*` route that serves it. T3 mints an HMAC-signed URL for a workspace file (or an absolute media file),
// and its iframe/`<img>` loads that URL without a bearer. This host keeps that shape, but every read goes through the
// caller's ExecutionEnv: the environment is the boundary, exactly as it is for `projects.readFile`.
//
// HTML/PDF assets carry their containing folder in the claims, so relative `<link>`, `<script>`, font and image URLs
// resolve under the same signed token. Images are exact-file claims. Only the extensions T3 previews are served; a
// text file goes through `projects.readFile` instead.
import { AssetPreviewTypeValidationError, AssetWorkspaceAssetInspectionError, AssetWorkspaceAssetNotFoundError, AssetWorkspacePathValidationError, type AssetCreateUrlResult, type AssetResource } from "@t3tools/contracts";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ASSET_ROUTE_PREFIX, type Signer } from "./attachment-store.ts";

/** T3's asset URL lifetime (`ASSET_TOKEN_TTL_MS`). The client re-mints before this expires. */
const ASSET_TOKEN_TTL_MS = 60 * 60 * 1000;
/** A preview is a document, not a file-transfer protocol; this bounds one read well above a normal page or image. */
const MAX_ASSET_BYTES = 64 * 1024 * 1024;

const WORKSPACE_IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const WORKSPACE_BROWSER_EXTENSIONS = new Set([".htm", ".html", ".pdf"]);
const SUBASSET_EXTENSIONS = new Set([...WORKSPACE_IMAGE_EXTENSIONS, ...WORKSPACE_BROWSER_EXTENSIONS, ".css", ".js", ".mjs", ".otf", ".ttf", ".woff", ".woff2"]);
const MEDIA_EXTENSIONS = new Set([...WORKSPACE_IMAGE_EXTENSIONS, ...WORKSPACE_BROWSER_EXTENSIONS, ".mp3", ".wav", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".opus", ".aiff", ".mp4", ".webm", ".mov", ".m4v", ".ogv"]);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
	".avif": "image/avif", ".gif": "image/gif", ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
	".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp", ".htm": "text/html", ".html": "text/html",
	".pdf": "application/pdf", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
	".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
	".aac": "audio/aac", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".aiff": "audio/aiff",
	".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".ogv": "video/ogg",
};

const extensionOf = (path: string): string => {
	const name = basename(path).toLowerCase();
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot);
};
const mimeTypeOf = (path: string): string | null => MIME_BY_EXTENSION[extensionOf(path)] ?? null;

type Claims =
	| { readonly version: 1; readonly kind: "workspace-file"; readonly workspaceRoot: string; readonly baseRelativePath: string; readonly expiresAt: number }
	| { readonly version: 1; readonly kind: "workspace-file-exact"; readonly workspaceRoot: string; readonly relativePath: string; readonly expiresAt: number }
	| { readonly version: 1; readonly kind: "media-file-exact"; readonly filePath: string; readonly expiresAt: number };

const decodeClaims = (payload: string): Claims | null => {
	try {
		const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<Claims>;
		if (value.version !== 1 || typeof value.expiresAt !== "number") return null;
		if (value.kind === "workspace-file" && typeof value.workspaceRoot === "string" && typeof value.baseRelativePath === "string") return value as Claims;
		if (value.kind === "workspace-file-exact" && typeof value.workspaceRoot === "string" && typeof value.relativePath === "string") return value as Claims;
		if (value.kind === "media-file-exact" && typeof value.filePath === "string") return value as Claims;
		return null;
	} catch {
		return null;
	}
};

const inside = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};

const decodeRelativePath = (value: string): string | null => {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
};

/** One resolved file: the canonical path and the workspace root that contains it. */
type WorkspaceTarget = { readonly root: string; readonly relativePath: string; readonly absolutePath: string };

export class WorkspaceAssets {
	readonly #env: ExecutionEnv;
	readonly #context: Context;
	readonly #roots: () => readonly string[];
	readonly #signer: Signer;

	constructor(options: { readonly env: ExecutionEnv; readonly context?: Context; readonly roots: () => readonly string[]; readonly signer: Signer }) {
		this.#env = options.env;
		this.#context = options.context ?? BACKGROUND_CONTEXT;
		this.#roots = options.roots;
		this.#signer = options.signer;
	}

	async #canonical(path: string): Promise<string | null> {
		const result = await this.#env.canonicalPath(path, this.#context);
		return result.ok ? result.value : null;
	}

	async #insideRoot(candidate: string, root: string): Promise<WorkspaceTarget | null> {
		const [realRoot, realFile] = await Promise.all([this.#canonical(root), this.#canonical(candidate)]);
		if (realRoot === null || realFile === null || !inside(realRoot, realFile)) return null;
		return { root: realRoot, relativePath: relative(realRoot, realFile).replaceAll("\\", "/"), absolutePath: realFile };
	}

	/** Resolve a workspace path: absolute paths are matched to a known root; a relative one is joined to `rootHint`. */
	async #workspaceTarget(path: string, rootHint?: string): Promise<WorkspaceTarget | null> {
		const roots = rootHint === undefined ? this.#roots() : [rootHint];
		for (const root of roots) {
			const candidate = isAbsolute(path) ? path : join(root, path);
			const target = await this.#insideRoot(candidate, root);
			if (target !== null) return target;
		}
		return null;
	}

	async #targetFile(target: WorkspaceTarget, resource: AssetResource): Promise<FileInfoLike> {
		const info = await this.#env.fileInfo(target.absolutePath, this.#context);
		if (!info.ok || info.value.kind !== "file") throw new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: target.absolutePath });
		if (info.value.size > MAX_ASSET_BYTES) throw new AssetWorkspaceAssetInspectionError({ resource, cause: new Error("File is too large to preview.") });
		return info.value;
	}

	/** `assets.createUrl` for a file resource. Throws the contract's typed asset errors on refusal. */
	async issue(resource: AssetResource): Promise<AssetCreateUrlResult> {
		const expiresAt = Date.now() + ASSET_TOKEN_TTL_MS;
		let claims: Claims;
		let fileName: string;
		if (resource._tag === "workspace-file" || resource._tag === "draft-workspace-file") {
			const rootHint = resource._tag === "draft-workspace-file" ? resource.cwd : undefined;
			const target = await this.#workspaceTarget(resource.path, rootHint);
			if (target === null) throw new AssetWorkspacePathValidationError({ resource, cause: new Error("Workspace file path must be relative to the project root.") });
			const extension = extensionOf(target.relativePath);
			const image = WORKSPACE_IMAGE_EXTENSIONS.has(extension);
			if (!image && !WORKSPACE_BROWSER_EXTENSIONS.has(extension)) throw new AssetPreviewTypeValidationError({ resource });
			await this.#targetFile(target, resource);
			fileName = basename(target.relativePath);
			claims = image
				? { version: 1, kind: "workspace-file-exact", workspaceRoot: target.root, relativePath: target.relativePath, expiresAt }
				: { version: 1, kind: "workspace-file", workspaceRoot: target.root, baseRelativePath: dirname(target.relativePath) || ".", expiresAt };
		} else if (resource._tag === "media-file") {
			const targetPath = await this.#mediaTarget(resource);
			await this.#targetFile({ root: "", relativePath: "", absolutePath: targetPath.absolutePath }, resource);
			if (mimeTypeOf(targetPath.absolutePath) === null || !MEDIA_EXTENSIONS.has(extensionOf(targetPath.absolutePath))) throw new AssetPreviewTypeValidationError({ resource });
			fileName = basename(targetPath.absolutePath);
			claims = { version: 1, kind: "media-file-exact", filePath: targetPath.absolutePath, expiresAt };
		} else {
			throw new AssetPreviewTypeValidationError({ resource });
		}
		const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
		const token = `${payload}.${this.#signer.signPayload(payload)}`;
		return { relativeUrl: `${ASSET_ROUTE_PREFIX}/${token}/${encodeURIComponent(fileName)}`, expiresAt };
	}

	async #mediaTarget(resource: Extract<AssetResource, { _tag: "media-file" }>): Promise<{ absolutePath: string }> {
		if (isAbsolute(resource.path)) {
			const canonical = await this.#canonical(resource.path);
			if (canonical !== null) return { absolutePath: canonical };
			throw new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: resource.path });
		}
		// T3 resolves a relative media path against the thread's workspace; this host has no thread lookup here, so use
		// the first known root. The file panel always sends an absolute path; this only serves a hand-built client.
		for (const root of this.#roots()) {
			const target = await this.#canonical(join(root, resource.path));
			if (target !== null) return { absolutePath: target };
		}
		throw new AssetWorkspaceAssetNotFoundError({ resource, checkedPath: resource.path });
	}

	/** Resolve a signed asset URL to bytes. Null on any failure: the HTTP route answers 404. */
	async resolve(token: string, relativePath: string): Promise<{ readonly bytes: Uint8Array; readonly mimeType: string; readonly fileName: string } | null> {
		const dot = token.indexOf(".");
		if (dot <= 0) return null;
		const payload = token.slice(0, dot);
		const signature = token.slice(dot + 1);
		if (!this.#signer.verifySignature(payload, signature)) return null;
		const claims = decodeClaims(payload);
		if (claims === null || claims.expiresAt <= Date.now()) return null;
		const decoded = decodeRelativePath(relativePath);
		if (decoded === null || decoded.length === 0) return null;
		const path = await this.#resolveClaimPath(claims, decoded);
		if (path === null) return null;
		const info = await this.#env.fileInfo(path, this.#context);
		if (!info.ok || info.value.kind !== "file" || info.value.size > MAX_ASSET_BYTES) return null;
		const read = await this.#env.readBinaryFile(path, this.#context);
		if (!read.ok || read.value.byteLength > MAX_ASSET_BYTES) return null;
		const mimeType = mimeTypeOf(path);
		return mimeType === null ? null : { bytes: read.value, mimeType, fileName: basename(path) };
	}

	async #resolveClaimPath(claims: Claims, requested: string): Promise<string | null> {
		if (claims.kind === "media-file-exact") {
			if (requested !== basename(claims.filePath)) return null;
			const canonical = await this.#canonical(claims.filePath);
			return canonical === claims.filePath ? canonical : null;
		}
		if (claims.kind === "workspace-file-exact") {
			if (requested !== basename(claims.relativePath)) return null;
			const root = await this.#canonical(claims.workspaceRoot);
			if (root === null) return null;
			const file = await this.#canonical(join(root, claims.relativePath));
			return file !== null && inside(root, file) ? file : null;
		}
		if (requested.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === ".." || segment.startsWith("."))) return null;
		if (!SUBASSET_EXTENSIONS.has(extensionOf(requested))) return null;
		const root = await this.#canonical(claims.workspaceRoot);
		if (root === null) return null;
		const relativePath = claims.baseRelativePath === "." ? requested : `${claims.baseRelativePath}/${requested}`;
		const file = await this.#canonical(join(root, relativePath));
		return file !== null && inside(root, file) ? file : null;
	}
}

type FileInfoLike = { readonly kind: "file" | "directory" | "symlink" | "other"; readonly size: number };
