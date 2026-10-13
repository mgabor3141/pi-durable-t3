// The server facet: serves the host objects over a `Threads` layer and the model catalog. The T3 bridge (`t3/bridge.ts`)
// loads beside it and calls these in-process.
import { defineFacet, type Facet } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type { Threads } from "./threads.ts";
import { serveServerObjects } from "./objects.ts";

export function createServerFacet(threads: Threads, models: Models): Facet {
	return { name: "pi-durable-t3", ...defineFacet((api) => serveServerObjects(api, threads, models)) };
}
