// `/tree`: a thread's lines as a tree of turns, and moving in it (`thread-navigator.ts`). The lines an undo left
// share the turns before they part; "Go here" makes any turn of any line the thread's last, "Fork" opens it as a new
// thread, and a long thread is shown a window at a time. A page cannot read an answer, so every action shows it again.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { describe, expect, it, onTestFinished } from "vitest";
import { Attachments, createDeterministicAttachmentId } from "../src/t3/attachments.ts";
import { AuthStore } from "../src/t3/auth.ts";
import { Bridge } from "../src/t3/bridge.ts";
import { type LineEntry, type Lines, THREAD_NAV_PATH, treePage, turnTree, type TurnNode } from "../src/t3/thread-navigator.ts";
import { bridgeConfig, conversation, createNamed, idle, makeThreads, quietLog } from "./threads-harness.ts";

/** The tree as nested lists: `*` on the line the thread is on, `!` where it is, `+n` where n other threads are. */
const outline = (nodes: readonly TurnNode[]): unknown[] => nodes.map((node) => [`${node.text}${node.current ? "*" : ""}${node.here ? "!" : ""}${node.threads.length === 0 ? "" : `+${node.threads.length}`}`, ...outline(node.children)]);

describe("the tree of turns", () => {
	/** Lines from a sketch: `u` starts a turn, `a` is a response, `x` is bookkeeping (a fork's own entry); `[id, kind, prev]`. */
	const lines = (head: number, tips: Record<number, number>, sketch: readonly (readonly [number, "u" | "a" | "x", number?])[]): Lines => ({
		head,
		tips: new Map(Object.entries(tips).map(([conversation, tip]) => [Number(conversation), tip])),
		entries: new Map(sketch.map(([id, kind, prev]): [number, LineEntry] => [id, { id, prev, start: kind === "u", work: kind === "a", text: kind === "x" ? "" : `${kind}${id}`, at: id, compaction: false }])),
	});

	it("a turn cut at two places is two turns; a fork's own entries make no second one", () => {
		// Line 1: u1 a2 a3, u4 a5. Line 2 (the head) was cut after a2 and went on differently: u1 a2 a6. Line 3 forked
		// after a5 and wrote only an entry of its own.
		const tree = turnTree(
			lines(2, { 2: 6, 1: 5, 3: 7 }, [
				[1, "u"],
				[2, "a", 1],
				[3, "a", 2],
				[4, "u", 3],
				[5, "a", 4],
				[6, "a", 2],
				[7, "x", 5],
			]),
		);
		expect(outline(tree.roots)).toEqual([["u1", ["u4"]], ["u1*!"]]);
		expect(tree.roots.map((node) => [node.answer, node.end])).toEqual([
			["a3", { conversation: 1, entryId: 3 }],
			["a6", { conversation: 2, entryId: 6 }],
		]);
		expect(tree.lines).toBe(2);
	});

	it("names the other threads where they are", () => {
		// The thread (line 1): u1 a2. A fork of it (line 2) went on: u3 a4. Another (line 3) forked and wrote nothing.
		const family: Lines = {
			...lines(1, { 1: 2, 2: 4, 3: 2 }, [
				[1, "u"],
				[2, "a", 1],
				[3, "u", 2],
				[4, "a", 3],
			]),
			others: new Map([
				[2, { threadId: "b", title: "B" }],
				[3, { threadId: "c", title: "C" }],
			]),
		};
		const tree = turnTree(family);
		expect(outline(tree.roots)).toEqual([["u1*!+1", ["u3+1"]]]);
		expect([tree.nodes.size, tree.lines, tree.threads]).toEqual([2, 1, 3]);
		expect(treePage(tree, { earlier: 0, later: 0, more: new Map() }, "t").html).toMatch(/class="thread"[^>]*>C<.*class="thread"[^>]*>B</s);
	});

	it("leaves nothing a line has out: work before the first message is a turn, and a line that shares no turn is shown first", () => {
		// The thread (line 1) was begun by an agent's work (a1 a2) before the user's first message u3. Line 2 is one it
		// left that starts on its own: u10 a11.
		const tree = turnTree(
			lines(1, { 1: 4, 2: 11 }, [
				[1, "a"],
				[2, "a", 1],
				[3, "u", 2],
				[4, "a", 3],
				[10, "u"],
				[11, "a", 10],
			]),
		);
		expect(tree.roots.map((root) => [root.text, root.answer, root.end.entryId, root.current, root.children.map((child) => child.text)])).toEqual([
			["", "a2", 2, true, ["u3"]],
			["u10", "a11", 11, false, []],
		]);
		// However far down the thread is, the other line is on the page.
		const sketch: [number, "u" | "a", number?][] = [[100, "u"], [101, "a", 100]];
		for (let turn = 0; turn < 30; turn++) sketch.push([turn * 2 + 1, "u", turn === 0 ? undefined : turn * 2], [turn * 2 + 2, "a", turn * 2 + 1]);
		const html = treePage(turnTree(lines(1, { 1: 60, 2: 101 }, sketch)), { earlier: 0, later: 0, more: new Map() }, "t").html;
		expect(html.indexOf(">u100<")).toBeGreaterThan(0);
		expect(html.indexOf(">u100<")).toBeLessThan(html.indexOf('data-action="earlier"'));
	});

	it("shows a window around where the thread is, and the first turns of a line that parts", () => {
		// Forty turns in a row; the thread was taken back to the twentieth, and a line of ten parts after the fifth.
		const sketch: [number, "u" | "a", number?][] = [];
		for (let turn = 0; turn < 40; turn++) sketch.push([turn * 2 + 1, "u", turn === 0 ? undefined : turn * 2], [turn * 2 + 2, "a", turn * 2 + 1]);
		for (let turn = 0; turn < 10; turn++) sketch.push([101 + turn * 2, "u", turn === 0 ? 10 : 100 + turn * 2], [102 + turn * 2, "a", 101 + turn * 2]);
		const tree = turnTree(lines(2, { 2: 40, 1: 80, 3: 120 }, sketch));
		const texts = (html: string) => [...html.matchAll(/class="text">([^<]*)|data-action="(?:earlier|later|more)"[^>]*>([^<]*)/g)].map((match) => match[1] ?? match[2]);
		const window = { earlier: 0, later: 0, more: new Map<string, number>() };
		const first = treePage(tree, window, "t");
		expect(texts(first.html)).toEqual(["Show 13 earlier turns", ...[27, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49, 51].map((id) => `u${id}`), "Show 14 later turns"]);
		expect(first.rows).toBe(15);
		// Earlier turns bring the line that parts after the fifth: three of its turns, and a button for the rest.
		window.earlier = 25;
		const all = texts(treePage(tree, window, "t").html);
		expect(all.slice(0, 10)).toEqual(["u1", "u3", "u5", "u7", "u9", "u101", "u103", "u105", "Show 7 more turns", "u11"]);
		window.more.set("101:102", 25);
		expect(texts(treePage(tree, window, "t").html).slice(5, 16)).toEqual([...[101, 103, 105, 107, 109, 111, 113, 115, 117, 119].map((id) => `u${id}`), "u11"]);
	});
});

it("shows every line; go moves the thread to any turn of any line, fork opens it as a thread, and the page is shown again", { timeout: 60_000 }, async () => {
	const f = await makeThreads({ projects: [{ id: "p" }] });
	await createNamed(f.threads, f.harness, f.model)({ threadId: "t", projectId: "p" });
	const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-nav-"));
	onTestFinished(() => rm(scratch, { recursive: true, force: true }));
	const env = new NodeExecutionEnv({ cwd: "/" });
	const home = join(scratch, "attachments");
	const attachments = new Attachments({ stateDir: join(scratch, "state"), signer: new AuthStore(join(scratch, "state"), { tokenTtlSeconds: 60 }), env, dir: home, context: BACKGROUND_CONTEXT });
	const bridge = new Bridge(bridgeConfig({ stateDir: scratch, registry: f.registry, env }), quietLog, f.threads, f.model.models, attachments);
	bridge.start();
	onTestFinished(() => bridge.close());
	await bridge.loaded();
	let sent = 0;
	const head = async () => (await f.threads.thread("t"))!.head;
	const say = async (text: string) => {
		f.model.respond(fauxAssistantMessage(`answer to ${text}`));
		await bridge.sendMessage({ threadId: "t", commandId: `c${++sent}`, messageId: `m${sent}`, text, mode: "start" });
		if (!text.startsWith("/")) await idle(f.harness, await head());
		return `m${sent}`;
	};
	const context = async (conversationId: number) =>
		(await (await conversation(f.harness, conversationId)).context(BACKGROUND_CONTEXT)).messages.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : ""));
	const tree = async () => outline((await bridge.navigator.tree("t")).roots);
	/** The page the command shows, the `n`th time it is shown. */
	const page = (messageId: string, n: number) => readFile(join(home, `${createDeterministicAttachmentId("t", `thread-nav:${messageId}:${n}`, "html")}.html`), "utf8");
	const keyOf = (html: string, text: string) => new RegExp(`class="text">${text}<.*?data-node="([\\d:]+)"`, "s").exec(html)![1]!;

	// Nothing to show before the first turn.
	await say("/tree");
	expect(await readdir(home).catch(() => [])).toEqual([]);

	await say("apples");
	await say("pears");
	await say("plums");
	await say("/undo");
	await say("/undo");
	await say("cherries");
	// Two lines that share "apples": the one the thread is on, and the one the undos left.
	expect(await tree()).toEqual([["apples*", ["pears", ["plums"]], ["cherries*!"]]]);

	const command = await say("/tree");
	const first = await page(command, 1);
	const token = /token: "([\w-]+)"/.exec(first)![1]!;
	expect(first).toContain("you are here");
	const act = (action: string, node?: string) => bridge.navigator.act({ token, action, ...(node === undefined ? {} : { node }) });

	// A token that is not a page's is refused; so are a turn the page does not have and an action there is not.
	expect(await bridge.navigator.act({ token: "nope", action: "go", node: keyOf(first, "pears") })).toBe(410);
	expect(await act("go", "1:1")).toBe(404);
	expect(await act("dance")).toBe(400);

	// Fork "pears" of the line that was left: a new thread, this one stays, and the page says so.
	const before = await head();
	expect(await act("fork", keyOf(first, "pears"))).toBe(200);
	const fork = (await f.threads.list()).find((thread) => thread.threadId !== "t")!;
	expect(await context(fork.head)).toEqual(["apples", "pears"]);
	expect(await head()).toBe(before);
	const forked = await page(command, 2);
	expect(forked).toContain("Opened &quot;pears&quot; as a new thread");
	// The page shown again names the new thread on the turn it is at.
	expect(forked).toMatch(/class="text">pears<.*?class="thread"[^>]*>[^<]*\(from pears\)</s);

	// Go to "plums" on the line that was left: the thread is there, and what it left is still one of its lines.
	expect(await act("go", keyOf(first, "plums"))).toBe(200);
	expect(await context(await head())).toEqual(["apples", "pears", "plums"]);
	expect(await tree()).toEqual([["apples*", ["pears*+1", ["plums*!"]], ["cherries"]]]);
	const moved = await page(command, 3);
	expect(moved).toContain("Moved this thread to &quot;plums&quot;. /redo goes back");
	// The page before the last is removed: only the last two are kept.
	expect((await readdir(home)).length).toBe(2);

	// A move is taken back as an undo is.
	await say("/redo");
	expect(await context(await head())).toEqual(["apples", "cherries"]);
	// The page was made before that: it says so, shows the thread as it stands, and moves nothing.
	expect(await act("go", keyOf(moved, "pears"))).toBe(409);
	expect(await context(await head())).toEqual(["apples", "cherries"]);
	const stale = await page(command, 4);
	expect(stale).toContain("The thread had changed since this view was made");
	// From the page as it is now, the move works, and the thread goes on from there.
	expect(await act("go", keyOf(stale, "pears"))).toBe(200);
	await say("quinces");
	expect(await context(await head())).toEqual(["apples", "pears", "quinces"]);
	expect(await tree()).toEqual([["apples*", ["pears*+1", ["plums"], ["quinces*!"]], ["cherries"]]]);
	// The fork is a thread of the same tree: from it, this thread is the one named.
	expect(outline((await bridge.navigator.tree(fork.threadId)).roots)).toEqual([["apples*", ["pears*!", ["plums"], ["quinces+1"]], ["cherries"]]]);

	// A line no record names is found by the conversations' own fork links: with the thread's undos forgotten, the
	// lines they left are still in its tree.
	await f.threads.updateRecord("t", (record) => void (record.undos = []));
	expect(await tree()).toEqual([["apples*", ["pears*+1", ["plums"], ["quinces*!"]], ["cherries"]]]);
	// Whatever shares history with the thread is in its tree, however it came to be: what a thread that was deleted
	// wrote is still a line, with no thread to name on it. A thread that began on its own is not.
	f.model.respond(fauxAssistantMessage("answer to figs"));
	await f.threads.submit({ threadId: fork.threadId, conversationId: fork.head, requestId: "figs", message: "figs" }, undefined);
	await idle(f.harness, fork.head);
	expect(await tree()).toEqual([["apples*", ["pears*", ["plums"], ["quinces*!"], ["figs+1"]], ["cherries"]]]);
	await f.threads.remove(fork.threadId);
	await createNamed(f.threads, f.harness, f.model)({ threadId: "beside", projectId: "p" });
	expect(await tree()).toEqual([["apples*", ["pears*", ["plums"], ["quinces*!"], ["figs"]], ["cherries"]]]);

	// What a page's button posts: the token in the body is all a caller needs, and all that is checked.
	const post = (body: string) => bridge.navigator.handle(new Request(`http://host${THREAD_NAV_PATH}`, { method: "POST", headers: { "content-type": "text/plain" }, body }));
	expect((await post(JSON.stringify({ token, action: "earlier" }))).status).toBe(200);
	expect((await post(JSON.stringify({ token: "nope", action: "earlier" }))).status).toBe(410);
	expect((await post("not json")).status).toBe(400);
});
