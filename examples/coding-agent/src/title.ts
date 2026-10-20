// The example's `titleThread` hook: one tool-less completion on the thread's own model. It reads the conversation's
// context at the entry the bridge names (not a fork: the title model gets no tools and runs nothing) and sends its
// user/assistant TEXT only, trimmed to a budget the way T3's `formatThreadTitleContext` does: no tool calls or results
// (no tools are declared), no thinking, at most 2000 characters per message and 8000 in all, keeping the first user
// message and then the most recent ones.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { Harness } from "@earendil-works/pi-durable";
import type { TitleThread } from "../../../src/bridge.ts";

const MAX_CONTEXT = 8_000;
const MAX_MESSAGE = 2_000;

/** The middle goes first: a message's opening and its end say the most. */
const clip = (text: string, budget: number): string =>
	text.length <= budget ? text : `${text.slice(0, Math.ceil(budget / 2))}\n[…]\n${text.slice(text.length - Math.floor(budget / 2))}`;

/** The transcript as text, within the budget, oldest first. */
export function titleContext(messages: readonly { role: string; content: unknown }[]): string {
	const sections = messages.flatMap((message) => {
		if (message.role !== "user" && message.role !== "assistant") return [];
		const content = message.content;
		const text = (typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block: { type?: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : [])).join("\n") : "").trim();
		return text === "" ? [] : [`${message.role.toUpperCase()}:\n${clip(text, MAX_MESSAGE)}`];
	});
	const first = sections.findIndex((section) => section.startsWith("USER:"));
	const kept = new Set<number>(first === -1 ? [] : [first]);
	let used = first === -1 ? 0 : sections[first]!.length;
	for (let index = sections.length - 1; index >= 0; index--) {
		if (kept.has(index) || used + sections[index]!.length > MAX_CONTEXT) continue;
		kept.add(index);
		used += sections[index]!.length;
	}
	const text = sections.filter((_, index) => kept.has(index)).join("\n\n");
	return kept.size < sections.length ? `[Earlier content left out]\n\n${text}` : text;
}

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
				messages: [{ role: "user", content: `${titleContext(messages)}\n\n${ask}`, timestamp: Date.now() }],
			},
			{ signal },
		);
		if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
		const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
		return text.replace(/^["']|["']$/g, "").trim() || undefined;
	};
}
