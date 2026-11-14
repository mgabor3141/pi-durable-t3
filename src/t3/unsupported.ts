// The refusals the UI shows verbatim, for a `/ws` method or a dispatched command this host does not implement.

/** T3 0.1.9's text generators: a model API named in T3's settings, for titles and other short texts. This host generates
 * those with one of pi's models, so one saved here would be picked in the UI and never used. */
export const TEXT_GENERATORS_UNSUPPORTED =
	"Text generators are not supported by pi-durable-t3. Add the model to pi (its models.json) and pick it as the text generation model.";

const UNSUPPORTED: Record<string, string> = {
	"runtime-request.respond": "pi runs without approvals; there is nothing to answer.",
	"provider.switch": "pi is the only provider.",
	"server.updateProvider": "This host does not update itself from T3: update it where it is installed.",
	"subagent.stop": "Stopping one subagent card is not supported by pi-durable-t3: a child is a thread of its own, so stop that thread.",
	// Self-update RPCs. The descriptor advertises no `serverSelfUpdate` capability, so a client offers a manual
	// relaunch command and never sends these; if one arrives (a hand-built client, a future default), refuse it
	// honestly: the bridge is not a T3 install and updates by updating itself on the host, not over the wire.
	"server.updateServer": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.updateServerWithProgress": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.commitDesktopUpdate": "This server is not supervised by the T3 Code desktop app; there is no desktop update to commit.",
	// T3 0.1.9.
	"server.listTextGeneratorModels": TEXT_GENERATORS_UNSUPPORTED,
	"orchestration.subscribePromptSuggestion": "Prompt suggestions come from Claude and Codex sessions; pi has none.",
	"server.reclaimDatabaseSpace": "pi-durable-t3 keeps no T3 database; its storage is pi-durable's.",
	"provider.auth.removeMethod": "pi's credentials are managed on the host, not from T3.",
};

/**
 * The refusal the UI shows verbatim: "yet" claims we intend to build it, so only the planned set says so and an
 * untriaged call is refused flatly (capabilities.md keeps the same statuses).
 */
export function unsupportedMessage(type: string): string {
	if (UNSUPPORTED[type] !== undefined) return UNSUPPORTED[type];
	if (type.startsWith("queued-") || type === "queue.resume") return "Editing queued messages is not supported by pi-durable-t3 yet.";
	return `${type} is not supported by pi-durable-t3.`;
}
