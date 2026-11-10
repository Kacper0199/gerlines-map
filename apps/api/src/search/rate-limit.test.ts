import { describe, expect, it } from "vitest";
import { aggregateKey, limiterKey, networkKey } from "./client-address.ts";
import { fixedWindowLimiter } from "./rate-limit.ts";

describe("fixedWindowLimiter", () => {
  it("allows the limit per window and says when the window ends", () => {
    let now = 0;
    const limiter = fixedWindowLimiter({ limit: 2, windowMs: 10_000, now: () => now });
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    now = 4_000;
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterS: 6 });
    expect(limiter.hit("b").allowed).toBe(true);
    now = 10_000;
    expect(limiter.hit("a").allowed).toBe(true);
  });

  it("drops expired windows as time goes on", () => {
    let now = 0;
    const limiter = fixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => now });
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`);
    expect(limiter.size()).toBe(100);
    now = 1_500;
    limiter.hit("fresh");
    expect(limiter.size()).toBe(1);
  });

  it("never lets a client reset its own limit by filling the table with new keys", () => {
    let now = 0;
    const limiter = fixedWindowLimiter({ limit: 2, windowMs: 60_000, now: () => now, maxKeys: 3 });
    limiter.hit("attacker");
    limiter.hit("attacker");
    expect(limiter.hit("attacker").allowed).toBe(false);
    for (const key of ["x1", "x2", "x3", "x4", "x5"]) limiter.hit(key);
    now = 1_000;
    expect(limiter.hit("attacker").allowed).toBe(false);
    expect(limiter.size()).toBeLessThanOrEqual(7);
  });

  it("gives a new key its own window over the cap instead of one window shared by every newcomer", () => {
    let now = 0;
    const limiter = fixedWindowLimiter({
      limit: 2,
      windowMs: 60_000,
      now: () => now,
      maxKeys: 2,
      maxOverflowKeys: 3,
    });
    limiter.hit("a");
    limiter.hit("b");
    for (const key of ["c", "d", "e"]) {
      expect(limiter.hit(key).allowed).toBe(true);
      expect(limiter.hit(key).allowed).toBe(true);
      expect(limiter.hit(key).allowed).toBe(false);
    }
    now = 60_000;
    expect(limiter.hit("e").allowed).toBe(true);
  });

  describe("a table filled with /64 keys of one /48", () => {
    const attacker = (index: number) => limiterKey(`2001:db8:1:${index.toString(16)}::1`);
    const filled = () => {
      const limiter = fixedWindowLimiter({
        limit: 2,
        windowMs: 60_000,
        now: () => 0,
        maxKeys: 100,
        overflowLimit: 10,
      });
      for (let index = 0; index < 100; index += 1) limiter.hit(attacker(index));
      return limiter;
    };

    it("still lets a new IPv4 visitor through on its own limit", () => {
      const limiter = filled();
      expect(limiter.hit("203.0.113.1").allowed).toBe(true);
      expect(limiter.hit("203.0.113.1").allowed).toBe(true);
      expect(limiter.hit("203.0.113.1").allowed).toBe(false);
      expect(limiter.hit("203.0.113.2").allowed).toBe(true);
    });

    it("still lets a visitor of another /48 through", () => {
      const limiter = filled();
      expect(limiter.hit(limiterKey("2001:db8:2:5::1")).allowed).toBe(true);
      expect(limiter.hit(limiterKey("2001:db8:2:6::1")).allowed).toBe(true);
    });

    it("counts the attacker's further /64 keys together at its /48 under the overflow limit", () => {
      const limiter = filled();
      const decisions = Array.from({ length: 12 }, (_, index) =>
        limiter.hit(attacker(200 + index)),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
      expect(decisions.at(-1)).toEqual({ allowed: false, retryAfterS: 60 });
      expect(limiter.hit("198.51.100.7").allowed).toBe(true);
    });
  });

  describe("both tables full", () => {
    const full = (maxNetworkKeys = 100) => {
      const limiter = fixedWindowLimiter({
        limit: 1,
        windowMs: 60_000,
        now: () => 0,
        maxKeys: 2,
        maxOverflowKeys: 2,
        overflowLimit: 3,
        maxNetworkKeys,
      });
      for (const index of [1, 2, 3, 4]) limiter.hit(limiterKey(`2001:db8:${index}::1`));
      return limiter;
    };

    it("counts a newcomer of the filling /32 together with it under the overflow limit", () => {
      const limiter = full();
      const decisions = [5, 6, 7, 8].map(
        (index) => limiter.hit(limiterKey(`2001:db8:${index}::1`)).allowed,
      );
      expect(decisions).toEqual([true, true, true, false]);
    });

    it("gives a visitor of another /32 its own window instead of the attacker's", () => {
      const limiter = full();
      for (const index of [5, 6, 7, 8]) limiter.hit(limiterKey(`2001:db8:${index}::1`));
      expect(limiter.hit(limiterKey("2a00:1:2::1")).allowed).toBe(true);
      expect(limiter.hit(limiterKey("2a00:1:3::1")).allowed).toBe(true);
    });

    it("counts IPv4 newcomers by their /16, so new addresses elsewhere still get through", () => {
      const limiter = full();
      const attacker = [1, 2, 3, 4].map((index) => limiter.hit(`198.51.${index}.7`).allowed);
      expect(attacker).toEqual([true, true, true, false]);
      const elsewhere = Array.from({ length: 50 }, (_, index) => `10.${index}.0.1`);
      expect(elsewhere.every((address) => limiter.hit(address).allowed)).toBe(true);
    });

    it("shares one window only when the network table is full too", () => {
      const limiter = full(1);
      limiter.hit(limiterKey("2001:db8:5::1"));
      const shared = ["2a00:1::1", "2a00:2::1", "2a00:3::1", "2a00:4::1"].map(
        (address) => limiter.hit(limiterKey(address)).allowed,
      );
      expect(shared).toEqual([true, true, true, false]);
      expect(limiter.size()).toBe(6);
    });
  });
});

describe("aggregateKey", () => {
  it("widens an IPv6 /64 key to its /48 and keeps every other key", () => {
    expect(aggregateKey("2001:db8:1:2::/64")).toBe("2001:db8:1::/48");
    expect(aggregateKey(limiterKey("2001:db8:1:ffff::9"))).toBe("2001:db8:1::/48");
    expect(aggregateKey("203.0.113.1")).toBe("203.0.113.1");
    expect(aggregateKey("unknown")).toBe("unknown");
  });
});

describe("networkKey", () => {
  it("widens an IPv6 key to its /32 and an IPv4 address to its /16", () => {
    expect(networkKey("2001:db8:1:2::/64")).toBe("2001:db8::/32");
    expect(networkKey(limiterKey("2a00:1:ffff:9::1"))).toBe("2a00:1::/32");
    expect(networkKey("2001:db8:1::/48")).toBe("2001:db8::/32");
    expect(networkKey("203.0.113.1")).toBe("203.0.0.0/16");
    expect(networkKey("unknown")).toBe("unknown");
  });
});
