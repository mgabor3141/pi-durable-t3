/** The browser endpoint for T3's server preview panel. A plain Chromium ignores the token; Browserless needs it. */
export interface PreviewBrowserConfig {
	readonly cdpUrl: string;
	readonly token?: string;
	/**
	 * A durable Playwright storageState file (cookies and origins' localStorage). The preview browser keeps one context
	 * for all tabs, loads it at start and writes it back as the page changes. Absent: the session is ephemeral.
	 */
	readonly storageStatePath?: string;
}
