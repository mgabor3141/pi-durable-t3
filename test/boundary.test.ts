// The separation boundary, enforced: `src/` is the bridge library, and it must never name the agent — not a model
// runtime, a credential store, a prompt, a canned model, or the coding-agent package. The example
// (`examples/coding-agent/`) owns all of that. This is the rule the split exists to make structural, so it is a test,
// not a comment.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const SRC = new URL("../src", import.meta.url).pathname;

/** Tokens the bridge may never contain: agent-side names, verbatim. */
const FORBIDDEN = ["pi-coding-agent", "PI_CODING_AGENT_DIR", ".pi/agent", "ModelRuntime", "createReplyModel", "CodingTools", "NodeExecutionEnv", "instructions"] as const;

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...tsFiles(path));
		else if (entry.endsWith(".ts")) out.push(path);
	}
	return out;
}

it("src/ never names the agent (no coding-agent package, credentials, prompt, tools, env, canned model)", () => {
	const hits: string[] = [];
	for (const file of tsFiles(SRC)) {
		const lines = readFileSync(file, "utf8").split("\n");
		lines.forEach((line, index) => {
			// ONE named exception: `agentCopy` passes pi-durable's own `pi.agent` fields through verbatim (the
			// undo-to-baseline fork inherits the head's configuration, prompt text included). That is pi's field
			// name on a copy path, not the bridge owning a prompt — the bridge has no prompt option anywhere.
			if (line.includes("agent.instructions")) return;
			for (const token of FORBIDDEN) {
				if (line.includes(token)) hits.push(`${relative(SRC, file)}:${index + 1}: ${token}`);
			}
		});
	}
	expect(hits, `forbidden tokens in src/:\n${hits.join("\n")}`).toEqual([]);
});
