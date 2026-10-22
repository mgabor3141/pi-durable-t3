// The chord objects: the surface design.md's "chord objects" table describes — thin adapters over `Threads` that mirror
// the thread list and each head view as observable state and answer host codes as `ChordError` reasons.
import { Type } from "typebox";
import {
	type Ctx,
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
import type { ContentBlock } from "./t3/model-types.ts";
import { parseSubagentThreadId } from "./t3/subagents.ts";

/** A persisted image record the client sent, placed in the entry's data (the projection reads it back). Mirrors
 * `AttachmentStore`'s record shape; declared here so the objects layer stays free of a facet→objects import. */
type AttachmentRecord = { readonly id: string; readonly name: string; readonly mimeType: string; readonly sizeBytes: number };

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

// A thread-search match, as `pi.threads.search` answers it (the threads layer's `ThreadSearchMatch`, ms timestamps).
const ThreadSearchMatchSchema = Type.Object({
	threadId: Type.String(),
	projectId: Type.String(),
	source: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
	snippet: Type.String(),
	messageCreatedAt: Type.Union([Type.Number(), Type.Null()]),
});

// The head's durable view, carried through as-is (an opaque JSON value; the facet reads the fields it needs).
const TranscriptState = Type.Object({ conversationId: Type.Number(), view: Type.Unknown() });

// A subagent, as `pi.threads.subagents` discovers it (`t3/subagents.ts`).
const SubagentSchema = Type.Object({
	threadId: Type.String(),
	parentThreadId: Type.String(),
	conversationId: Type.Number(),
	taskId: Type.Number(),
	prompt: Type.String(),
	title: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.Number(),
	endedAt: Type.Optional(Type.Number()),
});

const ThreadKey = Type.Object({ threadId: Type.String() });
/** A persisted image, shaped for the entry's data (the projection reads it back as the message's attachments). */
const AttachmentRecordSchema = Type.Object({ id: Type.String(), name: Type.String(), mimeType: Type.String(), sizeBytes: Type.Number() });
const MessageArgs = Type.Object({
	conversationId: Type.Number(),
	requestId: Type.String(),
	message: Type.String(),
	/** The client's id for this message; it rides in the `app.user` entry's data (state.md: no side store). */
	messageId: Type.Optional(Type.String()),
	/** Extra pi-ai content blocks (an image) appended after the text block — supplied only when the model accepts images. */
	blocks: Type.Optional(Type.Array(Type.Unknown())),
	/** The message's persisted images, placed in the entry's data so the thread shows them after a restart. */
	attachments: Type.Optional(Type.Array(AttachmentRecordSchema)),
});
const AbortArgs = Type.Object({ conversationId: Type.Number() });
const RewindArgs = Type.Object({ expectedHead: Type.Number(), entryId: Type.Number(), requestId: Type.String() });
const SubmissionRef = Type.Object({ submissionId: Type.Number() });
const ConversationRef = Type.Object({ conversationId: Type.Number() });

const ModelRefSchema = Type.Object({ provider: Type.String(), modelId: Type.String() });
const Catalog = Type.Array(Type.Object({ provider: Type.String(), modelId: Type.String(), input: Type.Array(Type.String()) }));
const ConfigurationSchema = Type.Object({ model: Type.Union([ModelRefSchema, Type.Null()]), thinkingLevel: Type.String() });

// Mirrors pi-ai's model thinking levels (the array is not exported from the package index).
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// ── Contracts ───────────────────────────────────────────────────────────────

export const PiThreads = local("pi.threads", {
	version: 1,
	input: Type.Object({}),
	members: {
		threads: ThreadsCell,
		// `title` is a launch's title (absent: untitled, "New thread"). `cwd` is a folder of its own under the project (a
		// Scratch thread's); absent, the project's root.
		create: method(Type.Object({ threadId: Type.String(), projectId: Type.String(), cwd: Type.Optional(Type.String()), title: Type.Optional(Type.String()) }), ThreadSchema),
		remove: method(Type.Object({ threadId: Type.String() }), Type.Null()),
		// Set a thread's title (a rename, a seed, a generated title); durable in the threads document.
		rename: method(Type.Object({ threadId: Type.String(), title: Type.String() }), Type.Null()),
		// T3's thread search over the threads the host has: a query and a limit, answered with T3's match shape (ms timestamps;
		// the facet converts to ISO for the wire).
		search: method(Type.Object({ query: Type.String(), limit: Type.Number() }), Type.Array(ThreadSearchMatchSchema)),
		// The subagents of every thread: conversations owned by a tool call of a thread's conversation (a read).
		subagents: method(Type.Object({ threadId: Type.Optional(Type.String()) }), Type.Array(SubagentSchema)),
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

/** The principal of the host's own code (`createHost({ self })`): chord 1.2's built-in `hostPrincipal`. */
export const HOST_PRINCIPAL = { host: true } as const;

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
			const state = {
				threads: self.state("threads", ThreadsCell, { revision: 0, projects: [...threads.projects], threads: [] }),
			};
			const publish = async (ctx: Ctx): Promise<void> => {
				const list = await threads.list();
				state.threads.replace(ctx, { revision: state.threads.value.revision + 1, projects: [...threads.projects], threads: list }, { diff: true });
			};
			self.task((ctx) => publish(ctx));
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
				rename: async (args, ctx) => {
					try {
						await threads.rename(args.threadId, args.title);
						await publish(ctx);
						return null;
					} catch (error) {
						throw toChordError(error);
					}
				},
				search: async (args) => {
					try {
						return await threads.search(args.query, args.limit);
					} catch (error) {
						throw toChordError(error);
					}
				},
				subagents: async (args) => {
					try {
						return await threads.subagents(args.threadId);
					} catch (error) {
						throw toChordError(error);
					}
				},
			};
		},
		{ lifetime: "host" },
	);

	api.serve(PiTranscript, ({ threadId }, _principal, self) => {
		const state = { transcript: self.state("transcript", TranscriptState, { conversationId: 0, view: EMPTY_VIEW }) };
		// Follow the thread's head: watch the thread list for the head, and the head conversation's view for its value.
		self.task(async (ctx) => {
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
			// A subagent's thread is its child conversation, fixed by the id: the bridge opens it only for a child it
			// discovered (`Bridge.hasThread`), and it is no thread's head, so it never enters the threads document.
			const subagent = parseSubagentThreadId(threadId);
			if (subagent !== undefined) {
				try {
					await rebind(subagent.conversationId);
					await untilAborted(ctx.signal);
				} finally {
					await conversationWatch?.stop().catch(() => {});
				}
				return;
			}
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
		});
		return { transcript: state.transcript };
	});

	api.serve(PiController, ({ threadId }, _principal, _self) => {
		const submit = async (
			args: { conversationId: number; requestId: string; message: string; messageId?: string; blocks?: unknown[]; attachments?: AttachmentRecord[] },
			whenBusy: "steer" | "followUp" | undefined,
		): Promise<{ submissionId: number }> => {
			try {
				const submission = await threads.submit(
					{
						threadId,
						conversationId: args.conversationId,
						requestId: args.requestId,
						message: args.message,
						...(args.messageId === undefined ? {} : { messageId: args.messageId }),
						...(args.blocks === undefined ? {} : { blocks: args.blocks as ContentBlock[] }),
						...(args.attachments === undefined ? {} : { attachments: args.attachments }),
					},
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
		const catalog = models.getModels().map((model) => ({ provider: model.provider, modelId: model.id, input: [...model.input] }));
		const state = {
			catalog: self.state("catalog", Catalog, catalog),
			configuration: self.state("configuration", ConfigurationSchema, { model: null, thinkingLevel: "off" }),
		};
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
		// Seed and refresh the head's configuration; the head only changes via a switch, so re-read on a thread change.
		self.task(async (ctx) => {
			const threadsWatch = await harness.watchDoc(ThreadsDoc, BACKGROUND_CONTEXT);
			const refresh = async (): Promise<void> => state.configuration.replace(ctx, await readConfiguration(), { diff: true });
			threadsWatch?.start(async () => refresh());
			try {
				await refresh();
				await untilAborted(ctx.signal);
			} finally {
				await threadsWatch?.stop().catch(() => {});
			}
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
