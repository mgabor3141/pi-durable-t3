// A system prompt that changes while a thread goes on is said in the thread: pi-durable writes `pi.system` entries
// where the conversation is, and the projection shows a quiet row there, among the run's work, that opens to the lines
// that differ. A change is the difference between one prompt in effect and the next, however it was written: the
// prompt's first rendering and a prompt rendered again the same are none.
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

type Row = { type: string; title?: string; toolName?: string; output?: string; runId: string | null };
const rows = (entries: EntryRecord[], with_: Partial<ThreadMeta> = {}) => projectThread({ ...meta, ...with_ }, view(entries), { rolledBack: [] }).projection.turnItems as unknown as Row[];
const updates = (entries: EntryRecord[], with_: Partial<ThreadMeta> = {}) => rows(entries, with_).flatMap((item) => (item.toolName === "system_prompt" ? [[item.title, item.runId]] : []));

const prompt = { preamble: "P", "global-agents": "Rule one.", "global-skills": "S" };
const first = [user(1, "one"), system(2, prompt), assistant(3, "ok")];

it("says which sections changed, in the run where they did, as a row of its work that opens to the lines that differ", () => {
	expect(updates(first), "the first rendering is not a change").toEqual([]);
	const changed = [...first, user(4, "two"), system(5, { "global-agents": "Rule one.\nRule two." }), assistant(6, "ok")];
	expect(updates(changed)).toEqual([["System prompt updated: global-agents", "r4"]]);
	// A section that appears, and one that is taken out.
	expect(updates([...changed, user(7, "three"), system(8, { "local-agents": "Local.", "global-skills": null }), assistant(9, "ok")]).at(-1)).toEqual(["System prompt updated: local-agents (added), global-skills (removed)", "r7"]);
	// A row like a tool's, in order: the user's message, the row, the answer. Never T3's notice, which is a warning.
	const run = rows(changed).filter((item) => item.runId === "r4");
	expect(run.map((item) => item.type)).toEqual(["user_message", "dynamic_tool", "assistant_message"]);
	expect(run[1]!.output).toContain("global-agents:\n+ Rule two.");
	expect(run[1]!.output).not.toContain("Rule one.");
});

it("the host's words for a change are the row's", () => {
	const changed = [...first, user(4, "two"), system(5, { "global-agents": "Rule two." }), assistant(6, "ok")];
	const seen: unknown[] = [];
	const promptUpdateTitle: ThreadMeta["promptUpdateTitle"] = (changes) => (seen.push(changes), "AGENTS.md changed");
	expect(updates(changed, { promptUpdateTitle })).toEqual([["AGENTS.md changed", "r4"]]);
	expect(seen[0]).toEqual([{ key: "global-agents", before: "Rule one.", after: "Rule two." }]);
	expect(updates(changed, { promptUpdateTitle: () => undefined })).toEqual([["System prompt updated: global-agents", "r4"]]);
});

it("a prompt written again says what differs from the one before, and nothing when nothing does", () => {
	const cleared = { preamble: null, "global-agents": null, "global-skills": null };
	// `/reload` with nothing changed: every section taken out, then given back the same.
	expect(updates([...first, system(4, cleared), user(5, "two"), system(6, prompt), assistant(7, "ok")])).toEqual([]);
	// With a changed file, and one that is gone.
	expect(updates([...first, system(4, cleared), user(5, "two"), system(6, { preamble: "P", "global-agents": "Rule two." }), assistant(7, "ok")])).toEqual([["System prompt updated: global-agents, global-skills (removed)", "r5"]]);
	// A section that comes to stand before others: pi-durable takes every section out and writes them all again, in
	// order. One row, for the section that is new.
	const reordered = [...first, user(4, "two"), system(5, cleared), system(6, { preamble: "P", "mcp-servers": "M", "global-agents": "Rule one.", "global-skills": "S" }), assistant(7, "ok")];
	expect(updates(reordered)).toEqual([["System prompt updated: mcp-servers (added)", "r4"]]);
});

it("a compaction's prompt is compared with the one before it, and starts from nothing", () => {
	// The same prompt written again after a compaction is no change; a file that changed meanwhile is one.
	expect(updates([...first, compaction(4, 3), user(5, "two"), system(6, prompt), assistant(7, "ok")])).toEqual([]);
	expect(updates([...first, compaction(4, 3), user(5, "two"), system(6, { ...prompt, "global-agents": "Rule two." }), assistant(7, "ok")])).toEqual([["System prompt updated: global-agents", "r5"]]);
	// A section the prompt had before a compaction and not after it is gone: a later change is not read against it.
	// (This was shown as six sections removed, when a server was added to a prompt that once had some.)
	const before = [user(1, "one"), system(2, { ...prompt, "mcp-servers": "M" }), assistant(3, "ok"), compaction(4, 3), user(5, "two"), system(6, prompt), assistant(7, "ok")];
	expect(updates(before)).toEqual([["System prompt updated: mcp-servers (removed)", "r5"]]);
	const cleared = { preamble: null, "global-agents": null, "global-skills": null };
	const again = [...before, user(8, "three"), system(9, cleared), system(10, { preamble: "P", "mcp-servers": "M2", "global-agents": "Rule one.", "global-skills": "S" }), assistant(11, "ok")];
	expect(updates(again)).toEqual([
		["System prompt updated: mcp-servers (removed)", "r5"],
		["System prompt updated: mcp-servers (added)", "r8"],
	]);
});
