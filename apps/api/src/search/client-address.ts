import { BlockList, isIP } from "node:net";
import { ConfigurationError } from "../config.ts";

export interface TrustedProxies {
  has(address: string): boolean;
  isCloudflareEdge?(address: string): boolean;
}

export interface ForwardingHeaders {
  readonly cfConnectingIp?: string | undefined;
  readonly forwardedFor?: string | undefined;
}

const BRACKETED = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_WITH_PORT = /^(\d+\.\d+\.\d+\.\d+):\d{1,5}$/;

function unwrapped(address: string): string {
  const trimmed = address.trim();
  return BRACKETED.exec(trimmed)?.[1] ?? IPV4_WITH_PORT.exec(trimmed)?.[1] ?? trimmed;
}

/** The address without brackets or port, and an IPv4 address mapped into IPv6 (any form) as IPv4. */
function plain(address: string): string {
  const value = unwrapped(address);
  if (isIP(value) !== 6) return value;
  const groups = ipv6Groups(value);
  if (
    groups === null ||
    groups[5] !== "ffff" ||
    groups.slice(0, 5).some((group) => group !== "0")
  ) {
    return value;
  }
  const [high = 0, low = 0] = groups.slice(6).map((group) => Number.parseInt(group, 16));
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function familyOf(address: string): "ipv4" | "ipv6" | null {
  const version = isIP(address);
  return version === 4 ? "ipv4" : version === 6 ? "ipv6" : null;
}

interface ProxyEntry {
  readonly address: string;
  readonly family: "ipv4" | "ipv6";
  readonly bits: number | null;
}

function proxyEntry(entry: string): ProxyEntry | null {
  const [address = "", prefix, extra] = entry.split("/");
  const family = familyOf(address);
  if (family === null || extra !== undefined) return null;
  if (prefix === undefined) return { address, family, bits: null };
  const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : -1;
  return bits >= 0 && bits <= (family === "ipv4" ? 32 : 128) ? { address, family, bits } : null;
}

function readAddressList(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): (address: string) => boolean {
  const list = new BlockList();
  const entries = (env[name] ?? "")
    .split(",")
    .map((raw) => raw.trim())
    .filter((entry) => entry !== "");
  for (const entry of entries) {
    const parsed = proxyEntry(entry);
    if (parsed === null) {
      throw new ConfigurationError(
        `${name} must be a comma list of IP addresses or subnets, got ${entry}`,
      );
    }
    if (parsed.bits === null) list.addAddress(parsed.address, parsed.family);
    else list.addSubnet(parsed.address, parsed.bits, parsed.family);
  }
  return (address) => {
    if (entries.length === 0) return false;
    const value = plain(address);
    const family = familyOf(value);
    return family !== null && list.check(value, family);
  };
}

/**
 * `API_TRUSTED_PROXIES`: a comma list of addresses and subnets (`127.0.0.1,::1`, `10.0.0.0/8`) of
 * the proxies in front of the API. Only a request whose socket peer is one of them may name its
 * client in `X-Forwarded-For`. `API_CLOUDFLARE_RANGES`: the Cloudflare edge ranges
 * (https://www.cloudflare.com/ips/); `CF-Connecting-IP` counts only when the hop that reached the
 * API or its trusted proxies is one of them. Unset or empty trusts nobody.
 */
export function readTrustedProxies(
  env: Readonly<Record<string, string | undefined>>,
): TrustedProxies {
  const proxies = readAddressList(env, "API_TRUSTED_PROXIES");
  const cloudflare = readAddressList(env, "API_CLOUDFLARE_RANGES");
  return { has: proxies, isCloudflareEdge: cloudflare };
}

function usable(address: string | undefined): string | null {
  if (address === undefined) return null;
  const value = plain(address);
  return familyOf(value) === null ? null : value;
}

/** The nearest hop that is not a trusted proxy: the peer, or a hop of `X-Forwarded-For` from the right. */
function edgeHop(
  socket: string,
  forwardedFor: string | undefined,
  trusted: TrustedProxies,
): string {
  if (!trusted.has(socket)) return socket;
  const hops = (forwardedFor ?? "").split(",").reverse();
  for (const hop of hops) {
    const address = usable(hop);
    if (address === null) break;
    if (!trusted.has(address)) return address;
  }
  return socket;
}

/**
 * The client a request came from. A peer that is not a trusted proxy is the client; behind a
 * trusted peer (Caddy) the rightmost hop of `X-Forwarded-For` that is not itself a trusted proxy
 * is, since hops left of it can be forged. When that hop is a Cloudflare edge, Cloudflare wrote
 * `CF-Connecting-IP` and it names the client; from any other hop the header is ignored, so a
 * visitor who reaches the origin directly cannot pick its own limiter key.
 */
export function clientAddress(
  peer: string,
  headers: ForwardingHeaders,
  trusted: TrustedProxies,
): string {
  const edge = edgeHop(plain(peer), headers.forwardedFor, trusted);
  if (trusted.isCloudflareEdge?.(edge) !== true) return edge;
  return usable(headers.cfConnectingIp) ?? edge;
}

function ipv6Groups(address: string): string[] | null {
  const zoneless = address.split("%")[0] ?? "";
  let text = zoneless;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(Math.max(fill, 0)).fill("0"), ...right];
  return groups.length === 8
    ? groups.map((group) => Number.parseInt(group, 16).toString(16))
    : null;
}

/** The rate limit key of a client: an IPv4 address as it is, an IPv6 address by its /64. */
export function limiterKey(address: string): string {
  const value = plain(address);
  const family = familyOf(value.split("%")[0] ?? "");
  if (family !== "ipv6") return value;
  const groups = ipv6Groups(value);
  return groups === null ? value : `${groups.slice(0, 4).join(":")}::/64`;
}

const SLASH_64 = /^((?:[0-9a-f]{1,4}:){3})[0-9a-f]{1,4}::\/64$/;

/** The wider key a limiter falls back to when its table is full: an IPv6 /64 key by its /48. */
export function aggregateKey(key: string): string {
  const match = SLASH_64.exec(key);
  return match ? `${match[1]}:/48` : key;
}

const IPV6_PREFIX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4}):[0-9a-f:]*\/(?:48|64)$/;
const IPV4_ADDRESS = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

/**
 * The widest key a limiter falls back to when its overflow table is full too: an IPv6 key by its
 * /32 (one provider allocation), an IPv4 address by its /16, any other key as it is.
 */
export function networkKey(key: string): string {
  const ipv6 = IPV6_PREFIX.exec(key);
  if (ipv6) return `${ipv6[1]}:${ipv6[2]}::/32`;
  const ipv4 = IPV4_ADDRESS.exec(key);
  return ipv4 ? `${ipv4[1]}.${ipv4[2]}.0.0/16` : key;
}
