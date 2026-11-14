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
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { browseFilesystem, BrowseCurrentProjectRequired, BrowseWindowsPathUnsupported } from "../src/t3/browse.ts";

let base = "";
const names = (entries: readonly { name: string }[]): string[] => entries.map((entry) => entry.name);
const env = () => new NodeExecutionEnv({ cwd: "/" });
/** An environment whose shell names `home` as $HOME: a remote workspace, whose home is not this host's. */
const envWithHome = (home: string) => {
	const inner = env();
	return new Proxy(inner, {
		get(target, key, receiver) {
			if (key !== "exec") return Reflect.get(target, key, receiver);
			return async (command: string, options: { onOutput?: (text: string, context: unknown, info: { stream: string }) => void }, context: unknown) => {
				if (command !== 'printf %s "$HOME"') throw new Error(`unexpected command: ${command}`);
				options.onOutput?.(home, context, { stream: "stdout" });
				return { ok: true, value: { exitCode: 0 } };
			};
		},
	});
};

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
		const listed = await browseFilesystem({ partialPath: `${base}/`, env: env(), platform: "linux" });
		expect(listed.parentPath).toBe(base);
		expect(names(listed.entries)).toEqual([".hidden", "alpha", "beta", "gamma"]); // only directories, sorted
		expect(listed.entries.every((entry) => entry.fullPath.startsWith(`${base}/`))).toBe(true);
		expect(names((await browseFilesystem({ partialPath: `${base}/Alph`, env: env(), platform: "linux" })).entries)).toEqual(["alpha"]);
		expect(names((await browseFilesystem({ partialPath: `${base}/h`, env: env(), platform: "linux" })).entries)).not.toContain(".hidden");
	});

	it("an explicit-relative path resolves against the current project's cwd; without one it is refused (current_project_required)", async () => {
		expect(names((await browseFilesystem({ partialPath: "./ga", cwd: base, env: env(), platform: "linux" })).entries)).toEqual(["gamma"]);
		await expect(browseFilesystem({ partialPath: "./ga", env: env(), platform: "linux" })).rejects.toBeInstanceOf(BrowseCurrentProjectRequired);
	});

	it("an absolute directory lists its own subdirectories; a Windows path on a non-Windows server is refused", async () => {
		expect((await browseFilesystem({ partialPath: `${base}/`, env: env(), platform: "linux" })).parentPath).toBe(base);
		await expect(browseFilesystem({ partialPath: "C:\\Users\\me", env: env(), platform: "linux" })).rejects.toBeInstanceOf(BrowseWindowsPathUnsupported);
	});

	it("a directory that does not exist fails as missing, so a client can offer to create it (T3 0.1.9)", async () => {
		await expect(browseFilesystem({ partialPath: "/no/such/directory/", env: env(), platform: "linux" })).rejects.toMatchObject({ name: "BrowseReadDirectoryFailed", parentPath: "/no/such/directory", pathMissing: true });
	});

	it("~ is the environment's home, not this host's: `~/` and `~` list it, `~/al` filters it (T3 opens the picker at ~/)", async () => {
		const remote = envWithHome(base);
		const listed = await browseFilesystem({ partialPath: "~/", env: remote, platform: "linux" });
		expect(listed.parentPath).toBe(base);
		expect(names(listed.entries)).toEqual([".hidden", "alpha", "beta", "gamma"]);
		expect((await browseFilesystem({ partialPath: "~", env: remote, platform: "linux" })).parentPath).toBe(base);
		expect(names((await browseFilesystem({ partialPath: "~/al", env: remote, platform: "linux" })).entries)).toEqual(["alpha"]);
		expect(names((await browseFilesystem({ partialPath: "../be", cwd: "~/gamma", env: remote, platform: "linux" })).entries)).toEqual(["beta"]);
	});
});
