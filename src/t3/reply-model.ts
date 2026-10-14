// A deterministic, network-free model for the running host (`PI_DURABLE_T3_FAKE=1`): replies to every turn with fixed text.
// Used by the browser smoke so a prompt shows a reply offline. Not for tests (those use the scripted model directly).
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

type ReplyModel = {
	readonly models: Models;
	readonly modelRef: ModelRef;
	readonly catalog: { provider: string; modelId: string; name: string; reasoning: boolean }[];
};

export function createReplyModel(text = "OK — this is the offline reply model.", provider = "reply"): ReplyModel {
	const faux = fauxProvider({ provider });
	const message = fauxAssistantMessage(text);
	// One canned reply per generation; a generous queue covers an interactive session.
	faux.setResponses(Array.from({ length: 256 }, () => message));
	const models = createModels();
	models.setProvider(faux.provider);
	const modelId = faux.models[0]!.id;
	return {
		models,
		modelRef: { provider, modelId },
		catalog: faux.models.map((model) => ({ provider, modelId: model.id, name: model.name ?? model.id, reasoning: false })),
	};
}
