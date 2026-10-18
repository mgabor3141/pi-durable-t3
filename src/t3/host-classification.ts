// Host classification, replicated from T3's `packages/shared/src/hostClassification.ts` and the three helpers of
// `apps/server/src/startupAccess.ts` that the direct endpoints need — the subset this host uses (T3's favicon/public
// host rules belong to features this bridge has none of).
//
// Two facts drive it: a MagicDNS name (`*.ts.net`) and `fd7a:115c:a1e0::/48` are only ever Tailscale's, while
// Tailscale's IPv4 range (100.64.0.0/10) is shared with Cloudflare WARP and other VPNs, so an IPv4 address alone
// proves nothing about the interface that carries it.

export const normalizeHostname = (host: string): string =>
	host
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.+$/u, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
	const parts = normalizeHostname(host).split(".").map(Number);
	return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: null;
};

const parseIpv6Address = (host: string): readonly number[] | null => {
	const normalized = normalizeHostname(host);
	if (!normalized.includes(":")) return null;
	const halves = normalized.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	if ([...head, ...tail].some((part) => !/^[\da-f]{1,4}$/u.test(part))) return null;
	const missing = 8 - head.length - tail.length;
	if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
	return [...head, ...Array.from({ length: missing }, () => "0"), ...tail].map((part) => Number.parseInt(part, 16));
};

const ipv6PrefixMatches = (
	address: readonly number[],
	prefix: readonly number[],
	prefixLength: number,
): boolean => {
	const fullHextets = Math.floor(prefixLength / 16);
	if (address.slice(0, fullHextets).some((part, index) => part !== prefix[index])) return false;
	const remainingBits = prefixLength % 16;
	if (remainingBits === 0) return true;
	const mask = (0xffff << (16 - remainingBits)) & 0xffff;
	return (address[fullHextets]! & mask) === (prefix[fullHextets]! & mask);
};

const isPrivateIpv4Address = (parts: readonly number[]): boolean =>
	parts[0] === 0 ||
	parts[0] === 10 ||
	parts[0] === 127 ||
	(parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
	(parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
	(parts[0] === 192 && parts[1] === 168) ||
	(parts[0] === 169 && parts[1] === 254) ||
	(parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19);

export const isLocalLoopbackHost = (host: string): boolean => {
	const normalized = normalizeHostname(host);
	if (normalized === "localhost" || normalized === "::1") return true;
	return parseIpv4Address(normalized)?.[0] === 127;
};

/** T3's `startupAccess.isLoopbackHost`: an unset host is loopback (the default bind). */
export const isLoopbackHost = (host: string | undefined): boolean => {
	if (!host || host.length === 0) return true;
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "[::1]" ||
		host.startsWith("127.")
	);
};

export const isWildcardHost = (host: string | undefined): boolean =>
	host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
	host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/** A name or address only Tailscale uses: a MagicDNS name, or an address in `fd7a:115c:a1e0::/48`. */
export const isTailnetHost = (host: string): boolean => {
	const normalized = normalizeHostname(host);
	if (normalized.endsWith(".ts.net")) return true;
	const ipv6 = parseIpv6Address(normalized);
	return ipv6 !== null && ipv6PrefixMatches(ipv6, [0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0], 48);
};

/** RFC 1918 / shared-address-space / link-local, plus the private name suffixes (`.local`, `.ts.net`, …) — T3's rule,
 * which decides what a server may advertise to a client. */
export const isPrivateNetworkHost = (host: string): boolean => {
	const normalized = normalizeHostname(host);
	if (
		normalized === "::" ||
		isLocalLoopbackHost(normalized) ||
		normalized.endsWith(".localhost") ||
		normalized.endsWith(".local") ||
		normalized === "home.arpa" ||
		normalized.endsWith(".home.arpa") ||
		(!normalized.includes(".") && !normalized.includes(":"))
	)
		return true;
	if (normalized.endsWith(".ts.net")) return true;
	const parts = parseIpv4Address(normalized);
	if (parts) return isPrivateIpv4Address(parts);
	const firstIpv6Token = normalizeHostname(host).split(":", 1)[0] ?? "";
	if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
	const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
	return (
		Number.isInteger(firstIpv6Hextet) &&
		((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
	);
};
