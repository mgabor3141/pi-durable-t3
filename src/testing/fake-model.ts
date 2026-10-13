// A scripted, network-free model for tests: pi-ai's faux provider over its own `Models` collection. Queue responses;
// the model replays them one per generation, in order. Nothing here reads `~/.pi` or the network.
import type { FauxResponseStep, FauxProviderHandle, Models } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export type ScriptedModel = {
	/** Pass to `Harness.open` as `models`. */
	readonly models: Models;
	/** `{ provider: "faux", modelId: "faux-1" }` — select it in a conversation's agent. */
	readonly modelRef: ModelRef;
	/** Replace the queued responses. */
	respond(...steps: FauxResponseStep[]): void;
	/** Queue more responses after the ones already pending. */
	append(...steps: FauxResponseStep[]): void;
	/** Drop the queue and reset the call counter bookkeeping the provider exposes. */
	reset(): void;
	/** Direct access, for a test that needs `state` or a specific model id. */
	readonly faux: FauxProviderHandle;
};

const PROVIDER = "faux";

// Re-export the response builders so a test scripts a model with just this module and `@earendil-works/pi-ai` types.
export function createScriptedModel(steps: FauxResponseStep[] = [], options: { readonly tokensPerSecond?: number } = {}): ScriptedModel {
	// A low `tokensPerSecond` keeps a response streaming long enough to observe a running turn mid-flight.
	const faux = fauxProvider({ provider: PROVIDER, ...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }) });
	faux.setResponses(steps);
	const models = createModels();
	models.setProvider(faux.provider);
	const modelRef: ModelRef = { provider: PROVIDER, modelId: faux.models[0].id };
	return {
		models,
		modelRef,
		respond: (...next) => faux.setResponses(next),
		append: (...next) => faux.appendResponses(next),
		reset: () => faux.setResponses([]),
		faux,
	};
}
