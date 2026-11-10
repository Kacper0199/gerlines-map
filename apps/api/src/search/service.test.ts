import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchService } from "./service.ts";
import { SEARCH_NOW_MS, testData } from "./test-data.ts";

afterEach(() => vi.useRealTimers());

describe("SearchService", () => {
  it("gives up a load that hangs at the deadline and tries again after the retry pause", async () => {
    vi.useFakeTimers();
    let now = SEARCH_NOW_MS;
    const { places, ...timetable } = testData();
    const load = vi
      .fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockImplementation(async () => timetable);
    const errors: string[] = [];
    const service = new SearchService({
      timetable: { load },
      places: async () => places,
      now: () => now,
      logger: { error: (line) => errors.push(line) },
      loadTimeoutMs: 1_000,
      retryMs: 5_000,
    });
    const first = service.ready();
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    expect(service.current()).toBeNull();
    expect(errors[0]).toMatch(/did not finish within 1000 ms/);
    now += 5_000;
    service.current();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(service.current()?.size).toBeGreaterThan(0);
  });

  it("aborts the signal of a load at the deadline, so its source starts no further query", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const load = vi.fn((_serviceDate: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => undefined);
    });
    const service = new SearchService({
      timetable: { load },
      places: async () => [],
      now: () => SEARCH_NOW_MS,
      loadTimeoutMs: 1_000,
    });
    const first = service.ready();
    await vi.advanceTimersByTimeAsync(999);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(signals[0]?.aborted).toBe(true);
  });

  it("answers stations, trains and lines when the places file is broken", async () => {
    const { places: _places, ...timetable } = testData();
    const errors: string[] = [];
    const service = new SearchService({
      timetable: { load: async () => timetable },
      places: async () => {
        throw new Error("line 3 has 4 fields");
      },
      now: () => SEARCH_NOW_MS,
      logger: { error: (line) => errors.push(line) },
    });
    await service.ready();
    const index = service.current();
    expect(index?.search("köln", { limit: 5, locale: "en" }).length).toBeGreaterThan(0);
    expect(errors).toEqual([expect.stringMatching(/places .*line 3 has 4 fields.*without places/)]);
  });

  it("leaves out a record that breaks the answer contract and logs the count", async () => {
    const { places, ...timetable } = testData();
    const [first, ...rest] = timetable.stations;
    if (!first) throw new Error("no station");
    const errors: string[] = [];
    const service = new SearchService({
      timetable: {
        load: async () => ({ ...timetable, stations: [{ ...first, name: "" }, ...rest] }),
      },
      places: async () => places,
      now: () => SEARCH_NOW_MS,
      logger: { error: (line) => errors.push(line) },
    });
    await service.ready();
    expect(service.current()?.station(first.id)).toBeNull();
    expect(errors).toEqual([expect.stringMatching(/dropped invalid records: 1 station$/)]);
  });

  it("reloads within the hour when a new timetable version is loaded mid-day", async () => {
    let now = SEARCH_NOW_MS;
    let version = "1";
    const { places, ...timetable } = testData();
    const load = vi.fn(async () => ({ ...timetable, timetableVersion: version }));
    const service = new SearchService({
      timetable: { load, version: async () => version },
      places: async () => places,
      now: () => now,
    });
    await service.ready();
    version = "2";
    now += 30 * 60_000;
    service.current();
    await vi.waitFor(() => undefined);
    expect(load).toHaveBeenCalledTimes(1);
    now += 30 * 60_000;
    service.current();
    await vi.waitFor(() => expect(service.current()?.timetableVersion).toBe("2"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves yesterday while today fails to load, but not for longer than three hours", async () => {
    let now = Date.parse("2026-11-07T22:30:00Z");
    const { places, ...timetable } = testData();
    const load = vi
      .fn()
      .mockImplementationOnce(async () => timetable)
      .mockImplementation(async () => {
        throw new Error("database down");
      });
    const service = new SearchService({
      timetable: { load },
      places: async () => places,
      now: () => now,
      logger: { error: () => undefined },
    });
    await service.ready();
    now = Date.parse("2026-11-07T23:30:00Z");
    expect(service.current()?.serviceDate).toBe("2026-11-07");
    now += 3 * 3_600_000 - 1;
    expect(service.current()?.serviceDate).toBe("2026-11-07");
    now += 2;
    expect(service.current()).toBeNull();
  });

  it("keeps answering from the old index while the new day's index is built between pauses", async () => {
    let now = SEARCH_NOW_MS;
    const { places, ...timetable } = testData();
    const waiting: (() => void)[] = [];
    let hold = false;
    const service = new SearchService({
      timetable: { load: async (serviceDate) => ({ ...timetable, serviceDate }) },
      places: async () => places,
      now: () => now,
      sliceSize: 2,
      pause: () =>
        hold ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve(),
    });
    await service.ready();
    const old = service.current();
    hold = true;
    now += 24 * 3_600_000;
    expect(service.current()).toBe(old);
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(service.current()).toBe(old);
    hold = false;
    waiting.shift()?.();
    await vi.waitFor(() => expect(service.current()).not.toBe(old));
    expect(service.current()?.serviceDate).not.toBe(old?.serviceDate);
  });
});
