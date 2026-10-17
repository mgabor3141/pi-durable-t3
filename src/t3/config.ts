// The T3 facet's configuration. The static, integrator-owned fields (`FacetConfig`) come from the caller
// (`attachT3`); the live project registry is the bridge's own file (`../registry.ts`) and T3's server settings are
// the store over the data dir's `settings.json` (`../settings.ts`) — both mutable sources the host opens at start.
// The facet reads them live, so an edit lands in the panes that read them.
import type { ProjectRegistry } from "../registry.ts";
import type { ServerSettingsStore } from "../settings.ts";

/** The facet's integrator-owned fields, assembled once from `attachT3`'s options. */
export interface FacetConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	readonly stateDir: string;
	readonly pairingToken: string | undefined;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[];
}

/** The fully-assembled facet config: the integrator's static fields, the live project registry, and the live
 * server-settings store. These are the sources of truth, shared with the host and the threads layer. */
export interface BridgeConfig extends FacetConfig {
	/** The live project registry. The facet reads it for the shell's `projects` and mutates it for
	 * `projects.mutate`; it is the source of truth, shared with the host and threads layer. */
	readonly registry: ProjectRegistry;
	/** T3's server settings (the data dir's `settings.json`, stored as T3's server stores them). `server.getSettings`
	 * and `server.updateSettings` answer through it, and its change signal is what emits `settingsUpdated`. */
	readonly settings: ServerSettingsStore;
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, or the state dir when there are no
 * projects — so a project-less host (an empty instance file) stays connectable instead of throwing in `serverConfig`. */
export function serverCwd(config: BridgeConfig): string {
	return config.registry.list()[0]?.cwd ?? config.stateDir;
}
