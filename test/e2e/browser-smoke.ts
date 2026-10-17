// One end-to-end browser smoke over the real T3 web app: pair → send a message → see the model reply → undo.
// Drives the facet's real pairing, the web SPA's launchThread/prompt, and a "revert and keep" undo. It asserts on the
// server projection (GET /api/orchestration/threads/:id) and the DOM.
// Run via dev/browser-smoke.sh, which sets T3_WEB (web app), BRIDGE (facet), PAIR (fixed pairing token).

import { chromium } from "playwright-core";

const webAppUrl = required("T3_WEB").replace(/\/$/, "");
const bridgeUrl = required("BRIDGE").replace(/\/$/, "");
const pairToken = required("PAIR");
const launchTimeout = Number(process.env["E2E_LAUNCH_TIMEOUT_MS"] ?? 60000);
const chrome = process.env["CHROMIUM"] ?? "/usr/bin/chromium";
const heading = (message: string) => console.log(`\n=== ${message} ===`);

type Projection = {
	runs: Array<{ id?: string; status?: string }>;
	turnItems: Array<{ runId?: string | null; type: string; text?: string }>;
	liveRunCount: number;
	thread?: { modelSelection?: { model?: string; options?: { id: string; value: string }[] } };
};

const token = await bridgeToken();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

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

async function projection(threadId: string): Promise<Projection> {
	const response = await fetch(`${bridgeUrl}/api/orchestration/threads/${threadId}`, {
		headers: { authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
	});
	if (!response.ok) throw new Error(`projection fetch failed: ${response.status}`);
	const body = (await response.json()) as { projection?: Projection } & Projection;
	return (body.projection ?? body) as Projection;
}
async function until<T>(
	what: string,
	deadline: number,
	poll: () => Promise<{ ok: boolean; value?: unknown }>,
): Promise<T> {
	let last = "pending";
	while (Date.now() < deadline) {
		const result = await poll();
		if (result.ok) return result.value as T;
		last = JSON.stringify(result.value ?? null).slice(0, 300);
		await sleep(250);
	}
	throw new Error(`${what} timed out. Last state: ${last}`);
}
// The thread's visible transcript text: top-level turn items, minus any owned by a rolled-back (reverted) run.
const messageTexts = (p: Projection): string[] => {
	const rolledBack = new Set(p.runs.filter((run) => run.status === "rolled_back").map((run) => run.id));
	return p.turnItems
		.filter(
			(item) =>
				(item.runId === null || item.runId === undefined || !rolledBack.has(item.runId)) &&
				(item.type === "user_message" || item.type === "assistant_message"),
		)
		.map((item) => item.text ?? "");
};

try {
	heading("smoke: pair → prompt → reply → undo");
	const browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
	const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
	const wsFrames: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") console.log(`[browser.error] ${message.text().slice(0, 200)}`);
	});
	page.on("pageerror", (error) => console.log(`[pageerror] ${error.message.slice(0, 200)}`));
	page.on("websocket", (ws) => {
		// Outgoing requests (launchThread, etc.) arrive on `framesent`; `message` is only inbound traffic.
		ws.on("framesent", (frame) => wsFrames.push(String(frame.payload)));
	});

	// 1. Pair.
	const url = `${webAppUrl}/pair?host=${encodeURIComponent(bridgeUrl)}&label=pi-smoke#${new URLSearchParams({ token: pairToken })}`;
	await page.goto(url, { waitUntil: "domcontentloaded" });
	await page.waitForURL((target) => !target.pathname.startsWith("/pair"), { timeout: 20000 });
	await sleep(4000);
	await page.goto(`${webAppUrl}/`, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[contenteditable]", { timeout: 30000 });

	// The offline model's fixed reply text; both turns reply with it, so count occurrences.
	const replyMarker = "offline reply model";
	const editor = page.locator('[contenteditable="true"]').first();
	const send = async (text: string): Promise<void> => {
		await editor.click();
		await page.keyboard.press("Control+A");
		await page.keyboard.press("Backspace");
		await page.keyboard.type(text);
		await page.keyboard.press("Enter");
	};
	const replyCount = async (): Promise<number> => (await page.getByText(replyMarker, { exact: false }).all()).length;
	let threadId: string | undefined;
	const runStatuses = async (): Promise<string[]> => {
		const p = await projection(threadId as string).catch(() => undefined);
		return p && Array.isArray(p.runs) ? p.runs.map((r) => r.status ?? "") : [];
	};

	// 2. Send the first message (the SPA launches a thread and prompts it in one step).
	const first = `smoke first ${Date.now()}`;
	await send(first);
	const launch = await until<string>("orchestration.launchThread", Date.now() + launchTimeout, async () => {
		const frame = wsFrames.find((f) => f.includes('"orchestration.launchThread"') && f.includes(first));
		return frame ? { ok: true, value: frame } : { ok: false, value: wsFrames.length };
	});
	const launched = JSON.parse(launch) as { payload?: { threadId?: string }; params?: { threadId?: string } };
	threadId = launched.payload?.threadId ?? launched.params?.threadId;
	if (!threadId) throw new Error("launchThread carried no threadId");
	await until<string[]>("first run completed (projection)", Date.now() + launchTimeout, async () => {
		const statuses = await runStatuses();
		return statuses[0] === "completed" ? { ok: true, value: statuses } : { ok: false, value: statuses };
	});
	await page.getByText(first).first().waitFor({ state: "visible", timeout: 15000 });
	await page.getByText(replyMarker, { exact: false }).first().waitFor({ state: "visible", timeout: launchTimeout });
	console.log(`replied: thread=${threadId.slice(0, 8)} reply1 visible`);

	// 3. A second turn, so there is a middle checkpoint to undo back to.
	const second = `smoke second ${Date.now()}`;
	await send(second);
	await until<string[]>("second run completed (projection)", Date.now() + launchTimeout, async () => {
		const statuses = await runStatuses();
		return statuses.length >= 2 && statuses[0] === "completed" && statuses[1] === "completed" ? { ok: true, value: statuses } : { ok: false, value: statuses };
	});
	await page.getByText(second).first().waitFor({ state: "visible", timeout: 15000 });
	await until<number>("two replies visible", Date.now() + launchTimeout, async () => {
		const count = await replyCount();
		return count >= 2 ? { ok: true, value: count } : { ok: false, value: count };
	});
	console.log("two replies visible (thread has two turns)");

	// 4. Undo the SECOND turn ("revert and keep changes") back to the middle checkpoint: run 1 stays complete, and run 2
	//    disappears ENTIRELY — its reply and its user message both go (a fork is inclusive, so the host forks at the
	//    entry just before run 2's user turn). This is the operator's mapping (undo to cp1 → revert run 2's turn).
	await page.getByText(second).first().hover();
	await page.getByRole("button", { name: "Edit from here" }).last().click({ force: true });
	await page.getByText("Revert and keep changes").click();
	await until<number>("undo dropped the second reply", Date.now() + launchTimeout, async () => {
		const count = await replyCount();
		return count <= 1 ? { ok: true, value: count } : { ok: false, value: count };
	});
	// Run 1 is untouched; run 2 is GONE from the thread's visible transcript — its reply AND its user message. (The SPA
	// re-fills the composer with the reverted text as part of "Edit from here", so assert on the server projection, not
	// the DOM, which would also match the composer.) The reverted turn is no longer in the new head.
	await page.getByText(first).first().waitFor({ state: "visible", timeout: 15000 });
	await page.getByText(replyMarker, { exact: false }).first().waitFor({ state: "visible", timeout: 15000 });
	await until<string[]>("run 2's message and reply removed from the visible transcript", Date.now() + launchTimeout, async () => {
		const p = await projection(threadId as string).catch(() => undefined);
		if (p === undefined) return { ok: false, value: "no projection" };
		const texts = messageTexts(p);
		const gone = !texts.some((t) => t.includes(second));
		const kept = texts.some((t) => t.includes(first)) && texts.some((t) => t.includes(replyMarker));
		return gone && kept ? { ok: true, value: texts } : { ok: false, value: texts };
	});
	console.log("undone: run 1's message and reply kept; run 2's message and reply both gone from the thread");

	// 5. The thinking control. T3 renders it from the capabilities the host declares (pi's ladder, for the levels the
	//    model supports), and a level picked on the composer rides the next message to the conversation — which the
	//    projection then reports back. No control, no pass-through: this step fails the smoke.
	const traits = page.getByRole("button", { name: "Off", exact: true }).first();
	await traits.waitFor({ state: "visible", timeout: 15000 });
	await traits.click();
	await page.getByRole("menuitemradio", { name: "High", exact: true }).click();
	const thinking = `smoke thinking ${Date.now()}`;
	await send(thinking);
	await until<unknown>("the chosen thinking level reached the conversation", Date.now() + launchTimeout, async () => {
		const p = await projection(threadId as string).catch(() => undefined);
		const options = p?.thread?.modelSelection?.options ?? [];
		const level = options.find((option) => option.id === "thinking")?.value;
		return level === "high" ? { ok: true, value: options } : { ok: false, value: { options, runs: p?.runs.map((run) => run.status) } };
	});
	console.log("thinking: the composer's High reached the conversation (projection reports thinking=high)");

	await browser.close();
	console.log("\nsmoke: PASS");
	process.exit(0);
} catch (error) {
	console.error(`\nsmoke: FAIL — ${(error as Error).message}`);
	process.exit(1);
}
