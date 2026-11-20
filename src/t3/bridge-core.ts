// What a part of the bridge (limit recovery, idle compaction, …) is given of it: the thread directory, a thread's
// projection, and the things every part writes through. A part names the members it uses (`Pick<BridgeCore, …>`).
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import type { Thread, Threads } from "../threads.ts";
import type { BridgeConfig } from "./config.ts";
import type { Logger } from "./logging.ts";
import type { ChildCard, ProjectionResult, ThreadMeta } from "./projection.ts";
import type { ThreadNavigator } from "./thread-navigator.ts";
import type { ThreadView } from "./thread-view.ts";
import type { TextGenerationModel } from "./title-thread.ts";

export interface BridgeCore {
	readonly config: BridgeConfig;
	readonly log: Logger;
	readonly store: Threads;
	/** `/tree`: the tree of a thread's lines. */
	readonly navigator: ThreadNavigator;
	/** True once the bridge is closing: nothing new is started. */
	closed(): boolean;
	/** A thread's row of the directory, current after any awaited write. */
	thread(threadId: string): Thread | undefined;
	/** Every row of the directory. */
	threads(): readonly Thread[];
	/** Hold the thread open; the answer lets it go. */
	acquire(threadId: string): () => void;
	/** The thread's projection, once its transcript is loaded. */
	projection(threadId: string): Promise<ProjectionResult>;
	/** The thread's sidebar row, current whether or not the thread is open. */
	shell(threadId: string): OrchestrationV2ThreadShell;
	/** The thread's open view (opened by this). */
	view(threadId: string): ThreadView;
	/** Show a thread again after a change no projection follows (its title, a title request, its sidebar state). */
	republish(threadId: string): void;
	/** What a thread's projection is made with besides its transcript. */
	meta(threadId: string, view: ThreadView | undefined): ThreadMeta;
	/** The cards of the threads it started (T3's subagent rows), current whether or not any of them is open. */
	children(threadId: string): readonly ChildCard[];
	hasThread(threadId: string): boolean;
	/** T3's text-generation model, when it is one of this host's. */
	textGenerationModel(): TextGenerationModel | undefined;
}
