// The refusals the UI shows verbatim, for a `/ws` method or a dispatched command this host does not implement.

const UNSUPPORTED: Record<string, string> = {
	"thread.merge_back": "Merging a fork back is not supported by pi-durable-t3 yet.",
	"thread.archive": "Archiving is not supported by pi-durable-t3 yet.",
	"orchestration.subscribeArchivedShell": "Archiving is not supported by pi-durable-t3 yet: there is nothing to list.",
	"orchestration.getArchivedShellSnapshot": "Archiving is not supported by pi-durable-t3 yet: there is nothing to list.",
	"thread.unarchive": "Archiving is not supported by pi-durable-t3 yet.",
	"thread.snooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"thread.unsnooze": "Snoozing is not supported by pi-durable-t3 yet.",
	"runtime-request.respond": "pi runs without approvals; there is nothing to answer.",
	"provider.switch": "pi is the only provider.",
	"subagent.stop": "Stopping one subagent card is not supported by pi-durable-t3: a child is a thread of its own, so stop that thread.",
	// Self-update RPCs. The descriptor advertises no `serverSelfUpdate` capability, so a client offers a manual
	// relaunch command and never sends these; if one arrives (a hand-built client, a future default), refuse it
	// honestly: the bridge is not a T3 install and updates by updating itself on the host, not over the wire.
	"server.updateServer": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.updateServerWithProgress": "pi-durable-t3 does not self-update. Update pi-durable-t3 and re-run `pnpm setup:t3` on the host.",
	"server.commitDesktopUpdate": "This server is not supervised by the T3 Code desktop app; there is no desktop update to commit.",
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
