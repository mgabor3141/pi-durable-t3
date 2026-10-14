// A T3 client for tests: the pairing handshake and the `/ws` Effect-RPC frames, exactly as the web app speaks them.
// Requests are `{_tag:"Request", id, tag, payload, headers}`; a unary answer is one `Exit` frame, and a stream sends
// `Chunk` frames the client must `Ack` (the server's flow control — a client that does not ack sees only the first
// chunk). Nothing here is a T3 import: the frames are the wire, and a test that asserts the wire asserts the contract.
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** Connect to `/ws` (protocol 2) with a fresh ticket, and ack every `Chunk` so streams keep flowing. */
export async function connectWs(port: number, token: string): Promise<WsRpc> {
	const ticket = await wsTicket(port, token);
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`);
	const frames: Frame[] = [];
	const byRequest = new Map<number, Frame[]>();
	ws.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as Frame;
		frames.push(frame);
		if (frame._tag === "Chunk" && frame.requestId !== undefined) {
			(byRequest.get(frame.requestId) ?? byRequest.set(frame.requestId, []).get(frame.requestId)!).push(frame);
			// The server's per-request window opens only on an Ack: without it a stream stalls after its first chunk.
			ws.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
		}
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("websocket connect failed")));
	});
	let nextId = 0;
	const send = (frame: unknown): void => ws.send(JSON.stringify(frame));
	const open = async (tag: string, payload: unknown): Promise<number> => {
		const id = ++nextId;
		send({ _tag: "Request", id, tag, payload, headers: [] });
		return id;
	};
	const call = async (tag: string, payload: unknown, timeoutMs = 10_000): Promise<Frame> => {
		const id = await open(tag, payload);
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const answer = frames.find((frame) => frame.requestId === id && (frame._tag === "Exit" || frame._tag === "Defect"));
			if (answer !== undefined) return answer;
			await sleep(25);
		}
		throw new Error(`no answer to ${tag} (id ${id}) within ${timeoutMs}ms; frames: ${JSON.stringify(frames).slice(0, 600)}`);
	};
	return {
		frames: () => frames.slice(),
		chunks: (requestId) => (byRequest.get(requestId) ?? []).slice(),
		call,
		open,
		send,
		close: () => {
			try {
				ws.close();
			} catch {}
		},
	};
}

/** The `value` of a successful `Exit`, throwing with the frame when the call failed. */
export function exitValue(frame: Frame, what: string): unknown {
	if (frame._tag !== "Exit" || frame.exit?._tag !== "Success") throw new Error(`${what}: not a success: ${JSON.stringify(frame).slice(0, 600)}`);
	return frame.exit.value;
}

/** The single typed failure of a `Failure` exit (the Effect cause's first `Fail` entry). */
export function exitError(frame: Frame, what: string): Record<string, unknown> {
	if (frame._tag === "Defect") throw new Error(`${what}: a DEFECT reached the wire (schema-encode failure): ${JSON.stringify(frame).slice(0, 800)}`);
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
