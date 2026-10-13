// The built-in base system prompt: what the model is and where it runs. Rendered from the conversation's own agent
// and env; tools describe themselves as tool definitions. Stable per conversation, so prompt caches stay warm.
import { arch, platform } from "node:os";
import { defineExtension, section } from "@earendil-works/pi-durable";

export const BasePrompt = defineExtension({
	name: "pi-durable-t3",
	sections: [
		section("base", (input) => {
			const cwd = input.env?.cwd ?? input.agent.cwd ?? "(unknown)";
			return [
				"You are a coding agent. Act on requests; do not just describe an answer.",
				`Working directory: ${cwd}.`,
				`Platform: ${platform()} ${arch()}.`,
			].join("\n");
		}),
	],
});
