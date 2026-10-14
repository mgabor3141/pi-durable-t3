// The plain-data shapes the T3 facet reads off a pi-durable head conversation. These are just the view/message/entry
// structures the projection and bridge consume — they mirror pi-durable's real `ConversationView` (whose `docs` are
// built-in documents keyed by kind, and whose entries carry `model`/`kind`/`head`), typed for the subset used here.
// No service/transport API lives here; writes go through the chord2 objects in `../objects.ts`.

/** A `{ provider, modelId }` reference (pi-durable `ModelRef`). */
export interface ModelRef {
	provider: string;
	modelId: string;
}

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
	conversationId: number;
	kind: string;
	model?: DurableMessage[];
	data?: unknown;
	head?: number;
	byTaskId?: number;
}

interface ToolSlot {
	toolCallId?: string;
	id?: string;
	name?: string;
	status?: string;
	output?: string;
	[key: string]: unknown;
}

export interface LiveDoc {
	run?: { taskId: number; inputs: number[] };
	generation?: { attempt: number; message?: DurableMessage; retry?: { at: number; error: string } };
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
	catalog: { revision: number; availableModels: (ModelRef & { name: string; reasoning: boolean })[] };
	configuration: { model: ModelRef | null; thinkingLevel: string };
	refresh: { status: string };
}
