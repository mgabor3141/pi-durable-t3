// What a T3 client is sent, and how long it waits, for the things a person does all day: open the app, open a long
// thread, send a message and watch the answer stream, steer, queue, pin and rename in the sidebar, reconnect. After
// T3's `transferBudgetV2.integration.test.ts`: the real HTTP and WebSocket transports, compression as a browser
// negotiates it, and ceilings that fail the suite when a change sends much more or answers much later.
//
// The ceilings stand well above what is observed (the comment on each says by how much): streaming is coalesced by
// time, so bytes vary a little from run to run, and a CI machine is slower than a desk. They are there to catch a
// change of kind (compression gone, a snapshot where events did, a hook on the path of an answer), not a few percent.
// `TRANSFER_BUDGET_REPORT_PATH` writes the observed numbers beside the ceilings as Markdown.
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { measureTransfer, transferReport, type TransferScenario } from "./transfer-scenario.ts";

const SCENARIO: TransferScenario = {
	port: 4993,
	historyTurns: 30,
	historyToolsPerTurn: 2,
	historyToolBytes: 2_000,
	measuredTools: 2,
	measuredToolBytes: 8_192,
	measuredWords: 1_500,
	fleetSettled: 24,
	fleetActive: 6,
	tokensPerSecond: 3_000,
};

const CEILINGS: Readonly<Record<string, number>> = {
	// 31 thread rows: ~54 KB of JSON, ~3.3 KB gzipped.
	"open: sidebar snapshot, wire": 6_000,
	"open: sidebar snapshot, decoded": 70_000,
	// The bounded snapshot of a thread of 31 turns and 60 tool calls: ~58 KB of JSON, ~6.4 KB gzipped. Tool
	// output is not in it (a row that is opened asks for its own).
	"open: thread snapshot, wire": 10_000,
	"open: thread snapshot, decoded": 75_000,
	// Two 8 KB tool results and a streamed answer of 1,500 words. Each update repeats the answer so far, which
	// is what the socket's shared compression window is for: ~44 KB of JSON in 8 messages is ~3 KB on the wire.
	// Sent uncompressed, the wire figure is the decoded one and fails. The decoded figure grows with the number
	// of updates, which a slower machine sends more of.
	"turn: thread stream, wire": 8_000,
	"turn: thread stream, decoded": 150_000,
	"turn: thread stream, messages": 30,
	"turn: thread stream, snapshots": 0,
	"turn: second client, wire": 8_000,
	"turn: sidebar stream, wire": 1_500,
	"turn: sidebar stream, messages": 12,
	// Caught up from the events the host kept, not with the thread sent again: ~3 KB.
	"reconnect: thread, wire": 8_000,
	// A steered and a queued message taking their places: their queued runs stay in the stream, cancelled, as T3's
	// server keeps them, so the change goes out as events and the thread is not sent again (~1.5 KB on the wire).
	"placed: thread stream, wire": 4_000,
	"placed: thread stream, snapshots": 0,
	"sidebar: pin and rename, wire": 800,
	// Waiting, on loopback: observed 15 to 30 ms for a command's answer, 55 to 65 ms until the thread's stream
	// shows it (updates go out in batches 50 ms apart), under 10 ms for a sidebar command. The ceilings are
	// several times that, for a slow machine: they catch waiting of another order (something slow on the path
	// of an answer), not a few milliseconds.
	"send: answered": 400,
	"send: shown in the thread": 700,
	"send: shown in the sidebar": 700,
	"steer: answered": 400,
	"steer: shown in the thread": 700,
	"queue: answered": 400,
	"queue: shown in the thread": 700,
	"pin: shown in the sidebar": 400,
	"rename: shown in the sidebar": 400,
	"while an answer streams: a sidebar command answered": 400,
	"while an answer streams: the host's longest pause": 500,
};

it("a client's transfer and waiting stay within their budgets", { timeout: 300_000 }, async () => {
	const result = await measureTransfer(SCENARIO);
	const report = transferReport(SCENARIO, result, CEILINGS);
	const path = process.env["TRANSFER_BUDGET_REPORT_PATH"];
	if (path !== undefined && path !== "") writeFileSync(path, report);
	const over = Object.entries(CEILINGS).flatMap(([name, ceiling]) => {
		const seen = result.observed[name];
		if (seen === undefined) return [`${name}: not measured`];
		return seen.value > ceiling ? [`${name}: ${Math.round(seen.value)} ${seen.unit} is over ${ceiling} ${seen.unit}`] : [];
	});
	expect(over, `\n${report}`).toEqual([]);
	expect(result.reconnectMode, "a client away for one turn is caught up from the events the host kept").toBe("replay");
});
