// A small server-side preview browser for T3's preview panel. T3's own server runs a headless Chromium beside the
// environment; this host does the same through a CDP endpoint (Browserless, or any Chromium speaking the same
// protocol). The preview RPCs own the tab bookkeeping; the stream route (`preview-http.ts`) owns the socket.
//
// Nothing here is a page reader: `fetch_page` and the harness browser tools are separate. This exists so a user can
// see and drive a local dev server from T3's web or mobile client, without exposing the workspace network to the
// device.
import { randomUUID } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from "playwright-core";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	FILL_PREVIEW_VIEWPORT,
	PreviewInvalidUrlError,
	PreviewSessionLookupError,
	ThreadId,
	type PreviewAdjustInput,
	type PreviewCloseInput,
	type PreviewEvent,
	type PreviewListResult,
	type PreviewOpenInput,
	type PreviewReportStatusInput,
	type PreviewResizeInput,
	type PreviewSessionSnapshot,
	type PreviewViewportSetting,
} from "@t3tools/contracts";
import type { Logger } from "./logging.ts";
import type { PreviewBrowserConfig } from "./preview-config.ts";

const CONNECT_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_TABS_PER_THREAD = 8;
const MAX_TABS_TOTAL = 32;
const AGENT_TAB_IDLE_MS = 30 * 60_000;
const USER_TAB_IDLE_MS = 24 * 60 * 60_000;
const TAB_SWEEP_MS = 60_000;
const BROWSER_IDLE_MS = 15 * 60_000;
const MAX_VIEWERS = 4;
const MAX_URL_LENGTH = 2_048;
const SAVE_INTERVAL_MS = 30_000;
const SAVE_DEBOUNCE_MS = 500;

type PreviewStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;


export type PreviewViewerSink = {
	readonly frame: (data: Uint8Array) => void;
	readonly json: (value: unknown) => void;
	readonly close: (code: number, reason: string) => void;
};

export interface PreviewViewer {
	readonly id: string;
	readonly canOperate: boolean;
	ack(): void;
	input(value: unknown): Promise<void>;
	close(code?: number, reason?: string): void;
}

/** A preview tab an agent can drive: the same Playwright page T3 streams to the user. */
export type PreviewAgentSession = {
	readonly id: string;
	readonly page: Page;
	touch(): void;
	close(): Promise<void>;
};

type EventDraft =
	| { type: "opened" | "navigated" | "resized"; threadId: string; tabId: string; createdAt: string; snapshot: PreviewSessionSnapshot }
	| { type: "closed"; threadId: string; tabId: string; createdAt: string }
	| { type: "failed"; threadId: string; tabId: string; createdAt: string; url: string; title: string; code: number; description: string };

const now = () => new Date().toISOString();
const keyOf = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

function endpoint(config: PreviewBrowserConfig): string {
	const url = new URL(config.cdpUrl);
	if (config.token !== undefined && config.token !== "") url.searchParams.set("token", config.token);
	return url.toString();
}

function invalidUrl(raw: string, reason: "empty" | "parse" | "unsupported-protocol" | "unexpected", protocol?: string): PreviewInvalidUrlError {
	return new PreviewInvalidUrlError({
		inputLength: raw.length,
		reason,
		...(protocol === undefined ? {} : { protocol }),
		cause: new Error(`Invalid preview URL: ${reason}`),
	});
}

function normalizeUrl(raw: string): string {
	if (raw.trim() === "") throw invalidUrl(raw, "empty");
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw invalidUrl(raw, "parse");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw invalidUrl(raw, "unsupported-protocol", parsed.protocol);
	if (parsed.toString().length > MAX_URL_LENGTH) throw invalidUrl(raw, "unexpected");
	return parsed.toString();
}

function viewportSize(setting: PreviewViewportSetting | undefined): { width: number; height: number } | undefined {
	if (setting === undefined || setting._tag === "fill") return undefined;
	return { width: setting.width, height: setting.height };
}

/** The device toolbar's selected viewport: fill, freeform, or a preset (kept as freeform here). */
function viewportSetting(value: unknown): PreviewViewportSetting | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const setting = value as Record<string, unknown>;
	if (setting._tag === "fill") return FILL_PREVIEW_VIEWPORT;
	if ((setting._tag === "freeform" || setting._tag === "preset") && typeof setting.width === "number" && typeof setting.height === "number") {
		const width = Math.max(1, Math.round(setting.width));
		const height = Math.max(1, Math.round(setting.height));
		return { _tag: "freeform", width, height };
	}
	return undefined;
}

function controlMessage(tab: PreviewTab, viewer: PreviewViewerImpl): Record<string, unknown> {
	const dialog = tab.dialog;
	return {
		type: "control",
		canOperate: viewer.canOperate,
		controller: tab.controller === viewer.id ? "you" : tab.controller === null ? "unclaimed" : "another-viewer",
		generation: tab.controlGeneration,
		dialog: dialog === null ? null : {
			type: dialog.type(),
			message: dialog.message().slice(0, 4_000),
			defaultValue: dialog.defaultValue().slice(0, 4_000),
		},
	};
}

/** One preview tab, including its Chromium page and its attached stream viewers. */
class PreviewTab {
	readonly threadId: string;
	readonly tabId: string;
	readonly createdAt: number;
	readonly origin: "agent" | "user";
	usedAt: number;
	snapshot: PreviewSessionSnapshot;
	page: Page | undefined;
	context: BrowserContext | undefined;
	cdp: CDPSession | undefined;
	dialog: Dialog | null = null;
	controller: string | null = null;
	controlGeneration = 0;
	readonly viewers = new Set<PreviewViewerImpl>();
	readonly #owner: PreviewSessions;
	#closed = false;
	#screencastStarted = false;
	#frameWaiters = 0;
	#frameSessionId: number | undefined;
	#pageHooks = false;
	#pageSize: { width: number; height: number } | undefined;

	constructor(owner: PreviewSessions, snapshot: PreviewSessionSnapshot, origin: "agent" | "user") {
		this.#owner = owner;
		this.threadId = snapshot.threadId;
		this.tabId = snapshot.tabId;
		this.createdAt = Date.now();
		this.origin = origin;
		this.usedAt = this.createdAt;
		this.snapshot = snapshot;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** The page an agent drives. It is the same page T3's preview viewers see. */
	async agentPage(): Promise<Page> {
		await this.ensurePage();
		if (this.page === undefined) throw new Error("The preview page is closed.");
		return this.page;
	}

	touch(): void {
		this.usedAt = Date.now();
	}

	/** Keep the page work off the RPC path: a tab with no URL stays a snapshot until a viewer or a navigate needs it. */
	async ensurePage(): Promise<void> {
		if (this.#closed) throw new Error("The preview tab is closed.");
		if (this.page !== undefined) return;
		const size = viewportSize(this.snapshot.viewport) ?? DEFAULT_VIEWPORT;
		this.context = await this.#owner.context();
		if (this.#closed) throw new Error("The preview tab was closed while it was opening.");
		this.page = await this.context.newPage();
		this.page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
		this.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
		this.cdp = await this.context.newCDPSession(this.page);
		// Browserless opens pages at its own window size; a CDP override is what makes the screencast match the tab.
		await this.#setViewport(size.width, size.height);
		this.cdp.on("Page.screencastFrame", (event) => this.#onScreencastFrame(event));
		this.#wirePage();
		const loading = this.snapshot.navStatus;
		if (loading._tag === "Loading") await this.#navigate(loading.url);
		else {
			await this.#applyViewport();
			this.#sendViewportAll();
		}
	}

	async #wirePage(): Promise<void> {
		const page = this.page;
		if (page === undefined || this.#pageHooks) return;
		this.#pageHooks = true;
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame() || this.#closed) return;
			const url = frame.url();
			if (url === "" || url === "about:blank") return;
			this.#owner.update(this, { navStatus: { _tag: "Loading", url, title: "" }, canGoBack: false, canGoForward: false });
		});
		page.on("load", () => void this.#settle());
		page.on("dialog", (dialog) => {
			this.dialog = dialog;
			this.controlGeneration += 1;
			this.#broadcastControl();
		});
		page.on("close", () => void this.#owner.closeTab(this));
	}

	async #settle(): Promise<void> {
		const page = this.page;
		if (page === undefined || this.#closed) return;
		try {
			const history = await this.cdp?.send("Page.getNavigationHistory");
			const title = await page.title().catch(() => "");
			const url = page.url();
			if (url === "about:blank") return;
			const index = history?.currentIndex ?? 0;
			const count = history?.entries.length ?? 0;
			this.#owner.update(this, {
				navStatus: { _tag: "Success", url, title },
				canGoBack: index > 0,
				canGoForward: index < count - 1,
			});
			this.touch();
			this.#owner.scheduleSave();
		} catch {
			// A page that vanished between load and title collection has no status to report.
		}
	}

	async navigate(url: string): Promise<void> {
		await this.#navigate(url);
	}

	async #navigate(url: string): Promise<void> {
		this.touch();
		const page = this.page;
		if (page === undefined) return;
		this.#owner.update(this, { navStatus: { _tag: "Loading", url, title: "" }, canGoBack: false, canGoForward: false });
		try {
			await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
		} catch (error) {
			const title = await page.title().catch(() => "");
			this.#owner.fail(this, url, title, (error as Error).message || String(error));
		}
	}

	async #setViewport(width: number, height: number): Promise<void> {
		this.#pageSize = { width, height };
		await this.cdp?.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => undefined);
	}

	async #applyViewport(): Promise<void> {
		const size = viewportSize(this.snapshot.viewport);
		if (this.page === undefined || size === undefined) return;
		await this.#setViewport(size.width, size.height);
	}

	async #startScreencast(): Promise<void> {
		const cdp = this.cdp;
		if (cdp === undefined || this.#screencastStarted || this.#closed) return;
		const viewer = this.viewers.values().next().value as PreviewViewerImpl | undefined;
		if (viewer === undefined) return;
		this.#screencastStarted = true;
		try {
			await cdp.send("Page.startScreencast", {
				format: "jpeg",
				quality: 70,
				maxWidth: Math.max(1, Math.round(viewer.maxWidth)),
				maxHeight: Math.max(1, Math.round(viewer.maxHeight)),
				everyNthFrame: 1,
			});
		} catch {
			this.#screencastStarted = false;
		}
	}

	async #stopScreencast(): Promise<void> {
		if (!this.#screencastStarted || this.cdp === undefined) {
			this.#screencastStarted = false;
			return;
		}
		this.#screencastStarted = false;
		this.#frameWaiters = 0;
		this.#frameSessionId = undefined;
		await this.cdp.send("Page.stopScreencast").catch(() => undefined);
	}

	async attach(canOperate: boolean, maxWidth: number, maxHeight: number, sink: PreviewViewerSink): Promise<PreviewViewer> {
		await this.ensurePage();
		if (this.#closed) throw new Error("The preview tab is closed.");
		if (this.viewers.size >= MAX_VIEWERS) throw new Error("This preview tab already has enough viewers.");
		const viewer = new PreviewViewerImpl(this, randomUUID(), canOperate, maxWidth, maxHeight, sink);
		this.viewers.add(viewer);
		viewer.sendJson(controlMessage(this, viewer));
		this.#sendViewport(viewer);
		await this.#startScreencast();
		return viewer;
	}

	removeViewer(viewer: PreviewViewerImpl): void {
		if (!this.viewers.delete(viewer)) return;
		if (this.controller === viewer.id) {
			this.controller = null;
			this.controlGeneration += 1;
		}
		if (viewer.busy) {
			viewer.busy = false;
			if (this.#frameWaiters > 0) this.#frameWaiters -= 1;
		}
		if (this.viewers.size === 0) {
			if (this.controller === null) this.touch();
			void this.#stopScreencast();
		}
		this.#broadcastControl();
	}

	#broadcastControl(): void {
		for (const viewer of this.viewers) viewer.sendJson(controlMessage(this, viewer));
	}

	#sendViewport(viewer: PreviewViewerImpl): void {
		const size = this.#pageSize ?? viewportSize(this.snapshot.viewport) ?? DEFAULT_VIEWPORT;
		viewer.sendJson({ type: "viewport", width: size.width, height: size.height });
	}

	#sendViewportAll(): void {
		for (const viewer of this.viewers) this.#sendViewport(viewer);
	}

	async takeControl(viewer: PreviewViewerImpl): Promise<void> {
		if (!viewer.canOperate) return;
		this.controller = viewer.id;
		this.controlGeneration += 1;
		this.#broadcastControl();
	}

	async releaseControl(viewer: PreviewViewerImpl): Promise<void> {
		if (this.controller !== viewer.id) return;
		this.controller = null;
		this.controlGeneration += 1;
		this.#broadcastControl();
	}

	async resolveDialog(viewer: PreviewViewerImpl, accept: boolean, promptText?: string): Promise<void> {
		if (this.controller !== viewer.id || this.dialog === null) return;
		const dialog = this.dialog;
		this.dialog = null;
		if (accept) await dialog.accept(promptText);
		else await dialog.dismiss();
		this.controlGeneration += 1;
		this.#broadcastControl();
	}

	async input(viewer: PreviewViewerImpl, raw: unknown): Promise<void> {
		if (!viewer.canOperate) return;
		this.touch();
		if (typeof raw !== "object" || raw === null) return;
		const message = raw as Record<string, unknown>;
		const type = message.type;
		if (type === "takeControl") return this.takeControl(viewer);
		if (type === "releaseControl") return this.releaseControl(viewer);
		if (type === "dialog") {
			if (typeof message.accept !== "boolean") return;
			return this.resolveDialog(viewer, message.accept, typeof message.promptText === "string" ? message.promptText : undefined);
		}
		if (this.controller !== viewer.id) return;
		try {
			await this.#dispatch(viewer, message);
			this.#owner.scheduleSave();
		} catch {
			this.#broadcastControl();
		}
	}

	async #dispatch(viewer: PreviewViewerImpl, message: Record<string, unknown>): Promise<void> {
		const page = this.page;
		const cdp = this.cdp;
		if (page === undefined || cdp === undefined) return;
		switch (message.type) {
			case "mouse": {
				if (message.action !== "move" && message.action !== "down" && message.action !== "up") return;
				const button = message.button === "left" || message.button === "middle" || message.button === "right" ? message.button : "none";
				await cdp.send("Input.dispatchMouseEvent", {
					type: message.action === "move" ? "mouseMoved" : message.action === "down" ? "mousePressed" : "mouseReleased",
					x: Number(message.x ?? 0),
					y: Number(message.y ?? 0),
					button,
					buttons: Number(message.buttons ?? 0),
					clickCount: Number(message.clickCount ?? 0),
					modifiers: Number(message.modifiers ?? 0),
				});
				return;
			}
			case "wheel":
				await cdp.send("Input.dispatchMouseEvent", {
					type: "mouseWheel",
					x: Number(message.x ?? 0),
					y: Number(message.y ?? 0),
					deltaX: Number(message.deltaX ?? 0),
					deltaY: Number(message.deltaY ?? 0),
					modifiers: Number(message.modifiers ?? 0),
				});
				return;
			case "key": {
				const key = String(message.key ?? "");
				const code = String(message.code ?? "");
				const text = typeof message.text === "string" ? message.text : undefined;
				const keyCode = typeof message.keyCode === "number" ? message.keyCode : undefined;
				await cdp.send("Input.dispatchKeyEvent", {
					type: message.action === "up" ? "keyUp" : "keyDown",
					key,
					code,
					...(keyCode === undefined ? {} : { windowsVirtualKeyCode: keyCode }),
					...(text === undefined || message.action === "up" ? {} : { text }),
					modifiers: Number(message.modifiers ?? 0),
				});
				return;
			}
			case "text":
				if (typeof message.text === "string") await cdp.send("Input.insertText", { text: message.text });
				return;
			case "navigate":
				if (typeof message.url === "string") await this.navigate(normalizeUrl(message.url));
				return;
			case "history":
				if (message.delta === -1) await page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				else if (message.delta === 1) await page.goForward({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
				return;
			case "reload":
				await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS, ...(message.ignoreCache === true ? {} : {}) });
				return;
			case "probe": {
				const x = Number(message.x ?? 0);
				const y = Number(message.y ?? 0);
				const editable = await page.evaluate(([px, py]) => {
					const doc = (globalThis as { document?: { elementFromPoint(x: number, y: number): { closest(selector: string): unknown } | null } }).document;
					const element = doc?.elementFromPoint(px, py);
					return element !== null && element !== undefined && element.closest("input, textarea, [contenteditable=true]") !== null;
				}, [x, y] as const).catch(() => false);
				viewer.sendJson({ type: "probe", x, y, editable });
				return;
			}
			case "resize": {
				if (typeof message.width !== "number" || typeof message.height !== "number") return;
				const width = Math.max(1, Math.round(message.width));
				const height = Math.max(1, Math.round(message.height));
				await this.#setViewport(width, height);
				this.#owner.update(this, { viewport: { _tag: "freeform", width, height } });
				this.#sendViewportAll();
				return;
			}
			case "viewport": {
				// T3's device toolbar sends the selected setting; fill follows the panel through `resize` instead.
				const setting = viewportSetting(message.setting);
				if (setting === undefined) return;
				if (setting._tag !== "fill") await this.#setViewport(setting.width, setting.height);
				this.#owner.update(this, { viewport: setting });
				this.#sendViewportAll();
				return;
			}
			default:
				return;
		}
	}

	#onScreencastFrame(event: { data: string; sessionId: number }): void {
		if (this.#closed) return;
		const viewers = [...this.viewers].filter((viewer) => !viewer.busy);
		if (viewers.length === 0) {
			void this.cdp?.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => undefined);
			return;
		}
		const data = Buffer.from(event.data, "base64");
		this.#frameSessionId = event.sessionId;
		this.#frameWaiters = viewers.length;
		for (const viewer of viewers) {
			viewer.busy = true;
			viewer.sendFrame(data);
		}
	}

	ackFrame(viewer: PreviewViewerImpl): void {
		if (this.#closed) return;
		if (this.#frameWaiters > 0) this.#frameWaiters -= 1;
		if (this.#frameWaiters === 0 && this.#frameSessionId !== undefined) {
			const sessionId = this.#frameSessionId;
			this.#frameSessionId = undefined;
			void this.cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
		}
		void viewer;
	}

	async applySetting(): Promise<void> {
		if (this.page === undefined) return;
		await this.#applyViewport();
		if (this.snapshot.colorScheme !== undefined && this.snapshot.colorScheme !== "system") {
			await this.page.emulateMedia({ colorScheme: this.snapshot.colorScheme }).catch(() => undefined);
		}
		this.#sendViewportAll();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#stopScreencast();
		for (const viewer of [...this.viewers]) viewer.close(4404, "tab closed");
		this.viewers.clear();
		if (this.dialog !== null) {
			await this.dialog.dismiss().catch(() => undefined);
			this.dialog = null;
		}
		const page = this.page;
		this.context = undefined;
		this.page = undefined;
		this.cdp = undefined;
		if (page !== undefined) await page.close().catch(() => undefined);
		this.#owner.scheduleSave();
	}
}

/** A viewer is one websocket. Frame acknowledgements pace Chromium's screencast; all other traffic is JSON. */
class PreviewViewerImpl implements PreviewViewer {
	readonly id: string;
	readonly canOperate: boolean;
	readonly maxWidth: number;
	readonly maxHeight: number;
	busy = false;
	readonly #tab: PreviewTab;
	readonly #sink: PreviewViewerSink;
	#closed = false;

	constructor(tab: PreviewTab, id: string, canOperate: boolean, maxWidth: number, maxHeight: number, sink: PreviewViewerSink) {
		this.#tab = tab;
		this.id = id;
		this.canOperate = canOperate;
		this.maxWidth = Math.min(7_680, Math.max(1, Math.round(maxWidth)));
		this.maxHeight = Math.min(4_320, Math.max(1, Math.round(maxHeight)));
		this.#sink = sink;
	}

	sendFrame(data: Uint8Array): void {
		if (this.#closed) return;
		this.#sink.frame(data);
	}

	sendJson(value: unknown): void {
		if (!this.#closed) this.#sink.json(value);
	}

	ack(): void {
		if (this.busy) {
			this.busy = false;
			this.#tab.ackFrame(this);
		}
	}

	async input(value: unknown): Promise<void> {
		if (!this.#closed) await this.#tab.input(this, value);
	}

	close(code = 4404, reason = "tab closed"): void {
		if (this.#closed) return;
		this.#closed = true;
		this.busy = false;
		this.#tab.removeViewer(this);
		this.#sink.close(code, reason);
	}
}

/** The bridge's preview tabs and their event stream. One shared Browserless connection owns all of them. */
export class PreviewSessions {
	readonly serverEpoch = randomUUID();
	revision = 0;
	readonly #config: PreviewBrowserConfig;
	readonly #log: Logger;
	readonly #tabs = new Map<string, PreviewTab>();
	readonly #listeners = new Set<(event: PreviewEvent) => void>();
	#browser: Browser | undefined;
	#browserOpening: Promise<Browser> | undefined;
	#context: BrowserContext | undefined;
	#contextOpening: Promise<BrowserContext> | undefined;
	#saveTimer: NodeJS.Timeout | undefined;
	#saveDebounce: NodeJS.Timeout | undefined;
	#saveQueue: Promise<void> = Promise.resolve();
	#sweepTimer: NodeJS.Timeout | undefined;
	#browserIdleTimer: NodeJS.Timeout | undefined;

	constructor(config: PreviewBrowserConfig, log: Logger) {
		this.#config = config;
		this.#log = log;
		this.#sweepTimer = setInterval(() => void this.sweepIdleTabs(), TAB_SWEEP_MS);
		this.#sweepTimer.unref();
	}

	async browser(): Promise<Browser> {
		if (this.#browser !== undefined && this.#browser.isConnected()) return this.#browser;
		this.#browserOpening ??= chromium.connectOverCDP(endpoint(this.#config), { timeout: CONNECT_TIMEOUT_MS }).then((browser) => {
			if (this.#browser === undefined) this.#browser = browser;
			browser.on("disconnected", () => {
				if (this.#browser === browser) this.#browser = undefined;
				this.#context = undefined;
				this.#stopSaveTimers();
				for (const tab of [...this.#tabs.values()]) void this.closeTab(tab, "browser disconnected");
			});
			return browser;
		}).finally(() => {
			this.#browserOpening = undefined;
		});
		return this.#browserOpening;
	}

	/** One context for all preview tabs: cookies and localStorage are shared and persisted by the profile. */
	async context(): Promise<BrowserContext> {
		if (this.#context !== undefined && !this.#context.isClosed()) return this.#context;
		this.#contextOpening ??= this.#createContext().finally(() => {
			this.#contextOpening = undefined;
		});
		return this.#contextOpening;
	}

	async #createContext(): Promise<BrowserContext> {
		const browser = await this.browser();
		const storageState = await this.#readState();
		const context = await browser.newContext({
			viewport: DEFAULT_VIEWPORT,
			...(storageState === undefined ? {} : { storageState }),
		});
		this.#context = context;
		context.on("close", () => {
			if (this.#context === context) this.#context = undefined;
			this.#stopSaveTimers();
		});
		this.#startSaveTimers();
		return context;
	}

	async #readState(): Promise<PreviewStorageState | undefined> {
		const path = this.#config.storageStatePath;
		if (path === undefined) return undefined;
		try {
			return JSON.parse(await readFile(path, "utf8")) as PreviewStorageState;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.#log.warn("could not read the browser profile", { path, error: (error as Error).message });
			}
			return undefined;
		}
	}

	/** Schedule a profile write after a page change; bursts collapse into one write. */
	scheduleSave(): void {
		if (this.#config.storageStatePath === undefined || this.#context === undefined) return;
		if (this.#saveDebounce !== undefined) clearTimeout(this.#saveDebounce);
		this.#saveDebounce = setTimeout(() => void this.saveState(), SAVE_DEBOUNCE_MS);
		this.#saveDebounce.unref();
	}

	/** Write cookies and origins' localStorage. A no-op without a storageState path or an open context. */
	saveState(): Promise<void> {
		const path = this.#config.storageStatePath;
		const context = this.#context;
		if (path === undefined || context === undefined || context.isClosed()) return Promise.resolve();
		this.#saveQueue = this.#saveQueue
			.catch(() => undefined)
			.then(async () => {
				const state = await context.storageState();
				await mkdir(dirname(path), { recursive: true });
				const temporary = `${path}.tmp`;
				await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
				await rename(temporary, path);
			})
			.catch((error: unknown) => this.#log.warn("could not save the browser profile", { path, error: (error as Error).message }));
		return this.#saveQueue;
	}

	#startSaveTimers(): void {
		if (this.#config.storageStatePath === undefined) return;
		this.#stopSaveTimers();
		this.#saveTimer = setInterval(() => void this.saveState(), SAVE_INTERVAL_MS);
		this.#saveTimer.unref();
	}

	#stopSaveTimers(): void {
		if (this.#saveTimer !== undefined) clearInterval(this.#saveTimer);
		if (this.#saveDebounce !== undefined) clearTimeout(this.#saveDebounce);
		this.#saveTimer = undefined;
		this.#saveDebounce = undefined;
	}

	#publish(draft: EventDraft): void {
		const event = { ...draft, revision: ++this.revision, serverEpoch: this.serverEpoch } as PreviewEvent;
		for (const listener of this.#listeners) listener(event);
	}

	subscribe(listener: (event: PreviewEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Open a preview tab an agent can drive and reveal it. The tab is visible in T3; there is no hidden preview.
	 */
	async openAgentSession(threadId: string, url: string): Promise<PreviewAgentSession> {
		await this.sweepIdleTabs();
		const thread = ThreadId.make(threadId);
		const snapshot = this.openTab({ threadId: thread, url, reveal: true }, "agent");
		const tab = this.require(threadId, snapshot.tabId);
		const page = await tab.agentPage();
		return {
			id: snapshot.tabId,
			page,
			touch: () => this.touch(tab),
			close: () => this.close({ threadId: thread, tabId: snapshot.tabId }),
		};
	}

	open(input: PreviewOpenInput): PreviewSessionSnapshot {
		return this.openTab(input, "user");
	}

	private openTab(input: PreviewOpenInput, origin: "agent" | "user"): PreviewSessionSnapshot {
		const threadTabs = [...this.#tabs.values()].filter((tab) => tab.threadId === input.threadId).length;
		if (threadTabs >= MAX_TABS_PER_THREAD) throw new Error(`Too many preview tabs for this thread (limit ${MAX_TABS_PER_THREAD}). Close one first.`);
		if (this.#tabs.size >= MAX_TABS_TOTAL) throw new Error(`Too many preview tabs overall (limit ${MAX_TABS_TOTAL}). Close one first.`);
		const url = input.url === undefined ? undefined : normalizeUrl(input.url);
		const updatedAt = now();
		const tabId = randomUUID().replace(/-/g, "");
		const snapshot: PreviewSessionSnapshot = {
			threadId: input.threadId,
			tabId,
			navStatus: url === undefined ? { _tag: "Idle" } : { _tag: "Loading", url, title: "" },
			canGoBack: false,
			canGoForward: false,
			viewport: input.viewport ?? FILL_PREVIEW_VIEWPORT,
			...(input.profileId === undefined ? {} : { profileId: input.profileId }),
			runtime: "server",
			...(input.reveal === undefined ? {} : { reveal: input.reveal }),
			updatedAt,
		};
		const tab = new PreviewTab(this, snapshot, origin);
		this.#tabs.set(keyOf(input.threadId, tabId), tab);
		this.#clearBrowserIdle();
		this.#publish({ type: "opened", threadId: input.threadId, tabId, createdAt: updatedAt, snapshot });
		return snapshot;
	}

	/** Record user/agent activity on a tab, so the idle sweep does not close a page in use. */
	touch(tab: PreviewTab): void {
		tab.touch();
	}

	/** Close expired tabs with no viewer. Agent tabs idle after 30 minutes; user tabs after 24 hours. */
	async sweepIdleTabs(): Promise<void> {
		const now = Date.now();
		const expired = [...this.#tabs.values()].filter((tab) =>
			tab.viewers.size === 0 && tab.usedAt <= now - (tab.origin === "agent" ? AGENT_TAB_IDLE_MS : USER_TAB_IDLE_MS),
		);
		await Promise.all(expired.map((tab) => this.closeTab(tab, "idle")));
	}

	/** Close all tabs of one thread, for example when T3 deletes it. */
	async closeThread(threadId: string): Promise<void> {
		await this.close({ threadId: ThreadId.make(threadId) });
	}

	#clearBrowserIdle(): void {
		if (this.#browserIdleTimer !== undefined) clearTimeout(this.#browserIdleTimer);
		this.#browserIdleTimer = undefined;
	}

	#maybeCloseBrowser(): void {
		if (this.#tabs.size > 0 || this.#browserIdleTimer !== undefined) return;
		this.#browserIdleTimer = setTimeout(() => void this.#closeIdleBrowser(), BROWSER_IDLE_MS);
		this.#browserIdleTimer.unref();
	}

	async #closeIdleBrowser(): Promise<void> {
		this.#browserIdleTimer = undefined;
		if (this.#tabs.size > 0) return;
		await this.saveState();
		this.#stopSaveTimers();
		const context = this.#context;
		this.#context = undefined;
		await context?.close().catch(() => undefined);
		const browser = this.#browser;
		this.#browser = undefined;
		await browser?.close().catch(() => undefined);
		this.#log.info("preview browser idle-closed");
	}

	list(threadId: string): PreviewListResult {
		const sessions = [...this.#tabs.values()]
			.filter((tab) => tab.threadId === threadId)
			.map((tab) => tab.snapshot)
			.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
		return { sessions, serverEpoch: this.serverEpoch, revision: this.revision };
	}

	require(threadId: string, tabId: string): PreviewTab {
		const tab = this.#tabs.get(keyOf(threadId, tabId));
		if (tab === undefined) throw new PreviewSessionLookupError({ threadId, tabId });
		return tab;
	}

	update(tab: PreviewTab, patch: Partial<PreviewSessionSnapshot>): void {
		if (tab.closed) return;
		const updatedAt = now();
		tab.snapshot = { ...tab.snapshot, ...patch, updatedAt };
		this.#publish({ type: "navigated", threadId: tab.threadId, tabId: tab.tabId, createdAt: updatedAt, snapshot: tab.snapshot });
	}

	fail(tab: PreviewTab, url: string, title: string, description: string): void {
		if (tab.closed) return;
		const updatedAt = now();
		tab.snapshot = {
			...tab.snapshot,
			navStatus: { _tag: "LoadFailed", url, title, code: 0, description },
			canGoBack: false,
			canGoForward: false,
			updatedAt,
		};
		this.#publish({ type: "failed", threadId: tab.threadId, tabId: tab.tabId, createdAt: updatedAt, url, title, code: 0, description });
	}

	async resize(input: PreviewResizeInput): Promise<PreviewSessionSnapshot> {
		const tab = this.require(input.threadId, input.tabId);
		this.touch(tab);
		this.update(tab, { viewport: input.viewport });
		await tab.applySetting();
		return tab.snapshot;
	}

	async adjust(input: PreviewAdjustInput): Promise<PreviewSessionSnapshot> {
		const tab = this.require(input.threadId, input.tabId);
		this.touch(tab);
		this.update(tab, {
			...(input.colorScheme === undefined ? {} : { colorScheme: input.colorScheme }),
			...(input.zoomFactor === undefined ? {} : { zoomFactor: input.zoomFactor }),
		});
		if (tab.page !== undefined) {
			if (input.hardReload === true) await tab.page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
			if (input.clear === "cookies" && tab.context !== undefined) await tab.context.clearCookies().catch(() => undefined);
			else if (input.clear === "cache") await tab.cdp?.send("Network.clearBrowserCache").catch(() => undefined);
			this.scheduleSave();
		}
		await tab.applySetting();
		return tab.snapshot;
	}

	async reportStatus(input: PreviewReportStatusInput): Promise<void> {
		const tab = this.require(input.threadId, input.tabId);
		this.update(tab, { navStatus: input.navStatus, canGoBack: input.canGoBack, canGoForward: input.canGoForward });
	}

	async close(input: PreviewCloseInput): Promise<void> {
		const targets = input.tabId === undefined
			? [...this.#tabs.values()].filter((tab) => tab.threadId === input.threadId)
			: [...this.#tabs.values()].filter((tab) => tab.threadId === input.threadId && tab.tabId === input.tabId);
		await Promise.all(targets.map((tab) => this.closeTab(tab)));
	}

	async closeTab(tab: PreviewTab, reason = "closed"): Promise<void> {
		if (!this.#tabs.delete(keyOf(tab.threadId, tab.tabId))) return;
		await tab.close();
		this.#publish({ type: "closed", threadId: tab.threadId, tabId: tab.tabId, createdAt: now() });
		this.#log.info("preview tab closed", { tabId: tab.tabId, reason });
		this.#maybeCloseBrowser();
	}

	async attach(input: { threadId: string; tabId: string; canOperate: boolean; maxWidth: number; maxHeight: number }, sink: PreviewViewerSink): Promise<PreviewViewer> {
		const tab = this.require(input.threadId, input.tabId);
		return tab.attach(input.canOperate, input.maxWidth, input.maxHeight, sink);
	}

	/** No profile store here: T3's client reports profiles, and this host keeps none. */
	reportProfiles(): void {}
	clearProfile(): void {
		void this.#clearProfile();
	}

	async #clearProfile(): Promise<void> {
		const path = this.#config.storageStatePath;
		if (path !== undefined) await rm(path, { force: true }).catch(() => undefined);
		await this.#context?.clearCookies().catch(() => undefined);
	}

	async closeAll(): Promise<void> {
		if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer);
		this.#sweepTimer = undefined;
		this.#clearBrowserIdle();
		await this.saveState();
		await Promise.all([...this.#tabs.values()].map((tab) => this.closeTab(tab)));
		this.#clearBrowserIdle();
		this.#stopSaveTimers();
		const context = this.#context;
		this.#context = undefined;
		await context?.close().catch(() => undefined);
		const browser = this.#browser;
		this.#browser = undefined;
		await browser?.close().catch(() => undefined);
	}
}
