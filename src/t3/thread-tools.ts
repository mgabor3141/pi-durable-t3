// The thread tools, for an agent that runs in the same process as the bridge (`orchestration.ts`): `thread_prompt`,
// `thread_wait`, `thread_read`, `thread_search`, `thread_list`, `thread_cancel`. A call acts as the thread its own
// conversation is the head of. Writes are safe to replay after a crash: a call without a `clientRequestId` uses its own
// call id, so a replay is answered with what the first run did.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { Context } from "@earendil-works/chord";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import { OrchestratorToolkit, ProjectToolkit, ThreadToolkit } from "./mcp-toolkit.ts";

/** What T3's descriptions leave unsaid about this host, added to the agent's tools. */
const PROJECT_CREATE_NOTE = "Here a project needs `workspaceRoot` (no git repositories are made), and has only a title and a folder.";
const QUEUE_NOTE = "Here `reorder` is refused: the queue keeps the order messages were sent in.";
const PROJECT_UPDATE_NOTE =
	"Here a project has only a title and a folder. A new `workspaceRoot` points the project at another folder: no files move, and the project's existing threads keep running in the folder they started in.";
import { advertisedJsonSchema } from "./t3-server.ts";
import type { ThreadOps } from "./thread-ops.ts";
import type { Bridge } from "./bridge.ts";
import { MAX_ACTIVE_CHILDREN, MAX_DEPTH, type Orchestration, ThreadToolError } from "./orchestration.ts";
import type { Report } from "./reports.ts";
import { arr, bool, num, opt, str, type Schema as ToolSchema, union } from "@earendil-works/pi-schema";
import { literal, object } from "./schema.ts";

type Callers = readonly ("model" | "tools")[];
type Api = { readonly conversationId: number; readonly taskId: unknown; readonly callId: string };

const PROMPT = `Prompt a thread and, by default, wait for its answer. Start a new thread with "new" (a child of yours: it nests under your thread, and you can prompt it again later), or name an existing "threadId" to follow up. The answer is the activity's report: every message that entered it, how many tool calls it took, and the final response; "verdict" says how it ended (completed, interrupted, failed, or active when the wait ran out). With wait: false it returns at once, and when the work settles its report is posted into your thread: into your current turn if you are working, or starting your next turn if you are idle. Reports that settle before you have read the first join it, in one message: fan out several, end your turn, and they arrive together. A report you collect with thread_wait or thread_read is not posted, or is taken back if it is still waiting for you. A wait that runs out also sends the report later. "mode": auto (start, or queue behind running work), followUp (queue), steer (redirect running work), notify (add the message to its context without starting work). A new thread starts with only your message unless "fork" (then it has your history up to your last finished turn). Threads nest at most ${MAX_DEPTH} deep, and at most ${MAX_ACTIVE_CHILDREN} of your children work at once.`;
const WAIT = "Wait until threads settle and get their reports, with the worst verdict among them. A thread that is not working answers with its latest exchange at once. Waiting never affects the threads.";
const READ = "Read a thread's exchanges (the prompt, the messages that entered it, its tool-call count and answer), newest last; your own thread when no threadId is named, back past any compaction. last: how many (default 1); before: an exchange number, to page back. Reading never starts anything.";
const SEARCH = "Search every thread's messages (full text). Returns threads with a matching snippet; read one with thread_read.";
const LIST = 'List threads, newest first. parent: "self" lists your children; status filters active or idle ones.';
const CANCEL = "Stop a thread's work, its queued messages and (by default) its children's work. You will not get reports for threads you stopped.";

const prompt = object({
	threadId: opt(str({ description: "The thread to prompt. Omit with new." })),
	new: opt(
		object({
			title: opt(str()),
			model: opt(str({ description: "provider/model; default: yours" })),
			fork: opt(bool({ description: "Start with your history instead of only the message" })),
		}),
	),
	message: str(),
	mode: opt(union([literal("auto"), literal("followUp"), literal("steer"), literal("notify")])),
	wait: opt(bool({ description: "Default true" })),
	timeoutMs: opt(num({ description: "Wait at most this long (default: until it settles); the work goes on, and its report is sent later" })),
	notify: opt(bool({ description: "Post the report into your thread when the work settles. Default: when not waiting" })),
	clientRequestId: opt(str()),
});
const wait = object({ threadIds: arr(str(), { minItems: 1, maxItems: 20 }), timeoutMs: opt(num({ description: "Default: until they settle" })) });
const read = object({ threadId: opt(str()), last: opt(num()), before: opt(num()) });
const search = object({ query: str(), limit: opt(num()) });
const list = object({
	parent: opt(str({ description: 'A thread id, or "self"' })),
	status: opt(union([literal("active"), literal("idle")])),
	projectId: opt(str()),
	limit: opt(num()),
});
const cancel = object({ threadId: str(), cascade: opt(bool({ description: "Default true" })) });

const reportJson = (entry: Report) => ({ threadId: entry.threadId, title: entry.title, runId: entry.runId, verdict: entry.verdict, toolCalls: entry.toolCalls, truncated: entry.truncated, report: entry.text });

/** The thread tools, as one extension. `callers`: who may call them (default: the model and scripts). */
export function threadToolsExtension(bridge: Bridge, orchestration: Orchestration, options: { readonly callers?: Callers; readonly ops?: ThreadOps } = {}): Extension {
	const callers = options.callers ?? ["model", "tools"];
	// A call's Stop arrives on `context.abortSignal`; a wait passes it on, so a stopped run does not wait for its child.
	const tool = <I>(name: string, description: string, parameters: ToolSchema, writes: boolean, run: (caller: string | undefined, input: I, api: Api, signal: AbortSignal | undefined) => Promise<unknown> | unknown): ToolRegistration =>
		({
			name,
			description,
			parameters,
			callers,
			replay: "safe",
			async execute(args: unknown, api: Api, context: Context) {
				const answer = (value: unknown, isError = false) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
				try {
					const input = { ...(args as Record<string, unknown>) };
					if (writes && input.clientRequestId === undefined) input.clientRequestId = `call:${String(api.taskId)}:${api.callId}`;
					const caller = await bridge.threadIdForConversation(api.conversationId);
					return answer(await run(caller, input as I, api, context.abortSignal));
				} catch (error) {
					if (error instanceof ThreadToolError) return answer({ error: error.message }, true);
					throw error;
				}
			},
		}) as unknown as ToolRegistration;
	const tools = [
		tool<Parameters<Orchestration["prompt"]>[1]>("thread_prompt", PROMPT, prompt, true, async (caller, input, _api, signal) => {
			const result = await orchestration.prompt(caller, input, signal);
			return { threadId: result.threadId, notify: result.notify, ...(result.report === undefined ? {} : reportJson(result.report)) };
		}),
		tool<{ threadIds: string[]; timeoutMs?: number }>("thread_wait", WAIT, wait, false, async (caller, input, _api, signal) => {
			const result = await orchestration.wait(caller, input.threadIds, input.timeoutMs, signal);
			return { verdict: result.verdict, reports: result.reports.map(reportJson) };
		}),
		tool<{ threadId?: string; last?: number; before?: number }>("thread_read", READ, read, false, (caller, input) => orchestration.read(caller, input)),
		tool<{ query: string; limit?: number }>("thread_search", SEARCH, search, false, async (_caller, input) => ({ matches: await orchestration.search(input.query, input.limit) })),
		tool<{ parent?: string; status?: "active" | "idle"; projectId?: string; limit?: number }>("thread_list", LIST, list, false, (caller, input) => ({ threads: orchestration.list(caller, input) })),
		tool<{ threadId: string; cascade?: boolean }>("thread_cancel", CANCEL, cancel, true, (caller, input) => orchestration.cancel(caller, input.threadId, input.cascade ?? true)),
	];
	// T3's tools for scheduled tasks, projects and organizing threads, with T3's names, descriptions and schemas (the
	// same operations `/mcp` serves).
	const ops = options.ops;
	if (ops !== undefined) {
		const t3Tools: Record<string, { readonly writes: boolean; readonly run: (caller: { threadId?: string }, input: never) => unknown; readonly note?: string }> = {
			schedule_task: { writes: true, run: (caller, input) => ops.scheduleTask(caller, input) },
			list_scheduled_tasks: { writes: false, run: (caller, input) => ops.listScheduledTasks(caller, input) },
			delete_scheduled_task: { writes: false, run: (caller, input) => ops.deleteScheduledTask(caller, input) },
			t3_project_list: { writes: false, run: (caller, input) => ops.projectList(caller, input) },
			t3_project_read: { writes: false, run: (caller, input) => ops.projectRead(caller, input) },
			t3_project_create: { writes: false, run: (caller, input) => ops.projectCreate(caller, input), note: PROJECT_CREATE_NOTE },
			t3_project_update: { writes: false, run: (caller, input) => ops.projectUpdate(caller, input), note: PROJECT_UPDATE_NOTE },
			t3_project_delete: { writes: false, run: (caller, input) => ops.projectDelete(caller, input) },
			run_scheduled_task_now: { writes: false, run: (caller, input) => ops.runScheduledTaskNow(caller, input) },
			t3_thread_update: { writes: true, run: (caller, input) => ops.update(caller, input) },
			t3_thread_organize: { writes: false, run: (caller, input) => ops.organize(caller, input) },
			t3_queue: { writes: false, run: (caller, input) => ops.queue(caller, input), note: QUEUE_NOTE },
		};
		const contracts: Record<string, (typeof OrchestratorToolkit.tools)[keyof typeof OrchestratorToolkit.tools] | (typeof ProjectToolkit.tools)[keyof typeof ProjectToolkit.tools] | (typeof ThreadToolkit.tools)[keyof typeof ThreadToolkit.tools]> = {
			...OrchestratorToolkit.tools,
			...ProjectToolkit.tools,
			...ThreadToolkit.tools,
		};
		for (const [name, operation] of Object.entries(t3Tools)) {
			const contract = contracts[name]!;
			const decode = Schema.decodeUnknownSync(Schema.toCodecJson(contract.parametersSchema as Schema.Top) as never);
			const encode = Schema.encodeUnknownSync(Schema.toCodecJson(contract.successSchema as Schema.Top) as never);
			tools.push(
				tool<Record<string, unknown>>(name, operation.note === undefined ? (contract.description ?? name) : `${contract.description ?? name} ${operation.note}`, advertisedJsonSchema(contract) as unknown as ToolSchema, operation.writes, async (caller, input) => {
					let decoded: unknown;
					try {
						decoded = decode(input);
					} catch (error) {
						throw new ThreadToolError((error as Error).message);
					}
					try {
						return encode(await operation.run(caller === undefined ? {} : { threadId: caller }, decoded as never));
					} catch (error) {
						if (error instanceof OrchestratorMcpFailure) throw new ThreadToolError(`${error.code}: ${error.message}`);
						throw error;
					}
				}),
			);
		}
	}
	return defineExtension({ name: "thread-tools", tools });
}
