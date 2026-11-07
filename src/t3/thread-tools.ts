// The thread tools, for an agent that runs in the same process as the bridge (`orchestration.ts`): `thread_prompt`,
// `thread_wait`, `thread_read`, `thread_search`, `thread_list`, `thread_cancel`. A call acts as the thread its own
// conversation is the head of. Writes are safe to replay after a crash: a call without a `clientRequestId` uses its own
// call id, so a replay is answered with what the first run did.
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "typebox";
import type { Bridge } from "./bridge.ts";
import { DEFAULT_WAIT_MS, MAX_ACTIVE_CHILDREN, MAX_DEPTH, type Orchestration, ThreadToolError } from "./orchestration.ts";
import type { Report } from "./reports.ts";

type Callers = readonly ("model" | "tools")[];
type Api = { readonly conversationId: number; readonly taskId: unknown; readonly callId: string; readonly signal?: AbortSignal };

const PROMPT = `Prompt a thread and, by default, wait for its answer. Start a new thread with "new" (a child of yours: it nests under your thread, and you can prompt it again later), or name an existing "threadId" to follow up. The answer is the activity's report: every message that entered it, how many tool calls it took, and the final response; "verdict" says how it ended (completed, interrupted, failed, or active when the wait ran out). With wait: false it returns at once, and the report is posted into your thread when the work settles (starting your next turn if you are idle): fan out several, end your turn, and the reports arrive. A wait that runs out also sends the report later. "mode": auto (start, or queue behind running work), followUp (queue), steer (redirect running work), notify (add the message to its context without starting work). A new thread starts with only your message unless "fork" (then it has your history up to your last finished turn). Threads nest at most ${MAX_DEPTH} deep, and at most ${MAX_ACTIVE_CHILDREN} of your children work at once.`;
const WAIT = "Wait until threads settle and get their reports, with the worst verdict among them. A thread that is not working answers with its latest exchange at once. Waiting never affects the threads.";
const READ = "Read a thread's exchanges (the prompt, the messages that entered it, its tool-call count and answer), newest last; your own thread when no threadId is named, back past any compaction. last: how many (default 1); before: an exchange number, to page back. Reading never starts anything.";
const SEARCH = "Search every thread's messages (full text). Returns threads with a matching snippet; read one with thread_read.";
const LIST = 'List threads, newest first. parent: "self" lists your children; status filters active or idle ones.';
const CANCEL = "Stop a thread's work, its queued messages and (by default) its children's work. You will not get reports for threads you stopped.";

const prompt = Type.Object({
	threadId: Type.Optional(Type.String({ description: "The thread to prompt. Omit with new." })),
	new: Type.Optional(
		Type.Object({
			title: Type.Optional(Type.String()),
			model: Type.Optional(Type.String({ description: "provider/model; default: yours" })),
			fork: Type.Optional(Type.Boolean({ description: "Start with your history instead of only the message" })),
		}),
	),
	message: Type.String(),
	mode: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("followUp"), Type.Literal("steer"), Type.Literal("notify")])),
	wait: Type.Optional(Type.Boolean({ description: "Default true" })),
	timeoutMs: Type.Optional(Type.Number({ description: `Wait at most this long (default ${DEFAULT_WAIT_MS}); the work goes on, and its report is sent later` })),
	notify: Type.Optional(Type.Boolean({ description: "Post the report into your thread when the work settles. Default: when not waiting" })),
	clientRequestId: Type.Optional(Type.String()),
});
const wait = Type.Object({ threadIds: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }), timeoutMs: Type.Optional(Type.Number()) });
const read = Type.Object({ threadId: Type.Optional(Type.String()), last: Type.Optional(Type.Number()), before: Type.Optional(Type.Number()) });
const search = Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) });
const list = Type.Object({
	parent: Type.Optional(Type.String({ description: 'A thread id, or "self"' })),
	status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("idle")])),
	projectId: Type.Optional(Type.String()),
	limit: Type.Optional(Type.Number()),
});
const cancel = Type.Object({ threadId: Type.String(), cascade: Type.Optional(Type.Boolean({ description: "Default true" })) });

const reportJson = (entry: Report) => ({ threadId: entry.threadId, title: entry.title, runId: entry.runId, verdict: entry.verdict, toolCalls: entry.toolCalls, truncated: entry.truncated, report: entry.text });

/** The thread tools, as one extension. `callers`: who may call them (default: the model and scripts). */
export function threadToolsExtension(bridge: Bridge, orchestration: Orchestration, options: { readonly callers?: Callers } = {}): Extension {
	const callers = options.callers ?? ["model", "tools"];
	const tool = <I>(name: string, description: string, parameters: TSchema, writes: boolean, run: (caller: string | undefined, input: I, api: Api) => Promise<unknown> | unknown): ToolRegistration =>
		({
			name,
			description,
			parameters,
			callers,
			replay: "safe",
			async execute(args: unknown, api: Api) {
				const answer = (value: unknown, isError = false) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
				try {
					const input = { ...(args as Record<string, unknown>) };
					if (writes && input.clientRequestId === undefined) input.clientRequestId = `call:${String(api.taskId)}:${api.callId}`;
					const caller = await bridge.threadIdForConversation(api.conversationId);
					return answer(await run(caller, input as I, api));
				} catch (error) {
					if (error instanceof ThreadToolError) return answer({ error: error.message }, true);
					throw error;
				}
			},
		}) as unknown as ToolRegistration;
	const tools = [
		tool<Parameters<Orchestration["prompt"]>[1]>("thread_prompt", PROMPT, prompt, true, async (caller, input, api) => {
			const result = await orchestration.prompt(caller, input, api.signal);
			return { threadId: result.threadId, notify: result.notify, ...(result.report === undefined ? {} : reportJson(result.report)) };
		}),
		tool<{ threadIds: string[]; timeoutMs?: number }>("thread_wait", WAIT, wait, false, async (caller, input, api) => {
			const result = await orchestration.wait(caller, input.threadIds, input.timeoutMs, api.signal);
			return { verdict: result.verdict, reports: result.reports.map(reportJson) };
		}),
		tool<{ threadId?: string; last?: number; before?: number }>("thread_read", READ, read, false, (caller, input) => orchestration.read(caller, input)),
		tool<{ query: string; limit?: number }>("thread_search", SEARCH, search, false, async (_caller, input) => ({ matches: await orchestration.search(input.query, input.limit) })),
		tool<{ parent?: string; status?: "active" | "idle"; projectId?: string; limit?: number }>("thread_list", LIST, list, false, (caller, input) => ({ threads: orchestration.list(caller, input) })),
		tool<{ threadId: string; cascade?: boolean }>("thread_cancel", CANCEL, cancel, true, (caller, input) => orchestration.cancel(caller, input.threadId, input.cascade ?? true)),
	];
	return defineExtension({ name: "thread-tools", tools });
}
