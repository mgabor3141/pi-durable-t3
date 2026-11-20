/** The browser endpoint for T3's server preview panel. A plain Chromium ignores the token; Browserless needs it. */
export interface PreviewBrowserConfig {
	readonly cdpUrl: string;
	readonly token?: string;
	/**
	 * A durable Playwright storageState file (cookies and origins' localStorage). The preview browser keeps one context
	 * for all tabs, loads it at start and writes it back as the page changes. Absent: the session is ephemeral.
	 */
	readonly storageStatePath?: string;
	/**
	 * The user agent every tab presents, when set. Without it Chromium in a container announces a bare
	 * `Chrome/<version>` (or `HeadlessChrome` in headless mode), which some sites read as automation.
	 */
	readonly userAgent?: string;
	/**
	 * A document-start script, run in every frame before the page's own scripts. Used to remove the automation
	 * flags a CDP-driven browser exposes (`navigator.webdriver`, a software WebGL renderer, and so on).
	 */
	readonly initScript?: string;
}
