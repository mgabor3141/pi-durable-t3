// A T3 client for tests: the pairing handshake and the `/ws` Effect-RPC frames, exactly as the web app speaks them.
// Requests are `{_tag:"Request", id, tag, payload, headers}`; a unary answer is one `Exit` frame, and a stream sends
// `Chunk` frames the client must `Ack` (the server's flow control — a client that does not ack sees only the first
// chunk). Nothing here is a T3 import: the frames are the wire, and a test that asserts the wire asserts the contract.
import { connectMeasured } from "./transfer.ts";
import { sleep } from "./wait.ts";
import { request } from "node:http";

export type Frame = {
	_tag: string;
	requestId?: number;
	tag?: string;
	payload?: unknown;
	exit?: { _tag: string; value?: unknown; cause?: unknown };
	values?: unknown[];
	defect?: unknown;
};


async function get(port: number, path: string): Promise<number> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
		return response.status;
	} catch {
		return 0;
	}
}

/** Poll `/.well-known/t3/environment` until the host answers 200. */
export async function waitListening(port: number, timeoutMs = 20_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await get(port, "/.well-known/t3/environment")) === 200) return true;
		await sleep(150);
	}
	return false;
}

/** Pair with the fixed test token and return the bearer token. */
export async function pair(port: number, pairingToken: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
			subject_token: pairingToken,
			subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
			requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
		}).toString(),
		signal: AbortSignal.timeout(5000),
	});
	if (response.status !== 200) throw new Error(`pair failed ${response.status}: ${await response.text()}`);
	return ((await response.json()) as { access_token: string }).access_token;
}

/** A one-shot WebSocket ticket for a paired bearer token. */
export async function wsTicket(port: number, token: string): Promise<string> {
	const response = await fetch(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(5000),
	});
	if (response.status !== 200) throw new Error(`ticket failed ${response.status}: ${await response.text()}`);
	return ((await response.json()) as { ticket: string }).ticket;
}

export type WsRpc = {
	/** Whether the socket has closed (the server reaps it when the token stops being active — expiry or revocation). */
	isClosed(): boolean;
	/** Every frame received so far (JSON-decoded). */
	frames(): Frame[];
	/** Frames of one tag (e.g. the stream events of a `Chunk`). */
	chunks(requestId: number): Frame[];
	/** One request; resolves with its `Exit` frame (or the terminal frame that answers it). */
	call(tag: string, payload: unknown, timeoutMs?: number): Promise<Frame>;
	/** Start a stream request; returns its request id. Events arrive as `Chunk` frames (acked automatically). */
	open(tag: string, payload: unknown): Promise<number>;
	send(frame: unknown): void;
	close(): void;
};

/** Connect to `/ws` as the web app does (`connectMeasured`: protocol 2, a fresh ticket, compression, every chunk acked). */
export async function connectWs(port: number, token: string): Promise<WsRpc> {
	const socket = await connectMeasured(port, token);
	const frames = (): Frame[] => socket.arrivals.map((arrival) => arrival.frame as unknown as Frame);
	return {
		isClosed: () => socket.isClosed(),
		frames,
		chunks: (requestId) => socket.chunks(String(requestId)).map((arrival) => arrival.frame as unknown as Frame),
		call: async (tag, payload, timeoutMs = 10_000) => (await socket.call(tag, payload, timeoutMs)).frame as unknown as Frame,
		open: async (tag, payload) => Number(socket.open(tag, payload)),
		send: (frame) => socket.send(frame),
		// An answer or stream item that does not encode with the contract's schema ends its request with the RPC server's
		// "Failed to encode response" defect (a protocol-level failure is a `Defect` frame). Closing a client that saw
		// either fails the test, so every test that talks to a host checks that what it received is the contract's.
		close: () => {
			try {
				socket.close();
			} catch {}
			const broken = frames().find(isEncodeFailure);
			if (broken !== undefined) throw new Error(`the host sent an item that does not encode: ${JSON.stringify(broken).slice(0, 800)}`);
		},
	};
}

/** A frame that says the host failed to encode what it answered (see `close`). */
export const isEncodeFailure = (frame: Frame): boolean => frame._tag === "Defect" || (frame._tag === "Exit" && JSON.stringify(frame.exit?.cause ?? null).includes("Failed to encode response"));

/** The `value` of a successful `Exit`, throwing with the frame when the call failed. */
export function exitValue(frame: Frame, what: string): unknown {
	if (frame._tag !== "Exit" || frame.exit?._tag !== "Success") throw new Error(`${what}: not a success: ${JSON.stringify(frame).slice(0, 600)}`);
	return frame.exit.value;
}

/** The single typed failure of a `Failure` exit (the Effect cause's first `Fail` entry). */
export function exitError(frame: Frame, what: string): Record<string, unknown> {
	if (isEncodeFailure(frame)) throw new Error(`${what}: the answer did not encode with the contract's schema: ${JSON.stringify(frame).slice(0, 800)}`);
	const cause = frame.exit?.cause;
	const entries = Array.isArray(cause) ? (cause as Record<string, unknown>[]) : [];
	const failed = entries.find((entry) => entry._tag === "Fail");
	if (frame.exit?._tag !== "Failure" || failed === undefined) throw new Error(`${what}: not a typed failure: ${JSON.stringify(frame).slice(0, 600)}`);
	return failed.error as Record<string, unknown>;
}

/** A raw HTTP POST (the REST parity route), returning the status and the parsed body. */
export async function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(8000),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function getJson(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(8000) });
	return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

export { request };
