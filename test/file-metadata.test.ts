// T3's `filesystem.getMetadata` (the web app's file chips in a reply), read through the environment: a file's kind and
// size, the type its first bytes name when it has no extension, a directory, and null for what is missing or relative.
// Entries follow the request's order; `~/` is the environment's own home.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { expect, it, onTestFinished } from "vitest";
import { filesystemMetadata } from "../src/t3/browse.ts";

it("answers a reply's paths: files with size and sniffed type, directories, null for the rest, in request order", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-meta-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "folder"));
	await writeFile(join(dir, "notes.md"), "# hi\n");
	await writeFile(join(dir, "script"), "#!/usr/bin/env python3\nprint(1)\n");
	await writeFile(join(dir, "blob"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
	const env = new NodeExecutionEnv({ cwd: dir });
	const paths = [join(dir, "notes.md"), join(dir, "script"), join(dir, "blob"), join(dir, "folder"), join(dir, "gone.txt"), "relative.md", join(dir, "notes.md")];
	expect(await filesystemMetadata(env, paths, BACKGROUND_CONTEXT)).toEqual([
		{ kind: "file", byteLength: 5 },
		{ kind: "file", byteLength: 32, mimeType: "text/x-python" },
		{ kind: "file", byteLength: 10, mimeType: "image/png" },
		{ kind: "directory" },
		null,
		null,
		{ kind: "file", byteLength: 5 },
	]);
	// ~/ is the environment's home (its shell's $HOME).
	expect(await filesystemMetadata(env, ["~"], BACKGROUND_CONTEXT)).toEqual([homedir() === "" ? null : { kind: "directory" }]);
});
