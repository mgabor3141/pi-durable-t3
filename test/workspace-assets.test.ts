import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it } from "vitest";
import { WorkspaceAssets } from "../src/t3/workspace-assets.ts";

const signer = {
	signPayload: (payload: string) => createHmac("sha256", "key").update(payload).digest("base64url"),
	verifySignature: (payload: string, signature: string) => signer.signPayload(payload) === signature,
};

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "workspace-assets-"));
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

	it("refuses a text file: the file panel reads that through projects.readFile", async () => {
		const { root, assets } = await fixture();
		await expect(assets.issue(workspaceFile(join(root, "secret.txt")))).rejects.toMatchObject({ _tag: "AssetPreviewTypeValidationError" });
	});
});
