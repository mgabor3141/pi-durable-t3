// T3's file RPCs — `projects.listEntries`, `projects.readFile`, `projects.writeFile`, `projects.searchEntries`,
// `projects.searchContents` — replicated from `apps/server/src/workspace/` (WorkspaceFileSystem, WorkspacePaths,
// WorkspaceEntries, WorkspaceSearchIndex, KnownWorkspaces) at the pinned release, and no more (docs/capabilities.md).
//
// Every read and write goes through the caller's `ExecutionEnv`, never `node:fs`: the file panel sees the same
// environment the agent's `read`/`write`/`bash` see. Reads, listings and searches may name any existing directory in
// that environment; writes stay inside a registered project root or a thread's working folder. T3's contract still
// talks in paths relative to the named `cwd` for file calls.
//
// Differences from T3, all deliberate (docs/capabilities.md, "File access"):
//   - reads, listings and searches may name any existing directory, not only workspace roots;
//   - an absolute read path is accepted; relative read paths stay confined to the named `cwd`;
//   - files are written through the environment, so atomicity and mode preservation are the environment's business,
//     not this layer's. A read-only file is refused as the environment refuses it.
//
// Failures are plain classes here (`EntriesError`, `FileError`); `rpc.ts` turns them into the contract's typed errors.
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ExecutionEnv, FileError as EnvFileError, FileInfo, Result } from "@earendil-works/pi-durable/env";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
	ProjectEntriesFailure,
	ProjectEntry,
	ProjectEntryKind,
	ProjectFileFailure,
	ProjectFileOperation,
	ProjectListEntriesResult,
	ProjectReadFileResult,
	ProjectSearchContentsResult,
	ProjectSearchEntriesResult,
} from "@t3tools/contracts";

/** `WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES`: a read returns at most this many bytes; `truncated` says more existed. */
export const READ_FILE_MAX_BYTES = 1024 * 1024;
/** The listing cap T3's index applies to a whole-tree listing. */
const INDEX_MAX_ENTRIES = 25_000;
/** The content-search budget and per-file match cap T3's index applies. */
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;

/** A list/search failure: `failure` is the contract's `ProjectEntriesFailure`. */
export class EntriesError extends Error {
	readonly name = "EntriesError";
	readonly failure: ProjectEntriesFailure;
	readonly context: { readonly normalizedCwd?: string; readonly timeout?: string; readonly detail?: string };
	constructor(failure: ProjectEntriesFailure, message: string, context: EntriesError["context"] = {}, cause?: unknown) {
		super(message, { cause });
		this.failure = failure;
		this.context = context;
	}
}

/** A read/write failure: `failure` is the contract's `ProjectFileFailure`. */
export class FileError extends Error {
	readonly name = "FileError";
	readonly failure: ProjectFileFailure;
	readonly context: {
		readonly resolvedPath?: string;
		readonly resolvedWorkspaceRoot?: string;
		readonly operation?: ProjectFileOperation;
		readonly operationPath?: string;
	};
	constructor(failure: ProjectFileFailure, message: string, context: FileError["context"] = {}, cause?: unknown) {
		super(message, { cause });
		this.failure = failure;
		this.context = context;
	}
}

const toPosix = (input: string) => input.replaceAll("\\", "/");

/** Absolute, normalized T3 path. T3 sends absolute paths; a relative one is refused by the caller. */
const normalizeCwd = (cwd: string) => resolve(cwd.trim());

/** `WorkspacePaths.resolveRelativePathWithinRoot`: lexical containment — absolute, `.`/empty and `..` escapes refuse. */
function resolveWithinRoot(workspaceRoot: string, requested: string): { absolutePath: string; relativePath: string } | null {
	const normalized = requested.trim();
	if (isAbsolute(normalized)) return null;
	const absolutePath = resolve(workspaceRoot, normalized);
	const relativeToRoot = toPosix(relative(workspaceRoot, absolutePath));
	if (relativeToRoot.length === 0 || relativeToRoot === "." || relativeToRoot.startsWith("../") || relativeToRoot === ".." || isAbsolute(relativeToRoot)) return null;
	return { absolutePath, relativePath: relativeToRoot };
}

/** Both paths must already be canonical. */
function isInsideRealRoot(realWorkspaceRoot: string, realPath: string): boolean {
	const rel = relative(realWorkspaceRoot, realPath);
	return !(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel));
}

/** Names git reads as `.git` on Windows too (`WorkspaceFileSystem.isGitMetadataName`). */
const isGitMetadataName = (segment: string) => {
	const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
	return name === ".GIT" || name === "GIT~1";
};

/** Whether a path names a git metadata folder; writes never land there. */
const inGitFolder = (path: string) => path.split(sep).some(isGitMetadataName);

/** `expandHomePath`: `~` and `~/…` expand to the home directory. Kept for T3's picker semantics on a local host; the
 * browse path uses the environment, so a remote environment's home is its own. */
function expandHome(value: string, home: string): string {
	if (value === "~") return home;
	if (value.startsWith("~/")) return resolve(home, value.slice(2));
	return value;
}

type WalkOptions = { readonly maxEntries?: number; readonly skipGit?: boolean };

/** One recursive walk over the environment, bounded like T3's index. Symbolic links are returned but never followed. */
async function walk(env: ExecutionEnv, root: string, context: Context, options: WalkOptions = {}): Promise<{ entries: ProjectEntry[]; truncated: boolean }> {
	const limit = options.maxEntries ?? INDEX_MAX_ENTRIES;
	const entries: ProjectEntry[] = [];
	const queue: string[] = [root];
	while (queue.length > 0 && entries.length < limit) {
		const directory = queue.shift()!;
		const listed = await env.listDir(directory, context);
		if (!listed.ok) continue;
		for (const info of listed.value) {
			if (entries.length >= limit) return { entries, truncated: true };
			if (info.name === ".git" && options.skipGit !== false) continue;
			const rel = toPosix(relative(root, info.path));
			if (rel === "" || rel.startsWith("../") || rel === "..") continue;
			if (info.kind === "directory") {
				entries.push({ path: rel, kind: "directory" });
				queue.push(info.path);
			} else if (info.kind === "file") {
				entries.push({ path: rel, kind: "file" });
			}
			// Symbolic links are listed neither as files nor as directories: following one is the caller's risk, and T3's
			// index treats a link as a link. A link to a directory is not descended into.
		}
	}
	return { entries, truncated: false };
}

/** `git check-ignore` over a bounded argv list, through the same environment: the set of ignored relative paths. */
async function gitIgnored(env: ExecutionEnv, root: string, paths: readonly string[], context: Context): Promise<ReadonlySet<string>> {
	if (paths.length === 0) return new Set();
	const hasGit = await env.exists(`${root}/.git`, context);
	if (!hasGit.ok || !hasGit.value) return new Set();
	const ignored = new Set<string>();
	const chunkSize = 1000;
	for (let offset = 0; offset < paths.length; offset += chunkSize) {
		const chunk = paths.slice(offset, offset + chunkSize);
		let output = "";
		const run = await env.exec(
			["git", "-c", "core.fsmonitor=false", "check-ignore", "--", ...chunk],
			{
				cwd: root,
				onOutput: (text, _context, info) => {
					if (info.stream === "stdout") output += text;
				},
			},
			context,
		);
		if (!run.ok || (run.value.exitCode !== 0 && run.value.exitCode !== 1)) break;
		for (const ignoredPath of output.split("\n")) if (ignoredPath !== "") ignored.add(toPosix(ignoredPath));
	}
	return ignored;
}

function withDirectoryAncestors(entries: readonly ProjectEntry[]): ProjectEntry[] {
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	for (const entry of entries) {
		let parent = entry.path.split("/").slice(0, -1).join("/");
		while (parent) {
			if (!byPath.has(parent)) byPath.set(parent, { path: parent, kind: "directory" });
			parent = parent.split("/").slice(0, -1).join("/");
		}
	}
	return [...byPath.values()];
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;
const codePointAt = (line: string, index: number) => {
	const codePoint = line.codePointAt(index);
	return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
};
function codePointBefore(line: string, index: number): string | undefined {
	if (index <= 0) return undefined;
	const previous = line.charCodeAt(index - 1);
	return codePointAt(line, previous >= 0xdc00 && previous <= 0xdfff ? index - 2 : index - 1);
}

type ContentQuery = { readonly query: string; readonly limit: number; readonly caseSensitive: boolean; readonly wholeWord: boolean; readonly useRegex: boolean };

function isWholeWordRange(line: string, range: { start: number; end: number }): boolean {
	if (range.end <= range.start) return false;
	const isWord = (character: string | undefined) => character !== undefined && WORD_CHARACTER.test(character);
	const leftIsBoundary = range.start === 0 || !isWord(codePointBefore(line, range.start)) || !isWord(codePointAt(line, range.start));
	const rightIsBoundary = range.end >= line.length || !isWord(codePointAt(line, range.end)) || !isWord(codePointBefore(line, range.end));
	return leftIsBoundary && rightIsBoundary;
}

/** `normalizeSearchQuery(query, { trimLeadingPattern: /^[@./]+/ })`. */
function normalizeSearchQuery(input: string): string {
	const trimmed = input.trim();
	return trimmed ? trimmed.replace(/^[@./]+/, "").toLowerCase() : "";
}

function lineMatches(query: ContentQuery): { ranges: (line: string) => { start: number; end: number }[]; fallback?: string } {
	if (!query.useRegex) {
		return {
			ranges: (line) => {
				const haystack = query.caseSensitive ? line : line.toLowerCase();
				const needle = query.caseSensitive ? query.query : query.query.toLowerCase();
				const found: { start: number; end: number }[] = [];
				if (needle === "") return found;
				for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
					const range = { start: index, end: index + needle.length };
					if (!query.wholeWord || isWholeWordRange(line, range)) found.push(range);
					if (found.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) break;
				}
				return found;
			},
		};
	}
	try {
		const regex = new RegExp(query.query, query.caseSensitive ? "g" : "gi");
		return {
			ranges: (line) => {
				const found: { start: number; end: number }[] = [];
				for (const match of line.matchAll(regex)) {
					const start = match.index ?? 0;
					const range = { start, end: start + match[0].length };
					if (match[0].length === 0) continue;
					if (!query.wholeWord || isWholeWordRange(line, range)) found.push(range);
					if (found.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) break;
				}
				return found;
			},
		};
	} catch (error) {
		const literal = query.query;
		return {
			ranges: (line) => {
				const haystack = query.caseSensitive ? line : line.toLowerCase();
				const needle = query.caseSensitive ? literal : literal.toLowerCase();
				const start = haystack.indexOf(needle);
				return start < 0 ? [] : [{ start, end: start + needle.length }];
			},
			fallback: error instanceof Error ? error.message : String(error),
		};
	}
}

export interface WorkspaceFilesOptions {
	/** The environment every read and write goes through. */
	readonly env: ExecutionEnv;
	/** Invocation context for environment calls; default `BACKGROUND_CONTEXT`. */
	readonly context?: Context;
	/** The folders a client-named `cwd` may write in: every registered project's root and every thread's working folder. Reads may name any existing directory. */
	readonly roots: () => readonly string[];
}

export class WorkspaceFiles {
	readonly #env: ExecutionEnv;
	readonly #context: Context;
	readonly #roots: () => readonly string[];

	constructor(options: WorkspaceFilesOptions) {
		this.#env = options.env;
		this.#context = options.context ?? BACKGROUND_CONTEXT;
		this.#roots = options.roots;
	}

	close(): Promise<void> {
		return Promise.resolve();
	}

	/** Canonical path, or an error the caller maps; the environment's own failure is kept. */
	async #canonical(path: string): Promise<Result<string, EnvFileError>> {
		return this.#env.canonicalPath(path, this.#context);
	}

	async #isKnown(cwd: string): Promise<boolean> {
		const real = await this.#canonical(normalizeCwd(cwd));
		if (!real.ok) return false;
		for (const root of this.#roots()) {
			const candidate = await this.#canonical(resolve(root));
			if (candidate.ok && candidate.value === real.value) return true;
		}
		return false;
	}

	/** `WorkspacePaths.normalizeWorkspaceRoot` for any existing directory; a missing one is `workspace_root_not_found`. */
	async #entriesRoot(cwd: string): Promise<string> {
		const normalized = normalizeCwd(cwd);
		const canonical = await this.#canonical(normalized);
		const info = canonical.ok ? await this.#env.fileInfo(canonical.value, this.#context) : canonical;
		if (!info.ok) {
			if (info.error.code === "not_found") throw new EntriesError("workspace_root_not_found", `Workspace root does not exist: ${normalized}`, { normalizedCwd: normalized }, info.error);
			throw new EntriesError("workspace_root_stat_failed", `Failed to stat workspace root '${normalized}' during 'validate-existing'.`, { normalizedCwd: normalized, detail: "validate-existing" }, info.error);
		}
		if (info.value.kind !== "directory") throw new EntriesError("workspace_root_not_directory", `Workspace root is not a directory: ${normalized}`, { normalizedCwd: normalized });
		return normalized;
	}

	/** A write call on an unknown root is `workspace_path_outside_root`, as T3 maps its `UnknownWorkspaceError`. */
	async #assertKnownFileRoot(cwd: string): Promise<void> {
		if (!(await this.#isKnown(cwd))) {
			throw new FileError("workspace_path_outside_root", `'${cwd}' is not a registered project or a thread's working folder.`);
		}
	}

	/** The real path of the deepest existing ancestor of `target`, checking the target when it exists. */
	async #canonicalTarget(_realWorkspaceRoot: string, target: string, allowMissing: boolean): Promise<{ path: string; exists: boolean }> {
		let candidate = target;
		const suffix: string[] = [];
		for (;;) {
			const canonical = await this.#canonical(candidate);
			if (canonical.ok) {
				// A missing tail is appended to the canonical ancestor, so a write creates the file where it was named.
				return { path: suffix.length === 0 ? canonical.value : join(canonical.value, ...suffix), exists: suffix.length === 0 };
			}
			if (!allowMissing || canonical.error.code !== "not_found") throw canonical.error;
			const info = await this.#env.fileInfo(candidate, this.#context);
			if (info.ok) throw canonical.error;
			if (info.error.code !== "not_found") throw canonical.error;
			const parent = dirname(candidate);
			if (parent === candidate) throw canonical.error;
			suffix.unshift(basename(candidate));
			candidate = parent;
		}
	}

	// --- projects.listEntries -----------------------------------------------------------------------------------------

	async list(input: { readonly cwd: string; readonly directoryPath?: string }): Promise<ProjectListEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		if (input.directoryPath === undefined) {
			const walked = await walk(this.#env, cwd, this.#context);
			const ignored = await gitIgnored(this.#env, cwd, walked.entries.map((entry) => entry.path), this.#context);
			const withIgnored = walked.entries.map((entry) => (ignored.has(entry.path) ? { ...entry, ignored: true } : entry));
			const sorted = withDirectoryAncestors(withIgnored).toSorted((left, right) => left.path.localeCompare(right.path));
			const entries = sorted.slice(0, INDEX_MAX_ENTRIES);
			return { entries, truncated: walked.truncated || entries.length < sorted.length };
		}
		const directoryPath = input.directoryPath;
		if (directoryPath !== "" && /(^|\/)\.git(\/|$)/.test(directoryPath)) {
			throw new EntriesError("directory_list_failed", `Failed to read workspace directory '${resolve(cwd, directoryPath)}' while browsing '${directoryPath}' from '${cwd}'.`, { normalizedCwd: cwd });
		}
		const target = directoryPath === "" ? { absolutePath: cwd, relativePath: "" } : resolveWithinRoot(cwd, directoryPath);
		if (target === null) throw new EntriesError("directory_list_failed", `Failed to read workspace directory '${resolve(cwd, directoryPath)}' while browsing '${directoryPath}' from '${cwd}'.`, { normalizedCwd: cwd });
		const realRoot = await this.#canonical(cwd);
		const realTarget = await this.#canonical(target.absolutePath);
		if (!realRoot.ok || !realTarget.ok || !isInsideRealRoot(realRoot.value, realTarget.value)) {
			throw new EntriesError("directory_list_failed", `Failed to read workspace directory '${target.absolutePath}' while browsing '${directoryPath}' from '${cwd}'.`, { normalizedCwd: cwd, detail: `Failed to read workspace directory '${target.absolutePath}' while browsing '${directoryPath}' from '${cwd}'.` }, !realTarget.ok ? realTarget.error : undefined);
		}
		const listed = await this.#env.listDir(target.absolutePath, this.#context);
		if (!listed.ok) {
			throw new EntriesError("directory_list_failed", `Failed to read workspace directory '${target.absolutePath}' while browsing '${directoryPath}' from '${cwd}'.`, { normalizedCwd: cwd, detail: `Failed to read workspace directory '${target.absolutePath}' while browsing '${directoryPath}' from '${cwd}'.` }, listed.error);
		}
		const entries = listed.value.flatMap((info): ProjectEntry[] => {
			if (info.name === ".git" || (info.kind !== "directory" && info.kind !== "file")) return [];
			const path = target.relativePath ? `${target.relativePath}/${info.name}` : info.name;
			return [{ path, kind: info.kind }];
		});
		const ignored = await gitIgnored(this.#env, cwd, entries.map((entry) => entry.path), this.#context);
		return { entries: entries.map((entry) => (ignored.has(entry.path) ? { ...entry, ignored: true } : entry)), truncated: false };
	}

	// --- projects.searchEntries / projects.searchContents -------------------------------------------------------------

	async searchEntries(input: { readonly cwd: string; readonly query: string; readonly limit: number; readonly kind?: ProjectEntryKind; readonly imageOnly?: boolean }): Promise<ProjectSearchEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const walked = await walk(this.#env, cwd, this.#context);
		const ignored = await gitIgnored(this.#env, cwd, walked.entries.map((entry) => entry.path), this.#context);
		const query = normalizeSearchQuery(input.query);
		const entries: ProjectEntry[] = [];
		for (const entry of walked.entries) {
			if (ignored.has(entry.path)) continue;
			if (input.kind !== undefined && entry.kind !== input.kind) continue;
			if (input.imageOnly === true && (entry.kind !== "file" || !isProjectFaviconPath(entry.path))) continue;
			if (query !== "" && !entry.path.toLowerCase().includes(query)) continue;
			entries.push(entry);
			if (entries.length >= input.limit) break;
		}
		return { entries: entries.slice(0, input.limit), truncated: entries.length >= input.limit && entries.length < walked.entries.length };
	}

	async searchContents(input: { readonly cwd: string } & ContentQuery): Promise<ProjectSearchContentsResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const walked = await walk(this.#env, cwd, this.#context);
		const ignored = await gitIgnored(this.#env, cwd, walked.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path), this.#context);
		const matcher = lineMatches(input);
		const matches: ProjectSearchContentsResult["matches"][number][] = [];
		const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
		let truncated = false;
		for (const entry of walked.entries) {
			if (entry.kind !== "file" || ignored.has(entry.path)) continue;
			if (performance.now() > deadline || matches.length >= input.limit) {
				truncated = true;
				break;
			}
			const text = await this.#env.readTextFile(`${cwd}/${entry.path}`, this.#context);
			if (!text.ok) continue;
			if (text.value.includes("\0")) continue;
			const lines = text.value.split("\n");
			for (const [index, line] of lines.entries()) {
				const ranges = matcher.ranges(line).filter((range) => !input.wholeWord || isWholeWordRange(line, range));
				if (ranges.length === 0) continue;
				matches.push({ path: entry.path, lineNumber: index + 1, lineContent: line, matchRanges: ranges });
				if (matches.length >= input.limit) {
					truncated = true;
					break;
				}
				if (ranges.length >= CONTENT_SEARCH_MAX_MATCHES_PER_FILE) break;
			}
			if (matches.length >= input.limit) {
				truncated = true;
				break;
			}
		}
		return {
			matches: matches.slice(0, input.limit),
			truncated,
			...(matcher.fallback === undefined ? {} : { regexFallbackError: matcher.fallback }),
		};
	}

	// --- projects.readFile --------------------------------------------------------------------------------------------

	async readFile(input: { readonly cwd: string; readonly relativePath: string; readonly allowMissing?: boolean }): Promise<ProjectReadFileResult> {
		const cwd = normalizeCwd(input.cwd);
		const requested = input.relativePath.trim();
		const absolute = isAbsolute(requested);
		const target = absolute
			? { absolutePath: resolve(requested), relativePath: toPosix(requested) }
			: resolveWithinRoot(cwd, requested);
		if (target === null) throw new FileError("workspace_path_outside_root", `Workspace file path must be relative to the project root: ${input.relativePath}`);
		let realWorkspaceRootPath: string | undefined;
		if (!absolute) {
			const realWorkspaceRoot = await this.#canonical(cwd).catch((cause: unknown) => {
				throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, cause);
			});
			if (!realWorkspaceRoot.ok) throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, realWorkspaceRoot.error);
			realWorkspaceRootPath = realWorkspaceRoot.value;
		}
		let resolved: { path: string; exists: boolean };
		try {
			resolved = await this.#canonicalTarget(realWorkspaceRootPath ?? "", target.absolutePath, input.allowMissing === true);
		} catch (cause) {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-target' failed at '${target.absolutePath}'.`, { resolvedPath: target.absolutePath, operation: "realpath-target", operationPath: target.absolutePath }, cause);
		}
		if (realWorkspaceRootPath !== undefined && !isInsideRealRoot(realWorkspaceRootPath, resolved.path)) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${resolved.path}`, { resolvedPath: resolved.path, resolvedWorkspaceRoot: realWorkspaceRootPath });
		}
		const absent = { relativePath: target.relativePath, contents: "", byteLength: 0, truncated: false, exists: false };
		if (!resolved.exists) return absent;
		const realTargetPath = resolved.path;
		const failed = (operation: ProjectFileOperation, cause: unknown) =>
			new FileError("operation_failed", `Workspace file operation '${operation}' failed at '${realTargetPath}'.`, { resolvedPath: realTargetPath, operation, operationPath: realTargetPath }, cause);
		const info = await this.#env.fileInfo(realTargetPath, this.#context);
		if (!info.ok) {
			if (input.allowMissing === true && info.error.code === "not_found") return absent;
			throw failed("stat", info.error);
		}
		if (info.value.kind !== "file") throw new FileError("path_not_file", `Workspace path '${input.relativePath}' in '${cwd}' is not a file: ${realTargetPath}`, { resolvedPath: realTargetPath });
		const bytesToRead = Math.min(info.value.size, READ_FILE_MAX_BYTES);
		const opened = await this.#env.openBinaryReader(realTargetPath, undefined, this.#context);
		if (!opened.ok) {
			if (input.allowMissing === true && opened.error.code === "not_found") return absent;
			throw failed("open", opened.error);
		}
		try {
			const read = await opened.value.read(0, bytesToRead, this.#context);
			if (!read.ok) throw failed("read", read.error);
			const fileBytes = read.value;
			// T3's binary test: a NUL byte in what was read.
			if (fileBytes.includes(0)) throw new FileError("binary_file", `Workspace file '${input.relativePath}' in '${cwd}' is binary and cannot be previewed as text.`, { resolvedPath: realTargetPath });
			return { relativePath: target.relativePath, contents: new TextDecoder("utf-8").decode(fileBytes), byteLength: info.value.size, truncated: info.value.size > READ_FILE_MAX_BYTES };
		} finally {
			await opened.value.close(this.#context).catch(() => {});
		}
	}

	// --- projects.writeFile -------------------------------------------------------------------------------------------

	async writeFile(input: { readonly cwd: string; readonly relativePath: string; readonly contents: string }): Promise<{ relativePath: string }> {
		await this.#assertKnownFileRoot(input.cwd);
		const cwd = normalizeCwd(input.cwd);
		const target = resolveWithinRoot(cwd, input.relativePath);
		if (target === null) throw new FileError("workspace_path_outside_root", `Workspace file path must be relative to the project root: ${input.relativePath}`);
		// Git runs config and hooks from its own folders, so a write never lands in one.
		if (inGitFolder(target.absolutePath)) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${target.absolutePath}`, { resolvedPath: target.absolutePath, resolvedWorkspaceRoot: cwd });
		}
		const realWorkspaceRoot = await this.#canonical(cwd);
		if (!realWorkspaceRoot.ok) throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, realWorkspaceRoot.error);
		// The deepest existing ancestor resolves to its real path before the root check, so neither the file nor the
		// directories created for it can follow a symlink out of the root. A dangling symlink is refused, not written through.
		let realTargetPath: string;
		try {
			realTargetPath = (await this.#canonicalTarget(realWorkspaceRoot.value, target.absolutePath, true)).path;
		} catch (cause) {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-target' failed at '${target.absolutePath}'.`, { resolvedPath: target.absolutePath, operation: "realpath-target", operationPath: target.absolutePath }, cause);
		}
		if (!isInsideRealRoot(realWorkspaceRoot.value, realTargetPath)) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${realTargetPath}`, { resolvedPath: realTargetPath, resolvedWorkspaceRoot: realWorkspaceRoot.value });
		}
		// The lexical guard above cannot see a link's target: check the real path too, so `hooks -> .git/hooks` is refused.
		if (inGitFolder(realTargetPath)) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${realTargetPath}`, { resolvedPath: realTargetPath, resolvedWorkspaceRoot: realWorkspaceRoot.value });
		}
		const directory = dirname(realTargetPath);
		const made = await this.#env.createDir(directory, { recursive: true }, this.#context);
		if (!made.ok) {
			throw new FileError("operation_failed", `Workspace file operation 'make-directory' failed at '${directory}'.`, { resolvedPath: realTargetPath, operation: "make-directory", operationPath: directory }, made.error);
		}
		const written = await this.#env.writeFile(realTargetPath, input.contents, this.#context);
		if (!written.ok) {
			throw new FileError("operation_failed", `Workspace file operation 'write-file' failed at '${realTargetPath}'.`, { resolvedPath: realTargetPath, operation: "write-file", operationPath: realTargetPath }, written.error);
		}
		return { relativePath: target.relativePath };
	}
}

/** `shared/filePreview`'s image extensions plus `.icns` (`isProjectFaviconPath`), the contract's `ProjectFaviconPath` set. */
const IMAGE_EXTENSIONS = [".avif", ".gif", ".icns", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"];
function isProjectFaviconPath(path: string): boolean {
	return IMAGE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}
