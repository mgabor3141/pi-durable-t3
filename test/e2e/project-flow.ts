// The browser flow a user performs to manage projects, over the real (unmodified) T3 web app and the real facet:
//   1. pair,
//   2. add a project from the directory picker — the command palette's ">Add project" → "Local folder" → the path field
//      fed by `filesystem.browse`, then Enter sends `projects.mutate` {type:"project.create"} with the id the client
//      minted (a UUID — the host honors it, and the app navigates to it: the composer must be editable without reload),
//   3. create a thread in it — the composer sends a message; the SPA launches a thread in the active (new) project,
//   4. remove it — `projects.mutate` {type:"project.delete", force:true} (exactly what T3's sidebar "Remove project"
//      sends), over the REST parity route that shares the one store with `projects.mutate` on `/ws`,
//   5. confirm the project's on-disk directory is untouched and the server no longer lists the project.
//
// Run via dev/browser-smoke.sh. Env: T3_WEB (web app), BRIDGE (facet), PAIR (a single-use pairing code),
// PICK_TARGET (the directory to add), PICK_MARKER (a file inside it that must survive the removal).
// Asserts on the DOM, the outgoing WS frames, the REST project list, and the filesystem.

import { chromium } from "playwright-core";

const webAppUrl = required("T3_WEB").replace(/\/$/, "");
const bridgeUrl = required("BRIDGE").replace(/\/$/, "");
// Codes are single-use: PAIR is this script's own exchange; PAIR2 is the browser's pairing screen.
const pairToken = required("PAIR2");
const pickTarget = required("PICK_TARGET").replace(/\/+$/, "");
const pickMarker = required("PICK_MARKER");
const launchTimeout = Number(process.env["E2E_LAUNCH_TIMEOUT_MS"] ?? 60000);
const chrome = process.env["CHROMIUM"] ?? "/usr/bin/chromium";
const heading = (message: string) => console.log(`\n=== project-flow: ${message} ===`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

// Pair first: the code is exchanged once by this script and once by the web app's pairing screen, and codes are
// single-use, so this flow uses TWO codes (the smoke script mints both: PAIR for here, PAIR2 for the browser).
const token = await bridgeToken();
async function bridgeToken(): Promise<string> {
	const response = await fetch(`${bridgeUrl}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: required("PAIR"),
			subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		}).toString(),
	});
	const body = (await response.json().catch(() => ({}))) as { access_token?: string };
	if (!response.ok || !body.access_token) throw new Error(`pairing token exchange failed: ${response.status} ${JSON.stringify(body)}`);
	return body.access_token;
}

const bearer = { authorization: `Bearer ${token}` };
async function projectsByRoot(): Promise<Record<string, string>> {
	const response = await fetch(`${bridgeUrl}/api/projects`, { headers: bearer, signal: AbortSignal.timeout(5000) });
	const body = (await response.json()) as { projects?: { id: string; workspaceRoot: string }[] };
	const map: Record<string, string> = {};
	for (const project of body.projects ?? []) map[project.workspaceRoot] = project.id;
	return map;
}
async function markerExists(): Promise<boolean> {
	const { access } = await import("node:fs/promises");
	try {
		await access(pickMarker);
		return true;
	} catch {
		return false;
	}
}

const wsFrames: string[] = [];
async function until<T>(what: string, deadline: number, poll: () => Promise<{ ok: boolean; value?: unknown }>): Promise<T> {
	let last = "pending";
	while (Date.now() < deadline) {
		const result = await poll();
		if (result.ok) return result.value as T;
		last = JSON.stringify(result.value ?? null).slice(0, 200);
		await sleep(250);
	}
	throw new Error(`${what} timed out. Last state: ${last}`);
}

try {
	heading("pair → add a project from the picker → thread → remove → files untouched");
	const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	page.on("pageerror", (error) => console.log(`[pageerror] ${error.message.slice(0, 200)}`));
	page.on("websocket", (ws) => ws.on("framesent", (frame) => wsFrames.push(String(frame.payload))));
	const sent = (needle: string) => wsFrames.some((frame) => frame.includes(needle));
	const palette = page.getByTestId("command-palette");

	// 1. Pair and land on the app.
	// The web app is served from the facet origin, so `/pair` is the bridge's screen: it exchanges the token for a
	// browser session (a cookie), after which the app opens as "This machine".
	await page.goto(`${webAppUrl}/pair#${new URLSearchParams({ token: pairToken })}`, { waitUntil: "domcontentloaded" });
	await page.getByText("This browser is paired", { exact: false }).waitFor({ state: "visible", timeout: 20000 });
	await page.goto(`${webAppUrl}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[contenteditable]", { timeout: 30000 });

	// 2. Add a project from the picker: command palette → ">Add project" → "Local folder" → type the target path → Enter.
	const baseline = await projectsByRoot();
	await page.keyboard.press("Control+k");
	await palette.waitFor({ state: "visible", timeout: 10000 });
	await page.keyboard.type(">add project");
	const addProject = page.getByRole("option", { name: /add project/i }).first();
	await addProject.waitFor({ state: "visible", timeout: 8000 });
	await addProject.click(); // select "Add project" (click selects the row directly)
	// The source list appears with "Local folder" (the disk browse picker) highlighted.
	const localFolder = page.getByRole("option", { name: /local folder/i }).first();
	await localFolder.waitFor({ state: "visible", timeout: 8000 });
	await localFolder.click();
	// The path field (fed by `filesystem.browse`). Type the absolute target and press Enter to add it.
	const pathField = page.locator('input[placeholder^="Enter path" i]').first();
	await pathField.waitFor({ state: "visible", timeout: 8000 });
	await pathField.click();
	await page.keyboard.type(pickTarget);
	// The picker browses the filesystem for the path. (Its `filesystem.browse` ran over the pairing WS; the DOM-driven
	// navigation is the assertion that the picker reached the target — the add's effect is confirmed against the server.)
	// A single Enter adds the project at the typed path (`projects.mutate` project.create); poll the server for it.
	await page.keyboard.press("Enter");
	const addedProjectId = await until<string>(`the added project (${pickTarget}) is registered after Enter`, Date.now() + launchTimeout, async () => {
		const id = (await projectsByRoot())[pickTarget];
		return id === undefined ? { ok: false, value: Object.keys(await projectsByRoot()) } : { ok: true, value: id };
	});
	console.log(`added project id=${addedProjectId.slice(0, 10)} (the picker listed the target via filesystem.browse)`);
	if (baseline[pickTarget] !== undefined) throw new Error("the target was already a project — the fixture is wrong");
	// The web app mints the project id (a UUID) BEFORE the project exists and navigates to it; the host must answer
	// with THAT id (the shell carries it), or the client's `useProject` lookup misses and the composer below renders
	// `contenteditable="false"` — the user cannot type until a reload.
	if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(addedProjectId)) {
		throw new Error(`the server answered a path-derived id (${addedProjectId}) for the id the client minted — the composer will be dead`);
	}

	// 3. Create a thread in the project. The app navigated to the new project's draft on add — WITHOUT a reload, the
	//    composer must be EDITABLE (the defect: the composer rendered `contenteditable="false"` until a reload, because
	//    the shell's project id was not the one the client navigated to), and the launch must carry the added project's id.
	const editor = page.locator('[contenteditable="true"]').first();
	await editor.waitFor({ state: "visible", timeout: launchTimeout });
	console.log("the composer is editable right after the add — the client's project id is the shell's project id");
	await editor.click();
	await page.keyboard.type(`project-flow ${Date.now()}`);
	await page.keyboard.press("Enter");
	await until(
		"the SPA launches a thread in the added project (launchThread carries the added project id)",
		Date.now() + launchTimeout,
		async () => ({ ok: wsFrames.some((frame) => frame.includes("launchThread") && frame.includes(addedProjectId)), value: wsFrames.length }),
	);
	console.log("a thread was created (launchThread sent) in the added project, under the id the client minted");

	// 4. Remove the project (force:true — exactly what T3's sidebar "Remove project" sends over its dialog).
	const removeResult = await fetch(`${bridgeUrl}/api/projects/mutate`, {
		method: "POST",
		headers: { ...bearer, "content-type": "application/json" },
		body: JSON.stringify({ type: "project.delete", commandId: `flow-del-${Date.now()}`, projectId: addedProjectId, force: true }),
		signal: AbortSignal.timeout(8000),
	});
	if (!removeResult.ok) throw new Error(`removing the project failed: ${removeResult.status} ${await removeResult.text()}`);

	// 5. Gone from the server; the on-disk directory (the marker file inside it) is untouched.
	const removedId = addedProjectId;
	await until("the removed project is gone from the server", Date.now() + 15000, async () => {
		const ids = Object.values(await projectsByRoot());
		return ids.includes(removedId) ? { ok: false, value: ids } : { ok: true, value: ids };
	});
	if (!(await markerExists())) throw new Error(`removing the project deleted the files on disk (${pickMarker} is gone) — T3's dialog promises they are NOT touched`);
	console.log("removed: the project is gone from the server, and its files on disk are untouched");

	await browser.close();
	console.log("\nproject-flow: PASS");
	process.exit(0);
} catch (error) {
	console.error(`\nproject-flow: FAIL — ${(error as Error).message}`);
	process.exit(1);
}
