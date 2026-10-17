// A deterministic, network-free model for the running example (`PI_DURABLE_T3_FAKE=1`): replies to every turn with
// fixed text. Used by the browser smoke so a prompt shows a reply offline. Not for tests (those use the scripted
// model directly).
import { createModels, fauxAssistantMessage, fauxProvider, type Models } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

type ReplyModel = {
	readonly models: Models;
	readonly modelRef: ModelRef;
};

export function createReplyModel(text = "OK — this is the offline reply model.", provider = "offline"): ReplyModel {
	// Two models, the way a real catalog has more than one: a reasoning one (so the offline demo shows the thinking
	// control pi-ai's levels drive, with a chosen level travelling the whole path to the conversation) and a plain one
	// (which declares no thinking control at all). The FIRST is the host's model — what a launch that names no
	// model runs on. The provider slug is deliberately NOT a prefix of the model ids: T3's picker strips a leading
	// sub-provider qualifier off the display name (`stripLeadingQualifier(shortName, subProvider)`), so a provider
	// "reply" would render the id "reply-1" as "1".
	const faux = fauxProvider({
		provider,
		models: [
			{ id: "reply-1", name: "Reply model", reasoning: true },
			{ id: "reply-2", name: "Reply model (no reasoning)", reasoning: false },
		],
	});
	const message = fauxAssistantMessage(text);
	// One canned reply per generation; a generous queue covers an interactive session.
	faux.setResponses(Array.from({ length: 256 }, () => message));
	const models = createModels();
	models.setProvider(faux.provider);
	const modelId = faux.models[0]!.id;
	return {
		models,
		modelRef: { provider, modelId },
	};
}
