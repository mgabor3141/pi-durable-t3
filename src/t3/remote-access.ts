// How this host is reached from other machines when the integrator runs the route itself (its own tailnet node, an SSH
// relay), instead of the bridge arming Tailscale Serve on the machine's own Tailscale (`tailscaleServe`). T3's server
// discovers both facts on its own machine (`DirectEndpoints`, `RemoteOpenTargets`); a host behind a container cannot,
// so the integrator states them and says when they change.

/** What this host advertises now. Either part may be absent: not set up yet, or not offered. */
export interface RemoteAccessState {
	/** The HTTPS URL a paired client may reach this host at (T3's `directEndpoints`, kind `tailnet`). */
	readonly httpBaseUrl?: string;
	/** Where editors open this host's paths over SSH, on port 22 (T3's `remoteOpenTargets`, kind `tailscale`): "Open in
	 * VS Code", file links and the file preview. The paths are the environment's, so this host's SSH must land there. */
	readonly ssh?: { readonly host: string; readonly username?: string };
}

export interface RemoteAccess {
	current(): RemoteAccessState;
	/** Called on every change; returns the unsubscribe. Connected clients get a fresh config snapshot. */
	subscribe(listener: () => void): () => void;
}

/** The state as T3's `ServerConfig` fields. */
export function advertisedRemoteAccess(state: RemoteAccessState): {
	directEndpoints: { kind: "tailnet"; httpBaseUrl: string }[];
	remoteOpenTargets?: { kind: "tailscale"; host: string; username?: string }[];
} {
	return {
		directEndpoints: state.httpBaseUrl === undefined ? [] : [{ kind: "tailnet", httpBaseUrl: state.httpBaseUrl.replace(/\/+$/u, "") }],
		...(state.ssh === undefined ? {} : { remoteOpenTargets: [{ kind: "tailscale", host: state.ssh.host, ...(state.ssh.username === undefined ? {} : { username: state.ssh.username }) }] }),
	};
}
