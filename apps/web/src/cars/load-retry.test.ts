import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWithRetry } from "./load-retry.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("loadWithRetry", () => {
  it("hands the result over and stops after the first success", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue("manifest");
    const loaded = vi.fn();
    const failed = vi.fn();
    loadWithRetry(load, loaded, failed);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(loaded).toHaveBeenCalledWith("manifest");
    expect(failed).not.toHaveBeenCalled();
  });

  it("warns and retries with a doubling delay until the load works", async () => {
    vi.useFakeTimers();
    const boom = new Error("manifest 503");
    const load = vi
      .fn()
      .mockRejectedValueOnce(boom)
      .mockRejectedValueOnce(boom)
      .mockResolvedValue("manifest");
    const loaded = vi.fn();
    const failed = vi.fn();
    loadWithRetry(load, loaded, failed);
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenLastCalledWith(boom, 1, 1000);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenLastCalledWith(boom, 2, 2000);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(3);
    expect(loaded).toHaveBeenCalledWith("manifest");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once cancelled", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new Error("down"));
    const cancel = loadWithRetry(load, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    cancel();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not hand over a result that arrives after cancelling", async () => {
    vi.useFakeTimers();
    const loaded = vi.fn();
    const cancel = loadWithRetry(() => Promise.resolve("late"), loaded, vi.fn());
    cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(loaded).not.toHaveBeenCalled();
  });
});

describe("loadWithRetry", () => {
  it("reports an exception thrown by the load handler instead of leaving it unhandled", async () => {
    const boom = new Error("worker terminated");
    const failed = vi.fn();
    loadWithRetry(
      () => Promise.resolve("manifest"),
      () => {
        throw boom;
      },
      failed,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledWith(boom, 1, 0);
  });

  it("stops warning about the same error after the third attempt, and warns again when it changes", async () => {
    vi.useFakeTimers();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("404"))
      .mockRejectedValueOnce(new Error("404"))
      .mockRejectedValueOnce(new Error("404"))
      .mockRejectedValueOnce(new Error("404"))
      .mockRejectedValueOnce(new Error("404"))
      .mockRejectedValue(new Error("503"));
    const failed = vi.fn();
    loadWithRetry(load, vi.fn(), failed);
    await vi.advanceTimersByTimeAsync(300_000);
    const attempts = failed.mock.calls.map((call) => call[1]);
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(attempts).not.toContain(4);
    expect(attempts).not.toContain(5);
    expect(attempts).toContain(6);
    expect(attempts.filter((n) => n > 6)).toEqual([]);
  });
});
