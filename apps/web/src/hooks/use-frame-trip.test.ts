// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTripCache,
  fetchTripOfKey,
  nextLookupDelay,
  seedTripOfKey,
  useTripOfKey,
} from "./use-frame-trip.ts";

const ID = "6f1c2a7e-6c3b-5d55-9a43-2f6b8e0c1d11";
const OTHER = "0a1b2c3d-1111-5222-8333-444455556666";

function answer(status: number, body?: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

beforeEach(() => clearTripCache());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("fetchTripOfKey", () => {
  it("asks the live key route and reads the trip instance", async () => {
    const fetch = vi.fn(async (_input: string) => answer(200, { tripInstanceId: ID }));
    expect(await fetchTripOfKey(25714801, { fetch })).toEqual({ kind: "ok", tripInstanceId: ID });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/live/keys/25714801");
  });

  it("tells not found, an error status, a network failure and an unreadable body apart", async () => {
    expect(await fetchTripOfKey(1, { fetch: async () => answer(404) })).toEqual({
      kind: "not-found",
    });
    expect(await fetchTripOfKey(1, { fetch: async () => answer(503) })).toEqual({ kind: "error" });
    expect(
      await fetchTripOfKey(1, {
        fetch: async () => {
          throw new TypeError("offline");
        },
      }),
    ).toEqual({ kind: "error" });
    expect(
      await fetchTripOfKey(1, { fetch: async () => answer(200, { tripInstanceId: 7 }) }),
    ).toEqual({ kind: "error" });
  });
});

describe("fetchTripOfKey abort", () => {
  it("hands its signal to fetch and returns without a verdict when aborted", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    expect(await fetchTripOfKey(3, { fetch, signal: controller.signal })).toEqual({
      kind: "aborted",
    });
  });
});

describe("trip cache lifetime", () => {
  it("forgets an answer after ten minutes and when cleared", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    seedTripOfKey(8, ID);
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    expect(renderHook(() => useTripOfKey(8, { fetch })).result.current.status).toBe("ready");
    vi.setSystemTime(10 * 60_000 + 1);
    expect(renderHook(() => useTripOfKey(8, { fetch })).result.current.status).toBe("loading");
    seedTripOfKey(9, ID);
    clearTripCache();
    expect(renderHook(() => useTripOfKey(9, { fetch })).result.current.status).toBe("loading");
  });
});

describe("a lookup mounted on a cache hit", () => {
  it("stays ready after the entry would expire and sends no request", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    seedTripOfKey(5, ID);
    const fetch = vi.fn(async () => answer(200, { tripInstanceId: ID }));
    const { result, rerender } = renderHook(() => useTripOfKey(5, { fetch }));
    expect(result.current.status).toBe("ready");
    vi.setSystemTime(10 * 60_000 + 1);
    rerender();
    expect(result.current).toEqual({ status: "ready", tripInstanceId: ID });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is looked up again after the cache is cleared", async () => {
    seedTripOfKey(6, ID);
    const fetch = vi.fn(async () => answer(200, { tripInstanceId: OTHER }));
    const { result } = renderHook(() => useTripOfKey(6, { fetch }));
    expect(result.current).toEqual({ status: "ready", tripInstanceId: ID });
    act(() => clearTripCache());
    await vi.waitFor(() =>
      expect(result.current).toEqual({ status: "ready", tripInstanceId: OTHER }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("nextLookupDelay", () => {
  it("doubles from five seconds up to one minute", () => {
    expect([0, 1, 2, 3, 4, 9].map(nextLookupDelay)).toEqual([
      5000, 10000, 20000, 40000, 60000, 60000,
    ]);
  });
});

describe("useTripOfKey", () => {
  it("is idle without a key and ready from the cache without a request", () => {
    const fetch = vi.fn();
    expect(renderHook(() => useTripOfKey(null, { fetch })).result.current).toEqual({
      status: "idle",
    });
    seedTripOfKey(5, ID);
    const seeded = renderHook(() => useTripOfKey(5, { fetch }));
    expect(seeded.result.current).toEqual({ status: "ready", tripInstanceId: ID });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads, then reports ready and remembers the answer", async () => {
    const fetch = vi.fn(async () => answer(200, { tripInstanceId: ID }));
    const { result } = renderHook(() => useTripOfKey(9, { fetch }));
    expect(result.current.status).toBe("loading");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toEqual({ status: "ready", tripInstanceId: ID });
    const again = renderHook(() => useTripOfKey(9, { fetch }));
    expect(again.result.current.status).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again for the mounted key when the cache is cleared under it", async () => {
    seedTripOfKey(111, ID);
    const fetch = vi.fn(async () => answer(200, { tripInstanceId: OTHER }));
    const { result } = renderHook(() => useTripOfKey(111, { fetch }));
    expect(result.current).toEqual({ status: "ready", tripInstanceId: ID });

    act(() => clearTripCache());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: "ready", tripInstanceId: OTHER });
  });

  it("says missing at once on a failure and asks again later until it finds the train", async () => {
    vi.useFakeTimers();
    let state: "none" | "found" = "none";
    const fetch = vi.fn(async () =>
      state === "none" ? answer(404) : answer(200, { tripInstanceId: OTHER }),
    );
    const { result } = renderHook(() => useTripOfKey(11, { fetch }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("missing");
    state = "found";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toEqual({ status: "ready", tripInstanceId: OTHER });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts the request of a key the selection has left", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_input: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const { rerender } = renderHook(({ key }) => useTripOfKey(key, { fetch }), {
      initialProps: { key: 1 as number | null },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);
    rerender({ key: null });
    expect(signal?.aborted).toBe(true);
  });

  it("starts loading again for another key", async () => {
    const fetch = vi.fn(async () => answer(200, { tripInstanceId: ID }));
    const { result, rerender } = renderHook(({ key }) => useTripOfKey(key, { fetch }), {
      initialProps: { key: 1 },
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe("ready");
    rerender({ key: 2 });
    expect(result.current.status).toBe("loading");
  });
});
