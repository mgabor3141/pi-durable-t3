// Threads that drive threads: the operations behind `thread_prompt`, `thread_wait`, `thread_read`, `thread_search`,
// `thread_list` and `thread_cancel` (`thread-tools.ts`). One entity, the thread; a child is a thread with a parent link
// (its card shows in the run that started it, and it nests under its parent in T3). A prompt waits for its activity to
// settle and answers with the activity's report (`reports.ts`), or returns at once; a prompt that does not wait (or
// whose wait ran out) asks to be answered: once the activity settles and the caller is idle, the report is posted into
// the caller's thread, starting a turn there. A busy caller is not interrupted: it reads its children itself, and a
// report it collects (`thread_wait`, `thread_read`, or a prompt that waits) answers its requests, which are withdrawn.
// What is still owed when it goes idle arrives in one message, so it takes one turn, however many children finished.
// The request is kept on the receiving thread's record until it is delivered, and a batch's id is written on its
// requests before the send, whose command id it is, so a restart sends it once.
import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { NotifyRequest, Provenance, Thread } from "../threads.ts";
import type { Bridge } from "./bridge.ts";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { childCardNodeId } from "./projection.ts";
import { exchanges, isActiveRun, isBusy, type Report, report, settledReport, type Verdict, worstVerdict } from "./reports.ts";
import { subagentThreadTitle } from "./child-title.ts";

/** A refusal the tool returns to the agent as its error (no stack, no retry advice beyond the message). */
export class ThreadToolError extends Error {}

/** How deep children may nest under a thread that is not a child, and how many may be busy under one parent. */
export const MAX_DEPTH = 3;
export const MAX_ACTIVE_CHILDREN = 10;
/** A wait with no `timeoutMs` lasts until the work settles (or the call is aborted), as pi's do. */
const waitMs = (timeoutMs: number | undefined) => (timeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(1, timeoutMs));
/** A follower re-arms its wait this often; it holds the thread open meanwhile. */
const FOLLOW_CHUNK_MS = 60 * 60_000;

const hash = (...parts: readonly (string | undefined)[]) => createHash("sha256").update(parts.map((part) => part ?? "").join("\0")).digest("base64url").slice(0, 20);

export type PromptMode = "auto" | "followUp" | "steer" | "notify";

export interface PromptInput {
	readonly threadId?: string;
	readonly new?: { readonly title?: string; readonly model?: string; readonly fork?: boolean };
	readonly message: string;
	readonly mode?: PromptMode;
	readonly wait?: boolean;
	readonly timeoutMs?: number;
	readonly notify?: boolean;
	readonly clientRequestId?: string;
}

export interface PromptResult {
	readonly threadId: string;
	readonly messageId: string;
	/** The activity's report, when the prompt waited. */
	readonly report?: Report;
	/** The report will be posted into the caller's thread when the activity settles. */
	readonly notify: boolean;
}

export interface ThreadSummaryRow {
	readonly threadId: string;
	readonly title: string;
	readonly parentThreadId: string | null;
	readonly status: string;
	readonly updatedAt: string;
	readonly lastMessage: string | null;
}

export class Orchestration {
	readonly #bridge: Bridge;
	readonly #log: Logger;
	/** Reports ready for each caller, by request id, until its deliverer posts them. */
	readonly #outbox = new Map<string, Map<string, { readonly child: string; readonly request: NotifyRequest; readonly report: Report }>>();
	/** Requests taken from an outbox and not yet dropped from their records: handed over, so not followed again. */
	readonly #inFlight = new Set<string>();
	/** The callers a deliverer is posting to, so each has one. */
	readonly #delivering = new Set<string>();
	/** The threads a follower is watching, so each has one. */
	readonly #following = new Set<string>();
	#closed = false;
	readonly #stop = new AbortController();

	constructor(bridge: Bridge, log: Logger) {
		this.#bridge = bridge;
		this.#log = log;
	}

	/** Resume delivering what the last process owed: every thread whose record keeps a request to be answered. */
	start(): void {
		void this.#bridge.loaded().then(() => {
			for (const thread of this.#bridge.threadRecords()) if ((thread.notify?.length ?? 0) > 0) this.#follow(thread.threadId);
		});
	}

	close(): void {
		this.#closed = true;
		this.#stop.abort();
	}

	// ---- prompt -----------------------------------------------------------------------------------------------

	async prompt(caller: string | undefined, input: PromptInput, signal?: AbortSignal): Promise<PromptResult> {
		if ((input.threadId === undefined) === (input.new === undefined)) throw new ThreadToolError("Name a threadId to prompt, or pass new to start a thread (not both).");
		const mode = input.mode ?? "auto";
		const key = input.clientRequestId ?? randomUUID();
		const id = hash(caller, key);
		const commandId = `prompt-${id}`;
		const messageId = `m-${id}`;
		const provenance: Provenance = { createdBy: "agent", creationSource: "mcp", ...(caller === undefined ? {} : { senderThreadId: caller }) };
		const threadId = input.new === undefined ? this.#existing(input.threadId!, caller) : await this.#startChild(caller, input.new, input.message, id, provenance);
		if (mode === "notify") {
			if (input.new !== undefined) throw new ThreadToolError("A new thread starts with a prompt; mode notify only adds to an existing one.");
			await this.#bridge.sendMessage({ threadId, commandId, messageId, text: input.message, mode: "queue", provenance, note: true });
			return { threadId, messageId, notify: false };
		}
		const wait = input.wait ?? true;
		let notify = input.notify ?? (!wait && caller !== undefined);
		if (notify && caller === undefined) throw new ThreadToolError("notify needs a calling thread to answer to.");
		// Asked before it is sent: a crash after the send still finds the request.
		if (notify) await this.#ask(threadId, caller!, commandId, messageId);
		if (mode === "steer") {
			const projection = await this.#projection(threadId);
			if (!isBusy(projection)) throw new ThreadToolError(`Thread ${threadId} is not working; send without mode steer to start it.`);
		}
		await this.#bridge.sendMessage({ threadId, commandId, messageId, text: input.message, mode: mode === "steer" ? "steer" : "queue", provenance });
		if (!wait) return { threadId, messageId, notify };
		const settled = await this.#waitSettled(threadId, messageId, caller, waitMs(input.timeoutMs), signal);
		// The caller has the report now: a request it also made (`notify: true`) is answered.
		if (settled !== undefined && notify) await this.#answered(threadId, caller!);
		if (settled !== undefined) return { threadId, messageId, report: settled, notify: false };
		// The wait ran out (or a restart ended it): the work goes on, and its report is sent when it settles.
		if (!notify && caller !== undefined) {
			await this.#ask(threadId, caller, commandId, messageId);
			notify = true;
		}
		return { threadId, messageId, report: this.#activeReport(await this.#projection(threadId), messageId, caller), notify };
	}

	#existing(threadId: string, caller: string | undefined): string {
		if (!this.#bridge.hasThread(threadId) || this.#bridge.threadRecord(threadId) === undefined) throw new ThreadToolError(`No thread ${threadId}.`);
		if (threadId === caller) throw new ThreadToolError("A thread cannot prompt itself.");
		return threadId;
	}

	/** Start a child of the caller: a new thread (or a fork of the caller's history) linked to the run that started it. */
	async #startChild(caller: string | undefined, spec: NonNullable<PromptInput["new"]>, prompt: string, id: string, provenance: Provenance): Promise<string> {
		if (caller === undefined) throw new ThreadToolError("Starting a thread needs a calling thread: it becomes that thread's child.");
		const parent = this.#bridge.threadRecord(caller);
		if (parent === undefined) throw new ThreadToolError(`The calling thread ${caller} is gone.`);
		const childId = `t-${id}`;
		// A retried call finds the child it made.
		if (this.#bridge.threadRecord(childId) !== undefined) return childId;
		if (this.#depth(parent) >= MAX_DEPTH) throw new ThreadToolError(`Threads nest at most ${MAX_DEPTH} deep; this thread is at the limit, so do the work here or hand it to a sibling.`);
		const busy = this.#bridge.threadRecords().filter((thread) => thread.spawn !== undefined && thread.lineage.parentThreadId === caller && this.#isActive(thread.threadId)).length;
		if (busy >= MAX_ACTIVE_CHILDREN) throw new ThreadToolError(`${busy} children of this thread are working (at most ${MAX_ACTIVE_CHILDREN}); wait for some to finish first.`);
		const projection = await this.#projection(caller);
		const runs = projection.runs.toSorted((left, right) => right.ordinal - left.ordinal);
		const parentRun = runs.find(isActiveRun) ?? runs[0];
		if (parentRun === undefined) throw new ThreadToolError("The calling thread has no run to start a child from.");
		const ordinal = this.#bridge.threadRecords().filter((thread) => thread.lineage.parentThreadId === caller && thread.spawn !== undefined).length + 1;
		const title = spec.title?.trim() || subagentThreadTitle({ parentTitle: parent.title || "New thread", title: null, prompt, ordinal });
		const spawn = { parentRunId: parentRun.id as string, prompt: prompt.slice(0, 2_000) };
		const nodeId = childCardNodeId(childId);
		if (spec.fork === true) {
			// The caller's history up to its last settled run: the run in flight is this call's own, still open.
			const settled = runs.find((run) => !isActiveRun(run));
			if (settled === undefined) throw new ThreadToolError("Nothing to fork yet: the calling thread has no finished run.");
			await this.#bridge.forkThread({ sourceThreadId: caller, targetThreadId: childId, runId: settled.id as string, title, provenance, child: { spawn, nodeId } });
		} else {
			await this.#bridge.createThread({
				threadId: childId,
				projectId: parent.projectId,
				title,
				provenance,
				child: { lineage: { parentThreadId: caller, relationshipToParent: "subagent", rootThreadId: parent.lineage.rootThreadId }, nodeId, spawn },
			});
		}
		const model = spec.model ?? (this.#bridge.threadShell(caller).modelSelection.model as string | undefined);
		if (model !== undefined) {
			try {
				await this.#bridge.applySelection(childId, { model });
			} catch (error) {
				throw new ThreadToolError((error as Error).message);
			}
		}
		this.#log.info("thread started a child", { parent: caller, child: childId, fork: spec.fork === true });
		return childId;
	}

	#depth(thread: Thread): number {
		let depth = 0;
		for (let current: Thread | undefined = thread; current?.spawn !== undefined && current.lineage.parentThreadId != null; depth++) {
			current = this.#bridge.threadRecord(current.lineage.parentThreadId);
		}
		return depth;
	}

	#isActive(threadId: string): boolean {
		const shell = this.#bridge.threadShell(threadId);
		return shell.activityRunStatus != null || ["queued", "preparing", "starting", "running", "waiting"].includes(shell.status);
	}

	// ---- waiting ----------------------------------------------------------------------------------------------

	/** Wait for several threads' current activities; a thread with none answers its latest exchange at once. */
	async wait(caller: string | undefined, threadIds: readonly string[], timeoutMs: number | undefined, signal?: AbortSignal): Promise<{ readonly reports: readonly Report[]; readonly verdict: Verdict }> {
		if (threadIds.length === 0) throw new ThreadToolError("Name at least one thread.");
		for (const threadId of threadIds) this.#existing(threadId, caller);
		const deadline = Date.now() + waitMs(timeoutMs);
		const reports = await Promise.all(
			threadIds.map(async (threadId) => {
				const report = await this.#waitOne(threadId, caller, deadline, signal);
				// Collected here: the caller's requests this report answers are withdrawn, so it is not posted again.
				if (caller !== undefined && report.verdict !== "active") await this.#answered(threadId, caller);
				return report;
			}),
		);
		return { reports, verdict: worstVerdict(reports.map((entry) => entry.verdict)) };
	}

	/** One thread's report for `wait`: its current activity once it settles (or the deadline passes), or its latest. */
	async #waitOne(threadId: string, caller: string | undefined, deadline: number, signal: AbortSignal | undefined): Promise<Report> {
		const before = await this.#projection(threadId);
		const runs = before.runs.toSorted((left, right) => left.ordinal - right.ordinal);
		const from = runs.find(isActiveRun) ?? runs.at(-1);
		const options = { ...(caller === undefined ? {} : { reader: caller }), label: (id: string) => this.#label(id) };
		if (!isBusy(before) || from === undefined) return report(before, { ...options, fromRunId: from?.id as string | undefined });
		const combined = this.#signal(signal);
		const settled = await this.#bridge
			.waitFor(threadId, (projection) => (isBusy(projection) ? undefined : report(projection, { ...options, fromRunId: from.id as string })), Math.max(1, deadline - Date.now()), combined)
			.catch((error: unknown) => {
				if (combined.aborted) return undefined;
				throw error;
			});
		return settled ?? report(await this.#projection(threadId), { ...options, fromRunId: from.id as string });
	}

	/** Withdraw `caller`'s requests on `threadId` whose activity has settled: the caller collected that report itself. */
	async #answered(threadId: string, caller: string): Promise<void> {
		const pending = (this.#bridge.threadRecord(threadId)?.notify ?? []).filter((request) => request.threadId === caller);
		if (pending.length === 0) return;
		const projection = await this.#projection(threadId);
		const answered = new Set(pending.filter((request) => settledReport(projection, request.messageId, this.#reportOptions(request.messageId, caller)) !== undefined).map((request) => request.id));
		if (answered.size === 0) return;
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			record.notify = (record.notify ?? []).filter((request) => !answered.has(request.id));
		});
	}

	async #waitSettled(threadId: string, messageId: string, reader: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Report | undefined> {
		try {
			return await this.#bridge.waitFor(threadId, (projection) => settledReport(projection, messageId, this.#reportOptions(messageId, reader)), timeoutMs, this.#signal(signal));
		} catch (error) {
			if ((error as Error).name === "AbortError" || this.#signal(signal)?.aborted === true) return undefined;
			throw error;
		}
	}

	#activeReport(projection: OrchestrationV2ThreadProjection, messageId: string, reader: string | undefined): Report {
		const runId = projection.messages.find((message) => (message.id as string) === messageId)?.runId;
		return report(projection, { fromRunId: runId == null ? undefined : (runId as string), ...this.#reportOptions(messageId, reader) });
	}

	/** A report for the thread that sent `messageId` (`reader`, when it is a thread). */
	#reportOptions(messageId: string, reader: string | undefined) {
		return { own: messageId, ...(reader === undefined ? {} : { reader }), label: (id: string) => this.#label(id) };
	}

	/** The caller's signal, and this orchestration's own close, as one. */
	#signal(signal: AbortSignal | undefined): AbortSignal {
		return AbortSignal.any([this.#stop.signal, ...(signal === undefined ? [] : [signal])]);
	}

	// ---- reading ----------------------------------------------------------------------------------------------

	async read(caller: string | undefined, input: { readonly threadId?: string; readonly last?: number; readonly before?: number }): Promise<{ readonly threadId: string; readonly title: string; readonly text: string; readonly earlier: number; readonly oldestOrdinal: number | null }> {
		const threadId = input.threadId ?? caller;
		if (threadId === undefined) throw new ThreadToolError("Name a threadId: this call is not inside a thread.");
		if (!this.#bridge.hasThread(threadId)) throw new ThreadToolError(`No thread ${threadId}.`);
		const projection = await this.#projection(threadId);
		const read = exchanges(projection, { count: Math.min(50, Math.max(1, input.last ?? 1)), ...(input.before === undefined ? {} : { before: input.before }), ...(caller === undefined ? {} : { reader: caller }), label: (id) => this.#label(id) });
		// Reading a child's latest exchange collects its report, as a wait does.
		if (caller !== undefined && threadId !== caller && input.before === undefined) await this.#answered(threadId, caller);
		const parts = read.reports.map((entry) => `=== exchange ${entry.ordinal} (${entry.verdict}) ===\n${entry.text}`);
		if (read.earlier > 0) parts.unshift(`[${read.earlier} earlier exchange${read.earlier === 1 ? "" : "s"}; pass before: ${read.reports[0]?.ordinal} to read them]`);
		return { threadId, title: projection.thread.title, text: parts.join("\n\n") || "[No exchanges yet]", earlier: read.earlier, oldestOrdinal: read.reports[0]?.ordinal ?? null };
	}

	async search(query: string, limit = 20) {
		const found = await this.#bridge.searchThreads(query, Math.min(100, Math.max(1, limit)));
		return found.matches.map((match) => ({ threadId: match.threadId as string, title: this.#bridge.threadRecord(match.threadId as string)?.title ?? "", snippet: match.snippet, at: match.messageCreatedAt }));
	}

	list(caller: string | undefined, filter: { readonly parent?: string; readonly status?: "active" | "idle"; readonly projectId?: string; readonly limit?: number }): ThreadSummaryRow[] {
		const parent = filter.parent === "self" ? caller : filter.parent;
		const rows: ThreadSummaryRow[] = [];
		for (const thread of [...this.#bridge.threadRecords()].reverse()) {
			if (parent !== undefined && thread.lineage.parentThreadId !== parent) continue;
			if (filter.projectId !== undefined && thread.projectId !== filter.projectId) continue;
			const active = this.#isActive(thread.threadId);
			if (filter.status !== undefined && (filter.status === "active") !== active) continue;
			const latest = thread.summary?.latestVisibleMessage;
			rows.push({
				threadId: thread.threadId,
				title: thread.title,
				parentThreadId: thread.spawn === undefined ? null : thread.lineage.parentThreadId,
				status: active ? "active" : (thread.spawn?.outcome?.status ?? "idle"),
				updatedAt: new Date(thread.summary?.updatedAt ?? thread.createdAt).toISOString(),
				lastMessage: latest == null ? null : latest.text.slice(0, 200),
			});
			if (rows.length >= Math.min(200, Math.max(1, filter.limit ?? 50))) break;
		}
		return rows;
	}

	// ---- cancelling -------------------------------------------------------------------------------------------

	/**
	 * Stop a thread's work (its queued messages too) and, with `cascade`, its children's. No report of the stopped work is
	 * sent to the caller or within the stopped threads: a stopped thread woken by its child's report would start again.
	 */
	async cancel(caller: string | undefined, threadId: string, cascade = true): Promise<{ readonly stopped: readonly string[] }> {
		this.#existing(threadId, caller);
		const subtree: string[] = [];
		const collect = (id: string) => {
			subtree.push(id);
			if (!cascade) return;
			for (const child of this.#bridge.threadRecords()) if (child.spawn !== undefined && child.lineage.parentThreadId === id && child.threadId !== caller && !subtree.includes(child.threadId)) collect(child.threadId);
		};
		collect(threadId);
		const silenced = new Set([...subtree, ...(caller === undefined ? [] : [caller])]);
		for (const id of subtree) {
			if (!(this.#bridge.threadRecord(id)?.notify ?? []).some((request) => silenced.has(request.threadId))) continue;
			await this.#bridge.updateThreadRecord(id, (record) => {
				record.notify = (record.notify ?? []).filter((request) => !silenced.has(request.threadId));
			});
		}
		const stopped: string[] = [];
		for (const id of subtree) {
			if (!this.#isActive(id)) continue;
			await this.#bridge.interrupt(id);
			stopped.push(id);
		}
		this.#log.info("threads stopped", { by: caller, stopped });
		return { stopped };
	}

	// ---- answering --------------------------------------------------------------------------------------------

	async #ask(threadId: string, caller: string, id: string, messageId: string): Promise<void> {
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			const notify = record.notify ?? [];
			if (notify.some((request) => request.id === id)) return false;
			record.notify = [...notify, { id, threadId: caller, messageId, createdAt: Date.now() } satisfies NotifyRequest];
		});
		this.#follow(threadId);
	}

	/** Watch a thread's requests: as each one's activity settles, hand its report to the caller's outbox. One follower
	 * per thread, until every request it holds is handed over. */
	#follow(threadId: string): void {
		if (this.#closed || this.#following.has(threadId)) return;
		this.#following.add(threadId);
		void (async () => {
			try {
				while (!this.#closed) {
					const handed = (request: NotifyRequest) => this.#inFlight.has(request.id) || this.#outbox.get(request.threadId)?.has(request.id) === true;
					const request = (this.#bridge.threadRecord(threadId)?.notify ?? []).find((candidate) => !handed(candidate));
					if (request === undefined) return;
					const ready = await this.#bridge
						.waitFor(threadId, (projection) => settledReport(projection, request.messageId, this.#reportOptions(request.messageId, request.threadId)), FOLLOW_CHUNK_MS, this.#stop.signal)
						.catch((error: unknown) => {
							if (this.#closed) return undefined;
							throw error;
						});
					if (ready === undefined) continue;
					const box = this.#outbox.get(request.threadId) ?? new Map();
					this.#outbox.set(request.threadId, box);
					box.set(request.id, { child: threadId, request, report: ready });
					this.#deliverTo(request.threadId);
				}
			} catch (error) {
				if (!this.#closed) this.#log.warn("thread notification follower stopped", { threadId, error: error instanceof Error ? error.message : String(error) });
			} finally {
				this.#following.delete(threadId);
			}
		})();
	}

	/** Post a caller's ready reports once it is idle, all in one message, until its outbox is empty. One deliverer per
	 * caller. A report withdrawn meanwhile (the caller collected it) is left out. */
	#deliverTo(caller: string): void {
		if (this.#closed || this.#delivering.has(caller)) return;
		this.#delivering.add(caller);
		void (async () => {
			try {
				while (!this.#closed) {
					const box = this.#outbox.get(caller);
					if (box === undefined || box.size === 0) return;
					if (this.#bridge.hasThread(caller)) {
						const idle = await this.#bridge.waitFor(caller, (projection) => (isBusy(projection) ? undefined : true), FOLLOW_CHUNK_MS, this.#stop.signal).catch((error: unknown) => {
							if (this.#closed) return undefined;
							throw error;
						});
						if (idle === undefined) continue;
					}
					const taken = [...box.values()];
					for (const item of taken) {
						box.delete(item.request.id);
						this.#inFlight.add(item.request.id);
					}
					if (box.size === 0) this.#outbox.delete(caller);
					try {
						// As the records hold them now: withdrawn ones are gone, and a batch written before a crash is kept.
						const owed = taken.flatMap((item) => {
							const request = (this.#bridge.threadRecord(item.child)?.notify ?? []).find((candidate) => candidate.id === item.request.id);
							return request === undefined ? [] : [{ ...item, request }];
						});
						if (owed.length > 0) await this.#deliver(caller, owed);
					} finally {
						for (const item of taken) this.#inFlight.delete(item.request.id);
					}
				}
			} catch (error) {
				if (!this.#closed) this.#log.warn("thread report delivery stopped", { caller, error: error instanceof Error ? error.message : String(error) });
			} finally {
				this.#delivering.delete(caller);
				// A report handed over after the last look waits for the next deliverer.
				if (!this.#closed && (this.#outbox.get(caller)?.size ?? 0) > 0) this.#deliverTo(caller);
			}
		})();
	}

	/** Post reports into the asking thread as one message, then drop their requests. Each batch's id is written on its
	 * requests first and is the send's command id, so a send retried after a crash (with the same batch) is a no-op. */
	async #deliver(caller: string, items: readonly { readonly child: string; readonly request: NotifyRequest; readonly report: Report }[]): Promise<void> {
		const batches = new Map<string, (typeof items)[number][]>();
		const fresh = items.filter((item) => item.request.batch === undefined);
		const freshId = fresh.length === 1 ? fresh[0]!.request.id : hash(...fresh.map((item) => item.request.id).toSorted());
		for (const item of items) {
			const batch = item.request.batch ?? freshId;
			batches.set(batch, [...(batches.get(batch) ?? []), item]);
		}
		for (const item of fresh) {
			await this.#bridge.updateThreadRecord(item.child, (record) => {
				const request = (record.notify ?? []).find((candidate) => candidate.id === item.request.id);
				if (request === undefined) return false;
				request.batch = freshId;
			});
		}
		for (const [batch, members] of batches) {
			const ordered = members.toSorted((left, right) => left.request.createdAt - right.request.createdAt);
			if (this.#bridge.threadRecord(caller) !== undefined) {
				const text = ordered.map(({ child, report }) => `[Report from thread "${report.title}" (${child}), ${report.verdict}]\n${report.text}`).join("\n\n");
				const single = ordered.length === 1 ? ordered[0]!.child : undefined;
				await this.#bridge.sendMessage({
					threadId: caller,
					commandId: `notify-${batch}`,
					messageId: `n-${hash(batch)}`,
					text,
					mode: "queue",
					provenance: { createdBy: "agent", creationSource: "server", ...(single === undefined ? {} : { senderThreadId: single }) },
					automatic: true,
				});
				this.#log.info("thread reports delivered", { to: caller, from: ordered.map((item) => item.child), verdicts: ordered.map((item) => item.report.verdict) });
			}
			for (const { child, request } of ordered) {
				await this.#bridge.updateThreadRecord(child, (record) => {
					record.notify = (record.notify ?? []).filter((candidate) => candidate.id !== request.id);
				});
			}
		}
	}

	// ---- helpers ----------------------------------------------------------------------------------------------

	async #projection(threadId: string): Promise<OrchestrationV2ThreadProjection> {
		try {
			return (await this.#bridge.projection(threadId)).projection;
		} catch (error) {
			if (error instanceof CommandError) throw new ThreadToolError(error.message);
			throw error;
		}
	}

	#label(threadId: string): string {
		const title = this.#bridge.threadRecord(threadId)?.title;
		return title === undefined || title === "" ? threadId : `"${title}" (${threadId})`;
	}
}
