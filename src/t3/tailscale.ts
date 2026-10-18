// Tailscale Serve, replicated from T3's `packages/tailscale/src/tailscale.ts` (at the pin) in the bridge's own
// promise style: the CLI calls the bridge makes for the serve feature, and nothing else. Not replicated: the SSH
// prefs (`tailscale debug prefs`) and the tailnet IPv4 list of `tailscale status --json` — T3 reads those for its
// SSH feature, which this host has none of.
//
// Like T3, every failure is a `TailscaleCommandError` whose message NAMES the command and never quotes the CLI's
// stderr: stderr can carry auth keys (`tskey-…`) and node names, and these messages get logged.
import { spawn } from "node:child_process";

/** T3's `DEFAULT_TAILSCALE_SERVE_PORT`: Serve's HTTPS port when the integrator names none. */
export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
/** T3's `TAILSCALE_STATUS_TIMEOUT` — a status read is on the config read's path, so it is short. */
export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
const TAILSCALE_PROBE_TIMEOUT_MS = 2_500;

/** The subcommands this module runs. The Windows spelling is T3's own rule (`tailscale.exe` on `win32`). */
type TailscaleSubcommand = "status" | "serve";
const tailscaleExecutable = (): "tailscale" | "tailscale.exe" =>
	process.platform === "win32" ? "tailscale.exe" : "tailscale";

/** The failure kinds T3 names without quoting the CLI: an unrecognized line is `unknown`, never raw text. */
export type TailscaleStderrDiagnostic =
	| "no-existing-handler"
	| "not-logged-in"
	| "permission-denied"
	| "unknown";

const STDERR_DIAGNOSTIC_PATTERNS: ReadonlyArray<readonly [RegExp, Exclude<TailscaleStderrDiagnostic, "unknown">]> = [
	[/handler does not exist/i, "no-existing-handler"],
	[/not logged in|logged out|needs? login/i, "not-logged-in"],
	[/permission denied|access denied|must be root|operation not permitted/i, "permission-denied"],
];

const stderrDiagnosticOf = (stderr: string): TailscaleStderrDiagnostic | undefined => {
	if (stderr.trim().length === 0) return undefined;
	return STDERR_DIAGNOSTIC_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "unknown";
};

/** One failed CLI call, in T3's set: it could not be spawned, it exited non-zero, it timed out, or (for `status`)
 * its JSON did not decode. The message is safe to log: names, never output. */
export class TailscaleCommandError extends Error {
	readonly subcommand: TailscaleSubcommand;
	readonly kind: "spawn" | "exit" | "timeout" | "parse";
	readonly exitCode: number | undefined;
	readonly stderrDiagnostic: TailscaleStderrDiagnostic | undefined;
	constructor(input: {
		subcommand: TailscaleSubcommand;
		kind: "spawn" | "exit" | "timeout" | "parse";
		exitCode?: number;
		timeoutMs?: number;
		stderrDiagnostic?: TailscaleStderrDiagnostic;
	}) {
		const { subcommand, kind } = input;
		super(
			kind === "spawn"
				? `Failed to spawn tailscale ${subcommand}.`
				: kind === "exit"
					? `tailscale ${subcommand} exited with code ${String(input.exitCode)}.`
					: kind === "timeout"
						? `tailscale ${subcommand} timed out after ${String(input.timeoutMs)}ms.`
						: "Failed to decode tailscale status JSON.",
		);
		this.name = "TailscaleCommandError";
		this.subcommand = subcommand;
		this.kind = kind;
		this.exitCode = input.exitCode;
		this.stderrDiagnostic = input.stderrDiagnostic;
	}
}

/** One CLI call: the args, bounded by `timeoutMs`. Resolves with the exit code and the streams; rejects only when
 * the process cannot be spawned or the timeout fires. Injectable, so tests fake the CLI (as T3's do). */
export type TailscaleRun = (
	subcommand: TailscaleSubcommand,
	args: readonly string[],
	timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runTailscale: TailscaleRun = (subcommand, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			// A non-directory entry on PATH can make node throw synchronously; both that and the async `error` event are
			// the same spawn failure (T3 catches the defect for the same reason).
			child = spawn(tailscaleExecutable(), [...args], { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			reject(new TailscaleCommandError({ subcommand, kind: "spawn" }));
			return;
		}
		child.once("error", () => reject(new TailscaleCommandError({ subcommand, kind: "spawn" })));
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new TailscaleCommandError({ subcommand, kind: "timeout", timeoutMs }));
		}, timeoutMs);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 0, stdout, stderr });
		});
	});

/** `tailscale status --json`'s `Self.DNSName`: MagicDNS, with the trailing dot T3 strips. No name (MagicDNS off) is
 * `null`, not an error. A status that is not the JSON T3 expects is the parse error. */
export function parseTailscaleMagicDnsName(rawStatusJson: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawStatusJson);
	} catch {
		throw new TailscaleCommandError({ subcommand: "status", kind: "parse" });
	}
	const dnsName = (parsed as { Self?: { DNSName?: unknown } })?.Self?.DNSName;
	if (dnsName === undefined || dnsName === null) return null;
	if (typeof dnsName !== "string")
		throw new TailscaleCommandError({ subcommand: "status", kind: "parse" });
	const normalized = dnsName.trim().replace(/\.$/u, "");
	return normalized.length > 0 ? normalized : null;
}

/** T3's `buildTailscaleHttpsBaseUrl`: the tailnet name is an HTTPS origin; 443 is the default and never printed. */
export function buildTailscaleHttpsBaseUrl(input: {
	readonly magicDnsName: string;
	readonly servePort?: number;
}): string {
	const url = new URL(`https://${input.magicDnsName}`);
	const servePort = input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT;
	if (servePort !== DEFAULT_TAILSCALE_SERVE_PORT) url.port = String(servePort);
	url.pathname = "/";
	return url.toString();
}

/** The serve feature's CLI surface. Injectable: a fake stands in for the binary in tests. */
export interface TailscaleCli {
	/** `tailscale status --json` → the MagicDNS name. Rejects `TailscaleCommandError`. */
	readMagicDnsName(): Promise<string | null>;
	/** `tailscale serve --bg --https=<servePort> http://<localHost>:<localPort>` — the mapping T3 arms at startup. */
	ensureServe(input: {
		readonly localPort: number;
		readonly servePort?: number;
		readonly localHost?: string;
	}): Promise<void>;
	/** `tailscale serve --https=<servePort> off` — T3's shutdown release of its own mapping. */
	disableServe(input?: { readonly servePort?: number }): Promise<void>;
	/** Does `baseUrl` answer as a T3 environment? T3 probes `/.well-known/t3/environment`; anything not 2xx (and any
	 * timeout) is `false`, never a throw. */
	probe(baseUrl: string): Promise<boolean>;
}

export function makeTailscaleCli(deps: {
	readonly run?: TailscaleRun;
	readonly fetchImpl?: typeof fetch;
} = {}): TailscaleCli {
	const run = deps.run ?? runTailscale;
	const doFetch = deps.fetchImpl ?? globalThis.fetch;

	const runServe = async (args: readonly string[]): Promise<void> => {
		const result = await run("serve", args, TAILSCALE_SERVE_TIMEOUT_MS);
		if (result.code !== 0) {
			const diagnostic = stderrDiagnosticOf(result.stderr);
			throw new TailscaleCommandError({
				subcommand: "serve",
				kind: "exit",
				exitCode: result.code,
				...(diagnostic === undefined ? {} : { stderrDiagnostic: diagnostic }),
			});
		}
	};

	return {
		readMagicDnsName: async () => {
			const result = await run("status", ["status", "--json"], TAILSCALE_STATUS_TIMEOUT_MS);
			if (result.code !== 0) {
				const diagnostic = stderrDiagnosticOf(result.stderr);
				throw new TailscaleCommandError({
					subcommand: "status",
					kind: "exit",
					exitCode: result.code,
					...(diagnostic === undefined ? {} : { stderrDiagnostic: diagnostic }),
				});
			}
			return parseTailscaleMagicDnsName(result.stdout);
		},
		ensureServe: (input) =>
			runServe([
				"serve",
				"--bg",
				`--https=${String(input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT)}`,
				`http://${input.localHost ?? "127.0.0.1"}:${String(input.localPort)}`,
			]),
		disableServe: (input) =>
			runServe([
				"serve",
				`--https=${String(input?.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT)}`,
				"off",
			]),
		// The probe is a plain GET with a short deadline: T3's `TAILSCALE_PROBE_TIMEOUT`.
		probe: async (baseUrl) => {
			try {
				const url = new URL("/.well-known/t3/environment", baseUrl);
				const response = await doFetch(url.toString(), { signal: AbortSignal.timeout(TAILSCALE_PROBE_TIMEOUT_MS) });
				return response.status >= 200 && response.status < 300;
			} catch {
				return false;
			}
		},
	};
}

/** One `tailscale status --json` against the host's own CLI: the MagicDNS name. For a CLI that prints links (T3's
 * `t3 pair --tailscale` reads it the same way). Rejects `TailscaleCommandError`. */
export const readTailscaleMagicDnsName = (): Promise<string | null> =>
	makeTailscaleCli().readMagicDnsName();
