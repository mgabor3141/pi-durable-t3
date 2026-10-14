// The browser case `threads.json` used to protect: a message T3 is still holding must appear EXACTLY ONCE after the
// host dies mid-turn and restarts. The client's id for a user message now rides in the durable entry (`app.user`'s
// data), so after a restart — where the old side store is gone — the projection hands back the SAME id the client
// chose, its optimistic row is reconciled (same key), and it stays one copy. A cold `m<entryId>` fallback would not
// match the client's row, and the message would show twice.
//
// The browser page stays open across the kill/restart, because a FRESH client never held the optimistic message and so
// proves nothing. The host process is owned by dev/browser-smoke.sh, which does the kill and the restart: this script
// and the shell hand off through files (SENT_FILE → the shell kills + restarts → RESTARTED_FILE → this script checks).
//
// Run via dev/browser-smoke.sh, which sets T3_WEB (web app), BRIDGE (facet), PAIR (fixed pairing token), plus:
//   CRASH_TEXT  the unique message text to send
//   CRASH_FILE  where to write the captured threadId + client messageId (tab-separated)
//   SENT_FILE   written once the message is on screen and the run is live (the shell kills on seeing it)
//   RESTARTED_FILE  appears once the shell has restarted the host; this script then checks and exits.

import { chromium } from "playwright-core";

const webAppUrl = required("T3_WEB").replace(/\/$/, "");
const bridgeUrl = required("BRIDGE").replace(/\/$/, "");
const pairToken = required("PAIR");
const crashText = required("CRASH_TEXT");
const crashFile = required("CRASH_FILE");
const sentFile = required("SENT_FILE");
const restartedFile = required("RESTARTED_FILE");
const launchTimeout = Number(process.env["E2E_LAUNCH_TIMEOUT_MS"] ?? 60000);
const chrome = process.env["CHROMIUM"] ?? "/usr/bin/chromium";
const heading = (message: string) => console.log(`\n=== crash-smoke: ${message} ===`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
async function writeMarker(path: string, body = ""): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, body);
}
async function pathExists(path: string): Promise<boolean> {
	const { access } = await import("node:fs/promises");
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

type Projection = {
	runs: Array<{ id?: string; status?: string; userMessageId?: string }>;
	turnItems: Array<{ runId?: string | null; type: string; text?: string; messageId?: string }>;
};

const token = await bridgeToken();
async function bridgeToken(): Promise<string> {
	const response = await fetch(`${bridgeUrl}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: pairToken,
			subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		}).toString(),
	});
	const body = (await response.json().catch(() => ({}))) as { access_token?: string };
	if (!response.ok || !body.access_token) throw new Error(`pairing token exchange failed: ${response.status} ${JSON.stringify(body)}`);
	return body.access_token;
}
async function projection(threadId: string): Promise<Projection | undefined> {
	const response = await fetch(`${bridgeUrl}/api/orchestration/threads/${threadId}`, {
		headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
	});
	if (!response.ok) return undefined; // mid-restart the facet is briefly unavailable; the poll retries
	const body = (await response.json()) as { projection?: Projection } & Projection;
	return (body.projection ?? body) as Projection;
}
// Count user turns in the thread's visible transcript whose text is the crash message (excluding any rolled-back run).
const userCopies = (p: Projection): { count: number; messageId?: string } => {
	const rolledBack = new Set(p.runs.filter((run) => run.status === "rolled_back").map((run) => run.id));
	const items = p.turnItems.filter(
		(item) => (item.runId === null || item.runId === undefined || !rolledBack.has(item.runId)) && item.type === "user_message" && (item.text ?? "").includes(crashText),
	);
	return { count: items.length, messageId: items[0]?.messageId };
};

try {
	heading("pair → send → (shell kills the host mid-turn) → restart → exactly one copy");
	const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	const wsFrames: string[] = [];
	page.on("pageerror", (error) => console.log(`[pageerror] ${error.message.slice(0, 200)}`));
	page.on("websocket", (ws) => ws.on("framesent", (frame) => wsFrames.push(String(frame.payload))));

	// 1. Pair.
	const url = `${webAppUrl}/pair?host=${encodeURIComponent(bridgeUrl)}&label=pi-crash#${new URLSearchParams({ token: pairToken })}`;
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForURL((target) => !target.pathname.startsWith("/pair"), { timeout: 20000 });
	await sleep(4000);
	await page.goto(`${webAppUrl}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[contenteditable]", { timeout: 30000 });

	const editor = page.locator('[contenteditable="true"]').first();
	await editor.click();
	await page.keyboard.press("Control+A");
	await page.keyboard.press("Backspace");
	await page.keyboard.type(crashText);
	await page.keyboard.press("Enter");

	// 2. Capture the thread and the client's message id from the launchThread frame (this id is what must survive).
	let threadId: string | undefined;
	let clientMessageId: string | undefined;
	const launchDeadline = Date.now() + launchTimeout;
	while (Date.now() < launchDeadline) {
		const frame = wsFrames.find((f) => f.includes('"orchestration.launchThread"') && f.includes(crashText));
		if (frame !== undefined) {
			const launched = JSON.parse(frame) as { payload?: { threadId?: string; initialMessage?: { messageId?: string } }; params?: { threadId?: string; initialMessage?: { messageId?: string } } };
			threadId = launched.payload?.threadId ?? launched.params?.threadId;
			clientMessageId = launched.payload?.initialMessage?.messageId ?? launched.params?.initialMessage?.messageId;
			if (threadId !== undefined) break;
		}
		await sleep(250);
	}
	if (threadId === undefined) throw new Error("launchThread never arrived with the crash message");
	if (clientMessageId === undefined) throw new Error("launchThread carried no client messageId");
	console.log(`sent: thread=${threadId.slice(0, 8)} messageId=${clientMessageId}`);
	await writeMarker(crashFile, `${threadId}\t${clientMessageId}`);

	// 3. Wait until the message has durably landed as a single user turn. The offline reply model settles the run almost
	//    instantly, so the durable placement (not a live run) is the mid-turn boundary we kill at — the entry is committed,
	//    the turn is running/done, and the client is still holding its optimistic row. Then signal the shell to kill.
	const liveDeadline = Date.now() + launchTimeout;
	for (;;) {
		const p = await projection(threadId);
		const copies = p === undefined ? { count: 0 } : userCopies(p);
		if (copies.count === 1) break;
		if (Date.now() > liveDeadline) throw new Error(`the crash message never landed as a single user turn: ${JSON.stringify(p?.runs ?? null)}`);
		await sleep(250);
	}
	await writeMarker(sentFile, "sent");
	console.log("message is durably placed (one user turn); the shell will now kill the host");

	// 4. Hand off: the shell kills the host, then restarts it. The page stays open — T3 reconnects on its own.
	const restartDeadline = Date.now() + 120_000;
	while (!(await pathExists(restartedFile))) {
		if (Date.now() > restartDeadline) throw new Error("the host was never restarted by the shell");
		await sleep(250);
	}
	console.log("host restarted; waiting for the client to reconcile its held message");

	// 5. The proof, from the SAME client: the server projection shows the message exactly once, under the client's own
	//    id (the id rode in the entry — not the `m<entryId>` fallback a lost store would force), and the DOM shows one copy.
	const checkDeadline = Date.now() + launchTimeout;
	for (;;) {
		const p = await projection(threadId);
		const copies = p === undefined ? { count: 0, messageId: undefined } : userCopies(p);
		if (copies.count === 1 && copies.messageId === clientMessageId && !/^m\d+$/.test(copies.messageId)) {
			const domCopies = (await page.getByText(crashText, { exact: false }).all()).length;
			if (domCopies === 1) {
				console.log(`single copy after restart (projection userMessageId=${copies.messageId}, dom=${domCopies})`);
				break;
			}
		}
		if (Date.now() > checkDeadline) {
			const p = await projection(threadId);
			throw new Error(`the held message is not exactly one copy under the client id after restart: projection=${JSON.stringify(userCopies(p ?? { runs: [], turnItems: [] }))} dom=${(await page.getByText(crashText, { exact: false }).all()).length}`);
		}
		await sleep(250);
	}

	await browser.close();
	console.log("\ncrash-smoke: PASS");
	process.exit(0);
} catch (error) {
	console.error(`\ncrash-smoke: FAIL — ${(error as Error).message}`);
	process.exit(1);
}
