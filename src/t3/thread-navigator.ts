// `/tree`: every line a thread has had, as a tree of turns, with a way to go to any of them.
//
// A thread's head is one conversation. An undo moves the head to a fork that ends earlier and leaves the old
// conversation whole, and a thread forked from another starts as a fork of its conversation: so a thread that was
// undone, written on again and forked is a tree, whose lines share their entries up to where they part. `readLines`
// reads every conversation that shares history with the thread (`Threads.linesOf`), each only down to the first entry
// another has too, and `turnTree` makes the tree of their turns, with the other threads named where they are.
//
// The command shows the tree as a page in T3's inline HTML frame, shown as a command's answer is: kept nowhere, not
// sent to the model. The frame has an opaque origin and no session, so its buttons cannot use the API the app uses.
// They post to `THREAD_NAV_PATH` with a token made for the page, and since the host's CORS answers its own origins
// only, the page cannot read what comes back: every action answers by showing the page again in the page's place,
// with what happened said in it. So the page is only ever a view of what the host holds for its token (`View`): which
// rows are open is the host's state too, and a long thread is sent a window at a time.
import { randomBytes, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { HostError, messageOf } from "../host-errors.ts";
import type { Threads } from "../threads.ts";
import { type Attachments, createDeterministicAttachmentId } from "./attachments.ts";
import { type HtmlRenderReference, preparePublish } from "./html-render.ts";
import type { Logger } from "./logging.ts";
import type { EntryRecord } from "./model-types.ts";
import type { ShownExchange } from "./projection.ts";
import { firstMessage, isCompactCommandEntry, isUserEntry } from "./runs.ts";
import { textOf } from "./thread-search.ts";

export const THREAD_NAV_PATH = "/api/thread-nav" as const;
/** How long a page's buttons work after it was last used. */
const VIEW_TTL_MS = 30 * 60_000;
/** Pages whose buttons work, at most: the oldest go. */
const MAX_VIEWS = 50;
/** Turns shown before and after the one the thread is on, and how many more a button shows. */
const AROUND = 6;
const MORE = 25;
/** Turns shown of a line that parts from the one the thread is on, before its button. */
const BRANCH = 3;
const TEXT_LENGTH = 160;
/** The largest request a button makes is far below this. */
const MAX_BODY = 2_000;

/** What the tree keeps of an entry. `prev`: the entry before it in every conversation that has it. */
export type LineEntry = {
	readonly id: number;
	prev: number | undefined;
	/** A message of the user's: a turn starts here. */
	readonly start: boolean;
	/** A response of the model's or a tool's result: part of what the turn is, where a fork's bookkeeping is not. */
	readonly work: boolean;
	readonly text: string;
	readonly at: number | undefined;
	readonly compaction: boolean;
};

/** Another thread, named on the turn it is at. */
export type OtherThread = { readonly threadId: string; readonly title: string };

export type Lines = {
	/** The conversation the thread is on. */
	readonly head: number;
	/** Each conversation's newest entry (`undefined`: it has none), the thread's own conversations first. */
	readonly tips: ReadonlyMap<number, number | undefined>;
	readonly entries: ReadonlyMap<number, LineEntry>;
	/** The conversations other threads are on. */
	readonly others?: ReadonlyMap<number, OtherThread>;
};

/** A turn: a message of the user's and what followed it, up to the next. */
export type TurnNode = {
	/** The entry it starts with and the last of its work: two lines that cut a turn at different places have two. */
	readonly key: string;
	readonly text: string;
	readonly answer: string;
	readonly at: number | undefined;
	readonly compacted: boolean;
	/** Where to fork to stand at its end: a conversation that has it, and its last entry there. */
	readonly end: { readonly conversation: number; readonly entryId: number };
	parent: TurnNode | undefined;
	readonly children: TurnNode[];
	/** On the line the thread is on. */
	current: boolean;
	/** The thread's last turn: where it is. */
	here: boolean;
	/** The other threads whose last turn this is. */
	readonly threads: OtherThread[];
};

export type TurnTree = { readonly head: number; readonly roots: TurnNode[]; readonly nodes: ReadonlyMap<string, TurnNode>; readonly lines: number; readonly threads: number };

const clip = (text: string, length: number): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
};

function lineEntry(entry: EntryRecord): LineEntry {
	const message = firstMessage(entry);
	const start = isUserEntry(entry) && !isCompactCommandEntry(entry);
	const assistant = message?.role === "assistant";
	return {
		id: entry.id,
		prev: undefined,
		start,
		work: assistant || message?.role === "toolResult",
		text: start || assistant ? clip(textOf(message!.content), TEXT_LENGTH) : "",
		at: start ? message!.timestamp : undefined,
		compaction: entry.kind === "pi.compaction",
	};
}

/**
 * The entries of the lines that share history with a thread (`Threads.linesOf`: the thread's head first), each read
 * from its newest entry down to the first one already read: a fork has its parent's entries up to where it was made,
 * under the same ids.
 */
export async function readLines(harness: Harness, lines: Awaited<ReturnType<Threads["linesOf"]>>): Promise<Lines> {
	const entries = new Map<number, LineEntry>();
	const tips = new Map<number, number | undefined>();
	const others = new Map(lines.slice(1).flatMap((line) => (line.thread === undefined ? [] : [[line.conversation, line.thread] as const])));
	for (const { conversation: id } of lines) {
		const conversation = await harness.conversation(id as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) continue;
		let newer: LineEntry | undefined;
		let joined = false;
		let cursor: Parameters<typeof conversation.entries>[2];
		tips.set(id, undefined);
		do {
			const page = await conversation.entries({ order: "descending" }, 200, cursor, BACKGROUND_CONTEXT);
			for (const entry of page.items as unknown as EntryRecord[]) {
				if (newer === undefined) tips.set(id, entry.id);
				else newer.prev = entry.id;
				if (entries.has(entry.id)) {
					joined = true;
					break;
				}
				newer = lineEntry(entry);
				entries.set(entry.id, newer);
			}
			cursor = page.next;
		} while (!joined && cursor !== undefined);
	}
	return { head: lines[0]!.conversation, tips, entries, others };
}

/**
 * The lines' turns as one tree. A turn is the same in two lines when it starts with the same message and its work
 * ends with the same entry; the turns before it are then the same too, so a line is walked from its newest turn down
 * to the first one the tree has.
 */
export function turnTree(lines: Lines): TurnTree {
	const nodes = new Map<string, TurnNode>();
	const roots: TurnNode[] = [];
	// The thread's own line first: its turns are the ones marked, and a turn is made by the first line that has it.
	for (const [conversation, tip] of [...lines.tips].sort(([a], [b]) => Number(b === lines.head) - Number(a === lines.head))) {
		const current = conversation === lines.head;
		const other = lines.others?.get(conversation);
		let above: TurnNode | undefined;
		let last: TurnNode | undefined;
		// The entries after the turn's first, newest first.
		let after: LineEntry[] = [];
		let joined = false;
		for (let entry = tip === undefined ? undefined : lines.entries.get(tip); entry !== undefined; entry = entry.prev === undefined ? undefined : lines.entries.get(entry.prev)) {
			if (!entry.start) {
				after.push(entry);
				continue;
			}
			const key = `${entry.id}:${after.find((each) => each.work)?.id ?? entry.id}`;
			let node = nodes.get(key);
			joined = node !== undefined;
			if (node === undefined) {
				node = {
					key,
					text: entry.text,
					answer: after.find((each) => each.work && each.text !== "")?.text ?? "",
					at: entry.at,
					compacted: after.some((each) => each.compaction),
					end: { conversation, entryId: after[0]?.id ?? entry.id },
					parent: undefined,
					children: [],
					current,
					here: current && above === undefined,
					threads: [],
				};
				nodes.set(key, node);
			}
			last ??= node;
			if (above !== undefined) {
				above.parent = node;
				node.children.push(above);
			}
			if (joined) break;
			above = node;
			after = [];
		}
		// What a line has before its first message (work an agent began, with no message of the user's): a turn too,
		// so that nothing a line has is left out of the tree.
		const before = after.find((each) => each.work);
		if (!joined && before !== undefined) {
			const key = `before:${after.at(-1)!.id}:${before.id}`;
			let node = nodes.get(key);
			if (node === undefined) {
				node = { key, text: "", answer: after.find((each) => each.work && each.text !== "")?.text ?? "", at: undefined, compacted: after.some((each) => each.compaction), end: { conversation, entryId: after[0]!.id }, parent: undefined, children: [], current, here: current && above === undefined, threads: [] };
				nodes.set(key, node);
				roots.push(node);
			}
			if (above !== undefined) {
				above.parent = node;
				node.children.push(above);
			}
			last ??= node;
		} else if (!joined && above !== undefined) roots.push(above);
		if (other !== undefined) last?.threads.push(other);
	}
	const order = (list: TurnNode[]): void => {
		list.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.end.entryId - b.end.entryId);
		for (const node of list) order(node.children);
	};
	order(roots);
	const all = [...nodes.values()];
	return { head: lines.head, roots, nodes, lines: Math.max(1, all.filter((node) => node.children.length === 0).length), threads: 1 + new Set(all.flatMap((node) => node.threads.map((thread) => thread.threadId))).size };
}

/** Which rows of the tree a page shows: more of each as its buttons are used. */
export type Window = { earlier: number; later: number; readonly more: Map<string, number> };

/** The line to follow from `node`: the one the thread is on, or the first. */
const next = (nodes: readonly TurnNode[]): TurnNode | undefined => nodes.find((node) => node.current) ?? nodes[0];
function chain(first: TurnNode | undefined): TurnNode[] {
	const list: TurnNode[] = [];
	for (let node = first; node !== undefined; node = next(node.children)) list.push(node);
	return list;
}

const escape = (text: string): string => text.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const STYLE = `
body{font:13px/1.45 var(--font-sans);color:var(--foreground)}
.turn{display:flex;gap:10px;align-items:flex-start;padding:7px 40px 7px 8px;border-radius:var(--radius)}
.turn:hover{background:var(--secondary)}
.dot{flex:none;width:9px;height:9px;margin-top:5px;border-radius:50%;border:2px solid var(--border);background:var(--background)}
.current>.dot{border-color:var(--primary);background:var(--primary)}
.body{flex:1;min-width:0}
.text{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.answer{color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.turn:not(.current) .text{font-weight:500;color:var(--muted-foreground)}
.side{flex:none;display:flex;gap:6px;align-items:center}
time{color:var(--muted-foreground);font:11px var(--font-mono)}
.here{color:var(--primary);font-weight:600;font-size:12px}
.tag{font-size:10px;padding:1px 5px;border-radius:999px;border:1px solid var(--border)}
.threads{display:flex;flex-wrap:wrap;gap:4px;margin-top:3px}
.thread{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--secondary);color:var(--foreground);white-space:nowrap}
.thread::before{content:"thread ";color:var(--muted-foreground)}
button{font:12px var(--font-sans);padding:3px 9px;border-radius:calc(var(--radius) - 2px);border:1px solid var(--border);background:var(--background);color:var(--foreground);cursor:pointer}
.turn button{visibility:hidden}
.turn:hover button,.turn button:focus{visibility:visible}
@media (hover:none){.turn button{visibility:visible}}
button.go:hover{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
button:hover{background:var(--secondary)}
button:disabled{opacity:.5;cursor:default}
.more{margin:4px 8px 4px 27px}
.more button{color:var(--muted-foreground)}
.branch{margin-left:13px;padding-left:12px;border-left:2px dashed var(--border)}
#status{margin:8px;color:var(--muted-foreground);min-height:18px}
#status.failed{color:var(--destructive)}
`;

/** How long the page waits to be shown again before it says that nothing happened. */
const PAGE_WAIT_MS = 8_000;
const script = (token: string): string => `
const status = document.getElementById("status");
for (const time of document.querySelectorAll("time[data-at]")) time.textContent = new Date(Number(time.dataset.at)).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
document.addEventListener("click", (event) => {
	const button = event.target.closest("button[data-action]");
	if (!button) return;
	const buttons = document.querySelectorAll("button");
	for (const each of buttons) each.disabled = true;
	status.className = "";
	status.textContent = "Working…";
	// The answer cannot be read from here (an opaque origin): the host shows this page again, with what happened.
	fetch(new URL(${JSON.stringify(THREAD_NAV_PATH)}, location.href), { method: "POST", mode: "no-cors", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token: ${JSON.stringify(token)}, action: button.dataset.action, node: button.dataset.node }) }).catch(() => {});
	setTimeout(() => {
		status.className = "failed";
		status.textContent = "Nothing happened: this view has expired, or the host cannot be reached. Run /tree again.";
		for (const each of buttons) each.disabled = false;
	}, ${PAGE_WAIT_MS});
});
`;

/**
 * The tree as a page, and how many rows it has. The line the thread is on is the column, shown around where the
 * thread is; a line that parts from it is indented under the turn it parts after, its first turns shown.
 */
export function treePage(tree: TurnTree, window: Window, token: string, notice?: string): { html: string; rows: number } {
	let rows = 0;
	const row = (node: TurnNode): string => {
		rows++;
		if (node.threads.length > 0) rows += 0.5;
		const threads = node.threads.map((thread) => `<span class="thread" title="Another thread is here">${escape(clip(thread.title, 60) || "Untitled thread")}</span>`).join("");
		const actions = node.here
			? `<span class="here">you are here</span>`
			: `<button class="go" data-action="go" data-node="${node.key}" title="Move this thread to the end of this turn">Go here</button><button data-action="fork" data-node="${node.key}" title="Open this turn and what led to it as a new thread">Fork</button>`;
		const time = node.at === undefined ? "" : `<time data-at="${node.at}">${new Date(node.at).toISOString().slice(0, 16).replace("T", " ")}</time>`;
		return `<div class="turn${node.current ? " current" : ""}"><span class="dot"></span><div class="body"><div class="text">${escape(node.text) || "<i>(no text)</i>"}</div><div class="answer">${escape(node.answer) || "<i>not answered</i>"}${node.compacted ? ' <span class="tag">compacted</span>' : ""}</div>${threads === "" ? "" : `<div class="threads">${threads}</div>`}</div><div class="side">${time}${actions}</div></div>`;
	};
	const more = (action: string, node: string | undefined, hidden: number, what: string): string => {
		rows++;
		return `<div class="more"><button data-action="${action}"${node === undefined ? "" : ` data-node="${node}"`}>Show ${hidden <= MORE ? count(hidden, `${what} turn`) : `${MORE} of ${hidden} ${what} turns`}</button></div>`;
	};
	const branches = (nodes: readonly TurnNode[], main: TurnNode | undefined): string =>
		nodes
			.filter((node) => node !== main)
			.map((node) => {
				const list = chain(node);
				const shown = list.slice(0, list.length - near(Math.max(0, list.length - BRANCH - (window.more.get(node.key) ?? 0))));
				return `<div class="branch">${shown.map((each, index) => row(each) + branches(each.children, list[index + 1])).join("")}${shown.length < list.length ? more("more", node.key, list.length - shown.length, "more") : ""}</div>`;
			})
			.join("");
	const main = chain(next(tree.roots));
	const here = main.findIndex((node) => node.here);
	// A button for a turn or two would take the room they do.
	const near = (hidden: number): number => (hidden <= 2 ? 0 : hidden);
	const from = near(Math.max(0, Math.max(0, here) - AROUND - window.earlier));
	const to = main.length - near(Math.max(0, main.length - (here + 1 + AROUND + window.later)));
	const body = [
		// The lines that share no turn with this one are always shown: nothing leads to them but this.
		branches(tree.roots, main[0]),
		from > 0 ? more("earlier", undefined, from, "earlier") : "",
		...main.slice(from, to).map((node, index) => row(node) + branches(node.children, main[from + index + 1])),
		to < main.length ? more("later", undefined, main.length - to, "later") : "",
	].join("");
	const said = notice ?? (here < 0 ? "The thread is at its start, before the first message." : "Each row is a message and its answer. Indented rows are other lines: what an undo left, and other threads forked from here, named where they are. Lines at the top share no turn with this one.");
	return { html: `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div id="tree">${body}</div><div id="status">${escape(said)}</div><script>${script(token)}</script></body></html>`, rows };
}

type Deps = {
	readonly store: Threads;
	readonly log: Logger;
	/** Where pages are kept, and what they are written through; without them `/tree` is refused. */
	readonly attachments: Attachments | undefined;
	readonly env: ExecutionEnv | undefined;
	/** Show the command's answer in the thread (`ThreadCommands.show`): the same message again replaces it. */
	show(threadId: string, said: Pick<ShownExchange, "messageId" | "answer" | "command" | "htmlRender">): void;
	/** After the thread moved: resolves once its view shows `head`. */
	moved(threadId: string, head: number): Promise<void>;
};

/** A page whose buttons work: what its token stands for. */
type View = { readonly threadId: string; readonly messageId: string; tree: TurnTree; window: Window; expires: number; published: number; files: string[]; busy: Promise<void> };

const emptyWindow = (): Window => ({ earlier: 0, later: 0, more: new Map() });

export class ThreadNavigator {
	readonly #deps: Deps;
	readonly #views = new Map<string, View>();

	constructor(deps: Deps) {
		this.#deps = deps;
	}

	/** The tree of a thread's turns, and of every line that shares history with it. */
	async tree(threadId: string): Promise<TurnTree> {
		return turnTree(await readLines(this.#deps.store.harness, await this.#deps.store.linesOf(threadId)));
	}

	/** `/tree`: show the thread's tree as the command's answer. */
	async open(threadId: string, messageId: string): Promise<void> {
		const tree = await this.tree(threadId);
		if (tree.nodes.size === 0) {
			this.#deps.show(threadId, { messageId, command: "/tree", answer: "There is nothing to show yet: this thread has no turns. Shown here only: not sent to the model, not saved." });
			return;
		}
		const now = Date.now();
		for (const [token, view] of this.#views) if (view.expires < now) this.#views.delete(token);
		for (const token of [...this.#views.keys()].slice(0, Math.max(0, this.#views.size + 1 - MAX_VIEWS))) this.#views.delete(token);
		const token = randomBytes(24).toString("base64url");
		const view: View = { threadId, messageId, tree, window: emptyWindow(), expires: now + VIEW_TTL_MS, published: 0, files: [], busy: Promise.resolve() };
		await this.#publish(token, view);
		this.#views.set(token, view);
	}

	/** Write the view's page and show it in the thread, in place of the one before. */
	async #publish(token: string, view: View, notice?: string): Promise<void> {
		const { attachments, env } = this.#deps;
		if (attachments === undefined || env === undefined) throw new Error("/tree shows a page, and this host keeps none (attachT3's attachmentsDir).");
		const { html, rows } = treePage(view.tree, view.window, token, notice);
		const page = await preparePublish(env, { html, title: "Thread", height: 40 + rows * 46 }, undefined, BACKGROUND_CONTEXT);
		// A new file each time: the frame shows a page again when its address changes.
		const attachmentId = createDeterministicAttachmentId(view.threadId, `thread-nav:${view.messageId}:${++view.published}`, "html");
		if (attachmentId === null) throw new Error(`Thread ${view.threadId} cannot hold attachments.`);
		await attachments.writeGenerated(attachmentId, new TextEncoder().encode(page.html));
		view.files.push(attachmentId);
		const turns = view.tree.nodes.size;
		this.#deps.show(view.threadId, {
			messageId: view.messageId,
			command: "/tree",
			htmlRender: { attachmentId, title: page.title, height: page.height } as HtmlRenderReference,
			answer: `${count(turns, "turn")} on ${count(view.tree.lines, "line")}${view.tree.threads === 1 ? "" : `, with ${count(view.tree.threads - 1, "other thread")} forked from them`}. Each row has "Go here", which moves this thread to the end of that turn, and "Fork", which opens it as a new thread. Shown here only: not sent to the model, not saved.`,
		});
		// The page before stays for a client that is still loading it; the ones before that go.
		for (const old of view.files.splice(0, Math.max(0, view.files.length - 2))) await attachments.removeGenerated(old).catch(() => {});
	}

	/**
	 * A button of a page. `go` moves the thread to the end of a turn, `fork` opens that as a new thread, and
	 * `earlier`, `later` and `more` show more rows. Each shows the page again, with what happened; the status is for
	 * the log and the tests, since the page cannot read it.
	 */
	async act(input: { readonly token?: unknown; readonly action?: unknown; readonly node?: unknown }): Promise<number> {
		const token = typeof input.token === "string" ? input.token : "";
		const view = this.#views.get(token);
		if (view === undefined || view.expires < Date.now()) return 410;
		view.expires = Date.now() + VIEW_TTL_MS;
		// One at a time for a page: each acts on the tree the last one left.
		const done = view.busy.then(() => this.#act(token, view, input.action, typeof input.node === "string" ? input.node : ""));
		view.busy = done.then(
			() => {},
			() => {},
		);
		return done;
	}

	async #act(token: string, view: View, action: unknown, key: string): Promise<number> {
		const { store } = this.#deps;
		let status = 200;
		let notice: string | undefined;
		if (action === "earlier") view.window.earlier += MORE;
		else if (action === "later") view.window.later += MORE;
		else if (action === "more") view.window.more.set(key, (view.window.more.get(key) ?? 0) + MORE);
		else if (action === "go" || action === "fork") {
			const node = view.tree.nodes.get(key);
			if (node === undefined) return 404;
			const label = `"${clip(node.text, 60) || "(no text)"}"`;
			try {
				if (action === "go") {
					const head = await store.moveTo({ threadId: view.threadId, expectedHead: view.tree.head, ...node.end, requestId: `thread-nav:${randomUUID()}` });
					await this.#deps.moved(view.threadId, head);
					this.#deps.log.info("moved a thread to a turn of its tree", { threadId: view.threadId, head });
					view.tree = await this.tree(view.threadId);
					view.window = emptyWindow();
					notice = `Moved this thread to ${label}. /redo goes back, until something new is written.`;
				} else {
					const source = await store.thread(view.threadId);
					const fork = await store.fork({ sourceThreadId: view.threadId, targetThreadId: randomUUID(), ...node.end, title: `${source?.title || "Thread"} (from ${clip(node.text, 30) || "a turn"})` });
					this.#deps.log.info("forked a turn of a thread's tree", { threadId: view.threadId, fork: fork.threadId });
					// The new thread is one of the tree's: named on its turn, the rows that are open left as they are.
					view.tree = await this.tree(view.threadId);
					notice = `Opened ${label} as a new thread: "${fork.title}". This thread is as it was.`;
				}
			} catch (error) {
				status = 409;
				if (error instanceof HostError && error.code === "turn_running") notice = "The agent is working, or messages are queued: stop the turn or clear the queue first. Nothing was moved.";
				else if (error instanceof HostError && error.code === "not_rewindable") {
					view.tree = await this.tree(view.threadId);
					view.window = emptyWindow();
					notice = "The thread had changed since this view was made: this is how it stands now. Nothing was moved.";
				} else {
					status = 500;
					this.#deps.log.warn("/tree: an action failed", { threadId: view.threadId, action, error: messageOf(error) });
					notice = `That did not work: ${messageOf(error)}`;
				}
			}
		} else return 400;
		await this.#publish(token, view, notice);
		return status;
	}

	/** What a page's buttons post to. Public: the token in the body is what a caller must have. */
	async handle(request: Request): Promise<Response> {
		const answer = (status: number): Response => new Response(null, { status, headers: { "cache-control": "no-store" } });
		if (Number(request.headers.get("content-length") ?? Number.NaN) > MAX_BODY) return answer(413);
		let input: unknown;
		try {
			input = JSON.parse((await request.text()).slice(0, MAX_BODY));
		} catch {
			return answer(400);
		}
		if (typeof input !== "object" || input === null) return answer(400);
		try {
			return answer(await this.act(input as Record<string, unknown>));
		} catch (error) {
			this.#deps.log.warn("/tree: a page could not be shown again", { error: messageOf(error) });
			return answer(500);
		}
	}
}
