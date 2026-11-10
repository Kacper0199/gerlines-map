import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../config.ts";
import { clientAddress, limiterKey, readTrustedProxies } from "./client-address.ts";

const CADDY = readTrustedProxies({ API_TRUSTED_PROXIES: "127.0.0.1, ::1" });
const NONE = readTrustedProxies({});
const CLOUDFLARE_RANGES = "173.245.48.0/20, 2400:cb00::/32";
const BEHIND_CLOUDFLARE = readTrustedProxies({
  API_TRUSTED_PROXIES: "127.0.0.1, ::1",
  API_CLOUDFLARE_RANGES: CLOUDFLARE_RANGES,
});
const CLOUDFLARE_EDGE = "173.245.48.10";

describe("readTrustedProxies", () => {
  it("reads addresses and subnets of both families, and trusts nobody when unset", () => {
    const trusted = readTrustedProxies({ API_TRUSTED_PROXIES: "10.0.0.0/8,fd00::/8, 192.0.2.7" });
    expect(trusted.has("10.20.30.40")).toBe(true);
    expect(trusted.has("fd12::1")).toBe(true);
    expect(trusted.has("192.0.2.7")).toBe(true);
    expect(trusted.has("192.0.2.8")).toBe(false);
    expect(NONE.has("127.0.0.1")).toBe(false);
    expect(readTrustedProxies({ API_TRUSTED_PROXIES: " " }).has("127.0.0.1")).toBe(false);
  });

  it.each(["localhost", "10.0.0.0/33", "1.2.3", "::1/129", "10.0.0.0/"])("refuses %s", (entry) => {
    expect(() => readTrustedProxies({ API_TRUSTED_PROXIES: entry })).toThrow(ConfigurationError);
    expect(() => readTrustedProxies({ API_TRUSTED_PROXIES: entry })).toThrow(/API_TRUSTED_PROXIES/);
    expect(() => readTrustedProxies({ API_CLOUDFLARE_RANGES: entry })).toThrow(
      /API_CLOUDFLARE_RANGES/,
    );
  });

  it("reads the Cloudflare edge ranges apart from the proxies, and knows none when unset", () => {
    expect(BEHIND_CLOUDFLARE.isCloudflareEdge?.(CLOUDFLARE_EDGE)).toBe(true);
    expect(BEHIND_CLOUDFLARE.isCloudflareEdge?.("2400:cb00:1::5")).toBe(true);
    expect(BEHIND_CLOUDFLARE.isCloudflareEdge?.("127.0.0.1")).toBe(false);
    expect(BEHIND_CLOUDFLARE.has(CLOUDFLARE_EDGE)).toBe(false);
    expect(CADDY.isCloudflareEdge?.(CLOUDFLARE_EDGE)).toBe(false);
  });
});

describe("clientAddress", () => {
  it("ignores every forwarding header from a peer that is not trusted", () => {
    expect(
      clientAddress(
        "198.51.100.9",
        { cfConnectingIp: "203.0.113.1", forwardedFor: "203.0.113.2" },
        CADDY,
      ),
    ).toBe("198.51.100.9");
    expect(clientAddress("127.0.0.1", { cfConnectingIp: "203.0.113.1" }, NONE)).toBe("127.0.0.1");
  });

  it("never takes CF-Connecting-IP from a trusted proxy alone, so rotating it changes nothing", () => {
    for (const forged of ["203.0.113.1", "203.0.113.2", "2001:db8::7", "203.0.113.3"]) {
      expect(clientAddress("127.0.0.1", { cfConnectingIp: forged }, CADDY)).toBe("127.0.0.1");
      expect(
        clientAddress("127.0.0.1", { cfConnectingIp: forged, forwardedFor: "198.51.100.9" }, CADDY),
      ).toBe("198.51.100.9");
      expect(
        clientAddress(
          "127.0.0.1",
          { cfConnectingIp: forged, forwardedFor: "198.51.100.9" },
          BEHIND_CLOUDFLARE,
        ),
      ).toBe("198.51.100.9");
    }
  });

  it("takes CF-Connecting-IP when the hop that reached the trusted proxy is a Cloudflare edge", () => {
    expect(
      clientAddress(
        "127.0.0.1",
        { cfConnectingIp: " 203.0.113.1 ", forwardedFor: CLOUDFLARE_EDGE },
        BEHIND_CLOUDFLARE,
      ),
    ).toBe("203.0.113.1");
    expect(
      clientAddress(
        "::1",
        { cfConnectingIp: "2001:db8::1", forwardedFor: `6.6.6.6, ${CLOUDFLARE_EDGE}, 127.0.0.1` },
        BEHIND_CLOUDFLARE,
      ),
    ).toBe("2001:db8::1");
  });

  it("takes CF-Connecting-IP when the socket peer itself is a Cloudflare edge", () => {
    expect(
      clientAddress("2400:cb00:1::5", { cfConnectingIp: "203.0.113.1" }, BEHIND_CLOUDFLARE),
    ).toBe("203.0.113.1");
    expect(clientAddress(CLOUDFLARE_EDGE, { cfConnectingIp: "203.0.113.1" }, NONE)).toBe(
      CLOUDFLARE_EDGE,
    );
  });

  it("keys a Cloudflare hop without a usable CF-Connecting-IP by the hop", () => {
    expect(
      clientAddress(
        "127.0.0.1",
        { cfConnectingIp: "junk", forwardedFor: CLOUDFLARE_EDGE },
        BEHIND_CLOUDFLARE,
      ),
    ).toBe(CLOUDFLARE_EDGE);
  });

  it("else takes the rightmost X-Forwarded-For hop that is not trusted, so a forged left hop does not count", () => {
    expect(clientAddress("::1", { forwardedFor: "6.6.6.6, 203.0.113.4, 127.0.0.1" }, CADDY)).toBe(
      "203.0.113.4",
    );
    expect(
      clientAddress(
        "127.0.0.1",
        { cfConnectingIp: "not-an-ip", forwardedFor: "203.0.113.5" },
        CADDY,
      ),
    ).toBe("203.0.113.5");
  });

  it("falls back to the peer when no hop is usable", () => {
    expect(clientAddress("127.0.0.1", { forwardedFor: "127.0.0.1, junk" }, CADDY)).toBe(
      "127.0.0.1",
    );
    expect(clientAddress("127.0.0.1", {}, CADDY)).toBe("127.0.0.1");
  });

  it("reads an IPv4 address mapped into IPv6 as IPv4", () => {
    expect(clientAddress("::ffff:127.0.0.1", { forwardedFor: "203.0.113.1" }, CADDY)).toBe(
      "203.0.113.1",
    );
    expect(
      clientAddress("::ffff:173.245.48.10", { cfConnectingIp: "203.0.113.1" }, BEHIND_CLOUDFLARE),
    ).toBe("203.0.113.1");
    expect(clientAddress("::ffff:198.51.100.9", {}, NONE)).toBe("198.51.100.9");
  });

  it("reads a mapped IPv4 address written in hex or in full as IPv4", () => {
    expect(clientAddress("::ffff:c633:6409", {}, NONE)).toBe("198.51.100.9");
    expect(clientAddress("0:0:0:0:0:FFFF:c633:6409", {}, NONE)).toBe("198.51.100.9");
    expect(clientAddress("::ffff:7f00:1", { forwardedFor: "203.0.113.1" }, CADDY)).toBe(
      "203.0.113.1",
    );
  });

  it("reads a forwarded hop with a port or in brackets", () => {
    expect(clientAddress("127.0.0.1", { forwardedFor: "5.5.5.5:80" }, CADDY)).toBe("5.5.5.5");
    expect(clientAddress("127.0.0.1", { forwardedFor: "[2001:db8::1]" }, CADDY)).toBe(
      "2001:db8::1",
    );
    expect(clientAddress("127.0.0.1", { forwardedFor: "[2001:db8::1]:443" }, CADDY)).toBe(
      "2001:db8::1",
    );
    expect(clientAddress("127.0.0.1", { forwardedFor: "6.6.6.6, [::1]:9000" }, CADDY)).toBe(
      "6.6.6.6",
    );
  });
});

describe("clientAddress behind the production edge (infra/compose.production.yaml)", () => {
  const ranges = readFileSync(
    new URL("../../../../infra/production/cloudflare-ips.txt", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .join(",");
  const EDGE = "172.31.250.10";
  const production = readTrustedProxies({
    API_TRUSTED_PROXIES: EDGE,
    API_CLOUDFLARE_RANGES: ranges,
  });

  it("names the visitor Cloudflare names when Caddy appended a Cloudflare peer", () => {
    expect(
      clientAddress(
        EDGE,
        { forwardedFor: "6.6.6.6, 203.0.113.9, 162.158.1.2", cfConnectingIp: "203.0.113.9" },
        production,
      ),
    ).toBe("203.0.113.9");
    expect(
      clientAddress(
        EDGE,
        { forwardedFor: "2001:db8::9, 2a06:98c0::1", cfConnectingIp: "2001:db8::9" },
        production,
      ),
    ).toBe("2001:db8::9");
  });

  it("names the peer Caddy saw when it was no Cloudflare edge, whatever the headers say", () => {
    expect(
      clientAddress(EDGE, { forwardedFor: "198.51.100.4", cfConnectingIp: "7.7.7.7" }, production),
    ).toBe("198.51.100.4");
  });

  it("ignores the forwarding headers of anyone who reaches the API around the edge", () => {
    expect(
      clientAddress(
        "172.31.250.20",
        { forwardedFor: "162.158.1.2", cfConnectingIp: "7.7.7.7" },
        production,
      ),
    ).toBe("172.31.250.20");
  });
});

describe("limiterKey", () => {
  it("keys IPv4 by the address and IPv6 by its /64", () => {
    expect(limiterKey("203.0.113.1")).toBe("203.0.113.1");
    expect(limiterKey("2001:db8:1:2:aaaa::1")).toBe(limiterKey("2001:DB8:1:2:bbbb:cccc:dddd:2"));
    expect(limiterKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(limiterKey("2001:db8:1:3::1")).not.toBe(limiterKey("2001:db8:1:2::1"));
    expect(limiterKey("::1")).toBe("0:0:0:0::/64");
    expect(limiterKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(limiterKey("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0::/64");
  });

  it("keys a mapped IPv4 address in hex as its IPv4 address, not as ::1", () => {
    expect(limiterKey("::ffff:0102:0304")).toBe("1.2.3.4");
    expect(limiterKey("::ffff:0102:0304")).not.toBe(limiterKey("::1"));
  });

  it("keys anything that is not an address as one shared key", () => {
    expect(limiterKey("unknown")).toBe("unknown");
  });
});
