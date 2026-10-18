// The `directEndpoints` a client may learn from this host, replicated from T3's
// `apps/server/src/environment/DirectEndpoints.ts`: the addresses this host is bound to, plus — when Tailscale Serve
// is on — the tailnet HTTPS name Serve forwards to loopback. The client's route learner
// (`packages/client-runtime/src/connection/supervisor.ts` → `registry.ts#learnRoutes`) folds these into its route
// list, which is why the bridge answers them at all.
import { isIPv4 } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

import {
	isLoopbackHost,
	isPrivateNetworkHost,
	isTailnetHost,
	isWildcardHost,
	formatHostForUrl,
} from "./host-classification.ts";
import { buildTailscaleHttpsBaseUrl, type TailscaleCli } from "./tailscale.ts";

/** The contract's `ServerDirectEndpoint` (kind `lan` | `tailnet`). */
export type DirectEndpoint = { readonly kind: "lan" | "tailnet"; readonly httpBaseUrl: string };

type NetworkInterfacesMap = ReturnType<typeof networkInterfaces>;

/** T3's `TAILSCALE_ENDPOINT_TIMEOUT`: a slow `tailscale` CLI drops only the tailnet name, never the LAN addresses. */
const TAILSCALE_ENDPOINT_TIMEOUT_MS = 3_000;

/**
 * T3's `isAdvertisableAddress`: these routes are plain HTTP and carry the client's credential, so a public address
 * would send it across the internet unencrypted, and a name (`server.local`) can resolve to a different machine on
 * each client's network.
 */
const isAdvertisableAddress = (address: string): boolean =>
	isIPv4(address) &&
	!address.startsWith("127.") &&
	!address.startsWith("169.254.") &&
	isPrivateNetworkHost(address);

/** Container and VM networks (Docker, libvirt, VMware, VirtualBox, Hyper-V, macOS's `bridge100`+) have private
 * addresses only this machine reaches. A host bridge (`br0`, `vmbr0`) carries the LAN address, so it stays. */
const VIRTUAL_INTERFACE =
	/^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet|podman|cni|flannel|cali|lxcbr|lxdbr|bridge1\d\d)/;

/**
 * Tailscale's own interface: `tailscale0` on Linux, "Tailscale" on Windows. macOS names every tunnel `utunN`, so
 * there it is the one that also carries an address in Tailscale's IPv6 range. Cloudflare WARP and other VPNs assign
 * from the same IPv4 range, so the IPv4 address alone proves nothing.
 */
const isTailscaleInterface = (name: string, entries: readonly NetworkInterfaceInfo[]): boolean =>
	/^tailscale/i.test(name) ||
	entries.some((entry) => entry.family === "IPv6" && isTailnetHost(entry.address));

/** T3's `resolveBoundEndpoints`: the addresses this host listens on, as a client may reach them. A loopback bind
 * answers nothing — a loopback address names whichever machine opens it. */
export function resolveBoundEndpoints(input: {
	readonly host: string | undefined;
	readonly port: number;
	readonly interfaces: NetworkInterfacesMap;
}): readonly DirectEndpoint[] {
	if (isLoopbackHost(input.host)) return [];
	const tailscaleAddresses = new Set(
		Object.entries(input.interfaces).flatMap(([name, entries = []]) =>
			isTailscaleInterface(name, entries) ? entries.map((entry) => entry.address) : [],
		),
	);
	const addresses = isWildcardHost(input.host)
		? Object.entries(input.interfaces)
				.flatMap(([name, entries]) => (VIRTUAL_INTERFACE.test(name) ? [] : (entries ?? [])))
				.filter(
					(entry) =>
						!entry.internal && entry.family === "IPv4" && isAdvertisableAddress(entry.address),
				)
				.map((entry) => entry.address)
		: [input.host as string].filter(isAdvertisableAddress);
	return [...new Set(addresses)].map((address) => ({
		kind: tailscaleAddresses.has(address) ? "tailnet" : "lan",
		httpBaseUrl: `http://${formatHostForUrl(address)}:${String(input.port)}/`,
	}));
}

/**
 * What a connected client learns: the bound addresses, and — only when Serve is enabled and the tailnet name
 * actually answers as this server — the HTTPS name Serve terminates (T3's comment: Serve works even for a loopback-only
 * server, and the name is listed only once it answers, because Serve setup can fail without stopping startup).
 */
export async function resolveDirectEndpoints(input: {
	readonly host: string;
	readonly port: number;
	/** Serve's config; `undefined` (the default) answers no tailnet name. */
	readonly tailscaleServe: { readonly port: number } | undefined;
	readonly tailscale: TailscaleCli;
	readonly interfaces?: NetworkInterfacesMap;
}): Promise<readonly DirectEndpoint[]> {
	const endpoints = [
		...resolveBoundEndpoints({
			host: input.host,
			port: input.port,
			interfaces: input.interfaces ?? networkInterfaces(),
		}),
	];
	if (input.tailscaleServe === undefined) return endpoints;

	const served: DirectEndpoint | null = await withTimeout(
		(async () => {
			const magicDnsName = await input.tailscale.readMagicDnsName().catch(() => null);
			if (magicDnsName === null) return null;
			const httpBaseUrl = buildTailscaleHttpsBaseUrl({
				magicDnsName,
				servePort: input.tailscaleServe?.port,
			});
			return (await input.tailscale.probe(httpBaseUrl)) ? { kind: "tailnet" as const, httpBaseUrl } : null;
		})(),
		TAILSCALE_ENDPOINT_TIMEOUT_MS,
	).catch(() => null);
	if (served !== null) endpoints.push(served);
	return endpoints;
}

/** Resolve `promise`, or the timeout value when it outlives `ms` — T3's `Effect.timeoutOption`, in promises. */
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
