// The plain-data mirrors of pi-durable's view shapes that the facet reads — no service or transport API lives here;
// writes go through the chord objects in `../objects.ts`. The `provider/model` slug helpers live here too: a leaf both
// sides may import keeps that shared code off a facet→host edge.

/** A `{ provider, modelId }` reference (pi-durable `ModelRef`). */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/** `provider/model` — the slug every side of the boundary uses for a model. */
export const modelSlug = (model: ModelRef): string => `${model.provider}/${model.modelId}`;

/** Split a `provider/model` slug; `undefined` when either part is empty. Callers add their own error: the host names
 * the config key, the facet answers the client. */
export function splitSlug(slug: string): ModelRef | undefined {
	const index = slug.indexOf("/");
	if (index <= 0 || index === slug.length - 1) return undefined;
	return { provider: slug.slice(0, index), modelId: slug.slice(index + 1) };
}

/** T3's pi driver's model-option id (`piThinkingCapabilities.ts` at the pin); its values ARE pi's thinking levels. */
export const THINKING_OPTION = "thinking";
/** One spelling for the array a model declares its levels in, a selection's change carries, and a head reports. */
export const thinkingOption = (level: string) => [{ id: THINKING_OPTION, value: level }];

/** The thinking level a T3 `modelSelection` carries (the contract's canonical `{ id, value }` array). */
export function thinkingOf(options: readonly { id: string; value: string | boolean }[] | undefined): string | undefined {
	const found = options?.find((option) => option.id === THINKING_OPTION);
	return typeof found?.value === "string" ? found.value : undefined;
}

/** Durable message content as pi-ai encodes it (the subset the projection reads). */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** pi-ai's per-response token and cost accounting (`Usage` in `@earendil-works/pi-ai`), the subset the usage view
 * reads. `cost` is pi's own catalog-price estimate; `reasoning` is a subset of `output`; the input/cache counters are
 * disjoint. pi reports no cache-savings figure and no speed tier, so neither appears here. */
export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type DurableMessage =
	| { role: "user"; content: string | ContentBlock[]; timestamp?: number }
	| {
			role: "assistant";
			content: ContentBlock[];
			stopReason?: string;
			errorMessage?: string;
			timestamp?: number;
			provider?: string;
			model?: string;
			/** The provider's own model id for this response; pi's usage reader prices on it when present. */
			responseModel?: string;
			/** Token counts and cost pi recorded for this turn (pi-ai `Usage`). */
			usage?: PiUsage;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			isError?: boolean;
			timestamp?: number;
			/** Usage from the tool execution itself, when the tool reports it (not part of the model context accounting). */
			usage?: PiUsage;
	  };

export interface EntryRecord {
	id: number;
	kind: string;
	model?: readonly DurableMessage[];
	data?: unknown;
}

interface ToolSlot {
	toolCallId?: string;
	id?: string;
	output?: string;
	[key: string]: unknown;
}

export interface LiveDoc {
	run?: { taskId: number; inputs: number[] };
	generation?: { attempt: number; message?: DurableMessage };
	tools?: ToolSlot[];
}

/** The head conversation's durable view, as `pi.transcript` serves it. */
export interface ConversationView {
	conversation: { id: number; [key: string]: unknown };
	entries: EntryRecord[];
	docs: {
		"pi.live"?: LiveDoc;
		"pi.agent"?: { model?: ModelRef; thinkingLevel?: string; cwd?: string };
		[key: string]: unknown;
	};
}
