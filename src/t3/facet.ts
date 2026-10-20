// Boot the T3 facet beside the host's objects: the auth store, model catalog and bridge, then the Effect HTTP/`/ws`
// server. The bridge is a local client of the chord objects — no socket, no separate process.
import { createServer } from "node:http";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { Host } from "@earendil-works/chord";
import { AuthStore } from "./auth.ts";
import { AttachmentStore } from "./attachment-store.ts";
import { Bridge } from "./bridge.ts";
import type { BridgeConfig } from "./config.ts";
import { makeServerLayer } from "./http.ts";
import type { Logger } from "./logging.ts";
import type { ModelCatalog } from "./models.ts";
import { ScheduledTasks, scheduledTaskDispatch } from "./scheduled-tasks.ts";
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
};

export function startFacet(deps: {
	host: Host;
	catalog: ModelCatalog;
	log: Logger;
	config: BridgeConfig;
	tailscale: TailscaleCli;
}): FacetHandle {
	const { host, catalog, log, config } = deps;
	const auth = new AuthStore(config.stateDir, { tokenTtlSeconds: config.tokenTtlSeconds });
	// The image-attachment store lives under the bridge's dir and signs its URLs with the auth store's durable key.
	const attachments = new AttachmentStore(join(config.stateDir, "attachments"), auth);

	const bridge = new Bridge(config, log, host, attachments);
	// Opened at boot (a scheduled-tasks.json the host cannot read stops it here), polled while the facet runs.
	const scheduledTasks = new ScheduledTasks({ stateDir: config.stateDir, dispatch: scheduledTaskDispatch(bridge), log });
	bridge.start();
	scheduledTasks.start();

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
	const serverFiber = Effect.runFork(Layer.launch(makeServerLayer({ bridge, auth, catalog, log, httpServer, attachments, scheduledTasks, tailscale: deps.tailscale })) as Effect.Effect<never>);
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
		ready,
		closed,
		setTitle: async (threadId, title) => {
			await bridge.loaded();
			await bridge.renameThread(threadId, title);
		},
		close: async () => {
			closing = true;
			await scheduledTasks.stop();
			await bridge.close();
			// Interrupting the launch fiber runs the server layer's finalizers, which close the listener and release the port.
			await Effect.runPromise(Fiber.interrupt(serverFiber) as Effect.Effect<never>);
		},
	};
}
