// The file calls (`src/t3/files.ts`), replicated from T3's workspace services: containment, the roots a call may name,
// read limits (1 MiB, NUL = binary), atomic writes that keep the file's mode, and the search limits.
import { chmod, link, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { EntriesError, FileError, READ_FILE_MAX_BYTES, WorkspaceFiles } from "../src/t3/files.ts";
import { tempRoot } from "./temp-root.ts";

const opened: WorkspaceFiles[] = [];
afterEach(async () => {
	await Promise.all(opened.splice(0).map((files) => files.close()));
});

/** A workspace root with a few files, a second tree outside it, and a files service that knows only the root. */
async function fixture(extraRoots: string[] = []) {
	const base = await tempRoot();
	const root = join(base, "project");
	const outside = join(base, "outside");
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await writeFile(join(root, "README.md"), "hello\n");
	await writeFile(join(root, "src", "app.ts"), "export const answer = 42;\n");
	await writeFile(join(outside, "secret.txt"), "top secret\n");
	const files = new WorkspaceFiles({ env: new NodeExecutionEnv({ cwd: "/" }), roots: () => [root, ...extraRoots] });
	opened.push(files);
	return { base, root, outside, files };
}

const failure = async (run: Promise<unknown>) => {
	const error = await run.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	expect(error, "the call should have been refused").toBeDefined();
	return error as FileError | EntriesError;
};

describe("roots", () => {
	it("refuses a cwd that is not a known root, for every call", async () => {
		const { base, outside, files } = await fixture();
		for (const cwd of [outside, base, "/etc", join(base, "nope")]) {
			expect(((await failure(files.readFile({ cwd, relativePath: "secret.txt" }))) as FileError).failure).toBe("workspace_path_outside_root");
			expect(((await failure(files.writeFile({ cwd, relativePath: "x.txt", contents: "x" }))) as FileError).failure).toBe("workspace_path_outside_root");
			expect(((await failure(files.list({ cwd, directoryPath: "" }))) as EntriesError).failure).toBe("workspace_root_not_found");
			expect(((await failure(files.searchEntries({ cwd, query: "a", limit: 5 }))) as EntriesError).failure).toBe("workspace_root_not_found");
			expect(((await failure(files.searchContents({ cwd, query: "a", limit: 5, caseSensitive: false, wholeWord: false, useRegex: false }))) as EntriesError).failure).toBe("workspace_root_not_found");
		}
	});

	it("knows a root by its real path, and a subfolder of a root is not a root", async () => {
		const { base, root, files } = await fixture();
		const alias = join(base, "alias");
		await symlink(root, alias);
		expect((await files.readFile({ cwd: alias, relativePath: "README.md" })).contents).toBe("hello\n");
		expect(((await failure(files.readFile({ cwd: join(root, "src"), relativePath: "app.ts" }))) as FileError).failure).toBe("workspace_path_outside_root");
	});

	it("accepts a thread's folder of its own as a root", async () => {
		const { root, files: _ } = await fixture();
		const thread = join(root, "threads", "t1");
		await mkdir(thread, { recursive: true });
		await writeFile(join(thread, "note.txt"), "mine");
		const files = new WorkspaceFiles({ env: new NodeExecutionEnv({ cwd: "/" }), roots: () => [root, thread] });
		opened.push(files);
		expect((await files.readFile({ cwd: thread, relativePath: "note.txt" })).contents).toBe("mine");
	});

	it("a root that stopped being a directory is a typed entries failure", async () => {
		const { root, files } = await fixture();
		const asFile = join(root, "README.md");
		const filesOnFile = new WorkspaceFiles({ env: new NodeExecutionEnv({ cwd: "/" }), roots: () => [asFile] });
		opened.push(filesOnFile);
		expect(((await failure(filesOnFile.list({ cwd: asFile, directoryPath: "" }))) as EntriesError).failure).toBe("workspace_root_not_directory");
		void files;
	});
});

describe("containment", () => {
	it("refuses `..`, an absolute path and `~/` as outside the root", async () => {
		const { root, outside, files } = await fixture();
		for (const relativePath of ["../outside/secret.txt", "src/../../outside/secret.txt", join(outside, "secret.txt"), "/etc/passwd", "~/secret.txt", "..", "."]) {
			expect(((await failure(files.readFile({ cwd: root, relativePath }))) as FileError).failure, `read ${relativePath}`).toBe("workspace_path_outside_root");
			// A write names a path inside the root, so `~/x` is just a folder called `~` there, as in T3.
			if (relativePath === "~/secret.txt") continue;
			expect(((await failure(files.writeFile({ cwd: root, relativePath, contents: "x" }))) as FileError).failure, `write ${relativePath}`).toBe("workspace_path_outside_root");
		}
		await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("top secret\n");
	});

	it("refuses a symlink that leads out of the root, for a file and for a directory", async () => {
		const { root, outside, files } = await fixture();
		await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
		await symlink(outside, join(root, "leakdir"));
		for (const relativePath of ["leak.txt", "leakdir/secret.txt"]) {
			const error = (await failure(files.readFile({ cwd: root, relativePath }))) as FileError;
			expect(error.failure).toBe("resolved_path_outside_root");
			expect(error.context.resolvedWorkspaceRoot).toBeTruthy();
			expect(((await failure(files.writeFile({ cwd: root, relativePath, contents: "pwn" }))) as FileError).failure).toBe("resolved_path_outside_root");
		}
		// A write through a symlinked directory must not create anything outside either.
		expect(((await failure(files.writeFile({ cwd: root, relativePath: "leakdir/new/deep.txt", contents: "pwn" }))) as FileError).failure).toBe("resolved_path_outside_root");
		expect(await readdir(outside)).toEqual(["secret.txt"]);
		await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("top secret\n");
	});

	it("allows a symlink that stays inside the root, and a write through it lands on the target", async () => {
		const { root, files } = await fixture();
		await symlink(join(root, "src", "app.ts"), join(root, "link.ts"));
		await symlink(join(root, "src"), join(root, "srclink"));
		expect((await files.readFile({ cwd: root, relativePath: "link.ts" })).contents).toContain("answer");
		expect((await files.readFile({ cwd: root, relativePath: "srclink/app.ts" })).contents).toContain("answer");
		await files.writeFile({ cwd: root, relativePath: "link.ts", contents: "changed\n" });
		expect((await stat(join(root, "link.ts"))).isFile()).toBe(true);
		expect((await readFile(join(root, "src", "app.ts"), "utf8"))).toBe("changed\n");
		expect((await import("node:fs/promises")).lstat(join(root, "link.ts")).then((s) => s.isSymbolicLink())).resolves.toBe(true);
	});

	it("never writes into a git folder", async () => {
		const { root, files } = await fixture();
		await mkdir(join(root, ".git"), { recursive: true });
		expect(((await failure(files.writeFile({ cwd: root, relativePath: ".git/config", contents: "[core]" }))) as FileError).failure).toBe("resolved_path_outside_root");
	});
});

describe("readFile", () => {
	it("answers T3's shape: the text, its byte length, not truncated, no `exists`", async () => {
		const { root, files } = await fixture();
		expect(await files.readFile({ cwd: root, relativePath: "src/app.ts" })).toEqual({ relativePath: "src/app.ts", contents: "export const answer = 42;\n", byteLength: 26, truncated: false });
	});

	it("reads the first MiB of a larger file and says it was truncated", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "big.txt"), "a".repeat(READ_FILE_MAX_BYTES + 10));
		const result = await files.readFile({ cwd: root, relativePath: "big.txt" });
		expect(result.truncated).toBe(true);
		expect(result.byteLength).toBe(READ_FILE_MAX_BYTES + 10);
		expect(result.contents.length).toBe(READ_FILE_MAX_BYTES);
		await writeFile(join(root, "exact.txt"), "b".repeat(READ_FILE_MAX_BYTES));
		expect((await files.readFile({ cwd: root, relativePath: "exact.txt" })).truncated).toBe(false);
	});

	it("refuses a file with a NUL byte in what it read as binary — and only in what it read", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));
		expect(((await failure(files.readFile({ cwd: root, relativePath: "image.bin" }))) as FileError).failure).toBe("binary_file");
		// A NUL beyond the first MiB is never looked at, as in T3.
		await writeFile(join(root, "late.txt"), Buffer.concat([Buffer.alloc(READ_FILE_MAX_BYTES, "a"), Buffer.from([0])]));
		expect((await files.readFile({ cwd: root, relativePath: "late.txt" })).truncated).toBe(true);
	});

	it("refuses a directory as not a file, and a missing file unless allowMissing", async () => {
		const { root, files } = await fixture();
		expect(((await failure(files.readFile({ cwd: root, relativePath: "src" }))) as FileError).failure).toBe("path_not_file");
		const missing = (await failure(files.readFile({ cwd: root, relativePath: "nope.txt" }))) as FileError;
		expect(missing.failure).toBe("operation_failed");
		expect(missing.context.operation).toBe("realpath-target");
		expect(await files.readFile({ cwd: root, relativePath: "nope.txt", allowMissing: true })).toEqual({ relativePath: "nope.txt", contents: "", byteLength: 0, truncated: false, exists: false });
		expect(await files.readFile({ cwd: root, relativePath: "no/such/dir/x.txt", allowMissing: true })).toMatchObject({ exists: false });
	});
});

describe("writeFile", () => {
	it("writes, creating parent directories, and answers the relative path", async () => {
		const { root, files } = await fixture();
		expect(await files.writeFile({ cwd: root, relativePath: "a/b/c.txt", contents: "deep\n" })).toEqual({ relativePath: "a/b/c.txt" });
		expect(await readFile(join(root, "a/b/c.txt"), "utf8")).toBe("deep\n");
		await files.writeFile({ cwd: root, relativePath: "README.md", contents: "rewritten\n" });
		expect(await readFile(join(root, "README.md"), "utf8")).toBe("rewritten\n");
	});

	it("keeps the mode of the file it replaces, and leaves no temp file behind", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
		await chmod(join(root, "run.sh"), 0o750);
		await files.writeFile({ cwd: root, relativePath: "run.sh", contents: "#!/bin/sh\necho hi\n" });
		expect((await stat(join(root, "run.sh"))).mode & 0o7777).toBe(0o750);
		expect(await readFile(join(root, "run.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it.skipIf(process.getuid?.() === 0)("refuses a read-only file, as T3's in-place write does, and leaves it untouched", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "locked.txt"), "keep\n");
		await chmod(join(root, "locked.txt"), 0o444);
		await expect(files.writeFile({ cwd: root, relativePath: "locked.txt", contents: "changed\n" })).rejects.toMatchObject({ failure: "operation_failed", context: { operation: "write-file" } });
		expect(await readFile(join(root, "locked.txt"), "utf8")).toBe("keep\n");
		expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("writes the complete content through the environment", async () => {
		const { root, files } = await fixture();
		await files.writeFile({ cwd: root, relativePath: "README.md", contents: "x".repeat(100_000) });
		expect(await readFile(join(root, "README.md"), "utf8")).toHaveLength(100_000);
	});

	it("a failed write leaves the old file intact and no temp file", async () => {
		const { root, files } = await fixture();
		// The target is a non-empty directory: the rename cannot replace it.
		await mkdir(join(root, "dir"));
		await writeFile(join(root, "dir", "keep.txt"), "keep");
		const error = (await failure(files.writeFile({ cwd: root, relativePath: "dir", contents: "x" }))) as FileError;
		expect(error.failure).toBe("operation_failed");
		expect(error.context.operation).toBe("write-file");
		expect(await readdir(root)).not.toContainEqual(expect.stringMatching(/\.tmp$/));
		expect(await readFile(join(root, "dir", "keep.txt"), "utf8")).toBe("keep");
	});

	it("writes through a hard link, as the environment writes", async () => {
		const { root, files } = await fixture();
		await link(join(root, "README.md"), join(root, "hard.md"));
		await files.writeFile({ cwd: root, relativePath: "README.md", contents: "new\n" });
		expect(await readFile(join(root, "hard.md"), "utf8")).toBe("new\n");
	});
});

describe("listEntries", () => {
	it("lists one directory, files and folders, as workspace-relative paths", async () => {
		const { root, files } = await fixture();
		const result = await files.list({ cwd: root, directoryPath: "" });
		expect(result.truncated).toBe(false);
		expect(result.entries.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
			{ path: "README.md", kind: "file" },
			{ path: "src", kind: "directory" },
		]);
		expect((await files.list({ cwd: root, directoryPath: "src" })).entries).toEqual([{ path: "src/app.ts", kind: "file" }]);
	});

	it("marks git-ignored entries when the root is a git repo, and hides .git itself", async () => {
		const { root, files } = await fixture();
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, ".gitignore"), "ignored.log\n");
		await writeFile(join(root, "ignored.log"), "x");
		const entries = (await files.list({ cwd: root, directoryPath: "" })).entries;
		expect(entries.find((entry) => entry.path === "ignored.log")).toEqual({ path: "ignored.log", kind: "file", ignored: true });
		expect(entries.find((entry) => entry.path === "README.md")).toEqual({ path: "README.md", kind: "file" });
		expect(entries.some((entry) => entry.path === ".git")).toBe(false);
		expect(((await failure(files.list({ cwd: root, directoryPath: ".git" }))) as EntriesError).failure).toBe("directory_list_failed");
	});

	it("refuses a directory outside the root or through a symlink out of it", async () => {
		const { root, outside, files } = await fixture();
		await symlink(outside, join(root, "leakdir"));
		for (const directoryPath of ["..", "../outside", "leakdir", "missing"]) {
			expect(((await failure(files.list({ cwd: root, directoryPath }))) as EntriesError).failure, directoryPath).toBe("directory_list_failed");
		}
	});

	it("without a directoryPath, lists the whole indexed tree with its ancestor folders", async () => {
		const { root, files } = await fixture();
		const result = await files.list({ cwd: root });
		expect(result.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["README.md", "src", "src/app.ts"]));
	});
});

describe("search", () => {
	it("finds files and folders by path, narrowing by kind, with T3's limit and truncated flag", async () => {
		const { root, files } = await fixture();
		for (let i = 0; i < 6; i++) await writeFile(join(root, `widget-${i}.txt`), "w");
		const one = await files.searchEntries({ cwd: root, query: "widget", limit: 3, kind: "file" });
		expect(one.entries).toHaveLength(3);
		expect(one.truncated).toBe(true);
		const all = await files.searchEntries({ cwd: root, query: "widget", limit: 20, kind: "file" });
		expect(all.entries).toHaveLength(6);
		expect(all.truncated).toBe(false);
		expect((await files.searchEntries({ cwd: root, query: "app", limit: 5, kind: "file" })).entries[0]).toEqual({ path: "src/app.ts", kind: "file" });
		expect((await files.searchEntries({ cwd: root, query: "src", limit: 5, kind: "directory" })).entries).toEqual([{ path: "src", kind: "directory" }]);
	});

	it("imageOnly keeps only the image extensions", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "logo.png"), "png");
		await writeFile(join(root, "logo.txt"), "txt");
		expect((await files.searchEntries({ cwd: root, query: "logo", limit: 10, imageOnly: true })).entries).toEqual([{ path: "logo.png", kind: "file" }]);
	});

	it("respects .gitignore in a git repo: an ignored file is not offered", async () => {
		const { root, files } = await fixture();
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, ".gitignore"), "ignored-file.txt\n");
		await writeFile(join(root, "ignored-file.txt"), "x");
		await writeFile(join(root, "kept-file.txt"), "x");
		const found = (await files.searchEntries({ cwd: root, query: "file.txt", limit: 10, kind: "file" })).entries.map((entry) => entry.path);
		expect(found).toContain("kept-file.txt");
		expect(found).not.toContain("ignored-file.txt");
	});

	it("searches contents: ranges, whole word, case, regex, and the limit with its truncated flag", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "notes.txt"), "Alpha beta\nalphabet soup\nALPHA again\n");
		const base = { cwd: root, limit: 50, caseSensitive: false, wholeWord: false, useRegex: false };
		const plain = await files.searchContents({ ...base, query: "alpha" });
		expect(plain.matches.map((match) => [match.path, match.lineNumber])).toEqual(expect.arrayContaining([["notes.txt", 1], ["notes.txt", 2], ["notes.txt", 3]]));
		expect(plain.matches.find((match) => match.lineNumber === 1)?.matchRanges).toEqual([{ start: 0, end: 5 }]);
		expect(plain.truncated).toBe(false);
		const whole = await files.searchContents({ ...base, query: "alpha", wholeWord: true });
		expect(whole.matches.map((match) => match.lineNumber).toSorted()).toEqual([1, 3]);
		const cased = await files.searchContents({ ...base, query: "ALPHA", caseSensitive: true });
		expect(cased.matches.map((match) => match.lineNumber)).toEqual([3]);
		const regex = await files.searchContents({ ...base, query: "^alpha\\w+", useRegex: true });
		expect(regex.matches.map((match) => match.lineNumber)).toEqual([2]);
		// The grep cursor advances by file (T3's comment), so truncation shows when more files remain.
		const many = await fixture();
		for (const name of ["m1.txt", "m2.txt", "m3.txt"]) await writeFile(join(many.root, name), "alpha\n".repeat(3));
		const limited = await many.files.searchContents({ ...base, cwd: many.root, query: "alpha", limit: 1 });
		expect(limited.matches).toHaveLength(1);
		expect(limited.truncated).toBe(true);
	});

	it("an invalid regex falls back and says why", async () => {
		const { root, files } = await fixture();
		await writeFile(join(root, "r.txt"), "a(b\n");
		const result = await files.searchContents({ cwd: root, query: "a(", limit: 5, caseSensitive: true, wholeWord: false, useRegex: true });
		expect(result.regexFallbackError).toEqual(expect.any(String));
		expect(result.matches.length).toBeGreaterThan(0);
	});

	it("sees a file written through writeFile (the index is refreshed)", async () => {
		const { root, files } = await fixture();
		expect((await files.searchEntries({ cwd: root, query: "fresh", limit: 5, kind: "file" })).entries).toEqual([]);
		await files.writeFile({ cwd: root, relativePath: "fresh-file.txt", contents: "findable-needle" });
		expect((await files.searchEntries({ cwd: root, query: "fresh", limit: 5, kind: "file" })).entries).toEqual([{ path: "fresh-file.txt", kind: "file" }]);
		expect((await files.searchContents({ cwd: root, query: "findable-needle", limit: 5, caseSensitive: false, wholeWord: false, useRegex: false })).matches).toHaveLength(1);
	});
});
