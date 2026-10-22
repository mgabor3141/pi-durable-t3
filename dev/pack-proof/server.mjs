// An outside integrator in ~15 lines: a faux-model Harness, attachT3, a pairing link. Run from the consumer dir.
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { attachT3, mintPairingCode } from "@mgabor3141/pi-durable-t3";
import { mkdirSync, writeFileSync } from "node:fs";
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
// One registered project (the registry is the bridge's `projects.json`; T3 shows its first-run wizard without any).
mkdirSync(join(dir, "alpha"), { recursive: true });
mkdirSync(stateDir, { recursive: true });
writeFileSync(join(stateDir, "projects.json"), JSON.stringify({ projects: [{ path: join(dir, "alpha"), title: "alpha" }] }));
const t3 = await attachT3(harness, { models, stateDir, scratchDir: join(dir, "scratch"), listen: { host: "127.0.0.1", port } });
await harness.resume();
console.log(`READY http://127.0.0.1:${port}/pair#token=${mintPairingCode(stateDir).code}`);
process.on("SIGTERM", () => void t3.close().then(() => process.exit(0)));
await t3.closed;
