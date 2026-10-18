// The routes a client learns from this host (`directEndpoints`), with the interfaces faked and the `tailscale` CLI
// faked — T3's own tests for `apps/server/src/environment/DirectEndpoints.ts` pin the same shapes. The client folds
// these into its route list (`packages/client-runtime/src/connection/registry.ts#learnRoutes`), so the KIND decides
// what the app calls the route ("LAN" vs "Tailscale") and the tailnet name is the only HTTPS one.
import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveBoundEndpoints, resolveDirectEndpoints } from "../src/t3/direct-endpoints.ts";
import type { TailscaleCli } from "../src/t3/tailscale.ts";

const entry = (address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo =>
	family === "IPv4"
		? { address, netmask: "255.255.255.0", family, mac: "aa:bb:cc:dd:ee:ff", internal, cidr: `${address}/24` }
		: {
				address,
				netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
				family,
				mac: "aa:bb:cc:dd:ee:ff",
				internal,
				cidr: `${address}/128`,
				scopeid: 0, // an IPv6 interface entry carries one (T3's pin does too)
		  };

// A loopback, a LAN interface, a public one, a Tailscale interface (its IPv6 is the tailnet range macOS names a
// tunnel by), and a Docker bridge that only this machine can reach.
const INTERFACES = {
	lo: [entry("127.0.0.1", "IPv4", true)],
	eth0: [entry("192.168.1.10", "IPv4"), entry("fe80::1", "IPv6")],
	eth1: [entry("203.0.113.20", "IPv4")],
	tailscale0: [entry("100.101.102.103", "IPv4"), entry("fd7a:115c:a1e0::1", "IPv6")],
	docker0: [entry("172.17.0.1", "IPv4")],
};

describe("resolveBoundEndpoints", () => {
	it("answers nothing for a loopback bind, where an address names the client's own machine", () => {
		expect(resolveBoundEndpoints({ host: "127.0.0.1", port: 3774, interfaces: INTERFACES })).toEqual([]);
		expect(resolveBoundEndpoints({ host: "localhost", port: 3774, interfaces: INTERFACES })).toEqual([]);
	});

	it("lists every advertiser address for a wildcard bind and tags the tailnet one", () => {
		expect(resolveBoundEndpoints({ host: "0.0.0.0", port: 3774, interfaces: INTERFACES })).toEqual([
			{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3774/" },
			{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3774/" },
		]);
		// The public address is not advertiser (a plain-HTTP route carrying the client's credential), and Docker's
		// bridge is a network only this machine reaches.
	});

	it("answers exactly the address a named bind listens on", () => {
		expect(resolveBoundEndpoints({ host: "100.127.227.28", port: 4931, interfaces: INTERFACES })).toEqual([
			{ kind: "lan", httpBaseUrl: "http://100.127.227.28:4931/" },
		]);
		// A public address binds nothing worth advertising.
		expect(resolveBoundEndpoints({ host: "203.0.113.20", port: 3774, interfaces: INTERFACES })).toEqual([]);
	});
});

/** A `tailscale` that answers as a machine on a tailnet, with the probe's answer chosen per test. */
function fakeTailscale(input: {
	readonly magicDnsName?: string | null;
	readonly reachable?: boolean;
	readonly statusFails?: boolean;
	readonly statusHangs?: boolean;
}): TailscaleCli & { probes: string[]; calls: number } {
	const cli = {
		probes: [] as string[],
		calls: 0,
		readMagicDnsName: async () => {
			cli.calls++;
			if (input.statusHangs === true) return new Promise<string>(() => undefined);
			if (input.statusFails === true) throw new Error("tailscale status exited with code 1.");
			return input.magicDnsName ?? null;
		},
		ensureServe: async () => {},
		disableServe: async () => {},
		probe: async (baseUrl: string) => {
			cli.probes.push(baseUrl);
			return input.reachable ?? false;
		},
	};
	return cli;
}

describe("resolveDirectEndpoints", () => {
	it("runs no tailscale command and advertises no tailnet name when Serve is off", async () => {
		const tailscale = fakeTailscale({ magicDnsName: "a.tail.ts.net", reachable: true });
		expect(
			await resolveDirectEndpoints({
				host: "0.0.0.0",
				port: 3774,
				tailscaleServe: undefined,
				tailscale,
				interfaces: INTERFACES,
			}),
		).toEqual([
			{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3774/" },
			{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3774/" },
		]);
		expect([tailscale.calls, tailscale.probes.length]).toEqual([0, 0]);
	});

	it("adds the served HTTPS name, on the Serve port, once it answers as this server", async () => {
		const tailscale = fakeTailscale({ magicDnsName: "machine.example-tail.ts.net", reachable: true });
		const endpoints = await resolveDirectEndpoints({
			host: "127.0.0.1",
			port: 4931,
			tailscaleServe: { port: 8443 },
			tailscale,
			interfaces: INTERFACES,
		});
		// A loopback-only server gains the tailnet name: Serve terminates HTTPS and forwards to loopback.
		expect(endpoints).toEqual([{ kind: "tailnet", httpBaseUrl: "https://machine.example-tail.ts.net:8443/" }]);
		// The name is listed only after the built base URL answers (the descriptor path is pinned in tailscale.test.ts).
		expect(tailscale.probes).toEqual(["https://machine.example-tail.ts.net:8443/"]);
	});

	it("leaves the name out when Serve is not answering, and never stalls the config read", async () => {
		const bound = { host: "127.0.0.1", port: 3774, interfaces: INTERFACES } as const;
		// Serve configured, the name known, the port not answering (Serve setup can fail without stopping startup).
		expect(
			await resolveDirectEndpoints({
				...bound,
				tailscaleServe: { port: 443 },
				tailscale: fakeTailscale({ magicDnsName: "a.tail.ts.net", reachable: false }),
			}),
		).toEqual([]);
		// No MagicDNS name: nothing to probe.
		const noName = fakeTailscale({ magicDnsName: null, reachable: true });
		expect(await resolveDirectEndpoints({ ...bound, tailscaleServe: { port: 443 }, tailscale: noName })).toEqual([]);
		expect(noName.probes).toEqual([]);
		// No Tailscale at all: the CLI fails, and the LAN addresses already found are still the answer.
		const interfaces = { ...INTERFACES };
		expect(
			await resolveDirectEndpoints({
				host: "0.0.0.0",
				port: 3774,
				tailscaleServe: { port: 443 },
				tailscale: fakeTailscale({ statusFails: true }),
				interfaces,
			}),
		).toEqual([
			{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3774/" },
			{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3774/" },
		]);
	});

	it("drops the tailnet name when the CLI is slower than the endpoint budget", async () => {
		const started = Date.now();
		const endpoints = await resolveDirectEndpoints({
			host: "0.0.0.0",
			port: 3774,
			tailscaleServe: { port: 443 },
			tailscale: fakeTailscale({ statusHangs: true }),
			interfaces: INTERFACES,
		});
		// T3's 3-second budget: a slow `tailscale` drops only the tailnet name, never the addresses in hand.
		expect(endpoints).toEqual([
			{ kind: "lan", httpBaseUrl: "http://192.168.1.10:3774/" },
			{ kind: "tailnet", httpBaseUrl: "http://100.101.102.103:3774/" },
		]);
		expect(Date.now() - started).toBeGreaterThanOrEqual(2_500);
		expect(Date.now() - started).toBeLessThan(6_000);
	}, 10_000);
});
