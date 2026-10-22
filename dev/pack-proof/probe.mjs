// Pair, send a prompt, see the reply, screenshot. argv: <pair link> <screenshot path>
import { chromium } from "playwright-core";

const [link, shot] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
	const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
	page.on("console", (m) => m.type() === "error" && console.log("[browser.error]", m.text().slice(0, 200)));
	page.on("pageerror", (e) => console.log("[pageerror]", e.message.slice(0, 200)));
	await page.goto(link, { waitUntil: "domcontentloaded" });
	const editor = page.locator('[contenteditable="true"]').first();
	await editor.waitFor({ timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: `${shot}.fail.png` }); throw e; });
	await editor.click();
	await page.keyboard.type("hello from the probe");
	await page.keyboard.press("Enter");
	await page.locator('[data-message-role="assistant"]').getByText("packed reply", { exact: false }).first().waitFor({ timeout: 60000 });
	await page.screenshot({ path: shot });
	console.log("PROBE OK: paired, prompted, reply visible");
} catch (error) {
	console.log("probe failed; screenshot of the page:", `${shot}.fail.png`);
	throw error;
} finally {
	await browser.close();
}
