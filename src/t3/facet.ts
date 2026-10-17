// Boot the T3 facet beside the host's objects: the auth store, model catalog and bridge, then the Effect HTTP/`/ws`
// server. The bridge is a local client of the chord objects — no socket, no separate process.
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { Host } from "@earendil-works/chord";
import { AuthStore } from "./auth.ts";
import { Bridge } from "./bridge.ts";
import type { BridgeConfig } from "./config.ts";
import { makeServerLayer } from "./http.ts";
import type { Logger } from "./logging.ts";
import type { ModelCatalog } from "./models.ts";

type FacetHandle = {
	readonly auth: AuthStore;
	readonly bridge: Bridge;
	pairingCode(): string;
	pairingUrls(code: string): string[];
	/** Resolves once the HTTP server is listening; rejects with the bind error (e.g. `EADDRINUSE`) if it cannot start. */
	readonly ready: Promise<void>;
	/** Resolves when the server fiber ENDS on its own after `ready`; what to do about it is the integrator's policy —
	 * the library never kills the process. */
	readonly closed: Promise<void>;
	close(): Promise<void>;
};

export function startFacet(deps: {
	host: Host;
	catalog: ModelCatalog;
	log: Logger;
	config: BridgeConfig;
}): FacetHandle {
	const { host, catalog, log, config } = deps;
	const auth = new AuthStore(config.stateDir, { ...(config.pairingToken === undefined ? {} : { pairingToken: config.pairingToken }), tokenTtlSeconds: config.tokenTtlSeconds });

	const bridge = new Bridge(config, log, host);
	bridge.start();

	// Bind eagerly: await "listening" before the host prints "ready", and surface a bind error to the caller. Keep the
	// launch fiber — `close()` interrupts it to release the port.
	const httpServer = createServer();
	const ready = new Promise<void>((resolve, reject) => {
		httpServer.once("listening", () => resolve());
		httpServer.once("error", (error) => reject(error));
	});
	const serverFiber = Effect.runFork(Layer.launch(makeServerLayer({ bridge, auth, catalog, log, httpServer })) as Effect.Effect<never>);
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

	const pairingCode = (): string => auth.createPairingCode();
	const pairingUrls = (code: string): string[] => {
		const hosts =
			config.host === "0.0.0.0" || config.host === "::"
				? Object.values(networkInterfaces())
						.flat()
						.filter((n) => n !== undefined && n.family === "IPv4" && !n.internal)
						.map((n) => n!.address)
				: [config.host];
		return hosts.map((h) => `http://${h}:${config.port}/pair#token=${code}`);
	};

	return {
		auth,
		bridge,
		pairingCode,
		pairingUrls,
		ready,
		closed,
		close: async () => {
			closing = true;
			await bridge.close();
			// Interrupting the launch fiber runs the server layer's finalizers, which close the listener and release the port.
			await Effect.runPromise(Fiber.interrupt(serverFiber) as Effect.Effect<never>);
		},
	};
}
