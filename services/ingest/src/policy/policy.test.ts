import { describe, expect, it } from "vitest";
import { backoffDelayMs, backoffForPeriod } from "./backoff.ts";
import { parseRetryAfter } from "./retry-after.ts";
import { nextAttemptAt, slotAfter } from "./schedule.ts";
import { TokenBucket } from "./token-bucket.ts";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-25T09:00:00Z");

  it("reads delay seconds", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
  });

  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter("Sun, 25 Oct 2026 09:01:30 GMT", now)).toBe(90_000);
  });

  it("treats a date in the past as no wait", () => {
    expect(parseRetryAfter("Sun, 25 Oct 2026 08:00:00 GMT", now)).toBe(0);
  });

  it.each([null, "", "soon", "-5", "1.5"])("ignores %j", (value) => {
    expect(parseRetryAfter(value, now)).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  const policy = { baseMs: 60_000, capMs: 900_000, jitterRatio: 0.2 };

  it("doubles per consecutive failure up to the cap", () => {
    const noJitter = () => 0.5;
    expect(backoffDelayMs(1, policy, noJitter)).toBe(60_000);
    expect(backoffDelayMs(2, policy, noJitter)).toBe(120_000);
    expect(backoffDelayMs(4, policy, noJitter)).toBe(480_000);
    expect(backoffDelayMs(9, policy, noJitter)).toBe(900_000);
    expect(backoffDelayMs(80, policy, noJitter)).toBe(900_000);
  });

  it("spreads the delay by the jitter ratio and never exceeds the cap", () => {
    expect(backoffDelayMs(1, policy, () => 0)).toBe(48_000);
    expect(backoffDelayMs(1, policy, () => 0.999_999)).toBeCloseTo(72_000, -1);
    expect(backoffDelayMs(20, policy, () => 0.999_999)).toBe(900_000);
  });

  it("returns zero without failures", () => {
    expect(backoffDelayMs(0, policy, () => 0.5)).toBe(0);
  });
});

describe("slotAfter", () => {
  it("aligns to the offset within the period in UTC", () => {
    const t = Date.parse("2026-10-25T09:13:30Z");
    expect(new Date(slotAfter(t, 60_000, 20_000)).toISOString()).toBe("2026-10-25T09:14:20.000Z");
    expect(new Date(slotAfter(t - 15_000, 60_000, 20_000)).toISOString()).toBe(
      "2026-10-25T09:13:20.000Z",
    );
  });

  it("keeps a steady minute grid across the DST switch of 2026-10-25", () => {
    const beforeSwitch = Date.parse("2026-10-25T00:59:50Z");
    const slots = [slotAfter(beforeSwitch, 60_000, 20_000)];
    for (let index = 0; index < 3; index += 1) {
      slots.push(slotAfter(slots.at(-1) ?? 0, 60_000, 20_000));
    }
    expect(slots.map((slot) => new Date(slot).toISOString())).toEqual([
      "2026-10-25T01:00:20.000Z",
      "2026-10-25T01:01:20.000Z",
      "2026-10-25T01:02:20.000Z",
      "2026-10-25T01:03:20.000Z",
    ]);
  });
});

describe("nextAttemptAt", () => {
  const t = Date.parse("2026-10-25T09:13:30Z");
  const base = {
    periodMs: 60_000,
    offsetMs: 20_000,
    jitterMs: 0,
    backoff: { baseMs: 60_000, capMs: 900_000, jitterRatio: 0 },
  };

  it("waits for the next slot after a success", () => {
    expect(
      nextAttemptAt({ ...base, now: t, failures: 0, retryAfterMs: null, random: () => 0 }),
    ).toBe(Date.parse("2026-10-25T09:14:20Z"));
  });

  it("backs off after failures and honours a longer Retry-After", () => {
    expect(
      nextAttemptAt({ ...base, now: t, failures: 3, retryAfterMs: null, random: () => 0.5 }),
    ).toBe(Date.parse("2026-10-25T09:18:20Z"));
    expect(
      nextAttemptAt({ ...base, now: t, failures: 1, retryAfterMs: 600_000, random: () => 0.5 }),
    ).toBe(Date.parse("2026-10-25T09:24:20Z"));
  });

  it("adds jitter inside the configured window", () => {
    const at = nextAttemptAt({
      ...base,
      jitterMs: 4_000,
      now: t,
      failures: 0,
      retryAfterMs: null,
      random: () => 0.75,
    });
    expect(at).toBe(Date.parse("2026-10-25T09:14:23Z"));
  });

  it("retries a daily source within the hour after a failure, not on the next day's slot", () => {
    const day = 86_400_000;
    const failedAt = Date.parse("2026-10-28T08:33:35Z");
    const daily = {
      periodMs: day,
      offsetMs: 8 * 3_600_000 + 15 * 60_000,
      jitterMs: 5 * 60_000,
      backoff: backoffForPeriod(day),
      retryAfterMs: null,
    };
    for (const random of [() => 0, () => 0.5, () => 0.999]) {
      const at = nextAttemptAt({ ...daily, now: failedAt, failures: 1, random });
      expect(at).toBeGreaterThan(failedAt);
      expect(at - failedAt).toBeLessThanOrEqual(3_600_000);
    }
    const afterSuccess = nextAttemptAt({ ...daily, now: failedAt, failures: 0, random: () => 0 });
    expect(new Date(afterSuccess).toISOString()).toBe("2026-10-29T08:15:00.000Z");
  });

  it("keeps the backoff of a minute source on its own period", () => {
    expect(backoffForPeriod(60_000)).toEqual({ baseMs: 60_000, capMs: 900_000, jitterRatio: 0.2 });
    expect(backoffForPeriod(86_400_000).baseMs).toBe(30 * 60_000);
  });

  it("caps a hostile Retry-After at one day", () => {
    const at = nextAttemptAt({
      ...base,
      now: t,
      failures: 1,
      retryAfterMs: 10 * 86_400_000,
      random: () => 0,
    });
    expect(at - t).toBeLessThanOrEqual(86_400_000 + 60_000);
  });
});

describe("TokenBucket", () => {
  it("allows the burst, then one token per refill interval", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 2, refillEveryMs: 12_000 }, () => now);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(12_000);
    now = 5_000;
    expect(bucket.take()).toBe(19_000);
    now = 36_000;
    expect(bucket.take()).toBe(0);
  });

  it("never holds more than its capacity", () => {
    let now = 0;
    const bucket = new TokenBucket({ capacity: 1, refillEveryMs: 1_000 }, () => now);
    now = 1_000_000;
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(1_000);
  });
});
