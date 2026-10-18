// Tailscale Serve with the CLI faked — T3's own tests fake its spawner the same way
// (`packages/tailscale/src/tailscale.test.ts`). What is pinned here is the contract with the binary: the exact argv,
// the failures that stay warnings, the messages that never carry the CLI's stderr (they get logged, and stderr can
// hold `tskey-…` auth keys and node names), and the runner's own spawn/exit/timeout paths against a fake `tailscale`
// on PATH. Nothing here runs the real Tailscale.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	buildTailscaleHttpsBaseUrl,
	DEFAULT_TAILSCALE_SERVE_PORT,
	makeTailscaleCli,
	parseTailscaleMagicDnsName,
	TailscaleCommandError,
	type TailscaleRun,
} from "../src/t3/tailscale.ts";

const scratch = await mkdtemp(join(tmpdir(), "pi-durable-t3-ts-"));

/** A `tailscale` that records what it was asked for and answers with `result`. */
function fakeRun(result: { code?: number; stdout?: string; stderr?: string } = {}): {
	run: TailscaleRun;
	calls: () => Array<{ subcommand: string; args: readonly string[]; timeoutMs: number }>;
} {
	const calls: Array<{ subcommand: string; args: readonly string[]; timeoutMs: number }> = [];
	return {
		calls: () => calls,
		run: async (subcommand, args, timeoutMs) => {
			calls.push({ subcommand, args, timeoutMs });
			return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		},
	};
}

it("arms and releases exactly the mapping T3 does", async () => {
	const { run, calls } = fakeRun();
	const cli = makeTailscaleCli({ run });

	await cli.ensureServe({ localPort: 3774 });
	await cli.ensureServe({ localPort: 4931, servePort: 8443, localHost: "100.101.102.103" });
	await cli.disableServe();
	await cli.disableServe({ servePort: 8443 });

	expect(calls().map((call) => call.args)).toEqual([
		// T3's `ensureTailscaleServe`: `--bg`, the HTTPS port, and the loopback target. 443 is the default.
		["serve", "--bg", "--https=443", "http://127.0.0.1:3774"],
		["serve", "--bg", "--https=8443", "http://100.101.102.103:4931"],
		["serve", "--https=443", "off"],
		["serve", "--https=8443", "off"],
	]);
	expect(calls().every((call) => call.subcommand === "serve")).toBe(true);
	// The serve call is T3's 10-second one, the status read the short 1.5-second one.
	expect(calls()[0]!.timeoutMs).toBe(10_000);
	expect(DEFAULT_TAILSCALE_SERVE_PORT).toBe(443);
});

it("names the failure without quoting the CLI", async () => {
	const secret = "tskey-auth-SECRET node=machine";
	const failing = makeTailscaleCli({ run: fakeRun({ code: 2, stderr: `failed to set handler: ${secret}` }).run });
	const error = await failing.ensureServe({ localPort: 3774 }).catch((error) => error);
	expect(error).toBeInstanceOf(TailscaleCommandError);
	expect((error as TailscaleCommandError).kind).toBe("exit");
	expect((error as TailscaleCommandError).exitCode).toBe(2);
	expect((error as TailscaleCommandError).message).toBe("tailscale serve exited with code 2.");
	expect(JSON.stringify({ ...error, message: (error as Error).message })).not.toContain("SECRET");

	// The stderr is classified into T3's named diagnostics, and an unrecognized line is `unknown`, never raw text.
	const diagnostic = async (stderr: string) =>
		(
			(await makeTailscaleCli({ run: fakeRun({ code: 1, stderr }).run })
				.ensureServe({ localPort: 1 })
				.catch((error) => error)) as TailscaleCommandError
		).stderrDiagnostic;
	expect(await diagnostic("Logged out. You need to login first.")).toBe("not-logged-in");
	expect(await diagnostic("Handler does not exist: 443")).toBe("no-existing-handler");
	expect(await diagnostic("open /var/run/tailscale: permission denied")).toBe("permission-denied");
	expect(await diagnostic("some other complaint SECRET")).toBe("unknown");
	expect(await diagnostic("")).toBe(undefined);
});

it("reads the MagicDNS name out of `tailscale status --json`", async () => {
	const { run, calls } = fakeRun({ stdout: `{"Self":{"DNSName":"desktop.tail.ts.net."}}` });
	const cli = makeTailscaleCli({ run });
	// The trailing dot of a FQDN is T3's to strip; the port-less base URL is what a pairing link uses.
	await expect(cli.readMagicDnsName()).resolves.toBe("desktop.tail.ts.net");
	expect(calls()[0]!.args).toEqual(["status", "--json"]);
	expect(calls()[0]!.timeoutMs).toBe(1_500);

	const nameOf = (stdout: string) => makeTailscaleCli({ run: fakeRun({ stdout }).run }).readMagicDnsName();
	await expect(nameOf(`{"Self":{}}`)).resolves.toBeNull();
	await expect(nameOf(`{"Self":{"DNSName":""}}`)).resolves.toBeNull();
	await expect(nameOf(`{"Self":{"DNSName":"  "}}`)).resolves.toBeNull();
	await expect(nameOf(`not json`)).rejects.toThrow("Failed to decode tailscale status JSON.");
	await expect(nameOf(`{"Self":{"DNSName":42}}`)).rejects.toThrow(TailscaleCommandError);
	// A status command that fails is the exit error, named as `status` (a machine with no tailnet is a warning).
	const offline = makeTailscaleCli({ run: fakeRun({ code: 1, stderr: "Logged out." }).run });
	const statusError = (await offline.readMagicDnsName().catch((error) => error)) as TailscaleCommandError;
	expect([statusError.subcommand, statusError.kind, statusError.stderrDiagnostic]).toEqual([
		"status",
		"exit",
		"not-logged-in",
	]);
});

it("parses the name on its own, the way T3 normalizes it", () => {
	expect(parseTailscaleMagicDnsName(`{"Self":{"DNSName":"a.tail.ts.net."}}`)).toBe("a.tail.ts.net");
	expect(parseTailscaleMagicDnsName(`{}`)).toBeNull();
});

it("builds the tailnet URL: 443 is the port that is never printed", () => {
	expect(buildTailscaleHttpsBaseUrl({ magicDnsName: "a.tail.ts.net" })).toBe("https://a.tail.ts.net/");
	expect(buildTailscaleHttpsBaseUrl({ magicDnsName: "a.tail.ts.net", servePort: 443 })).toBe("https://a.tail.ts.net/");
	expect(buildTailscaleHttpsBaseUrl({ magicDnsName: "a.tail.ts.net", servePort: 8443 })).toBe(
		"https://a.tail.ts.net:8443/",
	);
});

it("probes the environment descriptor, and answers false for anything that is not 2xx", async () => {
	const urls: string[] = [];
	const respond = (status: number) =>
		async (input: Parameters<typeof fetch>[0]) => {
			urls.push(String(input));
			return { status } as Response;
		};
	const cli = (fetchImpl: typeof fetch) => makeTailscaleCli({ run: fakeRun().run, fetchImpl });
	await expect(cli(respond(204)).probe("https://a.tail.ts.net:8443/")).resolves.toBe(true);
	await expect(cli(respond(404)).probe("https://a.tail.ts.net/")).resolves.toBe(false);
	await expect(cli(respond(502)).probe("https://a.tail.ts.net/")).resolves.toBe(false);
	// T3 probes the well-known descriptor: the path, and the port it was built with.
	expect(urls).toEqual([
		"https://a.tail.ts.net:8443/.well-known/t3/environment",
		"https://a.tail.ts.net/.well-known/t3/environment",
		"https://a.tail.ts.net/.well-known/t3/environment",
	]);
	// A probe that throws (DNS, TLS, a timeout) is `false`, never a rejection: a config read must answer.
	await expect(
		cli((() => { throw new Error("ENOTFOUND"); }) as typeof fetch).probe("https://a.tail.ts.net/"),
	).resolves.toBe(false);
});

// ── The default runner, against a fake `tailscale` on PATH: spawn, exit and timeout paths with no Tailscale involved.
/** A directory holding a `tailscale` that logs its argv and runs `script`, with the args it was called with. */
async function fakeBin(script: string): Promise<{ dir: string; calls: () => Promise<string> }> {
	const dir = await mkdtemp(join(scratch, "bin-"));
	const log = join(dir, "calls.log");
	await writeFile(join(dir, "tailscale"), `#!/bin/sh\necho "$@" >> ${log}\n${script}\n`, { mode: 0o755 });
	return { dir, calls: () => readFile(log, "utf8").catch(() => "") };
}

/** Run `body` with `dir` first on PATH (this file's tests run in order, and PATH is per worker). */
async function withPath<T>(dir: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env["PATH"];
	process.env["PATH"] = `${dir}:${saved}`;
	try {
		return await body();
	} finally {
		process.env["PATH"] = saved;
	}
}

it("runs the binary: a clean exit, a non-zero exit, a CLI that never answers, and no binary at all", async () => {
	// (1) Exit 0 with the status JSON: the name is read, and the binary saw `status --json`.
	const ok = await fakeBin('if [ "$1" = "status" ]; then echo \'{"Self":{"DNSName":"box.tail.ts.net."}}\'; fi; exit 0');
	await withPath(ok.dir, async () => {
		await expect(makeTailscaleCli().readMagicDnsName()).resolves.toBe("box.tail.ts.net");
	});
	expect(await ok.calls()).toContain("status --json");

	// (2) A non-zero exit reaches the module as the exit error, with the classified stderr.
	const nonzero = await fakeBin('echo "Logged out." >&2; exit 3');
	const exitError = (await withPath(nonzero.dir, () =>
		makeTailscaleCli().readMagicDnsName().catch((error) => error),
	)) as TailscaleCommandError;
	expect(exitError).toBeInstanceOf(TailscaleCommandError);
	expect([exitError.kind, exitError.exitCode, exitError.stderrDiagnostic]).toEqual(["exit", 3, "not-logged-in"]);
	expect(exitError.message).toBe("tailscale status exited with code 3.");
	expect(await nonzero.calls()).toContain("status --json");

	// (3) A CLI that never answers is the timeout error, inside the caller's deadline. The fake hangs on `status`
	// only; `serve` answers at once, so the 1.5s status bound fires without the 10s serve timeout racing it.
	const hung = await fakeBin('if [ "$1" = "status" ]; then sleep 5; fi; exit 0');
	const started = Date.now();
	const timeoutError = (await withPath(hung.dir, () =>
		// The real runner is private; the CLI surface reaches it with the module's own status deadline (1.5s).
		makeTailscaleCli().readMagicDnsName().catch((error) => error),
	)) as TailscaleCommandError;
	expect(timeoutError).toBeInstanceOf(TailscaleCommandError);
	expect([timeoutError.kind, timeoutError.message]).toEqual(["timeout", "tailscale status timed out after 1500ms."]);
	expect(Date.now() - started).toBeLessThan(3_000);
	expect(await hung.calls()).toContain("status --json");

	// (4) No binary on PATH is a named spawn failure, not an uncaught ENOENT.
	const savedPath = process.env["PATH"];
	process.env["PATH"] = "/nonexistent-dir-for-the-tailscale-test";
	const spawnFailure = (await makeTailscaleCli()
		.readMagicDnsName()
		.catch((error) => error)) as TailscaleCommandError;
	process.env["PATH"] = savedPath;
	expect(spawnFailure).toBeInstanceOf(TailscaleCommandError);
	expect([spawnFailure.subcommand, spawnFailure.kind]).toEqual(["status", "spawn"]);
	expect(spawnFailure.message).toBe("Failed to spawn tailscale status.");
});
