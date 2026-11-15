// `/context`: what fills the model's context, in a few rows. The total is what pi itself goes by (the last request's
// real usage plus an estimate of what came after it, `estimateContextTokens`); the parts are estimated from their
// length, as pi estimates, and scaled so they add up to that total. Pure: a context view in, Markdown out.
import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

/** pi's own allowance for an image (`estimate.ts`: 4800 characters). */
const IMAGE_TOKENS = estimateTextTokens("x".repeat(4800));
/** Rows listed under a part before the rest are summed as "other". */
const MAX_SUBROWS = 4;

/** The part of pi-durable's `ContextView` the report reads. */
export interface ContextReportView {
	readonly head: { readonly id: number } | undefined;
	readonly entries: readonly { readonly id: number; readonly kind: string }[];
	readonly contributions: readonly (readonly Message[])[];
	readonly messages: readonly Message[];
}

interface Part {
	readonly label: string;
	tokens: number;
	/** How many things the part counts (tools, results, images), said after the label. */
	count?: number;
	readonly rows: Map<string, number>;
}

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown; hidden?: boolean; shownAs?: { name?: string } };

const blocksOf = (content: unknown): Block[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : []);
const json = (value: unknown): string => {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
};
const number = (value: number) => Math.round(value).toLocaleString("en-US");

export function contextReport(input: { readonly view: ContextReportView; readonly window?: number; readonly model?: string }): string {
	const { view } = input;
	const part = (label: string): Part => ({ label, tokens: 0, rows: new Map() });
	const parts = {
		system: part("System prompt"),
		tools: part("Tool definitions"),
		summary: part("Summary of the earlier conversation"),
		user: part("Your messages"),
		added: part("Added to your messages"),
		images: part("Images"),
		replies: part("Agent: replies"),
		thinking: part("Agent: thinking"),
		calls: part("Agent: tool calls"),
		results: part("Tool results"),
	};
	const add = (target: Part, tokens: number, row?: string) => {
		target.tokens += tokens;
		if (row !== undefined) target.rows.set(row, (target.rows.get(row) ?? 0) + tokens);
	};

	// The system prompt as the next request carries it: every system message replayed into one, and the tools in force.
	const system = getCurrentSystemMessage(view.messages as Message[]);
	if (system !== undefined) {
		if (typeof system.content === "string" && system.content !== "") add(parts.system, estimateTextTokens(system.content), "base");
		for (const [key, text] of Object.entries((system as { sections?: Record<string, string | null> }).sections ?? {})) {
			if (typeof text === "string" && text !== "") add(parts.system, estimateTextTokens(text), key);
		}
	}
	const tools = getCurrentTools(view.messages as Message[]);
	parts.tools.count = tools.length;
	for (const tool of tools) add(parts.tools, estimateTextTokens(json(tool)), tool.name);

	view.entries.forEach((entry, index) => {
		const summary = view.head !== undefined && entry.id === view.head.id;
		for (const message of view.contributions[index] ?? []) {
			if (message.role === "system") continue;
			if (message.role === "assistant") {
				for (const block of blocksOf(message.content)) {
					if (block.type === "text") add(parts.replies, estimateTextTokens(block.text ?? ""));
					else if (block.type === "thinking") add(parts.thinking, estimateTextTokens(block.thinking ?? ""));
					else add(parts.calls, estimateTextTokens((block.name ?? "") + json(block.arguments)), block.name ?? "tool");
				}
				continue;
			}
			if (message.role === "toolResult") {
				parts.results.count = (parts.results.count ?? 0) + 1;
				for (const block of blocksOf(message.content)) {
					if (block.type === "text") add(parts.results, estimateTextTokens(block.text ?? ""), message.toolName);
					else {
						parts.images.count = (parts.images.count ?? 0) + 1;
						add(parts.images, IMAGE_TOKENS);
					}
				}
				continue;
			}
			for (const block of blocksOf(message.content)) {
				if (block.type !== "text") {
					parts.images.count = (parts.images.count ?? 0) + 1;
					add(parts.images, IMAGE_TOKENS);
				} else if (summary) add(parts.summary, estimateTextTokens(block.text ?? ""));
				// What the host put beside a message: memories recalled for it (named by the row T3 shows), the list of
				// its attachments, a transferred context.
				else if (block.shownAs !== undefined || block.hidden === true) add(parts.added, estimateTextTokens(block.text ?? ""), block.shownAs?.name ?? "notes");
				else add(parts.user, estimateTextTokens(block.text ?? ""));
			}
		}
	});

	const estimated = Object.values(parts).reduce((sum, each) => sum + each.tokens, 0);
	const total = estimateContextTokens(view.messages as Message[]).tokens;
	const scale = estimated === 0 ? 0 : total / estimated;
	const share = (tokens: number) => (estimated === 0 ? "0%" : `${Math.round((tokens / estimated) * 100)}%`);

	const lines: string[] = [];
	const head =
		input.window !== undefined && input.window > 0
			? `**Context: ${number(total)} of ${number(input.window)} tokens (${Math.round((total / input.window) * 100)}%)**`
			: `**Context: ${number(total)} tokens**`;
	lines.push(input.model === undefined ? head : `${head} · ${input.model}`, "");
	lines.push("| What | Tokens | Share |", "|---|---:|---:|");
	for (const each of Object.values(parts)) {
		if (each.tokens === 0) continue;
		lines.push(`| ${each.label}${each.count === undefined ? "" : ` (${number(each.count)})`} | ${number(each.tokens * scale)} | ${share(each.tokens)} |`);
		if (each.rows.size < 2) continue;
		const rows = [...each.rows].sort((a, b) => b[1] - a[1]);
		for (const [name, tokens] of rows.slice(0, MAX_SUBROWS)) lines.push(`| &nbsp;&nbsp;· ${name} | ${number(tokens * scale)} | ${share(tokens)} |`);
		const rest = rows.slice(MAX_SUBROWS).reduce((sum, [, tokens]) => sum + tokens, 0);
		if (rest > 0) lines.push(`| &nbsp;&nbsp;· ${rows.length - MAX_SUBROWS} more | ${number(rest * scale)} | ${share(rest)} |`);
	}
	if (estimated === 0) lines.push("| Nothing yet | 0 | 0% |");

	const last = view.messages.findLast((message) => message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted");
	const usage = last?.role === "assistant" ? last.usage : undefined;
	lines.push("");
	if (usage !== undefined && usage.input + usage.cacheRead + usage.cacheWrite > 0) {
		const sent = usage.input + usage.cacheRead + usage.cacheWrite;
		lines.push(`Last request: ${number(sent)} tokens in (${number(usage.cacheRead)} read from cache, ${number(usage.cacheWrite)} written to it), ${number(usage.output)} out.`);
	}
	lines.push("", "The parts are estimated from their length and scaled to the total. Shown here only: not sent to the model, not saved.");
	return lines.join("\n");
}
