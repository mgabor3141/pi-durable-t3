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
import type { ExecutionEnv, FileError as EnvFileError, Result } from "@earendil-works/pi-durable/env";
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
import { messageOf } from "../host-errors.ts";
import { type IgnoreFile, parseIgnoreFile } from "./ignore-patterns.ts";

/** `WorkspaceFileSystem.PROJECT_READ_FILE_MAX_BYTES`: a read returns at most this many bytes; `truncated` says more existed. */
export const READ_FILE_MAX_BYTES = 1024 * 1024;
const UTF8_BOM = "\uFEFF";
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

/** `WorkspacePaths.resolveRelativePathWithinRoot`: lexical containment — absolute, `.`/empty and `..` escapes refuse.
 * The path is taken as written: whitespace at its ends is part of a file's name (T3 stopped trimming it after 0.1.9). */
function resolveWithinRoot(workspaceRoot: string, requested: string): { absolutePath: string; relativePath: string } | null {
	if (isAbsolute(requested)) return null;
	const absolutePath = resolve(workspaceRoot, requested);
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

type WalkOptions = { readonly maxEntries?: number; readonly skipGit?: boolean };
/** `links`: the symbolic links met, in walk order, not yet resolved. */
type Walked = { entries: ProjectEntry[]; truncated: boolean; links: string[] };

/** One recursive walk over the environment, bounded like T3's index, parents before their entries. Symbolic links are
 * noted, not followed or resolved: `indexTree` resolves the ones search keeps. */
async function walk(env: ExecutionEnv, root: string, context: Context, options: WalkOptions = {}): Promise<Walked> {
	const limit = options.maxEntries ?? INDEX_MAX_ENTRIES;
	const entries: ProjectEntry[] = [];
	const links: string[] = [];
	const queue: string[] = [root];
	while (queue.length > 0 && entries.length + links.length < limit) {
		const directory = queue.shift()!;
		const listed = await env.listDir(directory, context);
		if (!listed.ok) continue;
		for (const info of listed.value) {
			if (entries.length + links.length >= limit) return { entries, truncated: true, links };
			if (info.name === ".git" && options.skipGit !== false) continue;
			const rel = toPosix(relative(root, info.path));
			if (rel === "" || rel.startsWith("../") || rel === "..") continue;
			if (info.kind === "directory") {
				entries.push({ path: rel, kind: "directory" });
				queue.push(info.path);
			} else if (info.kind === "file") {
				entries.push({ path: rel, kind: "file" });
			} else if (info.kind === "symlink") {
				links.push(rel);
			}
		}
	}
	return { entries, truncated: false, links };
}

/**
 * The tree T3's index serves for a root: the walk, what search leaves out of it (`ignored`), and the links it lists
 * (`links`). A link that is not left out and resolves inside the root, outside `.git`, to a file or a folder is an entry
 * under its target's kind, never followed (T3's `scanDirectory`); any other link is no entry. Only those links are
 * resolved: a remote environment pays a round trip for each, and an ignored folder (`node_modules`) may hold thousands.
 */
async function indexTree(env: ExecutionEnv, root: string, context: Context): Promise<{ entries: ProjectEntry[]; truncated: boolean; ignored: ReadonlySet<string>; links: ReadonlySet<string> }> {
	const walked = await walk(env, root, context);
	const ignored = await ignoredPaths(env, root, walked, context);
	const entries = [...walked.entries];
	const links = new Set<string>();
	const kept = walked.links.filter((link) => !ignored.has(link));
	const realRoot = kept.length === 0 ? undefined : await env.canonicalPath(root, context);
	const rootPath = realRoot?.ok === true ? realRoot.value : undefined;
	for (const link of rootPath === undefined ? [] : kept) {
		const target = await env.canonicalPath(`${root}/${link}`, context);
		const info = target.ok ? await env.fileInfo(target.value, context) : undefined;
		if (!target.ok || !info?.ok || (info.value.kind !== "file" && info.value.kind !== "directory")) continue;
		if (!isInsideRealRoot(rootPath!, target.value) || relative(rootPath!, target.value).split(sep).includes(".git")) continue;
		entries.push({ path: link, kind: info.value.kind });
		links.add(link);
	}
	return { entries, truncated: walked.truncated, ignored, links };
}

/**
 * The walked paths T3's file search leaves out, as ripgrep and T3's index (fff) decide them: below a folder that is left
 * out; else as the nearest `.ignore` with a pattern for the path says (T3's `decideByIgnoreFile`, which re-includes what
 * git ignores, too); else as git ignores it. Git's verdict is T3's `listGitIgnoredPaths` (every git source, tracked
 * files never), which names an ignored folder rather than what is in it, so a folder a `.ignore` takes back is searched.
 * Like T3, a link is never a folder to a folder-only rule, so links are judged as they are, unresolved. Everything is
 * read through the environment.
 */
async function ignoredPaths(env: ExecutionEnv, root: string, walked: Walked, context: Context): Promise<ReadonlySet<string>> {
	const gitIgnored = await gitIgnoredPaths(env, root, context);
	const ignoreFiles = new Map<string, IgnoreFile>();
	for (const entry of walked.entries) {
		if (entry.kind !== "file" || !(entry.path === ".ignore" || entry.path.endsWith("/.ignore"))) continue;
		const text = await env.readTextFile(`${root}/${entry.path}`, context);
		if (text.ok) ignoreFiles.set(parentOf(entry.path), parseIgnoreFile(text.value));
	}
	const decide = (path: string, isFolder: boolean) => {
		for (let directory = parentOf(path); ; directory = parentOf(directory)) {
			const decision = ignoreFiles.get(directory)?.decide(directory === "" ? path : path.slice(directory.length + 1), isFolder);
			if (decision !== undefined || directory === "") return decision;
		}
	};
	const ignored = new Set<string>();
	const judge = (path: string, isFolder: boolean) => {
		const parent = parentOf(path);
		const decision = parent !== "" && ignored.has(parent) ? "ignored" : decide(path, isFolder);
		if (decision === "ignored" || (decision === undefined && gitIgnored.has(path))) ignored.add(path);
	};
	// Parents come before their entries, so a folder's verdict is known when its entries are judged; links last.
	for (const entry of walked.entries) judge(entry.path, entry.kind === "directory");
	for (const link of walked.links) judge(link, false);
	return ignored;
}

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** `git ls-files --others --ignored --exclude-standard --directory` (T3's `listGitIgnoredPaths`): the untracked paths
 * git ignores, a folder named once without what is in it; none where the root is not a repository or git is missing. */
async function gitIgnoredPaths(env: ExecutionEnv, root: string, context: Context): Promise<ReadonlySet<string>> {
	const hasGit = await env.exists(`${root}/.git`, context);
	if (!hasGit.ok || !hasGit.value) return new Set();
	let output = "";
	const run = await env.exec(
		["git", "-c", "core.fsmonitor=false", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
		{
			cwd: root,
			onOutput: (text, _context, info) => {
				if (info.stream === "stdout") output += text;
			},
		},
		context,
	);
	if (!run.ok || run.value.exitCode !== 0) return new Set();
	return new Set(output.split("\0").flatMap((path) => (path === "" ? [] : [toPosix(path).replace(/\/$/, "")])));
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
			fallback: messageOf(error),
		};
	}
}

interface WorkspaceFilesOptions {
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

	/** Whether a file starts with a UTF-8 byte-order mark; a file that cannot be read (or is missing) does not. */
	async #startsWithUtf8Bom(path: string): Promise<boolean> {
		const opened = await this.#env.openBinaryReader(path, { noFollow: true }, this.#context);
		if (!opened.ok) return false;
		try {
			const read = await opened.value.read(0, 3, this.#context);
			return read.ok && read.value.length === 3 && read.value[0] === 0xef && read.value[1] === 0xbb && read.value[2] === 0xbf;
		} finally {
			await opened.value.close(this.#context).catch(() => {});
		}
	}

	// --- projects.listEntries -----------------------------------------------------------------------------------------

	async list(input: { readonly cwd: string; readonly directoryPath?: string }): Promise<ProjectListEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		if (input.directoryPath === undefined) {
			const tree = await indexTree(this.#env, cwd, this.#context);
			const withIgnored = tree.entries.map((entry) => (tree.ignored.has(entry.path) ? { ...entry, ignored: true } : entry));
			const sorted = withDirectoryAncestors(withIgnored).toSorted((left, right) => left.path.localeCompare(right.path));
			const entries = sorted.slice(0, INDEX_MAX_ENTRIES);
			return { entries, truncated: tree.truncated || entries.length < sorted.length };
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
		// A link is listed under its target's kind when it stays inside the root and outside `.git` (T3's
		// `resolveSymlinkKind`), except a link to a folder this listing is inside, so "Expand all folders" cannot loop.
		const rootPath = realRoot.value;
		let visited: string[] | undefined;
		const visitedFolders = async () => {
			if (visited !== undefined) return visited;
			visited = [rootPath];
			let current = cwd;
			for (const segment of target.relativePath.split("/").filter(Boolean)) {
				current = join(current, segment);
				const real = await this.#canonical(current);
				if (real.ok) visited.push(real.value);
			}
			return visited;
		};
		const linkKind = async (path: string): Promise<ProjectEntryKind | undefined> => {
			const resolved = await this.#canonical(path);
			if (!resolved.ok || !isInsideRealRoot(rootPath, resolved.value) || relative(rootPath, resolved.value).split(sep).includes(".git")) return undefined;
			const info = await this.#env.fileInfo(resolved.value, this.#context);
			if (!info.ok || (info.value.kind !== "file" && info.value.kind !== "directory")) return undefined;
			if (info.value.kind === "file") return "file";
			return (await visitedFolders()).some((folder) => isInsideRealRoot(resolved.value, folder)) ? undefined : "directory";
		};
		const entries: ProjectEntry[] = [];
		for (const info of listed.value) {
			if (info.name === ".git") continue;
			const kind = info.kind === "directory" || info.kind === "file" ? info.kind : info.kind === "symlink" ? await linkKind(info.path) : undefined;
			if (kind !== undefined) entries.push({ path: target.relativePath ? `${target.relativePath}/${info.name}` : info.name, kind });
		}
		const ignored = await gitIgnored(this.#env, cwd, entries.map((entry) => entry.path), this.#context);
		return { entries: entries.map((entry) => (ignored.has(entry.path) ? { ...entry, ignored: true } : entry)), truncated: false };
	}

	// --- projects.searchEntries / projects.searchContents -------------------------------------------------------------

	async searchEntries(input: { readonly cwd: string; readonly query: string; readonly limit: number; readonly kind?: ProjectEntryKind; readonly imageOnly?: boolean }): Promise<ProjectSearchEntriesResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const tree = await indexTree(this.#env, cwd, this.#context);
		const query = normalizeSearchQuery(input.query);
		const entries: ProjectEntry[] = [];
		for (const entry of tree.entries) {
			if (tree.ignored.has(entry.path)) continue;
			if (input.kind !== undefined && entry.kind !== input.kind) continue;
			if (input.imageOnly === true && (entry.kind !== "file" || !isProjectFaviconPath(entry.path))) continue;
			if (query !== "" && !entry.path.toLowerCase().includes(query)) continue;
			entries.push(entry);
			if (entries.length >= input.limit) break;
		}
		return { entries: entries.slice(0, input.limit), truncated: entries.length >= input.limit && entries.length < tree.entries.length };
	}

	async searchContents(input: { readonly cwd: string } & ContentQuery): Promise<ProjectSearchContentsResult> {
		const cwd = await this.#entriesRoot(input.cwd);
		const tree = await indexTree(this.#env, cwd, this.#context);
		const matcher = lineMatches(input);
		const matches: ProjectSearchContentsResult["matches"][number][] = [];
		const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
		let truncated = false;
		for (const entry of tree.entries) {
			// A link is listed, not searched: T3's index and git grep do not read through one.
			if (entry.kind !== "file" || tree.ignored.has(entry.path) || tree.links.has(entry.path)) continue;
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
		const requested = input.relativePath;
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
			if (!realWorkspaceRoot.ok) {
				// A project folder that is gone (T3: storage cleanup removed an idle worktree) holds no file, so a read that
				// allows a missing file answers missing, as T3 does.
				if (input.allowMissing === true && realWorkspaceRoot.error.code === "not_found") return { relativePath: target.relativePath, contents: "", byteLength: 0, truncated: false, exists: false };
				throw new FileError("operation_failed", `Workspace file operation 'realpath-workspace-root' failed at '${cwd}'.`, { resolvedPath: target.absolutePath, operation: "realpath-workspace-root", operationPath: cwd }, realWorkspaceRoot.error);
			}
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
			const truncated = info.value.size > READ_FILE_MAX_BYTES;
			const binary = () => new FileError("binary_file", `Workspace file '${input.relativePath}' in '${cwd}' is binary and cannot be previewed as text.`, { resolvedPath: realTargetPath });
			// T3's binary test: a NUL byte in what was read, or bytes that are not UTF-8. Text with U+FFFD in place of
			// them would corrupt the file on save. A character the 1 MiB cut split is dropped (a streaming decode), not
			// taken for binary. The decoder drops a byte-order mark; a save puts it back.
			if (fileBytes.includes(0)) throw binary();
			let contents: string;
			try {
				contents = new TextDecoder("utf-8", { fatal: true }).decode(fileBytes, { stream: truncated });
			} catch {
				throw binary();
			}
			return { relativePath: target.relativePath, contents, byteLength: info.value.size, truncated };
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
		// A read decodes a byte-order mark away, so a save from the editor would drop it: keep the one the file has.
		const contents = !input.contents.startsWith(UTF8_BOM) && (await this.#startsWithUtf8Bom(realTargetPath)) ? UTF8_BOM + input.contents : input.contents;
		const directory = dirname(realTargetPath);
		const made = await this.#env.createDir(directory, { recursive: true }, this.#context);
		if (!made.ok) {
			throw new FileError("operation_failed", `Workspace file operation 'make-directory' failed at '${directory}'.`, { resolvedPath: realTargetPath, operation: "make-directory", operationPath: directory }, made.error);
		}
		const written = await this.#env.writeFile(realTargetPath, contents, this.#context);
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
