// The one HTTP surface of the server preview: `/api/preview-stream/ws`. T3's client mints a short-lived websocket
// ticket and opens this route after `preview.open`; the route authenticates it, attaches a viewer, and carries frames
// and input over the socket. There is no download or upload route: this host has no profile store or file chooser.
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { AuthOrchestrationReadScope, AuthPreviewOperateScope, PreviewSessionLookupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";
import type { AuthStore } from "./auth.ts";
import type { Logger } from "./logging.ts";
import { type PreviewSessions, type PreviewViewerSink } from "./preview.ts";

const TAB_GONE_CODE = 4404;
const MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;
const textDecoder = new TextDecoder();

const intParam = (params: URLSearchParams, name: string, fallback: number, max: number): number => {
	const value = Number(params.get(name));
	return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : fallback;
};

type Output =
	| { readonly kind: "frame"; readonly data: Uint8Array }
	| { readonly kind: "json"; readonly value: unknown }
	| { readonly kind: "close"; readonly code: number; readonly reason: string };

const jsonResponse = (body: unknown, status: number) => HttpServerResponse.jsonUnsafe(body, { status });

/** The ticket-or-cookie session, exactly as the `/ws` upgrade reads it. */
const mediaSession = (auth: AuthStore, resolveSession: (request: HttpServerRequest.HttpServerRequest) => { hash: string } | undefined) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const url = new URL(request.url, "http://bridge");
		const ticketHash = auth.consumeTicket(url.searchParams.get("wsTicket"));
		const token = ticketHash === undefined ? resolveSession(request) : undefined;
		const session = ticketHash === undefined
			? token === undefined ? undefined : auth.sessionOfTokenHash(token.hash)
			: auth.sessionOfTokenHash(ticketHash);
		return { request, url, session };
	});

export const makePreviewStreamHandler = (deps: {
	readonly auth: AuthStore;
	readonly preview: PreviewSessions;
	readonly resolveSession: (request: HttpServerRequest.HttpServerRequest) => { hash: string } | undefined;
	readonly log: Logger;
}) =>
	Effect.gen(function* () {
		const { request, url, session } = yield* mediaSession(deps.auth, deps.resolveSession);
		if (url.pathname !== "/api/preview-stream/ws" || request.headers.upgrade?.toLowerCase() !== "websocket") {
			return HttpServerResponse.text("Not Found", { status: 404 });
		}
		if (session === undefined) {
			return jsonResponse({ _tag: "EnvironmentAuthInvalidError", code: "auth_invalid", message: "Pair this client first." }, 401);
		}
		if (!session.scopes.includes(AuthOrchestrationReadScope)) {
			return jsonResponse({ _tag: "EnvironmentScopeRequiredError", code: "insufficient_scope", requiredScope: AuthOrchestrationReadScope, requiredPermission: AuthOrchestrationReadScope, message: `This request needs the ${AuthOrchestrationReadScope} scope.` }, 403);
		}
		const params = url.searchParams;
		const threadId = params.get("threadId") ?? "";
		const tabId = params.get("tabId") ?? "";
		if (threadId.length === 0 || tabId.length === 0) return HttpServerResponse.text("Not Found", { status: 404 });
		const canOperate = session.scopes.includes(AuthPreviewOperateScope) && params.get("interactive") !== "false";

		const incoming = NodeHttpServerRequest.toIncomingMessage(request);
		delete incoming.headers["sec-websocket-extensions"];
		const transport = incoming.socket;
		const socket = yield* request.upgrade;
		const reader = yield* socket.reader;
		const writer = yield* socket.writer;

		const queue = yield* Queue.unbounded<Output>();
		const sink: PreviewViewerSink = {
			frame: (data) => Queue.offerUnsafe(queue, { kind: "frame", data }),
			json: (value) => Queue.offerUnsafe(queue, { kind: "json", value }),
			close: (code, reason) => Queue.offerUnsafe(queue, { kind: "close", code, reason }),
		};

		let viewer;
		try {
			viewer = yield* Effect.tryPromise({
				try: () => deps.preview.attach({
					threadId,
					tabId,
					canOperate,
					maxWidth: intParam(params, "maxWidth", 1280, 7680),
					maxHeight: intParam(params, "maxHeight", 800, 4320),
				}, sink),
				catch: (error) => error,
			});
		} catch (error) {
			const code = error instanceof PreviewSessionLookupError ? TAB_GONE_CODE : 1011;
			yield* writer.write(new Socket.CloseEvent(code, error instanceof Error ? error.message.slice(0, 100) : "preview unavailable"));
			return HttpServerResponse.empty();
		}
		deps.log.info("preview stream attached", { threadId, tabId, canOperate });

		const write = (data: Uint8Array | string) => {
			const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
			if (transport.writableLength + bytes + 14 > MAX_SOCKET_BUFFER_BYTES) {
				transport.destroy();
				return Effect.void;
			}
			return writer.write(data);
		};

		const send = Effect.gen(function* () {
			while (true) {
				const output = yield* Queue.take(queue);
				if (output.kind === "frame") {
					yield* write(output.data);
					continue;
				}
				if (output.kind === "json") {
					yield* write(JSON.stringify(output.value));
					continue;
				}
				yield* writer.write(new Socket.CloseEvent(output.code, output.reason));
				return;
			}
		});

		const receive = Effect.gen(function* () {
			while (true) {
				const chunks = yield* reader.pull;
				for (const chunk of chunks) {
					let message: unknown;
					try {
						message = JSON.parse(typeof chunk === "string" ? chunk : textDecoder.decode(chunk));
					} catch {
						continue;
					}
					if (typeof message === "object" && message !== null && (message as { type?: unknown }).type === "ack") viewer.ack();
					else yield* Effect.forkScoped(Effect.tryPromise({ try: () => viewer.input(message), catch: () => undefined }).pipe(Effect.ignore));
				}
			}
		});

		return yield* Effect.raceFirst(Effect.forever(receive), send).pipe(
			Effect.catch(() => Effect.void),
			Effect.ensuring(Effect.sync(() => viewer.close(4404, "viewer gone"))),
			Effect.as(HttpServerResponse.empty()),
		);
	});
