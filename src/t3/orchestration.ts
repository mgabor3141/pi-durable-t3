// Threads that drive threads: the operations behind `thread_prompt`, `thread_wait`, `thread_read`, `thread_search`,
// `thread_list` and `thread_cancel` (`thread-tools.ts`). One entity, the thread; a child is a thread with a parent link
// (its card shows in the run that started it, and it nests under its parent in T3). A prompt waits for its activity to
// settle and answers with the activity's report (`reports.ts`), or returns at once; a prompt that does not wait (or
// whose wait ran out) asks to be answered: the report is posted into the caller's thread when the activity settles,
// starting a turn there if it is idle. The request is kept on the receiving thread's record until it is delivered, and
// its delivery is idempotent, so a restart delivers it once.
import { createHash, randomUUID } from "node:crypto";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { NotifyRequest, Provenance, Thread } from "../threads.ts";
import type { Bridge } from "./bridge.ts";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { childCardNodeId } from "./projection.ts";
import { exchanges, isActiveRun, isBusy, type Report, report, settledReport, type Verdict, worstVerdict } from "./reports.ts";
import { subagentThreadTitle } from "./subagents.ts";

/** A refusal the tool returns to the agent as its error (no stack, no retry advice beyond the message). */
export class ThreadToolError extends Error {}

/** How deep children may nest under a thread that is not a child, and how many may be busy under one parent. */
export const MAX_DEPTH = 3;
export const MAX_ACTIVE_CHILDREN = 10;
/** A wait's default: under codemode's five-minute script limit. */
export const DEFAULT_WAIT_MS = 4 * 60_000;
const MAX_WAIT_MS = 60 * 60_000;
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
	readonly #waitSignal: () => AbortSignal | undefined;
	/** The threads a follower is delivering for, so each has one. */
	readonly #following = new Set<string>();
	#closed = false;
	readonly #stop = new AbortController();

	constructor(bridge: Bridge, log: Logger, options: { readonly waitSignal?: () => AbortSignal | undefined } = {}) {
		this.#bridge = bridge;
		this.#log = log;
		this.#waitSignal = options.waitSignal ?? (() => undefined);
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
		const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
		const settled = await this.#waitSettled(threadId, messageId, timeoutMs, signal);
		if (settled !== undefined) return { threadId, messageId, report: settled, notify: false };
		// The wait ran out (or a restart ended it): the work goes on, and its report is sent when it settles.
		if (!notify && caller !== undefined) {
			await this.#ask(threadId, caller, commandId, messageId);
			notify = true;
		}
		return { threadId, messageId, report: this.#activeReport(await this.#projection(threadId), messageId), notify };
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
		const deadline = Date.now() + Math.min(MAX_WAIT_MS, Math.max(1, timeoutMs ?? DEFAULT_WAIT_MS));
		const reports = await Promise.all(
			threadIds.map(async (threadId) => {
				const before = await this.#projection(threadId);
				const runs = before.runs.toSorted((left, right) => left.ordinal - right.ordinal);
				const from = runs.find(isActiveRun) ?? runs.at(-1);
				const options = { label: (id: string) => this.#label(id) };
				if (!isBusy(before) || from === undefined) return report(before, { ...options, fromRunId: from?.id as string | undefined });
				const combined = this.#signal(signal);
				const settled = await this.#bridge
					.waitFor(threadId, (projection) => (isBusy(projection) ? undefined : report(projection, { ...options, fromRunId: from.id as string })), Math.max(1, deadline - Date.now()), combined)
					.catch((error: unknown) => {
						if (combined.aborted) return undefined;
						throw error;
					});
				return settled ?? report(await this.#projection(threadId), { ...options, fromRunId: from.id as string });
			}),
		);
		return { reports, verdict: worstVerdict(reports.map((entry) => entry.verdict)) };
	}

	async #waitSettled(threadId: string, messageId: string, timeoutMs: number, signal?: AbortSignal): Promise<Report | undefined> {
		try {
			return await this.#bridge.waitFor(threadId, (projection) => settledReport(projection, messageId, { own: messageId, label: (id) => this.#label(id) }), timeoutMs, this.#signal(signal));
		} catch (error) {
			if ((error as Error).name === "AbortError" || this.#signal(signal)?.aborted === true) return undefined;
			throw error;
		}
	}

	#activeReport(projection: OrchestrationV2ThreadProjection, messageId: string): Report {
		const runId = projection.messages.find((message) => (message.id as string) === messageId)?.runId;
		return report(projection, { fromRunId: runId == null ? undefined : (runId as string), own: messageId, label: (id) => this.#label(id) });
	}

	/** The caller's signal, the host's (a restart ends waits), and this orchestration's own close, as one. */
	#signal(signal: AbortSignal | undefined): AbortSignal {
		return AbortSignal.any([this.#stop.signal, ...(signal === undefined ? [] : [signal]), ...(this.#waitSignal() === undefined ? [] : [this.#waitSignal()!])]);
	}

	// ---- reading ----------------------------------------------------------------------------------------------

	async read(caller: string | undefined, input: { readonly threadId?: string; readonly last?: number; readonly before?: number }): Promise<{ readonly threadId: string; readonly title: string; readonly text: string; readonly earlier: number; readonly oldestOrdinal: number | null }> {
		const threadId = input.threadId ?? caller;
		if (threadId === undefined) throw new ThreadToolError("Name a threadId: this call is not inside a thread.");
		if (!this.#bridge.hasThread(threadId)) throw new ThreadToolError(`No thread ${threadId}.`);
		const projection = await this.#projection(threadId);
		const read = exchanges(projection, { count: Math.min(50, Math.max(1, input.last ?? 1)), ...(input.before === undefined ? {} : { before: input.before }), label: (id) => this.#label(id) });
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

	/** Deliver a thread's requests as its activities settle, one follower per thread, until none is left. */
	#follow(threadId: string): void {
		if (this.#closed || this.#following.has(threadId)) return;
		this.#following.add(threadId);
		void (async () => {
			try {
				while (!this.#closed) {
					const pending = this.#bridge.threadRecord(threadId)?.notify ?? [];
					if (pending.length === 0) return;
					const request = pending[0]!;
					const ready = await this.#bridge
						.waitFor(threadId, (projection) => settledReport(projection, request.messageId, { own: request.messageId, label: (id) => this.#label(id) }), FOLLOW_CHUNK_MS, this.#stop.signal)
						.catch((error: unknown) => {
							if (this.#closed) return undefined;
							throw error;
						});
					if (ready === undefined) continue;
					await this.#deliver(threadId, request, ready);
				}
			} catch (error) {
				if (!this.#closed) this.#log.warn("thread notification follower stopped", { threadId, error: error instanceof Error ? error.message : String(error) });
			} finally {
				this.#following.delete(threadId);
			}
		})();
	}

	/** Post the report into the asking thread (starting a turn if it is idle; joining its work if it is busy), then drop
	 * the request. The send's command id is the request's, so a retry after a crash is a no-op. */
	async #deliver(threadId: string, request: NotifyRequest, ready: Report): Promise<void> {
		// Withdrawn while the activity ran (a cancel): nothing to send.
		if (!(this.#bridge.threadRecord(threadId)?.notify ?? []).some((candidate) => candidate.id === request.id)) return;
		const target = this.#bridge.threadRecord(request.threadId);
		if (target !== undefined) {
			const header = `[Report from thread "${ready.title}" (${threadId}), ${ready.verdict}]`;
			await this.#bridge.sendMessage({
				threadId: request.threadId,
				commandId: `notify-${request.id}`,
				messageId: `n-${hash(request.id)}`,
				text: `${header}\n${ready.text}`,
				mode: "queue",
				provenance: { createdBy: "agent", creationSource: "server", senderThreadId: threadId },
			});
			this.#log.info("thread report delivered", { from: threadId, to: request.threadId, verdict: ready.verdict });
		}
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			record.notify = (record.notify ?? []).filter((candidate) => candidate.id !== request.id);
		});
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
