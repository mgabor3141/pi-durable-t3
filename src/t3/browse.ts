// The read-only directory listing for T3's "Add project" picker: T3's own semantics, copied from
// `apps/server/src/workspace/WorkspaceEntries.ts`, not forked (capabilities.md). It reads through the caller's
// `ExecutionEnv`, writes nothing, and adds no trust surface beyond the `/ws` bearer token and loopback bind every
// other call needs. T3 paths are absolute in the environment; a relative path resolves against the current project.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { basename, dirname, resolve } from "node:path";

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
