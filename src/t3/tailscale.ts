// Tailscale Serve, replicated from T3's `packages/tailscale/src/tailscale.ts` (at the pin) in the bridge's own
// promise style: the CLI calls the bridge makes for the serve feature, and nothing else. Not replicated: T3's SSH
// prefs and tailnet IPv4 list (no SSH feature here), its LAN-address advertisement, and T3's unconditional arming —
// this host checks `tailscale serve status` first, a deliberate deviation: safer than T3, it never replaces a
// mapping this host did not create.
//
// Like T3, every failure is a `TailscaleCommandError` whose message NAMES the command and never quotes the CLI's
// stderr: stderr can carry auth keys (`tskey-…`) and node names, and these messages get logged. `stderrDiagnostic`
// is T3's named classification of the stderr — safe to log, and the bridge's warnings carry it.
import { spawn } from "node:child_process";

/** T3's `DEFAULT_TAILSCALE_SERVE_PORT`: Serve's HTTPS port when the integrator names none. */
export const DEFAULT_TAILSCALE_SERVE_PORT = 443;
/** T3's `TAILSCALE_STATUS_TIMEOUT` — status reads sit on short paths (arm check, config read), so they are short. */
export const TAILSCALE_STATUS_TIMEOUT_MS = 1_500;
const TAILSCALE_SERVE_TIMEOUT_MS = 10_000;
const TAILSCALE_PROBE_TIMEOUT_MS = 2_500;
/** T3's `TAILSCALE_ENDPOINT_TIMEOUT`: a slow CLI drops the advertised name, never the config read. */
const TAILSCALE_ENDPOINT_TIMEOUT_MS = 3_000;

type TailscaleSubcommand = "status" | "serve";
const tailscaleExecutable = (): "tailscale" | "tailscale.exe" =>
	process.platform === "win32" ? "tailscale.exe" : "tailscale";

/** T3's failure kinds, named without quoting the CLI: an unrecognized line is `unknown`, never raw text. */
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

/** One failed CLI call, in T3's set: it could not be spawned, it exited non-zero, it timed out, or its JSON did not
 * decode. The message is safe to log: names, never output. */
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

/** One CLI call: the args, bounded by `timeoutMs`. Injectable, so tests fake the CLI (as T3's do). */
export type TailscaleRun = (
	subcommand: TailscaleSubcommand,
	args: readonly string[],
	timeoutMs: number,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const runTailscale: TailscaleRun = (subcommand, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			// A non-directory PATH entry can make `spawn` throw synchronously; that and the async `error` event are
			// the same spawn failure.
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
			// A signal-killed child reports a null code: that is a failure, not a clean exit.
			resolve({ code: code ?? -1, stdout, stderr });
		});
	});

/** `tailscale status --json`'s `Self.DNSName`: MagicDNS, with the trailing dot stripped. No name (MagicDNS off) is
 * `null`, not an error. A status that is not the expected JSON is the parse error. */
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

/** `tailscale serve status --json` → the proxy targets mapped to `servePort`, or `null` when the port is not mapped.
 * An empty array is a mapping whose target the JSON does not report: treat it as taken. */
export function parseServeStatusTargets(rawJson: string, servePort: number): string[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawJson);
	} catch {
		throw new TailscaleCommandError({ subcommand: "serve", kind: "parse" });
	}
	const doc = parsed as {
		TCP?: Record<string, unknown>;
		Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>;
	};
	const port = String(servePort);
	if (doc?.TCP === undefined || !(port in doc.TCP)) return null;
	const targets: string[] = [];
	for (const [key, entry] of Object.entries(doc.Web ?? {})) {
		if (!key.endsWith(`:${port}`)) continue;
		for (const [path, handler] of Object.entries(entry?.Handlers ?? {})) {
			if (typeof handler?.Proxy === "string") targets.push(handler.Proxy + (path === "/" ? "" : path));
		}
	}
	return targets;
}

/** The serve feature's CLI surface. Injectable: a fake stands in for the binary in tests. */
export interface TailscaleCli {
	/** `tailscale status --json` → the MagicDNS name. Rejects `TailscaleCommandError`. */
	readMagicDnsName(): Promise<string | null>;
	/** `tailscale serve status --json` → what maps to `servePort` (see `parseServeStatusTargets`). */
	readServeTargets(input: { readonly servePort: number }): Promise<string[] | null>;
	/** `tailscale serve --bg --https=<servePort> http://<localHost>:<localPort>` — the mapping to arm at startup. */
	ensureServe(input: {
		readonly localPort: number;
		readonly servePort?: number;
		readonly localHost?: string;
	}): Promise<void>;
	/** `tailscale serve --https=<servePort> off` — the shutdown release of an armed mapping. */
	disableServe(input?: { readonly servePort?: number }): Promise<void>;
	/** Does `baseUrl` answer as a T3 environment? Anything not 2xx (and any timeout) is `false`, never a throw. */
	probe(baseUrl: string): Promise<boolean>;
}

export function makeTailscaleCli(deps: {
	readonly run?: TailscaleRun;
	readonly fetchImpl?: typeof fetch;
} = {}): TailscaleCli {
	const run = deps.run ?? runTailscale;
	const doFetch = deps.fetchImpl ?? globalThis.fetch;

	const runChecked = async (subcommand: TailscaleSubcommand, args: readonly string[], timeoutMs: number) => {
		const result = await run(subcommand, args, timeoutMs);
		if (result.code !== 0) {
			const diagnostic = stderrDiagnosticOf(result.stderr);
			throw new TailscaleCommandError({
				subcommand,
				kind: "exit",
				exitCode: result.code,
				...(diagnostic === undefined ? {} : { stderrDiagnostic: diagnostic }),
			});
		}
		return result;
	};

	return {
		readMagicDnsName: async () => {
			const result = await runChecked("status", ["status", "--json"], TAILSCALE_STATUS_TIMEOUT_MS);
			return parseTailscaleMagicDnsName(result.stdout);
		},
		readServeTargets: async ({ servePort }) => {
			const result = await runChecked("serve", ["serve", "status", "--json"], TAILSCALE_STATUS_TIMEOUT_MS);
			return parseServeStatusTargets(result.stdout, servePort);
		},
		ensureServe: (input) =>
			runChecked("serve", [
				"serve",
				"--bg",
				`--https=${String(input.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT)}`,
				`http://${input.localHost ?? "127.0.0.1"}:${String(input.localPort)}`,
			], TAILSCALE_SERVE_TIMEOUT_MS).then(() => undefined),
		disableServe: (input) =>
			runChecked("serve", [
				"serve",
				`--https=${String(input?.servePort ?? DEFAULT_TAILSCALE_SERVE_PORT)}`,
				"off",
			], TAILSCALE_SERVE_TIMEOUT_MS).then(() => undefined),
		// A plain GET with a short deadline.
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

/** The one `directEndpoints` entry this host advertises: the tailnet HTTPS URL Serve terminates. */
export type ServedEndpoint = { readonly kind: "tailnet"; readonly httpBaseUrl: string };

/** The tailnet URL a paired client may learn from this host: `null` with Serve off, no MagicDNS name, or a name that
 * does not answer as this server — Serve setup can fail without stopping startup, so the name is listed only once it
 * answers. Bounded by T3's endpoint budget: a slow CLI drops the name, never the config read. */
export async function resolveServedEndpoint(input: {
	readonly servePort: number;
	readonly tailscale: TailscaleCli;
}): Promise<ServedEndpoint | null> {
	const find = async (): Promise<ServedEndpoint | null> => {
		const magicDnsName = await input.tailscale.readMagicDnsName().catch(() => null);
		if (magicDnsName === null) return null;
		const httpBaseUrl = buildTailscaleHttpsBaseUrl({ magicDnsName, servePort: input.servePort });
		return (await input.tailscale.probe(httpBaseUrl)) ? { kind: "tailnet", httpBaseUrl } : null;
	};
	return withTimeout(find(), TAILSCALE_ENDPOINT_TIMEOUT_MS).catch(() => null);
}

/** Resolve `promise`, or reject at `ms`. The promise keeps running after the timeout; the caller stops waiting. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
