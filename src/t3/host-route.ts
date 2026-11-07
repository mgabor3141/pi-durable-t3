// Public: kept apart from the bridge config (which reaches the settings store and T3's contracts), so the declarations
// an integrator imports stay free of the vendored contracts (`build/prune-types.mjs`).

/**
 * An HTTP route the integrator adds to the host's listener, in web-standard terms. It is public: anyone who can reach
 * the host can call it, so it authenticates its own callers (an OAuth callback checks its `state`). Its path is under
 * `/host/`, which T3 never uses: the router refuses two routes on one path, and a clash would stop the server.
 */
export type HostRoute = {
	readonly method: "GET" | "POST";
	readonly path: `/host/${string}`;
	handle(request: Request): Promise<Response>;
};
