import { createHmac } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { WorkspaceAssets } from "../src/t3/workspace-assets.ts";
import { tempRoot } from "./temp-root.ts";

const signer = {
	signPayload: (payload: string) => createHmac("sha256", "key").update(payload).digest("base64url"),
	verifySignature: (payload: string, signature: string) => signer.signPayload(payload) === signature,
};

async function fixture() {
	const root = await tempRoot();
	await mkdir(join(root, "docs"));
	await writeFile(join(root, "docs", "index.html"), "<link rel=stylesheet href=style.css><h1>hi</h1>");
	await writeFile(join(root, "docs", "style.css"), "h1 { color: red }");
	await writeFile(join(root, "photo.png"), "not really a png");
	await writeFile(join(root, "secret.txt"), "no preview");
	const env = new NodeExecutionEnv({ cwd: root });
	const assets = new WorkspaceAssets({ env, roots: () => [root], signer });
	return { root, assets };
}

const workspaceFile = (path: string) => ({ _tag: "workspace-file", threadId: "thread-1", path }) as never;

describe("WorkspaceAssets", () => {
	it("serves HTML and its relative assets under one signed URL", async () => {
		const { root, assets } = await fixture();
		const issued = await assets.issue(workspaceFile(join(root, "docs", "index.html")));
		const token = issued.relativeUrl.split("/")[3]!;
		expect(await assets.resolve(token, "index.html")).toMatchObject({ mimeType: "text/html" });
		expect(await assets.resolve(token, "style.css")).toMatchObject({ mimeType: "text/css" });
		expect(await assets.resolve(token, "../secret.txt")).toBeNull();
	});

	it("serves an image by its exact name", async () => {
		const { root, assets } = await fixture();
		const issued = await assets.issue(workspaceFile(join(root, "photo.png")));
		const token = issued.relativeUrl.split("/")[3]!;
		expect(await assets.resolve(token, "photo.png")).toMatchObject({ mimeType: "image/png" });
		expect(await assets.resolve(token, "other.png")).toBeNull();
	});

	it("serves the audio and video an HTML page loads beside it (T3 0.1.11)", async () => {
		const { root, assets } = await fixture();
		await writeFile(join(root, "docs", "clip.mp4"), "not really a video");
		await writeFile(join(root, "docs", "theme.ogg"), "not really audio");
		const token = (await assets.issue(workspaceFile(join(root, "docs", "index.html")))).relativeUrl.split("/")[3]!;
		expect(await assets.resolve(token, "clip.mp4")).toMatchObject({ mimeType: "video/mp4" });
		expect(await assets.resolve(token, "theme.ogg")).toMatchObject({ mimeType: "audio/ogg" });
	});

	it("checks what a link points at, not only the name asked for (T3 0.1.11)", async () => {
		const { root, assets } = await fixture();
		await writeFile(join(root, ".env"), "TOKEN=secret");
		await mkdir(join(root, ".hidden"));
		await writeFile(join(root, ".hidden", "style.css"), "h1 {}");
		await writeFile(join(root, "movie.mov"), "not really a video");
		await writeFile(join(root, "notes.css"), "h1 {}");
		// A page's dependency that leads to a hidden file, or to a type a page does not load, is refused; one that leads
		// out of the page's folder to a fair file is served.
		await symlink(join(root, ".env"), join(root, "docs", "env.css"));
		await symlink(join(root, ".hidden", "style.css"), join(root, "docs", "hidden.css"));
		await symlink(join(root, "movie.mov"), join(root, "docs", "clip.mp4"));
		await symlink(join(root, "notes.css"), join(root, "docs", "notes.css"));
		const token = (await assets.issue(workspaceFile(join(root, "docs", "index.html")))).relativeUrl.split("/")[3]!;
		expect(await assets.resolve(token, "env.css")).toBeNull();
		expect(await assets.resolve(token, "hidden.css")).toBeNull();
		expect(await assets.resolve(token, "clip.mp4")).toBeNull();
		expect(await assets.resolve(token, "notes.css")).toMatchObject({ mimeType: "text/css" });
		// A preview is minted only when the name asked for and the file it points at are both previewable.
		await symlink(join(root, "photo.png"), join(root, "photo.txt"));
		await expect(assets.issue(workspaceFile(join(root, "photo.txt")))).rejects.toMatchObject({ _tag: "AssetPreviewTypeValidationError" });
		// An image repointed at a file that is not one after its URL was issued is no longer served.
		const image = (await assets.issue(workspaceFile(join(root, "photo.png")))).relativeUrl.split("/")[3]!;
		expect(await assets.resolve(image, "photo.png")).toMatchObject({ mimeType: "image/png" });
		await rm(join(root, "photo.png"));
		await symlink(join(root, "notes.css"), join(root, "photo.png"));
		expect(await assets.resolve(image, "photo.png")).toBeNull();
	});

	it("refuses a text file: the file panel reads that through projects.readFile", async () => {
		const { root, assets } = await fixture();
		await expect(assets.issue(workspaceFile(join(root, "secret.txt")))).rejects.toMatchObject({ _tag: "AssetPreviewTypeValidationError" });
	});
});
