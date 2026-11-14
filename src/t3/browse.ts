// The read-only directory listing for T3's "Add project" picker: T3's own semantics, copied from
// `apps/server/src/workspace/WorkspaceEntries.ts`, not forked (capabilities.md). It reads through the caller's
// `ExecutionEnv`, writes nothing, and adds no trust surface beyond the `/ws` bearer token and loopback bind every
// other call needs. `~` is the environment's home; a relative path resolves against the current project.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { basename, dirname, extname, join, resolve } from "node:path";

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
	/** The directory does not exist (T3 0.1.9: its mobile app then offers to create it). */
	readonly pathMissing: boolean;
	constructor(parentPath: string, cause?: unknown) {
		super(`Failed to read workspace directory '${parentPath}'.`, { cause });
		this.parentPath = parentPath;
		this.pathMissing = (cause as { code?: unknown } | undefined)?.code === "not_found";
	}
}

/** The environment's home, asked of its shell (a remote environment's home is its own, not this host's). A failed
 * answer is not kept, so the next call asks again. `undefined` when it cannot say. */
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
		void home.then((found) => found === undefined && homes.delete(env));
	}
	return home;
}

/** T3's `expandHomePath` against the environment's home: `~`, `~/…` and `~\…` expand, anything else is returned as
 * is. `undefined` when the path needs the home and the environment cannot say it. */
export async function expandEnvHome(env: ExecutionEnv, value: string, context: Context): Promise<string | undefined> {
	if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
	const home = await homeOf(env, context);
	return home === undefined ? undefined : value === "~" ? home : join(home, value.slice(2));
}

/** Resolve a browse target, mirroring T3's `resolveBrowseTarget`: `~` expands to the environment's home, absolute
 * paths resolve directly, an explicit-relative one needs the current project's `cwd`, and a Windows path on a
 * non-Windows server is refused. */
async function resolveBrowseTarget(input: { readonly partialPath: string; readonly cwd?: string; readonly env: ExecutionEnv }, platform: NodeJS.Platform, context: Context): Promise<string> {
	const expand = async (value: string) => {
		const expanded = await expandEnvHome(input.env, value, context);
		if (expanded === undefined) throw new BrowseReadDirectoryFailed(value, new Error("The environment did not say its home directory."));
		return expanded;
	};
	if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) throw new BrowseWindowsPathUnsupported();
	if (!isExplicitRelativePath(input.partialPath)) return resolve(await expand(input.partialPath));
	if (input.cwd === undefined || input.cwd === "") throw new BrowseCurrentProjectRequired();
	return resolve(await expand(input.cwd), input.partialPath);
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
	const resolved = await resolveBrowseTarget(input, platform, context);
	const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
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

/**
 * T3's `filesystem.getMetadata` (`WorkspaceFileSystem.getMetadata`), read through the environment: for each path a reply
 * mentions, whether it is a file (with its size, and the type its first bytes name when it has no extension), a
 * directory or something else; `null` for a path that is not absolute (after `~/`) or does not exist. Entries follow the
 * request's order; a repeated path is read once. The web app draws a reply's file chips from it.
 */
export async function filesystemMetadata(env: ExecutionEnv, paths: readonly string[], context: Context): Promise<(FileMetadata | null)[]> {
	const unique = [...new Set(paths)];
	const read = async (requested: string): Promise<FileMetadata | null> => {
		const path = await expandEnvHome(env, requested, context);
		if (path === undefined || !path.startsWith("/")) return null;
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
