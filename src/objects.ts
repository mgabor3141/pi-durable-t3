// The chord objects: the surface design.md's "chord objects" table describes — thin adapters over `Threads` that mirror
// the thread list and each head view as observable state and answer host codes as `ChordError` reasons.
import { Type } from "typebox";
import {
	type Ctx,
	cell,
	ChordError,
	defineFacet,
	type Facet,
	type FacetApi,
	invalid,
	isChordError,
	local,
	method,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentChange, ConversationId, ConversationView, ConversationWatch } from "@earendil-works/pi-durable";
import { HostError } from "./host-errors.ts";
import { ThreadsDoc, type Thread, type Threads } from "./threads.ts";

// ── Schemas ─────────────────────────────────────────────────────────────────

const ProjectSchema = Type.Object({ id: Type.String(), name: Type.String(), cwd: Type.String() });
const ParentSchema = Type.Object({ threadId: Type.String() });
const ThreadSchema = Type.Object({
	threadId: Type.String(),
	projectId: Type.String(),
	head: Type.Number(),
	title: Type.String(),
	createdAt: Type.Number(),
	parent: Type.Optional(ParentSchema),
});
const ThreadsCell = Type.Object({
	revision: Type.Number(),
	projects: Type.Array(ProjectSchema),
	threads: Type.Array(ThreadSchema),
});

// The head's durable view, carried through as-is (an opaque JSON value; the facet reads the fields it needs).
const TranscriptState = Type.Object({ conversationId: Type.Number(), view: Type.Unknown() });

const ThreadKey = Type.Object({ threadId: Type.String() });
const MessageArgs = Type.Object({
	conversationId: Type.Number(),
	requestId: Type.String(),
	message: Type.String(),
	/** The client's id for this message; it rides in the `app.user` entry's data (state.md: no side store). */
	messageId: Type.Optional(Type.String()),
});
const AbortArgs = Type.Object({ conversationId: Type.Number() });
const RewindArgs = Type.Object({ expectedHead: Type.Number(), entryId: Type.Number(), requestId: Type.String() });
const SubmissionRef = Type.Object({ submissionId: Type.Number() });
const ConversationRef = Type.Object({ conversationId: Type.Number() });

const ModelRefSchema = Type.Object({ provider: Type.String(), modelId: Type.String() });
const Catalog = Type.Array(Type.Object({ provider: Type.String(), modelId: Type.String() }));
const ConfigurationSchema = Type.Object({ model: Type.Union([ModelRefSchema, Type.Null()]), thinkingLevel: Type.String() });

// Mirrors pi-ai's model thinking levels (the array is not exported from the package index).
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ── Contracts ───────────────────────────────────────────────────────────────

export const PiThreads = local("pi.threads", {
	version: 1,
	input: Type.Object({}),
	members: {
		threads: ThreadsCell,
		// A thread starts untitled: the create command carries no title (capabilities.md; the 🔜 rename owns the field).
		create: method(Type.Object({ threadId: Type.String(), projectId: Type.String() }), ThreadSchema),
		remove: method(Type.Object({ threadId: Type.String() }), Type.Null()),
	},
});

export const PiTranscript = local("pi.transcript", {
	version: 1,
	input: ThreadKey,
	members: { transcript: TranscriptState },
});

export const PiController = local("pi.controller", {
	version: 1,
	input: ThreadKey,
	members: {
		prompt: method(MessageArgs, SubmissionRef),
		steer: method(MessageArgs, SubmissionRef),
		followUp: method(MessageArgs, SubmissionRef),
		abort: method(AbortArgs, Type.Null()),
		rewind: method(RewindArgs, ConversationRef),
	},
});

export const PiModels = local("pi.models", {
	version: 1,
	input: ThreadKey,
	members: {
		catalog: Catalog,
		configuration: ConfigurationSchema,
		select: method(ModelRefSchema, ConfigurationSchema),
		selectThinking: method(Type.Object({ level: Type.String() }), ConfigurationSchema),
	},
});

// ── Error mapping ────────────────────────────────────────────────────────────

function toChordError(error: unknown): ChordError {
	if (isChordError(error)) return error;
	if (error instanceof HostError) return invalid(error.code, error.message);
	return new ChordError("unavailable", error instanceof Error ? error.message : String(error), { cause: error });
}

/** The view of a thread that is not loaded yet: NO conversation, no entries, no docs, and no head id — a magic `0`
 * looks like a target, and a write that read one aims at a conversation that does not exist. `Bridge.#awaitHead`
 * waits for the real id (design.md: cold-thread writes await the head). */
const EMPTY_VIEW = { conversation: {}, entries: [], docs: {} } as unknown as ConversationView;

const untilAborted = (signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});

// ── Serving ──────────────────────────────────────────────────────────────────

export function serveServerObjects(api: Pick<FacetApi, "serve">, threads: Threads, models: Models): void {
	const harness = threads.harness;

	/** The thread's current head conversation id, or `undefined` when the thread is gone. */
	const headOf = (state: { threads: Thread[] } | null, threadId: string): number | undefined =>
		state?.threads.find((thread) => thread.threadId === threadId)?.head;

	api.serve(
		PiThreads,
		(_input, _principal, self) => {
			const state = self.state({
				threads: cell(ThreadsCell, { revision: 0, projects: [...threads.projects], threads: [] }),
			});
			const publish = async (ctx: Ctx): Promise<void> => {
				const list = await threads.list();
				state.threads.replace(ctx, { revision: state.threads.value.revision + 1, projects: [...threads.projects], threads: list }, { diff: true });
			};
			self.tasks({ load: (ctx) => publish(ctx) });
			return {
				threads: state.threads,
				create: async (args, ctx) => {
					try {
						const thread = await threads.create(args);
						await publish(ctx);
						return thread;
					} catch (error) {
						throw toChordError(error);
					}
				},
				remove: async (args, ctx) => {
					try {
						await threads.remove(args.threadId);
						await publish(ctx);
						return null;
					} catch (error) {
						throw toChordError(error);
					}
				},
			};
		},
		{ eager: true },
	);

	api.serve(PiTranscript, ({ threadId }, _principal, self) => {
		const state = self.state({ transcript: cell(TranscriptState, { conversationId: 0, view: EMPTY_VIEW }) });
		self.tasks({
			// Follow the thread's head: watch the thread list for the head, and the head conversation's view for its value.
			pump: async (ctx) => {
				let conversationWatch: ConversationWatch | undefined;
				let currentHead = -1;
				const setView = (conversationId: number, view: ConversationView): void => {
					state.transcript.replace(ctx, { conversationId, view }, { diff: true });
				};
				const rebind = async (head: number): Promise<void> => {
					if (head === currentHead) return;
					currentHead = head;
					await conversationWatch?.stop().catch(() => {});
					const conversation = await harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
					if (conversation === undefined) {
						setView(head, EMPTY_VIEW);
						return;
					}
					conversationWatch = await conversation.watch(BACKGROUND_CONTEXT);
					conversationWatch.start(async (view) => setView(head, view));
					setView(head, conversationWatch.value);
				};
				const threadsWatch = await harness.watchDoc(ThreadsDoc, BACKGROUND_CONTEXT);
				threadsWatch?.start(async (value) => {
					const head = headOf(value, threadId);
					if (head !== undefined) await rebind(head);
				});
				try {
					const head = headOf((await harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT)) ?? null, threadId);
					if (head !== undefined) await rebind(head);
					await untilAborted(ctx.signal);
				} finally {
					await conversationWatch?.stop().catch(() => {});
					await threadsWatch?.stop().catch(() => {});
				}
			},
		});
		return { transcript: state.transcript };
	});

	api.serve(PiController, ({ threadId }, _principal, _self) => {
		const submit = async (
			args: { conversationId: number; requestId: string; message: string; messageId?: string },
			whenBusy: "steer" | "followUp" | undefined,
		): Promise<{ submissionId: number }> => {
			try {
				const submission = await threads.submit(
					{ threadId, conversationId: args.conversationId, requestId: args.requestId, message: args.message, ...(args.messageId === undefined ? {} : { messageId: args.messageId }) },
					whenBusy,
				);
				return { submissionId: submission.id };
			} catch (error) {
				throw toChordError(error);
			}
		};
		return {
			prompt: (args) => submit(args, undefined),
			steer: (args) => submit(args, "steer"),
			followUp: (args) => submit(args, "followUp"),
			abort: async (args) => {
				try {
					await threads.abort({ threadId, conversationId: args.conversationId });
					return null;
				} catch (error) {
					throw toChordError(error);
				}
			},
			rewind: async (args) => {
				try {
					return { conversationId: await threads.rewind({ threadId, expectedHead: args.expectedHead, entryId: args.entryId, requestId: args.requestId }) };
				} catch (error) {
					throw toChordError(error);
				}
			},
		};
	});

	api.serve(PiModels, ({ threadId }, _principal, self) => {
		const catalog = models.getModels().map((model) => ({ provider: model.provider, modelId: model.id }));
		const state = self.state({
			catalog: cell(Catalog, catalog),
			configuration: cell(ConfigurationSchema, { model: null, thinkingLevel: "off" }),
		});
		const headConversation = async () => {
			const doc = await harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT);
			const head = headOf(doc ?? null, threadId);
			return head === undefined ? undefined : harness.conversation(head as ConversationId, BACKGROUND_CONTEXT);
		};
		const readConfiguration = async (): Promise<{ model: { provider: string; modelId: string } | null; thinkingLevel: string }> => {
			const conversation = await headConversation();
			if (conversation === undefined) return { model: null, thinkingLevel: "off" };
			const agent = await conversation.agent(BACKGROUND_CONTEXT);
			return {
				model: agent.model === undefined ? null : { provider: agent.model.provider, modelId: agent.model.modelId },
				thinkingLevel: agent.thinkingLevel,
			};
		};
		/** Configure the head, then re-read and publish its configuration (shared by `select` / `selectThinking`). */
		const configureHead = async (change: AgentChange, ctx: Ctx) => {
			const conversation = await headConversation();
			if (conversation === undefined) throw invalid("unknown_thread", `no head for thread ${threadId}`);
			await conversation.configure(change, BACKGROUND_CONTEXT);
			const configuration = await readConfiguration();
			state.configuration.replace(ctx, configuration, { diff: true });
			return configuration;
		};
		self.tasks({
			// Seed and refresh the head's configuration; the head only changes via a switch, so re-read on a thread change.
			pump: async (ctx) => {
				const threadsWatch = await harness.watchDoc(ThreadsDoc, BACKGROUND_CONTEXT);
				const refresh = async (): Promise<void> => state.configuration.replace(ctx, await readConfiguration(), { diff: true });
				threadsWatch?.start(async () => refresh());
				try {
					await refresh();
					await untilAborted(ctx.signal);
				} finally {
					await threadsWatch?.stop().catch(() => {});
				}
			},
		});
		return {
			catalog: state.catalog,
			configuration: state.configuration,
			select: async (args, ctx) => {
				if (!catalog.some((model) => model.provider === args.provider && model.modelId === args.modelId)) {
					throw invalid("unknown_model", `not in the catalog: ${args.provider}/${args.modelId}`);
				}
				return configureHead({ model: args }, ctx);
			},
			selectThinking: async (args, ctx) => {
				if (!THINKING_LEVELS.includes(args.level as (typeof THINKING_LEVELS)[number])) {
					throw invalid("unknown_thinking_level", `unknown thinking level: ${args.level}`);
				}
				return configureHead({ thinkingLevel: args.level as ModelThinkingLevel }, ctx);
			},
		};
	});
}

// ── The facet the host loads ────────────────────────────────────────────────

/** Serve every object above as one facet (the T3 bridge is a local client of these, loaded beside this facet). */
export function createServerFacet(threads: Threads, models: Models): Facet {
	return { name: "pi-durable-t3", ...defineFacet((api) => serveServerObjects(api, threads, models)) };
}
