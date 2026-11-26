// T3's command ingress over this host: `orchestration.dispatchCommand`'s commands (`OrchestrationV2Command`), applied with
// the provenance of whoever sent them. The `/ws` adapter sends a person's commands (`user`, the client's surface); an
// agent's tools will send their own. One place maps a command to the bridge, as T3's `ThreadManagementService.dispatch`
// is the one place both its WebSocket and its MCP server go through.
import { DateTime } from "effect";
import type { Bridge } from "./bridge.ts";
import { CommandError } from "./bridge.ts";
import type { Logger } from "./logging.ts";
import { unsupportedMessage } from "./unsupported.ts";
import type { WsPayload } from "./ws-types.ts";
import type { Provenance } from "../threads.ts";

/** A dispatched command, as the contract decoded it. */
export type DispatchCommand = WsPayload<"orchestration.dispatchCommand">;

/** Commands acknowledged without host state: the receipt T3's server writes once a child's report was handed to the
 * parent's provider (`EffectWorker.ts`), which no client sends. Everything else unknown fails. */
const SIDEBAR_NO_OPS = new Set(["notification.delivery.accept"]);

/** The image and file attachments of a command (the persisted records the client sent), shaped for
 * `Bridge.sendMessage`. Unknown attachment types are dropped. */
export function attachmentRecords(attachments: unknown): { type?: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number }[] | undefined {
	if (!Array.isArray(attachments)) return undefined;
	const records = attachments
		.filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && typeof a.id === "string" && (a.type === "image" || a.type === "file"))
		.map((a) => ({ type: a.type as "image" | "file", id: a.id as string, name: String(a.name ?? (a.type === "file" ? "file" : "image")), mimeType: String(a.mimeType ?? "application/octet-stream"), sizeBytes: Number(a.sizeBytes ?? 0) }));
	return records.length > 0 ? records : undefined;
}

/** The provenance T3's WebSocket gives a person's command: the client's own `creationSource` when the command carries
 * one, else the web app (`ws.ts`, `withCreationProvenance`). */
export function clientProvenance(command: DispatchCommand): Provenance {
	const source = "creationSource" in command ? (command as { creationSource?: Provenance["creationSource"] }).creationSource : undefined;
	return { createdBy: "user", creationSource: source ?? "web" };
}

/** Apply one command once per `commandId` — durably, through the host's receipts — and answer the sequence the client
 * orders its stream by. */
export function dispatchCommand(bridge: Bridge, command: DispatchCommand, provenance: Provenance, log: Logger): Promise<number> {
	return bridge.receipted(command.commandId, async () => {
		switch (command.type) {
			case "message.dispatch": {
				// T3 0.1.9's "start a new provider session without the thread's earlier context" (its /clear). The descriptor
				// does not advertise `freshContext`, so T3's client does not send it; a caller that does is told, since
				// sending the message with the old context would be the opposite of what it asked.
				if (command.freshContext === true) throw new CommandError("freshContext is not supported by pi-durable-t3: a thread keeps its context. Start a new thread instead.");
				await bridge.applySelection(command.threadId, command.modelSelection);
				// With serverResolvedCommandContext the client sends start_immediately plus a deliveryIntent
				// (steer/restart/auto); queued sends are queue_after_active. Older clients name the mode directly.
				const modeType = command.dispatchMode?.type ?? "start_immediately";
				const intent = command.deliveryIntent;
				const mode =
					modeType === "steer_active" || intent === "steer" || intent === "auto"
						? "steer"
						: modeType === "restart_active" || intent === "restart"
							? "restart"
							: modeType === "queue_after_active"
								? "queue"
								: "start";
				const attachments = attachmentRecords(command.attachments);
				await bridge.sendFromOutside({
					threadId: command.threadId,
					commandId: command.commandId,
					messageId: command.messageId,
					text: command.text,
					mode,
					provenance,
					...(typeof command.titleSeed === "string" ? { titleSeed: command.titleSeed } : {}),
					...(attachments === undefined ? {} : { attachments }),
					...(command.context === undefined ? {} : { context: command.context }),
					...(command.manualContinuationOfRunId === undefined ? {} : { continuationOf: command.manualContinuationOfRunId }),
				});
				break;
			}
			case "run.interrupt":
			case "thread.stop":
				// A person's Stop: every command here is a client's. An agent stops a thread through its tools
				// (`ThreadOps.interrupt`, `Orchestration.cancel`), which say so themselves.
				await bridge.interrupt(command.threadId);
				break;
			case "queued-run.cancel":
				await bridge.cancelQueued(command.threadId, command.runId);
				break;
			case "queued-run.edit":
				await bridge.editQueued(command.threadId, command.runId, command.text, attachmentRecords(command.attachments));
				break;
			case "queued-message.promote-to-steer":
				await bridge.promoteQueued(command.threadId, command.queuedRunId);
				break;
			case "queued-run.start":
				await bridge.startQueued(command.threadId, command.runId, command.commandId);
				break;
			case "queue.resume":
				await bridge.startQueued(command.threadId, undefined, command.commandId);
				break;
			case "thread.settle":
				await bridge.sidebar.settle(command.threadId, command.expectedLatestRunId);
				break;
			case "thread.unsettle":
				await bridge.sidebar.unsettle(command.threadId, command.restoreUnsettledAt);
				break;
			case "thread.tag.set":
				await bridge.sidebar.setTag(command.threadId, command.tag, command.tagged);
				break;
			case "thread.archive":
				await bridge.sidebar.archive(command.threadId);
				break;
			case "thread.unarchive":
				await bridge.sidebar.unarchive(command.threadId);
				break;
			case "thread.snooze":
				await bridge.sidebar.snooze(command.threadId, command.snoozedUntil);
				break;
			case "thread.unsnooze":
				await bridge.sidebar.unsnooze(command.threadId);
				break;
			case "thread.visit":
				await bridge.sidebar.visit(command.threadId, command.visitedAt, command.opened === true, command.searchQuery);
				break;
			case "thread.mark-unread":
				await bridge.sidebar.markUnread(command.threadId);
				break;
			case "thread.pin":
				await bridge.sidebar.pin(command.threadId, command.orderKey);
				break;
			case "thread.unpin":
				await bridge.sidebar.unpin(command.threadId);
				break;
			case "thread.pin.reorder":
				await bridge.sidebar.reorder(command.threadId, "pinned", command.orderKey);
				break;
			case "thread.active.reorder":
				await bridge.sidebar.reorder(command.threadId, "active", command.orderKey);
				break;
			case "thread.auto-settle.set":
				await bridge.sidebar.setAutoSettle(command.threadId, command.enabled);
				break;
			case "thread.auto-settle":
				await bridge.sidebar.autoSettle(
					command.threadId,
					DateTime.toEpochMillis(command.snapshotAt),
					command.settledAt === undefined ? undefined : DateTime.toEpochMillis(command.settledAt),
				);
				break;
			case "thread.model-selection.set":
				await bridge.applySelection(command.threadId, command.modelSelection);
				break;
			case "checkpoint.rollback":
				await bridge.rollback({
					threadId: command.threadId,
					commandId: command.commandId,
					checkpointId: command.checkpointId,
					restoreFiles: command.restoreFiles === true,
				});
				break;
			case "thread.delete":
				await bridge.deleteThread(command.threadId, { onlyIfUnused: command.onlyIfUnused === true });
				break;
			case "thread.metadata.update":
				await bridge.updateThreadMetadata(command);
				break;
			case "thread.create":
				await bridge.createThread({ threadId: command.threadId, projectId: command.projectId, title: command.title, provenance });
				await bridge.applySelection(command.threadId, command.modelSelection);
				break;
			case "thread.fork":
				await bridge.forkThread({
					sourceThreadId: command.sourceThreadId,
					targetThreadId: command.targetThreadId,
					...(command.sourcePoint.type === "run" ? { runId: command.sourcePoint.runId } : {}),
					...(command.title === undefined ? {} : { title: command.title }),
					...(command.sideChat === true ? { sideChat: true } : {}),
					provenance,
				});
				break;
			case "thread.merge_back":
				await bridge.mergeBack({ sourceThreadId: command.sourceThreadId, targetThreadId: command.targetThreadId, sourcePoint: command.sourcePoint });
				break;
			// T3's answer to a card: the agent's questions (`ask_user`), or an approval a host's gate asked for
			// (`approvals.ts`). pi runs tools without approvals of its own.
			case "runtime-request.respond": {
				if (command.decision !== undefined && bridge.approvals.owns(command.requestId)) {
					await bridge.approvals.respond({ threadId: command.threadId, requestId: command.requestId, decision: command.decision, ...(command.feedback === undefined ? {} : { feedback: command.feedback }) });
					break;
				}
				if (!bridge.userInput.owns(command.requestId)) throw new CommandError(`Runtime request ${command.requestId} is no longer pending.`);
				if (command.answers === undefined) throw new CommandError("A question is answered, not approved: send answers, not a decision.");
				if (Object.values(command.attachmentsByQuestionId ?? {}).some((attached) => attached.length > 0)) {
					throw new CommandError("attachmentsByQuestionId is not supported by pi-durable-t3: an answer is text. Send the file as a message.");
				}
				await bridge.userInput.respond({ threadId: command.threadId, requestId: command.requestId, answers: command.answers });
				break;
			}
			case "thread.user-input.dismiss":
				if (!bridge.userInput.owns(command.requestId)) throw new CommandError(unsupportedMessage(command.type));
				await bridge.userInput.respond({ threadId: command.threadId, requestId: command.requestId });
				break;
			case "thread.runtime-mode.set":
				if (command.runtimeMode !== "full-access") throw new CommandError("pi runs tools without approvals; full-access is the only mode.");
				break;
			case "thread.interaction-mode.set":
				if (command.interactionMode !== "default") throw new CommandError("Plan mode is not supported by pi-durable-t3.");
				break;
			default:
				if (!SIDEBAR_NO_OPS.has(command.type)) throw new CommandError(unsupportedMessage(command.type));
				// A delivery receipt for a push this host never sent: accepting it changes nothing.
				log.info("command accepted without effect", { type: command.type });
		}
		return bridge.nextSequence();
	});
}
