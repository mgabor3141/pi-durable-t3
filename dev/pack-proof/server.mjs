// An outside integrator in ~15 lines: a faux-model Harness, attachT3, a pairing link. Run from the consumer dir.
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { attachT3, mintPairingCode } from "@mgabor3141/pi-durable-t3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [dir, port] = [process.argv[2], Number(process.argv[3])];
mkdirSync(dir, { recursive: true });
const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux one" }] });
faux.setResponses(Array.from({ length: 16 }, () => fauxAssistantMessage("packed reply: hello from the tarball")));
const models = createModels();
models.setProvider(faux.provider);

const storage = await openNodeSqliteStorage(join(dir, "durable.db"));
const harness = await Harness.open(storage, { models, registry: createRegistry(), env: () => { throw new Error("no tools"); } }, BACKGROUND_CONTEXT);
const stateDir = join(dir, "t3");
mkdirSync(join(dir, "alpha"), { recursive: true });
// The environment T3 reads, writes and runs in (required): this machine, paths from the root.
const t3 = await attachT3(harness, { models, env: new NodeExecutionEnv({ cwd: "/" }), stateDir, scratchDir: join(dir, "scratch"), listen: { host: "127.0.0.1", port } });
await harness.resume();
// One project (T3 shows its first-run wizard without any), added as a T3 client adds it: pair, then `project.create`.
const base = `http://127.0.0.1:${port}`;
const { access_token } = await (await fetch(`${base}/oauth/token`, {
	method: "POST",
	body: new URLSearchParams({
		grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
		subject_token: mintPairingCode(stateDir).code,
		subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
		requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
	}),
})).json();
const created = await fetch(`${base}/api/projects/mutate`, {
	method: "POST",
	headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" },
	body: JSON.stringify({ type: "project.create", commandId: "pack-proof-alpha", projectId: crypto.randomUUID(), title: "alpha", workspaceRoot: join(dir, "alpha") }),
});
if (!created.ok) throw new Error(`adding the project failed: ${created.status} ${await created.text()}`);
console.log(`READY http://127.0.0.1:${port}/pair#token=${mintPairingCode(stateDir).code}`);
process.on("SIGTERM", () => void t3.close().then(() => process.exit(0)));
await t3.closed;
