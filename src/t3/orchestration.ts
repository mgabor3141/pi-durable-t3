// Threads that drive threads: the operations behind `thread_prompt`, `thread_wait`, `thread_read`, `thread_search`,
// `thread_list` and `thread_cancel` (`thread-tools.ts`). One entity, the thread; a child is a thread with a parent link
// (its card shows in the run that started it, and it nests under its parent in T3). A prompt waits for its activity to
// settle and answers with the activity's report (`reports.ts`), or returns at once; a prompt that does not wait (or
// whose wait ran out) asks to be answered, and the report is posted into the caller's thread, as T3 delivers a delegated
// task's completion (`Orchestrator.ts`, completionWake and the delegated-completion cohort):
// - A child started without waiting wakes its caller when it settles (T3's `always`): into the caller's running turn as
//   a steer (pi steers without interrupting tools, as T3 asks before it steers), or as a new turn when the caller is idle.
//   It never interrupts or restarts a turn. A request made because a wait ran out (T3's `settled_only`) waits until the
//   turn that made it has ended, and then queues.
// - Reports that settle while an earlier one waits in the caller's queue join that message: one message, one turn.
// - A report the caller collects itself (`thread_wait`, `thread_read` of the child's latest exchange, or a prompt that
//   waits) answers its requests, which are withdrawn; while the caller waits for a child, that child's report is held.
//   One already in a report message still waiting in the caller's queue is taken out of it, and a message left with
//   none is cancelled, as T3 acknowledges a task's result (`dispatchDelegatedTaskCompletionDeliveryResolution`).
// - A thread that waits for reports of children it started has not settled (T3's `waiting_for_children`): their reports
//   wake it and its work goes on, so the report of that work waits for it.
// - A person's message to a child, or its parent's through T3's tools, asks for the report to go to the parent, as T3
//   makes it a new delegated task (`Orchestrator.ts`, the follow-up owned by the parent's run).
// - A person's Stop on a thread stops the threads it started too, with no report to it or among them, as T3's Stop
//   stops a thread's delegated tasks.
// - One message holds at most 16,000 characters of reports, as T3 inlines delegated results up to 16 KB in one wake; a
//   report past that says where to read it.
// The request is kept on the receiving thread's record until it is delivered; the message it goes into is written on it
// first, so a restart finds that message and does not send it twice.
// A child that asks a question (`ask_user`) is blocked until it is answered, and the answer is its parent's to give
// (`child-questions.ts`): the question ends the parent's wait for it, as T3's ends a wait for a delegated task
// (`hasPendingQuestion`), with a report that names the request. The report of the work is still owed, and sent later.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { NotifyRequest, Provenance, Thread } from "../threads.ts";
import type { Bridge } from "./bridge.ts";
import { CommandError } from "./errors.ts";
import type { Logger } from "./logging.ts";
import { ChildQuestions, pendingQuestions, questionNotice } from "./child-questions.ts";
import { childCardNodeId } from "./projection.ts";
import { reportBlocks, reportChild, reportHeader } from "./notices.ts";
import { awaitsChildren, exchanges, isActiveIn, isActiveRun, isActiveShell, isBusy, type Report, report, settledReport, takesSteer, type Verdict, worstVerdict } from "./reports.ts";
import { subagentThreadTitle } from "./child-title.ts";
import { messageOf } from "../host-errors.ts";

/** A refusal the tool returns to the agent as its error (no stack, no retry advice beyond the message). */
export class ThreadToolError extends Error {}

/** How deep children may nest under a thread that is not a child, and how many may be busy under one parent. */
export const MAX_DEPTH = 3;
export const MAX_ACTIVE_CHILDREN = 10;
/** A wait with no `timeoutMs` lasts until the work settles (or the call is aborted), as pi's do. */
const waitMs = (timeoutMs: number | undefined) => (timeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(1, timeoutMs));
/** A follower re-arms its wait this often; it holds the thread open meanwhile. */
const FOLLOW_CHUNK_MS = 60 * 60_000;
/** What a follower's look answers for a request whose message will not run (`#lost`); it is looked at again after
 * `LOST_RECHECK_MS` before it is dropped. One whose message waits in the inbox unshown is looked at every
 * `HELD_LOOK_MS`, so a removal that changes nothing shown is noticed. */
const LOST = Symbol("lost");
const LOST_RECHECK_MS = 1_000;
const HELD_LOOK_MS = 60_000;
/** A delivery that failed is tried again after this pause, so that a lasting failure does not spin. */
const REDELIVER_MS = 10_000;

const hash = (...parts: readonly (string | undefined)[]) => createHash("sha256").update(parts.map((part) => part ?? "").join("\0")).digest("base64url").slice(0, 20);

type PromptMode = "auto" | "followUp" | "steer" | "notify";

interface PromptInput {
	readonly threadId?: string;
	readonly new?: { readonly title?: string; readonly model?: string; readonly fork?: boolean };
	readonly message: string;
	readonly mode?: PromptMode;
	readonly wait?: boolean;
	readonly timeoutMs?: number;
	readonly notify?: boolean;
	readonly clientRequestId?: string;
}

interface PromptResult {
	readonly threadId: string;
	readonly messageId: string;
	/** The activity's report, when the prompt waited. */
	readonly report?: Report;
	/** The report will be posted into the caller's thread when the activity settles. */
	readonly notify: boolean;
}

interface ThreadSummaryRow {
	readonly threadId: string;
	readonly title: string;
	readonly parentThreadId: string | null;
	readonly status: string;
	readonly updatedAt: string;
	readonly lastMessage: string | null;
}

/** What one report message holds of its reports' text, as T3 inlines delegated results up to 16 KB in one wake
 * (`DELEGATED_RESULT_INLINE_BYTES`): ten children that settle together do not post ten long reports in one turn. The
 * first report in a message is whole (its own budget cuts it, `reports.ts`); a later one that does not fit says where to
 * read it. */
const MESSAGE_BUDGET = 16_000;

/** The reports `items` as the text of a report message, after the reports it already holds (`before`). */
const reportsText = (items: readonly { readonly child: string; readonly report: Report }[], before = ""): string => {
	let used = before.length;
	return items
		.map(({ child, report }) => {
			const header = reportHeader(report.title, child, report.verdict);
			const whole = `${header}\n${report.text}`;
			const fits = used === 0 || used + whole.length <= MESSAGE_BUDGET;
			const block = fits ? whole : `${header}\n[Not shown: this message holds enough reports already. Read it with thread_read, threadId ${child}]`;
			used += block.length + 2;
			return block;
		})
		.join("\n\n");
};


/** A report for a parent whose child waits on `requestIds`: it says so, and how each is answered. */
const asking = (entry: Report, requestIds: readonly string[]): Report =>
	requestIds.length === 0 ? entry : { ...entry, text: [entry.text, ...requestIds.map((requestId) => `[Agent ${questionNotice(entry.threadId, requestId)}]`)].join("\n"), pendingRequestIds: requestIds };

/** A report ready for its caller: the child it is from, the request it answers, and the report. */
type OutboxItem = { readonly child: string; readonly request: NotifyRequest; readonly report: Report };

export class Orchestration {
	readonly #bridge: Bridge;
	readonly #log: Logger;
	/** Reports ready for each caller, by request id, until its deliverer posts them. */
	readonly #outbox = new Map<string, Map<string, OutboxItem>>();
	/** Requests taken from an outbox and not yet dropped from their records: handed over, so not followed again. */
	readonly #inFlight = new Set<string>();
	/** The callers a deliverer is posting to, each with what wakes it from a wait (a new report, a wait ended). */
	readonly #delivering = new Map<string, AbortController>();
	/** Which callers are waiting for which children right now (`thread_wait`, a prompt's own wait), with a count. */
	readonly #awaited = new Map<string, Map<string, number>>();
	/** The threads a follower is watching, so each has one. */
	readonly #following = new Set<string>();
	/** What children ask, told to their parents. */
	readonly #questions: ChildQuestions;
	/** The waits on each thread's projection that also depend on other threads' records (`#awaitsChildren`), each woken
	 * to look again when those change. */
	readonly #nudges = new Map<string, Set<() => void>>();
	#closed = false;
	readonly #stop = new AbortController();
	#stopShells: (() => void) | undefined;
	#stopOutside: (() => void) | undefined;
	/** When a person last stopped each thread: a wait of its that the Stop ended asks for no report (`prompt`). */
	readonly #personStops = new Map<string, number>();
	/** The threads whose children a person's Stop is stopping now, so that their own Stops do not start it again. */
	readonly #stopping = new Set<string>();
	/** Requests made for a message that is still being sent: not lost for not showing yet (`#lost`). */
	readonly #sending = new Set<string>();

	constructor(bridge: Bridge, log: Logger) {
		this.#bridge = bridge;
		this.#log = log;
		this.#questions = new ChildQuestions(bridge, log, (parent, child) => (this.#awaited.get(parent)?.get(child) ?? 0) > 0);
	}

	/** Resume delivering what the last process owed: every thread whose record keeps a request to be answered. */
	start(): void {
		this.#questions.start();
		this.#stopOutside = this.#bridge.onOutside({ stopped: (threadId) => this.#personStopped(threadId), message: (message) => this.#followUp(message) });
		// A child's change can end its parent's wait for it (`#awaitsChildren`); a thread deleted takes its requests along.
		this.#stopShells = this.#bridge.onShell((item) => {
			if (item.kind === "thread.removed") for (const threadId of [...this.#nudges.keys()]) this.#nudge(threadId);
			else if (item.kind === "thread.updated") {
				const record = this.#bridge.threadRecord(item.thread.id as string);
				if (record?.spawn !== undefined && record.lineage.parentThreadId != null) this.#nudge(record.lineage.parentThreadId);
			}
		});
		void this.#bridge.loaded().then(() => {
			for (const thread of this.#bridge.threadRecords()) if ((thread.notify?.length ?? 0) > 0) this.#follow(thread.threadId);
		});
	}

	close(): void {
		this.#closed = true;
		this.#stopShells?.();
		this.#stopOutside?.();
		this.#questions.close();
		this.#stop.abort();
	}

	// ---- prompt -----------------------------------------------------------------------------------------------

	async prompt(caller: string | undefined, input: PromptInput, signal?: AbortSignal): Promise<PromptResult> {
		if ((input.threadId === undefined) === (input.new === undefined)) throw new ThreadToolError("Name a threadId to prompt, or pass new to start a thread (not both).");
		const mode = input.mode ?? "auto";
		const startedAt = Date.now();
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
		if (mode === "steer") {
			const projection = await this.#projection(threadId);
			if (!isBusy(projection)) throw new ThreadToolError(`Thread ${threadId} is not working; send without mode steer to start it.`);
		}
		this.#sending.add(commandId);
		try {
			// Asked before it is sent: a crash after the send still finds the request.
			if (notify) await this.#ask(threadId, caller!, commandId, messageId, "always");
			await this.#bridge.sendMessage({ threadId, commandId, messageId, text: input.message, mode: mode === "steer" ? "steer" : "queue", provenance });
		} catch (error) {
			// A request for a message that was never sent would keep its caller waiting for it (`awaitsChildren`).
			if (notify) await this.#withdraw(threadId, commandId);
			throw error;
		} finally {
			this.#sending.delete(commandId);
			this.#nudge(threadId);
		}
		if (!wait) return { threadId, messageId, notify };
		const answer = await this.#awaiting(caller, [threadId], signal, async () => {
			const report = await this.#waitSettled(threadId, messageId, caller, waitMs(input.timeoutMs), signal);
			if (report?.pendingRequestIds !== undefined) await this.#handed(caller, [report]);
			// The caller has the report now: a request it also made (`notify: true`) is answered.
			else if (report !== undefined && notify) await this.#answered(threadId, caller!);
			return report;
		});
		if (answer !== undefined && answer.pendingRequestIds === undefined) return { threadId, messageId, report: answer, notify: false };
		// The wait ran out (or a restart ended it), or the child asks its parent a question: the work goes on, and its
		// report is sent when it settles. Not when a person stopped the caller: that stopped the child too, with no report.
		const stoppedByPerson = caller !== undefined && signal?.aborted === true && (this.#personStops.get(caller) ?? 0) >= startedAt;
		if (!notify && caller !== undefined && !stoppedByPerson) {
			await this.#ask(threadId, caller, commandId, messageId, "settled_only");
			notify = true;
		}
		return { threadId, messageId, report: answer ?? this.#activeReport(await this.#projection(threadId), messageId, caller), notify };
	}

	#existing(threadId: string, caller: string | undefined): string {
		if (!this.#bridge.hasThread(threadId)) throw new ThreadToolError(`No thread ${threadId}.`);
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
		return isActiveShell(this.#bridge.threadShell(threadId));
	}

	// ---- waiting ----------------------------------------------------------------------------------------------

	/** Wait for several threads' current activities; a thread with none answers its latest exchange at once. A child of
	 * the caller's that asks a question ends the wait for all of them. */
	async wait(caller: string | undefined, threadIds: readonly string[], timeoutMs: number | undefined, signal?: AbortSignal): Promise<{ readonly reports: readonly Report[]; readonly verdict: Verdict }> {
		if (threadIds.length === 0) throw new ThreadToolError("Name at least one thread.");
		for (const threadId of threadIds) this.#existing(threadId, caller);
		const deadline = Date.now() + waitMs(timeoutMs);
		// A child's question ends the whole wait: the child is blocked until its parent answers, however long the others work.
		const asked = new AbortController();
		const reports = await this.#awaiting(caller, threadIds, signal, async () => {
			const all = await Promise.all(
				threadIds.map(async (threadId) => {
					const report = await this.#waitOne(threadId, caller, deadline, signal === undefined ? asked.signal : AbortSignal.any([signal, asked.signal]));
					if (report.pendingRequestIds !== undefined) asked.abort();
					// Collected here: the caller's requests this report answers are withdrawn, so it is not posted again.
					if (caller !== undefined && report.verdict !== "active") await this.#answered(threadId, caller);
					return report;
				}),
			);
			await this.#handed(caller, all);
			return all;
		});
		return { reports, verdict: worstVerdict(reports.map((entry) => entry.verdict)) };
	}

	/** One thread's report for `wait`: its current activity once it settles (or the deadline passes), or its latest. */
	async #waitOne(threadId: string, caller: string | undefined, deadline: number, signal: AbortSignal | undefined): Promise<Report> {
		const before = await this.#projection(threadId);
		const runs = before.runs.toSorted((left, right) => left.ordinal - right.ordinal);
		const from = runs.find(isActiveIn(before)) ?? runs.at(-1);
		const options = { ...(caller === undefined ? {} : { reader: caller }), label: (id: string) => this.#label(id) };
		if ((!isBusy(before) && !this.#awaitsChildren(threadId)) || from === undefined) return report(before, { ...options, fromRunId: from?.id as string | undefined });
		const current = (projection: OrchestrationV2ThreadProjection, asks: readonly string[]) => asking(report(projection, { ...options, fromRunId: from.id as string, awaitsChildren: this.#awaitsChildren(threadId) }), asks);
		const combined = this.#signal(signal);
		const settled = await this
			.#watch(
				threadId,
				(projection) => {
					const asks = this.#asks(caller, threadId, projection);
					return asks.length === 0 && (isBusy(projection) || this.#awaitsChildren(threadId)) ? undefined : current(projection, asks);
				},
				Math.max(1, deadline - Date.now()),
				combined,
			)
			.catch((error: unknown) => {
				if (combined.aborted) return undefined;
				throw error;
			});
		if (settled !== undefined) return settled;
		const after = await this.#projection(threadId);
		return current(after, this.#asks(caller, threadId, after));
	}

	/** The questions `threadId` waits on that are `caller`'s to answer: those of a thread it started. */
	#asks(caller: string | undefined, threadId: string, projection: OrchestrationV2ThreadProjection): string[] {
		const record = this.#bridge.threadRecord(threadId);
		return caller !== undefined && record?.spawn !== undefined && record.lineage.parentThreadId === caller ? pendingQuestions(projection) : [];
	}

	/** The questions a wait answered with are in the caller's hands while this turn of it runs: it is not told of them
	 * again unless the turn ends with them open. */
	async #handed(caller: string | undefined, reports: readonly Report[]): Promise<void> {
		const asked = reports.filter((entry) => entry.pendingRequestIds !== undefined);
		if (caller === undefined || asked.length === 0) return;
		const runId = (await this.#projection(caller)).runs.find(isActiveRun)?.id as string | undefined;
		for (const entry of asked) this.#questions.handed(caller, entry.threadId, entry.pendingRequestIds!, runId);
	}

	/** Take `child`'s reports out of the report messages still waiting in `caller`'s queue (a steer not placed yet, or a
	 * queued follow-up); cancel a message left with none. One placed meanwhile stays, as T3 leaves a delivered notice. */
	async #retract(caller: string, child: string): Promise<void> {
		if (this.#bridge.threadRecord(caller) === undefined) return;
		for (const message of await this.#waitingReports(caller)) {
			const blocks = reportBlocks(message.text);
			const kept = blocks.filter((block) => reportChild(block) !== child);
			if (kept.length === blocks.length) continue;
			try {
				if (kept.length === 0) await this.#bridge.cancelQueued(caller, String(message.submissionId));
				else await this.#bridge.editQueued(caller, String(message.submissionId), kept.join("\n\n"));
				this.#log.info("thread report taken back", { from: child, to: caller, emptied: kept.length === 0 });
			} catch {
				// Placed meanwhile: the caller has it in its turn.
			}
		}
	}

	/** Run `work`, a wait of `caller` for `threadIds`: meanwhile their reports to it are held, as it is collecting them. */
	async #awaiting<T>(caller: string | undefined, threadIds: readonly string[], signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
		if (caller === undefined) return work();
		const children = this.#awaited.get(caller) ?? new Map<string, number>();
		this.#awaited.set(caller, children);
		for (const threadId of threadIds) children.set(threadId, (children.get(threadId) ?? 0) + 1);
		try {
			// A loop of waits that a child's question keeps ending turns slowly (`ChildQuestions.pause`). The caller waits
			// already: a question asked meanwhile is the wait's to answer with. A Stop ends the pause.
			const pause = this.#questions.pause(caller, threadIds);
			if (pause > 0) await sleep(pause, undefined, { signal: this.#signal(signal), ref: false }).catch(() => {});
			return await work();
		} finally {
			for (const threadId of threadIds) {
				const count = (children.get(threadId) ?? 1) - 1;
				if (count === 0) children.delete(threadId);
				else children.set(threadId, count);
			}
			if (children.size === 0) this.#awaited.delete(caller);
			// What it did not collect (a wait that ran out) goes out now, and so does a question the wait did not answer with.
			this.#deliverTo(caller);
			for (const threadId of threadIds) this.#questions.waitEnded(threadId);
		}
	}

	/** Withdraw `caller`'s requests on `threadId` whose activity has settled: the caller collected that report itself.
	 * A report of it already posted and still waiting in the caller's queue is taken back too. */
	async #answered(threadId: string, caller: string): Promise<void> {
		await this.#retract(caller, threadId);
		const pending = (this.#bridge.threadRecord(threadId)?.notify ?? []).filter((request) => request.threadId === caller);
		if (pending.length === 0) return;
		const projection = await this.#projection(threadId);
		const answered = new Set(pending.filter((request) => settledReport(projection, request.messageId, this.#reportOptions(threadId, request.messageId, caller)) !== undefined).map((request) => request.id));
		if (answered.size === 0) return;
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			record.notify = (record.notify ?? []).filter((request) => !answered.has(request.id));
		});
		this.#owedChanged(caller);
	}

	/** The report of the activity `messageId` started, once it settled; or, for the thread's parent, the activity so far
	 * with the questions the thread waits on, as soon as it asks any. */
	async #waitSettled(threadId: string, messageId: string, reader: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Report | undefined> {
		try {
			return await this.#watch(
				threadId,
				(projection) => {
					const settled = settledReport(projection, messageId, this.#reportOptions(threadId, messageId, reader));
					if (settled !== undefined) return settled;
					const asks = this.#asks(reader, threadId, projection);
					return asks.length === 0 ? undefined : asking(this.#activeReport(projection, messageId, reader), asks);
				},
				timeoutMs,
				this.#signal(signal),
			);
		} catch (error) {
			if ((error as Error).name === "AbortError" || this.#signal(signal)?.aborted === true) return undefined;
			throw error;
		}
	}

	#activeReport(projection: OrchestrationV2ThreadProjection, messageId: string, reader: string | undefined): Report {
		const runId = projection.messages.find((message) => (message.id as string) === messageId)?.runId;
		return report(projection, { fromRunId: runId == null ? undefined : (runId as string), ...this.#reportOptions(projection.thread.id as string, messageId, reader) });
	}

	/** A report of `threadId` for the thread that sent `messageId` (`reader`, when it is a thread). */
	#reportOptions(threadId: string, messageId: string, reader: string | undefined) {
		return { own: messageId, ...(reader === undefined ? {} : { reader }), label: (id: string) => this.#label(id), awaitsChildren: this.#awaitsChildren(threadId) };
	}

	/** Does `threadId` wait for the report of a child it started? Then it has not settled (`awaitsChildren`). */
	#awaitsChildren(threadId: string): boolean {
		return awaitsChildren(this.#bridge.threadRecords(), threadId);
	}

	/** `Bridge.waitFor`, also woken when something it reads besides the thread's projection changes (`#nudge`): the
	 * requests of the thread's children, which its settling waits for. */
	async #watch<T>(threadId: string, read: (projection: OrchestrationV2ThreadProjection) => T | undefined, timeoutMs: number, signal: AbortSignal): Promise<T | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const nudged = new AbortController();
			const wake = () => nudged.abort();
			const waiting = this.#nudges.get(threadId) ?? new Set();
			this.#nudges.set(threadId, waiting);
			waiting.add(wake);
			try {
				return await this.#bridge.waitFor(threadId, read, Math.max(1, deadline - Date.now()), AbortSignal.any([signal, nudged.signal]));
			} catch (error) {
				if (!nudged.signal.aborted || signal.aborted) throw error;
			} finally {
				waiting.delete(wake);
				if (waiting.size === 0) this.#nudges.delete(threadId);
			}
		}
	}

	/** Wake the waits on `threadId`'s projection to look again (`#watch`). */
	#nudge(threadId: string): void {
		for (const wake of this.#nudges.get(threadId) ?? []) wake();
	}

	/** A request owed to `threadId` was taken off its child's record: its waits look again, and so does its parent's card
	 * of it, which shows it working while it waits for its children (`Bridge.refreshCard`). */
	#owedChanged(threadId: string): void {
		this.#nudge(threadId);
		this.#bridge.refreshCard(threadId);
	}

	/**
	 * Will the message a request waits for never run? The thread is idle, the message is not in it and is not still being
	 * sent: someone removed it from the queue, or it was never sent (the host stopped first). Such a request would never
	 * be answered, and its caller would wait for it for good (`awaitsChildren`).
	 */
	#lost(projection: OrchestrationV2ThreadProjection, request: NotifyRequest): boolean {
		return !isBusy(projection) && !this.#sending.has(request.id) && !projection.messages.some((message) => (message.id as string) === request.messageId);
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
		const found = await this.#bridge.searchThreads(query, Math.min(100, Math.max(1, limit)), true);
		return found.matches.map((match) => ({ threadId: match.threadId as string, title: this.#bridge.threadRecord(match.threadId as string)?.title ?? "", snippet: match.snippet, at: match.messageCreatedAt }));
	}

	list(caller: string | undefined, filter: { readonly parent?: string; readonly status?: "active" | "idle"; readonly projectId?: string; readonly limit?: number }): ThreadSummaryRow[] {
		const parent = filter.parent === "self" ? caller : filter.parent;
		const rows: ThreadSummaryRow[] = [];
		for (const thread of [...this.#bridge.threadRecords()].reverse()) {
			// Side chats live inside their main thread's view, never in lists (T3's `isListedThreadLineage`).
			if (thread.lineage.sideChat === true) continue;
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
		for (const id of silenced) this.#owedChanged(id);
		const stopped: string[] = [];
		for (const id of subtree) {
			if (!this.#isActive(id)) continue;
			await this.#bridge.interrupt(id, { by: "agent" });
			stopped.push(id);
		}
		this.#log.info("threads stopped", { by: caller, stopped });
		return { stopped };
	}

	/**
	 * A person stopped `threadId`: stop the work of the threads it started too, and of theirs, as T3's Stop stops a
	 * thread's delegated tasks (`ThreadManagementService.stopDelegatedTasks`). No report of it reaches the stopped thread
	 * or goes between them, and reports of theirs still waiting in a queue are taken back: a stopped thread woken by a
	 * report would start again.
	 */
	#personStopped(threadId: string): void {
		this.#personStops.set(threadId, Date.now());
		if (this.#stopping.has(threadId)) return;
		const subtree = this.#descendants(threadId);
		if (subtree.length === 0) return;
		for (const id of subtree) this.#stopping.add(id);
		void (async () => {
			try {
				const silenced = new Set([threadId, ...subtree]);
				for (const id of subtree) {
					if (!(this.#bridge.threadRecord(id)?.notify ?? []).some((request) => silenced.has(request.threadId))) continue;
					await this.#bridge.updateThreadRecord(id, (record) => {
						record.notify = (record.notify ?? []).filter((request) => !silenced.has(request.threadId));
					});
				}
				for (const id of silenced) this.#owedChanged(id);
				for (const id of subtree) {
					const parent = this.#bridge.threadRecord(id)?.lineage.parentThreadId;
					if (parent != null) await this.#retract(parent, id);
				}
				const stopped: string[] = [];
				for (const id of subtree) {
					if (!this.#isActive(id)) continue;
					await this.#bridge.interrupt(id);
					stopped.push(id);
				}
				this.#log.info("a person's stop stopped the threads it started", { threadId, stopped });
			} catch (error) {
				this.#log.warn("a person's stop could not stop the threads it started", { threadId, error: messageOf(error) });
			} finally {
				for (const id of subtree) this.#stopping.delete(id);
			}
		})();
	}

	/** The threads `threadId` started, and theirs, parents first. */
	#descendants(threadId: string): string[] {
		const found: string[] = [];
		const collect = (id: string) => {
			for (const child of this.#bridge.threadRecords()) {
				if (child.spawn === undefined || child.lineage.parentThreadId !== id || child.threadId === threadId || found.includes(child.threadId)) continue;
				found.push(child.threadId);
				collect(child.threadId);
			}
		};
		collect(threadId);
		return found;
	}

	/**
	 * A message sent to a child from outside the thread tools (`Bridge.sendFromOutside`): by a person, a client, or its
	 * parent through T3's tools. Its parent hears back when the work it starts settles, as T3 makes such a message to a
	 * delegated task's thread a new task that wakes the parent. Not a message from another thread (that thread asked
	 * for it), not a Resume or a command, not while the parent waits for the child (it collects the report), and not
	 * when a report the parent is owed already covers it (the message joins that work). Answers what to do once the
	 * send has ended: take the request back if it failed.
	 */
	async #followUp(message: { readonly threadId: string; readonly messageId: string; readonly text: string; readonly provenance: Provenance; readonly writesMessage: boolean }): Promise<((sent: boolean) => Promise<void>) | undefined> {
		// A report waits for the run its message starts: a Resume writes no message, and a command (`/compact`, `/context`)
		// may start no run, so either would keep the parent waiting for good.
		if (!message.writesMessage || message.text.trimStart().startsWith("/")) return undefined;
		const record = this.#bridge.threadRecord(message.threadId);
		const parent = record?.spawn === undefined ? undefined : record.lineage.parentThreadId;
		if (parent == null || !this.#bridge.hasThread(parent)) return undefined;
		const sender = message.provenance.senderThreadId;
		if (message.provenance.createdBy !== "user" && sender !== undefined && sender !== parent) return undefined;
		if ((this.#awaited.get(parent)?.get(message.threadId) ?? 0) > 0) return undefined;
		if ((record!.notify ?? []).some((request) => request.threadId === parent)) return undefined;
		const id = `follow-up-${hash(parent, message.messageId)}`;
		this.#sending.add(id);
		try {
			await this.#ask(message.threadId, parent, id, message.messageId, "always");
		} catch (error) {
			this.#sending.delete(id);
			throw error;
		}
		this.#log.info("a message to a child asks its parent to hear back", { child: message.threadId, parent });
		return async (sent) => {
			this.#sending.delete(id);
			// Sent: a follower that saw no message yet looks again (`#lost`).
			if (sent) this.#nudge(message.threadId);
			else await this.#withdraw(message.threadId, id);
		};
	}

	/** Take back a request made for a message that was not sent. */
	async #withdraw(threadId: string, id: string): Promise<void> {
		const request = (this.#bridge.threadRecord(threadId)?.notify ?? []).find((candidate) => candidate.id === id);
		if (request === undefined) return;
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			record.notify = (record.notify ?? []).filter((candidate) => candidate.id !== id);
		});
		this.#owedChanged(request.threadId);
	}

	// ---- answering --------------------------------------------------------------------------------------------

	/** Ask for `threadId`'s report on `messageId` to be posted to `caller`. `settled_only` (a wait that ran out) holds it
	 * until the caller's turn that asked has ended, so its run is kept. */
	async #ask(threadId: string, caller: string, id: string, messageId: string, wake: "always" | "settled_only"): Promise<void> {
		const runId = wake === "settled_only" ? ((await this.#projection(caller)).runs.find(isActiveRun)?.id as string | undefined) : undefined;
		await this.#bridge.updateThreadRecord(threadId, (record) => {
			const notify = record.notify ?? [];
			if (notify.some((request) => request.id === id)) return false;
			record.notify = [...notify, { id, threadId: caller, messageId, createdAt: Date.now(), wake, ...(runId === undefined ? {} : { runId }) } satisfies NotifyRequest];
		});
		// The caller now waits for this child: its parent's card of it shows it working (`Bridge.refreshCard`).
		this.#bridge.refreshCard(caller);
		this.#follow(threadId);
	}

	/** Watch a thread's requests: as each one's activity settles, hand its report to the caller's outbox. One follower
	 * per thread, until every request it holds is handed over. */
	#follow(threadId: string): void {
		if (this.#closed || this.#following.has(threadId)) return;
		this.#following.add(threadId);
		// The requests whose message waits in the inbox without showing: their next look waits for a change.
		const held = new Set<string>();
		void (async () => {
			try {
				while (!this.#closed) {
					const handed = (request: NotifyRequest) => this.#inFlight.has(request.id) || this.#outbox.get(request.threadId)?.has(request.id) === true;
					const request = (this.#bridge.threadRecord(threadId)?.notify ?? []).find((candidate) => !handed(candidate));
					if (request === undefined) return;
					const inInbox = held.has(request.id);
					const ready = await this
						.#watch(threadId, (projection) => settledReport(projection, request.messageId, this.#reportOptions(threadId, request.messageId, request.threadId)) ?? (!inInbox && this.#lost(projection, request) ? LOST : undefined), inInbox ? HELD_LOOK_MS : FOLLOW_CHUNK_MS, this.#stop.signal)
						.catch((error: unknown) => {
							if (this.#closed) return undefined;
							throw error;
						});
					held.delete(request.id);
					if (ready === undefined) continue;
					if (ready === LOST) {
						// Looked at again a moment later, so a view that has not caught up with the send yet is not taken for
						// the message's absence. Waiting in the inbox still (not shown yet): look again once the thread changes.
						await sleep(LOST_RECHECK_MS, undefined, { signal: this.#stop.signal, ref: false }).catch(() => {});
						if (this.#closed) return;
						if (!this.#lost(await this.#projection(threadId), request)) continue;
						if ((await this.#bridge.waitingMessages(threadId)).some((message) => message.messageId === request.messageId)) held.add(request.id);
						else {
							this.#log.info("a report was asked of a message that will not run; the request is dropped", { threadId, caller: request.threadId });
							await this.#withdraw(threadId, request.id);
						}
						continue;
					}
					const box = this.#outbox.get(request.threadId) ?? new Map();
					this.#outbox.set(request.threadId, box);
					box.set(request.id, { child: threadId, request, report: ready });
					this.#deliverTo(request.threadId);
				}
			} catch (error) {
				if (!this.#closed) this.#log.warn("thread notification follower stopped", { threadId, error: messageOf(error) });
			} finally {
				this.#following.delete(threadId);
			}
		})();
	}

	/** Post a caller's ready reports as they may go, until its outbox is empty. One deliverer per caller; a new report or
	 * a wait that ended wakes it when it is holding some back. */
	#deliverTo(caller: string): void {
		if (this.#closed) return;
		const running = this.#delivering.get(caller);
		if (running !== undefined) return void running.abort();
		this.#delivering.set(caller, new AbortController());
		void (async () => {
			try {
				while (!this.#closed) {
					const box = this.#outbox.get(caller);
					if (box === undefined || box.size === 0) return;
					const callerGone = !this.#bridge.hasThread(caller);
					// Read before the outbox is: a report handed over meanwhile is then seen with the projection it is judged on.
					const projection = callerGone ? undefined : await this.#projection(caller);
					// As the records hold them now: withdrawn ones are gone, and a message written before a crash is kept.
					const owed: OutboxItem[] = [];
					for (const item of [...box.values()]) {
						const request = (this.#bridge.threadRecord(item.child)?.notify ?? []).find((candidate) => candidate.id === item.request.id);
						if (request === undefined) box.delete(item.request.id);
						else owed.push({ ...item, request });
					}
					if (owed.length === 0) continue;
					if (projection === undefined) {
						// The caller is gone: nobody to answer.
						for (const item of owed) box.delete(item.request.id);
						await this.#drop(owed);
						continue;
					}
					const ready = owed.filter((item) => this.#mayDeliver(caller, item, projection) && this.#batchComplete(caller, item, box, projection));
					if (ready.length === 0) {
						// Held: until the turn that asked ends, a wait ends, or another report arrives.
						const wake = new AbortController();
						this.#delivering.set(caller, wake);
						await this.#bridge
							.waitFor(caller, (next) => (owed.some((item) => this.#mayDeliver(caller, item, next) && this.#batchComplete(caller, item, box, next)) ? true : undefined), FOLLOW_CHUNK_MS, AbortSignal.any([this.#stop.signal, wake.signal]))
							.catch((error: unknown) => {
								if (this.#closed || wake.signal.aborted) return undefined;
								throw error;
							});
						continue;
					}
					for (const item of ready) {
						box.delete(item.request.id);
						this.#inFlight.add(item.request.id);
					}
					try {
						await this.#deliver(caller, ready, projection);
					} finally {
						for (const item of ready) this.#inFlight.delete(item.request.id);
					}
				}
			} catch (error) {
				if (!this.#closed) {
					this.#log.warn("thread report delivery stopped", { caller, error: messageOf(error) });
					// The requests are still on the children's records, but their followers counted them as handed over and
					// ended: follow those children again, which hands the requests over once more.
					setTimeout(() => {
						for (const thread of this.#bridge.threadRecords()) if ((thread.notify ?? []).some((request) => request.threadId === caller)) this.#follow(thread.threadId);
					}, REDELIVER_MS).unref();
				}
			} finally {
				this.#delivering.delete(caller);
				if ((this.#outbox.get(caller)?.size ?? 0) === 0) this.#outbox.delete(caller);
				// A report handed over after the last look waits for the next deliverer.
				else if (!this.#closed) this.#deliverTo(caller);
			}
		})();
	}

	/** A report a stopped process put in a message it had not sent yet goes when every report it put there is back. */
	#batchComplete(caller: string, item: OutboxItem, box: ReadonlyMap<string, OutboxItem>, projection: OrchestrationV2ThreadProjection): boolean {
		const batch = item.request.batch;
		if (batch === undefined || projection.messages.some((message) => (message.id as string) === batch)) return true;
		return this.#bridge.threadRecords().every((thread) => (thread.notify ?? []).every((request) => request.threadId !== caller || request.batch !== batch || box.has(request.id)));
	}

	/** Whether a report may go to `caller` now: not while it waits for that child (it is collecting it), and a
	 * `settled_only` one not while the turn that asked is still running. */
	#mayDeliver(caller: string, item: OutboxItem, projection: OrchestrationV2ThreadProjection): boolean {
		if ((this.#awaited.get(caller)?.get(item.child) ?? 0) > 0) return false;
		if (item.request.wake !== "settled_only" || item.request.runId === undefined) return true;
		const run = projection.runs.find((candidate) => (candidate.id as string) === item.request.runId);
		return run === undefined || !isActiveIn(projection)(run);
	}

	/** Post reports into the caller's thread: appended to a report message still waiting in its queue, or as a new
	 * message, steered into its running turn when every report may wake it and the turn takes a steer, else queued
	 * (a new turn when it is idle). The message's id is written on the requests first; a request whose message already
	 * holds its report (sent before a crash) is only dropped. */
	async #deliver(caller: string, items: readonly OutboxItem[], projection: OrchestrationV2ThreadProjection): Promise<void> {
		const ordered = items.toSorted((left, right) => left.request.createdAt - right.request.createdAt);
		const sent: OutboxItem[] = [];
		const fresh: OutboxItem[] = [];
		// Reports a stopped process put in a message it never sent: that message, sent now under its id.
		const unsent = new Map<string, OutboxItem[]>();
		for (const item of ordered) {
			const batch = item.request.batch;
			const message = batch === undefined ? undefined : projection.messages.find((candidate) => (candidate.id as string) === batch);
			// Only a message that holds the report has delivered it.
			if (message !== undefined && message.text.includes(`(${item.child})`)) sent.push(item);
			else if (batch !== undefined && message === undefined) unsent.set(batch, [...(unsent.get(batch) ?? []), item]);
			else fresh.push(item);
		}
		for (const [messageId, members] of unsent) await this.#send(caller, members, messageId, projection);
		if (fresh.length > 0) {
			// T3 adds a sibling to its queued completion notice; ours is the newest report message still queued.
			const pending = (await this.#waitingReports(caller)).at(-1);
			let delivered = false;
			if (pending !== undefined) {
				await this.#mark(fresh, pending.messageId);
				this.#keepOwed(fresh);
				delivered =
					fresh.length === 0 ||
					(await this.#bridge
						.editQueued(caller, String(pending.submissionId), `${pending.text}\n\n${reportsText(fresh, pending.text)}`)
						.then(() => true)
						.catch(() => false));
			}
			if (!delivered) {
				const messageId = `n-${hash(...fresh.map((item) => item.request.id).toSorted())}`;
				await this.#mark(fresh, messageId);
				this.#keepOwed(fresh);
				if (fresh.length > 0) await this.#send(caller, fresh, messageId, projection);
			} else this.#log.info("thread reports delivered", { to: caller, from: fresh.map((item) => item.child), joined: true });
		}
		await this.#drop([...sent, ...fresh, ...[...unsent.values()].flat()]);
	}

	/** Send reports as a new message: steered into the caller's running turn when every one may wake it and the turn
	 * takes a steer, else queued (a new turn when it is idle). The command id is the message's, so a resend is a no-op. */
	async #send(caller: string, items: readonly OutboxItem[], messageId: string, projection: OrchestrationV2ThreadProjection): Promise<void> {
		const text = reportsText(items);
		// T3 steers a notice only for tasks that wake their parent while it works, and never into a compaction.
		const steer = takesSteer(projection) && items.every((item) => item.request.wake !== "settled_only");
		const single = items.length === 1 ? items[0]!.child : undefined;
		await this.#bridge.sendMessage({
			threadId: caller,
			commandId: `notify-${messageId}`,
			messageId,
			text,
			mode: steer ? "steer" : "queue",
			provenance: { createdBy: "agent", creationSource: "server", ...(single === undefined ? {} : { senderThreadId: single }) },
			automatic: true,
		});
		this.#log.info("thread reports delivered", { to: caller, from: items.map((item) => item.child), verdicts: items.map((item) => item.report.verdict), steer });
	}

	/** The report messages still waiting in `caller`'s inbox, not placed yet: a steer its running turn has not read, or
	 * a queued message. */
	async #waitingReports(caller: string) {
		return (await this.#bridge.waitingMessages(caller)).filter((message) => message.messageId.startsWith("n-"));
	}

	/** Leave out of `items` the requests withdrawn while they were being delivered (a person's Stop, a wait that
	 * collected the report): their reports are not sent. */
	#keepOwed(items: OutboxItem[]): void {
		const owed = items.filter((item) => (this.#bridge.threadRecord(item.child)?.notify ?? []).some((request) => request.id === item.request.id));
		items.splice(0, items.length, ...owed);
	}

	/** Write the message a report goes into on its request, before it is sent. */
	async #mark(items: readonly OutboxItem[], messageId: string): Promise<void> {
		for (const item of items) {
			await this.#bridge.updateThreadRecord(item.child, (record) => {
				const request = (record.notify ?? []).find((candidate) => candidate.id === item.request.id);
				if (request === undefined || request.batch === messageId) return false;
				request.batch = messageId;
			});
		}
	}

	/** Drop delivered (or unanswerable) requests from their records. */
	async #drop(items: readonly OutboxItem[]): Promise<void> {
		for (const { child, request } of items) {
			await this.#bridge.updateThreadRecord(child, (record) => {
				record.notify = (record.notify ?? []).filter((candidate) => candidate.id !== request.id);
			});
		}
		for (const caller of new Set(items.map((item) => item.request.threadId))) this.#owedChanged(caller);
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
