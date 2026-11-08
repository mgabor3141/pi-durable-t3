// Boot the T3 facet: the auth store, model catalog and bridge (over the threads layer), then the Effect HTTP/`/ws` server.
import { createServer } from "node:http";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { Models } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import type { Threads } from "../threads.ts";
import { AuthStore } from "./auth.ts";
import { Attachments } from "./attachments.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Bridge } from "./bridge.ts";
import type { BridgeConfig } from "./config.ts";
import { makeServerLayer } from "./http.ts";
import { PreviewSessions } from "./preview.ts";
import type { Logger } from "./logging.ts";
import { WorkspaceFiles } from "./files.ts";
import { WorkspaceAssets } from "./workspace-assets.ts";
import type { ModelCatalog } from "./models.ts";
import { ScheduledTasks, scheduledTaskDispatch } from "./scheduled-tasks.ts";
import { ThreadOps } from "./thread-ops.ts";
import { SecretRequests } from "./secret-requests.ts";
import type { SecretSink } from "./secret-sink.ts";
import { threadToolsExtension } from "./thread-tools.ts";
import { Orchestration } from "./orchestration.ts";
import type { TextGenerationModel } from "./title-thread.ts";
import type { TailscaleCli } from "./tailscale.ts";

type FacetHandle = {
	/** Resolves with the port the listener ACTUALLY got, once it is listening; rejects with the bind error (e.g.
	 * `EADDRINUSE`). The bound port, not the configured one: with port 0 the two differ, and Tailscale Serve must be
	 * pointed at the socket that is really open. */
	readonly ready: Promise<number>;
	/** Resolves when the server fiber ENDS on its own after `ready`; what to do about it is the integrator's policy —
	 * the library never kills the process. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
	/** A user rename of a thread (`T3Attachment.setTitle`). */
	setTitle(threadId: string, title: string): Promise<void>;
	/** The `request_secret` tool, saving into `sink` (`T3Attachment.secretRequests`). */
	secretRequests(sink: SecretSink): Extension;
	/** The thread tools as an extension (`T3Attachment.threadTools`). */
	threadTools(options?: { readonly callers?: readonly ("model" | "tools")[] }): Extension;
	readonly orchestration: Orchestration;
	/** T3's text-generation model, when it names one of this host's (`Bridge.textGenerationModel`). */
	textGenerationModel(): TextGenerationModel | undefined;
	/** The preview browser, when configured. */
	readonly preview?: PreviewSessions;
};

export function startFacet(deps: {
	threads: Threads;
	models: Models;
	catalog: ModelCatalog;
	log: Logger;
	config: BridgeConfig;
	tailscale: TailscaleCli;
}): FacetHandle {
	const { catalog, log, config } = deps;
	const auth = new AuthStore(config.stateDir, { tokenTtlSeconds: config.tokenTtlSeconds });
	// Attachments live in the environment (`attachmentsDir`); their URLs are signed with the auth store's durable key.
	// Without a dir, the host takes none.
	const attachments =
		config.attachmentsDir === undefined || config.env === undefined
			? undefined
			: new Attachments({ stateDir: config.stateDir, signer: auth, env: config.env, dir: config.attachmentsDir, context: config.context ?? BACKGROUND_CONTEXT });

	const bridge = new Bridge(config, log, deps.threads, deps.models, attachments);
	const preview = config.preview === undefined ? undefined : new PreviewSessions(config.preview, log);
	// Read before the host is ready (tasks the host cannot read stop it), polled while the facet runs.
	const scheduledTasks = new ScheduledTasks({ harness: deps.threads.harness, dispatch: scheduledTaskDispatch(bridge), log });
	bridge.start();
	scheduledTasks.start();
	// T3 deletes the tasks bound to a deleted thread (the thread deletion's `scheduled-tasks.cleanup` effect).
	bridge.onThreadDeleted((threadId) => {
		void scheduledTasks.deleteForThread(threadId).catch((error: unknown) =>
			log.warn("could not delete the scheduled tasks of a deleted thread", { threadId, error: error instanceof Error ? error.message : String(error) }),
		);
		void preview?.closeThread(threadId).catch((error: unknown) =>
			log.warn("could not close the preview tabs of a deleted thread", { threadId, error: error instanceof Error ? error.message : String(error) }),
		);
	});

	// Bind eagerly: await "listening" before the host prints "ready", and surface a bind error to the caller. Keep the
	// launch fiber — `close()` interrupts it to release the port.
	const httpServer = createServer();
	const ready = new Promise<number>((resolve, reject) => {
		httpServer.once("listening", () => {
			const address = httpServer.address();
			// A listener that is up has an address; anything else is a broken contract, not a port to hand to Serve.
			if (typeof address === "object" && address !== null) resolve(address.port);
			else reject(new Error("HTTP server is listening with no bound address."));
		});
		httpServer.once("error", (error) => reject(error));
	});
	if (config.env === undefined) throw new Error("pi-durable-t3: attachT3 requires an execution environment.");
	const secretRequests = new SecretRequests((conversationId) => bridge.threadIdForConversation(conversationId));
	// Threads that drive threads (`thread_prompt` and the rest); its followers deliver the reports the last process owed.
	const orchestration = new Orchestration(bridge, log);
	orchestration.start();
	const files = new WorkspaceFiles({ env: config.env, ...(config.context === undefined ? {} : { context: config.context }), roots: () => bridge.workspaceRoots() });
	const assets = new WorkspaceAssets({ env: config.env, ...(config.context === undefined ? {} : { context: config.context }), roots: () => bridge.workspaceRoots(), signer: auth });
	const serverFiber = Effect.runFork(Layer.launch(makeServerLayer({ bridge, auth, catalog, log, httpServer, attachments, assets, scheduledTasks, tailscale: deps.tailscale, files, preview, secretRequests })) as Effect.Effect<never>);
	let closing = false;
	// Armed only after `ready` (a bind failure rejects `ready` instead): a server that stops serving is the integrator's
	// call, never the library's.
	const closed = new Promise<void>((resolve) => {
		void ready.then(() =>
			void Effect.runPromise(Fiber.await(serverFiber) as Effect.Effect<unknown>).then(() => {
				if (closing) return;
				log.warn("t3 facet stopped; the host cannot serve");
				resolve();
			}),
		);
	});

	return {
		// Ready once listening and once the scheduled tasks are read: a host that cannot read its tasks does not start.
		ready: Promise.all([ready, scheduledTasks.load()]).then(([port]) => port),
		closed,
		...(preview === undefined ? {} : { preview }),
		setTitle: async (threadId, title) => {
			await bridge.loaded();
			await bridge.renameThread(threadId, title);
		},
		secretRequests: (sink) => secretRequests.extension(sink),
		threadTools: (options) => threadToolsExtension(bridge, orchestration, { ...options, ops: new ThreadOps(bridge, auth.environmentId, log, scheduledTasks) }),
		orchestration,
		textGenerationModel: () => bridge.textGenerationModel(),
		close: async () => {
			closing = true;
			orchestration.close();
			await scheduledTasks.stop();
			await preview?.closeAll();
			await files.close();
			await bridge.close();
			// Interrupting the launch fiber runs the server layer's finalizers, which close the listener and release the port.
			await Effect.runPromise(Fiber.interrupt(serverFiber) as Effect.Effect<never>);
		},
	};
}
