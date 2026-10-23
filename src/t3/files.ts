// T3's file RPCs — `projects.listEntries`, `projects.readFile`, `projects.writeFile`, `projects.searchEntries`,
// `projects.searchContents` — replicated from `apps/server/src/workspace/` (WorkspaceFileSystem, WorkspacePaths,
// WorkspaceEntries, WorkspaceSearchIndex, KnownWorkspaces) at the pinned release, and no more (docs/capabilities.md).
//
// Differences from T3, all deliberate (docs/capabilities.md, "File access"):
//   - a `cwd` must be a workspace root this host knows (a registered project's root or a thread's working folder) for
//     EVERY call, not only writes. This scopes the panel; it is not a sandbox: a paired client can register any folder
//     as a project (and can ask the agent to read anything), so pairing is the security boundary;
//   - an absolute (or `~/`) host path is refused on read, where T3 reads it in place;
//   - a write is atomic (a temp file in the target's directory, then a rename) where T3 truncates and rewrites in place.
//     A read-only file is refused as T3 refuses it; a read-only directory refuses the temp file, where T3 could write.
//
// Failures are plain classes here (`EntriesError`, `FileError`); `rpc.ts` turns them into the contract's typed errors.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { GrepResult, FileFinder as FileFinderType, FileItem, GrepCursor, MixedItem, MixedSearchResult, Result, SearchResult, DirItem, DirSearchResult } from "@ff-labs/fff-node";
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
/** `WorkspaceSearchIndex`: the listing cap, the index scan timeout, the idle lifetime of an index, the content-search budget. */
const INDEX_MAX_ENTRIES = 25_000;
const INDEX_PAGE_SIZE = INDEX_MAX_ENTRIES + 2;
const INDEX_SCAN_TIMEOUT_MS = 15_000;
const INDEX_SCAN_TIMEOUT = "15 seconds";
const INDEX_IDLE_TTL_MS = 15 * 60 * 1000;
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
/** `WorkspaceEntries`: paths sent to one `git check-ignore` call. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

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

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

/** `expandHomePath`: `~` and `~/…` expand to the home directory. */
function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

const normalizeCwd = (cwd: string) => resolve(expandHome(cwd.trim()));
const toPosix = (input: string) => input.replaceAll("\\", "/");

/** `WorkspacePaths.resolveRelativePathWithinRoot`: lexical containment — absolute, `.`/empty and `..` escapes refuse. */
function resolveWithinRoot(workspaceRoot: string, requested: string): { absolutePath: string; relativePath: string } | null {
	const normalized = requested.trim();
	if (isAbsolute(normalized)) return null;
	const absolutePath = resolve(workspaceRoot, normalized);
	const relativeToRoot = toPosix(relative(workspaceRoot, absolutePath));
	if (relativeToRoot.length === 0 || relativeToRoot === "." || relativeToRoot.startsWith("../") || relativeToRoot === ".." || isAbsolute(relativeToRoot)) return null;
	return { absolutePath, relativePath: relativeToRoot };
}

/** Both paths must already be real paths. */
function isInsideRealRoot(realWorkspaceRoot: string, realPath: string): boolean {
	const rel = relative(realWorkspaceRoot, realPath);
	return !(rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel));
}

/** Names git reads as `.git` on Windows too (`WorkspaceFileSystem.isGitMetadataName`). */
const isGitMetadataName = (segment: string) => {
	const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
	return name === ".GIT" || name === "GIT~1";
};

/** `WorkspaceFileSystem.isInGitFolder`: git runs config and hooks from its own folders, so a write never lands in one. */
async function isInGitFolder(absolutePath: string): Promise<boolean> {
	if (absolutePath.split(sep).some(isGitMetadataName)) return true;
	for (let folder = dirname(absolutePath); ; folder = dirname(folder)) {
		const [head, commondir, objects, refs, dotGit] = await Promise.all(
			["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
				fsp.lstat(join(folder, name)).catch((error: NodeJS.ErrnoException) => {
					// Any other failure leaves the folder unknown, so the write is refused.
					if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
					throw error;
				}),
			),
		);
		if (head && (commondir || (objects && refs))) return true;
		if (dotGit?.isFile() || dirname(folder) === folder) return false;
	}
}

/** `git` with optional stdin, bounded; `undefined` when git is missing, times out or prints too much (T3's `orElseSucceed`). */
function runGit(args: readonly string[], cwd: string, stdin: string, timeoutMs: number, maxOutputBytes: number): Promise<{ exitCode: number; stdout: string } | undefined> {
	return new Promise((done) => {
		let settled = false;
		const finish = (value: { exitCode: number; stdout: string } | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done(value);
		};
		const child = spawn("git", [...args], { cwd, stdio: ["pipe", "pipe", "ignore"] });
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, timeoutMs);
		const chunks: Buffer[] = [];
		let size = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > maxOutputBytes) {
				child.kill();
				finish(undefined);
				return;
			}
			chunks.push(chunk);
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === null ? undefined : { exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") }));
		child.stdin.on("error", () => {});
		child.stdin.end(stdin);
	});
}

// --- search index (`WorkspaceSearchIndex`, backed by the same `@ff-labs/fff-node` T3 uses) -------------------------------

type IndexVariant = "paths" | "content";
type Index = { readonly finder: FileFinderType; initialScanTimedOut: boolean; timer?: NodeJS.Timeout };

const trimDirectorySeparator = (input: string) => (input.endsWith("/") ? input.slice(0, -1) : input);
const parentPathOf = (input: string) => {
	const index = input.lastIndexOf("/");
	return index === -1 ? undefined : input.slice(0, index);
};

function toProjectEntry(item: MixedItem): ProjectEntry | null {
	const path = trimDirectorySeparator(toPosix(item.item.relativePath));
	return path ? { path, kind: item.type } : null;
}
function toFileEntry(item: FileItem): ProjectEntry | null {
	const path = trimDirectorySeparator(toPosix(item.relativePath));
	return path ? { path, kind: "file" } : null;
}
function toDirectoryEntry(item: DirItem): ProjectEntry | null {
	const path = trimDirectorySeparator(toPosix(item.relativePath));
	return path ? { path, kind: "directory" } : null;
}

/** `shared/filePreview`'s image extensions plus `.icns` (`isProjectFaviconPath`), the contract's `ProjectFaviconPath` set. */
const IMAGE_EXTENSIONS = [".avif", ".gif", ".icns", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"];
const isProjectFaviconPath = (path: string) => IMAGE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

function mapFileSearchResult(result: SearchResult, limit: number, imageOnly = false): ProjectSearchEntriesResult {
	const entries = result.items.flatMap((item) => {
		const entry = toFileEntry(item);
		return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
	});
	return { entries: entries.slice(0, limit), truncated: entries.length > limit || result.totalMatched > result.items.length };
}

function mapDirectorySearchResult(result: DirSearchResult, limit: number): ProjectSearchEntriesResult {
	const entries = result.items.flatMap((item) => {
		const entry = toDirectoryEntry(item);
		return entry ? [entry] : [];
	});
	const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
	return { entries: entries.slice(0, limit), truncated: result.totalMatched - rootDirectoryCount > limit };
}

function mapMixedSearchResult(result: MixedSearchResult, limit: number): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
	const entries: ProjectEntry[] = [];
	for (const item of result.items) {
		const entry = toProjectEntry(item);
		if (entry) entries.push(entry);
		if (entries.length >= limit) break;
	}
	const rootDirectoryCount = result.items.some((item) => item.type === "directory" && item.item.relativePath.length === 0) ? 1 : 0;
	return { entries, truncated: result.totalMatched - rootDirectoryCount > limit };
}

function withDirectoryAncestors(entries: readonly ProjectEntry[]): ProjectEntry[] {
	const byPath = new Map(entries.map((entry) => [entry.path, entry]));
	for (const entry of entries) {
		let parent = parentPathOf(entry.path);
		while (parent) {
			if (!byPath.has(parent)) byPath.set(parent, { path: parent, kind: "directory" });
			parent = parentPathOf(parent);
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

function buildContentSearchQuery(input: ContentQuery): { readonly searchQuery: string; readonly regexMode: boolean } {
	if (input.caseSensitive) return { searchQuery: input.query, regexMode: input.useRegex };
	return input.useRegex ? { searchQuery: `(?i)${input.query}`, regexMode: true } : { searchQuery: input.query.toLowerCase(), regexMode: false };
}

function mapContentMatchRanges(line: string, byteRanges: ReadonlyArray<readonly [number, number]>): Array<{ start: number; end: number }> {
	const lineBytes = Buffer.from(line);
	const toStringIndex = (byteOffset: number) => lineBytes.subarray(0, byteOffset).toString().length;
	return byteRanges.map(([startByte, endByte]) => ({ start: toStringIndex(startByte), end: toStringIndex(endByte) }));
}

/** Whole-word filtering happens after the grep, not in the pattern (T3's comment: boundary regexes widen adjacent ranges). */
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

/** One index per (variant, folder), made on first use and dropped after 15 idle minutes — T3's `WorkspaceSearchIndexMap`. */
class SearchIndexes {
	readonly #indexes = new Map<string, Promise<Index>>();

	static key(cwd: string, variant: IndexVariant) {
		return `${variant}\n${cwd}`;
	}

	async #create(cwd: string, variant: IndexVariant): Promise<Index> {
		// Loaded on first use: a host that never searches never loads the native library, and one where it cannot load
		// answers the typed `search_index_create_failed` instead of failing to boot.
		let module: typeof import("@ff-labs/fff-node");
		try {
			module = await import("@ff-labs/fff-node");
		} catch (cause) {
			throw new EntriesError("search_index_create_failed", `Failed to create the workspace search index for '${cwd}'.`, { normalizedCwd: cwd, detail: "The native file-search library (@ff-labs/fff-node) could not be loaded." }, cause);
		}
		const created = ((): Result<FileFinderType> => {
			try {
				return module.FileFinder.create({
					basePath: cwd,
					disableMmapCache: true,
					// Content indexing costs scan CPU and memory, so only the on-demand content-search index pays for it.
					disableContentIndexing: variant !== "content",
					aiMode: false,
					enableFsRootScanning: true,
					enableHomeDirScanning: true,
				});
			} catch (cause) {
				throw new EntriesError("search_index_create_failed", `Failed to create the workspace search index for '${cwd}'.`, { normalizedCwd: cwd, detail: "FileFinder.create threw unexpectedly." }, cause);
			}
		})();
		if (!created.ok) throw new EntriesError("search_index_create_failed", `Failed to create the workspace search index for '${cwd}'.`, { normalizedCwd: cwd, detail: created.error });
		const finder = created.value;
		const index: Index = { finder, initialScanTimedOut: false };
		try {
			const ready = await finder.waitForIndexReady(INDEX_SCAN_TIMEOUT_MS);
			if (!ready.ok) throw new EntriesError("search_index_create_failed", `Failed to create the workspace search index for '${cwd}'.`, { normalizedCwd: cwd, detail: ready.error });
			if (!ready.value) {
				// The path index still answers while it scans (and says `truncated`); the content index needs the whole scan.
				if (variant !== "paths") throw new EntriesError("search_index_scan_timed_out", `Workspace search index for '${cwd}' did not finish scanning within ${INDEX_SCAN_TIMEOUT}`, { normalizedCwd: cwd, timeout: INDEX_SCAN_TIMEOUT });
				index.initialScanTimedOut = true;
			}
		} catch (error) {
			finder.destroy();
			throw error;
		}
		return index;
	}

	/** The index for `cwd`, its idle timer restarted. */
	async get(cwd: string, variant: IndexVariant): Promise<Index> {
		const key = SearchIndexes.key(cwd, variant);
		let pending = this.#indexes.get(key);
		if (pending === undefined) {
			pending = this.#create(cwd, variant);
			this.#indexes.set(key, pending);
			pending.catch(() => this.#indexes.get(key) === pending && this.#indexes.delete(key));
		}
		const index = await pending;
		clearTimeout(index.timer);
		index.timer = setTimeout(() => void this.#drop(key), INDEX_IDLE_TTL_MS);
		index.timer.unref();
		return index;
	}

	async #drop(key: string): Promise<void> {
		const pending = this.#indexes.get(key);
		if (pending === undefined) return;
		this.#indexes.delete(key);
		const index = await pending.catch(() => undefined);
		if (index === undefined) return;
		clearTimeout(index.timer);
		try {
			index.finder.destroy();
		} catch {
			// destroying twice or a library that already died: nothing left to release
		}
	}

	/** After a write: rescan every index that exists for `cwd`; one that cannot rescan is dropped and rebuilt on next use. */
	async refresh(cwd: string): Promise<void> {
		for (const variant of ["paths", "content"] as const) {
			const key = SearchIndexes.key(cwd, variant);
			const pending = this.#indexes.get(key);
			if (pending === undefined) continue;
			try {
				const index = await pending;
				const scanned = index.finder.scanFiles();
				if (!scanned.ok) throw new Error(scanned.error);
				const ready = await index.finder.waitForIndexReady(INDEX_SCAN_TIMEOUT_MS);
				if (!ready.ok || !ready.value) throw new Error("the rescan did not finish");
			} catch {
				await this.#drop(key);
			}
		}
	}

	async close(): Promise<void> {
		await Promise.all([...this.#indexes.keys()].map((key) => this.#drop(key)));
	}
}

function searchFailed(cwd: string, reason: string, cause?: unknown): EntriesError {
	return new EntriesError("search_index_search_failed", `Workspace search failed for '${cwd}'.`, { normalizedCwd: cwd, detail: reason }, cause);
}

function runSearch<A>(cwd: string, operation: string, execute: () => Result<A>): A {
	let result: Result<A>;
	try {
		result = execute();
	} catch (cause) {
		throw searchFailed(cwd, `FileFinder.${operation} threw unexpectedly.`, cause);
	}
	if (!result.ok) throw searchFailed(cwd, result.error);
	return result.value;
}

// --- the service ------------------------------------------------------------------------------------------------------

export interface WorkspaceFilesOptions {
	/** The folders a client-named `cwd` may act in: every registered project's root and every thread's working folder. */
	readonly roots: () => readonly string[];
	/** When set, only roots whose realpath is inside this directory are known: the panel never serves another tree. */
	readonly root?: string;
}

export class WorkspaceFiles {
	readonly #roots: () => readonly string[];
	readonly #root: string | undefined;
	readonly #indexes = new SearchIndexes();

	constructor(options: WorkspaceFilesOptions) {
		this.#roots = options.roots;
		this.#root = options.root;
	}

	close(): Promise<void> {
		return this.#indexes.close();
	}

	/** Whether the realpath of `cwd` is the realpath of a known root. Exact: a subfolder of a root is not a root. */
	async #isKnown(cwd: string): Promise<boolean> {
		let real: string;
		try {
			real = await fsp.realpath(normalizeCwd(cwd));
		} catch {
			return false;
		}
		const realRoot = this.#root === undefined ? undefined : await fsp.realpath(resolve(this.#root)).catch(() => undefined);
		for (const root of this.#roots()) {
			const candidate = await fsp.realpath(resolve(root)).catch(() => undefined);
			if (candidate !== real) continue;
			if (realRoot !== undefined && !isInsideRealRoot(realRoot, candidate)) continue;
			return true;
		}
		return false;
	}

	/** `WorkspacePaths.normalizeWorkspaceRoot` for a known root; an unknown one is `workspace_root_not_found`. */
	async #entriesRoot(cwd: string): Promise<string> {
		const normalized = normalizeCwd(cwd);
		if (!(await this.#isKnown(cwd))) throw new EntriesError("workspace_root_not_found", `Workspace root does not exist: ${normalized}`, { normalizedCwd: normalized });
		let stat;
		try {
			stat = await fsp.stat(normalized);
		} catch (cause) {
			if (errnoCode(cause) === "ENOENT") throw new EntriesError("workspace_root_not_found", `Workspace root does not exist: ${normalized}`, { normalizedCwd: normalized }, cause);
			throw new EntriesError("workspace_root_stat_failed", `Failed to stat workspace root '${normalized}' during 'validate-existing'.`, { normalizedCwd: normalized, detail: "validate-existing" }, cause);
		}
		if (!stat.isDirectory()) throw new EntriesError("workspace_root_not_directory", `Workspace root is not a directory: ${normalized}`, { normalizedCwd: normalized });
		return normalized;
	}

	/** A file call on an unknown root is `workspace_path_outside_root`, as T3 maps its `UnknownWorkspaceError`. */
	async #assertKnownFileRoot(cwd: string): Promise<void> {
		if (!(await this.#isKnown(cwd))) {
			throw new FileError("workspace_path_outside_root", `'${cwd}' is not a registered project or a thread's working folder.`);
		}
	}

	// --- projects.listEntries -----------------------------------------------------------------------------------------

	async list(input: { readonly cwd: string; readonly directoryPath?: string }): Promise<ProjectListEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		if (input.directoryPath === undefined) {
			const index = await this.#indexes.get(cwd, "paths");
			const incompleteBeforeQuery = index.initialScanTimedOut && index.finder.isScanning();
			const result = runSearch(cwd, "mixedSearch", () => index.finder.mixedSearch("", { pageSize: INDEX_PAGE_SIZE }));
			const mapped = mapMixedSearchResult(result, INDEX_MAX_ENTRIES);
			const sorted = withDirectoryAncestors(mapped.entries).toSorted((left, right) => left.path.localeCompare(right.path));
			const entries = sorted.slice(0, INDEX_MAX_ENTRIES);
			return { entries, truncated: incompleteBeforeQuery || mapped.truncated || entries.length < sorted.length };
		}
		const directoryPath = input.directoryPath;
		const toError = (cause: unknown) =>
			new EntriesError("directory_list_failed", `Failed to read workspace directory '${resolve(cwd, directoryPath)}' while browsing '${directoryPath}' from '${cwd}'.`, { normalizedCwd: cwd, detail: `Failed to read workspace directory '${resolve(cwd, directoryPath)}' while browsing '${directoryPath}' from '${cwd}'.` }, cause);
		let target: { absolutePath: string; relativePath: string };
		if (directoryPath === "") target = { absolutePath: cwd, relativePath: "" };
		else {
			const within = resolveWithinRoot(cwd, directoryPath);
			if (within === null) throw toError(new Error(`Workspace file path must be relative to the project root: ${directoryPath}`));
			target = within;
		}
		let listed: { entries: ProjectEntry[]; throughSymlink: boolean };
		try {
			const root = await fsp.realpath(cwd);
			const directory = await fsp.realpath(target.absolutePath);
			const rel = relative(root, directory);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep).includes(".git") || target.relativePath.split("/").includes(".git")) {
				throw new Error("Directory must be inside the workspace and outside .git.");
			}
			const children = await fsp.readdir(directory, { withFileTypes: true });
			listed = {
				entries: children.flatMap((child): ProjectEntry[] => {
					if (child.name === ".git" || (!child.isDirectory() && !child.isFile())) return [];
					return [{ path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name, kind: child.isDirectory() ? "directory" : "file" }];
				}),
				// Git refuses to classify paths beyond a symbolic link.
				throughSymlink: rel !== target.relativePath.split("/").join(sep),
			};
		} catch (cause) {
			throw toError(cause);
		}
		const { entries, throughSymlink } = listed;
		// Ignore classification is optional: a non-git folder, or no `git` on this host, lists without `ignored` flags.
		const checkIgnore = (paths: readonly string[]) =>
			runGit(["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"], cwd, `${paths.join("\0")}\0`, 10_000, 16 * 1024 * 1024);
		// Asking about the folder itself answers for every child of a large one (T3's comment: `node_modules`-sized folders).
		if (entries.length > IGNORE_CHECK_CHUNK_SIZE && target.relativePath !== "" && !throughSymlink && !/^:|[*?[\\]/.test(target.relativePath) && (await checkIgnore([target.relativePath]))?.exitCode === 0) {
			return { entries: entries.map((entry) => ({ ...entry, ignored: true })), truncated: false };
		}
		const ignored = new Set<string>();
		for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
			const result = await checkIgnore(entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path));
			if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
			for (const ignoredPath of result.stdout.split("\0")) ignored.add(ignoredPath);
		}
		return { entries: entries.map((entry) => (ignored.has(entry.path) ? { ...entry, ignored: true } : entry)), truncated: false };
	}

	// --- projects.searchEntries / projects.searchContents -------------------------------------------------------------

	async searchEntries(input: { readonly cwd: string; readonly query: string; readonly limit: number; readonly kind?: ProjectEntryKind; readonly imageOnly?: boolean }): Promise<ProjectSearchEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const query = normalizeSearchQuery(input.query);
		const index = await this.#indexes.get(cwd, "paths");
		const { finder } = index;
		const pageSize = input.imageOnly ? INDEX_PAGE_SIZE : Math.max(1, input.limit + 1);
		const incompleteBeforeQuery = index.initialScanTimedOut && finder.isScanning();
		if (input.kind === "file" || input.imageOnly) {
			const mapped = mapFileSearchResult(runSearch(cwd, "fileSearch", () => finder.fileSearch(query, { pageSize })), input.limit, input.imageOnly);
			return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
		}
		if (input.kind === "directory") {
			const mapped = mapDirectorySearchResult(runSearch(cwd, "directorySearch", () => finder.directorySearch(query, { pageSize })), input.limit);
			return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
		}
		const mapped = mapMixedSearchResult(runSearch(cwd, "mixedSearch", () => finder.mixedSearch(query, { pageSize })), input.limit);
		return { ...mapped, truncated: incompleteBeforeQuery || mapped.truncated };
	}

	async searchContents(input: { readonly cwd: string } & ContentQuery): Promise<ProjectSearchContentsResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const { finder } = await this.#indexes.get(cwd, "content");
		const { searchQuery, regexMode } = buildContentSearchQuery(input);
		const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
		// Grep cursors advance by file, so whole-word post-filtering needs enough raw candidates from the current file.
		const rawPageSize = input.wholeWord ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE) : input.limit;
		const matches: ProjectSearchContentsResult["matches"][number][] = [];
		let nextCursor: GrepCursor | null = null;
		let regexFallbackError: string | undefined;
		do {
			const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
			const cursor: GrepCursor | null = nextCursor;
			const result: GrepResult = runSearch(cwd, "grep", () =>
				finder.grep(searchQuery, {
					mode: regexMode ? "regex" : "plain",
					smartCase: !input.caseSensitive && !regexMode,
					maxMatchesPerFile: Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
					pageSize: rawPageSize,
					cursor,
					timeBudgetMs: remaining,
				}),
			);
			for (const match of result.items) {
				const matchRanges = mapContentMatchRanges(match.lineContent, match.matchRanges).filter((range) => !input.wholeWord || isWholeWordRange(match.lineContent, range));
				if (matchRanges.length === 0) continue;
				matches.push({ path: toPosix(match.relativePath), lineNumber: match.lineNumber, lineContent: match.lineContent, matchRanges });
			}
			nextCursor = result.nextCursor;
			regexFallbackError ??= result.regexFallbackError;
		} while (matches.length < input.limit && nextCursor !== null && performance.now() < deadline);
		return {
			matches: matches.slice(0, input.limit),
			truncated: matches.length > input.limit || nextCursor !== null,
			...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
		};
	}

	// --- projects.readFile --------------------------------------------------------------------------------------------

	async readFile(input: { readonly cwd: string; readonly relativePath: string; readonly allowMissing?: boolean }): Promise<ProjectReadFileResult> {
		await this.#assertKnownFileRoot(input.cwd);
		const cwd = normalizeCwd(input.cwd);
		const requested = input.relativePath.trim();
		// T3 reads an absolute or `~/` host path in place; this host has no host-wide reads (capabilities.md).
		if (requested.startsWith("~/") || requested === "~" || isAbsolute(requested)) {
			throw new FileError("workspace_path_outside_root", `Workspace file path must be relative to the project root: ${input.relativePath}`);
		}
		const target = resolveWithinRoot(cwd, input.relativePath);
		if (target === null) throw new FileError("workspace_path_outside_root", `Workspace file path must be relative to the project root: ${input.relativePath}`);
		const realWorkspaceRoot = await fsp.realpath(cwd).catch((cause) => {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, cause);
		});
		let resolved: { realTargetPath: string; exists: boolean };
		try {
			let candidate = target.absolutePath;
			for (;;) {
				try {
					resolved = { realTargetPath: join(await fsp.realpath(candidate), relative(candidate, target.absolutePath)), exists: candidate === target.absolutePath };
					break;
				} catch (error) {
					if (!input.allowMissing || errnoCode(error) !== "ENOENT") throw error;
					// Like writes, a missing read checks the nearest existing ancestor; an entry that exists but cannot resolve is a dangling link.
					const exists = await fsp.lstat(candidate).then(
						() => true,
						(cause: NodeJS.ErrnoException) => {
							if (cause.code !== "ENOENT") throw cause;
							return false;
						},
					);
					if (exists || dirname(candidate) === candidate) throw error;
					candidate = dirname(candidate);
				}
			}
		} catch (cause) {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-target' failed at '${target.absolutePath}'.`, { resolvedPath: target.absolutePath, operation: "realpath-target", operationPath: target.absolutePath }, cause);
		}
		if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${resolved.realTargetPath}`, { resolvedPath: resolved.realTargetPath, resolvedWorkspaceRoot: realWorkspaceRoot });
		}
		const absent = { relativePath: target.relativePath, contents: "", byteLength: 0, truncated: false, exists: false };
		if (!resolved.exists) return absent;
		const realTargetPath = resolved.realTargetPath;
		const failed = (operation: ProjectFileOperation, cause: unknown) =>
			new FileError("operation_failed", `Workspace file operation '${operation}' failed at '${realTargetPath}'.`, { resolvedPath: realTargetPath, operation, operationPath: realTargetPath }, cause);
		let handle: fsp.FileHandle;
		try {
			// Non-blocking so a FIFO cannot hang the open; the stat below rejects it.
			handle = await fsp.open(realTargetPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		} catch (cause) {
			if (input.allowMissing === true && errnoCode(cause) === "ENOENT") return absent;
			throw failed("open", cause);
		}
		try {
			const stat = await handle.stat().catch((cause) => {
				throw failed("stat", cause);
			});
			if (!stat.isFile()) throw new FileError("path_not_file", `Workspace path '${input.relativePath}' in '${cwd}' is not a file: ${realTargetPath}`, { resolvedPath: realTargetPath });
			const bytesToRead = Math.min(stat.size, READ_FILE_MAX_BYTES);
			const buffer = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0).catch((cause) => {
				throw failed("read", cause);
			});
			const fileBytes = buffer.subarray(0, bytesRead);
			// T3's binary test: a NUL byte in what was read.
			if (fileBytes.includes(0)) throw new FileError("binary_file", `Workspace file '${input.relativePath}' in '${cwd}' is binary and cannot be previewed as text.`, { resolvedPath: realTargetPath });
			return { relativePath: target.relativePath, contents: new TextDecoder("utf-8").decode(fileBytes), byteLength: stat.size, truncated: stat.size > READ_FILE_MAX_BYTES };
		} finally {
			await handle.close().catch(() => {});
		}
	}

	// --- projects.writeFile -------------------------------------------------------------------------------------------

	async writeFile(input: { readonly cwd: string; readonly relativePath: string; readonly contents: string }): Promise<{ relativePath: string }> {
		await this.#assertKnownFileRoot(input.cwd);
		const cwd = normalizeCwd(input.cwd);
		const target = resolveWithinRoot(cwd, input.relativePath);
		if (target === null) throw new FileError("workspace_path_outside_root", `Workspace file path must be relative to the project root: ${input.relativePath}`);
		const realWorkspaceRoot = await fsp.realpath(cwd).catch((cause) => {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, cause);
		});
		// The deepest existing ancestor resolves to its real path before the root check, so neither the file nor the
		// directories created for it can follow a symlink out of the root. A dangling symlink is refused, not written through.
		// The check and the writes below are separate steps: a symlink swapped in between them (by someone writing inside
		// the root, i.e. the agent) is followed, as in T3.
		const segments = relative(cwd, target.absolutePath).split(sep);
		let realTargetPath: string;
		try {
			realTargetPath = join(realWorkspaceRoot, ...segments);
			for (let depth = segments.length; depth > 0; depth--) {
				const candidate = join(realWorkspaceRoot, ...segments.slice(0, depth));
				try {
					realTargetPath = join(await fsp.realpath(candidate), ...segments.slice(depth));
					break;
				} catch (error) {
					const exists = await fsp.lstat(candidate).then(() => true, () => false);
					if (errnoCode(error) !== "ENOENT" || exists) throw error;
				}
			}
		} catch (cause) {
			throw new FileError("operation_failed", `Workspace file operation 'realpath-target' failed at '${target.absolutePath}'.`, { resolvedPath: target.absolutePath, operation: "realpath-target", operationPath: target.absolutePath }, cause);
		}
		// The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
		const namedTargetPath = join(realWorkspaceRoot, ...segments);
		const inGit = (path: string) =>
			isInGitFolder(path).catch((cause) => {
				throw new FileError("operation_failed", `Workspace file operation 'stat' failed at '${path}'.`, { resolvedPath: realTargetPath, operation: "stat", operationPath: path }, cause);
			});
		if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath) || (await inGit(realTargetPath)) || (await inGit(namedTargetPath))) {
			throw new FileError("resolved_path_outside_root", `Workspace file '${input.relativePath}' resolves outside workspace root '${cwd}': ${realTargetPath}`, { resolvedPath: realTargetPath, resolvedWorkspaceRoot: realWorkspaceRoot });
		}
		const directory = dirname(realTargetPath);
		await fsp.mkdir(directory, { recursive: true }).catch((cause) => {
			throw new FileError("operation_failed", `Workspace file operation 'make-directory' failed at '${directory}'.`, { resolvedPath: realTargetPath, operation: "make-directory", operationPath: directory }, cause);
		});
		const writeFailed = (cause: unknown) =>
			new FileError("operation_failed", `Workspace file operation 'write-file' failed at '${realTargetPath}'.`, { resolvedPath: realTargetPath, operation: "write-file", operationPath: realTargetPath }, cause);
		// Atomic: the bytes land in a temp file beside the target, then one rename replaces it. A reader (or the agent) sees
		// the old file or the new one, never a half-written one, and a symlink swapped in at the target is replaced, not followed.
		const temp = join(directory, `.${basename(realTargetPath)}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			// An existing file keeps its permission bits; a new one gets the default for this process's umask.
			const existing = await fsp.stat(realTargetPath).then((stat) => stat, (error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return undefined;
				throw error;
			});
			// The rename would replace a file this user may not write; refuse it as T3's in-place write does (EACCES).
			if (existing !== undefined) await fsp.access(realTargetPath, constants.W_OK);
			const handle = await fsp.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
			try {
				await handle.writeFile(input.contents);
				if (existing !== undefined) await handle.chmod(existing.mode & 0o7777);
			} finally {
				await handle.close();
			}
			await fsp.rename(temp, realTargetPath);
		} catch (cause) {
			await fsp.rm(temp, { force: true }).catch(() => {});
			throw writeFailed(cause);
		}
		await this.#indexes.refresh(cwd);
		return { relativePath: target.relativePath };
	}
}
