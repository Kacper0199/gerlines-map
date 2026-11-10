import { describe, expect, it } from "vitest";
import { StatsCache } from "./cache.ts";

describe("StatsCache", () => {
  it("shares one read between concurrent requests for the same key", async () => {
    const cache = new StatsCache();
    let loads = 0;
    let release: (value: string) => void = () => undefined;
    const load = () => {
      loads += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };
    const first = cache.read("period:a", 60_000, load);
    const second = cache.read("period:a", 60_000, load);
    release("body");
    expect(await Promise.all([first, second])).toEqual(["body", "body"]);
    expect(loads).toBe(1);
  });

  it("holds a key while its answer is fresh and not after the time to live", async () => {
    let now = 0;
    const cache = new StatsCache({ now: () => now });
    expect(cache.holds("k")).toBe(false);
    await cache.read("k", 1000, async () => 1);
    now = 999;
    expect(cache.holds("k")).toBe(true);
    now = 1000;
    expect(cache.holds("k")).toBe(false);
  });

  it("reads again after the time to live", async () => {
    let now = 0;
    const cache = new StatsCache({ now: () => now });
    let loads = 0;
    const load = async () => ++loads;
    await cache.read("k", 1000, load);
    now = 999;
    expect(await cache.read("k", 1000, load)).toBe(1);
    now = 1000;
    expect(await cache.read("k", 1000, load)).toBe(2);
  });

  it("drops a failed read so the next request retries", async () => {
    const cache = new StatsCache();
    await expect(cache.read("k", 60_000, () => Promise.reject(new Error("down")))).rejects.toThrow(
      "down",
    );
    expect(cache.size).toBe(0);
    expect(await cache.read("k", 60_000, async () => "ok")).toBe("ok");
  });

  it("keeps at most the given number of entries, the oldest leaving first", async () => {
    const cache = new StatsCache({ maxEntries: 2 });
    for (const key of ["a", "b", "c"]) await cache.read(key, 60_000, async () => key);
    expect(cache.size).toBe(2);
    expect(await cache.read("a", 60_000, async () => "again")).toBe("again");
  });
});
