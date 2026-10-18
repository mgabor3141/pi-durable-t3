// Image attachments over the real facet: persist → mint → serve → dispatch → show → survive a restart. This is the
// end-to-end wire path (data-URL image flow) against the running host on the offline reply model (a faux model whose
// `input` includes "image", so the bridge sends it the bytes). The model-receives-the-image assertion lives in
// attachment-prompt.test.ts; this proves the wire, the store, and durability.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { connectWs, exitValue, pair, waitListening, type WsRpc } from "./ws-rpc.ts";
import { launch, pairCode, t3Dir, type Launched } from "./host-process-harness.ts";

const PORT = 4964;
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAEA//8DAAAGAAVXv6vUAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

let root: string;
let agentDir: string;
let host: Launched;

const start = () => (host = launch(root, PORT, {}, agentDir));

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-durable-t3-att-e2e-"));
	agentDir = join(root, "agent");
	await mkdir(join(root, "projects", "alpha"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "AGENTS.md"), "reply with the single word ok\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${PORT}"\n`, "utf8");
	await mkdir(t3Dir(root), { recursive: true });
	await writeFile(join(t3Dir(root), "projects.json"), JSON.stringify({ projects: [{ id: "p-alpha", title: "alpha", path: join(root, "projects", "alpha") }] }), "utf8");
	start();
}, 30_000);

afterAll(async () => {
	host?.child.kill("SIGKILL");
	await rm(root, { recursive: true, force: true });
}, 30_000);

const poll = async (fn: () => Promise<boolean>, ms = 30_000): Promise<boolean> => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
};

type Projection = { messages: { role: string; attachments?: { type: string; id: string }[] }[]; runs: { status: string }[] };
const userAttachments = async (ws: WsRpc): Promise<{ type: string; id: string }[]> => {
	const projection = exitValue(await ws.call("orchestration.getThreadProjection", { threadId: "t-att" }), "projection") as Projection;
	return projection.messages.find((m) => m.role === "user")?.attachments ?? [];
};

it("persist → mint a signed URL → serve the bytes → dispatch → the thread shows the image, and it survives a restart", async () => {
	expect(await waitListening(PORT), host.out().slice(-2000)).toBe(true);
	const token = await pair(PORT, pairCode(root));
	const ws = await connectWs(PORT, token);
	try {
		// 1. The client persists the image (data URL) for this thread + message; the host stores the bytes.
		const persisted = exitValue(await ws.call("assets.persistChatAttachments", {
			threadId: "t-att",
			messageId: "m-att-1",
			attachments: [{ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength, dataUrl: `data:image/png;base64,${PNG_B64}` }],
		}), "assets.persistChatAttachments") as { attachments: { type: string; id: string; name: string; mimeType: string; sizeBytes: number }[] };
		expect(persisted.attachments).toHaveLength(1);
		const record = persisted.attachments[0]!;
		expect(record).toMatchObject({ type: "image", name: "pic.png", mimeType: "image/png", sizeBytes: PNG_BYTES.byteLength });

		// 2. assets.createUrl mints a signed relative URL for the attachment.
		const url = exitValue(await ws.call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: record.id, mimeType: "image/png" } }), "assets.createUrl") as { relativeUrl: string; expiresAt: number };
		expect(url.relativeUrl.startsWith("/api/assets/")).toBe(true);

		// 3. GET the URL over plain HTTP (no bearer — the signature is the credential): the exact PNG bytes come back.
		const served = await fetch(`http://127.0.0.1:${PORT}${url.relativeUrl}`, { signal: AbortSignal.timeout(8000) });
		expect(served.status, "the signed asset URL serves 200").toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		const servedBytes = Buffer.from(await served.arrayBuffer());
		expect(servedBytes.equals(PNG_BYTES), "the served bytes are the persisted PNG").toBe(true);

		// A tampered token is refused (404), not served.
		const tampered = url.relativeUrl.replace(/\/api\/assets\/([^.]+)\./, "/api/assets/$1Z.");
		const bad = await fetch(`http://127.0.0.1:${PORT}${tampered}`, { signal: AbortSignal.timeout(8000) });
		expect(bad.status, "a tampered signature is not served").toBe(404);

		// 4. Launch the thread with the message + the persisted attachment (the data-URL path's dispatch), then the
		//    projection reports the attachment on the user message.
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((p) => p.models.length > 0)!;
		const modelSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug, options: [] };
		exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-att-launch", threadId: "t-att", projectId: "p-alpha", title: "Att", modelSelection,
			runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" },
			initialMessage: { messageId: "m-att-1", role: "user", text: "what is in this picture?", attachments: [record] },
		}), "launchThread");

		expect(await poll(async () => ((exitValue(await ws.call("orchestration.getThreadProjection", { threadId: "t-att" }), "projection") as Projection).runs.some((r) => r.status === "completed"))), "the offline reply model answered the turn").toBe(true);
		const shown = await userAttachments(ws);
		expect(shown.map((a) => a.id), "the thread shows the persisted image").toEqual([record.id]);
		ws.close();
	} finally {
		if (!ws.isClosed()) ws.close();
	}

	// 5. Restart: kill the host, reopen over the SAME root; the attachment record (in the entry) and the bytes (on disk)
	//    both survive, and the thread still shows the image.
	host.child.kill("SIGKILL");
	await host.exited;
	start();
	expect(await waitListening(PORT), "host restarted").toBe(true);
	const token2 = await pair(PORT, pairCode(root));
	const ws2 = await connectWs(PORT, token2);
	try {
		const shown = await userAttachments(ws2);
		expect(shown.length, "after a restart the user message still reports its attachment").toBe(1);
		// The bytes on disk still serve (the record's attachment id resolves to a stored file).
		const url = exitValue(await ws2.call("assets.createUrl", { resource: { _tag: "attachment", attachmentId: shown[0]!.id, mimeType: "image/png" } }), "createUrl after restart") as { relativeUrl: string };
		const served = await fetch(`http://127.0.0.1:${PORT}${url.relativeUrl}`, { signal: AbortSignal.timeout(8000) });
		expect(served.status, "the persisted bytes survive the restart").toBe(200);
	} finally {
		ws2.close();
	}
}, 120_000);
