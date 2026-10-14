// The plain-data shapes the T3 facet reads off a pi-durable head conversation. These are just the view/message/entry
// structures the projection and bridge consume — they mirror pi-durable's real `ConversationView` (whose `docs` are
// built-in documents keyed by kind, and whose entries carry their messages in `model`). A mirrored shape is typed
// with the fields the facet reads; where it stands for one of pi's encodings (a message's content blocks, a live
// run) it also carries the fields of that encoding the facet ignores, so the mirror stays recognizable against pi's
// view. No service/transport API lives here; writes go through the chord2 objects in `../objects.ts`. The
// `provider/model` slug helpers live here too: the host's config parser and the facet's projection share one
// splitter, and a leaf both sides may import is what keeps that shared code off a facet→host edge.

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

/** How many models a refusal lists: enough to spot the right one, bounded so a large catalog cannot flood a toast. */
export const REFUSAL_MODEL_LIMIT = 12;

/**
 * A model the host cannot use: it is not in the catalog. The message names the refused model and a bounded list of
 * what IS available, so a typo is fixable from the refusal alone — a default outside the catalog is not a label, it
 * makes every new thread an interrupted turn, and the instance file is edited by hand as well as by the UI.
 */
export class ModelNotAvailable extends Error {
	readonly model: string;
	readonly available: readonly string[];
	constructor(model: string, available: readonly string[], limit = REFUSAL_MODEL_LIMIT) {
		const shown = available.slice(0, limit);
		const more = available.length > shown.length ? ` (+${available.length - shown.length} more)` : "";
		super(`model ${model} is not available; available: ${shown.length > 0 ? `${shown.join(", ")}${more}` : "(none)"}`);
		this.name = "ModelNotAvailable";
		this.model = model;
		this.available = available;
	}
}

/** `provider/model` for a catalog entry, so the host's `{provider, id}` list and the facet's `{provider, modelId}`
 * catalog compare one spelling. */
export const refSlug = (ref: { provider: string; id?: string; modelId?: string }): string => `${ref.provider}/${ref.modelId ?? ref.id}`;

/** Durable message content as pi-ai encodes it (the subset the projection reads). */
export type ContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "image"; data: string; mimeType: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

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
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: ContentBlock[];
			isError?: boolean;
			timestamp?: number;
	  };

export interface EntryRecord {
	id: number;
	kind: string;
	model?: DurableMessage[];
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

/** A `pi.models` state, as the objects assemble it for the catalog. */
export interface ModelsState {
	catalog: { revision: number; availableModels: (ModelRef & { name: string })[] };
	configuration: { model: ModelRef | null; thinkingLevel: string };
}
