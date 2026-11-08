// The read-only directory listing for T3's "Add project" picker: T3's own semantics, copied from
// `apps/server/src/workspace/WorkspaceEntries.ts`, not forked (capabilities.md). It reads through the caller's
// `ExecutionEnv`, writes nothing, and adds no trust surface beyond the `/ws` bearer token and loopback bind every
// other call needs. T3 paths are absolute in the environment; a relative path resolves against the current project.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { basename, dirname, extname, resolve } from "node:path";

/** Mirror of `@t3tools/shared/path`'s `isWindowsAbsolutePath` (a Windows path is refused on a non-Windows server). */
function isWindowsAbsolutePath(value: string): boolean {
	return value.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(value);
}

/** Mirror of `isExplicitRelativePath`: a leading `.`/`..` (with `/` or `\`), which resolves against the current project. */
function isExplicitRelativePath(value: string): boolean {
	return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

export type BrowseEntry = { readonly name: string; readonly fullPath: string };
export type BrowseResult = { readonly parentPath: string; readonly entries: readonly BrowseEntry[] };

/** The failures `FilesystemBrowseError.classify`, so the handler builds the contract's typed error. */
export class BrowseWindowsPathUnsupported extends Error {
	readonly name = "BrowseWindowsPathUnsupported";
}
export class BrowseCurrentProjectRequired extends Error {
	readonly name = "BrowseCurrentProjectRequired";
}
export class BrowseReadDirectoryFailed extends Error {
	readonly name = "BrowseReadDirectoryFailed";
	readonly parentPath: string;
	constructor(parentPath: string, cause?: unknown) {
		super(`Failed to read workspace directory '${parentPath}'.`, { cause });
		this.parentPath = parentPath;
	}
}

/** Resolve a browse target, mirroring T3: absolute paths resolve directly, an explicit-relative one needs the current
 * project's `cwd`, and a Windows path on a non-Windows server is refused. `~` is not expanded: the environment has its
 * own home, and T3's picker works in absolute paths. */
function resolveBrowseTarget(partialPath: string, cwd: string | undefined, platform: NodeJS.Platform): string {
	if (platform !== "win32" && isWindowsAbsolutePath(partialPath)) throw new BrowseWindowsPathUnsupported();
	if (!isExplicitRelativePath(partialPath)) return resolve(partialPath);
	if (cwd === undefined || cwd === "") throw new BrowseCurrentProjectRequired();
	return resolve(cwd, partialPath);
}

/** Browse one directory for the picker: reads the target's PARENT (a trailing separator means the target is the
 * directory), returning only subdirectories, prefix-filtered by the target's basename. */
export async function browseFilesystem(input: {
	readonly partialPath: string;
	readonly cwd?: string;
	readonly env: ExecutionEnv;
	readonly context?: Context;
	readonly platform?: NodeJS.Platform;
}): Promise<BrowseResult> {
	const platform = input.platform ?? process.platform;
	const context = input.context ?? BACKGROUND_CONTEXT;
	const resolved = resolveBrowseTarget(input.partialPath, input.cwd, platform);
	const endsWithSeparator = /[\\/]$/.test(input.partialPath);
	const parentPath = endsWithSeparator ? resolved : dirname(resolved);
	const prefix = endsWithSeparator ? "" : basename(resolved);

	const listed = await input.env.listDir(parentPath, context);
	if (!listed.ok) {
		// T3 treats an unreadable directory (permissions) as an empty list, not a hard failure; other errors surface.
		if (listed.error.code === "permission_denied") return { parentPath, entries: [] };
		throw new BrowseReadDirectoryFailed(parentPath, listed.error);
	}

	const showHidden = endsWithSeparator || prefix.startsWith(".");
	const lowerPrefix = prefix.toLowerCase();
	const entries: BrowseEntry[] = [];
	for (const info of listed.value) {
		if (info.kind !== "directory") continue;
		if (!info.name.toLowerCase().startsWith(lowerPrefix)) continue;
		if (!showHidden && info.name.startsWith(".")) continue;
		entries.push({ name: info.name, fullPath: info.path });
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { parentPath, entries };
}

// ---- file metadata (T3's `filesystem.getMetadata`) ----------------------------------------------------------------

/** T3's `fileHeaderMimeType` (`workspace/fileHeaderMimeType.ts`): the type an extensionless file's first bytes name. */
export function fileHeaderMimeType(bytes: Uint8Array): string | undefined {
	const startsWith = (signature: readonly number[], offset = 0) => signature.every((byte, index) => bytes[offset + index] === byte);
	if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith([0x50, 0x4b, 0x03, 0x04])) return "application/zip";
	if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	const header = new TextDecoder().decode(bytes);
	if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "image/gif";
	if (header.startsWith("%PDF-")) return "application/pdf";
	if (header.startsWith("SQLite format 3\0")) return "application/vnd.sqlite3";
	if (!header.startsWith("#!")) return undefined;
	const interpreter = header.split("\n", 1)[0] ?? "";
	if (/\bpython[\d.]*\b/.test(interpreter)) return "text/x-python";
	if (/\b(?:node|nodejs)\b/.test(interpreter)) return "text/javascript";
	if (/\bruby\b/.test(interpreter)) return "text/x-ruby";
	if (/\b(?:sh|bash|zsh|fish)\b/.test(interpreter)) return "text/x-shellscript";
	return undefined;
}

export type FileMetadata = { kind: "file"; byteLength: number; mimeType?: string } | { kind: "directory" } | { kind: "other" };

/** The environment's home, for `~/` paths: asked of its shell once. `undefined` when it cannot say. */
const homes = new WeakMap<ExecutionEnv, Promise<string | undefined>>();
function homeOf(env: ExecutionEnv, context: Context): Promise<string | undefined> {
	let home = homes.get(env);
	if (home === undefined) {
		let stdout = "";
		home = env
			.exec("printf %s \"$HOME\"", { onOutput: (text, _context, info) => void (info.stream === "stdout" && (stdout += text)) }, context)
			.then((result) => (result.ok && result.value.exitCode === 0 && stdout.startsWith("/") ? stdout : undefined))
			.catch(() => undefined);
		homes.set(env, home);
	}
	return home;
}

/**
 * T3's `filesystem.getMetadata` (`WorkspaceFileSystem.getMetadata`), read through the environment: for each path a reply
 * mentions, whether it is a file (with its size, and the type its first bytes name when it has no extension), a
 * directory or something else; `null` for a path that is not absolute (after `~/`) or does not exist. Entries follow the
 * request's order; a repeated path is read once. The web app draws a reply's file chips from it.
 */
export async function filesystemMetadata(env: ExecutionEnv, paths: readonly string[], context: Context): Promise<(FileMetadata | null)[]> {
	const unique = [...new Set(paths)];
	const read = async (requested: string): Promise<FileMetadata | null> => {
		let path = requested;
		if (path === "~" || path.startsWith("~/")) {
			const home = await homeOf(env, context);
			if (home === undefined) return null;
			path = home + path.slice(1);
		}
		if (!path.startsWith("/")) return null;
		const info = await env.fileInfo(path, context);
		if (!info.ok) return null;
		if (info.value.kind === "directory") return { kind: "directory" };
		if (info.value.kind !== "file") return { kind: "other" };
		const byteLength = info.value.size;
		let mimeType: string | undefined;
		if (extname(path) === "" && byteLength > 0) {
			const reader = await env.openBinaryReader(path, undefined, context);
			if (reader.ok) {
				try {
					const head = await reader.value.read(0, 512, context);
					if (head.ok) mimeType = fileHeaderMimeType(head.value);
				} finally {
					await reader.value.close(context);
				}
			}
		}
		return { kind: "file", byteLength, ...(mimeType === undefined ? {} : { mimeType }) };
	};
	const entries = new Map<string, FileMetadata | null>();
	for (let index = 0; index < unique.length; index += 8) {
		const batch = unique.slice(index, index + 8);
		const results = await Promise.all(batch.map((path) => read(path).catch(() => null)));
		batch.forEach((path, offset) => entries.set(path, results[offset]!));
	}
	return paths.map((path) => entries.get(path) ?? null);
}
