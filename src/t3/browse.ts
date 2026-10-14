// The read-only directory listing that feeds T3's "Add project" picker — the same semantics as T3's own server
// (`apps/server/src/workspace/WorkspaceEntries.ts`), copied, not forked: resolve an absolute path (`~` expanded),
// resolve an explicit-relative path against the current project's `cwd` (a relative path with no cwd is refused),
// read the parent directory, return ONLY subdirectories, prefix-filtered (hidden ones shown once the prefix starts
// with `.`), an unreadable directory answering an empty list. This reads the filesystem; it writes nothing, and adds
// no new trust surface — the facet reaches it over the same `/ws` bearer token and loopback bind as every other call.
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Mirror of `@t3tools/shared/path`'s `isWindowsAbsolutePath` (a Windows path is refused on a non-Windows server). */
function isWindowsAbsolutePath(value: string): boolean {
	return value.startsWith("\\\\") || /^[a-zA-Z]:([/\\]|$)/.test(value);
}

/** Mirror of `isExplicitRelativePath`: a leading `.`/`..` (with `/` or `\`), which resolves against the current project. */
function isExplicitRelativePath(value: string): boolean {
	return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

/** Mirror of T3's `expandHomePathWith`: `~` and `~/` (or `~\`) expand to the home dir; anything else is unchanged. */
function expandHomePath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
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

/** Resolve a browse target, mirroring T3: an absolute path (with `~`) resolves directly; an explicit-relative one
 * needs the current project's `cwd`; a Windows path on a non-Windows server is refused. */
function resolveBrowseTarget(partialPath: string, cwd: string | undefined, platform: NodeJS.Platform): string {
	if (platform !== "win32" && isWindowsAbsolutePath(partialPath)) throw new BrowseWindowsPathUnsupported();
	if (!isExplicitRelativePath(partialPath)) return resolve(expandHomePath(partialPath));
	if (cwd === undefined || cwd === "") throw new BrowseCurrentProjectRequired();
	return resolve(expandHomePath(cwd), partialPath);
}

/** Browse one directory for the picker. Reads the parent of the target (a trailing separator means the target IS the
 * directory, filtered by an empty prefix; otherwise the basename is the prefix). Only subdirectories are returned. */
export async function browseFilesystem(input: { readonly partialPath: string; readonly cwd?: string; readonly platform?: NodeJS.Platform }): Promise<BrowseResult> {
	const platform = input.platform ?? process.platform;
	const resolved = resolveBrowseTarget(input.partialPath, input.cwd, platform);
	const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
	const parentPath = endsWithSeparator ? resolved : dirname(resolved);
	const prefix = endsWithSeparator ? "" : basename(resolved);

	let dirents: Dirent[];
	try {
		dirents = await readdir(parentPath, { withFileTypes: true });
	} catch (error) {
		// T3 treats an unreadable directory (permissions) as an empty list, not a hard failure; other errors surface.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") return { parentPath, entries: [] };
		throw new BrowseReadDirectoryFailed(parentPath, error);
	}

	const showHidden = endsWithSeparator || prefix.startsWith(".");
	const lowerPrefix = prefix.toLowerCase();
	const entries: BrowseEntry[] = [];
	for (const dirent of dirents) {
		if (dirent.isDirectory() && dirent.name.toLowerCase().startsWith(lowerPrefix) && (showHidden || !dirent.name.startsWith("."))) {
			entries.push({ name: dirent.name, fullPath: join(parentPath, dirent.name) });
		}
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { parentPath, entries };
}
