// A thread's request priority: T3's "Priority" model option, sent as the request's `priority` field (vLLM's: lower is
// taken sooner). pi sends that field only for a model whose `compat.vllmPriority` is set in models.json (on its
// provider or on the model), with that value; the option shows on those models alone, and a thread's choice replaces
// the value in its requests. A thread without one (Default) takes its parent's, else the value pi put there.
import { type ConversationId, defineExtension, type Extension, GenerationTask, hook } from "@earendil-works/pi-durable";

/** The model option's id. */
export const PRIORITY_OPTION = "priority";
/** The choice that clears a thread's own priority. */
const INHERIT = "inherit";
/** What each choice sends. */
export const PRIORITIES = { high: -5, normal: 0, low: 5 } as const;
export type Priority = keyof typeof PRIORITIES;

/** The option as a model declares it (T3's `SelectProviderOptionDescriptor`). The labels are words no thinking level
 * uses: T3 shows both options' values side by side (the model button's tooltip: "High · Relaxed"). Default (a thread
 * with no choice of its own, which follows its parent) is marked the default, so every thread shows a value, the same
 * one before and after it is picked. The ids are what a thread's record keeps. */
export const PRIORITY_DESCRIPTOR = {
	id: PRIORITY_OPTION,
	label: "Priority",
	type: "select",
	options: [
		{ id: INHERIT, label: "Default", isDefault: true },
		{ id: "high", label: "Urgent" },
		{ id: "normal", label: "Normal" },
		{ id: "low", label: "Relaxed" },
	],
} as const;

/** Whether pi sends `model` a `priority` field (its openai-completions request, with `compat.vllmPriority`). */
export function takesPriority(model: { readonly api?: string; readonly compat?: unknown }): boolean {
	return model.api === "openai-completions" && (model.compat as { vllmPriority?: unknown } | undefined)?.vllmPriority !== undefined;
}

/** The priority a selection's options choose: a choice, `null` for Default (none of the thread's own), `undefined`
 * when they name none. An unknown value is an error, `Error` with the value in its message. */
export function priorityChoice(options: readonly { readonly id: string; readonly value: string | boolean }[] | undefined): Priority | null | undefined {
	const value = options?.find((option) => option.id === PRIORITY_OPTION)?.value;
	if (value === undefined) return undefined;
	if (value === INHERIT) return null;
	if (typeof value === "string" && Object.hasOwn(PRIORITIES, value)) return value as Priority;
	throw new Error(`Unknown priority: ${String(value)}`);
}

/** A thread as the priority reads it: its own choice and its lineage. */
export type PriorityNode = {
	readonly priority?: Priority;
	readonly lineage: { readonly parentThreadId: string | null; readonly relationshipToParent: "fork" | "subagent" | null; readonly sideChat?: true };
};

/**
 * The priority `threadId` runs at: its own, else its parent's as that one runs. A subagent and a side chat follow
 * their parent. A fork took its origin's choice when it was made, so past a fork the origin's own choice is not read,
 * only what the origin itself inherits. `undefined`: none in the line, the value pi put in the request stands.
 */
export function threadPriority(threadId: string, read: (threadId: string) => PriorityNode | undefined): Priority | undefined {
	const seen = new Set<string>();
	let readOwn = true;
	for (let id: string | null = threadId; id !== null && !seen.has(id); ) {
		seen.add(id);
		const node = read(id);
		if (node === undefined) return undefined;
		if (readOwn && node.priority !== undefined) return node.priority;
		const { parentThreadId, relationshipToParent, sideChat } = node.lineage;
		readOwn = relationshipToParent === "subagent" || sideChat === true;
		id = relationshipToParent === null ? null : parentThreadId;
	}
	return undefined;
}

/** The extension that puts a thread's priority in its requests: only where pi already sent the field, so a provider
 * without `compat.vllmPriority` never gets one. */
export function priorityExtension(host: { readonly priorityOf: (conversationId: ConversationId) => number | undefined }): Extension {
	return defineExtension({
		name: "t3-priority",
		hooks: [
			hook(GenerationTask, {
				beforeProviderRequest: (request, api) => {
					const payload = request.payload;
					if (typeof payload !== "object" || payload === null || !("priority" in payload)) return undefined;
					const priority = host.priorityOf(api.conversationId);
					return priority === undefined ? undefined : { payload: { ...payload, priority } };
				},
			}),
		],
	});
}
