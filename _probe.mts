import { createServer } from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

const LOOP = new Set(["127.0.0.1", "localhost", "::1"]);
const hostGuard = HttpRouter.middleware((effect: any) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const host = String(request.headers.host ?? "").toLowerCase();
		const hostname = host.replace(/:\d+$/, "");
		if (LOOP.has(hostname)) return yield* effect;
		return HttpServerResponse.jsonUnsafe({ code: "invalid_host", host }, { status: 421 });
	}),
	{ global: true },
);

const routes = HttpRouter.add("GET", "/x", Effect.sync(() => HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 })));

const app = HttpRouter.serve(Layer.mergeAll(routes, hostGuard), { disableLogger: true }).pipe(
	Layer.provide(NodeHttpServer.layer(() => createServer(), { host: "127.0.0.1", port: 4988 })),
);

await Effect.runPromise(Layer.launch(app) as any);
console.log("listening");
