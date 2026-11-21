// The preview manager against a real Chromium over CDP, as Browserless serves one: tabs live in the browser's own
// context (so its profile keeps what they store), the configured identity reaches the page before its own scripts,
// and T3's "clear browser data" clears the profile's cookies. Runs in the Chrome that `CHROMIUM` names (CI passes the
// runner's) and is skipped without one.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nullLogger } from "../src/t3/logging.ts";
import { PreviewSessions } from "../src/t3/preview.ts";

const chrome = process.env["CHROMIUM"];
const PAGE_PORT = 4955;
const CDP_PORT = 4956;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe.skipIf(chrome === undefined)("preview in a browser", () => {
	let server: Server;
	let browser: ChildProcess;
	let profile: string;
	let cdpUrl: string;

	beforeAll(async () => {
		// The page names what it sees as it loads: the init script's mark, the webdriver flag and the user agent.
		server = createServer((_, res) => {
			res.setHeader("set-cookie", "kept=1; Path=/");
			res.end("<!doctype html><title>-</title><script>document.title = [window.__identity, navigator.webdriver, navigator.userAgent].join('|')</script>");
		}).listen(PAGE_PORT, "127.0.0.1");
		profile = await mkdtemp(join(tmpdir(), "preview-profile-"));
		browser = spawn(chrome!, ["--headless", "--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
		for (let i = 0; i < 100 && cdpUrl === undefined; i++) {
			cdpUrl = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(async (response) => ((await response.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).catch(() => undefined as never);
			if (cdpUrl === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
		}
	});

	afterAll(async () => {
		server?.close();
		// Chrome writes its profile as it exits: remove the directory once it has.
		if (browser !== undefined && browser.exitCode === null && browser.signalCode === null) {
			const exited = new Promise((resolve) => browser.once("exit", resolve));
			browser.kill();
			await exited;
		}
		await rm(profile, { recursive: true, force: true, maxRetries: 5 });
	});

	it("opens tabs in the browser's own context with the configured identity, and clears its cookies", { timeout: 60_000 }, async () => {
		const initScript = "window.__identity = 'set'; Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });";
		const preview = new PreviewSessions({ cdpUrl, userAgent: USER_AGENT, initScript }, nullLogger);
		try {
			const session = await preview.openAgentSession("thread", `http://127.0.0.1:${PAGE_PORT}/`);
			await session.page.waitForFunction("document.title !== '-'");
			expect(await session.page.title()).toBe(`set|false|${USER_AGENT}`);
			const context = await preview.context();
			expect(context, "the browser's default context").toBe((await preview.browser()).contexts()[0]);
			expect((await context.cookies()).map((cookie) => cookie.name)).toEqual(["kept"]);
			preview.clearProfile();
			await expect.poll(() => context.cookies()).toEqual([]);
			await session.close();
		} finally {
			await preview.closeAll();
		}
	});
});
