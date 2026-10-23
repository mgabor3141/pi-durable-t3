// The session a live `/ws` connection belongs to, provided per connection so the auth-access stream can mark the
// viewer's own client `current` (the web reducer keys the client list by session id; T3 computes `current` against
// the socket's session). The HTTP endpoints read it from the bearer token directly and do not use this service.
import * as Context from "effect/Context";

export class CurrentAuthSession extends Context.Service<CurrentAuthSession, { readonly sessionId: string; readonly scopes: readonly string[] }>()(
	"pi-durable-t3/CurrentAuthSession",
) {}
