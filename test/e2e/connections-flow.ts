// The Connections check over the web app served from the facet origin: after pairing via `/pair`, the pi host is the
// primary environment ("This machine"), Settings → Connections shows its authorized clients, the browser mints a
// pairing link in the UI, and the device list shows this browser's own session. Run via dev/browser-smoke.sh, which
// sets T3_WEB (the facet origin, which now serves the app), PAIR2 (this browser's single-use pairing code), CHROMIUM.

import { chromium } from "playwright-core";

const webAppUrl = required("T3_WEB").replace(/\/$/, "");
const pairToken = required("PAIR2");
const chrome = process.env["CHROMIUM"] ?? "/usr/bin/chromium";
const heading = (message: string) =>
	console.log(`\n=== connections: ${message} ===`);
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

try {
	heading( "pair → the pi host is This machine → mint a link → see the device list", );
	const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"], });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, });
	page.on("pageerror", (error) => console.log(`[pageerror] ${error.message.slice(0, 200)}`), );

	// Pair, then land on the app as the primary (same-origin) environment.
	await page.goto(
		`${webAppUrl}/pair#${new URLSearchParams({ token: pairToken })}`,
		{ waitUntil: "domcontentloaded" },
	);
	await page
		.getByText("This browser is paired", { exact: false })
		.waitFor({ state: "visible", timeout: 20000 });
	await page.goto(`${webAppUrl}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[contenteditable]", { timeout: 30000 });

	// Open Settings → Connections directly (the SPA route, served by the facet's static fallback).
	await page.goto(`${webAppUrl}/settings/connections`, { waitUntil: "domcontentloaded", });

	// The pi host is the primary environment: its section is titled by the descriptor's label, and the authorized-clients
	// section (gated on the access scopes this browser's session holds) is present.
	await page
		.getByText("pi", { exact: true })
		.first()
		.waitFor({ state: "visible", timeout: 30000 });
	await page
		.getByText("Authorized clients", { exact: true })
		.first()
		.waitFor({ state: "visible", timeout: 30000 });

	// Mint a pairing link IN THE UI: the section's "Create link" action opens the dialog; submit it.
	const createLink = page.getByRole("button", { name: "Create link", exact: true, });
	await createLink.first().waitFor({ state: "visible", timeout: 30000 });
	await createLink.first().click();
	await page
		.getByText("Create pairing link")
		.first()
		.waitFor({ state: "visible", timeout: 15000 });
	// The dialog's submit is the last "Create link" button (the header trigger is the first).
	await page
		.getByRole("button", { name: "Create link", exact: true })
		.last()
		.click();

	// The minted link appears in the list (the default label): the write-scoped browser session minted it, and the
	// access stream pushed it back. Expand the section to see its rows.
	await page
		.getByText("Authorized clients", { exact: true })
		.first()
		.click()
		.catch(() => {});
	await page
		.getByText("Pairing link", { exact: true })
		.first()
		.waitFor({ state: "visible", timeout: 30000 });

	// The device list shows this browser's own session, marked as the current device.
	await page
		.getByText("This device", { exact: true })
		.first()
		.waitFor({ state: "visible", timeout: 30000 });

	await browser.close();
	console.log("\nconnections: PASS");
	process.exit(0);
} catch (error) {
	console.error(`\nconnections: FAIL — ${(error as Error).message}`);
	process.exit(1);
}
