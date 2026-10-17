// The example's prompt: one extension with a `base` section (what the model is, where it runs — rendered from the
// conversation's own agent and env, stable per conversation so prompt caches stay warm) and, when an instructions
// file is configured, an `instructions` section carrying that file's text. Tools describe themselves as tool
// definitions; nothing here is a bridge option.
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

/** The coding-agent prompt extension. With `instructionsPath` the file's text is an extra prompt section. */
export function CodingExtension(instructionsPath?: string): Extension {
	return defineExtension({
		name: "coding-agent",
		sections: [
			section("base", (input) => {
				const cwd = input.env?.cwd ?? input.agent.cwd ?? "(unknown)";
				return [
					"You are a coding agent. Act on requests; do not just describe an answer.",
					`Working directory: ${cwd}.`,
					`Platform: ${platform()} ${arch()}.`,
				].join("\n");
			}),
			// The optional instructions file: read at render, so an edit takes effect from the next generation.
			...(instructionsPath === undefined ? [] : [section("repo-instructions", () => readFileSync(instructionsPath, "utf8"))]),
		],
	});
}
