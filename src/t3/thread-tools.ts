// T3's thread tools as pi-durable tools, for an agent that runs in the same process as the bridge: the operations
// `/mcp` serves (`thread-ops.ts`), with T3's names, descriptions and input schemas, and the calling thread taken from
// the call's own conversation — no credential or `_meta` to pass. Writes are safe to replay after a crash: a call
// without a `clientRequestId` uses its own call id, so the replay is answered with what the first run did.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { defineExtension, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type { TSchema } from "typebox";
import type { Bridge } from "./bridge.ts";
import { OrchestratorToolkit } from "./mcp-toolkit.ts";
import { advertisedJsonSchema } from "./t3-server.ts";
import type { Caller, ThreadOps } from "./thread-ops.ts";

type Operation = (ops: ThreadOps, caller: Caller, input: never) => unknown;

const OPERATIONS: Record<string, { readonly run: Operation; readonly writes: boolean }> = {
	t3_thread_list: { run: (ops, caller, input) => ops.list(caller, input), writes: false },
	t3_thread_read: { run: (ops, caller, input) => ops.read(caller, input), writes: false },
	t3_thread_wait: { run: (ops, caller, input) => ops.wait(caller, input), writes: false },
	t3_thread_send: { run: (ops, caller, input) => ops.send(caller, input), writes: true },
	t3_thread_interrupt: { run: (ops, caller, input) => ops.interrupt(caller, input), writes: true },
	create_threads: { run: (ops, caller, input) => ops.create(caller, input), writes: true },
	t3_thread_update: { run: (ops, caller, input) => ops.update(caller, input), writes: true },
};

/** The thread tools, as one extension. `callers`: who may call them (default: the model and scripts). */
export function threadToolsExtension(bridge: Bridge, ops: ThreadOps, options: { readonly callers?: readonly ("model" | "tools")[] } = {}): Extension {
	const tools: ToolRegistration[] = Object.entries(OPERATIONS).map(([name, operation]) => {
		const tool = OrchestratorToolkit.tools[name as keyof typeof OrchestratorToolkit.tools];
		const decode = Schema.decodeUnknownSync(Schema.toCodecJson(tool.parametersSchema as Schema.Top) as never);
		const encode = Schema.encodeUnknownSync(Schema.toCodecJson(tool.successSchema as Schema.Top) as never);
		return {
			name,
			description: tool.description ?? name,
			parameters: advertisedJsonSchema(tool) as unknown as TSchema,
			callers: options.callers ?? ["model", "tools"],
			replay: "safe",
			async execute(args, api) {
				const answer = (value: unknown, isError = false) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
				try {
					const raw = { ...(args as Record<string, unknown>) };
					if (operation.writes && raw.clientRequestId === undefined) raw.clientRequestId = `call:${String(api.taskId)}:${api.callId}`;
					let input: unknown;
					try {
						input = decode(raw);
					} catch (error) {
						throw new OrchestratorMcpFailure({ code: "invalid_request", message: (error as Error).message });
					}
					const threadId = await bridge.threadIdForConversation(api.conversationId);
					const result = await operation.run(ops, threadId === undefined ? {} : { threadId }, input as never);
					return answer(encode(result));
				} catch (error) {
					if (error instanceof OrchestratorMcpFailure) return answer({ _tag: error._tag, code: error.code, message: error.message }, true);
					throw error;
				}
			},
		} satisfies ToolRegistration;
	});
	return defineExtension({ name: "t3-thread-tools", tools });
}
