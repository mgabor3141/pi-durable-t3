// A system prompt that changes while a thread goes on is said in the thread: pi-durable writes a `pi.system` entry
// where the conversation is, and the projection shows T3's notice row there, naming the sections. The prompt's first
// rendering, a compaction's baseline and a prompt rendered again the same are not changes.
import { expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false };
const view = (entries: EntryRecord[]): ConversationView => ({ conversation: { id: 1 }, entries, docs: {} }) as unknown as ConversationView;
let at = 1_000;
const user = (id: number, text: string): EntryRecord => ({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: (at += 1_000) }] }) as unknown as EntryRecord;
const assistant = (id: number, text: string): EntryRecord => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: (at += 1_000) }] }) as unknown as EntryRecord;
const system = (id: number, sections: Record<string, string | null>): EntryRecord => ({ id, kind: "pi.system", model: [{ role: "system", content: "", sections, timestamp: (at += 1_000) }] }) as unknown as EntryRecord;
const compaction = (id: number, head: number): EntryRecord => ({ id, kind: "pi.compaction", head, model: [{ role: "user", content: [{ type: "text", text: "<summary>\ns\n</summary>" }], timestamp: (at += 1_000) }] }) as unknown as EntryRecord;

const notices = (entries: EntryRecord[]) =>
	projectThread(meta, view(entries), { rolledBack: [] }).projection.turnItems.flatMap((item) => ((item as unknown as { type: string }).type === "system_notice" ? [[(item as unknown as { message: string }).message, item.runId]] : []));

const first = [user(1, "one"), system(2, { preamble: "P", "global-agents": "Rule one.", "global-skills": "S" }), assistant(3, "ok")];

it("names the sections that changed, in the run where they did", () => {
	expect(notices(first), "the first rendering is not a change").toEqual([]);
	const changed = [...first, user(4, "two"), system(5, { "global-agents": "Rule two." }), assistant(6, "ok")];
	expect(notices(changed)).toEqual([["System prompt updated: global-agents", "r4"]]);
	// A section that appears, and one that is taken out.
	expect(notices([...changed, user(7, "three"), system(8, { "local-agents": "Local.", "global-skills": null }), assistant(9, "ok")]).at(-1)).toEqual(["System prompt updated: local-agents, global-skills (removed)", "r7"]);
	// The rows are in order: the user's message, the notice, the answer.
	const rows = projectThread(meta, view(changed), { rolledBack: [] }).projection.turnItems.filter((item) => item.runId === "r4").map((item) => (item as unknown as { type: string }).type);
	expect(rows).toEqual(["user_message", "system_notice", "assistant_message"]);
});

it("a prompt rendered again names what differs, and nothing when nothing does", () => {
	const cleared = { preamble: null, "global-agents": null, "global-skills": null };
	// `/reload` with nothing changed: every section taken out, then given back the same.
	expect(notices([...first, system(4, cleared), user(5, "two"), system(6, { preamble: "P", "global-agents": "Rule one.", "global-skills": "S" }), assistant(7, "ok")])).toEqual([]);
	// With a changed file, and one that is gone.
	expect(notices([...first, system(4, cleared), user(5, "two"), system(6, { preamble: "P", "global-agents": "Rule two." }), assistant(7, "ok")])).toEqual([["System prompt updated: global-agents, global-skills (removed)", "r5"]]);
	// A compaction's baseline is the prompt written again, not a change to it.
	expect(notices([...first, compaction(4, 3), user(5, "two"), system(6, { preamble: "P", "global-agents": "Rule two.", "global-skills": "S" }), assistant(7, "ok")])).toEqual([]);
	// After it, a change is one again.
	expect(notices([...first, compaction(4, 3), user(5, "two"), system(6, { preamble: "P", "global-agents": "Rule two.", "global-skills": "S" }), assistant(7, "ok"), user(8, "three"), system(9, { "global-skills": "S2" }), assistant(10, "ok")])).toEqual([["System prompt updated: global-skills", "r8"]]);
});
