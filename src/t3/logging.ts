// The facet's logger contract. Everything the facet logs goes through this, so the host controls the sink.
export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
}

/** A logger that says nothing — `attachT3`'s default when the caller passes no `log`.
 * The facet's refusals are answered to the client, so silence loses no contract guarantee. */
export const nullLogger: Logger = { info: () => {}, warn: () => {} };

/** One RPC method invocation. `kind` distinguishes a unary request from a stream open. */
export interface RpcCall {
	readonly method: string;
	readonly kind: "request" | "stream";
	readonly durationMs: number;
}

/** A call whose handler failed. `error` is the squashed cause's message. */
export interface RpcCallFailure extends RpcCall {
	readonly error: string;
}

/** A call to a method this host does not implement. Every invocation reports it; the `log.info` line is once per tag. */
export interface RpcCallStub {
	readonly method: string;
	readonly kind: "request" | "stream";
	readonly reason: string;
	readonly durationMs: number;
}

/**
 * Optional per-call observation for debugging the T3 wire. `onSuccess` fires when a request handler succeeds or a
 * stream opens; `onFailure` when a request handler fails; `onStubbed` when the client calls a method this host does
 * not implement. Callbacks are called synchronously and their exceptions are caught, so a debug sink never breaks a
 * call. Absent: nothing is called.
 */
export interface RpcLog {
	readonly onSuccess?: (call: RpcCall) => void;
	readonly onFailure?: (call: RpcCallFailure) => void;
	readonly onStubbed?: (call: RpcCallStub) => void;
}

