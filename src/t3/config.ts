// The T3 facet's configuration: one plain, fully-resolved object the host builds once from `config.toml` (`../config.ts`)
// and hands to the facet, so the facet never parses the file and carries no host-only (or TOML) concerns of its own.
export interface ProjectConfig {
	readonly id: string;
	readonly name: string;
	/** Absolute directory a new thread in this project runs in (a project cwd under the env root). */
	readonly path: string;
}

export interface BridgeConfig {
	readonly host: string;
	readonly port: number;
	readonly label: string;
	readonly stateDir: string;
	readonly pairingToken: string | undefined;
	readonly tokenTtlSeconds: number;
	readonly corsOrigins: readonly string[];
	readonly projects: readonly ProjectConfig[];
}

/** The single server-level `cwd` T3's ServerConfig shows: the first project's path, or the state dir when there are no
 * projects — so a project-less host (a valid empty `config.toml`) stays connectable instead of throwing in `serverConfig`. */
export function serverCwd(config: BridgeConfig): string {
	return config.projects[0]?.path ?? config.stateDir;
}
