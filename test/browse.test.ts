// The directory listing that feeds T3's "Add project" picker. Pure filesystem behavior (no wire), tested against real
// temp directories: only subdirectories, sorted; a trailing component filters by case-insensitive prefix; hidden
// directories appear only when the prefix starts with `.`; an explicit-relative path resolves against the current
// project's `cwd` (refused without one); `~` expands; a Windows path is refused on a non-Windows server. These are
// T3's semantics, copied, not forked. An unreadable directory answers an empty list (a hard failure would kill the
// picker). Temp roots only.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseReadDirectoryFailed, BrowseWindowsPathUnsupported } from "../src/t3/browse.ts";

let base = "";
const names = (entries: readonly { name: string }[]): string[] => entries.map((entry) => entry.name);

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "pi-durable-t3-browse-"));
	if (base.startsWith(join(homedir(), ".pi"))) throw new Error("temp root must not be under ~/.pi");
	// base/{alpha, beta, gamma, .hidden}/, and a file that must never appear.
	for (const dir of ["alpha", "beta", "gamma", ".hidden"]) await mkdir(join(base, dir), { recursive: true });
	await writeFile(join(base, "afile.txt"), "not a directory");
});
afterAll(async () => {
	await rm(base, { recursive: true, force: true });
});

describe("browseFilesystem (the picker's directory listing)", () => {
	it("the listing: trailing separator lists sorted subdirectories (files excluded); a trailing component filters by case-insensitive prefix; hidden entries need a dot prefix", async () => {
		const listed = await browseFilesystem({ partialPath: `${base}/`, platform: "linux" });
		expect(listed.parentPath).toBe(base);
		expect(names(listed.entries)).toEqual([".hidden", "alpha", "beta", "gamma"]); // only directories, sorted
		expect(listed.entries.every((entry) => entry.fullPath.startsWith(`${base}/`))).toBe(true);
		expect(names((await browseFilesystem({ partialPath: `${base}/Alph`, platform: "linux" })).entries)).toEqual(["alpha"]);
		expect(names((await browseFilesystem({ partialPath: `${base}/h`, platform: "linux" })).entries)).not.toContain(".hidden");
	});

	it("an explicit-relative path resolves against the current project's cwd; without one it is refused (current_project_required)", async () => {
		expect(names((await browseFilesystem({ partialPath: "./ga", cwd: base, platform: "linux" })).entries)).toEqual(["gamma"]);
		await expect(browseFilesystem({ partialPath: "./ga", platform: "linux" })).rejects.toBeInstanceOf(BrowseCurrentProjectRequired);
	});

	it("a configured root refuses a listing outside it", async () => {
		const root = join(base, "alpha");
		const outside = join(base, "beta");
		expect((await browseFilesystem({ partialPath: `${root}/`, root, platform: "linux" })).parentPath).toBe(root);
		await expect(browseFilesystem({ partialPath: `${outside}/`, root, platform: "linux" })).rejects.toBeInstanceOf(BrowseReadDirectoryFailed);
	});

	it("~ expands to the home directory; a Windows path on a non-Windows server is refused", async () => {
		expect((await browseFilesystem({ partialPath: "~/", platform: "linux" })).parentPath).toBe(homedir());
		await expect(browseFilesystem({ partialPath: "C:\\Users\\me", platform: "linux" })).rejects.toBeInstanceOf(BrowseWindowsPathUnsupported);
	});
});
