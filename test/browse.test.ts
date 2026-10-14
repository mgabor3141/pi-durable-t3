// The directory listing that feeds T3's "Add project" picker. Pure filesystem behavior (no wire), tested against real
// temp directories: only subdirectories are returned; a trailing separator lists the directory itself; a trailing
// component filters by prefix (case-insensitive); hidden directories appear only when the prefix starts with `.`; an
// explicit-relative path resolves against the current project's `cwd` (refused without one); a Windows path is refused
// on a non-Windows server; an unreadable directory answers an empty list. These are T3's semantics, copied, not forked.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseWindowsPathUnsupported } from "../src/t3/browse.ts";

let base = "";
const names = (entries: readonly { name: string }[]): string[] => entries.map((entry) => entry.name);

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "pi-durable-t3-browse-"));
	if (base.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
	// base/{alpha, beta, gamma, .hidden}/, base/gamma/{one, two}/, and a file that must never appear.
	for (const dir of ["alpha", "beta", "gamma", ".hidden", "gamma/one", "gamma/two"]) await mkdir(join(base, dir), { recursive: true });
	await writeFile(join(base, "afile.txt"), "not a directory");
});
afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("browseFilesystem (the picker's directory listing)", () => {
	it("a trailing separator lists the directory's subdirectories, sorted", async () => {
		const result = await browseFilesystem({ partialPath: `${base}/`, platform: "linux" });
		expect(result.parentPath).toBe(base);
		// The file is excluded; only directories, sorted by name.
		expect(names(result.entries)).toEqual([".hidden", "alpha", "beta", "gamma"]);
		expect(result.entries.every((entry) => entry.fullPath.startsWith(`${base}/`))).toBe(true);
	});

	it("a trailing component is a case-insensitive prefix filter", async () => {
		const result = await browseFilesystem({ partialPath: `${base}/Alph`, platform: "linux" });
		expect(names(result.entries)).toEqual(["alpha"]);
		expect(result.parentPath).toBe(base);
	});

	it("hidden directories are shown only when the prefix starts with `.`", async () => {
		expect(names((await browseFilesystem({ partialPath: `${base}/`, platform: "linux" })).entries)).toContain(".hidden");
		// A non-dot prefix filters hidden out.
		expect(names((await browseFilesystem({ partialPath: `${base}/h`, platform: "linux" })).entries)).not.toContain(".hidden");
	});

	it("an explicit-relative path resolves against the current project's cwd", async () => {
		const result = await browseFilesystem({ partialPath: "./ga", cwd: base, platform: "linux" });
		expect(names(result.entries)).toEqual(["gamma"]);
	});

	it("an explicit-relative path with no cwd is refused (current_project_required)", async () => {
		await expect(browseFilesystem({ partialPath: "./ga", platform: "linux" })).rejects.toBeInstanceOf(BrowseCurrentProjectRequired);
	});

	it("an unreadable directory answers an empty list, not a hard failure", async (ctx) => {
		const locked = join(base, "locked");
		await mkdir(locked, { recursive: true });
		await mkdir(join(locked, "secret"), { recursive: true });
		await chmod(locked, 0o000);
		try {
			// Root can traverse 0000 dirs, so on a root run the listing succeeds; assert the empty-list path only when
			// the read is actually denied (i.e. the directory is not listable as this user).
			const result = await browseFilesystem({ partialPath: `${locked}/`, platform: "linux" });
			if (process.getuid?.() === 0) {
				expect(names(result.entries)).toContain("secret");
			} else {
				expect(result.entries).toEqual([]);
				expect(result.parentPath).toBe(locked);
			}
		} finally {
			await chmod(locked, 0o755).catch(() => {});
			ctx;
		}
	});

	it("a Windows path on a non-Windows server is refused", async () => {
		await expect(browseFilesystem({ partialPath: "C:\\Users\\me", platform: "linux" })).rejects.toBeInstanceOf(BrowseWindowsPathUnsupported);
	});

	it("~ expands to the home directory", async () => {
		const result = await browseFilesystem({ partialPath: "~/", platform: "linux" });
		expect(result.parentPath).toBe(homedir());
	});
});
