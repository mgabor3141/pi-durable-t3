// The T3 facet's configuration. The static, integrator-owned fields (`FacetConfig`) come from `config.toml`
// (`../config.ts`); the live project registry and new-thread defaults are the instance file (`../registry.ts`), a
// mutable source the host opens at start. The facet reads projects through the registry and answers a UI's add/remove
// at once, so the registry is shared (host + threads layer + facet), never a snapshot the facet owns.
import type { ProjectRegistry } from "../registry.ts";

/** The facet's integrator-owned fields, assembled once from `config.toml` (no facet-only concerns of its own). */
export interface FacetConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	readonly stateDir: string;
	readonly pairingToken: string | undefined;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[];
}

/** The fully-assembled facet config: the integrator's static fields plus the live registry the host opens at start. */
export interface BridgeConfig extends FacetConfig {
	/** The live project registry (the instance file). The facet reads it for the shell's `projects` and mutates it for
	 * `projects.mutate`; it is the source of truth, shared with the host and threads layer. */
	readonly registry: ProjectRegistry;
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, or the state dir when there are no
 * projects — so a project-less host (an empty instance file) stays connectable instead of throwing in `serverConfig`. */
export function serverCwd(config: BridgeConfig): string {
	return config.registry.list()[0]?.cwd ?? config.stateDir;
}
