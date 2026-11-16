// Measuring what a T3 client is sent and how long it waits, on the real HTTP and WebSocket transports: T3's
// `NetworkTransferMeasurement.integration.ts`, with a clock. The HTTP reader asks for gzip and the socket negotiates
// permessage-deflate, as a browser does, so "wire bytes" are what crosses the network (the socket's own byte count)
// and "decoded bytes" are the JSON a client parses and keeps.
import { get } from "node:http";
import { gunzipSync } from "node:zlib";
import WebSocket from "ws";
import { sleep } from "./wait.ts";
import { wsTicket } from "./ws-rpc.ts";


export type HttpTransfer = {
	readonly status: number;
	readonly contentEncoding: string | null;
	/** What crossed the network for the response: headers and the (compressed) body. */
	readonly wireBytes: number;
	readonly decodedBytes: number;
	readonly ms: number;
	readonly body: unknown;
};

/** One GET as T3's web app sends it (bearer token, the orchestration protocol header, gzip accepted). */
export function measureHttpGet(port: number, path: string, token: string): Promise<HttpTransfer> {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		let before = 0;
		const request = get(`http://127.0.0.1:${port}${path}`, { agent: false, headers: { "accept-encoding": "gzip", connection: "close", authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" } }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("error", reject);
			response.once("end", () => {
				const encoded = Buffer.concat(chunks);
				const header = response.headers["content-encoding"];
				const contentEncoding = (Array.isArray(header) ? header[0] : header) ?? null;
				const decoded = contentEncoding === "gzip" ? gunzipSync(encoded) : encoded;
				let body: unknown;
				try {
					body = JSON.parse(decoded.toString("utf8"));
				} catch {
					body = decoded.toString("utf8");
				}
				resolve({ status: response.statusCode ?? 0, contentEncoding, wireBytes: Math.max(0, response.socket.bytesRead - before), decodedBytes: decoded.byteLength, ms: performance.now() - started, body });
			});
		});
		request.once("socket", (socket) => void (before = socket.bytesRead));
		request.once("error", reject);
	});
}

export type Frame = { readonly _tag: string; readonly requestId?: string; readonly exit?: { readonly _tag: string; readonly value?: unknown; readonly cause?: unknown }; readonly values?: readonly Record<string, unknown>[] };
/** One frame as it arrived: when, how large once inflated, and what it said. */
export type Arrival = { readonly at: number; readonly decodedBytes: number; readonly text: string; readonly frame: Frame };
export type WsTotals = { readonly wireBytes: number; readonly decodedBytes: number; readonly messages: number };

export type MeasuredWs = {
	/** Every frame so far, in order. */
	readonly arrivals: Arrival[];
	/** Send a request (a call, or a stream to subscribe to); answers its id. */
	open(tag: string, payload: unknown): string;
	/** One call: its `Exit` frame, with when it arrived. */
	call(tag: string, payload: unknown, timeoutMs?: number): Promise<Arrival>;
	/** The first frame from `from` on (an index into `arrivals`) that `find` accepts. */
	until(find: (arrival: Arrival) => boolean, from?: number, timeoutMs?: number): Promise<Arrival>;
	/** The stream chunks of one request, from `from` on. */
	chunks(requestId: string, from?: number): Arrival[];
	/** What the socket has received in all: bytes on the wire, bytes once inflated, messages. */
	totals(): WsTotals;
	/** Send a frame as it is. */
	send(frame: unknown): void;
	/** Whether the socket has closed (the host reaps it when its token stops being active). */
	isClosed(): boolean;
	close(): void;
};

/** `after - before`: what a part of a scenario cost. */
export const since = (before: WsTotals, after: WsTotals): WsTotals => ({ wireBytes: after.wireBytes - before.wireBytes, decodedBytes: after.decodedBytes - before.decodedBytes, messages: after.messages - before.messages });

/** Connect to `/ws` as the web app does (protocol 2, a fresh ticket, compression), acking every chunk. */
export async function connectMeasured(port: number, token: string): Promise<MeasuredWs> {
	const ticket = await wsTicket(port, token);
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`, { perMessageDeflate: true });
	const arrivals: Arrival[] = [];
	let decodedBytes = 0;
	let closed = false;
	ws.on("close", () => void (closed = true));
	ws.on("message", (data) => {
		const text = data.toString();
		const frame = JSON.parse(text) as Frame;
		const size = Buffer.byteLength(text);
		decodedBytes += size;
		arrivals.push({ at: performance.now(), decodedBytes: size, text, frame });
		// The server's per-request window opens only on an Ack: without it a stream stalls after its first chunk.
		if (frame._tag === "Chunk") ws.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	if (!ws.extensions.includes("permessage-deflate")) throw new Error(`the host did not negotiate compression on /ws (extensions: "${ws.extensions}")`);
	let next = 0;
	const open = (tag: string, payload: unknown): string => {
		const id = String(++next);
		ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
		return id;
	};
	const until = async (find: (arrival: Arrival) => boolean, from = 0, timeoutMs = 20_000): Promise<Arrival> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			for (let index = from; index < arrivals.length; index++) if (find(arrivals[index]!)) return arrivals[index]!;
			if (Date.now() > deadline) throw new Error(`nothing arrived within ${timeoutMs} ms; last frames: ${arrivals.slice(-3).map((arrival) => arrival.text.slice(0, 200)).join(" | ")}`);
			await sleep(1);
		}
	};
	return {
		arrivals,
		open,
		until,
		call: async (tag, payload, timeoutMs) => {
			const from = arrivals.length;
			const id = open(tag, payload);
			return until((arrival) => arrival.frame.requestId === id && (arrival.frame._tag === "Exit" || arrival.frame._tag === "Defect"), from, timeoutMs);
		},
		chunks: (requestId, from = 0) => arrivals.slice(from).filter((arrival) => arrival.frame._tag === "Chunk" && arrival.frame.requestId === requestId),
		totals: () => ({ wireBytes: (ws as unknown as { _socket?: { bytesRead: number } })._socket?.bytesRead ?? 0, decodedBytes, messages: arrivals.length }),
		send: (frame) => ws.send(JSON.stringify(frame)),
		isClosed: () => closed,
		close: () => ws.close(),
	};
}

/** The value of a call that succeeded; a failure throws with what the host said. */
export function succeeded<T>(arrival: Arrival, what: string): T {
	if (arrival.frame._tag !== "Exit" || arrival.frame.exit?._tag !== "Success") throw new Error(`${what} failed: ${arrival.text.slice(0, 600)}`);
	return arrival.frame.exit.value as T;
}
