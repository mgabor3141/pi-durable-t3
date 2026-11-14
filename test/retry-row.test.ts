// Requests that fail one after another are one row (T3's provider retry row), not one error row each.
//
// pi-durable records every failed request as an assistant entry before it waits and sends the request again. With a
// long retry policy (64 retries, five minutes apart) a thread that is out of usage would show 64 error rows. T3 shows a
// provider's retries as ONE `error` item that it updates: "Retrying provider (3/64)", then "Provider recovered" or
// "... after 64/64 retries". The projection is pure, so every state is an entry shape here: no host, storage or model.
import { expect, it } from "vitest";
import type { ConversationView, EntryRecord } from "../src/t3/model-types.ts";
import { projectThread, type ThreadMeta } from "../src/t3/projection.ts";

const meta: ThreadMeta = { threadId: "t1", projectId: "p", title: "t", cwd: "/", createdAt: 0, updatedAt: 0, model: null, running: false, maxRetries: 64 };
const LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';

const user = (id: number, text: string): EntryRecord =>
	({ id, kind: "app.user", data: { messageId: `u${id}` }, model: [{ role: "user", content: text, timestamp: id }] }) as unknown as EntryRecord;
const assistant = (id: number, text: string, stopReason: string, errorMessage?: string): EntryRecord =>
	({ id, kind: "pi.assistant", model: [{ role: "assistant", content: text === "" ? [] : [{ type: "text", text }], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: id }] }) as unknown as EntryRecord;
const failed = (id: number, message = LIMIT, partial = "") => assistant(id, partial, "error", message);

type Row = { id: string; type: string; status: string; text?: string; failure?: { class: string; message: string; retryable: boolean | null }; retry?: { attempt: number; maxAttempts: number | null; retryDelayMs: number | null } };
const rows = (entries: readonly EntryRecord[], live?: object, over: Partial<ThreadMeta> = {}) => {
	const view = { conversation: { id: 1 }, entries, docs: live === undefined ? {} : { "pi.live": live } } as unknown as ConversationView;
	const result = projectThread({ ...meta, ...over }, view, { rolledBack: [] });
	return {
		items: (result.projection.turnItems as unknown as Row[]).filter((item) => item.type !== "user_message"),
		run: result.projection.runs.at(-1)!.status,
	};
};
const RUNNING = { run: { taskId: 1, inputs: [] } };

it("a request that waits to be sent again is one running row that counts", () => {
	const waiting = { ...RUNNING, generation: { attempt: 3, retry: { at: 12 + 8_000, error: LIMIT } } };
	const { items, run } = rows([user(1, "go"), failed(10), failed(11), failed(12, LIMIT, "half an ans")], waiting);
	expect(run).toBe("running");
	// One row, where the first failure stands, and nothing of what the failed requests left.
	expect(items).toEqual([
		expect.objectContaining({
			id: "ti-e1.0",
			type: "error",
			status: "running",
			failure: { class: "usage_limit", message: LIMIT, code: null, retryable: true },
			retry: { attempt: 3, maxAttempts: 64, retryDelayMs: 8_000 },
		}),
	]);
	// The request is out again: the row stays, without a wait.
	expect(rows([user(1, "go"), failed(10), failed(11)], { ...RUNNING, generation: { attempt: 3 } }).items).toEqual([
		expect.objectContaining({ id: "ti-e1.0", status: "running", retry: { attempt: 2, maxAttempts: 64, retryDelayMs: null } }),
	]);
	// Without the integrator's limit the row counts alone.
	expect(rows([user(1, "go"), failed(10)], RUNNING, { maxRetries: undefined }).items[0]!.retry).toEqual({ attempt: 1, maxAttempts: null, retryDelayMs: null });
});

it("an answer after failures says the provider recovered, and the answer follows", () => {
	const { items, run } = rows([user(1, "go"), failed(10), failed(11, "fetch failed", "half"), assistant(12, "done", "stop")]);
	expect(run).toBe("completed");
	expect(items.map((item) => [item.id, item.type, item.status, item.text])).toEqual([
		["ti-e1.0", "error", "completed", undefined],
		["ti-a1.2", "assistant_message", "completed", "done"],
	]);
	expect(items[0]).toMatchObject({ failure: { class: "provider_error", message: "fetch failed" }, retry: { attempt: 2, maxAttempts: 64, retryDelayMs: null } });
});

it("a run that gave up says how many times it tried again; a first failure is a plain error", () => {
	const gaveUp = rows([user(1, "go"), failed(10), failed(11), failed(12, LIMIT, "what there was")]);
	expect(gaveUp.run).toBe("failed");
	expect(gaveUp.items.map((item) => [item.id, item.type, item.status])).toEqual([
		["ti-a1.2", "assistant_message", "completed"],
		["ti-e1.0", "error", "failed"],
	]);
	expect(gaveUp.items[1]).toMatchObject({ failure: { class: "usage_limit", retryable: true }, retry: { attempt: 2, maxAttempts: 64, retryDelayMs: null } });

	const once = rows([user(1, "go"), failed(10, "  invalid x-api-key  ")]);
	expect(once.items).toHaveLength(1);
	expect(once.items[0]).toMatchObject({ id: "ti-e1.0", status: "failed", failure: { class: "provider_error", message: "invalid x-api-key", code: null, retryable: null } });
	expect(once.items[0]!.retry).toBeUndefined();
});

it("a Stop while a request is out again ends the row as stopped; two streaks in a run are two rows", () => {
	const stopped = rows([user(1, "go"), failed(10), assistant(11, "", "aborted")]);
	expect(stopped.items[0]).toMatchObject({ id: "ti-e1.0", status: "interrupted", retry: { attempt: 1 } });

	const twice = rows([user(1, "go"), failed(10), assistant(11, "one", "stop"), user(12, "more"), failed(13), failed(14), assistant(15, "two", "stop")]);
	expect(twice.items.filter((item) => item.type === "error").map((item) => [item.id, item.status, item.retry?.attempt])).toEqual([
		["ti-e1.0", "completed", 1],
		["ti-e12.0", "completed", 2],
	]);
});
