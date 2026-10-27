/** The browser endpoint for T3's server preview panel. A plain Chromium ignores the token; Browserless needs it. */
export interface PreviewBrowserConfig {
	readonly cdpUrl: string;
	readonly token?: string;
}
