// T3's html tools for an agent running beside the bridge (`T3Attachment.htmlTools`): `html_render` publishes a page that
// shows inline in the agent's thread, above its reply; `html_preview` (only with a browser) shows the agent the page
// first. A call works wherever it is made — the model's own call or a script's: the page is kept as an attachment, and a
// display-only entry (`app.html-render`) in the calling conversation is what the thread shows, so it is durable, and an
// undo of its run removes it.
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Browser } from "playwright-core";
import type { Threads } from "../threads.ts";
import { type Attachments, createDeterministicAttachmentId } from "./attachments.ts";
import {
	HTML_PREVIEW_DESCRIPTION,
	HTML_PREVIEW_WIDTH_DESCRIPTION,
	HTML_RENDER_DESCRIPTION,
	HTML_RENDER_HEIGHT_DESCRIPTION,
	HTML_RENDER_MESSAGE,
	HTML_RENDER_TOOL_NAME,
	HtmlPageError,
	preparePublish,
	previewHtml,
} from "./html-render.ts";
import { APP_HTML_RENDER_ENTRY } from "./runs.ts";
import { arr, int, opt, str, union } from "@earendil-works/pi-schema";
import { literal, object } from "./schema.ts";

type Callers = readonly ("model" | "tools")[];
type Api = { readonly conversationId: number; readonly taskId: unknown; readonly callId: string };

export interface HtmlToolsDeps {
	readonly threads: Threads;
	readonly threadIdOf: (conversationId: number) => Promise<string | undefined>;
	readonly attachments: Attachments;
	readonly env: ExecutionEnv;
	readonly context: Context;
	/** The host's browser (`preview`), when it has one: `html_preview`, and the heights a published page is measured at. */
	readonly browser?: () => Promise<Browser>;
}

const html = str({ minLength: 1, maxLength: 512_000, description: "A complete, self-contained HTML document." });
const renderParameters = object({
	html,
	title: str({ minLength: 1, maxLength: 200 }),
	height: int({ description: HTML_RENDER_HEIGHT_DESCRIPTION }),
});
const previewParameters = object({
	html,
	width: opt(int({ description: HTML_PREVIEW_WIDTH_DESCRIPTION })),
	appearance: opt(union([literal("dark"), literal("light")], { description: "Default dark." })),
});
const consoleMessage = object({ level: union([literal("log"), literal("info"), literal("warning"), literal("error")]), text: str() });
const PREVIEW_RESULT_SCHEMA = object({
	width: int(),
	contentHeight: int(),
	capturedHeight: int(),
	consoleMessages: arr(consoleMessage),
	missingImages: opt(arr(str())),
	screenshot: object({ mimeType: literal("image/png"), data: str(), width: int(), height: int() }),
});

const failure = (message: string) => ({ output: [{ type: "text" as const, text: message }], isError: true });

/** `html_render`, and `html_preview` when the host has a browser. `callers`: who may call them (default: the model and
 * scripts). */
export function htmlToolsExtension(deps: HtmlToolsDeps, options: { readonly callers?: Callers } = {}): Extension {
	const callers = options.callers ?? ["model", "tools"];
	const render = {
		name: HTML_RENDER_TOOL_NAME,
		description: HTML_RENDER_DESCRIPTION,
		parameters: renderParameters,
		callers,
		// The page's id and the entry's request id come from the call, so a replay writes the same file and entry once.
		replay: "safe",
		async execute(args: { html: string; title: string; height: number }, api: Api) {
			const threadId = await deps.threadIdOf(api.conversationId);
			if (threadId === undefined) return failure("html_render shows a page in a T3 thread, and this conversation is not one.");
			const key = `html-render:${String(api.taskId)}:${api.callId}`;
			let page: Awaited<ReturnType<typeof preparePublish>>;
			try {
				page = await preparePublish(deps.env, args, deps.browser, deps.context);
			} catch (error) {
				if (error instanceof HtmlPageError) return failure(error.message);
				throw error;
			}
			const attachmentId = createDeterministicAttachmentId(threadId, key, "html");
			if (attachmentId === null) return failure(`Thread ${threadId} cannot hold attachments.`);
			await deps.attachments.writeGenerated(attachmentId, new TextEncoder().encode(page.html));
			const htmlRender = { attachmentId, title: page.title, height: page.height, ...(page.heights === undefined ? {} : { heights: page.heights }) };
			await deps.threads.writeDisplayEntry(api.conversationId, key, APP_HTML_RENDER_ENTRY, { ...htmlRender, createdAt: Date.now() });
			const text = JSON.stringify({ htmlRender, message: HTML_RENDER_MESSAGE });
			return { output: [{ type: "text" as const, text }] };
		},
	};
	const tools = [render as unknown as ToolRegistration];
	const browser = deps.browser;
	if (browser !== undefined) {
		const preview = {
			name: "html_preview",
			description: HTML_PREVIEW_DESCRIPTION,
			parameters: previewParameters,
			structuredOutputSchema: PREVIEW_RESULT_SCHEMA,
			callers,
			replay: "safe",
			async execute(args: { html: string; width?: number; appearance?: "dark" | "light" }) {
				let result: Awaited<ReturnType<typeof previewHtml>>;
				try {
					result = await previewHtml(deps.env, await browser(), args, deps.context);
				} catch (error) {
					if (error instanceof HtmlPageError) return failure(error.message);
					return failure(`The page could not be previewed: ${error instanceof Error ? error.message : String(error)}`);
				}
				const { screenshot, ...facts } = result;
				return {
					output: [
						{ type: "text" as const, text: JSON.stringify({ ...facts, screenshot: { mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height } }) },
						{ type: "image" as const, data: screenshot.data, mimeType: screenshot.mimeType },
					],
					structuredOutput: result,
				};
			},
		};
		tools.push(preview as unknown as ToolRegistration);
	}
	return defineExtension({ name: "html-tools", tools });
}
