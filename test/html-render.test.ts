// T3's inline HTML: html_render keeps a page as an attachment and shows it in the caller's thread as T3's html_render
// tool item (which T3's timeline renders inline), html_preview renders it in the host's browser first. The page rules are
// T3's. The browser tests run where Chromium can be launched and are skipped elsewhere.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { chromium, type Browser } from "playwright-core";
import { describe, expect, it, onTestFinished } from "vitest";
import { ServerSettingsStore } from "../src/settings.ts";
import type { Threads } from "../src/threads.ts";
import { AuthStore } from "../src/t3/auth.ts";
import { Attachments } from "../src/t3/attachments.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { assetResponse } from "../src/t3/http.ts";
import { HtmlPageError, inlineLocalImages, measureHtml, preparePublish, previewHtml, rejectViewportHeight } from "../src/t3/html-render.ts";
import { htmlToolsExtension } from "../src/t3/html-tools.ts";
import type { Logger } from "../src/t3/logging.ts";
import { createNamed, idle, makeThreads } from "./threads-harness.ts";

const log: Logger = { info: () => {}, warn: () => {} };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const env = new NodeExecutionEnv({ cwd: "/" });

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-durable-t3-html-"));
	onTestFinished(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("T3's page rules", () => {
	it("refuses viewport-height units in styles, not in text or inlined data", () => {
		expect(() => rejectViewportHeight("<style>.a { height: 100vh }</style>")).toThrow(/viewport height unit \(100vh\)/);
		expect(() => rejectViewportHeight('<div style="min-height: 50dvh">x</div>')).toThrow(HtmlPageError);
		expect(() => rejectViewportHeight("<p>100vh is a unit</p><style>.a { height: 10px }</style>")).not.toThrow();
		expect(() => rejectViewportHeight("<!-- 100vh --><style>.a{}</style>")).not.toThrow();
	});

	it("inlines local images by absolute path, checking their bytes, and names the ones it could not read", async () => {
		const dir = await scratch();
		await writeFile(join(dir, "dot.png"), PNG);
		await writeFile(join(dir, "fake.png"), "not an image, maybe a secret");
		const page = `<img src="${dir}/dot.png"><div style="background: url(${dir}/dot.png)"></div><img src="${dir}/fake.png"><img src="${dir}/gone.png"><img src="https://example.com/x.png">`;
		const inlined = await inlineLocalImages(env, page, BACKGROUND_CONTEXT);
		const dataUri = `data:image/png;base64,${PNG.toString("base64")}`;
		expect(inlined.html).toBe(`<img src="${dataUri}"><div style="background: url(${dataUri})"></div><img src="${dir}/fake.png"><img src="${dir}/gone.png"><img src="https://example.com/x.png">`);
		expect(inlined.missing).toEqual([`${dir}/fake.png`, `${dir}/gone.png`]);
	});

	it("publishes without a browser: T3's bootstrap injected, title and height clamped, no heights; a missing image is refused", async () => {
		const page = await preparePublish(env, { html: "<!doctype html><html><head><title>x</title></head><body><p>Hi</p></body></html>", title: "  Chart  ", height: 99_999 }, undefined, BACKGROUND_CONTEXT);
		expect(page.title).toBe("Chart");
		expect(page.height).toBe(2000);
		expect(page.heights).toBeUndefined();
		expect(page.html.indexOf("<script")).toBeGreaterThan(page.html.indexOf("<head>"));
		expect(page.html.indexOf("<script")).toBeLessThan(page.html.indexOf("</head>"));
		expect(page.html).toContain("<p>Hi</p>");
		await expect(preparePublish(env, { html: '<img src="/nope/missing.png">', title: "x", height: 100 }, undefined, BACKGROUND_CONTEXT)).rejects.toThrow(/could not be read: \/nope\/missing.png/);
	});
});

it("html_render keeps the page and shows it in the thread as T3's html_render item, above the reply, after a restart too", { timeout: 60_000 }, async () => {
	const dir = await scratch();
	const home = join(dir, "attachments");
	const holder: { threads?: Threads; bridge?: Bridge } = {};
	const attachments = new Attachments({ stateDir: join(dir, "state"), signer: new AuthStore(join(dir, "state"), { tokenTtlSeconds: 60 }), env, dir: home, context: BACKGROUND_CONTEXT });
	const extension = htmlToolsExtension({
		get threads() {
			return holder.threads!;
		},
		threadIdOf: (conversationId) => holder.bridge!.threadIdForConversation(conversationId),
		attachments,
		env,
		context: BACKGROUND_CONTEXT,
	});
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [extension] });
	holder.threads = f.threads;
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const bridge = (): Bridge => {
		const made = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(dir), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models, attachments);
		onTestFinished(() => made.close());
		return made;
	};
	holder.bridge = bridge();
	holder.bridge.start();
	await holder.bridge.loaded();

	const page = '<!doctype html><html><head></head><body><svg width="100" height="40"><rect width="100" height="40" fill="var(--chart-1)"/></svg></body></html>';
	f.model.respond(
		fauxAssistantMessage([fauxToolCall("html_render", { html: page, title: "Sales", height: 120 }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Q3 leads."),
	);
	await holder.bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Chart it.", mode: "start" });
	await idle(f.harness, thread.head);

	const shown = async (made: Bridge) => {
		const items = (await made.projection("t")).projection.turnItems as unknown as { type: string; toolName?: string; output?: unknown; status: string; text?: string }[];
		const renders = items.filter((item) => item.type === "dynamic_tool" && item.toolName === "html_render" && htmlRenderFromToolItem(item as never) !== undefined);
		return { items, renders };
	};
	const { items, renders } = await shown(holder.bridge);
	// The model's own call is one item; the published page is the one T3 renders inline.
	expect(renders).toHaveLength(1);
	const reference = htmlRenderFromToolItem(renders[0] as never)!;
	expect(reference).toMatchObject({ title: "Sales", height: 120 });
	expect(reference.attachmentId).toMatch(/^t-[0-9a-f-]{36}-html$/);
	const reply = items.findIndex((item) => item.type === "assistant_message" && item.text === "Q3 leads.");
	expect(items.indexOf(renders[0]!)).toBeLessThan(reply);
	// Kept where attachments are, with T3's bootstrap; served as sandboxed HTML.
	const stored = await readFile(join(home, `${reference.attachmentId}.html`), "utf8");
	expect(stored).toContain('<rect width="100"');
	expect(stored).toContain("<script");
	const url = await attachments.mintAssetUrl({ attachmentId: reference.attachmentId, fileName: "Sales.html", mimeType: "text/html" });
	const [token, name] = url!.relativeUrl.split("/").slice(3);
	const asset = await attachments.resolveAsset(token!, decodeURIComponent(name!));
	expect(asset?.mimeType).toBe("text/html");
	expect(assetResponse(asset!.mimeType).headers["content-security-policy"]).toContain("sandbox allow-scripts");

	// A restart reads it from the conversation.
	const fresh = bridge();
	fresh.start();
	await fresh.loaded();
	expect((await shown(fresh)).renders.map((item) => htmlRenderFromToolItem(item as never))).toEqual([reference]);
});

it("a script's html_render (the way an agent that acts through codemode calls it) shows the page once, above the reply", { timeout: 60_000 }, async () => {
	const dir = await scratch();
	const holder: { threads?: Threads; bridge?: Bridge } = {};
	const attachments = new Attachments({ stateDir: join(dir, "state"), signer: new AuthStore(join(dir, "state"), { tokenTtlSeconds: 60 }), env, dir: join(dir, "attachments"), context: BACKGROUND_CONTEXT });
	const html = htmlToolsExtension(
		{
			get threads() {
				return holder.threads!;
			},
			threadIdOf: (conversationId) => holder.bridge!.threadIdForConversation(conversationId),
			attachments,
			env,
			context: BACKGROUND_CONTEXT,
		},
		{ callers: ["tools"] },
	);
	const codemode = createCodemodeExtension({ sandbox: new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 }) }) as never;
	const f = await makeThreads({ projects: [{ id: "p" }], extensions: [codemode, html] });
	holder.threads = f.threads;
	const thread = await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	holder.bridge = new Bridge({ host: "127.0.0.1", port: 0, label: "t", stateDir: dir, scratchDir: undefined, tokenTtlSeconds: 60, settings: ServerSettingsStore.open(dir), corsOrigins: [], staticDir: undefined, registry: f.registry }, log, f.threads, f.model.models, attachments);
	onTestFinished(() => holder.bridge!.close());
	holder.bridge.start();
	await holder.bridge.loaded();

	const code = 'const r = await tools.html_render({ html: "<p>chart</p>", title: "Chart", height: 200 }); return JSON.parse(r).message;';
	f.model.respond(fauxAssistantMessage([fauxToolCall("codemode", { code }, { id: "call-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done."));
	await holder.bridge.sendMessage({ threadId: "t", commandId: "c1", messageId: "m1", text: "Chart it.", mode: "start" });
	await idle(f.harness, thread.head);

	const items = (await holder.bridge.projection("t")).projection.turnItems as unknown as { type: string; toolName?: string; output?: unknown; text?: string }[];
	const script = items.find((item) => item.type === "dynamic_tool" && item.toolName === "js");
	expect(String(script?.output)).toContain("Shown to the reader above your reply.");
	const renders = items.filter((item) => item.type === "dynamic_tool" && htmlRenderFromToolItem(item as never) !== undefined);
	expect(renders.map((item) => htmlRenderFromToolItem(item as never)?.title)).toEqual(["Chart"]);
	const reply = items.findIndex((item) => item.type === "assistant_message" && item.text === "Done.");
	expect(items.indexOf(renders[0]!)).toBeLessThan(reply);
	expect(items.indexOf(renders[0]!)).toBeGreaterThan(items.indexOf(script!));
});

it("html_render outside a T3 thread, and a page T3 refuses, answer the agent with why", async () => {
	const dir = await scratch();
	const attachments = new Attachments({ stateDir: join(dir, "state"), signer: new AuthStore(join(dir, "state"), { tokenTtlSeconds: 60 }), env, dir: join(dir, "a"), context: BACKGROUND_CONTEXT });
	let thread: string | undefined;
	const extension = htmlToolsExtension({ threads: undefined as never, threadIdOf: async () => thread, attachments, env, context: BACKGROUND_CONTEXT });
	const render = (extension as unknown as { tools: { name: string; execute: (args: unknown, api: unknown) => Promise<{ output: { text: string }[]; isError?: boolean }> }[] }).tools.find((tool) => tool.name === "html_render")!;
	const api = { conversationId: 1, taskId: "1", callId: "c" };
	expect(await render.execute({ html: "<p>x</p>", title: "x", height: 100 }, api)).toMatchObject({ isError: true, output: [{ text: expect.stringMatching(/not one/) }] });
	thread = "t";
	expect(await render.execute({ html: "<style>.a{height:100vh}</style>", title: "x", height: 100 }, api)).toMatchObject({ isError: true, output: [{ text: expect.stringMatching(/viewport height/) }] });
	// Without a browser there is no html_preview.
	expect((extension as unknown as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(["html_render"]);
});

const browser: Browser | undefined = await chromium.launch({ headless: true }).catch(() => undefined);

describe.skipIf(browser === undefined)("in a browser", () => {
	it("previews a page: a PNG at the width asked, its content height, its console, and the images it could not inline", { timeout: 60_000 }, async () => {
		onTestFinished(() => browser?.close());
		const page = '<!doctype html><html><body style="margin:0"><div style="height:300px">tall</div><script>console.log("hello", 1); console.error("bad")</script><img src="/nope/x.png"></body></html>';
		const preview = await previewHtml(env, browser!, { html: page, width: 390, appearance: "light" }, BACKGROUND_CONTEXT);
		expect(preview.width).toBe(390);
		expect(preview.contentHeight).toBeGreaterThanOrEqual(300);
		expect(preview.capturedHeight).toBe(preview.contentHeight);
		expect(preview.screenshot).toMatchObject({ mimeType: "image/png", width: 390, height: preview.capturedHeight });
		expect(Buffer.from(preview.screenshot.data, "base64").subarray(1, 4).toString()).toBe("PNG");
		expect(preview.consoleMessages).toEqual(expect.arrayContaining([{ level: "log", text: "hello 1" }, { level: "error", text: "bad" }]));
		expect(preview.missingImages).toEqual(["/nope/x.png"]);
		await expect(previewHtml(env, browser!, { html: "<style>.a{height:100vh}</style>" }, BACKGROUND_CONTEXT)).rejects.toThrow(HtmlPageError);

		// Measuring: T3's nine widths. Forty 100×50 boxes wrap into more rows when narrower (boxes, not text, so no font
		// is needed).
		const boxes = `<!doctype html><html><body style="margin:0"><div style="display:flex;flex-wrap:wrap">${'<div style="width:100px;height:50px"></div>'.repeat(40)}</div></body></html>`;
		const heights = await measureHtml(browser!, boxes);
		expect(heights).toEqual([320, 375, 430, 520, 640, 728, 860, 1000, 1144].map((width) => [width, Math.ceil(40 / Math.floor(width / 100)) * 50]));
	});
});
