// T3's inline HTML (`html_render`, `html_preview`): a page the agent publishes shows inline in its thread, above its
// reply, in T3's sandboxed frame. T3's rules, replicated from its server (`htmlRender/HtmlRender.ts`,
// `htmlRender/headlessChrome.ts`): no viewport-height units, local images by absolute path inlined (read here through
// the environment, as the agent sees its files), T3's bootstrap injected (theme, live height, links and shortcuts), and
// heights measured in a browser at T3's widths when one is configured. The page is stored as an attachment
// (`<thread>-<uuid>-html.html` in `attachmentsDir`), served by the asset route like any other.
import { type ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	clampHtmlRenderHeight,
	HTML_RENDER_COLUMN_WIDTH,
	HTML_RENDER_LAYOUT_GUIDE,
	HTML_RENDER_MAX_FIT_HEIGHT,
	HTML_RENDER_MAX_HEIGHT,
	HTML_RENDER_MAX_TITLE_LENGTH,
	HTML_RENDER_MEASURE_FONTS,
	HTML_RENDER_MEASURE_WIDTHS,
	HTML_RENDER_MIN_HEIGHT,
	HTML_RENDER_THEME_GUIDE,
	type HtmlRenderReference,
	htmlRenderTheme,
	htmlRenderThemeFragment,
	injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_DARK_THEME_COLORS, T3_CODE_LIGHT_THEME_COLORS } from "@t3tools/shared/themePalettes";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Context } from "@earendil-works/chord";

export { HTML_RENDER_TOOL_NAME } from "@t3tools/shared/htmlRender";
export type { HtmlRenderReference };

const MIB = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * MIB;
const MAX_PAGE_BYTES = 25 * MIB;
const MAX_HTML_CHARS = 512_000;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/** A page T3 would refuse, with T3's message: the agent fixes the page and calls again. */
export class HtmlPageError extends Error {}

// ---- the page ------------------------------------------------------------------------------------------------

// Check only stylesheets and style attributes, even inside scripts; skip comments whole (T3's `CSS_SOURCE`).
const CSS_SOURCE = /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/** T3's refusal of viewport-height units: the frame grows to fit the page, so a page that follows the frame never stops. */
export function rejectViewportHeight(html: string): void {
	for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
		const found = VIEWPORT_HEIGHT_UNIT.exec(sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "")?.[0];
		if (found !== undefined) {
			throw new HtmlPageError(
				`The page uses a viewport height unit (${found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
			);
		}
	}
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX absolute paths only: the environment is a Linux workspace.
const LOCAL_IMAGE_PATTERN = new RegExp(
	String.raw`(["'\x60])(/(?!/)(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` + String.raw`|url\(\s*(/(?!/)[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
	"gid",
);

const dataUriPrefix = (path: string) => `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;
const latin1 = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
const after = (text: string, token: string, from: number) => {
	const at = text.indexOf(token, from);
	return at === -1 ? -1 : at + token.length;
};
const afterDoctype = (text: string, from: number) => {
	let inSubset = false;
	let at = from;
	while (at !== -1 && at < text.length) {
		const char = text[at];
		if (char === '"' || char === "'") at = after(text, char, at + 1);
		else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
		else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
		else if (char === ">" && !inSubset) return at + 1;
		else {
			if (char === "[") inSubset = true;
			else if (char === "]") inSubset = false;
			at += 1;
		}
	}
	return -1;
};
const hasSvgRoot = (text: string) => {
	let at = 0;
	while (at !== -1) {
		while (/\s/.test(text.charAt(at))) at += 1;
		if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
		else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
		else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
		else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
	}
	return false;
};
/** T3 checks bytes, not names, so a renamed file or a symlink cannot inline a secret. */
const isImageBytes = (bytes: Uint8Array) => {
	const head = latin1(bytes, 0, 12);
	if (
		head.startsWith("\x89PNG") ||
		head.startsWith("\xff\xd8\xff") ||
		head.startsWith("GIF8") ||
		head.startsWith("\0\0\x01\0") ||
		(head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
		(head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
		/^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
	) {
		return true;
	}
	return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

/** T3's `inlineLocalImages`: every local image the page names by absolute path, as a data URI. `missing`: paths that are
 * not readable image files. */
export async function inlineLocalImages(env: ExecutionEnv, html: string, context: Context): Promise<{ html: string; missing: string[] }> {
	const references = [...html.matchAll(LOCAL_IMAGE_PATTERN)].flatMap((match) => {
		const span = match.indices?.[2] ?? match.indices?.[3];
		return span === undefined ? [] : [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }];
	});
	const paths = [...new Set(references.map((reference) => reference.path))];
	const sizes = new Map<string, number | undefined>();
	for (const path of paths) {
		const info = await env.fileInfo(path, context);
		sizes.set(path, info.ok && info.value.kind === "file" ? info.value.size : undefined);
	}
	for (const [path, size] of sizes) {
		if (size !== undefined && size > MAX_IMAGE_BYTES) throw new HtmlPageError(`${path} is ${formatMib(size)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`);
	}
	const estimate = references.reduce((total, reference) => {
		const size = sizes.get(reference.path);
		return size === undefined ? total : total + dataUriPrefix(reference.path).length + Math.ceil(size / 3) * 4 - Buffer.byteLength(reference.path);
	}, Buffer.byteLength(html));
	if (estimate > MAX_PAGE_BYTES) throw new HtmlPageError(`With its images inlined the page is ${formatMib(estimate)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`);
	const dataUris = new Map<string, string>();
	for (const [path, size] of sizes) {
		if (size === undefined) continue;
		const read = await env.readBinaryFile(path, context);
		if (!read.ok || !isImageBytes(read.value)) continue;
		if (read.value.byteLength > MAX_IMAGE_BYTES) throw new HtmlPageError(`${path} is ${formatMib(read.value.byteLength)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`);
		dataUris.set(path, dataUriPrefix(path) + Buffer.from(read.value).toString("base64"));
	}
	const parts: string[] = [];
	let cursor = 0;
	for (const reference of references) {
		const dataUri = dataUris.get(reference.path);
		if (dataUri === undefined) continue;
		parts.push(html.slice(cursor, reference.start), dataUri);
		cursor = reference.end;
	}
	parts.push(html.slice(cursor));
	const inlined = parts.join("");
	const bytes = Buffer.byteLength(inlined);
	if (bytes > MAX_PAGE_BYTES) throw new HtmlPageError(`With its images inlined the page is ${formatMib(bytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`);
	return { html: inlined, missing: paths.filter((path) => !dataUris.has(path)) };
}

/** The page as T3 serves it: checked, with its bootstrap (first, so its head scan never runs over image data) and its
 * local images inlined. */
async function preparePage(env: ExecutionEnv, html: string, context: Context): Promise<{ html: string; missing: string[] }> {
	if (html.length === 0 || html.length > MAX_HTML_CHARS) throw new HtmlPageError(`The page must be 1 to ${MAX_HTML_CHARS} characters.`);
	rejectViewportHeight(html);
	return inlineLocalImages(env, injectHtmlRenderBootstrap(html), context);
}

// ---- the browser -------------------------------------------------------------------------------------------

export type ConsoleMessage = { level: "log" | "info" | "warning" | "error"; text: string };
const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_TEXT_CHARS = 500;
const VIEWPORT_HEIGHT = 800;
const MAX_CAPTURE_HEIGHT = 4_000;
const CAPTURE_TIMEOUT_MS = 20_000;
const MEASURE_TIMEOUT_MS = 6_000;
const MEASURE_CONCURRENCY = 3;
const PAGE_ORIGIN = "http://t3-page.localhost";
const PAGE_URL = `${PAGE_ORIGIN}/page.html`;
const PAGE_NAME = "page.html";
const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_600;
// Wait for fonts and two paint frames to capture late layout.
const SETTLE_EXPRESSION = "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))";
// scrollHeight is at least the viewport height; use the root box for shorter pages.
const MEASURE_EXPRESSION = "(() => { const root = document.documentElement; return root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height; })()";
const CONSOLE_LEVELS: Readonly<Record<string, ConsoleMessage["level"]>> = {
	log: "log",
	debug: "log",
	dir: "log",
	dirxml: "log",
	table: "log",
	trace: "log",
	info: "info",
	warning: "warning",
	error: "error",
	assert: "error",
};
const MEASURE_FRAGMENT = htmlRenderThemeFragment(htmlRenderTheme(T3_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_MEASURE_FONTS));

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * One page of T3's headless browser, in a context of its own (none of the preview tabs' cookies): the main frame stays
 * on T3's page, which is served from memory; other sites load in subframes and as resources, as in T3. WebRTC is
 * removed, as T3 removes it.
 */
async function openPage(browser: Browser, width: number, appearance: "dark" | "light"): Promise<{ page: Page; context: BrowserContext; consoleMessages: () => ConsoleMessage[]; load: (html: string, fragment: string) => Promise<number> }> {
	const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, deviceScaleFactor: 1, colorScheme: appearance, serviceWorkers: "block" });
	try {
		await context.addInitScript("delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;");
		const page = await context.newPage();
		const messages: ConsoleMessage[] = [];
		let omitted = 0;
		const push = (level: ConsoleMessage["level"], raw: string) => {
			if (messages.length >= MAX_CONSOLE_MESSAGES) {
				omitted += 1;
				return;
			}
			const text = raw.replaceAll(PAGE_URL, PAGE_NAME);
			messages.push({ level, text: text.length > MAX_CONSOLE_TEXT_CHARS ? `${text.slice(0, MAX_CONSOLE_TEXT_CHARS)}…` : text });
		};
		page.on("console", (message) => {
			const level = CONSOLE_LEVELS[message.type()];
			if (level !== undefined) push(level, message.text());
		});
		page.on("pageerror", (error) => push("error", error.stack ?? error.message));
		const cdp = await context.newCDPSession(page);
		await cdp.send("Log.enable");
		cdp.on("Log.entryAdded", ({ entry }) => {
			if (entry.level === "error" || entry.level === "warning") push(entry.level, entry.url ? `${entry.text} ${entry.url}` : entry.text);
		});
		let body = "";
		await context.route("**/*", async (route) => {
			const request = route.request();
			const url = request.url().split("#", 1)[0]!;
			if (url === PAGE_URL) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
			if (url.startsWith(`${PAGE_ORIGIN}/`)) return route.abort("accessdenied");
			if (request.resourceType() === "document") {
				let mainFrame = true;
				try {
					mainFrame = request.frame() === page.mainFrame();
				} catch {}
				return mainFrame ? route.abort("accessdenied") : route.continue();
			}
			return route.continue();
		});
		const load = async (html: string, fragment: string): Promise<number> => {
			body = html;
			await page.goto(`${PAGE_URL}${fragment}`, { waitUntil: "load" });
			await page.evaluate(SETTLE_EXPRESSION);
			const measured = (await page.evaluate(MEASURE_EXPRESSION)) as number;
			return Math.max(0, Math.ceil(measured));
		};
		const consoleMessages = () => (omitted === 0 ? [...messages] : [...messages, { level: "warning" as const, text: `${omitted} more console messages were omitted.` }]);
		return { page, context, consoleMessages, load };
	} catch (error) {
		await context.close().catch(() => {});
		throw error;
	}
}

/** T3's preview: the page at a width, in a theme, as a PNG of up to 4,000 px, with its content height and console. */
export type HtmlPreview = {
	width: number;
	contentHeight: number;
	capturedHeight: number;
	consoleMessages: ConsoleMessage[];
	missingImages?: string[];
	screenshot: { mimeType: "image/png"; data: string; width: number; height: number };
};

export async function previewHtml(env: ExecutionEnv, browser: Browser, input: { html: string; width?: number; appearance?: "dark" | "light" }, context: Context): Promise<HtmlPreview> {
	const width = Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_PREVIEW_WIDTH, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH)));
	const appearance = input.appearance ?? "dark";
	const page = await preparePage(env, input.html, context);
	const theme = htmlRenderTheme(appearance === "light" ? T3_CODE_LIGHT_THEME_COLORS : T3_CODE_DARK_THEME_COLORS, appearance, HTML_RENDER_MEASURE_FONTS);
	const opened = await withTimeout(openPage(browser, width, appearance), CAPTURE_TIMEOUT_MS, "opening the preview page");
	try {
		return await withTimeout(
			(async () => {
				const contentHeight = await opened.load(page.html, htmlRenderThemeFragment(theme));
				const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE_HEIGHT));
				const png = await opened.page.screenshot({ type: "png", clip: { x: 0, y: 0, width, height: capturedHeight } });
				return {
					width,
					contentHeight,
					capturedHeight,
					consoleMessages: opened.consoleMessages(),
					...(page.missing.length === 0 ? {} : { missingImages: page.missing }),
					screenshot: { mimeType: "image/png" as const, data: Buffer.from(png).toString("base64"), width, height: capturedHeight },
				};
			})(),
			CAPTURE_TIMEOUT_MS,
			"capturing the page",
		);
	} finally {
		await opened.context.close().catch(() => {});
	}
}

/** The page's height at each of T3's measure widths, three at a time; undefined when it cannot be measured in time
 * (T3 then publishes without heights, and clients fit the frame to the live page). */
export async function measureHtml(browser: Browser, html: string): Promise<[number, number][] | undefined> {
	const contexts: BrowserContext[] = [];
	const measureAt = async (width: number): Promise<[number, number]> => {
		const opened = await openPage(browser, width, "dark");
		contexts.push(opened.context);
		return [width, await opened.load(html, MEASURE_FRAGMENT)];
	};
	try {
		return await withTimeout(
			(async () => {
				const heights: [number, number][] = [];
				const widths = [...HTML_RENDER_MEASURE_WIDTHS];
				while (widths.length > 0) heights.push(...(await Promise.all(widths.splice(0, MEASURE_CONCURRENCY).map(measureAt))));
				return heights.toSorted(([left], [right]) => left - right);
			})(),
			MEASURE_TIMEOUT_MS,
			"measuring",
		);
	} catch {
		return undefined;
	} finally {
		await Promise.all(contexts.map((context) => context.close().catch(() => {})));
	}
}

// ---- publishing ----------------------------------------------------------------------------------------------

/** T3's `html_render`: the prepared page, its reference (clamped height, measured heights when a browser measured it). */
export async function preparePublish(
	env: ExecutionEnv,
	input: { html: string; title: string; height: number },
	browser: (() => Promise<Browser>) | undefined,
	context: Context,
): Promise<{ html: string; title: string; height: number; heights?: [number, number][] }> {
	const page = await preparePage(env, input.html, context);
	if (page.missing.length > 0) throw new HtmlPageError(`These local images could not be read: ${page.missing.join(", ")}. Use absolute paths to existing image files, or remove them.`);
	let heights: [number, number][] | undefined;
	if (browser !== undefined) {
		try {
			heights = await measureHtml(await withTimeout(browser(), MEASURE_TIMEOUT_MS, "opening the browser"), page.html);
		} catch {
			heights = undefined;
		}
	}
	return {
		html: page.html,
		title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
		height: clampHtmlRenderHeight(input.height),
		...(heights === undefined ? {} : { heights }),
	};
}

// ---- tool descriptions (T3's, `mcp/toolkits/html/tools.ts`) --------------------------------------------------

const PAGE_RULES = "Inline <style> and <script>. Local images as absolute paths are inlined. Remote URLs load as-is.";
/** T3's agent guidance for visuals (`orchestrationInstructions.ts`), carried by the tool so it travels with it. */
const WHEN_TO_USE =
	"Answer data with a trend or comparison with a chart, and show any visual the user asks for here: pass its HTML to html_preview, then html_render. If the visual is a file, pass that file's HTML. A screenshot on disk or a text description does not show it. Never start a server for it. Asked for an image to post, send, or use elsewhere: a .png file and its path, never html_render.";

export const HTML_PREVIEW_DESCRIPTION = `Check an HTML page before html_render. Returns PNG, contentHeight, and console output. ${PAGE_RULES} Theme and layout rules are in html_render.`;
export const HTML_RENDER_DESCRIPTION = `Show a finished HTML page (chart, diagram, mockup) inline in this thread, above your final reply. Do not announce or restate the page. Frame fits height to ${HTML_RENDER_MAX_FIT_HEIGHT}px. On mobile, content past the given height scrolls. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE} ${WHEN_TO_USE}`;
export const HTML_RENDER_MESSAGE = "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";
export const HTML_RENDER_HEIGHT_DESCRIPTION = `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the contentHeight from html_preview.`;
export const HTML_PREVIEW_WIDTH_DESCRIPTION = `CSS pixels, ${MIN_PREVIEW_WIDTH} to ${MAX_PREVIEW_WIDTH}. Default ${HTML_RENDER_COLUMN_WIDTH}. Use about 390 for phones.`;
