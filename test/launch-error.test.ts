// `orchestration.launchThread` failures answer with the contract's TYPED error — decodable, naming the
// project (review store #3, carried forward from round one). The RPC's success schema is
// `OrchestrationV2ThreadLaunchResult`; its declared failure is `OrchestrationV2ThreadLaunchError`, whose
// payload is `{ commandId, projectId, message, cause? }`. The handler built it from a catch-all message and
// cast away the checker (`as Any`), shipping `{commandId, message}` — no `projectId`. A Fail frame carrying
// that payload is not a `OrchestrationV2ThreadLaunchError`: the encode fails at the boundary, and the frame
// that reaches a strict client is a Defect — the RPC that answers "did the launch work?" answers with
// garbage.
//
// The probe drives a real host over `/ws` and asks for a launch in a project that is not registered. The
// refusal must arrive as a Failure exit whose value DECODES against the vendored schema — and the success
// path must keep answering the result schema, so the probe pins the pair.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { Schema } from "effect";
import { OrchestrationV2ThreadLaunchError, OrchestrationV2ThreadLaunchResult } from "@t3tools/contracts";
import { connectWs, exitError, exitValue, pair, waitListening } from "./ws-rpc.ts";
import { launch, type Launched } from "./host-process-harness.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-launch-"));
const agentDir = join(scratch, "agent");
await mkdir(agentDir, { recursive: true });
const launched: Launched[] = [];
afterAll(async () => {
	for (const host of launched) host.child.kill("SIGKILL");
	await Promise.allSettled(launched.map((host) => host.exited));
	await rm(scratch, { recursive: true, force: true });
});

const TOKEN = "probe-token-launch-0123456789ab";

it("launchThread: an unregistered project refuses with the decodable typed error naming the project; a registered one answers the result", async () => {
	const port = 4945;
	const root = join(scratch, "host");
	const projectDir = join(root, "projects", "real");
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, ".keep"), "real project\n", "utf8");
	await writeFile(join(root, "config.toml"), `listen = "127.0.0.1:${port}"\n`, "utf8");
	await writeFile(
		join(root, "settings.json"),
		JSON.stringify({ projects: [{ id: "p-registered-1", title: "Real", path: projectDir }], defaults: {} }),
		"utf8",
	);
	const host = launch(root, port, { PI_DURABLE_T3_PAIRING_TOKEN: TOKEN }, agentDir);
	launched.push(host);
	expect(await waitListening(port), `the host booted: ${host.out()}`).toBe(true);

	const bearer = await pair(port, TOKEN);
	const ws = await connectWs(port, bearer);
	try {
		const providers = exitValue(await ws.call("server.refreshProviders", {}), "server.refreshProviders") as { providers: { instanceId: string; models: { slug: string }[] }[] };
		const provider = providers.providers.find((entry) => entry.models.length > 0);
		expect(provider, `the host's catalog has a model: ${JSON.stringify(providers).slice(0, 400)}`).toBeDefined();
		const modelSelection = { instanceId: provider!.instanceId, model: provider!.models[0]!.slug };

		// The refusal: a launch into a project that is NOT registered.
		const failure = exitError(await ws.call("orchestration.launchThread", {
			commandId: "cmd-launch-ghost",
			threadId: "launch-ghost",
			projectId: "p-never-registered",
			title: "Ghost",
			modelSelection,
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
		}), "launchThread into a project that is not registered");
		// The frame's value must BE the contract's error: decode it with the vendored schema, in the form the
		// wire carries (the JSON codec — e.g. `DateTimeUtc` is an ISO string in JSON, a `DateTime` instance in
		// the Type domain). Pre-fix the handler's `as Any` shipped `{commandId, message}` — the encode failed
		// at the boundary and the frame was a Defect, which `exitError` above already refuses; this decode is
		// the schema-level pin on the payload shape.
		const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadLaunchError))(failure);
		expect(decoded.projectId, "the refusal names the project the client asked about").toBe("p-never-registered");
		expect(decoded.commandId).toBe("cmd-launch-ghost");
		expect(String(decoded.message), "the refusal's message names the same project the payload does").toContain("p-never-registered");

		// The success path: the same RPC into a registered project answers the RESULT schema.
		const ok = exitValue(await ws.call("orchestration.launchThread", {
			commandId: "cmd-launch-real",
			threadId: "launch-real",
			projectId: "p-registered-1",
			title: "Real",
			modelSelection,
			runtimeMode: "full-access",
			interactionMode: "default",
			workspaceStrategy: { type: "root" },
		}), "launchThread into a registered project");
		Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadLaunchResult))(ok);
		expect((ok as { threadId: string }).threadId).toBe("launch-real");
	} finally {
		ws.close();
		host.child.kill("SIGKILL");
	}
}, 60_000);
