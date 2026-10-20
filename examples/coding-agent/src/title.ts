// The example's `titleThread` hook: one tool-less completion on the thread's own model, over the conversation's context
// at the entry the bridge names. Not a fork — the title model gets no tools and runs nothing.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import type { TitleThread } from "../../../src/bridge.ts";

export function titleThread(harness: Harness, models: Models): TitleThread {
	return async ({ conversationId, at, reason, previousTitle, signal }) => {
		const ctx = BACKGROUND_CONTEXT;
		const conversation = await harness.conversation(conversationId, ctx);
		if (conversation === undefined) return undefined;
		const { model: ref } = await conversation.agent(ctx);
		const model = ref === undefined ? undefined : models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return undefined;
		const { messages } = await conversation.context(ctx, { at });
		const ask =
			reason === "regenerate"
				? `Write a better title for this conversation than "${previousTitle ?? ""}".`
				: "Write a title for this conversation.";
		const reply = await models.completeSimple(
			model,
			{
				systemPrompt: "You name chat threads. Reply with the title only: at most 6 words, no quotes, no trailing period.",
				messages: [...messages, { role: "user", content: ask, timestamp: Date.now() }],
			},
			{ signal },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
		const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
		return text.replace(/^["']|["']$/g, "").trim() || undefined;
	};
}
