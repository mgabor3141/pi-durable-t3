// The T3 facet's configuration: the integrator-owned static fields from `attachT3`, the live project registry
// (`../registry.ts`), and the live settings store over the data dir (`../settings.ts`). The facet reads them live.
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

/** The fully-assembled facet config: the integrator's static fields plus the two live sources of truth. */
export interface BridgeConfig extends FacetConfig {
	/** The live project registry: the shell's `projects`, and what `projects.mutate` writes. */
	readonly registry: ProjectRegistry;
	/** T3's server settings: what `server.getSettings`/`server.updateSettings` answer, and what emits `settingsUpdated`. */
	readonly settings: ServerSettingsStore;
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, else the state dir — a display
 * field, because this host has no working directory of its own (design.md, The model). */
export function serverCwd(config: BridgeConfig): string {
	return config.registry.list()[0]?.cwd ?? config.stateDir;
}
