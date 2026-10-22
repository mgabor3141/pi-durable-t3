// The example's `subagent` tool: pi-durable's FOREGROUND subagent pattern (README "Abort and Subagents", upstream example
// 22). The tool call creates a child conversation it OWNS, runs one task there, and returns the child's answer as its
// output. Aborting the call (or the parent's run) aborts the child, and the parent is busy until the child is idle.
// The call's `details` name the child (`{ conversationId }`) while it runs and on its result: that is the convention the
// T3 bridge reads to show the call as a subagent. Nothing here is T3-specific.
import { Type } from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	configure,
	defineExtension,
	defineTool,
	type Extension,
} from "@earendil-works/pi-durable";

/** What the model sends: the task, and an optional short label (T3's subagent card shows both). */
const parameters = Type.Object({
	prompt: Type.String({ description: "The self-contained task for the subagent. It sees nothing of this conversation." }),
	description: Type.Optional(Type.String({ description: "A short (3-5 word) label for the task." })),
});

export const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its final answer back.",
			parameters,
			// Safe to rerun after a crash: a rerun finds the child it already created and the submission it already made.
			replay: "safe",
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					// Ownership records the child: a rerun of this call finds it instead of creating another.
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// Starts as a copy of this conversation's agent (model, thinking level, cwd, tools), owned by this call's task.
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// Without this extension the child is not offered the tool: no recursion.
					await configure(tx, created.id, { extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				// A UI watching the parent sees this and can attach to the child.
				await api.details({ conversationId: child }, context);
				const handle = (await api.conversation(child, context))!;
				// The request id makes a rerun get back the submission it made before the crash.
				const request = { type: "input", content: args.prompt, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await handle.submit(request, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") throw new Error(`The subagent did not finish: ${settled.status}`);
				const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				const message = answer?.model?.[0];
				const text = message?.role === "assistant" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") : "";
				return { output: [{ type: "text", text }], details: { conversationId: child } };
			},
		}),
	],
});
