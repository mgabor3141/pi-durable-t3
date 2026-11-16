// The scenario the transfer budgets are measured on (`transfer-budget.test.ts`), and that the bench runs at other
// sizes (`bench/transfer.bench.test.ts`): a host over a real socket, a long thread and a sidebar of threads written
// through the commands a client sends, then what a person does, measured.
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { attachT3, mintPairingCode } from "../src/bridge.ts";
import { object } from "../src/t3/schema.ts";
import { gated, makeThreads } from "./threads-harness.ts";
import { connectMeasured, measureHttpGet, since, succeeded, type Arrival, type MeasuredWs } from "./transfer.ts";
import { pair, waitListening } from "./ws-rpc.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const WEB = { acceptBoundedSnapshot: true, acceptDeferredWork: true, acceptCompactTurnItems: true, acceptDedupedBodies: true, acceptCompactIds: true, requestCompletionMarker: true };

export type TransferScenario = {
	readonly port: number;
	/** The long thread: turns of `historyToolsPerTurn` tool calls with `historyToolBytes` of output each, and an answer. */
	readonly historyTurns: number;
	readonly historyToolsPerTurn: number;
	readonly historyToolBytes: number;
	/** The measured turn: tool calls with a large result each (T3's `TRANSFER_MEASURED_MCP_RESULT_BYTES`), then an
	 * answer of `measuredWords` words that streams. */
	readonly measuredTools: number;
	readonly measuredToolBytes: number;
	readonly measuredWords: number;
	/** The sidebar: threads someone settled, and ones that are active. */
	readonly fleetSettled: number;
	readonly fleetActive: number;
	/** The scripted model's speed. */
	readonly tokensPerSecond: number;
	/** An integrator's `messageContext` hook that takes this long (a memory recall); 0: no hook. */
	readonly messageContextMs?: number;
};

export type Observed = { readonly value: number; readonly unit: "B" | "ms" | "" };
export type TransferObserved = { readonly observed: Record<string, Observed>; readonly reconnectMode: "replay" | "snapshot"; readonly setupSeconds: number };

export async function measureTransfer(scenario: TransferScenario): Promise<TransferObserved> {
	const { port: PORT, historyTurns: HISTORY_TURNS, historyToolsPerTurn: HISTORY_TOOLS_PER_TURN, historyToolBytes: HISTORY_TOOL_BYTES, measuredTools: MEASURED_TOOLS, measuredToolBytes: MEASURED_TOOL_BYTES, measuredWords: MEASURED_WORDS, fleetSettled: FLEET_SETTLED, fleetActive: FLEET_ACTIVE } = scenario;
	const setupStarted = performance.now();
	const lines = (bytes: number) => "a line of output from a tool that printed a lot\n".repeat(Math.ceil(bytes / 48)).slice(0, bytes);
	const tools = defineExtension({
		name: "outputs",
		tools: [
			defineTool({ name: "page", description: "a page of output", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: lines(HISTORY_TOOL_BYTES) }] }) }),
			defineTool({ name: "large", description: "a large result", parameters: object({}), execute: async () => ({ output: [{ type: "text" as const, text: lines(MEASURED_TOOL_BYTES) }] }) }),
		],
	});
	const f = await makeThreads({ projects: [{ id: "unused" }], tokensPerSecond: scenario.tokensPerSecond, extensions: [tools] });
	// No compaction: the thread is to stay long, and the scripted model has no summaries queued.
	(f.model.faux.models[0] as { contextWindow: number }).contextWindow = 2_000_000_000;
	const stateDir = join(f.root, "t3-state");
	const contextMs = scenario.messageContextMs ?? 0;
	const t3 = await attachT3(f.harness, {
		models: f.model.models,
		stateDir,
		env: new NodeExecutionEnv({ cwd: f.root }),
		listen: { host: "127.0.0.1", port: PORT },
		...(contextMs === 0 ? {} : { messageContext: async () => (await sleep(contextMs), undefined) }),
	});
	const sockets: MeasuredWs[] = [];
	const connect = async () => {
		const socket = await connectMeasured(PORT, token);
		sockets.push(socket);
		return socket;
	};
	let token = "";
	try {
		if (!(await waitListening(PORT))) throw new Error(`the host is not listening on ${PORT}`);
		token = await pair(PORT, mintPairingCode(stateDir).code);

		// ---- the scenario's history, written through the same commands a client sends ----
		const setup = await connect();
		const shells = new Map<string, { status: string; settledOverride: string | null; latestVisibleMessage: { role: string; text: string } | null }>();
		const setupShell = setup.open("orchestration.subscribeShell", {});
		const readShells = () => {
			for (const arrival of setup.chunks(setupShell)) {
				for (const value of arrival.frame.values ?? []) {
					const snapshot = value["snapshot"] as { threads?: { id: string }[] } | undefined;
					for (const thread of snapshot?.threads ?? []) shells.set(thread.id, thread as never);
					if (value["kind"] === "thread.updated") shells.set((value["thread"] as { id: string }).id, value["thread"] as never);
				}
			}
			setup.arrivals.length = 0;
		};
		const shellShows = async (threadId: string, shows: (shell: NonNullable<ReturnType<typeof shells.get>>) => boolean, what: string) => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				readShells();
				const shell = shells.get(threadId);
				if (shell !== undefined && shows(shell)) return;
				if (Date.now() > deadline) throw new Error(`the sidebar never showed ${what} for ${threadId}: ${JSON.stringify({ status: shell?.status, latest: shell?.latestVisibleMessage?.text.slice(0, 60) })}`);
				await sleep(3);
			}
		};
		const replied = (threadId: string, starts: string) => shellShows(threadId, (shell) => shell.status === "completed" && shell.latestVisibleMessage?.role === "assistant" && shell.latestVisibleMessage.text.startsWith(starts), `the answer "${starts}"`);
		const providers = succeeded<{ providers: { instanceId: string; models: { slug: string }[] }[] }>(await setup.call("server.refreshProviders", {}), "refreshProviders");
		const provider = providers.providers.find((each) => each.models.length > 0)!;
		const modelSelection = { instanceId: provider.instanceId, model: provider.models[0]!.slug, options: [] };
		succeeded(await setup.call("projects.mutate", { type: "project.create", commandId: "pc", projectId: "proj", title: "Proj", workspaceRoot: join(f.root, "proj"), createWorkspaceRootIfMissing: true }), "project.create");
		let commands = 0;
		const command = (type: string, fields: Record<string, unknown>) => ({ type, commandId: `cmd-${++commands}`, ...fields });
		const message = (threadId: string, text: string, fields: Record<string, unknown> = {}) => {
			const sent = command("message.dispatch", { threadId, text, attachments: [], modelSelection, createdBy: "user", creationSource: "web", dispatchMode: { type: "start_immediately" }, ...fields });
			return { ...sent, messageId: `msg-${commands}` };
		};
		const launch = async (threadId: string, answer: string) => {
			f.model.append(fauxAssistantMessage(answer));
			succeeded(await setup.call("orchestration.launchThread", { commandId: `launch-${threadId}`, threadId, projectId: "proj", title: threadId, modelSelection, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" }, initialMessage: { messageId: `first-${threadId}`, role: "user", text: `the first message of ${threadId}`, attachments: [] } }), "launchThread");
			await replied(threadId, answer.slice(0, 20));
		};
		for (let index = 0; index < FLEET_SETTLED + FLEET_ACTIVE; index++) {
			await launch(`fleet-${index}`, `Fleet answer ${index}. ` + "lorem ipsum dolor sit amet ".repeat(8));
			if (index < FLEET_SETTLED) succeeded(await setup.call("orchestration.dispatchCommand", command("thread.settle", { threadId: `fleet-${index}` })), "thread.settle");
		}
		await launch("long", "The thread begins.");
		for (let turn = 0; turn < HISTORY_TURNS; turn++) {
			for (let tool = 0; tool < HISTORY_TOOLS_PER_TURN; tool++) f.model.append(fauxAssistantMessage([fauxToolCall("page", {}, { id: `call-${turn}-${tool}` })], { stopReason: "toolUse" }));
			f.model.append(fauxAssistantMessage(`Answer ${turn}: ` + "lorem ipsum dolor sit amet ".repeat(20)));
			succeeded(await setup.call("orchestration.dispatchCommand", message("long", `Question ${turn}: ` + "please explain ".repeat(10))), "message.dispatch");
			await replied("long", `Answer ${turn}:`);
		}

		const setupSeconds = (performance.now() - setupStarted) / 1000;

		// ---- 1. cold open: the sidebar, then the long thread, as the web app reads them over HTTP ----
		const shellSnapshot = await measureHttpGet(PORT, "/api/orchestration/shell", token);
		if (shellSnapshot.status !== 200 || shellSnapshot.contentEncoding !== "gzip") throw new Error(`the sidebar snapshot: ${shellSnapshot.status}, encoding ${shellSnapshot.contentEncoding}: ${JSON.stringify(shellSnapshot.body).slice(0, 300)}`);
		const threadSnapshot = await measureHttpGet(PORT, "/api/orchestration/threads/long/bounded?deferWork=1&compactTurnItems=1&dedupeBodies=1&compactIds=1", token);
		if (threadSnapshot.status !== 200 || threadSnapshot.contentEncoding !== "gzip") throw new Error(`the thread snapshot: ${threadSnapshot.status}, encoding ${threadSnapshot.contentEncoding}: ${JSON.stringify(threadSnapshot.body).slice(0, 300)}`);
		const snapshotSequence = (threadSnapshot.body as { snapshotSequence: number }).snapshotSequence;

		// ---- 2. the measured turn, seen by a thread subscriber, the sidebar, and a second client ----
		const first = await connect();
		const sidebar = await connect();
		const second = await connect();
		const firstThread = first.open("orchestration.subscribeThread", { threadId: "long", afterSequence: snapshotSequence, ...WEB });
		const sidebarShell = sidebar.open("orchestration.subscribeShell", { requestCompletionMarker: true });
		second.open("orchestration.subscribeThread", { threadId: "long", afterSequence: snapshotSequence, ...WEB });
		await sidebar.until((arrival) => arrival.frame._tag === "Chunk" && arrival.frame.requestId === sidebarShell);
		await sleep(250);
		const before = { first: first.totals(), sidebar: sidebar.totals(), second: second.totals() };
		/** Send a command on `first` and time it: the answer to the call, its message in the thread, the sidebar's row. */
		const timed = async (sent: Record<string, unknown>, seenInThread?: string) => {
			const fromFirst = first.arrivals.length;
			const fromSidebar = sidebar.arrivals.length;
			const at = performance.now();
			const id = first.open("orchestration.dispatchCommand", sent);
			const ack = await first.until((arrival) => arrival.frame.requestId === id && arrival.frame._tag === "Exit", fromFirst);
			succeeded(ack, String(sent["type"]));
			const inThread = seenInThread === undefined ? undefined : await first.until((arrival) => arrival.frame.requestId === firstThread && arrival.text.includes(seenInThread), fromFirst);
			const inSidebar: Arrival = await sidebar.until((arrival) => arrival.frame.requestId === sidebarShell && arrival.frame._tag === "Chunk", fromSidebar);
			return { ackMs: ack.at - at, threadMs: inThread === undefined ? 0 : inThread.at - at, sidebarMs: inSidebar.at - at };
		};
		for (let tool = 0; tool < MEASURED_TOOLS; tool++) f.model.append(fauxAssistantMessage([fauxToolCall("large", {}, { id: `measured-${tool}` })], { stopReason: "toolUse" }));
		f.model.append(fauxAssistantMessage("Measured answer. " + "word ".repeat(MEASURED_WORDS)));
		const lag = monitorEventLoopDelay({ resolution: 5 });
		lag.enable();
		const cpuBefore = process.cpuUsage();
		const measured = message("long", "The measured question.");
		const send = await timed(measured, measured.messageId);
		// While the answer streams: a sidebar command on another thread, and how long it takes to come back.
		const visitAt = performance.now();
		const visit = await first.call("orchestration.dispatchCommand", command("thread.visit", { threadId: `fleet-${FLEET_SETTLED}`, visitedAt: new Date().toISOString() }));
		succeeded(visit, "thread.visit");
		const whileStreamingMs = visit.at - visitAt;
		await replied("long", "Measured answer.");
		await sleep(250);
		lag.disable();
		const cpu = process.cpuUsage(cpuBefore);
		const turnCpuMs = (cpu.user + cpu.system) / 1000;
		const turn = { first: since(before.first, first.totals()), sidebar: since(before.sidebar, sidebar.totals()), second: since(before.second, second.totals()) };
		const turnSnapshots = first.chunks(firstThread).filter((arrival) => (arrival.frame.values ?? []).some((value) => value["kind"] === "snapshot")).length;

		// ---- 3. a client that was away for the measured turn comes back ----
		const back = await connect();
		const backThread = back.open("orchestration.subscribeThread", { threadId: "long", afterSequence: snapshotSequence, ...WEB });
		const caughtUp = await back.until((arrival) => arrival.frame.requestId === backThread && (arrival.frame.values ?? []).some((value) => value["kind"] === "synchronized"));
		const reconnect = back.totals();
		const reconnectMode = back.chunks(backThread).some((arrival) => (arrival.frame.values ?? []).some((value) => value["kind"] === "snapshot")) ? "snapshot" : "replay";
		void caughtUp;

		// ---- 4. a steer and a queued message into a running turn ----
		const held = gated("The held answer.");
		f.model.append(held.step);
		const opening = message("long", "A question whose answer is held back.");
		await timed(opening, opening.messageId);
		const steered = message("long", "A steer.", { deliveryIntent: "steer" });
		const steer = await timed(steered, steered.messageId);
		const queuedMessage = message("long", "A queued message.", { dispatchMode: { type: "queue_after_active" } });
		const queue = await timed(queuedMessage, queuedMessage.messageId);
		f.model.append(fauxAssistantMessage("After the steer."));
		const beforePlaced = first.totals();
		const fromPlaced = first.arrivals.length;
		held.release();
		await replied("long", "After the steer.");
		await sleep(250);
		const placed = since(beforePlaced, first.totals());
		const placedSnapshots = first.chunks(firstThread, fromPlaced).filter((arrival) => (arrival.frame.values ?? []).some((value) => value["kind"] === "snapshot")).length;

		// ---- 5. the sidebar's own commands ----
		const beforeSidebar = sidebar.totals();
		const pin = await timed(command("thread.pin", { threadId: `fleet-${FLEET_SETTLED + 1}` }));
		const rename = await timed(command("thread.metadata.update", { threadId: `fleet-${FLEET_SETTLED + 2}`, title: "Renamed" }));
		await sleep(100);
		const sidebarCommands = since(beforeSidebar, sidebar.totals());

		const B = (value: number): Observed => ({ value, unit: "B" });
		const ms = (value: number): Observed => ({ value, unit: "ms" });
		const count = (value: number): Observed => ({ value, unit: "" });
		return {
			reconnectMode,
			setupSeconds,
			observed: {
				"open: sidebar snapshot, wire": B(shellSnapshot.wireBytes),
				"open: sidebar snapshot, decoded": B(shellSnapshot.decodedBytes),
				"open: thread snapshot, wire": B(threadSnapshot.wireBytes),
				"open: thread snapshot, decoded": B(threadSnapshot.decodedBytes),
				"turn: thread stream, wire": B(turn.first.wireBytes),
				"turn: thread stream, decoded": B(turn.first.decodedBytes),
				"turn: thread stream, messages": count(turn.first.messages),
				"turn: thread stream, snapshots": count(turnSnapshots),
				"turn: second client, wire": B(turn.second.wireBytes),
				"turn: sidebar stream, wire": B(turn.sidebar.wireBytes),
				"turn: sidebar stream, messages": count(turn.sidebar.messages),
				"turn: the host's processor time": ms(turnCpuMs),
				"reconnect: thread, wire": B(reconnect.wireBytes),
				"placed: thread stream, wire": B(placed.wireBytes),
				"placed: thread stream, snapshots": count(placedSnapshots),
				"sidebar: pin and rename, wire": B(sidebarCommands.wireBytes),
				"send: answered": ms(send.ackMs),
				"send: shown in the thread": ms(send.threadMs),
				"send: shown in the sidebar": ms(send.sidebarMs),
				"steer: answered": ms(steer.ackMs),
				"steer: shown in the thread": ms(steer.threadMs),
				"queue: answered": ms(queue.ackMs),
				"queue: shown in the thread": ms(queue.threadMs),
				"pin: shown in the sidebar": ms(pin.sidebarMs),
				"rename: shown in the sidebar": ms(rename.sidebarMs),
				"while an answer streams: a sidebar command answered": ms(whileStreamingMs),
				"while an answer streams: the host's longest pause": ms(lag.max / 1e6),
			},
		};
	} finally {
		for (const socket of sockets) socket.close();
		await t3.close();
	}
}

/** The observed numbers as a Markdown table, beside their ceilings when there are any. */
export function transferReport(scenario: TransferScenario, result: TransferObserved, ceilings?: Readonly<Record<string, number>>): string {
	const show = (value: number, unit: string) => `${Math.round(value).toLocaleString("en-US")}${unit === "" ? "" : ` ${unit}`}`;
	return [
		"### Transfer and waiting",
		"",
		`Scenario: a thread of ${scenario.historyTurns + 1} turns and ${scenario.historyTurns * scenario.historyToolsPerTurn} tool calls of ${scenario.historyToolBytes} B; a sidebar of ${scenario.fleetSettled} settled and ${scenario.fleetActive + 1} active threads; a measured turn of ${scenario.measuredTools} tool results of ${scenario.measuredToolBytes} B and an answer of ${scenario.measuredWords} words${(scenario.messageContextMs ?? 0) === 0 ? "" : `; an integrator's message context that takes ${scenario.messageContextMs} ms`}. A client that reconnects is caught up by ${result.reconnectMode}.`,
		"",
		ceilings === undefined ? "| | Observed |" : "| | Observed | Ceiling |",
		ceilings === undefined ? "|---|--:|" : "|---|--:|--:|",
		...Object.entries(result.observed).map(([name, { value, unit }]) => `| ${name} | ${show(value, unit)} |${ceilings === undefined ? "" : ` ${ceilings[name] === undefined ? "" : show(ceilings[name], unit)} |`}`),
		"",
	].join("\n");
}
