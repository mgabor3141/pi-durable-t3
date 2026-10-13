// Scaffolding proof: the scripted model drives a real durable Harness turn to completion, with no network and no key.
// This is also the guard that vitest, the installed pi packages, and the shared `chord` copy work together.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { createScriptedModel } from "../src/testing/fake-model.ts";

const context = BACKGROUND_CONTEXT;

test("a scripted model drives a Harness turn to done", async () => {
	const model = createScriptedModel([fauxAssistantMessage("hello back")]);
	const harness = await Harness.open(new MemoryStorage(), { models: model.models, registry: createRegistry() }, context);
	try {
		const root = await harness.root(context, { agent: { model: model.modelRef } });
		const submission = await root.submit({ type: "input", requestId: "s1", content: "hi" }, context);
		const settled = await submission.wait(context);
		expect(settled.status).toBe("done");

		const entries = (await root.entries({}, 100, undefined, context)).items;
		expect(entries.filter((entry) => UserEntry.is(entry))).toHaveLength(1);
		expect(model.faux.state.callCount).toBe(1);
	} finally {
		await harness.close(context);
	}
});
