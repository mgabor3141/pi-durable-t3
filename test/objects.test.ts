// Drives the chord2 objects in-process — the way the T3 bridge calls them: one host serves the objects over a real
// `Threads`, and we resolve handles on that same host, create a thread, prompt it, and watch the models and transcript
// cells update.
import { describe, expect, it } from "vitest";
import { createHost, isChordError } from "@earendil-works/chord";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PiController, PiModels, PiThreads, PiTranscript } from "../src/objects.ts";
import { createServerFacet } from "../src/objects.ts";
import { makeThreads } from "./threads-harness.ts";

type Cell<T> = { readonly value: T | undefined; subscribe(listener: (value: T | undefined) => void): () => void };

function waitFor<T>(cell: Cell<T>, predicate: (value: T | undefined) => boolean, ms = 8000): Promise<void> {
	return new Promise((resolve, reject) => {
		if (predicate(cell.value)) return resolve();
		const timer = setTimeout(() => {
			stop();
			reject(new Error("state did not arrive in time"));
		}, ms);
		const stop = cell.subscribe((value) => {
			if (predicate(value)) {
				clearTimeout(timer);
				stop();
				resolve();
			}
		});
	});
}

describe("objects (in-process)", () => {
	it("create, prompt, transcript, models, remove", async () => {
		const fixture = await makeThreads();
		const server = createHost({ name: "server" });
		await server.load([createServerFacet(fixture.threads, fixture.model.models)]);
		await server.ready();

		const directory = server.get(PiThreads, {});
		await directory.ready;

		// Create a thread and see it arrive through the eager directory cell.
		await server.root((ctx) => directory.create({ threadId: "t", projectId: "p" }, ctx));
		await waitFor(directory.threads, (value) => (value?.threads.length ?? 0) >= 1);
		const created = directory.threads.value?.threads.find((thread) => thread.threadId === "t");
		expect(created?.title, "a thread starts untitled; T3 sends no title on create").toBe("");
		const head = created?.head;
		expect(head).toBeTypeOf("number");

		// Prompt through the controller; the run should reach the transcript view for the same conversation.
		fixture.model.respond(fauxAssistantMessage("hi back"));
		const controller = server.get(PiController, { threadId: "t" });
		await controller.ready;
		await server.root((ctx) => controller.prompt({ conversationId: head!, requestId: "m1", message: "hi" }, ctx));

		const transcript = server.get(PiTranscript, { threadId: "t" });
		await transcript.ready;
		await waitFor(transcript.transcript, (value) => value?.conversationId === head && JSON.stringify(value?.view ?? "").includes("hi"));

		// The model catalog is the injected collection; selecting validates against it.
		const models = server.get(PiModels, { threadId: "t" });
		await models.ready;
		expect(models.catalog.value?.length).toBeGreaterThan(0);
		const faux = models.catalog.value!.find((entry) => entry.provider === "faux")!;
		await expect(server.root((ctx) => models.select({ provider: "nope", modelId: "x" }, ctx))).rejects.toSatisfy((error) => isChordError(error, "invalid"));
		const configured = await server.root((ctx) => models.select({ provider: faux.provider, modelId: faux.modelId }, ctx));
		expect(configured.model).toEqual({ provider: faux.provider, modelId: faux.modelId });

		// Remove drops it from the directory.
		await server.root((ctx) => directory.remove({ threadId: "t" }, ctx));
		await waitFor(directory.threads, (value) => (value?.threads.length ?? 0) === 0);

		await server.close();
	});
});
